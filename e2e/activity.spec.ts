import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/activity";

const width = (info: TestInfo) => (info.project.name === "phone" ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `activity-${name}-${width(info)}.png`), fullPage });

async function open(page: Page, query = "") {
  await page.goto(`/dev/activity${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

const rows = (page: Page) => page.getByTestId("activity-row");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const bar = (page: Page) => page.getByTestId("undo-bar");

test.describe("/dev/activity", () => {
  test("newest first, grouped by day, with who, time and every undo state", async ({ page }, info) => {
    await open(page);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Today", "Yesterday", "Thursday, November 19"]);
    await expect(rows(page)).toHaveCount(12);
    await expect(rows(page).first()).toContainText('Deleted task "Film 6 Wordwise videos"');

    const task = row(page, "Film 6 Wordwise videos");
    await expect(task).toContainText("You");
    await expect(task).toContainText("11:48 AM");
    await expect(row(page, "Changed 3 transactions")).toContainText("Hydra");
    await expect(row(page, "Brand payment emails")).toContainText("Routine");

    await expect(row(page, 'Deleted rule "Uber').getByText("Undone")).toBeVisible();
    await expect(row(page, "Undid: Deleted rule").getByRole("button", { name: /^Redo/ })).toBeVisible();
    const sent = row(page, "Sent W-9");
    await expect(sent.getByText("Can't undo")).toBeVisible();
    await expect(sent.getByRole("button", { name: "Why not" })).toHaveAccessibleDescription(/outside Hydra/);
    await shot(page, info, "list", true);

    const dot = sent.getByRole("button", { name: "Why not" });
    if (info.project.name === "phone") await dot.click();
    else await dot.hover();
    await expect(page.locator("[data-radix-popper-content-wrapper]")).toContainText("It acted outside Hydra");
    await shot(page, info, "why-not");
  });

  test("a click on the summary opens its details; long summaries wrap", async ({ page }, info) => {
    await open(page);
    const long = row(page, "Renamed goal");
    const toggle = long.getByRole("button", { name: /^Renamed goal/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(long.getByRole("listitem")).toHaveCount(20);
    const box = await long.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(width(info));
    // No sideways scroll at either width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await long.scrollIntoViewIfNeeded();
    await shot(page, info, "details", true);
  });

  test("Undo marks the entry Undone and its undo shows at the top", async ({ page }) => {
    await open(page);
    await row(page, "Film 6 Wordwise videos").first().getByRole("button", { name: /^Undo: / }).click();
    await expect(rows(page).first()).toContainText('Undid: Deleted task "Film 6 Wordwise videos"');
    await expect(rows(page).first().getByRole("button", { name: /^Redo/ })).toBeVisible();
    await expect(row(page, 'Deleted task "Film 6').filter({ hasNotText: "Undid" }).getByText("Undone")).toBeVisible();
  });

  test("changed since: shows what changed, then Undo anyway", async ({ page }, info) => {
    await open(page);
    const r = row(page, "Changed 3 transactions");
    await r.getByRole("button", { name: /^Undo: / }).click();
    const alert = r.getByRole("alert");
    await expect(alert).toContainText("Changed since");
    await expect(alert).toContainText("Figma: now Design");
    await expect(alert).toContainText("Notion: row deleted since");
    await shot(page, info, "changed-since");
    await alert.getByRole("button", { name: "Undo anyway" }).click();
    await expect(r.getByText("Undone")).toBeVisible();
    await expect(rows(page).first()).toContainText("Undid: Changed 3 transactions");
  });

  test("changed since: Cancel leaves it as it was", async ({ page }) => {
    await open(page);
    const r = row(page, "Changed 3 transactions");
    await r.getByRole("button", { name: /^Undo: / }).click();
    await r.getByRole("button", { name: "Cancel" }).click();
    await expect(r.getByRole("alert")).toHaveCount(0);
    await expect(r.getByRole("button", { name: /^Undo: / })).toBeEnabled();
  });

  test("a failed undo says so in the row", async ({ page }, info) => {
    await open(page);
    const r = row(page, "Hid 14 transactions");
    await r.getByRole("button", { name: /^Undo: / }).click();
    await expect(r.getByRole("status")).toHaveText("Could not undo. Try again.");
    await r.scrollIntoViewIfNeeded();
    await shot(page, info, "failed");
  });

  test("blocked: says why, and offers no Undo anyway", async ({ page }, info) => {
    await open(page);
    await page.getByRole("button", { name: "Show more" }).click();
    const r = row(page, 'Deleted category "Gear"');
    await r.getByRole("button", { name: /^Undo: / }).click();
    const alert = r.getByRole("alert");
    await expect(alert).toContainText("Can't undo");
    await expect(alert).toContainText("A category with the same name exists now");
    await expect(alert.getByRole("button", { name: "Undo anyway" })).toHaveCount(0);
    await r.scrollIntoViewIfNeeded();
    await shot(page, info, "blocked");
    await alert.getByRole("button", { name: "OK" }).click();
    await expect(r.getByRole("alert")).toHaveCount(0);
  });

  test("an undo deep in the list keeps the pages already shown (UI-10)", async ({ page }) => {
    await open(page);
    const more = page.getByRole("button", { name: "Show more" });
    await more.click();
    await more.click();
    await expect(rows(page)).toHaveCount(32);
    const deep = row(page, "Trader Joe's #20");
    await deep.getByRole("button", { name: /^Undo: / }).click();
    await expect(rows(page).first()).toContainText("Undid: Changed category of \"Trader Joe's #20\"");
    await expect(rows(page)).toHaveCount(33);
    await expect(deep.getByText("Undone")).toBeVisible();
    await expect(row(page, "Old Chase checking")).toHaveCount(1);
  });

  test("Show more pages to the end, including an expired entry", async ({ page }, info) => {
    await open(page);
    const more = page.getByRole("button", { name: "Show more" });
    await more.click();
    await expect(rows(page)).toHaveCount(24);
    await more.click();
    await expect(rows(page)).toHaveCount(32);
    await expect(more).toHaveCount(0);
    const old = row(page, "Old Chase checking");
    await expect(old.getByText("Can't undo")).toBeVisible();
    await expect(old.getByRole("button", { name: "Why not" })).toHaveAccessibleDescription(/30 days/);
    await expect(page.getByRole("heading", { level: 2, name: /October/ })).toBeVisible();
    await shot(page, info, "paged", true);
  });

  test("empty list", async ({ page }, info) => {
    await open(page, "?state=empty");
    await expect(page.getByText("No activity yet")).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await shot(page, info, "empty");
  });

  test("loading skeleton", async ({ page }, info) => {
    await page.goto("/dev/activity/loading");
    await expect(page.getByRole("status", { name: "Loading Activity" })).toBeVisible();
    await shot(page, info, "loading");
  });

  test("nav: Activity in the sidebar (desktop) or the More sheet (phone)", async ({ page }, info) => {
    await open(page);
    if (info.project.name === "phone") {
      await page.getByRole("navigation", { name: "Tabs" }).getByRole("button", { name: "More" }).click();
      const link = page.getByRole("navigation", { name: "More" }).getByRole("link", { name: "Activity" });
      await expect(link).toHaveAttribute("aria-current", "page");
      await page.waitForTimeout(350);
      await shot(page, info, "nav");
    } else {
      await expect(page.getByRole("link", { name: "Activity" })).toHaveAttribute("aria-current", "page");
      await shot(page, info, "nav");
    }
  });
});

test.describe("undo bar", () => {
  test("Deleted <thing>. Undo — polite, keyboard reachable, Undo closes it", async ({ page }, info) => {
    await open(page, "?state=bar");
    const live = page.locator('[role="status"][aria-live="polite"]').filter({ has: bar(page) });
    await expect(live).toHaveCount(1);
    await expect(bar(page)).toHaveText(/Deleted task "Film 6 Wordwise videos"\.\s*Undo/);
    await page.waitForTimeout(300); // the fade-in settles
    await shot(page, info, "bar");

    // Keyboard: Tab reaches Undo, Enter runs it.
    const undo = bar(page).getByRole("button", { name: "Undo" });
    await undo.focus();
    await expect(undo).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(bar(page)).toHaveCount(0);
  });

  test("one at a time, Esc closes, a failure points to Activity", async ({ page }, info) => {
    await open(page, "?state=bar");
    await page.getByRole("button", { name: "Delete a transaction" }).click();
    await expect(bar(page)).toHaveCount(1);
    await expect(bar(page)).toContainText("Uber Eats");
    await page.waitForTimeout(300);
    await shot(page, info, "bar-long");

    await page.getByRole("button", { name: "Delete (undo fails)" }).click();
    await expect(bar(page)).toHaveCount(1);
    await bar(page).getByRole("button", { name: "Undo" }).click();
    await expect(bar(page)).toContainText("Could not undo.");
    await expect(bar(page).getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/activity");
    // Clear of the phone tabs and the agent orb.
    const orb = page.getByTestId("agent-status-phone");
    if (await orb.isVisible()) {
      const [b, o] = [await bar(page).boundingBox(), await orb.locator("..").boundingBox()];
      expect(b!.y + b!.height).toBeLessThanOrEqual(o!.y);
    }
    await shot(page, info, "bar-failed");

    await bar(page).getByRole("button", { name: "Dismiss" }).focus();
    await page.keyboard.press("Escape");
    await expect(bar(page)).toHaveCount(0);
  });

  test("goes away after 8 s, but not while hovered", async ({ page }) => {
    await page.clock.install();
    await open(page, "?state=bar");
    await bar(page).hover();
    await page.clock.runFor(9000);
    await expect(bar(page)).toBeVisible();
    await page.mouse.move(5, 5);
    await page.clock.runFor(7500);
    await expect(bar(page)).toBeVisible();
    await page.clock.runFor(700);
    await expect(bar(page)).toHaveCount(0);
  });

  test("an undo that ends after a newer delete leaves the newer bar up (UI-1)", async ({ page }) => {
    await open(page, "?state=bar");
    await bar(page).getByRole("button", { name: "Undo" }).click();
    await expect(bar(page)).toContainText("Undoing…");
    // The fixture's undo takes 300 ms: a second delete lands while the first is still running.
    await page.getByRole("button", { name: "Delete a deal" }).click();
    await expect(bar(page)).toContainText('Deleted deal "Wordwise November".');
    await page.waitForTimeout(700);
    await expect(bar(page)).toContainText('Deleted deal "Wordwise November".');
    await expect(bar(page).getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  test("the bar leaves with a short exit, then is gone (UI-6)", async ({ page }, info) => {
    await open(page, "?state=bar");
    // Hold every animation still, so the leaving frame can be seen and measured.
    const hold = await page.addStyleTag({ content: "*{animation-play-state:paused !important}" });
    await bar(page).getByRole("button", { name: "Dismiss" }).click();
    await expect(bar(page)).toHaveCount(0);
    const leaving = page.getByTestId("undo-bar-leaving");
    await expect(leaving).toHaveCount(1);
    expect(await leaving.evaluate((el) => [getComputedStyle(el).animationName, getComputedStyle(el).animationDuration])).toEqual(["exit", "0.15s"]);
    await expect(leaving).toHaveAttribute("aria-hidden", "true");
    await shot(page, info, "bar-leaving");
    await hold.evaluate((el) => (el as Element).remove());
    await expect(leaving).toHaveCount(0);
  });

  test("no motion under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, "?state=bar");
    expect(await bar(page).evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });
});
