import { expect, test, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { scopeMenu, scopeSeg } from "./helpers/scope";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/ugc";

const isPhone = (info: TestInfo) => info.project.name === "phone";
const width = (info: TestInfo) => (isPhone(info) ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `ugc-${name}-${width(info)}.png`), fullPage });

// Fixture ids (src/components/ugc/fixture-data.ts): the clock is fixed at Saturday, November 21, 2026, Toronto.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WORDWISE = id(101);

/** Opens the fixture and waits until React has taken over (the stats tween in after hydration). */
async function open(page: Page, query = "") {
  await page.goto(`/dev/ugc${query}`);
  // A deep link opens a modal panel, which hides the page behind it from the accessibility tree.
  await expect(page.getByRole("heading", { name: "UGC Tracker", includeHidden: true })).toBeAttached();
  // The add-deal flows replace the tabs, and a panel hides them.
  if (!/flow=|day=|deal=/.test(query)) await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await page.waitForTimeout(300);
}

/** The text of one stat cell of the Overview strip. */
const stat = (page: Page, label: string) => page.locator('[data-slot="stat"]').filter({ hasText: label }).first();
const figure = async (page: Page, label: string) => (await stat(page, label).locator(".text-figure-s").innerText()).trim();
const day = (page: Page, label: string) => page.locator(`a[data-state-day][aria-label^="${label}"]`);

