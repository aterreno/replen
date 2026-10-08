import { expect, type Page, test } from "@playwright/test";

/**
 * Planner workflow against a freshly planned dataset (scripts/e2e.mjs runs the planning before these tests).
 * Tests run in order and share server state.
 */

async function signIn(page: Page, userId: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByTestId(`login-${userId}`).click();
  await page.waitForURL("**/proposals");
}

test("a viewer can read the queue but cannot decide", async ({ page }) => {
  await signIn(page, "viewer.vic");
  await expect(page.getByTestId("run-planning")).toHaveCount(0);
  await page.getByTestId("proposal-row-SUP-HOME").click();
  await expect(page.getByTestId("calc-ladder")).toBeVisible();
  await expect(page.getByTestId("approve")).toHaveCount(0);
  await expect(page.getByTestId("save-override")).toBeDisabled();
});

test("planner resolves an MOQ conflict, approves, and the PO reaches the ERP", async ({ page }) => {
  await signIn(page, "planner.priya");
  const home = page.getByTestId("proposal-row-SUP-HOME");
  await expect(home).toContainText("1 to decide");
  await home.click();

  await expect(page.getByTestId("unresolved-count")).toHaveText("1");
  await expect(page.getByTestId("approve")).toBeDisabled();
  await expect(page.getByTestId("approval-reasons")).toContainText("need a planner decision");

  await page.getByTestId("line-HOM-VAS-001").click();
  await expect(page.getByTestId("calc-ladder")).toContainText("Order-up-to level");
  await expect(page.getByTestId("calc-ladder")).toContainText("MOQ conflict");

  await page.getByRole("tab", { name: "Demand and forecast" }).click();
  await expect(page.getByTestId("demand-chart").locator("svg")).toBeVisible();
  await page.getByRole("tab", { name: "Why this quantity" }).click();

  await page.getByTestId("decide-decline-moq").click();
  await expect(page.getByTestId("final-HOM-VAS-001")).toContainText("0");
  await expect(page.getByTestId("unresolved-count")).toHaveText("0");

  // An invalid override is rejected with the API's explanation and changes nothing.
  await page.getByTestId("line-HOM-TWL-001").click();
  await page.getByTestId("final-qty").fill("25");
  await page.getByTestId("reason").selectOption("FORECAST_TOO_LOW");
  await page.getByTestId("save-override").click();
  await expect(page.getByTestId("override-form").getByRole("alert")).toContainText("multiple of the case pack 6");

  await page.getByTestId("approve").click();
  await expect(page.getByTestId("proposal-status")).toContainText("approved");
  await expect(page.getByTestId("po-link")).toContainText("submitted", { timeout: 15_000 });
  await expect(page.getByTestId("po-link")).toContainText("ERP 45");

  await page.getByTestId("po-link").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("RPO-");
  await expect(page.getByTestId("audit-trail")).toContainText("submitted");
});

test("over-limit proposal needs a second approver", async ({ page }) => {
  await signIn(page, "planner.priya");
  await page.getByTestId("proposal-row-SUP-ELEC").click();
  await expect(page.getByTestId("approve")).toBeDisabled();
  await expect(page.getByTestId("approval-reasons")).toContainText("exceeds your approval limit");
  await page.getByTestId("escalate").click();
  await expect(page.getByTestId("proposal-status")).toContainText("awaiting approval");
  const url = page.url();

  await signIn(page, "senior.sam");
  await page.goto(url);
  await expect(page.getByTestId("approve")).toBeEnabled();
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("po-link")).toContainText("submitted", { timeout: 15_000 });
});

test("what-if shows the effect of a demand uplift without changing the proposal", async ({ page }) => {
  await signIn(page, "planner.priya");
  await page.getByTestId("proposal-row-SUP-FASH").click();
  const before = await page.getByTestId("order-value").textContent();
  await page.getByTestId("whatif-uplift").fill("30");
  await page.getByTestId("whatif-run").click();
  await expect(page.getByTestId("whatif-totals")).toContainText("Units");
  await expect(page.getByTestId("order-value")).toHaveText(before ?? "");
});

test("KPIs and audit pages render from live data", async ({ page }) => {
  await signIn(page, "planner.priya");
  await page.goto("/kpis");
  await expect(page.getByTestId("kpi-wape")).toContainText("%");
  await expect(page.getByTestId("kpi-value-pos_submitted")).toHaveText("2");
  await expect(page.getByTestId("otif-chart")).toContainText("SUP-FURN");
  await page.goto("/activity");
  await expect(page.getByTestId("audit-verify")).toContainText("Audit chain verified");
});
