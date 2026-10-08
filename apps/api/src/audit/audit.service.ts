import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { currentContext } from "../common/context.js";
import { DB, type Db, type Queryable } from "../db/db.js";
import { canonicalJson, sha256 } from "../common/util.js";

export interface AuditEntry {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

interface AuditRow {
  seq: number;
  event_id: string;
  occurred_at: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  correlation_id: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  prev_hash: string | null;
  hash: string;
}

function material(r: Omit<AuditRow, "seq" | "hash">): string {
  return canonicalJson({
    eventId: r.event_id,
    occurredAt: r.occurred_at,
    actor: r.actor,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    correlationId: r.correlation_id,
    before: r.before ?? null,
    after: r.after ?? null,
    metadata: r.metadata ?? null,
    prevHash: r.prev_hash,
  });
}

/**
 * Append-only, hash-chained audit log. Each row's hash covers its content and the previous row's hash, so
 * any edit or deletion breaks verification. Rows are written in the caller's transaction; the chain head row
 * lock serialises appends.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async record(q: Queryable, entry: AuditEntry): Promise<void> {
    const [head] = await q.query<{ last_hash: string | null }>(
      "SELECT last_hash FROM audit.chain_head WHERE id = 1 FOR UPDATE",
    );
    const row = {
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      actor: entry.actor,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      correlation_id: currentContext().correlationId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      metadata: entry.metadata ?? null,
      prev_hash: head.last_hash,
    };
    const hash = sha256(material(row));
    await q.query(
      `INSERT INTO audit.audit_event
        (event_id, occurred_at, actor, action, entity_type, entity_id, correlation_id, before, after, metadata, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)`,
      [
        row.event_id,
        row.occurred_at,
        row.actor,
        row.action,
        row.entity_type,
        row.entity_id,
        row.correlation_id,
        JSON.stringify(row.before),
        JSON.stringify(row.after),
        JSON.stringify(row.metadata),
        row.prev_hash,
        hash,
      ],
    );
    await q.query("UPDATE audit.chain_head SET last_hash = $1 WHERE id = 1", [hash]);
  }

  async list(filter: { entityType?: string; entityId?: string; limit?: number }) {
    const rows = await this.db.query<AuditRow>(
      `SELECT * FROM audit.audit_event
       WHERE ($1::text IS NULL OR entity_type = $1) AND ($2::text IS NULL OR entity_id = $2)
       ORDER BY seq DESC LIMIT $3`,
      [filter.entityType ?? null, filter.entityId ?? null, Math.min(filter.limit ?? 100, 500)],
    );
    return rows.map((r) => ({
      seq: r.seq,
      eventId: r.event_id,
      occurredAt: r.occurred_at,
      actor: r.actor,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      correlationId: r.correlation_id,
      before: r.before,
      after: r.after,
      metadata: r.metadata,
      prevHash: r.prev_hash,
      hash: r.hash,
    }));
  }

  async verify(): Promise<{ valid: boolean; checked: number; firstInvalidSeq: number | null }> {
    const rows = await this.db.query<AuditRow>("SELECT * FROM audit.audit_event ORDER BY seq");
    let prev: string | null = null;
    for (const r of rows) {
      if (r.prev_hash !== prev || sha256(material(r)) !== r.hash) {
        return { valid: false, checked: rows.length, firstInvalidSeq: r.seq };
      }
      prev = r.hash;
    }
    const [head] = await this.db.query<{ last_hash: string | null }>("SELECT last_hash FROM audit.chain_head WHERE id = 1");
    if (head.last_hash !== prev) return { valid: false, checked: rows.length, firstInvalidSeq: null };
    return { valid: true, checked: rows.length, firstInvalidSeq: null };
  }
}
