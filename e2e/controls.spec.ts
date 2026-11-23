import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/controls";

const isPhone = (info: TestInfo) => /phone|iphone/i.test(info.project.name);
const width = (info: TestInfo) => (isPhone(info) ? 390 : 1440);
const shot = async (page: Page, info: TestInfo, name: string) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, `controls-${name}-${info.project.name}-${width(info)}.png`) });
};
/** Tap on phones (touch), click on desktop (mouse). */
const press = (info: TestInfo, l: Locator) => (isPhone(info) ? l.tap() : l.click());

const values = (page: Page) => page.getByTestId("values");
/** A time from the open TimePicker: one row on desktop; the hour, then the minute, in the phone sheet. */
async function pickTime(page: Page, info: TestInfo, label: string) {
  const [, h, m, ap] = /^(\d+):(\d+) (AM|PM)$/.exec(label)!;
  if (!isPhone(info)) return press(info, page.getByRole("option", { name: label, exact: true }));
  await press(info, page.getByRole("option", { name: `${h} ${ap}`, exact: true }));
  await press(info, page.getByRole("option", { name: `:${m}`, exact: true }));
}
const surface = (page: Page) => page.locator('[data-slot="picker-popover"], [data-slot="picker-sheet"]');

async function open(page: Page) {
  await page.goto("/dev/controls");
  await expect(page.getByRole("heading", { name: "Controls" })).toBeVisible();
  await page.waitForTimeout(300);
}

