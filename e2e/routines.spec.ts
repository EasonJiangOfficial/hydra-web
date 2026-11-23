import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { pickOption } from "./helpers/controls";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/routines";

const isPhone = (info: TestInfo) => info.project.name === "phone";
const width = (info: TestInfo) => (isPhone(info) ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `routines-${name}-${width(info)}.png`), fullPage });

/** Opens the fixture and waits until React has taken over. */
async function open(page: Page) {
  await page.goto("/dev/routines");
  await expect(page.getByRole("button", { name: "New routine" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

// By test id, not role: while the panel is open the page behind it is aria-hidden.
const rows = (page: Page) => page.getByTestId("routine-row");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
const strip = (page: Page) => page.getByRole("region", { name: "Waiting for you" });
const panel = (page: Page) => page.getByRole("dialog", { name: "Routine" });

async function openPanel(page: Page, name: string) {
  await row(page, name).getByRole("link", { name }).click();
  await expect(panel(page)).toBeVisible();
  await expect(page).toHaveURL(/routine=/);
  // The slide-out settles before the shot or the next click.
  await page.waitForTimeout(350);
}

test.describe("/dev/routines", () => {
  test("lists the routines in plain words, with next run, last run and its result", async ({ page }, info) => {
    await open(page);
    await expect(page.getByRole("heading", { level: 1, name: "Routines" })).toBeVisible();
    await expect(rows(page)).toHaveCount(5);

    const payments = row(page, "Brand payment emails");
    await expect(payments).toContainText("Weekdays at 08:00");
    await expect(payments).toContainText("Mon, Nov 23 08:00");
    await expect(payments).toContainText("Yesterday 08:00");
    await expect(payments).toContainText("Ok");
    await expect(payments.getByRole("switch")).toHaveAttribute("aria-checked", "true");

    await expect(row(page, "Tidy the desktop")).toContainText("Waiting for approval");
    await expect(row(page, "Tidy the desktop")).toContainText("Today 22:00");
    const tax = row(page, "Weekly tax set-aside check");
    await expect(tax).toContainText("Every Monday at 09:00");
    await expect(tax).toContainText("Paused");
    await expect(tax).toContainText("Failed");
    // Red is for money lost or overdue only: a failed run is ink.
    const failed = tax.getByText("Failed", { exact: true });
    expect(await failed.evaluate((el) => getComputedStyle(el).color)).not.toBe("rgb(179, 38, 30)");
    await expect(tax.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await expect(row(page, "Close the day")).toContainText("Skipped, the Mac was off");
    await expect(row(page, "Close the day")).toContainText("Today 18:00");

    await expect(strip(page)).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, info, "list", true);
  });

  test("New routine: the form makes a routine and it joins the list", async ({ page }, info) => {
    await open(page);
    await page.getByRole("button", { name: "New routine" }).click();
    const dialog = page.getByRole("dialog", { name: "New routine" });
    await expect(dialog).toBeVisible();
    const add = dialog.getByRole("button", { name: "Add routine" });
    await expect(add).toBeDisabled();

    await dialog.getByLabel("What should Hydra do?").fill("Every Monday and Wednesday, list my open UGC deals");
    await pickOption(dialog.getByLabel("How often"), "weekly");
    await dialog.getByRole("button", { name: "Wed" }).click();
    await expect(dialog.getByRole("button", { name: "Wed" })).toHaveAttribute("aria-pressed", "true");
    await dialog.getByLabel("Time").fill("07:30");
    await dialog.getByLabel("Gmail").check();
    await dialog.getByLabel("Spoken on the Mac").check();
    await dialog.getByRole("radio", { name: "Skip" }).click();
    await expect(add).toBeEnabled();
    await page.waitForTimeout(400);
    await shot(page, info, "new");

    await add.click();
    await expect(dialog).toBeHidden();
    await expect(rows(page)).toHaveCount(6);
    const made = row(page, "Every Monday and Wednesday, list my open");
    await expect(made).toContainText("Every Monday, Wednesday at 07:30");
    await expect(made).toContainText("Mon, Nov 23 07:30");
    await expect(made).toContainText("Not yet");
    await expect(page.getByRole("status").filter({ hasText: "Added" })).toBeVisible();
  });

  test("the switch pauses and resumes a routine", async ({ page }) => {
    await open(page);
    const payments = row(page, "Brand payment emails");
    const on = payments.getByRole("switch", { name: "Brand payment emails is on" });
    await on.click();
    await expect(on).toHaveAttribute("aria-checked", "false");
    await expect(payments).toContainText("Paused");
    await expect(payments).not.toContainText("Mon, Nov 23 08:00");
    await on.click();
    await expect(on).toHaveAttribute("aria-checked", "true");
    await expect(payments).toContainText("Mon, Nov 23 08:00");
  });

  test("the panel: runs with output and actions, Run now (mocked) and Pause", async ({ page }, info) => {
    await open(page);
    await openPanel(page, "Brand payment emails");
    const p = panel(page);
    await expect(p.getByRole("heading", { name: "Brand payment emails" })).toBeVisible();
    await expect(p).toContainText("Weekdays at 08:00");
    const runs = p.getByTestId("run");
    await expect(runs).toHaveCount(2);
    await expect(runs.first()).toContainText("Found 2 payment emails");
    await expect(runs.first().getByRole("list", { name: "Actions taken" }).getByRole("listitem")).toHaveCount(2);
    await shot(page, info, "panel");

    await p.getByRole("button", { name: "Run now" }).click();
    await expect(p.getByRole("status")).toContainText("Running within a minute.");
    await expect(runs).toHaveCount(3);
    await expect(runs.first()).toContainText("Queued");
    await page.waitForTimeout(250);
    await shot(page, info, "panel-run-now");

    await p.getByRole("button", { name: "Pause" }).click();
    await expect(p.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(p.getByRole("button", { name: "Run now" })).toBeDisabled();
    await expect(p).toContainText("Paused");
  });

  test("an action a run took can be undone", async ({ page }) => {
    await open(page);
    await openPanel(page, "Brand payment emails");
    const p = panel(page);
    await p.getByRole("button", { name: "Undo: Marked the Wordwise payment as received" }).click();
    await expect(p.getByRole("button", { name: "Undo: Marked the Wordwise payment as received" })).toHaveCount(0);
    await expect(p.getByTestId("run").first()).toContainText("Undone");
    await expect(p.getByRole("button", { name: "Undo: Marked the Brandly payment as received" })).toBeVisible();
  });

  test("Settings: the form changes the schedule", async ({ page }, info) => {
    await open(page);
    await openPanel(page, "Brand payment emails");
    const p = panel(page);
    await p.getByRole("tab", { name: "Settings" }).click();
    await expect(p.getByLabel("What should Hydra do?")).toHaveValue(/Check Gmail for brand payment emails/);
    await p.getByLabel("Time").fill("07:45");
    await shot(page, info, "panel-settings");
    await p.getByRole("button", { name: "Save changes" }).click();
    await expect(p.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await expect(p).toContainText("Weekdays at 07:45");
  });

  test("Approve runs a waiting step, Decline drops one", async ({ page }, info) => {
    await open(page);
    const approvals = strip(page).getByTestId("approval");
    await expect(approvals).toHaveCount(2);
    await expect(approvals.first()).toContainText("Quit Preview, it has unsaved changes");
    await expect(approvals.first()).toContainText("Tidy the desktop");

    await strip(page).getByRole("button", { name: /^Approve: Quit Preview/ }).click();
    await expect(approvals).toHaveCount(1);
    await expect(row(page, "Tidy the desktop")).not.toContainText("Waiting for approval");
    await expect(row(page, "Tidy the desktop")).toContainText("Ok");
    await expect(page.getByRole("status").filter({ hasText: "Approved." })).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, info, "approved", true);

    await strip(page).getByRole("button", { name: /^Decline: Send a payment reminder/ }).click();
    await expect(strip(page)).toHaveCount(0);
    await expect(row(page, "Brand follow-ups")).toContainText("Failed");
    await expect(row(page, "Brand follow-ups")).not.toContainText("Waiting for approval");
  });

  test("Delete asks first, and Keep it leaves the routine alone", async ({ page }, info) => {
    await open(page);
    await openPanel(page, "Close the day");
    const p = panel(page);
    await p.getByRole("button", { name: "Delete" }).click();
    const ask = p.getByRole("alertdialog", { name: "Delete this routine?" });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("run history");
    await expect(rows(page)).toHaveCount(5);
    await shot(page, info, "delete-asks");

    await ask.getByRole("button", { name: "Keep it" }).click();
    await expect(ask).toBeHidden();
    await expect(rows(page)).toHaveCount(5);

    await p.getByRole("button", { name: "Delete" }).click();
    await p.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(panel(page)).toBeHidden();
    await expect(page).not.toHaveURL(/routine=/);
    await expect(rows(page)).toHaveCount(4);
    await expect(row(page, "Close the day")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Deleted Close the day." })).toBeVisible();
  });

  test("?routine= opens the panel on a hard load", async ({ page }) => {
    await page.goto("/dev/routines?routine=00000000-0000-4000-8000-0000000000a4");
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole("heading", { name: "Weekly tax set-aside check" })).toBeVisible();
    await expect(panel(page).getByTestId("run").first()).toContainText("Failed");
    await expect(panel(page).getByTestId("run").first()).toContainText("bank feed was out of date");
    await expect(panel(page).getByRole("button", { name: "Run now" })).toBeDisabled();
  });

  test("the loading skeleton is shaped like the page", async ({ page }, info) => {
    await page.goto("/dev/routines/loading");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("status", { name: "Loading Routines" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Routines" })).toBeVisible();
    await page.waitForTimeout(350);
    await shot(page, info, "loading", !isPhone(info));
  });
});
