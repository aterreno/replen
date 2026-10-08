import { Inject, Injectable } from "@nestjs/common";
import { DB, type Db } from "../db/db.js";
import { conflict, unprocessable } from "./errors.js";
import { canonicalJson, sha256 } from "./util.js";

export interface CommandResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Idempotency-Key handling for mutating commands. The first request with a key runs; repeats with the same
 * body replay the stored response; repeats with a different body are rejected. Failed commands release the
 * key so the client can retry.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async run<T>(
    key: string | undefined,
    actor: string,
    method: string,
    path: string,
    body: unknown,
    fn: () => Promise<{ status: number; body: T }>,
  ): Promise<CommandResult<T>> {
    if (!key) return { ...(await fn()), replayed: false };
    if (key.length > 200) throw unprocessable("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key longer than 200 characters");
    const hash = sha256(canonicalJson({ method, path, body }));
    const inserted = await this.db.query(
      `INSERT INTO messaging.idempotency_key (idempotency_key, actor, method, path, request_hash)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING idempotency_key`,
      [key, actor, method, path, hash],
    );
    if (inserted.length === 0) {
      const [row] = await this.db.query<{ request_hash: string; status_code: number | null; response: T }>(
        "SELECT request_hash, status_code, response FROM messaging.idempotency_key WHERE idempotency_key = $1 AND actor = $2",
        [key, actor],
      );
      if (row.request_hash !== hash) {
        throw unprocessable("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request");
      }
      if (row.status_code === null) throw conflict("IDEMPOTENCY_IN_PROGRESS", "A request with this key is in progress");
      return { status: row.status_code, body: row.response, replayed: true };
    }
    try {
      const result = await fn();
      await this.db.query(
        "UPDATE messaging.idempotency_key SET status_code = $3, response = $4::jsonb WHERE idempotency_key = $1 AND actor = $2",
        [key, actor, result.status, JSON.stringify(result.body)],
      );
      return { ...result, replayed: false };
    } catch (err) {
      await this.db.query("DELETE FROM messaging.idempotency_key WHERE idempotency_key = $1 AND actor = $2", [
        key,
        actor,
      ]);
      throw err;
    }
  }
}
