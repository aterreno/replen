import { Controller, Get, Inject, Query } from "@nestjs/common";
import { DB, type Db } from "../db/db.js";

@Controller("api/v1/events")
export class EventsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Query("subject") subject?: string, @Query("limit") limit?: string) {
    const rows = await this.db.query<{
      seq: number;
      envelope: object;
      published_at: string | null;
      attempts: number;
      last_error: string | null;
      dead_lettered_at: string | null;
    }>(
      `SELECT seq, envelope, published_at, attempts, last_error, dead_lettered_at FROM messaging.outbox
       WHERE ($1::text IS NULL OR subject = $1) ORDER BY seq DESC LIMIT $2`,
      [subject ?? null, Math.min(Number(limit ?? 100) || 100, 500)],
    );
    return rows.map((r) => ({
      seq: r.seq,
      event: r.envelope,
      publishedAt: r.published_at,
      attempts: r.attempts,
      lastError: r.last_error,
      deadLetteredAt: r.dead_lettered_at,
    }));
  }
}
