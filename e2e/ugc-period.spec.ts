import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/ugc-period";
const width = (info: TestInfo) => (info.project.name === "phone" ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `period-${name}-${width(info)}.png`), fullPage });

// Fixture numbers (src/components/ugc/fixture-data.ts, clock Sat Nov 21, 2026, Toronto), from
// src/components/ugc/model.ts periodTotals and src/lib/ugc/analytics.ts on the same rows.
const stat = (page: Page, label: string) => page.locator('[data-slot="stat"]').filter({ has: page.getByText(label, { exact: true }) });
const period = (page: Page) => page.getByRole("radiogroup", { name: "Period" });
const views = (page: Page) => page.getByRole("region", { name: "Views by deal", exact: true });
const pills = (page: Page) => page.getByRole("region", { name: "Posting calendar" });
const top = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!.y;

async function open(page: Page, query = "") {
  await page.goto(`/dev/ugc${query}`);
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await page.waitForTimeout(300);
}

async function revealViews(page: Page) {
  for (let i = 0; i < 12 && !(await views(page).count()); i++) await page.mouse.wheel(0, 600);
  await views(page).scrollIntoViewIfNeeded();
  await expect(views(page)).toBeVisible();
}

test.describe("/dev/ugc period", () => {
  test("Monthly by default: this month's numbers, the arrows step a month and the URL keeps it", async ({ page }, info) => {
    await open(page);
    await expect(period(page).getByRole("radio", { name: "Monthly" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("period-label")).toHaveText("November 2026");
    await expect(stat(page, "Earned")).toContainText("$6,974");
    await expect(stat(page, "Paid")).toContainText("$2,580");
    await expect(stat(page, "Owed")).toContainText("$11,629");
    await expect(stat(page, "Missed")).toContainText("$440");
    await expect(page.getByRole("img", { name: "Earned per day, November 2026" })).toBeVisible();
    await expect(page.locator("[data-bar]")).toHaveCount(30);
    await expect(pills(page)).toContainText("Hit target 13 of 21 days");
    // The period sits under the tabs, so the tabs never move when the period control shows or hides.
    expect((await period(page).boundingBox())!.y).toBeGreaterThan((await page.getByRole("tablist", { name: "UGC Tracker" }).boundingBox())!.y);
    await page.waitForTimeout(600);
    await shot(page, info, "monthly");

    await page.getByRole("button", { name: "Earlier month" }).click();
    await expect(page).toHaveURL(/from=2026-10-01&to=2026-10-31/);
    await expect(page).not.toHaveURL(/period=/);
    await expect(page.getByTestId("period-label")).toHaveText("October 2026");
    await expect(stat(page, "Earned")).toContainText("$7,134");
    await expect(stat(page, "Paid")).toContainText("$0");
    await expect(stat(page, "Owed")).toContainText("$7,234");
    // The posting calendar follows a monthly period.
    await expect(page.getByRole("grid", { name: "October 2026" })).toBeVisible();
    await revealViews(page);
    await expect(views(page)).toContainText("11,672,298");
    await expect(views(page)).toContainText("Studyfetch");
    // A reload keeps the period.
    await page.reload();
    await expect(page.getByTestId("period-label")).toHaveText("October 2026");
  });

  test("Weekly starts Monday; Daily steps a day; each drives the numbers and the analytics", async ({ page }, info) => {
    await open(page);
    await period(page).getByRole("radio", { name: "Weekly" }).click();
    await expect(page).toHaveURL(/period=weekly&from=2026-11-16&to=2026-11-22/);
    await expect(page.getByTestId("period-label")).toHaveText("Nov 16 – 22");
    await expect(stat(page, "Earned")).toContainText("$1,617");
    await expect(stat(page, "Paid")).toContainText("$0");
    await expect(stat(page, "Owed")).toContainText("$11,629");
    await expect(stat(page, "Missed")).toContainText("$195");
    await expect(page.locator("[data-bar]")).toHaveCount(7);
    // Days outside the week step back on the calendar.
    await expect(page.locator('a[data-state-day][aria-label^="Nov 16"]')).not.toHaveClass(/opacity-35/);
    await expect(page.locator('a[data-state-day][aria-label^="Nov 15"]')).toHaveClass(/opacity-35/);
    await expect(page.locator('a[data-state-day][aria-label^="Nov 23"]')).toHaveClass(/opacity-35/);
    // Weeks start Monday on the calendar too: the week is one row, Monday to Sunday.
    await expect(page.getByRole("grid", { name: "November 2026", exact: true }).locator("span").first()).toHaveText("M");
    const row = await top(page, 'a[data-state-day][aria-label^="Nov 16"]');
    expect(await top(page, 'a[data-state-day][aria-label^="Nov 22"]')).toBe(row);
    expect(await top(page, 'a[data-state-day][aria-label^="Nov 15"]')).toBeLessThan(row);
    // The pills count the week, not the month.
    await expect(pills(page)).toContainText("Hit target 2 of 6 days");
    await revealViews(page);
    await expect(views(page)).toContainText("1,435,086");
    await expect(views(page)).not.toContainText("Canvasly");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    await shot(page, info, "weekly");

    await page.getByRole("button", { name: "Earlier week" }).click();
    await expect(page.getByTestId("period-label")).toHaveText("Nov 9 – 15");
    await page.getByRole("button", { name: "Later week" }).click();
    await expect(page.getByTestId("period-label")).toHaveText("Nov 16 – 22");

    await period(page).getByRole("radio", { name: "Daily" }).click();
    await expect(page).toHaveURL(/period=daily&from=2026-11-21&to=2026-11-21/);
    await expect(page.getByTestId("period-label")).toHaveText("Sat, Nov 21");
    await page.getByRole("button", { name: "Earlier day" }).click();
    await expect(page.getByTestId("period-label")).toHaveText("Fri, Nov 20");
    await expect(stat(page, "Earned")).toContainText("$43");
    await expect(stat(page, "Missed")).toContainText("$50");
    await expect(page.locator("[data-bar]")).toHaveCount(1);
    await revealViews(page);
    await expect(views(page)).toContainText("1,712");
  });

  test("Custom opens the calendar; two picks set From – To on the control", async ({ page }, info) => {
    await open(page);
    await period(page).getByRole("radio", { name: "Custom" }).click();
    await expect(page).toHaveURL(/period=custom&from=2026-11-01&to=2026-11-30/);
    const button = page.getByTestId("period-range");
    await expect(button).toHaveText("Nov 1 – 30");
    await button.click();
    const pop = page.getByRole("dialog", { name: "Custom range" });
    await expect(pop).toBeVisible();
    await page.waitForTimeout(250);
    // The range calendar starts its weeks on Monday as well.
    await expect(pop.getByRole("columnheader").first()).toHaveAccessibleName("Mo");
    await shot(page, info, "custom-open");
    // The last day first: the range still comes out in order.
    await pop.locator('[data-day="2026-11-07"]').click();
    await expect(pop).toContainText("Nov 7 – …");
    await pop.locator('[data-day="2026-11-01"]').click();
    await expect(pop).toBeHidden();
    await expect(page).toHaveURL(/period=custom&from=2026-11-01&to=2026-11-07/);
    await expect(button).toHaveText("Nov 1 – 7");
    await expect(stat(page, "Earned")).toContainText("$2,577");
    await expect(stat(page, "Paid")).toContainText("$2,180");
    await expect(pills(page)).toContainText("Hit target 5 of 7 days");
    await expect(pills(page)).toContainText("Streak 2 days");
    await revealViews(page);
    await expect(views(page)).toContainText("2,637,892");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await shot(page, info, "custom");
    // Back to Monthly lands on the month that holds today.
    await period(page).getByRole("radio", { name: "Monthly" }).click();
    await expect(page.getByTestId("period-label")).toHaveText("November 2026");
  });

  test("a bad bookmark cannot ask for thousands of years: out-of-bounds days fall back, long ranges are cut to a year", async ({ page }) => {
    await open(page, "?period=custom&from=0001-01-01&to=9999-12-31");
    await expect(page.getByTestId("period-range")).toHaveText("Nov 21");
    await expect(page.locator("[data-bar]")).toHaveCount(1);
    await open(page, "?period=custom&from=2026-01-01&to=2099-12-31");
    await expect(page.getByTestId("period-range")).toHaveText("Jan 1, 2026 – Jan 1, 2027");
    await expect(page.locator("[data-bar]")).toHaveCount(366);
  });

  test("the period shows on Overview only; the deal filter narrows it", async ({ page }) => {
    await open(page, "?period=weekly&from=2026-11-18");
    await expect(page.getByTestId("period-label")).toHaveText("Nov 16 – 22");
    await page.getByRole("button", { name: "Deal", exact: true }).click();
    await page.getByRole("option", { name: /Brightleaf/ }).click();
    await expect(stat(page, "Paid")).toContainText("$0");
    await page.getByRole("tab", { name: "Videos" }).click();
    await expect(period(page)).toHaveCount(0);
    await expect(page.getByTestId("video-summary")).toBeVisible();
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByTestId("period-label")).toHaveText("Nov 16 – 22");
  });
});
