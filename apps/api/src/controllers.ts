import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { AuditService } from "./audit/audit.service.js";
import { DomainError } from "./common/errors.js";
import { CONFIG, type AppConfig } from "./config.js";
import { DB, type Db } from "./db/db.js";
import { currentUser, Public, Roles } from "./identity/identity.js";
import { KpiService } from "./insights/kpi.service.js";
import { ImportService } from "./imports/import.service.js";
import { InventoryService } from "./inventory/inventory.service.js";
import { ENGINE, type EngineClient } from "./planning/engine.client.js";
import { ERP, type ErpPort } from "./purchasing/erp/erp.port.js";
import { PurchasingService } from "./purchasing/purchasing.service.js";

@Controller("api/v1/imports")
export class ImportsController {
  constructor(private readonly imports: ImportService) {}

  @Post(":entity")
  @HttpCode(200)
  @Roles("admin")
  import(@Param("entity") entity: string, @Body() body: { records?: unknown[] }, @Req() req: Request) {
    return this.imports.import(entity, body?.records, currentUser(req).userId);
  }
}

@Controller("api/v1")
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get("inventory-positions")
  positions(@Query("sku") sku?: string, @Query("locationId") locationId?: string) {
    return this.inventory.positions({ sku, locationId });
  }
}

@Controller("api/v1/purchase-orders")
export class PurchasingController {
  constructor(@Inject(PurchasingService) private readonly purchasing: PurchasingService) {}

  @Get()
  list() {
    return this.purchasing.list();
  }

  @Get(":poId")
  get(@Param("poId", ParseUUIDPipe) poId: string) {
    return this.purchasing.get(poId);
  }

  @Post(":poId/retry-submission")
  @HttpCode(200)
  @Roles("planner", "senior_planner", "head_of_replenishment", "admin")
  retry(@Param("poId", ParseUUIDPipe) poId: string, @Req() req: Request) {
    return this.purchasing.retry(poId, currentUser(req).userId);
  }
}

@Controller("api/v1/audit-events")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query("entityType") entityType?: string, @Query("entityId") entityId?: string, @Query("limit") limit?: string) {
    return this.audit.list({ entityType, entityId, limit: limit ? Number(limit) : undefined });
  }

  @Get("verify")
  verify() {
    return this.audit.verify();
  }
}

@Controller("api/v1/kpis")
export class KpiController {
  constructor(private readonly kpis: KpiService) {}

  @Get()
  get() {
    return this.kpis.snapshot();
  }
}

@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENGINE) private readonly engine: EngineClient,
    @Inject(ERP) private readonly erp: ErpPort,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get("health")
  async health() {
    let database = "ok";
    try {
      await this.db.query("SELECT 1");
    } catch {
      database = "unavailable";
    }
    const [engine, erp] = await Promise.all([this.engine.health(), this.erp.health()]);
    if (database !== "ok") throw new DomainError("DB_UNAVAILABLE", 503, "database unavailable");
    return {
      status: engine === "ok" && erp === "ok" ? "ok" : "degraded",
      version: "0.1.0",
      database: `${database} (${this.db.kind})`,
      engine,
      erp,
      authMode: this.config.authMode,
      demoMode: this.config.demoMode,
      relayMode: this.config.relayMode,
      erpMode: this.config.erpMode,
    };
  }
}