test.describe("/dev/controls", () => {
  test("Select: mouse or touch picks; the chosen row has a check; the sheet opens on phones", async ({ page }, info) => {
    await open(page);
    const field = page.getByRole("combobox", { name: "Account type" });
    await press(info, field);
    await expect(surface(page)).toBeVisible();
    await expect(page.locator(isPhone(info) ? '[data-slot="picker-sheet"]' : '[data-slot="picker-popover"]')).toBeVisible();
    await expect(page.getByRole("option", { name: "Checking" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("option", { name: "Cash" })).toHaveAttribute("aria-disabled", "true");
    await shot(page, info, "select-open");
    if (isPhone(info)) {
      const box = await page.getByRole("option", { name: "Savings" }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await press(info, page.getByRole("option", { name: "Savings" }));
    await expect(surface(page)).toBeHidden();
    await expect(field).toHaveText("Savings");
    await expect(values(page)).toContainText('"kind":"savings"');
  });

  test("Select: keyboard (arrows skip disabled, Home, End, type-ahead, Escape, Enter) and focus returns", async ({ page }) => {
    await open(page);
    const field = page.getByRole("combobox", { name: "Account type" });
    await field.focus();
    await page.keyboard.press("ArrowDown");
    const list = page.getByRole("listbox");
    await expect(list).toBeFocused();
    await page.keyboard.press("End"); // Cash is disabled: End lands on Credit card
    await expect(list).toHaveAttribute("aria-activedescendant", (await page.getByRole("option", { name: "Credit card" }).getAttribute("id"))!);
    await page.keyboard.press("Home");
    await page.keyboard.press("s");
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(field).toBeFocused();
    await expect(values(page)).toContainText('"kind":"checking"');
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(field).toBeFocused();
    await expect(values(page)).toContainText('"kind":"savings"');
  });

  test("Select: a long list is searchable; multiple stays open", async ({ page }, info) => {
    await open(page);
    await press(info, page.getByRole("combobox", { name: "Category" }));
    const search = page.getByRole("searchbox", { name: "Search" });
    await expect(search).toBeFocused();
    await search.pressSequentially("ride");
    await expect(page.getByRole("option")).toHaveCount(1);
    await shot(page, info, "select-search");
    await page.keyboard.press("Enter");
    await expect(values(page)).toContainText('"cat":"Rideshare and transit"');

    await press(info, page.getByRole("combobox", { name: "Many" }));
    await press(info, page.getByRole("option", { name: "Bank fees" }));
    await expect(page.getByRole("listbox")).toBeVisible();
    await shot(page, info, "select-multiple");
    await page.keyboard.press("Escape");
    await expect(values(page)).toContainText('"many":["Software","Bank fees"]');
  });

  test("DatePicker: calendar by mouse or touch, month and year jump, Today and Clear", async ({ page }, info) => {
    await open(page);
    const field = page.getByRole("combobox", { name: "Due" });
    await expect(field).toHaveValue("Nov 21, 2026");
    await press(info, field);
    const grid = page.getByRole("grid", { name: "November 2026" });
    await expect(grid).toBeVisible();
    await expect(grid.getByRole("button", { name: "Nov 21, 2026" })).toHaveClass(/bg-ink/);
    await shot(page, info, "date-open");
    await press(info, page.getByRole("button", { name: "Next month" }));
    await press(info, page.getByRole("button", { name: "Dec 24, 2026" }));
    await expect(field).toHaveValue("Dec 24, 2026");
    await expect(values(page)).toContainText('"day":"2026-12-24"');

    await press(info, field);
    await press(info, page.getByRole("button", { name: "Choose month and year" }));
    await expect(page.getByRole("group", { name: "Months of 2026" })).toBeVisible();
    await shot(page, info, "date-months");
    await press(info, page.getByRole("button", { name: "Next year" }));
    await press(info, page.getByRole("button", { name: "Mar", exact: true }));
    await expect(page.getByRole("grid", { name: "March 2027" })).toBeVisible();
    await press(info, page.getByRole("button", { name: "Mar 8, 2027" }));
    await expect(values(page)).toContainText('"day":"2027-03-08"');

    await press(info, field);
    await press(info, page.getByRole("button", { name: "Clear" }));
    await expect(field).toHaveValue("");
    await press(info, field);
    await press(info, page.getByRole("button", { name: "Today", exact: true }));
    await expect(values(page)).toContainText(/"day":"2026-11-2\d"/);
  });

  test("DatePicker: keyboard and typing", async ({ page }, info) => {
    test.skip(isPhone(info), "phones use the sheet; typing is a keyboard thing");
    await open(page);
    const field = page.getByRole("combobox", { name: "Due" });
    await field.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("button", { name: /^Nov 21, 2026/ })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("PageDown");
    await expect(page.getByRole("button", { name: "Dec 29, 2026" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(field).toBeFocused();
    await expect(values(page)).toContainText('"day":"2026-12-29"');
    await field.fill("jan 5 2027");
    await field.press("Enter");
    await expect(field).toHaveValue("Jan 5, 2027");
    await expect(values(page)).toContainText('"day":"2027-01-05"');
    await field.fill("11/02/2026");
    await field.press("Tab");
    await expect(values(page)).toContainText('"day":"2026-11-02"');
  });

  test("DateRange: the end calendar shows the range and refuses days before the start", async ({ page }, info) => {
    await open(page);
    await press(info, page.getByRole("combobox", { name: "To" }));
    const grid = page.getByRole("grid", { name: "November 2026" });
    await expect(grid.getByRole("button", { name: "Nov 3, 2026" })).toHaveClass(/border-ink/);
    await expect(grid.getByRole("button", { name: "Nov 2, 2026" })).toHaveAttribute("aria-disabled", "true");
    await shot(page, info, "date-range");
    await grid.getByRole("button", { name: "Nov 2, 2026" }).dispatchEvent("click"); // off: nothing happens
    await expect(values(page)).toContainText('"to":"2026-11-18"');
    await press(info, grid.getByRole("button", { name: "Nov 27, 2026" }));
    await expect(values(page)).toContainText('"to":"2026-11-27"');
  });

  test("TimePicker and DateTimePicker", async ({ page }, info) => {
    await open(page);
    const time = page.getByRole("combobox", { name: "Time", exact: true });
    await expect(time).toHaveValue("9:30 AM");
    await press(info, time);
    if (isPhone(info)) {
      await expect(page.getByRole("option", { name: "9 AM", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("option", { name: ":30", exact: true })).toHaveAttribute("aria-selected", "true");
    } else await expect(page.getByRole("option", { name: "9:30 AM" })).toHaveAttribute("aria-selected", "true");
    await shot(page, info, "time-open");
    await pickTime(page, info, "10:15 AM");
    await expect(values(page)).toContainText('"time":"10:15"');
    if (!isPhone(info)) {
      await time.fill("7:45pm");
      await time.press("Enter");
      await expect(values(page)).toContainText('"time":"19:45"');
      await time.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(values(page)).toContainText('"time":"19:50"');
    }
    const alertTime = page.getByRole("combobox", { name: "Alert time" });
    await expect(page.getByRole("combobox", { name: "Alert", exact: true })).toHaveValue("Nov 22, 2026");
    await expect(alertTime).toHaveValue("6:45 PM");
    await press(info, alertTime);
    await shot(page, info, "datetime-open");
    await pickTime(page, info, "8:00 PM");
    await expect(values(page)).toContainText('"alert":"2026-11-22T20:00"');
  });

  test("Checkbox: click, label, keyboard, indeterminate", async ({ page }, info) => {
    await open(page);
    const hide = page.getByRole("checkbox", { name: "Hide done" });
    await expect(hide).toHaveAttribute("aria-checked", "true");
    await press(info, page.getByText("Hide done", { exact: true }));
    await expect(hide).toHaveAttribute("aria-checked", "false");
    await hide.focus();
    await page.keyboard.press("Space");
    await expect(hide).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("checkbox", { name: /Select all/ })).toHaveAttribute("aria-checked", "mixed");
    await page.getByRole("region", { name: "Checkbox" }).scrollIntoViewIfNeeded();
    await hide.focus();
    await page.getByRole("region", { name: "Checkbox" }).screenshot({ path: path.join(SHOTS, `controls-checkbox-${info.project.name}-${width(info)}.png`) });
  });

  test("a form posts every control's value", async ({ page }, info) => {
    await open(page);
    const form = page.getByTestId("form");
    await press(info, form.getByRole("combobox", { name: "Form kind" }));
    await press(info, page.getByRole("option", { name: "Credit card" }));
    await press(info, form.getByRole("combobox", { name: "Form day" }));
    await press(info, page.getByRole("button", { name: "Nov 30, 2026" }));
    await press(info, form.getByRole("checkbox", { name: "Agree" }));
    await form.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByTestId("sent")).toHaveText(JSON.stringify({ kind: "credit", day: "2026-11-30", time: "07:15" }));
  });

  test("inside a slide-out: the picker sits above it, Escape closes only the picker", async ({ page }, info) => {
    await page.goto("/dev/controls?task=demo");
    const drawer = page.getByRole("dialog", { name: "Task" });
    await expect(drawer).toBeVisible();
    await press(info, drawer.getByRole("combobox", { name: "Status" }));
    await shot(page, info, "drawer-select");
    await press(info, page.getByRole("option", { name: "Credit card" }));
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("combobox", { name: "Status" })).toHaveText("Credit card");
    await press(info, drawer.getByRole("combobox", { name: "Due" }));
    await expect(page.getByRole("grid")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("grid")).toBeHidden();
    await expect(page).toHaveURL(/task=demo/);
    await expect(drawer).toBeVisible();
    // On a phone the picker sheet adds no second scrim over the slide-out's.
    if (isPhone(info)) {
      await press(info, drawer.getByRole("combobox", { name: "Status" }));
      await expect(page.locator('[data-slot="picker-overlay"]')).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await press(info, page.locator('[data-slot="picker-sheet"]').getByRole("button", { name: "Close" }));
      await expect(surface(page)).toHaveCount(0);
    }
    // Category suggestions open in the Hydra list above the slide-out; Escape closes only them.
    const tag = drawer.getByRole("combobox", { name: "Category", exact: true });
    await tag.fill("ed");
    await expect(page.getByRole("option", { name: "Education" })).toBeVisible();
    await shot(page, info, "drawer-combobox");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(drawer).toBeVisible();
  });

  test("Combobox: suggestions in the Hydra list, never a datalist", async ({ page }, info) => {
    await open(page);
    await expect(page.locator("datalist, input[list]")).toHaveCount(0);
    const tag = page.getByRole("combobox", { name: "Tag", exact: true });
    await press(info, tag);
    await tag.fill("car");
    await expect(page.getByRole("option")).toHaveText(["Car and truck"]);
    await tag.fill("o");
    await shot(page, info, "combobox-open");
    if (isPhone(info)) await press(info, page.getByRole("option", { name: "Office supplies" }));
    else {
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
    }
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(values(page)).toContainText(isPhone(info) ? '"tag":"Office supplies"' : '"tag":"Contract labor"');
    await tag.fill("Something new");
    await tag.press("Tab");
    await expect(values(page)).toContainText('"tag":"Something new"');
  });

  test("phone time sheet: hour and minute columns, Clear", async ({ page }, info) => {
    test.skip(!isPhone(info), "the columns are the phone sheet");
    await open(page);
    const time = page.getByRole("combobox", { name: "Time", exact: true });
    await press(info, time);
    await expect(page.getByRole("listbox", { name: "Time hour" })).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Time minute" })).toBeVisible();
    await pickTime(page, info, "9:45 PM");
    await expect(values(page)).toContainText('"time":"21:45"');
    await press(info, time);
    await shot(page, info, "time-columns");
    await press(info, page.getByRole("button", { name: "Clear" }));
    await expect(values(page)).toContainText('"time":""');
    await expect(time).toHaveValue("");
  });
});

// ---- Six real forms across the app submit the right value through the custom controls ----

test.describe("real forms", () => {
  test("planning: a task's due date from the calendar", async ({ page }, info) => {
    await page.goto("/dev/planning");
    await page.getByRole("button", { name: "Open Film 6 Wordwise videos" }).click();
    const drawer = page.getByRole("dialog", { name: "Task" });
    await press(info, drawer.getByLabel("Due", { exact: true }));
    await press(info, page.getByRole("button", { name: "Nov 25, 2026" }));
    await expect(drawer.getByLabel("Due", { exact: true })).toHaveValue("Nov 25, 2026");
    await expect(surface(page)).toHaveCount(0); // the picker has finished closing
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await page.getByRole("button", { name: "Open Film 6 Wordwise videos" }).click();
    await expect(page.getByRole("dialog", { name: "Task" }).locator('[data-slot="date-picker"]').first()).toHaveAttribute("data-value", "2026-11-25");
  });

  test("routines: the time from the list", async ({ page }, info) => {
    await page.goto("/dev/routines");
    await page.getByRole("button", { name: "New routine" }).click();
    const dialog = page.getByRole("dialog", { name: "New routine" });
    await dialog.getByLabel("What should Hydra do?").fill("Every day, list my open UGC deals");
    await press(info, dialog.getByRole("combobox", { name: "Time" }));
    await pickTime(page, info, "7:35 AM");
    await expect(dialog.getByRole("combobox", { name: "Time" })).toHaveValue("7:35 AM");
    await press(info, dialog.getByRole("checkbox", { name: "Gmail" }));
    await expect(dialog.getByRole("checkbox", { name: "Gmail" })).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("button", { name: "Add routine" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/at 07:35/).first()).toBeVisible();
  });

  test("transactions: the From date filter", async ({ page }, info) => {
    await page.goto("/dev/transactions");
    await expect(page.getByTestId("tx-table")).toHaveAttribute("aria-busy", "false");
    if (isPhone(info)) await page.getByRole("button", { name: /Filters/ }).click();
    await press(info, page.getByRole("combobox", { name: "From date" }));
    await press(info, page.getByRole("button", { name: "Nov 1, 2026" }));
    await expect(page).toHaveURL(/from=2026-11-01/);
  });

  test("taxes: the payment date", async ({ page }, info) => {
    await page.goto("/dev/taxes");
    await page.getByRole("button", { name: /^Q4, due/ }).click();
    const form = page.getByRole("form", { name: "Payment for Q4" });
    await press(info, form.getByRole("combobox", { name: "Paid on" }));
    await press(info, page.getByRole("button", { name: "Nov 20, 2026" }));
    await expect(form.getByRole("combobox", { name: "Paid on" })).toHaveValue("Nov 20, 2026");
    await form.getByRole("button", { name: "Save payment" }).click();
    await expect(page.getByRole("button", { name: /^Q4, due/ })).toContainText("Paid");
  });

  test("accounts: the type select in the manual account form", async ({ page }, info) => {
    await page.goto("/dev/accounts");
    await page.getByRole("button", { name: /Add a manual account/ }).click();
    const dialog = page.getByRole("dialog", { name: "Add a manual account" });
    await dialog.getByLabel("Name").fill("Bike");
    await press(info, dialog.getByRole("combobox", { name: "Type" }));
    await press(info, page.getByRole("option", { name: /Asset/i }).first());
    await dialog.getByLabel("Value").fill("900");
    await dialog.getByRole("button", { name: "Add account" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Bike").first()).toBeVisible();
    await expect(page.locator("section, div").filter({ hasText: /^Manual assets/ }).first()).toContainText("Bike");
  });

  test("ugc: a deal's start date", async ({ page }, info) => {
    await page.goto(`/dev/ugc?tab=deals&deal=00000000-0000-4000-8000-000000000101`);
    const panel = page.getByTestId("deal-panel");
    await expect(panel.getByLabel("Brand name")).toHaveValue("Wordwise");
    const start = panel.getByRole("combobox", { name: "Start date" });
    const before = await start.inputValue();
    await press(info, start);
    await press(info, page.getByRole("button", { name: "Nov 2, 2026" }));
    await expect(start).toHaveValue("Nov 2, 2026");
    expect(before).not.toBe("Nov 2, 2026");
    await expect(panel.locator('[data-slot="date-picker"]').first()).toHaveAttribute("data-value", "2026-11-02");
  });
});