test.describe("/dev/ugc", () => {
  test("Overview: five numbers with their formulas, calendar, projection and earned per day", async ({ page }, info) => {
    await open(page);
    for (const label of ["Earned", "Paid", "Owed", "Missed", "Projected, 30 days"]) await expect(stat(page, label)).toBeVisible();
    // Paid is the three matched deposits: $1,280 + $400 + $900.
    await expect(stat(page, "Paid")).toContainText("$2,580");
    // The info dot carries the formula with the real numbers.
    await stat(page, "Owed").getByRole("button", { name: "More info" }).hover();
    // Owed is the balance at the end of the period (this month by default).
    await expect(page.getByText(/Balance at Nov 30: earned \$[\d,.]+ - paid \$2,580 = \$[\d,.]+/)).toBeVisible();
    await page.mouse.move(0, 0);
    await stat(page, "Projected, 30 days").getByRole("button", { name: "More info" }).hover();
    await expect(page.getByText(/Wordwise 2 x \$25 x 30 = \$1,500/)).toBeVisible();
    await expect(page.getByText(/Brightleaf 1 x \$40 x 30 = \$1,200/)).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page.getByRole("img", { name: "Earned per day, November 2026" })).toBeVisible();
    await expect(page.getByLabel("Posts per day for Wordwise")).toHaveValue("2");
    await page.waitForTimeout(500);
    await shot(page, info, "overview", true);
  });

  test("projection calculator is a what-if: it never changes the five numbers", async ({ page }) => {
    await open(page);
    const before = await figure(page, "Projected, 30 days");
    await page.getByLabel("Posts per day for Wordwise").fill("4");
    // 4 x $25 x 30 + 1 x $40 x 30 = $4,200
    await expect(page.getByTestId("projection-total")).toHaveText("$4,200");
    expect(await figure(page, "Projected, 30 days")).toBe(before);
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(page.getByTestId("projection-total")).toHaveText("$2,700");
  });

  test("calendar hover card, then the day panel with the target override", async ({ page }, info) => {
    await open(page);
    // Nov 18: Wordwise 1 of 2, Brightleaf 0 of 1, so $65 missed.
    await day(page, "Nov 18").hover();
    await expect(page.getByText("Wordwise 1 of 2").last()).toBeVisible();
    await expect(page.getByText("-$65 missed").last()).toBeVisible();
    await shot(page, info, "calendar-hover");
    await page.mouse.move(0, 0);

    await day(page, "Nov 18").click();
    await expect(page).toHaveURL(/day=2026-11-18/);
    const panel = page.getByTestId("day-panel");
    await expect(panel.getByRole("heading", { name: "Wednesday, November 18" })).toBeVisible();
    await expect(page.getByTestId("day-summary")).toContainText("1 of 3 posted");
    await expect(page.getByTestId("day-summary")).toContainText("-$65 missed");
    await expect(panel.getByText("Watch this before finals")).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, info, "day-panel");

    // A day off for Wordwise: its $25 is no longer missed.
    await panel.getByRole("button", { name: "Day off" }).first().click();
    await expect(page.getByTestId("day-summary")).toContainText("-$40 missed");
    await expect(panel.getByRole("region", { name: "Wordwise" }).getByText("Day off", { exact: true })).toBeVisible();
    // Removing the override asks first.
    await panel.getByRole("button", { name: "Reset" }).click();
    await expect(panel.getByText(/Remove the override for Wordwise\?/)).toBeVisible();
    await expect(page.getByTestId("day-summary")).toContainText("-$40 missed");
    await panel.getByRole("group", { name: "Confirm reset" }).getByRole("button", { name: "Cancel" }).click();
    await panel.getByRole("button", { name: "Reset" }).click();
    await panel.getByRole("group", { name: "Confirm reset" }).getByRole("button", { name: "Reset" }).click();
    await expect(page.getByTestId("day-summary")).toContainText("-$65 missed");

    // Escape closes the panel.
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/day=/);
  });

  test("a day with target 0 keeps no missed money (the fixture's Nov 11 day off)", async ({ page }) => {
    await open(page, "?day=2026-11-11");
    await expect(page.getByTestId("day-summary")).toBeVisible();
    await expect(page.getByTestId("day-summary")).not.toContainText("missed");
    await expect(page.getByTestId("day-panel").getByRole("region", { name: "Wordwise" }).getByText("Day off", { exact: true })).toBeVisible();
  });

  test("add a video from the day panel, then delete it (asks first)", async ({ page }) => {
    await open(page, "?day=2026-11-20");
    const panel = page.getByTestId("day-panel");
    // The form is closed on a day that already has videos.
    await panel.getByRole("button", { name: "Add a video" }).click();
    const form = panel.getByRole("form", { name: "Add a video" });
    await expect(form).toBeVisible();
    await form.getByLabel("Post link").fill("https://www.tiktok.com/@eason.ugc/video/7777777777");
    await form.getByLabel("Account").fill("@eason.ugc");
    await form.getByLabel("Title").fill("A brand new video");
    await form.getByRole("button", { name: "Add video" }).click();
    await expect(form.getByRole("status")).toHaveText("Added");
    const row = panel.locator("[data-day-video]").filter({ hasText: "A brand new video" });
    await expect(row).toBeVisible();

    // The same URL again is one post, not two (upsert on the normalized URL).
    await form.getByLabel("Post link").fill("https://tiktok.com/@eason.ugc/video/7777777777/?utm=x");
    await form.getByRole("button", { name: "Add video" }).click();
    await expect(panel.locator("[data-day-video]").filter({ hasText: "A brand new video" })).toHaveCount(1);

    await row.getByRole("button", { name: "Delete" }).click();
    await expect(row.getByText("Delete this video?")).toBeVisible();
    await row.getByRole("button", { name: "Cancel" }).click();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Delete" }).click();
    await row.getByRole("group").getByRole("button", { name: "Delete" }).click();
    await expect(row).toHaveCount(0);
  });

  test("Videos: hover cards, exclude from pay, search and CSV export", async ({ page }, info) => {
    await open(page, "?tab=videos");
    const summary = page.getByTestId("video-summary");
    await expect(summary).toContainText("1 excluded");

    // Views hover: a sparkline for a video with several readings. Total hover: base, CPM and bonus.
    const first = page.locator("[data-video]").filter({ hasText: "Watch this before finals" }).first();
    await first.getByRole("button").first().hover();
    await expect(page.getByText(/Last read Nov 21/).last()).toBeVisible();
    await page.mouse.move(0, 0);
    await first.getByRole("button").nth(1).hover();
    await expect(page.getByText(/Base \$25/).last()).toBeVisible();
    await expect(page.getByText(/CPM \$0/).last()).toBeVisible();
    await shot(page, info, "videos-hover");
    await page.mouse.move(0, 0);

    // Exclude: the row dims, the count goes up, and its pay is $0.
    await first.getByRole("button", { name: /Exclude Watch this before finals.* from pay/ }).click();
    await expect(summary).toContainText("2 excluded");
    await expect(first.getByRole("button", { name: /Count Watch this before finals.* in pay/ })).toHaveText("Excluded");
    await expect(first).toContainText("$0");
    await first.getByRole("button", { name: /Count Watch this before finals.* in pay/ }).click();
    await expect(summary).toContainText("1 excluded");

    // Search narrows the table; export gives a CSV of what is shown.
    await page.getByLabel("Search videos").fill("Roblox");
    await expect(page.locator("[data-video]").first()).toContainText("Roblox walkthrough");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("hydra-videos-2026-11-21.csv");
    const csv = fs.readFileSync((await file.path())!, "utf8");
    expect(csv.split("\n")[0]).toBe("Title,Link,Account,Platform,Deal,Posted,Views,Base,CPM,Bonus,Total,Pay");
    expect(csv).toContain("Roblox walkthrough");
    expect(csv).not.toContain("Watch this before finals");
    await page.getByLabel("Search videos").fill("");
    await page.waitForTimeout(300);
    await shot(page, info, "videos", false);
  });

  test("excluding a video lowers Earned on the Overview", async ({ page }) => {
    await open(page);
    const before = await figure(page, "Earned");
    await page.getByRole("tab", { name: "Videos" }).click();
    await page.locator("[data-video]").first().getByRole("button", { name: /Exclude .* from pay/ }).click();
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect.poll(() => figure(page, "Earned")).not.toBe(before);
  });

  test("Deals: list with logos, then the deal panel edits pay, payout and matches a deposit", async ({ page }, info) => {
    await open(page, "?tab=deals");
    for (const name of ["Wordwise", "Brightleaf", "Canvasly", "Studyfetch"]) await expect(page.getByRole("link", { name: `Open ${name}` })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Canvasly" })).toContainText("Paused");
    await expect(page.getByRole("link", { name: "Open Studyfetch" })).toContainText("Archived");
    await shot(page, info, "deals");

    await page.getByRole("link", { name: "Open Wordwise" }).click();
    await expect(page).toHaveURL(new RegExp(`deal=${WORDWISE}`));
    const panel = page.getByTestId("deal-panel");
    await expect(panel.getByLabel("Brand name")).toHaveValue("Wordwise");
    await page.waitForTimeout(400);
    await shot(page, info, "deal-panel");

    // Posts per day saves when it changes.
    await panel.getByLabel("Posts per day").fill("3");
    await panel.getByLabel("Posts per day").blur();
    await expect(panel.getByTestId("deal-saved")).toHaveText("Saved");

    // Pay structure: new base pay. Saved with its button; the deal's summary line follows.
    await panel.getByLabel("Base pay per video").fill("30");
    await panel.getByRole("button", { name: "Save pay structure" }).click();
    await expect(panel).toContainText("$30 base + 3 bonus tiers");
    // A bad tier is refused before anything is sent.
    await panel.getByRole("button", { name: "Add tier" }).click();
    await panel.getByLabel("Bonus tier views").last().fill("100000");
    await panel.getByLabel("Bonus tier amount").last().fill("5");
    await expect(panel.getByRole("alert")).toContainText("different views threshold");
    await expect(panel.getByRole("button", { name: "Save pay structure" })).toBeDisabled();
    await panel.getByLabel("Bonus tier views").last().fill("200000");
    await expect(panel.getByRole("button", { name: "Save pay structure" })).toBeEnabled();

    // Payout rule and matching: the open $1,100 deposit fits "WORDWISE" and lowers Owed.
    await panel.getByLabel("Bank deposit name contains").fill("WORDWISE INC");
    await panel.getByRole("button", { name: "Save payout" }).click();
    await expect(panel.getByTestId("deal-saved")).toHaveText("Saved");
    await expect(panel.locator("[data-deposit]")).toHaveCount(1);
    await expect(panel.locator("[data-payment]")).toHaveCount(1);
    await panel.getByRole("button", { name: /Match WORDWISE INC PAYOUT to Wordwise/ }).click();
    await expect(panel.locator("[data-payment]")).toHaveCount(2);
    await expect(panel.locator("[data-deposit]")).toHaveCount(0);

    // Unmatching asks first and puts the deposit back.
    const payment = panel.locator("[data-payment]").first();
    await payment.getByRole("button", { name: "Unmatch" }).click();
    await expect(payment.getByText("Unmatch this deposit?")).toBeVisible();
    await payment.getByRole("button", { name: "Cancel" }).click();
    await expect(panel.locator("[data-payment]")).toHaveCount(2);
    await payment.getByRole("button", { name: "Unmatch" }).click();
    await payment.getByRole("group").getByRole("button", { name: "Unmatch" }).click();
    await expect(panel.locator("[data-payment]")).toHaveCount(1);
  });

  test("a deal pauses, resumes, ends and deletes, and every one of the last two asks first", async ({ page }) => {
    await open(page, `?tab=deals&deal=${id(102)}`);
    const panel = page.getByTestId("deal-panel");
    await panel.getByRole("button", { name: "Pause" }).click();
    await expect(panel).toContainText("Paused");
    await panel.getByRole("button", { name: "Resume" }).click();
    await expect(panel).toContainText("Active");

    await panel.getByRole("button", { name: "Delete deal" }).click();
    await expect(panel.getByText(/Delete Brightleaf with its \d+ videos?, readings and payments\?/)).toBeVisible();
    await panel.getByRole("button", { name: "Cancel" }).click();
    // Cancelled: the deal is still in the list behind the panel.
    await expect(page.getByRole("link", { name: "Open Brightleaf", includeHidden: true })).toHaveCount(1);
    await panel.getByRole("button", { name: "Delete deal" }).click();
    await panel.getByRole("group").getByRole("button", { name: "Delete" }).click();
    await expect(page).not.toHaveURL(/deal=/);
    await expect(page.getByRole("link", { name: "Open Brightleaf" })).toHaveCount(0);
  });

  test("New deal: every step to the review, then Create opens the deal", async ({ page }, info) => {
    await open(page);
    await page.getByRole("button", { name: "New deal" }).click();
    await expect(page).toHaveURL(/flow=new/);
    const wiz = page.locator('[data-wizard="new"]');
    await expect(wiz.getByTestId("wizard-step")).toHaveText("1/5 · Name and dates");

    // A name is needed first.
    await expect(wiz.getByRole("button", { name: "Continue" })).toBeDisabled();
    await wiz.getByLabel("Deal name").fill("Acme Study");
    await shot(page, info, "wizard-new-basics");
    await wiz.getByRole("button", { name: "Continue" }).click();

    await expect(wiz.getByTestId("wizard-step")).toHaveText("2/5 · Daily target");
    await wiz.getByRole("button", { name: "One more post per day" }).click();
    await expect(wiz.getByLabel("Posts per day")).toHaveValue("2");
    await wiz.getByRole("button", { name: "Continue" }).click();

    await expect(wiz.getByTestId("wizard-step")).toHaveText("3/5 · Pay structure");
    await wiz.getByLabel("Base pay per video").fill("35");
    await wiz.getByRole("button", { name: "CPM", exact: true }).click();
    await wiz.getByLabel("CPM rate").fill("1.5");
    await page.waitForTimeout(300);
    await shot(page, info, "wizard-new-pay");
    await wiz.getByRole("button", { name: "Continue" }).click();

    await expect(wiz.getByTestId("wizard-step")).toHaveText("4/5 · Payout");
    await wiz.getByLabel("Bank deposit name contains").fill("ACME");
    await wiz.getByRole("button", { name: "Continue" }).click();

    await expect(wiz.getByTestId("wizard-step")).toHaveText("5/5 · Review");
    await expect(wiz).toContainText("Acme Study");
    await expect(wiz).toContainText("$35 base + $1.5 per 1K views");
    await expect(wiz).toContainText("2 videos a day");
    await expect(wiz).toContainText('Deposits containing "ACME"');
    await expect(wiz).toContainText("$2,100"); // 2 x 30 x $35
    await page.waitForTimeout(300);
    await shot(page, info, "wizard-new-review");

    await wiz.getByRole("button", { name: "Create deal" }).click();
    await expect(page).toHaveURL(/tab=deals/);
    await expect(page.getByTestId("deal-panel").getByLabel("Brand name")).toHaveValue("Acme Study");
    await expect(page).not.toHaveURL(/flow=/);
  });

  test("New deal keeps its draft through a reload and asks before discarding it", async ({ page }) => {
    await open(page, "?flow=new");
    const wiz = page.locator('[data-wizard="new"]');
    await wiz.getByLabel("Deal name").fill("Draft Co");
    await wiz.getByRole("button", { name: "Continue" }).click();
    await expect(wiz.getByTestId("wizard-step")).toHaveText("2/5 · Daily target");
    await page.reload();
    await expect(wiz.getByTestId("wizard-step")).toHaveText("2/5 · Daily target");
    await wiz.getByRole("button", { name: "Back to Step 1, Name and dates" }).click();
    await expect(wiz.getByLabel("Deal name")).toHaveValue("Draft Co");

    await wiz.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("alertdialog", { name: "Discard this draft" })).toBeVisible();
    await page.getByRole("button", { name: "Keep editing" }).click();
    await expect(wiz.getByLabel("Deal name")).toHaveValue("Draft Co");
    await wiz.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page).not.toHaveURL(/flow=/);
    await expect(page.getByRole("link", { name: "Open Draft Co" })).toHaveCount(0);
    // Nothing is left to resume.
    await page.goto("/dev/ugc?flow=new");
    await expect(page.locator('[data-wizard="new"]').getByLabel("Deal name")).toHaveValue("");
  });

  test("Add existing: pick a deal from Hydra or Ripple, every step to the review", async ({ page }, info) => {
    await open(page);
    await page.getByRole("button", { name: "Add existing" }).click();
    await expect(page).toHaveURL(/flow=existing/);
    const wiz = page.locator('[data-wizard="existing"]');
    await expect(wiz.getByTestId("wizard-step")).toHaveText("1/6 · Pick a deal");
    await expect(wiz.getByRole("button", { name: "Continue" })).toBeDisabled();
    // Deals already in Hydra and Ripple's masters are both offered; no step connects a social account.
    await expect(wiz.locator("[data-option^='deal:']")).toHaveCount(4);
    await expect(wiz.locator("[data-option^='template:']")).toHaveCount(3);
    await expect(wiz).not.toContainText(/connect/i);
    await wiz.getByLabel("Search deals").fill("clue");
    await expect(wiz.locator("[data-option]")).toHaveCount(1);
    await wiz.locator("[data-option]").click();
    await expect(wiz.getByRole("radio", { checked: true })).toContainText("Cluely");
    await shot(page, info, "wizard-existing-pick");
    await wiz.getByRole("button", { name: "Continue" }).click();

    // The name and the structure come from the source; the dates start today.
    await expect(wiz.getByTestId("wizard-step")).toHaveText("2/6 · Name and dates");
    await expect(wiz.getByLabel("Deal name")).toHaveValue("Cluely");
    await expect(wiz.getByLabel("Start date")).toHaveValue("Nov 21, 2026");
    await wiz.getByLabel("Deal name").fill("Cluely Fall");
    await wiz.getByRole("button", { name: "Continue" }).click();
    await expect(wiz.getByTestId("wizard-step")).toHaveText("3/6 · Daily target");
    await wiz.getByRole("button", { name: "Continue" }).click();
    await expect(wiz.getByTestId("wizard-step")).toHaveText("4/6 · Pay structure");
    await expect(wiz.getByLabel("Base pay per video")).toHaveValue("30");
    await expect(wiz.getByLabel("CPM rate")).toHaveValue("1.5");
    await expect(wiz.getByLabel("CPM cap views")).toHaveValue("500000");
    await wiz.getByRole("button", { name: "Continue" }).click();
    await expect(wiz.getByTestId("wizard-step")).toHaveText("5/6 · Payout");
    await expect(wiz.getByLabel("Bank deposit name contains")).toHaveValue("CLUELY");
    await wiz.getByRole("button", { name: "Continue" }).click();
    await expect(wiz.getByTestId("wizard-step")).toHaveText("6/6 · Review");
    await expect(wiz).toContainText("Cluely Fall");
    await expect(wiz).toContainText("$30 base + $1.5 per 1K views");
    await page.waitForTimeout(300);
    await shot(page, info, "wizard-existing-review");

    await wiz.getByRole("button", { name: "Create deal" }).click();
    await expect(page.getByTestId("deal-panel").getByLabel("Brand name")).toHaveValue("Cluely Fall");
  });

  test("missed-day view warning on the Overview, with each day behind the info dot", async ({ page }, info) => {
    await open(page);
    const gap = page.getByTestId("view-gap");
    await expect(gap).toHaveText(/Views missing for 2 days/);
    await gap.getByRole("button", { name: "Missing views by day" }).click();
    await expect(page.getByText("Nov 19: 6 of 9 posts read")).toBeVisible();
    await expect(page.getByText("Nov 20: 0 of 9 posts read")).toBeVisible();
    await shot(page, info, "views-warning");
  });

  test("a held reading is accepted from the Videos tab and then counts", async ({ page }, info) => {
    await open(page, "?tab=videos");
    const accept = page.getByRole("button", { name: /^Accept 4\.2M views for / });
    await expect(accept).toHaveCount(1);
    const key = await page.locator("[data-video]").filter({ has: accept }).getAttribute("data-video");
    const row = page.locator(`[data-video="${key}"]`);
    await expect(row).not.toContainText("4.2M views");
    await accept.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, info, "videos-held");
    // The money is on screen at every width: the table never scrolls sideways.
    const table = page.locator('[aria-label="Videos"] [data-slot="table-container"]');
    expect(await table.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await expect(row.locator("td").nth(5)).toBeInViewport();
    const before = await row.locator("td").nth(5).innerText();
    await accept.click();
    await expect(page.getByRole("button", { name: /^Accept / })).toHaveCount(0);
    await expect(row.locator("td").nth(4)).toContainText("4.2M");
    expect(await row.locator("td").nth(5).innerText()).not.toBe(before);
  });

  test("the deal panel shows whole figures at every width, and pausing keeps past missed money", async ({ page }, info) => {
    await open(page, `?tab=deals&deal=${WORDWISE}`);
    const panel = page.getByTestId("deal-panel");
    await expect(panel.getByLabel("Brand name")).toHaveValue("Wordwise");
    const figures = panel.locator("dd");
    await expect(figures).toHaveCount(4);
    for (const dd of await figures.all()) {
      expect(await dd.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      await expect(dd).not.toContainText("…");
    }
    await expect(panel.getByRole("button", { name: "About rate changes" })).toBeVisible();
    await expect(panel.locator("p", { hasText: "Old videos keep the rate" })).toHaveCount(0);
    await page.waitForTimeout(400);
    await shot(page, info, "deal-panel-figures");

    const missed = await figures.nth(3).innerText();
    expect(missed).toMatch(/^-\$[\d,]+$/);
    await panel.getByRole("button", { name: "Pause" }).click();
    await expect(panel).toContainText("Paused");
    await expect(figures.nth(3)).toHaveText(missed);
  });

  test("a deal logo uploads from the deal panel and from the new deal flow", async ({ page }) => {
    // A 1x1 PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await open(page, `?tab=deals&deal=${id(102)}`);
    const panel = page.getByTestId("deal-panel");
    await expect(panel.locator("img")).toHaveCount(0);
    await panel.getByLabel("Add logo").setInputFiles({ name: "brightleaf.png", mimeType: "image/png", buffer: png });
    await expect(panel.locator("img").first()).toHaveAttribute("src", /^blob:/);
    await expect(panel.getByLabel("Change logo")).toBeAttached();
    // Not an image: refused before anything is stored.
    await panel.getByLabel("Change logo").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
    await expect(panel.getByRole("alert")).toContainText("PNG, JPEG, WebP or GIF");

    await open(page, "?flow=new");
    const wiz = page.locator('[data-wizard="new"]');
    await wiz.getByLabel("Deal name").fill("Logo Co");
    await wiz.getByLabel("Add logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
    await expect(wiz.locator("img")).toHaveCount(1);
    for (let step = 1; step < 5; step++) await wiz.getByRole("button", { name: "Continue" }).click();
    await expect(wiz.getByTestId("wizard-step")).toHaveText("5/5 · Review");
    await wiz.getByRole("button", { name: "Create deal" }).click();
    await expect(page.getByTestId("deal-panel").getByLabel("Brand name")).toHaveValue("Logo Co");
    await expect(page.getByTestId("deal-panel").locator("img").first()).toHaveAttribute("src", /^blob:/);
  });

  test("a logo the new deal flow could not save is named in the deal panel until a pick lands", async ({ page }, info) => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await open(page, `?tab=deals&deal=${id(102)}&logofail=${id(102)}`);
    const panel = page.getByTestId("deal-panel");
    await expect(panel.getByRole("alert")).toHaveText("Logo not saved");
    await page.screenshot({ path: info.outputPath("deal-logo-not-saved.png") });
    await panel.getByLabel("Add logo").setInputFiles({ name: "brightleaf.png", mimeType: "image/png", buffer: png });
    await expect(panel.locator("img").first()).toHaveAttribute("src", /^blob:/);
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(page).not.toHaveURL(/logofail=/);
  });

  test("tabs and the deal filter", async ({ page }) => {
    await open(page);
    await page.getByRole("tab", { name: "Videos" }).click();
    await expect(page).toHaveURL(/tab=videos/);
    await expect(page.getByTestId("video-summary")).toContainText("160 videos");
    await page.getByRole("button", { name: "Deal", exact: true }).click();
    await page.getByRole("option", { name: /Brightleaf/ }).click();
    await expect(page.getByTestId("video-summary")).not.toContainText("160 videos");
    await page.getByRole("tab", { name: "Deals" }).click();
    await expect(page.getByRole("button", { name: "Deal", exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page).not.toHaveURL(/tab=/);
    // Month navigation keeps the calendar honest.
    await page.getByRole("button", { name: "Previous month" }).click();
    await expect(page.getByText("October 2026").first()).toBeVisible();
    await page.getByRole("button", { name: "Next month" }).click();
    await expect(page.getByText("November 2026").first()).toBeVisible();
  });

  test("the deal picker: logos, keyboard, type-ahead, archived deals behind a toggle", async ({ page }, info) => {
    await open(page);
    const trigger = page.getByRole("button", { name: "Deal", exact: true });
    await expect(trigger).toContainText("All deals");
    await expect(page.locator("select")).toHaveCount(0);
    await page.waitForTimeout(200);
    await shot(page, info, "picker-closed");

    // Keyboard: the arrow opens it, typing jumps to a brand, Enter picks.
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const list = page.getByRole("listbox", { name: "Deal" });
    await expect(list).toBeFocused();
    // Rows carry the brand's logo (Wordwise has one) or its initial.
    await expect(list.getByRole("option", { name: /Wordwise/ }).locator("img")).toHaveCount(1);
    await expect(list.getByRole("option", { name: /Brightleaf/ })).toContainText("T");
    // Studyfetch ended: it stays out until Show archived.
    await expect(list.getByRole("option", { name: /Studyfetch/ })).toHaveCount(0);
    await page.waitForTimeout(250);
    await shot(page, info, "picker-open");
    await page.keyboard.type("te");
    await expect(page.locator('[role="option"][data-deal-option]').filter({ hasText: "Brightleaf" })).toHaveAttribute(
      "id",
      (await list.getAttribute("aria-activedescendant"))!,
    );
    await page.keyboard.press("Enter");
    await expect(list).toHaveCount(0);
    await expect(trigger).toContainText("Brightleaf");
    await expect(trigger).toBeFocused();

    // Escape closes without picking.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(trigger).toContainText("Brightleaf");

    // Show archived lists the ended deal, marked.
    await trigger.click();
    await page.getByRole("button", { name: "Show archived (1)" }).click();
    await expect(list.getByRole("option", { name: /Studyfetch/ })).toContainText("Archived");
    await page.waitForTimeout(250);
    await shot(page, info, "picker-archived");
    await page.keyboard.press("Escape");
  });

  test("archive and restore a deal from its picker row, and delete asks first with its name", async ({ page }, info) => {
    await open(page);
    const trigger = page.getByRole("button", { name: "Deal", exact: true });
    await trigger.click();
    const list = page.getByRole("listbox", { name: "Deal" });
    // In the list, a row's "..." is for the mouse (the keyboard opens it with ArrowRight), so it is hidden from the tree.
    const more = (brand: string) => page.getByRole("button", { name: `More for ${brand}`, includeHidden: true });
    if (!isPhone(info)) {
      // The "..." names itself on hover.
      await more("Brightleaf").hover();
      await page.waitForTimeout(400);
      await shot(page, info, "picker-more-hover");
    }
    await more("Brightleaf").click();
    const menu = page.getByRole("menu", { name: "More for Brightleaf" });
    await expect(menu.getByRole("menuitem", { name: "Archive" })).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, info, "picker-row-menu");
    await menu.getByRole("menuitem", { name: "Archive" }).click();
    await expect(list.getByRole("option", { name: /Brightleaf/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Show archived (2)" }).click();
    await more("Brightleaf").click();
    await menu.getByRole("menuitem", { name: "Restore" }).click();
    await expect(list.getByRole("option", { name: /Brightleaf/ })).not.toContainText("Archived");

    // Delete asks first, naming the deal; Cancel keeps it.
    await more("Canvasly").click();
    const canvasly = page.getByRole("menu", { name: "More for Canvasly" });
    await canvasly.getByRole("menuitem", { name: "Delete" }).click();
    await expect(canvasly).toContainText(/Delete Canvasly with its \d+ videos?, readings and payments\?/);
    await page.waitForTimeout(200);
    await shot(page, info, "picker-delete-ask");
    await canvasly.getByRole("menuitem", { name: "Cancel" }).click();
    await expect(list.getByRole("option", { name: /Canvasly/ })).toHaveCount(1);
    await canvasly.getByRole("menuitem", { name: "Delete" }).click();
    await canvasly.getByRole("menuitem", { name: "Delete" }).click();
    await expect(list.getByRole("option", { name: /Canvasly/ })).toHaveCount(0);
  });

  test("the picker's row menus from the keyboard: ArrowRight opens one, its keys stay in it, focus comes back", async ({ page }, info) => {
    await open(page);
    const trigger = page.getByRole("button", { name: "Deal", exact: true });
    const list = page.getByRole("listbox", { name: "Deal" });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(list).toBeFocused();

    // A space typed inside a name is type-ahead, not a pick.
    await page.keyboard.type("op");
    await page.keyboard.press(" ");
    await expect(list).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(trigger).toContainText("All deals");

    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(list).toBeFocused();

    // ArrowRight opens the active row's menu; its arrows and Enter act in the menu, not on the list.
    await page.keyboard.type("te");
    await page.keyboard.press("ArrowRight");
    const menu = page.getByRole("menu", { name: "More for Brightleaf" });
    await expect(menu).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, info, "picker-row-menu-keyboard");
    // The menu opens on its first item.
    await expect(menu.getByRole("menuitem", { name: "Archive" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    // Brightleaf is archived, the list is still open with focus back on it, and the filter did not move.
    await expect(list).toBeFocused();
    await expect(list.getByRole("option", { name: /Brightleaf/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show archived (2)" })).toBeVisible();
    await expect(trigger).toContainText("All deals");

    // Tab from the list never stops on a row's "..." button.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-deal-menu"))).toBe(false);
  });

  test("a day card has the deal's menu: archive keeps it until its end date, delete asks first", async ({ page }, info) => {
    await open(page, "?day=2026-11-18");
    const panel = page.getByTestId("day-panel");
    const card = panel.getByRole("region", { name: "Wordwise" });
    await card.getByRole("button", { name: "More for Wordwise" }).click();
    const menu = page.getByRole("menu", { name: "More for Wordwise" });
    await page.waitForTimeout(200);
    await shot(page, info, "day-card-menu");
    await menu.getByRole("menuitem", { name: "Archive" }).click();
    await expect(menu).toHaveCount(0);
    // Archived today (Nov 21): Nov 18 is inside its dates, so the card stays, now with Restore.
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "More for Wordwise" }).click();
    await expect(menu.getByRole("menuitem", { name: "Restore" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Delete" }).click();
    await expect(menu).toContainText(/Delete Wordwise with its \d+ videos?, readings and payments\?/);
    await menu.getByRole("menuitem", { name: "Cancel" }).click();
    await expect(card).toBeVisible();
    await page.keyboard.press("Escape");
    // The Add a video picker lists only deals that run that day: Studyfetch ended Oct 31.
    await panel.getByRole("button", { name: "Add a video" }).click();
    const form = panel.getByRole("form", { name: "Add a video" });
    await form.getByRole("button", { name: "Deal", exact: true }).click();
    await expect(page.getByRole("listbox", { name: "Deal" }).getByRole("option")).not.toHaveCount(0);
    await expect(page.getByRole("option", { name: /Studyfetch/ })).toHaveCount(0);
    await page.waitForTimeout(200);
    await shot(page, info, "day-add-picker");
  });

  test("the scope switch is not on the UGC page, and stays on pages it filters", async ({ page }, info) => {
    await open(page);
    await expect(page.getByRole("radiogroup", { name: "Scope" })).toHaveCount(0);
    await expect(scopeMenu(page)).toHaveCount(0);
    await shot(page, info, "no-scope");
    await page.goto("/dev/transactions");
    await expect(isPhone(info) ? scopeMenu(page) : scopeSeg(page)).toHaveCount(1);
  });
});
