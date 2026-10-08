import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { EventType } from "@replen/contracts";
import { runWithContext } from "../common/context.js";
import { log } from "../common/logger.js";
import { CONFIG, type AppConfig } from "../config.js";
import { DB, type Db, type Queryable } from "../db/db.js";
import type { Envelope } from "./outbox.service.js";

export type Handler = (event: Envelope) => Promise<void>;

/** In-process subscribers. Same contract as a Pub/Sub push subscription: at-least-once, dedupe via inbox. */
@Injectable()
export class EventBus {
  private readonly handlers = new Map<string, { consumer: string; handler: Handler }[]>();

  subscribe<T extends EventType>(type: T, consumer: string, handler: (event: Envelope<T>) => Promise<void>): void {
    const list = this.handlers.get(type) ?? [];
    list.push({ consumer, handler: handler as Handler });
    this.handlers.set(type, list);
  }

  handlersFor(type: string) {
    return this.handlers.get(type) ?? [];
  }
}

/** Claim an event for a consumer inside the consumer's transaction. Returns false if already processed. */
export async function claimInbox(q: Queryable, consumer: string, eventId: string): Promise<boolean> {
  const rows = await q.query(
    "INSERT INTO messaging.inbox (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id",
    [consumer, eventId],
  );
  return rows.length > 0;
}

export interface ExternalPublisher {
  readonly name: string;
  publish(events: Envelope[]): Promise<void>;
}

export const EXTERNAL_PUBLISHER = Symbol("EXTERNAL_PUBLISHER");

/** Local stand-in for Pub/Sub: newline-delimited CloudEvents appended to a file. */
export class LogFilePublisher implements ExternalPublisher {
  readonly name = "log-file";
  constructor(private readonly path?: string) {}

  async publish(events: Envelope[]): Promise<void> {
    if (!this.path || events.length === 0) return;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

const MAX_ATTEMPTS = 10;

interface OutboxRow {
  seq: number;
  event_id: string;
  ordering_key: string;
  envelope: Envelope;
  attempts: number;
}

/**
 * Polls the outbox in sequence order, publishes externally, then dispatches to in-process subscribers.
 * A failing event blocks later events with the same ordering key (per-aggregate order) until it succeeds
 * or is dead-lettered after MAX_ATTEMPTS.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(EXTERNAL_PUBLISHER) private readonly publisher: ExternalPublisher,
    private readonly bus: EventBus,
  ) {}

  onApplicationBootstrap() {
    if (this.config.relayIntervalMs > 0) {
      this.timer = setInterval(() => void this.tick().catch(() => undefined), this.config.relayIntervalMs);
    }
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Process one batch. Returns the number of events published. */
  async tick(batch = 100): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const rows = await this.db.query<OutboxRow>(
        `SELECT seq, event_id, ordering_key, envelope, attempts FROM messaging.outbox
         WHERE published_at IS NULL AND dead_lettered_at IS NULL ORDER BY seq LIMIT $1`,
        [batch],
      );
      const blocked = new Set<string>();
      let published = 0;
      for (const row of rows) {
        if (blocked.has(row.ordering_key)) continue;
        try {
          await this.publisher.publish([row.envelope]);
          for (const { consumer, handler } of this.bus.handlersFor(row.envelope.type)) {
            await runWithContext(
              { correlationId: row.envelope.correlationid, causationId: row.envelope.id, actor: `system:${consumer}` },
              () => handler(row.envelope),
            );
          }
          await this.db.query("UPDATE messaging.outbox SET published_at = now(), attempts = attempts + 1 WHERE seq = $1", [
            row.seq,
          ]);
          published++;
        } catch (err) {
          blocked.add(row.ordering_key);
          const message = err instanceof Error ? err.message : String(err);
          const dead = row.attempts + 1 >= MAX_ATTEMPTS;
          await this.db.query(
            `UPDATE messaging.outbox SET attempts = attempts + 1, last_error = $2,
               dead_lettered_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE seq = $1`,
            [row.seq, message.slice(0, 1000), dead],
          );
          log(dead ? "error" : "warn", "event dispatch failed", {
            eventId: row.event_id,
            type: row.envelope.type,
            attempt: row.attempts + 1,
            deadLettered: dead,
            error: message,
          });
        }
      }
      return published;
    } finally {
      this.running = false;
    }
  }

  /** Run ticks until the outbox is empty (tests and scripts). */
  async drain(maxRounds = 50): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.tick();
      total += n;
      if (n === 0) break;
    }
    return total;
  }
}
