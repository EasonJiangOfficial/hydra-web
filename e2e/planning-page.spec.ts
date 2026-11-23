import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { pickOption } from "./helpers/controls";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/planning-page";

const isPhone = (info: TestInfo) => info.project.name === "phone";
const width = (info: TestInfo) => (isPhone(info) ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `planning-page-${name}-${width(info)}.png`), fullPage });

// Fixture ids (src/lib/planning/fixtures.ts): the clock is fixed at Saturday, November 21, 2026.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FILM = id(100); // Not started, due Sunday Nov 22
const W9 = id(101); // Not started, due Tuesday Nov 24, has an alert Nov 24 9:00
const REVIEW = id(400); // Weekly review, Monday Nov 23 10:00, repeats weekly

/** Opens the fixture and waits until React has taken over (the goal bars fill in after hydration). */
async function open(page: Page, view?: "calendar" | "table") {
  await page.goto(`/dev/planning-page${view ? `?view=${view}` : ""}`);
  await expect(page.getByText("1 of 3 tasks")).toBeVisible();
}

const day = (page: Page, date: string) => page.getByTestId(`cal-day-${date}`);
const chip = (page: Page, key: string) => page.locator(`[data-item-key="${key}"]`);
const column = (page: Page, name: string) => page.getByRole("region", { name: `${name} column` });
const openDay = (page: Page, label: string) => page.getByRole("button", { name: `Open ${label}`, exact: true }).click();

