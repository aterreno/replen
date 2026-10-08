import { randomUUID } from "node:crypto";
import {
  type DynamicModule,
  Global,
  Inject,
  type INestApplication,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { waitUntil } from "@vercel/functions";
import type { NextFunction, Request, Response } from "express";
import { AuditService } from "./audit/audit.service.js";
import { runWithContext } from "./common/context.js";
import { ProblemFilter } from "./common/errors.js";
import { IdempotencyService } from "./common/idempotency.service.js";
import { log } from "./common/logger.js";
import { CONFIG, type AppConfig } from "./config.js";
import {
  AuditController,
  HealthController,
  ImportsController,
  InventoryController,
  KpiController,
  PurchasingController,
} from "./controllers.js";
import { DB, type Db, PgDb, PgliteDb } from "./db/db.js";
import { DemoController, DemoService } from "./demo/demo.service.js";
import { ImportService } from "./imports/import.service.js";
import { migrate } from "./db/migrations.js";
import { AuthController, AuthGuard, TokenService, UsersService } from "./identity/identity.js";
import { KpiService } from "./insights/kpi.service.js";
import { InventoryService } from "./inventory/inventory.service.js";
import { ContractValidator } from "./messaging/contracts.js";
import { EventsController } from "./messaging/events.controller.js";
import { OutboxService } from "./messaging/outbox.service.js";
import { EventBus, EXTERNAL_PUBLISHER, LogFilePublisher, OutboxRelay } from "./messaging/relay.service.js";
import { ENGINE, HttpEngineClient } from "./planning/engine.client.js";
import { PlanningController } from "./planning/planning.controller.js";
import { PlanningService } from "./planning/planning.service.js";
import { ProposalsService } from "./planning/proposals.service.js";
import { ERP } from "./purchasing/erp/erp.port.js";
import { HttpErpAdapter } from "./purchasing/erp/http-erp.adapter.js";
import { SimulatedErpAdapter } from "./purchasing/erp/simulated-erp.adapter.js";
import { PurchasingService } from "./purchasing/purchasing.service.js";
import { ReferenceController } from "./reference/reference.controller.js";
import { ReferenceService } from "./reference/reference.service.js";

export async function openDatabase(config: AppConfig): Promise<Db> {
  const db = config.databaseUrl ? new PgDb(config.databaseUrl) : await PgliteDb.create(config.pgliteDir);
  const applied = await migrate(db);
  if (applied.length) log("info", "migrations applied", { applied, kind: db.kind });
  return db;
}

class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}
  async onApplicationShutdown() {
    await this.db.close();
  }
}

/** Platform services shared by all modules: config, database, identity, audit, messaging. */
@Global()
@Module({})
class CoreModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DB, inject: [CONFIG], useFactory: openDatabase },
        { provide: EXTERNAL_PUBLISHER, useValue: new LogFilePublisher(config.eventLogPath) },
        DbLifecycle,
        IdempotencyService,
        AuditService,
        ContractValidator,
        OutboxService,
        EventBus,
        OutboxRelay,
        TokenService,
        UsersService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
      exports: [CONFIG, DB, IdempotencyService, AuditService, ContractValidator, OutboxService, EventBus, OutboxRelay, UsersService],
      controllers: [AuthController, EventsController, AuditController],
    };
  }
}

@Module({
  providers: [
    {
      provide: ERP,
      inject: [CONFIG, DB],
      useFactory: (c: AppConfig, db: Db) =>
        c.erpMode === "simulated" ? new SimulatedErpAdapter(db) : new HttpErpAdapter(c.erpUrl, c.erpApiKey),
    },
    PurchasingService,
  ],
  controllers: [PurchasingController],
  exports: [PurchasingService, ERP],
})
class PurchasingModule {}

@Module({
  imports: [PurchasingModule],
  providers: [ReferenceService],
  controllers: [ReferenceController],
  exports: [ReferenceService],
})
class ReferenceModule {}

@Module({
  imports: [PurchasingModule],
  providers: [InventoryService],
  controllers: [InventoryController],
  exports: [InventoryService],
})
class InventoryModule {}

@Module({
  imports: [ReferenceModule, InventoryModule, PurchasingModule],
  providers: [
    {
      provide: ENGINE,
      inject: [CONFIG],
      useFactory: (c: AppConfig) => new HttpEngineClient(c.engineUrl, c.engineTimeoutMs),
    },
    PlanningService,
    ProposalsService,
  ],
  controllers: [PlanningController],
  exports: [ENGINE, PlanningService],
})
class PlanningModule {}

@Module({
  imports: [ReferenceModule, InventoryModule, PurchasingModule, PlanningModule],
  providers: [KpiService, ImportService, DemoService],
  controllers: [ImportsController, KpiController, HealthController, DemoController],
})
class ApplicationModule {}

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return { module: AppModule, imports: [CoreModule.register(config), ApplicationModule] };
  }
}

/** Correlation ids, access logs, demo seeding gate and serverless outbox draining. Used by main.ts and tests. */
export function configureApp(app: INestApplication): void {
  const config = app.get<AppConfig>(CONFIG);
  const relay = app.get(OutboxRelay);
  const purchasing = app.get(PurchasingService);
  const demo = app.get(DemoService);
  const ungated = /^\/(health|api\/v1\/(auth|users|demo))/;

  app.use((req: Request, res: Response, next: NextFunction) => {
    const correlationId = (req.header("x-correlation-id") || randomUUID()).slice(0, 100);
    res.setHeader("x-correlation-id", correlationId);
    const started = performance.now();
    res.on("finish", () =>
      runWithContext({ correlationId }, () =>
        log("info", "request", {
          method: req.method,
          path: req.originalUrl.split("?")[0],
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        }),
      ),
    );
    if (config.relayMode === "after-request") {
      // No background timers on serverless: drain the outbox once this response is sent, kept alive by
      // waitUntil (a no-op outside Vercel, where the promise simply runs).
      waitUntil(
        new Promise((resolve) => res.on("finish", resolve)).then(() =>
          runWithContext({ correlationId: `relay-${correlationId}` }, async () => {
            await relay.drain();
            await purchasing.retrySweep();
          }).catch((err) => log("error", "after-request drain failed", { err: String(err) })),
        ),
      );
    }
    if (config.demoMode && !ungated.test(req.path)) {
      runWithContext({ correlationId }, () =>
        demo
          .ensureSeeded()
          .catch((err) => log("error", "demo seeding failed", { err: String(err) }))
          .then(() => runWithContext({ correlationId }, () => next())),
      );
      return;
    }
    runWithContext({ correlationId }, () => next());
  });
  app.enableShutdownHooks();
}
