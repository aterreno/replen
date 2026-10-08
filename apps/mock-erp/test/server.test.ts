import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createMockErp, type MockErp } from "../src/server.ts";

let erp: MockErp;
let base: string;

const payload = {
  VENDOR_NO: "SUP-1",
  SHIP_TO: "DC1",
  ORDER_DATE: "20261005",
  DELIVERY_DATE: "20261013",
  CURRENCY: "GBP",
  LINES: [{ LINE_NO: 10, ITEM_NO: "SKU-1", QTY: 12, UOM: "EA", UNIT_COST: 4.5 }],
};

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/erp/v1/purchase-orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer mock-erp-key", ...headers },
    body: JSON.stringify(body),
  });

before(async () => {
  erp = createMockErp();
  base = `http://127.0.0.1:${await erp.listen(0)}`;
});

after(() => erp.close());

test("creates an order and is idempotent on client reference", async () => {
  const first = await post(payload, { "x-client-reference": "ref-1" });
  assert.equal(first.status, 201);
  const { ERP_PO_NUMBER } = (await first.json()) as { ERP_PO_NUMBER: string };
  const again = await post(payload, { "x-client-reference": "ref-1" });
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { ERP_PO_NUMBER: string }).ERP_PO_NUMBER, ERP_PO_NUMBER);
  assert.equal(erp.orders.size, 1);
});

test("rejects bad credentials, missing reference and invalid payloads", async () => {
  const unauth = await fetch(`${base}/erp/v1/purchase-orders`, { method: "POST", body: "{}" });
  assert.equal(unauth.status, 401);
  assert.equal((await post(payload)).status, 400);
  const bad = await post({ ...payload, ORDER_DATE: "2026-10-05", LINES: [] }, { "x-client-reference": "ref-2" });
  assert.equal(bad.status, 422);
  const blocked = await post({ ...payload, VENDOR_NO: "BLOCKED-9" }, { "x-client-reference": "ref-3" });
  assert.equal(blocked.status, 422);
});

test("failure injection returns 503 then recovers", async () => {
  erp.failNext(1);
  assert.equal((await post(payload, { "x-client-reference": "ref-4" })).status, 503);
  assert.equal((await post(payload, { "x-client-reference": "ref-4" })).status, 201);
});