/** A real mouse drag, so dnd-kit's 6 px activation and its collision pass both run. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, fast = false) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: fast ? 2 : 18 });
  const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await frames();
  // One more move over the target after the frames: dnd-kit sets the drop target from a move it has processed,
  // and under load the last of a 2-step move can land after the frames above (a 1-in-32 flake, measured).
  await page.mouse.move(to.x + 1, to.y + 1);
  await frames();
  await page.mouse.up();
  // dnd-kit swallows every click for 50 ms after a drop (a capture listener it removes on a 50 ms timer,
  // node_modules/@dnd-kit/core AbstractPointerSensor.detach). A 50 ms timer set now fires after that one,
  // so the next click is a real click, however slow the machine is.
  await page.evaluate(() => new Promise((done) => setTimeout(done, 50)));
}

const center = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

test.describe("/dev/planning-page", () => {
  test("switches between Board, Calendar and Table; the goal bars are live", async ({ page }, info) => {
    await open(page);
    // The savings goal reads the real resolver over the fixture ledger: (6,400 - 4,400) / 6,400.
    await expect(page.getByRole("button", { name: "Open goal Save 30 percent" })).toContainText("31.3%");
    await expect(page.getByRole("button", { name: "Open goal Taxes ready by January" })).toContainText("0 of 2 tasks");
    for (const name of ["Not started", "In progress", "Blocked", "Done"]) await expect(column(page, name)).toHaveCount(1);
    await page.waitForTimeout(400);
    await shot(page, info, "board", true);

    await page.getByRole("radio", { name: "Calendar" }).click();
    await expect(page.getByTestId("calendar")).toBeVisible();
    await expect(page.getByTestId("cal-month")).toHaveText("November 2026");
    await expect(page).toHaveURL(/view=calendar/);
    await expect(page.getByTestId("board")).toHaveCount(0);
    await page.waitForTimeout(400);
    await shot(page, info, "calendar", true);

    await page.getByRole("radio", { name: "Table" }).click();
    await expect(page.getByTestId("table")).toBeVisible();
    await expect(page.getByTestId("calendar")).toHaveCount(0);
    await page.waitForTimeout(300);
    await shot(page, info, "table", true);
    if (!isPhone(info)) {
      // At 1440 with the sidebar open every column fits: no sideways scroll, the last header whole.
      const fit = await page.getByTestId("table").evaluate((t) => {
        const box = t.parentElement!.closest(".overflow-x-auto") as HTMLElement;
        return { scroll: box.scrollWidth, client: box.clientWidth };
      });
      expect(fit.scroll).toBeLessThanOrEqual(fit.client);
      await expect(page.getByRole("columnheader", { name: "Effort" })).toBeInViewport({ ratio: 1 });
    }

    await page.getByRole("radio", { name: "Board" }).click();
    await expect(page.getByTestId("board")).toBeVisible();
    await expect(page).not.toHaveURL(/view=/);
  });

  test("a reload keeps the view from the URL", async ({ page }) => {
    await open(page, "calendar");
    await expect(page.getByTestId("calendar")).toBeVisible();
    await expect(page.getByRole("radio", { name: "Calendar" })).toBeChecked();
  });

  test("drag a board card from one column to the next", async ({ page }, info) => {
    await open(page);
    await page.getByTestId("board").evaluate((el) => {
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 90);
    });
    const from = (await page.locator(`[data-task-id="${W9}"]`).boundingBox())!;
    const target = (await column(page, "In progress").boundingBox())!;
    // On the phone the next column peeks in at the right edge: drop on the sliver that shows.
    const dropX = isPhone(info) ? 372 : target.x + target.width / 2;
    await drag(page, { x: from.x + from.width / 2, y: from.y + 22 }, { x: dropX, y: target.y + 60 }, isPhone(info));
    await expect(column(page, "In progress").locator(`[data-task-id="${W9}"]`)).toBeVisible();
    await expect(column(page, "Not started").locator(`[data-task-id="${W9}"]`)).toHaveCount(0);
  });

  test("the calendar shows card due dates, payouts, tax dates and reminders", async ({ page }, info) => {
    await open(page, "calendar");

    // Card due date, Wednesday Nov 25: dashed chip on the desktop, a row in the day panel everywhere.
    await expect(chip(page, "card:card-sapphire:2026-11-25")).toHaveCount(1);
    // Payout, Saturday Nov 28: the owed amount is on the next payout.
    await expect(chip(page, "payout:deal-wordwise:2026-11-28")).toHaveAttribute("aria-label", "Payout: Wordwise payout $1,200");
    // The alert on the W-9 task shows as a reminder on Nov 24.
    await expect(chip(page, `reminder:task:${W9}`)).toHaveAttribute("aria-label", "Reminder: Send W-9 to Brightleaf");
    if (!isPhone(info)) {
      await expect(chip(page, "card:card-sapphire:2026-11-25")).toBeVisible();
      await expect(day(page, "2026-11-28")).toContainText("Wordwise payout");
    }

    await openDay(page, "Wednesday, November 25");
    const panel = page.getByRole("dialog", { name: "Day" });
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-finance-row="card"]')).toContainText("Sapphire 4242 due");
    await expect(panel.locator('[data-finance-row="card"]')).toContainText("$842");
    await expect(panel).toContainText("They cannot be moved here");
    await page.waitForTimeout(400);
    await shot(page, info, "day-panel");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    // Tax date: Q4 estimated tax is Friday Jan 15, 2027.
    await page.getByRole("button", { name: "Next month" }).click();
    await page.getByRole("button", { name: "Next month" }).click();
    await expect(page.getByTestId("cal-month")).toHaveText("January 2027");
    await expect(chip(page, "tax:2027-01-15")).toHaveAttribute("aria-label", "Tax date: Q4 estimated tax");
    if (!isPhone(info)) await expect(day(page, "2027-01-15")).toContainText("Q4 estimated tax");
    await page.getByRole("button", { name: "Today" }).click();
    await expect(page.getByTestId("cal-month")).toHaveText("November 2026");
  });

  test("drag a task and an event to another day", async ({ page }, info) => {
    test.skip(isPhone(info), "On a phone the calendar shows dots; a date changes in the task and event panels.");
    await open(page, "calendar");
    // Bring the month to the top of the screen: near the bottom edge dnd-kit scrolls the page mid-drag.
    await page.getByTestId("calendar").evaluate((el) => {
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70);
    });

    const film = chip(page, `task:${FILM}`);
    await expect(day(page, "2026-11-22").locator(`[data-item-key="task:${FILM}"]`)).toBeVisible();
    await drag(page, center((await film.boundingBox())!), center((await day(page, "2026-11-25").boundingBox())!));
    await expect(day(page, "2026-11-25").locator(`[data-item-key="task:${FILM}"]`)).toBeVisible();
    await expect(day(page, "2026-11-22").locator(`[data-item-key="task:${FILM}"]`)).toHaveCount(0);

    // The new date holds: the task drawer says so.
    await film.click();
    await expect(page.getByRole("dialog", { name: "Task" }).getByLabel("Due", { exact: true })).toHaveValue("Nov 25, 2026");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Task" })).toBeHidden();
    await page.getByTestId("calendar").evaluate((el) => {
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70);
    });

    // The weekly review moves with its series: Monday Nov 23 to Thursday Nov 26, next one Dec 3.
    const review = chip(page, `event:${REVIEW}:2026-11-23`);
    await expect(review).toBeVisible();
    await drag(page, center((await review.boundingBox())!), center((await day(page, "2026-11-26").boundingBox())!));
    await expect(chip(page, `event:${REVIEW}:2026-11-26`)).toBeVisible();
    await expect(chip(page, `event:${REVIEW}:2026-11-23`)).toHaveCount(0);
    await expect(chip(page, `event:${REVIEW}:2026-11-30`)).toHaveCount(0);
    await expect(chip(page, `event:${REVIEW}:2026-12-03`)).toHaveCount(1);
    await page.waitForTimeout(300);
    await shot(page, info, "calendar-dragged");
  });

  test("a task opens from the calendar, its title saves by itself, and the board shows it", async ({ page }, info) => {
    await open(page, "calendar");
    await openDay(page, "Sunday, November 22");
    const panel = page.getByRole("dialog", { name: "Day" });
    await panel.getByRole("button", { name: "Open Film 6 Wordwise videos" }).click();

    const drawer = page.getByRole("dialog", { name: "Task" });
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`task=${FILM}`));
    await expect(page).not.toHaveURL(/day=/); // one panel at a time
    await drawer.getByLabel("Title").fill("Film 8 Wordwise videos");
    await drawer.getByLabel("Title").press("Enter");
    await drawer.getByLabel("Notes").fill("Hooks A, B and C from the brief.");
    await expect(drawer.getByRole("status")).toHaveText("Saved");
    await page.waitForTimeout(400);
    await shot(page, info, "task-drawer");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    if (!isPhone(info)) await expect(chip(page, `task:${FILM}`)).toContainText("Film 8 Wordwise videos");
    await page.getByRole("radio", { name: "Board" }).click();
    await expect(page.locator(`[data-task-id="${FILM}"]`)).toContainText("Film 8 Wordwise videos");
  });

  test("a day takes a new task and a new event, and the event edits in place", async ({ page }, info) => {
    await open(page, "calendar");
    await openDay(page, "Thursday, November 26");
    const panel = page.getByRole("dialog", { name: "Day" });

    const task = panel.getByLabel("Add a task to this day");
    await task.fill("Pay Sapphire");
    await task.press("Enter");
    await expect(panel.getByRole("button", { name: "Open Pay Sapphire" })).toBeVisible();

    const event = panel.getByLabel("Add an event to this day");
    await event.fill("Dentist");
    await event.press("Enter");
    const editor = panel.locator("[data-event-panel]");
    await expect(editor).toBeVisible();
    await editor.getByLabel("All day").uncheck();
    await editor.getByLabel("Start", { exact: true }).fill("14:00");
    await editor.getByLabel("Start", { exact: true }).press("Enter"); // typed text commits on Enter or blur
    await expect(panel.getByRole("button", { name: /2:00 PM\s+Dentist/ })).toBeVisible();
    await pickOption(editor.getByLabel("Repeat", { exact: true }), "weekly");
    await editor.getByLabel("Event notes").fill("Bring the card.");
    await expect(editor.getByRole("status")).toHaveText("Saved");
    await page.waitForTimeout(400);
    await shot(page, info, "event-editor");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    if (!isPhone(info)) {
      await expect(day(page, "2026-11-26")).toContainText("2:00 PM Dentist");
      await expect(day(page, "2026-11-26")).toContainText("Pay Sapphire");
    }
    // The task is a real task: it is on the board.
    await page.getByRole("radio", { name: "Board" }).click();
    await expect(column(page, "Not started").getByText("Pay Sapphire")).toBeVisible();
  });

  test("the category filter narrows the calendar", async ({ page }) => {
    await open(page, "calendar");
    await expect(chip(page, `task:${FILM}`)).toHaveCount(1);
    await pickOption(page.getByLabel("Category filter"), "Taxes");
    await expect(chip(page, `task:${FILM}`)).toHaveCount(0);
    await expect(chip(page, `task:${W9}`)).toHaveCount(1);
    await expect(chip(page, `event:${REVIEW}:2026-11-23`)).toHaveCount(0); // the review is Hydra
  });

  test("New makes a task, an event or a goal and opens it", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Task" }).click();
    await expect(page.getByRole("dialog", { name: "Task" }).getByLabel("Title")).toHaveValue("New task");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Event" }).click();
    await expect(page.getByRole("dialog", { name: "Day" }).locator("[data-event-panel]")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Goal" }).click();
    await expect(page.getByRole("dialog", { name: "Goal" })).toBeVisible();
  });

  test("items deleted in Google wait: Delete asks first, Keep puts it back", async ({ page }, info) => {
    await page.goto("/dev/planning-page?deleted=1");
    await expect(page.getByText("1 of 3 tasks")).toBeVisible();
    const strip = page.getByRole("region", { name: "Deleted in Google" });
    await expect(strip).toBeVisible();
    await expect(strip.locator("[data-google-delete]")).toHaveCount(2);

    // Delete only asks; No backs out and the task is still on the board.
    await strip.getByRole("button", { name: "Delete Send W-9 to Brightleaf" }).click();
    const ask = strip.getByRole("group", { name: "Delete Send W-9 to Brightleaf?" });
    await expect(ask).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, info, "google-delete-confirm");
    await ask.getByRole("button", { name: "No" }).click();
    await expect(page.locator(`[data-task-id="${W9}"]`).first()).toBeVisible();

    await strip.getByRole("button", { name: "Delete Send W-9 to Brightleaf" }).click();
    await strip.getByRole("group", { name: "Delete Send W-9 to Brightleaf?" }).getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(`[data-task-id="${W9}"]`)).toHaveCount(0);

    await strip.getByRole("button", { name: "Keep Weekly review" }).click();
    await expect(strip).toHaveCount(0);
  });
});

test.describe("/dev/planning-page drag feel", () => {
  test("a held calendar chip lifts, the day under it highlights, and it settles into that day", async ({ page, browserName }, info) => {
    test.skip(isPhone(info), "On a phone the calendar shows dots; a date changes in the task and event panels.");
    await open(page, "calendar");
    await page.getByTestId("calendar").evaluate((el) => {
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70);
    });
    const frame = (name: string) => page.screenshot({ path: path.join(SHOTS, `drag-${browserName}-${width(info)}-calendar-${name}.png`) });
    const film = center((await chip(page, `task:${FILM}`).boundingBox())!);
    const to = center((await day(page, "2026-11-25").boundingBox())!);
    await page.mouse.move(film.x, film.y);
    await page.mouse.down();
    await page.mouse.move(film.x + 12, film.y + 4, { steps: 4 });
    const lifted = page.locator("[data-cal-item]").and(page.locator(`[data-item-key="task:${FILM}"]`));
    await expect(lifted).toHaveClass(/text-transparent/); // the slot it leaves is a quiet tint
    await page.mouse.move(to.x, to.y, { steps: 16 });
    await expect(day(page, "2026-11-25")).toHaveAttribute("data-drop-target", "true");
    await expect
      .poll(() => page.locator(".cursor-grabbing.pointer-events-none").evaluate((el) => [getComputedStyle(el).scale, getComputedStyle(el).rotate].join(" ")))
      .toBe("1.02 1deg");
    await frame("1-held");
    const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
    await cdp?.send("Animation.enable");
    await cdp?.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
    await page.mouse.up();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const moving = await day(page, "2026-11-25").locator(`[data-item-key="task:${FILM}"]`).evaluate((el) => el.getAnimations().length);
    expect(moving).toBeGreaterThan(0);
    await frame("2-settle");
    await cdp?.send("Animation.setPlaybackRate", { playbackRate: 1 });
    await expect(day(page, "2026-11-25").locator(`[data-item-key="task:${FILM}"]`)).toBeVisible();
    await expect(page.locator("[data-drop-target]")).toHaveCount(0);
    await page.waitForTimeout(300);
    await frame("3-done");
  });

  test("a view change in the middle of a keyboard drag gives text selection back", async ({ page }, info) => {
    test.skip(isPhone(info), "Keyboard.");
    await open(page);
    const userSelect = () => page.evaluate(() => document.documentElement.style.userSelect);
    await page.getByRole("button", { name: "Reorder Send W-9 to Brightleaf" }).focus();
    await page.keyboard.press("Space");
    await expect(page.locator("[data-task-preview]")).toHaveCount(1);
    expect(await userSelect()).toBe("none");
    // A mouse click does not end a keyboard drag; the board unmounts with the card still held.
    await page.getByRole("radio", { name: "Calendar" }).click();
    await expect(page.getByTestId("calendar")).toBeVisible();
    expect(await userSelect()).toBe("");
  });
});
