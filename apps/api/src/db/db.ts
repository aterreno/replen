import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

/** Minimal SQL surface shared by node-postgres (Cloud SQL) and PGlite (tests, laptop dev). */
export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Multi-statement SQL without parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly kind: "pg" | "pglite";
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const DB = Symbol("DB");

const NUMERIC = 1700;
const INT8 = 20;
const DATE = 1082;
const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;

/** Postgres timestamp text -> ISO-8601 UTC with millisecond precision. */
export function toIso(value: string): string {
  let v = value.trim().replace(" ", "T");
  v = v.replace(/([+-]\d{2})$/, "$1:00");
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(v)) v += "Z";
  return new Date(v).toISOString();
}

const parsers: Record<number, (v: string) => unknown> = {
  [NUMERIC]: (v) => Number.parseFloat(v),
  [INT8]: (v) => Number.parseInt(v, 10),
  [DATE]: (v) => v,
  [TIMESTAMP]: toIso,
  [TIMESTAMPTZ]: toIso,
};

export class PgDb implements Db {
  readonly kind = "pg" as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    for (const [oid, fn] of Object.entries(parsers)) pg.types.setTypeParser(Number(oid), fn);
    // No session settings: transaction-mode poolers (Neon, PgBouncer) do not keep them. Timestamps are parsed
    // with their offset (toIso), so the session time zone does not matter.
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }

  async query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn({
        query: async <R>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as R[],
        exec: async (sql: string) => void (await client.query(sql)),
      });
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class PgliteDb implements Db {
  readonly kind = "pglite" as const;
  private constructor(private readonly pg: PGlite) {}

  /** dataDir undefined = in-memory (tests); a path = file-backed (laptop dev without Docker). */
  static async create(dataDir?: string): Promise<PgliteDb> {
    const db = new PGlite({ dataDir, parsers });
    await db.waitReady;
    await db.query("SET TIME ZONE 'UTC'");
    return new PgliteDb(db);
  }

  async query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pg.query<T>(sql, params)).rows;
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (t) =>
      fn({
        query: async <R>(sql: string, params: unknown[] = []) => (await t.query<R>(sql, params)).rows,
        exec: async (sql: string) => void (await t.exec(sql)),
      }),
    );
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
