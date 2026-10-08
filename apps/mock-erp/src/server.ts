/**
 * Mock ERP purchase-order API (assumption A-23). Field names, date format and line numbering are deliberately
 * unlike Replen's canonical model so the anti-corruption adapter in replen-api has real translation to do.
 *
 * Behaviour:
 * - POST /erp/v1/purchase-orders requires `Authorization: Bearer <key>` and `X-Client-Reference`.
 *   First submission: 201 with a new ERP_PO_NUMBER. Same reference again: 200 with the original number.
 * - Vendors starting with "BLOCKED" are rejected with 422 (non-retryable).
 * - Failure injection: MOCK_ERP_FAIL_FIRST=n env, POST /erp/v1/admin/fail-next {count}, or header x-mock-fail: 503.
 * State is in memory and lost on restart.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

export interface ErpLine {
  LINE_NO: number;
  ITEM_NO: string;
  QTY: number;
  UOM: string;
  UNIT_COST: number;
}

export interface ErpOrder {
  ERP_PO_NUMBER: string;
  CLIENT_REFERENCE: string;
  VENDOR_NO: string;
  SHIP_TO: string;
  ORDER_DATE: string;
  DELIVERY_DATE: string;
  CURRENCY: string;
  EXT_REF?: string;
  LINES: ErpLine[];
  STATUS: "CREATED";
  RECEIVED_AT: string;
}

export interface MockErpOptions {
  apiKey?: string;
  failFirst?: number;
}

export interface MockErp {
  server: Server;
  orders: Map<string, ErpOrder>;
  requests: number;
  failNext(count: number): void;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function validate(body: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const f of ["VENDOR_NO", "SHIP_TO", "ORDER_DATE", "DELIVERY_DATE", "CURRENCY"]) {
    if (typeof body[f] !== "string" || !body[f]) errors.push(`${f} is required`);
  }
  for (const f of ["ORDER_DATE", "DELIVERY_DATE"]) {
    if (typeof body[f] === "string" && !/^\d{8}$/.test(body[f] as string)) errors.push(`${f} must be YYYYMMDD`);
  }
  const lines = body.LINES;
  if (!Array.isArray(lines) || lines.length === 0) errors.push("LINES must be a non-empty array");
  else {
    lines.forEach((l: Record<string, unknown>, i) => {
      if (!Number.isInteger(l.QTY) || (l.QTY as number) <= 0) errors.push(`LINES[${i}].QTY must be a positive integer`);
      if (typeof l.ITEM_NO !== "string") errors.push(`LINES[${i}].ITEM_NO is required`);
      if (typeof l.UNIT_COST !== "number" || (l.UNIT_COST as number) < 0) errors.push(`LINES[${i}].UNIT_COST invalid`);
    });
  }
  return errors;
}

export function createMockErp(options: MockErpOptions = {}): MockErp {
  const apiKey = options.apiKey ?? "mock-erp-key";
  const orders = new Map<string, ErpOrder>();
  let failRemaining = options.failFirst ?? 0;
  let seq = 4500100000;

  const state: MockErp = {
    server: undefined as unknown as Server,
    orders,
    requests: 0,
    failNext(count: number) {
      failRemaining = count;
    },
    listen(port = 0) {
      return new Promise((resolve) => {
        state.server.listen(port, "127.0.0.1", () => {
          const addr = state.server.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      });
    },
    close() {
      return new Promise((resolve) => state.server.close(() => resolve()));
    },
  };

  state.server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok", orders: orders.size });

      if (req.method === "POST" && url.pathname === "/erp/v1/admin/fail-next") {
        const body = (await readJson(req)) as { count?: number };
        failRemaining = body.count ?? 1;
        return send(res, 200, { failNext: failRemaining });
      }

      if (url.pathname.startsWith("/erp/v1/purchase-orders")) {
        if (req.headers.authorization !== `Bearer ${apiKey}`) {
          return send(res, 401, { ERRORS: [{ CODE: "AUTH", MSG: "invalid credentials" }] });
        }
        if (req.method === "GET" && url.pathname === "/erp/v1/purchase-orders") {
          return send(res, 200, [...orders.values()]);
        }
        const match = url.pathname.match(/^\/erp\/v1\/purchase-orders\/(\d+)$/);
        if (req.method === "GET" && match) {
          const order = [...orders.values()].find((o) => o.ERP_PO_NUMBER === match[1]);
          return order ? send(res, 200, order) : send(res, 404, { ERRORS: [{ CODE: "NOT_FOUND", MSG: "unknown PO" }] });
        }
        if (req.method === "POST" && url.pathname === "/erp/v1/purchase-orders") {
          state.requests++;
          if (failRemaining > 0 || req.headers["x-mock-fail"] === "503") {
            if (failRemaining > 0) failRemaining--;
            return send(res, 503, { ERRORS: [{ CODE: "UNAVAILABLE", MSG: "ERP batch window, retry later" }] });
          }
          const ref = req.headers["x-client-reference"];
          if (typeof ref !== "string" || !ref) {
            return send(res, 400, { ERRORS: [{ CODE: "REF", MSG: "X-Client-Reference header required" }] });
          }
          const existing = orders.get(ref);
          if (existing) return send(res, 200, { ERP_PO_NUMBER: existing.ERP_PO_NUMBER, STATUS: existing.STATUS });
          const body = (await readJson(req)) as Record<string, unknown>;
          const errors = validate(body);
          if (String(body.VENDOR_NO ?? "").startsWith("BLOCKED")) errors.push("VENDOR_NO is blocked for purchasing");
          if (errors.length) return send(res, 422, { ERRORS: errors.map((m) => ({ CODE: "VALIDATION", MSG: m })) });
          seq++;
          const order: ErpOrder = {
            ERP_PO_NUMBER: String(seq),
            CLIENT_REFERENCE: ref,
            VENDOR_NO: body.VENDOR_NO as string,
            SHIP_TO: body.SHIP_TO as string,
            ORDER_DATE: body.ORDER_DATE as string,
            DELIVERY_DATE: body.DELIVERY_DATE as string,
            CURRENCY: body.CURRENCY as string,
            EXT_REF: body.EXT_REF as string | undefined,
            LINES: body.LINES as ErpLine[],
            STATUS: "CREATED",
            RECEIVED_AT: new Date().toISOString(),
          };
          orders.set(ref, order);
          return send(res, 201, { ERP_PO_NUMBER: order.ERP_PO_NUMBER, STATUS: order.STATUS });
        }
      }
      send(res, 404, { ERRORS: [{ CODE: "NOT_FOUND", MSG: `${req.method} ${url.pathname}` }] });
    } catch (err) {
      send(res, 500, { ERRORS: [{ CODE: "INTERNAL", MSG: err instanceof Error ? err.message : String(err) }] });
    }
  });
  return state;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const erp = createMockErp({
    apiKey: process.env.ERP_API_KEY,
    failFirst: Number(process.env.MOCK_ERP_FAIL_FIRST ?? 0),
  });
  const port = await erp.listen(Number(process.env.MOCK_ERP_PORT ?? 4100));
  process.stdout.write(JSON.stringify({ service: "mock-erp", msg: "listening", port }) + "\n");
}
