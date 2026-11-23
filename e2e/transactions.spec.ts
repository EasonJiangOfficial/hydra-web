import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { pickOption } from "./helpers/controls";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/transactions";

const isPhone = (info: TestInfo) => info.project.name === "phone";
const width = (info: TestInfo) => (isPhone(info) ? 390 : 1440);
/** Waits out the 200 ms fades first, so the picture shows the settled state. */
const shot = async (page: Page, info: TestInfo, name: string) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `transactions-${name}-${width(info)}.png`) });
};

/** Opens the fixture and waits until the first rows are in. */
async function open(page: Page) {
  await page.goto("/dev/transactions");
  await settled(page);
  await expect(firstRow(page)).toBeVisible();
}

/** Opens the Rules tab straight from the URL. */
async function openRules(page: Page) {
  await page.goto("/dev/transactions?tab=rules");
  await expect(page.getByTestId("rules-list").locator("li").first()).toBeVisible();
}

const table = (page: Page) => page.getByTestId("tx-table");

/** The table shows the view for `filters` (a pattern on its data-filters) and has finished loading it. */
async function settled(page: Page, filters?: RegExp) {
  if (filters) await expect(table(page)).toHaveAttribute("data-filters", filters);
  await expect(table(page)).toHaveAttribute("aria-busy", "false");
}
/** Scoped to the table: the agent card in the sidebar has its own "Open the thread" button. */
const firstRow = (page: Page) => table(page).getByRole("button", { name: /^Open / }).first();

/** The phone keeps the filters behind a button. */
async function showFilters(page: Page, info: TestInfo) {
  if (isPhone(info)) await page.getByRole("button", { name: "Filters" }).click();
}

/** Opens the panel for the first row. */
async function openPanel(page: Page) {
  await firstRow(page).click();
  await expect(page).toHaveURL(/[?&]tx=/);
  await expect(page.locator("[data-tx-panel]")).toBeVisible();
}

