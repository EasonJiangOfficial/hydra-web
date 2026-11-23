import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

import { pickOption } from "./helpers/controls";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/label-colors";
const isPhone = (info: TestInfo) => info.project.name === "phone";
const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({ path: path.join(SHOTS, `${name}-${isPhone(info) ? 390 : 1440}.png`) });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FILM = id(100); // Not started, Priority High, due Nov 22
const TEAL = "#4b8a8c";
const BLUE = "#4f7cb8";
const PURPLE = "#8466ae";

test.describe("label colors", () => {
  test("a status and a tag color show on the board, a card, the table and the calendar", async ({ page }, info) => {
    await page.goto("/dev/planning-page");
    await expect(page.getByText("1 of 3 tasks")).toBeVisible();

    // Status: the column's dot opens the picker; arrows and Enter pick.
    const notStarted = page.getByRole("region", { name: "Not started column" });
    // The seeded gray is a palette swatch: named, not a raw hex.
    const trigger = notStarted.getByRole("button", { name: "Color for Not started: Mist" });
    const box = (await trigger.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
    await trigger.click();
    await expect(page.getByRole("radio", { name: "Mist" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radiogroup", { name: "Color for Not started" })).toBeVisible();
    await page.getByRole("radio", { name: "Teal" }).hover();
    await shot(page, info, "picker-open");
    await page.getByRole("radio", { name: "Teal" }).click();
    await expect(notStarted.getByRole("button", { name: "Color for Not started: Teal" })).toBeVisible();

    // Tag: the task drawer's option list has a picker per option.
    await page.locator(`[data-task-id="${FILM}"]`).getByRole("button", { name: /^Open / }).click();
    const drawer = page.locator(`[data-task-panel="${FILM}"]`);
    await drawer.getByRole("button", { name: /^Color for High/ }).click();
    await page.getByRole("textbox", { name: "Custom color" }).fill(BLUE);
    await page.keyboard.press("Enter");
    await expect(drawer.getByRole("button", { name: "Color for High: Blue" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Color for Not started: Teal" })).toBeVisible();
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
    // Priority fills its row like Status does (it was a narrow box).
    const status = (await drawer.getByRole("combobox", { name: "Status" }).boundingBox())!;
    const prio = (await drawer.getByRole("combobox", { name: /^Priority of / }).boundingBox())!;
    expect(prio.width).toBeGreaterThan(status.width - 30);
    expect(prio.x + prio.width).toBeCloseTo(status.x + status.width, -1);
    await shot(page, info, "task-drawer");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    // Board and card.
    const card = page.locator(`[data-task-id="${FILM}"]`);
    await expect(card.locator(`[data-slot="color-pill"][data-color="${BLUE}"]`)).toHaveText("High");
    await notStarted.scrollIntoViewIfNeeded();
    await shot(page, info, "board");

    // Table: the status cell's dot.
    await page.getByRole("radio", { name: "Table" }).click();
    const row = page.getByTestId("table").locator(`tr[data-task-id="${FILM}"]`);
    await expect(row.locator(`[data-color-dot="${TEAL}"]`)).toBeAttached();
    await shot(page, info, "table");

    // Calendar: the task chip's leading dot (desktop), the day's dot (phone).
    await page.getByRole("radio", { name: "Calendar" }).click();
    const cell = page.getByTestId("cal-day-2026-11-22");
    if (isPhone(info)) {
      await expect(cell.locator(`[style*="75, 138, 140"]`).first()).toBeAttached();
      // An In-progress task (ink) and an event (ink) still differ: the event is a square.
      const dots = await page.locator('[data-testid^="cal-day-"] .sm\\:hidden > span').evaluateAll((els) =>
        els.map((e) => ({ bg: getComputedStyle(e).backgroundColor, r: parseFloat(getComputedStyle(e).borderTopLeftRadius) })),
      );
      const ink = dots.filter((d) => d.bg === "rgb(29, 29, 31)");
      expect(ink.some((d) => d.r <= 1)).toBe(true);
      expect(ink.some((d) => d.r > 1)).toBe(true);
    } else await expect(cell.locator(`[data-item-key="task:${FILM}"] [data-color-dot="${TEAL}"]`)).toBeVisible();
    await shot(page, info, "calendar");

    // Goal drawer: a linked task's status pill carries its dot.
    await page.getByRole("radio", { name: "Board" }).click();
    await page.locator("[data-goal-id]").filter({ hasText: "1 of 3 tasks" }).first().click();
    const linked = page.getByRole("region", { name: "Linked tasks" }).or(page.locator('section[aria-label="Linked tasks"]'));
    await expect(linked.locator(`[data-slot="pill"] [data-color-dot="${TEAL}"]`).first()).toBeAttached();
    await shot(page, info, "goal-drawer");
  });

  test("a Planning category color shows on its board column, card pills, the table and the filter", async ({ page }, info) => {
    await page.goto("/dev/planning-page");
    await expect(page.getByText("1 of 3 tasks")).toBeVisible();
    await pickOption(page.getByLabel("Group by"), { label: "Group: Category" });
    const board = page.getByTestId("board");

    // A category starts with no color: the header's picker shows an empty ring, the pill is plain.
    const colorColumn = async (category: string, swatch: string) => {
      const column = board.getByRole("region", { name: `${category} column` });
      await column.scrollIntoViewIfNeeded();
      await column.getByRole("button", { name: `Color for ${category}: None` }).click();
      await page.getByRole("radio", { name: swatch }).click();
      await expect(column.getByRole("button", { name: `Color for ${category}: ${swatch}` })).toBeVisible();
      await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
      return column;
    };
    const card = page.locator(`[data-task-id="${FILM}"]`);
    await expect(card.locator('[data-slot="pill"]', { hasText: "UGC" })).toBeVisible();
    await colorColumn("UGC", "Blue");
    await expect(card.locator(`[data-slot="color-pill"][data-color="${BLUE}"]`)).toHaveText("UGC");
    await colorColumn("Taxes", "Amber");
    await colorColumn("Hydra", "Teal");
    await colorColumn("Money", "Green");
    // Every Taxes card's pill is tinted, in every column.
    await expect(board.locator('[data-slot="color-pill"][data-color="#c29a2e"]', { hasText: "Taxes" })).toHaveCount(3);
    // Phone shows one column: the Taxes one (three tinted pills); desktop shows the board from the left.
    if (isPhone(info)) await board.getByRole("region", { name: "Taxes column" }).evaluate((c) => c.scrollIntoView({ block: "start", inline: "start" }));
    else await board.evaluate((b) => b.scrollTo({ left: 0 }));
    await page.waitForTimeout(400);
    await shot(page, info, "board-by-category");

    // None clears it: the pill goes back to plain text.
    const hydra = board.getByRole("region", { name: "Hydra column" });
    await hydra.scrollIntoViewIfNeeded();
    await hydra.getByRole("button", { name: "Color for Hydra: Teal" }).click();
    await page.getByRole("button", { name: "None", exact: true }).click();
    await expect(hydra.getByRole("button", { name: "Color for Hydra: None" })).toBeVisible();
    await expect(hydra.locator('[data-slot="pill"]', { hasText: "Hydra" })).toBeVisible();

    // The color follows the category everywhere: the table's category cell and the filter.
    await page.getByRole("radio", { name: "Table" }).click();
    await expect(page.getByTestId("table").getByLabel("Category of Film 6 Wordwise videos")).toHaveAttribute("data-color", BLUE);
    // Each option in the filter's list shows its category's color dot.
    const filter = page.getByRole("combobox", { name: "Category filter" });
    await filter.click();
    const list = page.getByRole("listbox", { name: "Category filter" });
    await expect(list.getByRole("option", { name: "UGC" }).locator(`[data-color-dot="${BLUE}"]`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await pickOption(filter, "UGC");
    await expect(filter).toHaveAttribute("data-color", BLUE);
    // The select fades to the tint (transition-colors), and the view switch slides: let both settle.
    await expect(filter).toHaveCSS("background-color", "rgb(230, 237, 245)");
    await page.waitForTimeout(400);
    await shot(page, info, "table-by-category");
  });

  test("a category color shows on its transaction rows", async ({ page }, info) => {
    await page.goto("/dev/transactions");
    const table = page.getByTestId("tx-table");
    await expect(table).toHaveAttribute("aria-busy", "false");
    const first = table.locator("[data-tx-id]").first();
    await first.getByRole("button", { name: /^Open / }).click();
    const panel = page.locator("[data-tx-panel]");
    await expect(panel).toBeVisible();
    const picker = panel.getByRole("button", { name: /^Color for / });
    const name = ((await picker.getAttribute("aria-label")) ?? "").replace(/^Color for (.*): .*$/, "$1");
    // The picker sits under the category select, so the select keeps the row's full width.
    const select = (await panel.getByRole("combobox", { name: "Category" }).boundingBox())!;
    const pick = (await picker.boundingBox())!;
    expect(pick.y).toBeGreaterThanOrEqual(select.y + select.height - 1);
    await picker.click();
    await page.getByRole("radio", { name: "Purple" }).click();
    await expect(panel.getByRole("button", { name: `Color for ${name}: Purple` })).toBeVisible();
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
    await shot(page, info, "tx-panel");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(first.locator(`[data-color-dot="${PURPLE}"]`)).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, info, "tx-rows");
  });

  test("a category color shows on the Reports donut, its row and its trend bars", async ({ page }, info) => {
    await page.goto("/dev/reports?tab=spending");
    await expect(page.getByTestId("strip")).toContainText("$6,480", { timeout: 15_000 });
    await page.getByRole("button", { name: "Open Housing" }).click();
    await page.getByRole("button", { name: /^Color for Housing/ }).click();
    await page.getByRole("radio", { name: "Blue" }).click();
    await expect(page.getByRole("button", { name: "Color for Housing: Blue" })).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator(`[data-testid="category-panel"] .recharts-bar-rectangle path[fill="${BLUE}"]`).first()).toBeAttached();
    await shot(page, info, "reports-panel");
    await page.keyboard.press("Escape");
    await expect(page.locator(`.recharts-pie-sector path[fill="${BLUE}"]`)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Open Housing" }).locator(`span[style*="79, 124, 184"]`)).toBeAttached();
    await page.waitForTimeout(900);
    await shot(page, info, "reports-chart");
  });

  test("a category color shows on the Dashboard Recent card", async ({ page }, info) => {
    await page.goto("/dev/dashboard");
    const recent = page.getByRole("link", { name: /Adobe Creative Cloud/ });
    await expect(recent.locator(`[data-color-dot="${BLUE}"]`)).toBeVisible();
    await shot(page, info, "dashboard-recent");
  });
});
