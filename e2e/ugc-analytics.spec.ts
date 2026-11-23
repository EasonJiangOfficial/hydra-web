import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/ugc-analytics";
const width = (info: TestInfo) => (info.project.name === "phone" ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `analytics-${name}-${width(info)}.png`), fullPage });

// Numbers are the fixture's (src/components/ugc/fixture-data.ts, clock Nov 21, 2026, Toronto), checked by
// src/lib/ugc/analytics.test.ts's formulas: 160 counted posts, one excluded, three still ahead of the clock.
// The page's period drives the analytics; ALL is a custom period over every fixture post (the first is Sep 25).
const ALL = "?period=custom&from=2026-09-01&to=2026-11-21";
const block = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

async function open(page: Page, query = "") {
  await page.goto(`/dev/ugc${query}`);
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await page.waitForTimeout(300);
}

/** Scroll a block in so it trades its skeleton for content. */
async function reveal(page: Page, name: string) {
  const b = block(page, name);
  for (let i = 0; i < 12 && !(await b.count()); i++) await page.mouse.wheel(0, 600);
  await b.scrollIntoViewIfNeeded();
  await expect(b).toBeVisible();
  return b;
}

test.describe("/dev/ugc analytics", () => {
  test("every block shows below Overview, over a period that holds every post", async ({ page }, info) => {
    await open(page, ALL);
    await expect(page.getByRole("region", { name: "Analytics" })).toBeAttached();
    // Before a block nears the viewport it is a skeleton.
    await expect(page.locator('[data-analytics-block="loading"]').first()).toBeAttached();
    const views = await reveal(page, "Views by deal");
    await expect(views).toContainText("19,922,742");
    for (const deal of ["Wordwise", "Brightleaf", "Canvasly", "Studyfetch"]) await expect(views).toContainText(deal);
    await expect(views.getByRole("img", { name: "Views by deal" })).toBeVisible();
    const year = await reveal(page, "Posting consistency");
    await expect(year).toContainText("Streak 49 days");
    await expect(year.getByRole("gridcell")).toHaveCount(365);
    const eng = await reveal(page, "Engagement");
    for (const label of ["Views", "Likes", "Comments", "Earnings"]) await expect(eng).toContainText(label);
    await expect(eng).toContainText("19.9M");
    await expect(eng).toContainText("1.1M");
    await reveal(page, "Earnings over time");
    const pv = await reveal(page, "Views by platform");
    await expect(pv).toContainText("TikTok");
    await expect(pv).toContainText("Instagram");
    const vids = await reveal(page, "Videos by platform");
    await expect(vids).toContainText("156");
    await reveal(page, "View distribution");
    const top = await reveal(page, "Top videos");
    await expect(top).toContainText("Top videos (156)");
    await expect(top.locator("[data-post]")).toHaveCount(5);
    const recent = await reveal(page, "Recent posts");
    await expect(recent).toContainText("Recent posts (160)");
    await expect(recent.locator("[data-post]")).toHaveCount(10);
    await page.waitForTimeout(900);
    await shot(page, info, "all-time", true);
  });

  test("the page's period filters the windowed blocks; its own range picker is gone", async ({ page }, info) => {
    await open(page, "?period=weekly&from=2026-11-16");
    await expect(page.getByRole("radiogroup", { name: "Analytics range" })).toHaveCount(0);
    const views = await reveal(page, "Views by deal");
    await expect(views).toContainText("1,435,086");
    await expect(views).not.toContainText("Studyfetch");
    await expect(views).not.toContainText("Canvasly");
    await expect(await reveal(page, "Top videos")).toContainText(/Top videos \(\d+\)/);
    // Posting consistency and recent posts are not windowed (as in Ripple).
    await expect(await reveal(page, "Recent posts")).toContainText("Recent posts (160)");
    await expect(await reveal(page, "Posting consistency")).toContainText("Streak 49 days");
    await page.waitForTimeout(600);
    await shot(page, info, "weekly");
    // Monthly by default: November.
    await open(page);
    await expect(await reveal(page, "Views by deal")).toContainText("7,392,598");
  });

  test("the deal picker filters every block", async ({ page }, info) => {
    await open(page, ALL);
    await page.getByRole("button", { name: "Deal", exact: true }).click();
    await page.getByRole("option", { name: /Brightleaf/ }).click();
    const views = await reveal(page, "Views by deal");
    await expect(views).toContainText("2,494,732");
    await expect(views).not.toContainText("Wordwise");
    await expect(await reveal(page, "Posting consistency")).toContainText("Streak 3 days");
    await expect(await reveal(page, "Recent posts")).toContainText("Recent posts (28)");
    await page.waitForTimeout(900);
    await shot(page, info, "brightleaf", true);
  });

  test("platform cards switch to a calendar; lists show more", async ({ page }, info) => {
    await open(page, ALL);
    const pv = await reveal(page, "Views by platform");
    await pv.getByRole("radio", { name: "Calendar" }).click();
    await expect(pv.getByRole("grid", { name: /views per day, November 2026/ })).toBeVisible();
    await pv.getByRole("button", { name: "Previous month" }).click();
    await expect(pv.getByRole("grid", { name: /October 2026/ })).toBeVisible();
    await pv.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, info, "platform-calendar");
    const recent = await reveal(page, "Recent posts");
    await recent.getByRole("button", { name: "Show more" }).click();
    await expect(recent.locator("[data-post]")).toHaveCount(20);
    const top = await reveal(page, "Top videos");
    await top.getByRole("radio", { name: "Recent" }).click();
    await expect(top.locator("[data-post]")).toHaveCount(5);
  });
});
