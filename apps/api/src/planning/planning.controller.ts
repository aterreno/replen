import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { IdempotencyService } from "../common/idempotency.service.js";
import { parseBody } from "../common/util.js";
import { currentUser, Roles } from "../identity/identity.js";
import { PlanningService } from "./planning.service.js";
import { ProposalsService } from "./proposals.service.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const runSchema = z.object({ asOfDate: isoDate.optional(), supplierIds: z.array(z.string()).optional() }).strict();
const adjustSchema = z
  .object({
    finalQty: z.number().int().min(0),
    reasonCode: z.string().min(1),
    note: z.string().max(500).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
const decisionSchema = z.object({ expectedVersion: z.number().int().min(1), comment: z.string().max(500).optional() }).strict();
const rejectSchema = z
  .object({ expectedVersion: z.number().int().min(1), reasonCode: z.string().min(1), comment: z.string().max(500).optional() })
  .strict();
const simulateSchema = z
  .object({
    leadTimeDeltaDays: z.number().int().min(-30).max(90).optional(),
    demandMultiplier: z.number().gt(0).max(5).optional(),
    serviceLevel: z.number().gt(0).lt(1).optional(),
    supplierDelayDays: z.number().int().min(0).max(90).optional(),
  })
  .strict();

const PLANNERS = ["planner", "senior_planner", "head_of_replenishment"] as const;

@Controller("api/v1")
export class PlanningController {
  constructor(
    private readonly planning: PlanningService,
    private readonly proposals: ProposalsService,
    private readonly idem: IdempotencyService,
  ) {}

  @Get("planning-runs")
  runs() {
    return this.planning.list();
  }

  @Get("planning-runs/:runId")
  run(@Param("runId", ParseUUIDPipe) runId: string) {
    return this.planning.get(runId);
  }

  @Post("planning-runs")
  @Roles(...PLANNERS, "admin")
  async startRun(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key?: string,
  ) {
    const user = currentUser(req);
    const parsed = parseBody(runSchema, body);
    const r = await this.idem.run(key, user.userId, "POST", "/planning-runs", parsed, async () => ({
      status: 201,
      body: await this.planning.run(user.userId, parsed),
    }));
    res.status(r.status);
    if (r.replayed) res.setHeader("Idempotency-Replayed", "true");
    return r.body;
  }

  @Get("override-reasons")
  reasons() {
    return this.proposals.reasons();
  }

  @Get("order-proposals")
  list(@Query("status") status?: string, @Query("supplierId") supplierId?: string) {
    return this.proposals.list({ status, supplierId });
  }

  @Get("order-proposals/:id")
  get(@Param("id", ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.proposals.get(id, currentUser(req));
  }

  @Patch("order-proposals/:id/lines/:lineId")
  @Roles(...PLANNERS)
  adjust(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("lineId", ParseUUIDPipe) lineId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.proposals.adjustLine(id, lineId, currentUser(req), parseBody(adjustSchema, body));
  }

  private async decide(
    action: "approve" | "escalate" | "reject",
    id: string,
    body: unknown,
    req: Request,
    res: Response,
    key?: string,
  ) {
    const user = currentUser(req);
    const run = async () => {
      if (action === "reject") return this.proposals.reject(id, user, parseBody(rejectSchema, body));
      const parsed = parseBody(decisionSchema, body);
      return action === "approve" ? this.proposals.approve(id, user, parsed) : this.proposals.escalate(id, user, parsed);
    };
    const r = await this.idem.run(key, user.userId, "POST", `/order-proposals/${id}/${action}`, body, async () => ({
      status: 200,
      body: await run(),
    }));
    res.status(r.status);
    if (r.replayed) res.setHeader("Idempotency-Replayed", "true");
    return r.body;
  }

  @Post("order-proposals/:id/approve")
  @Roles(...PLANNERS)
  approve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.decide("approve", id, body, req, res, key);
  }

  @Post("order-proposals/:id/escalate")
  @Roles(...PLANNERS)
  escalate(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.decide("escalate", id, body, req, res, key);
  }

  @Post("order-proposals/:id/reject")
  @Roles(...PLANNERS)
  reject(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.decide("reject", id, body, req, res, key);
  }

  @Post("order-proposals/:id/simulate")
  @HttpCode(200)
  simulate(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.proposals.simulate(id, parseBody(simulateSchema, body));
  }
}