test.describe("/dev/transactions", () => {
  test("a scope slug with no business shows no rows, as Reports does, not every row", async ({ page }) => {
    await page.goto("/dev/transactions?scope=no-such-business");
    await settled(page, /00000000-0000-0000-0000-000000000000/);
    await expect(table(page)).toHaveAttribute("aria-rowcount", "1"); // the header row alone
    await expect(page.locator("[data-tx-id]")).toHaveCount(0);
  });

  test("scrolls thousands of rows with only a window of them in the page", async ({ page }, info) => {
    await open(page);
    const grid = table(page);
    expect(Number(await grid.getAttribute("aria-rowcount"))).toBeGreaterThan(3000);
    const drawn = () => page.locator("[data-tx-id]").count();
    expect(await drawn()).toBeLessThan(60);
    // Scroll to the far end: pages load as it nears, the page never holds more than a window.
    let last = 0;
    for (let i = 0; i < 40; i++) {
      await grid.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.waitForTimeout(60);
      const now = await grid.evaluate((el) => el.scrollHeight);
      if (now === last && i > 3) break;
      last = now;
    }
    expect(await drawn()).toBeLessThan(60);
    const rowcount = Number(await grid.getAttribute("aria-rowcount"));
    await expect(page.locator(`[data-tx-id][aria-rowindex="${rowcount}"]`)).toBeVisible();
    await grid.evaluate((el) => el.scrollTo(0, 0));
    await page.waitForTimeout(250);
    await shot(page, info, "table");
  });

  test("filters by search and by category", async ({ page }, info) => {
    await open(page);
    await showFilters(page, info);
    await page.getByLabel("Search transactions").fill("adobe");
    await expect(page).toHaveURL(/q=adobe/);
    await settled(page, /adobe/);
    await expect(page.locator("[data-tx-id]").first()).toContainText("Adobe");
    const names = await page.locator("[data-tx-id] button[aria-label^='Open ']").allTextContents();
    expect(names.length).toBeGreaterThan(3);
    expect(names.every((n) => /adobe/i.test(n))).toBe(true);

    await page.getByLabel("Search transactions").fill("");
    await expect(page).not.toHaveURL(/q=/);
    await pickOption(page.getByLabel("Category", { exact: true }), { label: "Rideshare and transit" });
    await expect(page).toHaveURL(/category=/);
    await settled(page, /categoryIds/);
    await expect(page.locator("[data-tx-id]").first()).toBeVisible();
    if (!isPhone(info)) {
      const cats = await page.locator("[data-tx-id] [role=cell]:nth-child(4)").allTextContents();
      expect(cats.length).toBeGreaterThan(3);
      expect(cats.every((c) => c.includes("Rideshare and transit"))).toBe(true);
    }
    await shot(page, info, "filtered");

    await pickOption(page.getByLabel("Category", { exact: true }), { label: "All categories" });
    await pickOption(page.getByLabel("Account", { exact: true }), { label: "Visa 9034" });
    await expect(page).toHaveURL(/account=/);
    await page.getByLabel("From date").fill("2026-11-01");
    await page.getByLabel("From date").press("Enter"); // typed text commits on Enter or blur
    await expect(page).toHaveURL(/from=2026-11-01/);
    await settled(page, /2026-11-01/);
    const rows = await page.locator("[data-tx-id]").count();
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(120);
  });

  test("the category pill shows which rule set it", async ({ page }, info) => {
    test.skip(isPhone(info), "hover cards open on long-press on the phone");
    await open(page);
    await page.getByLabel("Search transactions").fill("netflix");
    await settled(page, /netflix/);
    const pill = page.locator("[data-tx-id]").first().locator("[data-slot=pill]");
    await expect(pill).toHaveText("Subscriptions");
    await pill.hover();
    await expect(page.getByText(/Set by a rule/).filter({ visible: true })).toBeVisible();
    await expect(page.getByText(/Name contains any of/).filter({ visible: true })).toBeVisible();
    await shot(page, info, "hover");
  });

  test("the panel autosaves a note, a rename and hide", async ({ page }, info) => {
    await open(page);
    await page.getByLabel("Search transactions").fill("starbucks");
    await settled(page, /starbucks/);
    await openPanel(page);
    const panel = page.locator("[data-tx-panel]");

    await panel.getByLabel("Note").fill("Shoot day coffee");
    await expect(panel.locator("[data-save-state=saved]")).toBeVisible();

    const name = panel.getByLabel("Name");
    await name.fill("Morning coffee");
    await name.blur();
    await expect(panel.locator("[data-save-state=saved]")).toBeVisible();
    await shot(page, info, "panel");

    await page.keyboard.press("Escape");
    await expect(page.locator("[data-tx-panel]")).toHaveCount(0);
    await expect(page.locator("[data-tx-id]").first()).toContainText("Morning coffee");

    // Reopen: the note is kept.
    await openPanel(page);
    await expect(page.locator("[data-tx-panel]").getByLabel("Note")).toHaveValue("Shoot day coffee");

    // Hide it from reports: it leaves the list.
    await page.locator("[data-tx-panel]").getByRole("switch", { name: "Hide from reports" }).check({ force: true });
    await expect(page.locator("[data-tx-panel]").locator("[data-save-state=saved]")).toBeVisible();
  });

  test("Needs review suggests a transfer between two cash accounts; Not a transfer and Mark as transfer settle it", async ({ page }, info) => {
    await page.goto("/dev/transactions?view=review");
    await settled(page, /"review":true/);
    const strip = page.getByTestId("transfer-suggestions");
    const item = strip.getByTestId("transfer-suggestion").filter({ hasText: "Transfer to Business Checking" });
    await expect(item).toBeVisible();
    await expect(item).toContainText("Transfer from Everyday Checking");
    await expect(item).toContainText("$500.00");
    await expect(strip.locator("p")).toHaveCount(0); // no sentence on the page; the info dot explains
    await shot(page, info, "possible-transfer");
    await item.getByRole("button", { name: "Not a transfer" }).click();
    await expect(item).toHaveCount(0);

    await page.reload(); // the fixture starts over: the suggestion is back
    await settled(page, /"review":true/);
    const before = await page.getByRole("radio", { name: /Needs review/ }).innerText();
    const again = page.getByTestId("transfer-suggestion").filter({ hasText: "Transfer to Business Checking" });
    await again.getByRole("button", { name: "Mark as transfer" }).click();
    await expect(again).toHaveCount(0);
    const count = Number(before.match(/(\d+)$/)![1]);
    await expect(page.getByRole("radio", { name: new RegExp(`Needs review ${count - 2}$`) })).toBeVisible();
  });

  test("a hand-picked category offers a rule, and the editor previews it", async ({ page }, info) => {
    await open(page);
    await page.getByRole("radio", { name: /Needs review/ }).click();
    await expect(page).toHaveURL(/view=review/);
    await settled(page, /"review":true/);
    const before = await page.getByRole("radio", { name: /Needs review/ }).innerText();
    const count = Number(before.match(/\d+/)![0]);
    expect(count).toBeGreaterThan(20);
    await shot(page, info, "review");

    const name = (await firstRow(page).innerText()).replace(/Pending/, "").trim();
    // The first real category of the row's business.
    if (isPhone(info)) {
      await openPanel(page);
      await pickOption(page.locator("[data-tx-panel]").getByLabel("Category"), { index: 1 });
      await page.keyboard.press("Escape");
    } else {
      await pickOption(page.locator("[data-tx-id]").first().getByRole("combobox"), { index: 1 });
    }
    const offer = page.getByTestId("rule-offer");
    await expect(offer).toBeVisible();
    await expect(offer).toContainText(`“${name}”`);
    await expect(page.getByRole("radio", { name: new RegExp(`Needs review ${count - 1}$`) })).toBeVisible();
    await shot(page, info, "offer");

    await offer.getByRole("button", { name: "Make rule" }).click();
    const dialog = page.getByRole("dialog", { name: "New rule" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("preview-summary")).toContainText(/\d+ of \d+ recent rows match/);
    await shot(page, info, "rule-editor");
    await dialog.getByRole("button", { name: "Save rule" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("notice")).toContainText("Rule saved");

    await page.getByRole("tab", { name: "Rules" }).click();
    await expect(page.getByTestId("rules-list").locator("li")).toHaveCount(9);
  });

  test("the rule editor previews live as the rule changes", async ({ page }, info) => {
    await openRules(page);
    await page.getByRole("button", { name: "New rule" }).click();
    const dialog = page.getByRole("dialog", { name: "New rule" });
    await expect(dialog.getByRole("button", { name: "Save rule" })).toBeDisabled();

    const summary = dialog.getByTestId("preview-summary");
    await pickOption(dialog.getByLabel("Condition 1 operator"), { label: "contains" });
    await dialog.getByLabel("Condition 1 value").fill("uber");
    await dialog.getByRole("button", { name: "Add action" }).click();
    await pickOption(dialog.getByLabel("Action 1 category"), { label: "Rideshare and transit" });
    await expect(summary).toContainText(/\d+ of \d+ recent rows match/);
    const wide = Number((await summary.innerText()).match(/^(\d+)/)![1]);
    expect(wide).toBeGreaterThan(0);

    await dialog.getByLabel("Condition 1 value").fill("uber trip that never happened");
    await expect(summary).toContainText(/^0 of/);
    await dialog.getByLabel("Condition 1 value").fill("uber");
    await expect(summary).toContainText(new RegExp(`^${wide} of`));
    // Rows already set by that rule would not change; the preview says what would.
    await expect(dialog.locator("[data-preview-row]").first()).toBeVisible();
    await shot(page, info, "rule-preview");

    // A bad pattern says so and blocks saving.
    await pickOption(dialog.getByLabel("Condition 1 operator"), { label: "matches pattern" });
    await dialog.getByLabel("Condition 1 value").fill("(");
    await expect(dialog.getByText("That pattern is not valid").first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save rule" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("drag reorders the rules and saves the new order", async ({ page }, info) => {
    await openRules(page);
    const list = page.getByTestId("rules-list");
    const order = async () => (await list.locator("li").evaluateAll((els) => els.map((e) => e.getAttribute("data-rule-id")))) as string[];
    await expect(list.locator("li")).toHaveCount(8);
    const before = await order();
    await shot(page, info, "rules");

    const handle = list.locator("li").first().getByRole("button", { name: /^Reorder rule 1/ });
    await handle.scrollIntoViewIfNeeded();
    const from = (await handle.boundingBox())!;
    const target = (await list.locator("li").nth(2).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 2, from.y + 10, { steps: 4 });
    await page.mouse.move(from.x + from.width / 2, target.y + target.height * 0.5, { steps: 14 });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await page.mouse.up();

    await expect.poll(order).toEqual([before[1], before[2], before[0], ...before.slice(3)]);

    // The keyboard does it too: space lifts, an arrow moves, space drops.
    const second = list.locator(`li[data-rule-id="${before[1]}"]`).getByRole("button", { name: /^Reorder rule/ });
    await second.focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(150);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
    await page.keyboard.press("Space");
    await expect.poll(order).toEqual([before[2], before[1], before[0], ...before.slice(3)]);
  });

  test("bulk delete of rules asks first", async ({ page }, info) => {
    await openRules(page);
    const list = page.getByTestId("rules-list");
    await list.getByLabel("Select rule 1", { exact: true }).check();
    await list.getByLabel("Select rule 2", { exact: true }).check();
    await page.getByRole("button", { name: "Delete 2" }).click();
    await expect(page.getByText(/Delete 2 rules\?/)).toBeVisible();
    await shot(page, info, "bulk-confirm");
    await page.getByRole("group", { name: "Confirm" }).getByRole("button", { name: "Keep" }).click();
    await expect(list.locator("li")).toHaveCount(8);

    await page.getByRole("button", { name: "Delete 2" }).click();
    await page.getByRole("group", { name: "Confirm" }).getByRole("button", { name: "Delete" }).click();
    await expect(list.locator("li")).toHaveCount(6);
    await expect(page.getByTestId("notice")).toContainText("2 rules deleted");
  });

  test("bulk edit asks first when it touches more than 10 rows", async ({ page }, info) => {
    test.skip(isPhone(info), "the select-all box is a desktop control");
    await open(page);
    await page.getByRole("radio", { name: /Needs review/ }).click();
    await settled(page, /"review":true/);
    await page.getByLabel("Select all loaded transactions").check();
    const bar = page.getByRole("region", { name: "Bulk edit" });
    await expect(bar).toContainText("200 selected");
    await pickOption(bar.getByLabel("Set category for selected"), { label: "Dining out" });
    await expect(bar.getByText(/Set category Dining out on 200 rows\?/)).toBeVisible();
    await shot(page, info, "bulk");
    await bar.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByTestId("notice")).toContainText("Changed 200 rows");
  });

  test("a deposit links to a deal through the Hydra list, not the OS menu", async ({ page }, info) => {
    await open(page);
    await page.getByLabel("Search transactions").fill("wordwise payment");
    await settled(page, /wordwise payment/);
    await openPanel(page);
    const panel = page.locator("[data-tx-panel]");
    const deal = panel.getByLabel("UGC deal");
    await expect(deal).toHaveAttribute("role", "combobox");
    await expect(deal).toHaveText("Link to a deal");
    await expect(panel.locator("select")).toHaveCount(0);
    await deal.click();
    await expect(page.getByRole("listbox").last()).toBeVisible();
    await shot(page, info, "deal-link-open");
    await page.getByRole("listbox").last().getByRole("option", { name: "Wordwise", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Unlink" })).toBeVisible();
    await expect(panel.getByText("Wordwise", { exact: true })).toBeVisible();
  });
});
