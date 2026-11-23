/* Undo on the real local database: page deletes come back through the bar, edits through /activity. SUPABASE_E2E=1 only. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

import { bootstrapOwner, emailCode, ownerEmail } from "./helpers/supabase";

const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/undo";
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `${name}-${page.viewportSize()?.width}.png`), fullPage });

const TASK = "a1d00000-0000-4000-8000-000000000001";
const ACCOUNT = "a1d00000-0000-4000-8000-000000000002";
const COFFEE = "a1d00000-0000-4000-8000-000000000003";
const DEPOSIT = "a1d00000-0000-4000-8000-000000000004";
const DEAL = "a1d00000-0000-4000-8000-000000000005";
const PAYMENT = "a1d00000-0000-4000-8000-000000000006";
const TITLE = "Undo spec task";

/**
 * SQL on the local stack's database (E2E_DB_URL, local only): seeds and reads back. These writes come from no
 * owner session and carry no actor header, so Activity does not log them.
 */
function sql(query: string): string {
  const url = process.env.E2E_DB_URL ?? "";
  if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("set E2E_DB_URL to the local stack's database");
  return execFileSync("psql", [url, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim();
}

async function one(table: string, id: string): Promise<Record<string, unknown> | null> {
  const out = sql(`select row_to_json(t) from public.${table} t where id = '${id}'`);
  return out ? (JSON.parse(out) as Record<string, unknown>) : null;
}

function seed() {
  sql(`
    delete from public.deal_payments where id = '${PAYMENT}';
    delete from public.deals where id = '${DEAL}';
    delete from public.transactions where id in ('${COFFEE}', '${DEPOSIT}');
    delete from public.accounts where id = '${ACCOUNT}';
    delete from public.planning_tasks where id = '${TASK}';
    insert into public.planning_tasks (id, title, notes, status_id, due_date, category)
      select '${TASK}', '${TITLE}', 'Keep these notes', id, '2026-11-25', 'Admin' from public.planning_statuses order by position limit 1;
    insert into public.accounts (id, kind, entity_id, name, is_manual)
      select '${ACCOUNT}', 'cash', id, 'Undo spec cash', true from public.entities where slug = 'personal';
    insert into public.transactions (id, account_id, posted_on, amount_cents, name, note, entity_id, source)
      select '${COFFEE}', '${ACCOUNT}', '2026-11-20', -1250, 'Undo spec coffee', 'oat milk', id, 'manual' from public.entities where slug = 'personal';
    insert into public.transactions (id, account_id, posted_on, amount_cents, name, entity_id, source)
      select '${DEPOSIT}', '${ACCOUNT}', '2026-11-18', 50000, 'Undo spec deposit', id, 'manual' from public.entities where slug = 'ugc';
    insert into public.deals (id, entity_id, brand_name, start_date, flat_rate_cents)
      select '${DEAL}', id, 'Undo Spec Brand', '2026-11-01', 50000 from public.entities where slug = 'ugc';
    insert into public.deal_payments (id, deal_id, transaction_id, amount_cents, paid_on) values ('${PAYMENT}', '${DEAL}', '${DEPOSIT}', 50000, '2026-11-18');
  `);
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByRole("textbox", { name: "Email" }).fill(ownerEmail());
  await page.getByRole("button", { name: "Send code" }).click();
  // The form's own send finishes first; the admin code then replaces the one it mailed.
  await expect(page.getByText("Check your email")).toBeVisible();
  await page.getByRole("textbox", { name: "Code" }).fill(await emailCode(ownerEmail()));
  await page.getByRole("button", { name: "Sign in" }).click();
  // After the code, /login either goes home or first shows the add-passkey step (only while the owner
  // has no passkey; another spec may have added one). Wait for whichever comes first, within a bound,
  // instead of looking once: the step can paint after any single check.
  const notNow = page.getByRole("button", { name: "Not now" });
  const home = page.waitForURL((u) => u.pathname === "/", { timeout: 20_000 });
  const prompt = notNow.waitFor({ state: "visible", timeout: 20_000 }).then(
    () => "prompt" as const,
    () => null,
  );
  if ((await Promise.race([home.then(() => "home" as const), prompt])) === "prompt") await notNow.click();
  await home;
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

const bar = (page: Page) => page.getByTestId("undo-bar");

/** The bar is up with its text; press Undo and wait for it to go. */
async function undoFromBar(page: Page, text: string, shotName?: string) {
  await expect(bar(page)).toContainText(`Deleted ${text}.`);
  // Let the 200 ms fade-in and the drawer close finish, so the shot shows what stays on screen.
  if (shotName) await page.waitForTimeout(600).then(() => shot(page, shotName));
  await bar(page).getByRole("button", { name: "Undo" }).click();
  await expect(bar(page)).toBeHidden();
}

async function deleteTask(page: Page) {
  await page.goto(`/planning?task=${TASK}`);
  const drawer = page.getByRole("dialog", { name: "Task" });
  await drawer.getByRole("button", { name: "Delete task" }).click();
  await drawer.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => one("planning_tasks", TASK)).toBeNull();
}

async function deleteDeal(page: Page) {
  await page.goto(`/ugc?deal=${DEAL}`);
  const drawer = page.getByRole("dialog", { name: "Deal" });
  await drawer.getByRole("button", { name: "Delete deal" }).click();
  await drawer.getByRole("group", { name: "Confirm delete deal" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => one("deals", DEAL)).toBeNull();
}

/** The same delete from the deal's "..." menu on its deal picker row: it asks, then deletes. */
async function deleteDealFromMenu(page: Page, shotName?: string) {
  await page.goto("/ugc");
  await page.getByRole("button", { name: "Deal", exact: true }).click();
  await page.getByRole("button", { name: "More for Undo Spec Brand", includeHidden: true }).click();
  const menu = page.getByRole("menu", { name: "More for Undo Spec Brand" });
  await expect(menu.getByRole("menuitem", { name: "Archive" })).toBeVisible();
  if (shotName) await page.waitForTimeout(250).then(() => shot(page, shotName));
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await expect.poll(() => one("deals", DEAL)).toBeNull();
}

async function renameTask(page: Page, title: string) {
  await page.goto(`/planning?task=${TASK}`);
  const box = page.getByRole("dialog", { name: "Task" }).getByRole("textbox", { name: "Title" });
  await box.fill(title);
  await box.press("Enter");
  await expect.poll(async () => (await one("planning_tasks", TASK))?.title).toBe(title);
}

test.describe("undo on local Supabase", () => {
  test.skip(!process.env.SUPABASE_E2E, "set SUPABASE_E2E=1 with local Supabase running");

  test("page deletes come back from the bar; edits come back from Activity, changed-since asks first", async ({ page }) => {
    // One owner and one set of rows: the desktop project only (the 390 shots resize the same page).
    test.skip(test.info().project.name !== "desktop", "desktop project only");
    test.setTimeout(240_000);
    bootstrapOwner();
    seed();
    const task0 = await one("planning_tasks", TASK);
    const coffee0 = await one("transactions", COFFEE);
    const deal0 = await one("deals", DEAL);
    const pay0 = await one("deal_payments", PAYMENT);
    await signIn(page);

    await test.step("a task: delete, Undo in the bar, back with the same id and values", async () => {
      await deleteTask(page);
      await undoFromBar(page, `task "${TITLE}"`, "bar-planning");
      expect(await one("planning_tasks", TASK)).toEqual(task0);
      await expect(page.getByText(TITLE).first()).toBeVisible();
      // At 390 too (the bar sits above the tabs and the orb).
      await page.setViewportSize({ width: 390, height: 844 });
      await deleteTask(page);
      await undoFromBar(page, `task "${TITLE}"`, "bar-planning");
      expect(await one("planning_tasks", TASK)).toEqual(task0);
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await test.step("a deal: delete, Undo, the deal and its payment are back", async () => {
      await deleteDeal(page);
      expect(await one("deal_payments", PAYMENT)).toBeNull();
      await undoFromBar(page, 'deal "Undo Spec Brand"', "bar-ugc");
      expect(await one("deals", DEAL)).toEqual(deal0);
      expect(await one("deal_payments", PAYMENT)).toEqual(pay0);
      // The page shows it again: its drawer opens with its name.
      await page.goto(`/ugc?deal=${DEAL}`);
      await expect(page.getByRole("dialog", { name: "Deal" }).getByRole("textbox", { name: "Brand name" })).toHaveValue("Undo Spec Brand");
      await page.setViewportSize({ width: 390, height: 844 });
      await deleteDeal(page);
      await undoFromBar(page, 'deal "Undo Spec Brand"', "bar-ugc");
      expect(await one("deals", DEAL)).toEqual(deal0);
      expect(await one("deal_payments", PAYMENT)).toEqual(pay0);
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await test.step('a deal from its "..." menu: delete, the bar, Undo, the deal and its payment are back', async () => {
      await deleteDealFromMenu(page, "menu-ugc");
      expect(await one("deal_payments", PAYMENT)).toBeNull();
      await undoFromBar(page, 'deal "Undo Spec Brand"', "bar-ugc-menu");
      expect(await one("deals", DEAL)).toEqual(deal0);
      expect(await one("deal_payments", PAYMENT)).toEqual(pay0);
      await page.setViewportSize({ width: 390, height: 844 });
      await deleteDealFromMenu(page, "menu-ugc");
      await undoFromBar(page, 'deal "Undo Spec Brand"', "bar-ugc-menu");
      expect(await one("deals", DEAL)).toEqual(deal0);
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await test.step("a manual transaction: delete in its drawer, Undo, back the same", async () => {
      await page.goto(`/transactions?tx=${COFFEE}`);
      const panel = page.locator(`[data-tx-panel="${COFFEE}"]`);
      await panel.getByRole("button", { name: "Delete", exact: true }).click();
      await panel.getByRole("group", { name: "Confirm" }).getByRole("button", { name: "Delete" }).click();
      await expect.poll(() => one("transactions", COFFEE)).toBeNull();
      await undoFromBar(page, '"Undo spec coffee"', "bar-transactions");
      expect(await one("transactions", COFFEE)).toEqual(coffee0);
      await expect(page.getByText("Undo spec coffee").first()).toBeVisible();
    });

    await test.step("an edit: undone from the Activity page", async () => {
      await renameTask(page, "Undo spec edit one");
      await page.goto("/activity");
      const entry = page.getByTestId("activity-row").filter({ hasText: 'Changed task "Undo spec edit one"' }).first();
      await entry.getByRole("button", { name: /^Undo:/ }).click();
      await expect(entry.getByText("Undone")).toBeVisible();
      expect((await one("planning_tasks", TASK))?.title).toBe(TITLE);
      await expect(page.getByTestId("activity-row").first()).toContainText('Reverted task "Undo spec task"');
    });

    await test.step("changed since: Undo shows what changed, Undo anyway reverts", async () => {
      await renameTask(page, "Undo spec edit two");
      await renameTask(page, "Undo spec edit three");
      await page.goto("/activity");
      const entry = page.getByTestId("activity-row").filter({ hasText: 'Changed task "Undo spec edit two"' }).first();
      await entry.getByRole("button", { name: /^Undo:/ }).click();
      await expect(entry).toContainText("Changed since");
      await expect(entry).toContainText("Title changed since");
      expect((await one("planning_tasks", TASK))?.title).toBe("Undo spec edit three");
      await shot(page, "activity-changed-since");
      await entry.getByRole("button", { name: "Undo anyway" }).click();
      await expect(entry.getByText("Undone")).toBeVisible();
      expect((await one("planning_tasks", TASK))?.title).toBe(TITLE);
      await shot(page, "activity-real");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await expect(page.getByTestId("activity-row").first()).toBeVisible();
      // The page fades in after a reload: capture it once the enter motion has finished.
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
      await shot(page, "activity-real");
      await page.setViewportSize({ width: 1440, height: 900 });
    });
  });
});
