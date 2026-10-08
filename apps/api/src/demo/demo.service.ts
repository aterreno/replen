import { Body, Controller, Get, HttpCode, Inject, Injectable, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { AuditService } from "../audit/audit.service.js";
import { DomainError } from "../common/errors.js";
import { log } from "../common/logger.js";
import { CONFIG, type AppConfig } from "../config.js";
import { DB, type Db } from "../db/db.js";
import { currentUser, Public, Roles } from "../identity/identity.js";
import { LEGACY_FILES, parseCsv } from "../imports/legacy-csv.js";
import { ImportService } from "../imports/import.service.js";
import { ENGINE, type EngineClient } from "../planning/engine.client.js";
import { PlanningService } from "../planning/planning.service.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hosted showcase support (DEMO_MODE=1). Seeds the synthetic extract on first use and lets admins reset it.
 * Seeding is claimed through a single row so concurrent serverless instances do not seed twice; a claim older
 * than three minutes is treated as abandoned.
 */
@Injectable()
export class DemoService {
  private ready?: Promise<void>;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(ENGINE) private readonly engine: EngineClient,
    private readonly imports: ImportService,
    private readonly planning: PlanningService,
    private readonly audit: AuditService,
  ) {}

  ensureSeeded(): Promise<void> {
    if (!this.config.demoMode) return Promise.resolve();
    this.ready ??= this.seedIfNeeded().catch((err) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  async status(): Promise<string> {
    const [row] = await this.db.query<{ status: string }>("SELECT status FROM public.demo_state WHERE id = 1");
    return row?.status ?? "empty";
  }

  private async claim(force: boolean): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO public.demo_state (id, status) VALUES (1, 'seeding')
       ON CONFLICT (id) DO UPDATE SET status = 'seeding', updated_at = now()
       WHERE $1 OR public.demo_state.updated_at < now() - interval '3 minutes'
       RETURNING id`,
      [force],
    );
    return rows.length > 0;
  }

  private async seedIfNeeded(): Promise<void> {
    for (let attempt = 0; attempt < 90; attempt++) {
      const status = await this.status();
      if (status === "ready") return;
      if (status === "empty") {
        const [{ n }] = await this.db.query<{ n: number }>("SELECT count(*)::int AS n FROM reference.product");
        if (n > 0) {
          // Data loaded by other means (scripts); adopt it.
          await this.db.query("INSERT INTO public.demo_state (id, status) VALUES (1, 'ready') ON CONFLICT DO NOTHING");
          return;
        }
      }
      if (await this.claim(false)) {
        await this.seed("system:demo");
        return;
      }
      await sleep(1000);
    }
    log("warn", "demo seeding still in progress elsewhere; continuing without waiting");
  }

  private async seed(actor: string): Promise<void> {
    const started = Date.now();
    const extract = await this.engine.demoExtract();
    for (const { entity, file, map } of LEGACY_FILES) {
      const text = extract.files[file];
      if (text === undefined) throw new DomainError("DEMO_EXTRACT_INCOMPLETE", 502, `engine extract missing ${file}`);
      await this.imports.import(entity, parseCsv(text).map(map), actor);
    }
    await this.planning.run(actor, {});
    await this.db.query("UPDATE public.demo_state SET status = 'ready', updated_at = now() WHERE id = 1");
    log("info", "demo data seeded", { durationMs: Date.now() - started, asOfDate: extract.asOfDate });
  }

  /** Wipe all transactional data (users are kept) and seed again. */
  async reset(actor: string): Promise<{ status: string; durationMs: number }> {
    if (!this.config.demoMode) throw new DomainError("NOT_DEMO", 404, "demo reset is only available in DEMO_MODE");
    const started = Date.now();
    await this.claim(true);
    await this.db.tx(async (q) => {
      await q.exec(`
        TRUNCATE planning.proposal_line, planning.order_proposal, planning.planning_run,
          purchasing.purchase_order_line, purchasing.purchase_order, purchasing.receipt_history,
          inventory.snapshot, inventory.legacy_open_order,
          reference.order_constraint, reference.item_location, reference.sourcing, reference.product,
          reference.supplier, reference.location,
          messaging.outbox, messaging.inbox, messaging.idempotency_key,
          audit.audit_event, mock_erp.purchase_order
        RESTART IDENTITY CASCADE;
        UPDATE audit.chain_head SET last_hash = NULL WHERE id = 1;
        ALTER SEQUENCE purchasing.po_number_seq RESTART WITH 100001;
        ALTER SEQUENCE mock_erp.po_number_seq RESTART WITH 4500100001;
      `);
      await this.audit.record(q, { actor, action: "demo.reset", entityType: "demo", entityId: "1" });
    });
    this.ready = undefined;
    await this.seed(actor);
    this.ready = Promise.resolve();
    return { status: "ready", durationMs: Date.now() - started };
  }
}

@Controller("api/v1/demo")
export class DemoController {
  constructor(
    private readonly demo: DemoService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  async state() {
    return { demoMode: this.config.demoMode, status: this.config.demoMode ? await this.demo.status() : "disabled" };
  }

  @Post("reset")
  @HttpCode(200)
  @Roles("admin")
  reset(@Req() req: Request, @Body() _body: unknown) {
    return this.demo.reset(currentUser(req).userId);
  }
}
