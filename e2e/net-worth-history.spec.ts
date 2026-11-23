import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

/**
 * Net worth and balance history walked back from transactions (0115). Fixtures: /dev/dashboard has
 * real balances for its last 14 days only, /dev/accounts for the last 5 of 400 days; the days before are
 * estimated, and the hover says so. Screenshots go to SHOTS_DIR when set.
 */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/net-worth-history";
const width = (info: TestInfo) => (info.project.name === "phone" ? 390 : 1440);
const RANGES = ["1W", "1M", "3M", "YTD", "All"] as const;

async function hoverAt(page: Page, testId: string, x: number) {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} not visible`);
  await page.mouse.move(b.x + b.width * x, b.y + b.height * 0.6, { steps: 6 });
}

test.describe("net worth history", () => {
  test("the chart draws every range, and the hover marks estimated days", async ({ page }, info) => {
    const phone = info.project.name === "phone";
    await page.goto("/dev/dashboard");
    const nw = page.getByTestId("block-net-worth");
    await expect(nw).toBeVisible();
    await nw.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1400);
    const tip = page.getByTestId("net-worth-tip");
    const range = nw.getByRole("radiogroup", { name: "Range" });
    // The phone has no range switch (it shows 1M); the desktop draws each range.
    for (const r of phone ? (["1M"] as const) : RANGES) {
      if (!phone) await range.getByRole("radio", { name: r, exact: true }).click();
      await page.waitForTimeout(1100);
      await expect(nw.locator(".recharts-area-curve")).toBeVisible();
      await nw.screenshot({ path: path.join(SHOTS, `range-${r.toLowerCase()}-${width(info)}.png`) });
    }

    // An old day (All on desktop, 1M on the phone: day 24 of 30) is estimated.
    await hoverAt(page, "net-worth-chart", 0.2);
    await expect(tip).toContainText("Estimated from transactions");
    await nw.screenshot({ path: path.join(SHOTS, `hover-estimated-${width(info)}.png`) });

    // The last days have real balances.
    await page.mouse.move(2, 2);
    if (!phone) await range.getByRole("radio", { name: "1W", exact: true }).click();
    await page.waitForTimeout(1100);
    await hoverAt(page, "net-worth-chart", 0.95);
    await expect(tip).toBeVisible();
    await expect(tip).not.toContainText("Estimated");
    await nw.screenshot({ path: path.join(SHOTS, `hover-real-${width(info)}.png`) });
  });

  test("the account balance history marks estimated days too", async ({ page }, info) => {
    await page.goto("/dev/accounts");
    await page.waitForLoadState("networkidle");
    await page.getByRole("link", { name: /Chase Checking/ }).click();
    const panel = page.getByRole("dialog", { name: "Account" });
    const chart = panel.getByRole("img", { name: /Balance history of/ });
    await chart.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    const b = await chart.boundingBox();
    if (!b) throw new Error("balance history not visible");
    // The fixture runs 400 days back from 2026-11-21: an old day carries its year, and so does the
    // first day in the "since" line.
    await page.mouse.move(b.x + b.width * 0.05, b.y + b.height * 0.6, { steps: 6 });
    await expect(panel.getByText("Estimated from transactions")).toBeVisible();
    await expect(panel.getByText(/^[A-Z][a-z]{2} \d{1,2}, 2025$/)).toBeVisible();
    await expect(panel.getByText(/since Oct 18, 2025$/)).toBeVisible();
    await page.waitForTimeout(300); // the tip fades in
    await page.screenshot({ path: path.join(SHOTS, `account-history-estimated-${width(info)}.png`) });
    await page.mouse.move(b.x + b.width - 1, b.y + b.height * 0.6, { steps: 6 }); // the last day: real
    await expect(panel.getByText("Estimated from transactions")).toHaveCount(0);
  });
});
