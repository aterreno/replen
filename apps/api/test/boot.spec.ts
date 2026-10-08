import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestApp, type TestApp } from "./helpers.js";

describe("boot", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("serves health and identity", async () => {
    const h = await t.http.get("/health").expect(200);
    expect(h.body.database).toContain("pglite");
    await t.http.get("/api/v1/me").expect(401);
    const tok = await t.token("planner.priya");
    const me = await t.http.get("/api/v1/me").set(auth(tok)).expect(200);
    expect(me.body).toMatchObject({ userId: "planner.priya", approvalLimit: 5000 });
  });
});
