import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { pickOption } from "./helpers/controls";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/planning";

const isPhone = (info: TestInfo) => info.project.name === "phone";
const width = (info: TestInfo) => (isPhone(info) ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `planning-${name}-${width(info)}.png`), fullPage });

// Fixture ids (src/lib/planning/fixtures.ts): the clock is fixed at Saturday, November 21, 2026.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FILM = id(100); // Not started, due Nov 22, no alert, no repeat
const W9 = id(101); // Not started, has an alert
const PLAID = id(104); // Blocked, no due date

/** Opens the fixture and waits until React has taken over (the goal bars fill in after hydration). */
async function open(page: Page) {
  await page.goto("/dev/planning");
  await expect(page.getByText("1 of 3 tasks")).toBeVisible();
}

const column = (page: Page, name: string) => page.getByRole("region", { name: `${name} column` });
const card = (page: Page, taskId: string) => page.locator(`[data-task-id="${taskId}"]`);

/**
 * A real mouse drag, so dnd-kit's 6 px activation and its collision pass both run. On the phone
 * the board auto-scrolls while a card sits near its edge, so the last leg is short and quick: the
 * card is dropped two frames after it reaches the target column, before the board scrolls on.
 */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, fast: boolean) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: fast ? 2 : 18 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.mouse.up();
  // dnd-kit swallows clicks for 50 ms after a drop (see planning-page.spec.ts drag); let that pass.
  await page.evaluate(() => new Promise((done) => setTimeout(done, 50)));
}

test.describe("/dev/planning", () => {
  test("shows the goals strip and the four status columns", async ({ page }, info) => {
    await open(page);
    for (const name of ["Not started", "In progress", "Blocked", "Done"]) await expect(page.getByRole("region", { name: `${name} column` })).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Planning" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open goal Post 3 a day" })).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, info, "board", true);
  });

  test("drag a card from one column to the next", async ({ page }, info) => {
    await open(page);
    // Bring the board to the top of the screen (the phone stacks the goals above it), so both
    // the card and its target are on screen for the mouse.
    await page.getByTestId("board").evaluate((el) => {
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 90);
    });
    const source = card(page, W9);
    await expect(column(page, "Not started").locator(`[data-task-id="${W9}"]`)).toBeVisible();
    const from = (await source.boundingBox())!;
    const target = (await column(page, "In progress").boundingBox())!;
    // On the phone the next column peeks in at the right edge: drop on the sliver that shows.
    const dropX = isPhone(info) ? 372 : target.x + target.width / 2;
    await drag(page, { x: from.x + from.width / 2, y: from.y + 22 }, { x: dropX, y: target.y + 60 }, isPhone(info));
    await expect(column(page, "In progress").locator(`[data-task-id="${W9}"]`)).toBeVisible();
    await expect(column(page, "Not started").locator(`[data-task-id="${W9}"]`)).toHaveCount(0);
    await expect(column(page, "In progress").getByLabel("3 tasks")).toBeVisible();
  });

  test("Move sends a card to the next status without dragging", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Move Film 6 Wordwise videos to In progress" }).click();
    await expect(column(page, "In progress").locator(`[data-task-id="${FILM}"]`)).toBeVisible();
  });

  test("quick add puts a new card in the column", async ({ page }) => {
    await open(page);
    const input = page.getByLabel("New task in Blocked");
    await input.fill("Chase the Plaid keys");
    await input.press("Enter");
    await expect(column(page, "Blocked").getByText("Chase the Plaid keys")).toBeVisible();
    await expect(input).toHaveValue("");
    await expect(column(page, "Blocked").getByLabel("2 tasks")).toBeVisible();
  });

  test("a task opens in the drawer; the title and notes save by themselves", async ({ page }, info) => {
    await open(page);
    await page.getByRole("button", { name: "Open Film 6 Wordwise videos" }).click();
    await expect(page).toHaveURL(new RegExp(`task=${FILM}`));
    const drawer = page.getByRole("dialog", { name: "Task" });
    await expect(drawer).toBeVisible();

    await drawer.getByLabel("Title").fill("Film 8 Wordwise videos");
    await drawer.getByLabel("Title").press("Enter");
    await drawer.getByLabel("Notes").fill("Hooks A, B and C from the brief.");
    await expect(drawer.getByRole("status")).toHaveText("Saved");
    await page.waitForTimeout(400);
    await shot(page, info, "task-drawer");

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(card(page, FILM)).toContainText("Film 8 Wordwise videos");

    await page.getByRole("button", { name: "Open Film 8 Wordwise videos" }).click();
    await expect(page.getByRole("dialog", { name: "Task" }).getByLabel("Notes")).toHaveValue("Hooks A, B and C from the brief.");
  });

  test("set a repeat and an alert, then clear the alert", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Open Film 6 Wordwise videos" }).click();
    const drawer = page.getByRole("dialog", { name: "Task" });

    await pickOption(drawer.getByLabel("Repeat", { exact: true }), "weekly");
    await expect(card(page, FILM).getByText("Repeats weekly")).toHaveCount(1);

    await drawer.getByLabel("Alert", { exact: true }).fill("2026-11-22T09:00");
    await drawer.getByLabel("Alert", { exact: true }).press("Enter"); // typed text commits on Enter or blur
    await expect(card(page, FILM).getByText("Has an alert")).toHaveCount(1);
    await expect(drawer.locator('[data-slot="date-time-picker"]')).toHaveAttribute("data-value", "2026-11-22T09:00");
    await expect(drawer.getByLabel("Alert", { exact: true })).toHaveValue("Nov 22, 2026");

    await drawer.getByRole("button", { name: "Clear alert" }).click();
    await expect(card(page, FILM).getByText("Has an alert")).toHaveCount(0);
    await expect(drawer.getByLabel("Alert", { exact: true })).toHaveValue("");
    await expect(card(page, FILM).getByText("Repeats weekly")).toHaveCount(1);
  });

  test("a repeat on an undated task dates it today", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Open Waiting on Plaid Sandbox keys" }).click();
    const drawer = page.getByRole("dialog", { name: "Task" });
    await expect(drawer.getByLabel("Due", { exact: true })).toHaveValue("");
    await pickOption(drawer.getByLabel("Repeat", { exact: true }), "daily");
    await expect(drawer.getByLabel("Due", { exact: true })).toHaveValue("Nov 21, 2026");
    expect(await card(page, PLAID).count()).toBe(1);
  });

  test("the table sorts by a header and edits a cell in place", async ({ page }, info) => {
    await open(page);
    await page.getByRole("radio", { name: "Table" }).click();
    const table = page.getByTestId("table");
    await expect(table).toBeVisible();

    await table.getByRole("button", { name: "Due" }).click();
    await expect(table.getByRole("columnheader", { name: "Due" })).toHaveAttribute("aria-sort", "ascending");
    await expect(table.locator("tbody tr").first()).toContainText("Reconcile October"); // due Nov 19, the earliest

    await pickOption(table.getByLabel("Status of Film 6 Wordwise videos"), { label: "In progress" });
    await expect(table.getByLabel("Status of Film 6 Wordwise videos")).toHaveAttribute("data-value", /.+/);
    await table.getByLabel("Category of Film 6 Wordwise videos").fill("Content");
    await table.getByLabel("Category of Film 6 Wordwise videos").press("Enter");
    await page.getByRole("radio", { name: "Board" }).click();
    await expect(column(page, "In progress").locator(`[data-task-id="${FILM}"]`)).toContainText("Content");

    await page.getByRole("radio", { name: "Table" }).click();
    await page.waitForTimeout(300);
    await shot(page, info, "table", true);
  });

  test("grouping by priority turns a drop into a priority change", async ({ page }) => {
    await open(page);
    await pickOption(page.getByLabel("Group by"), { label: "Group: Priority" });
    await expect(page.getByRole("region", { name: "Urgent column" })).toBeVisible();
    await expect(page.getByRole("region", { name: "No Priority column" })).toBeVisible();
    // The accountant task is Urgent; Move is for statuses only, so use the drawer.
    await page.getByRole("button", { name: "Open Waiting on Plaid Sandbox keys" }).click();
    await pickOption(page.getByRole("dialog", { name: "Task" }).getByLabel("Priority of Waiting on Plaid Sandbox keys"), { label: "Urgent" });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Urgent column" }).locator(`[data-task-id="${PLAID}"]`)).toBeVisible();
  });

  test("a goal opens in its drawer and takes a metric", async ({ page }, info) => {
    await open(page);
    await page.getByRole("button", { name: "Open goal Taxes ready by January" }).click();
    await expect(page).toHaveURL(/goal=/);
    const drawer = page.getByRole("dialog", { name: "Goal" });
    await expect(drawer).toBeVisible();
    await pickOption(drawer.getByLabel("Metric", { exact: true }), { label: "Net worth" });
    await drawer.getByLabel("Target", { exact: true }).fill("60000");
    await drawer.getByRole("button", { name: "Add metric" }).click();
    await expect(drawer.locator("[data-metric-id]")).toHaveCount(2);
    await expect(drawer.getByText("$48,212")).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, info, "goal-drawer");
  });

  test("removing a goal metric or link asks first; Keep leaves it", async ({ page }, info) => {
    await open(page);
    await page.getByRole("button", { name: "Open goal Post 3 a day" }).click();
    const drawer = page.getByRole("dialog", { name: "Goal" });
    await expect(drawer).toBeVisible();
    const metrics = drawer.locator("[data-metric-id]");
    const count = await metrics.count();
    expect(count).toBeGreaterThan(0);
    const label = (await metrics.first().getByRole("button", { name: /^Remove / }).getAttribute("aria-label"))!;

    // One tap only asks: nothing is gone yet.
    await drawer.getByRole("button", { name: label, exact: true }).click();
    const ask = drawer.getByRole("group", { name: `${label}?` });
    await expect(ask).toBeVisible();
    await expect(metrics).toHaveCount(count);
    await page.waitForTimeout(300);
    await shot(page, info, "goal-remove-confirm");
    await ask.getByRole("button", { name: "Keep" }).click();
    await expect(metrics).toHaveCount(count);

    await drawer.getByRole("button", { name: label, exact: true }).click();
    await drawer.getByRole("group", { name: `${label}?` }).getByRole("button", { name: "Remove" }).click();
    await expect(metrics).toHaveCount(count - 1);

    // The link asks the same way.
    await drawer.getByRole("button", { name: "Remove link TikTok" }).click();
    const linkAsk = drawer.getByRole("group", { name: "Remove link TikTok?" });
    await linkAsk.getByRole("button", { name: "Keep" }).click();
    await expect(drawer.getByRole("link", { name: "TikTok" })).toBeVisible();
    await drawer.getByRole("button", { name: "Remove link TikTok" }).click();
    await linkAsk.getByRole("button", { name: "Remove" }).click();
    await expect(drawer.getByRole("link", { name: "TikTok" })).toHaveCount(0);
  });

  test("the Blocked column is gray, not red", async ({ page }) => {
    await open(page);
    const dot = page.getByRole("region", { name: "Blocked column" }).locator("[style*='background']").first();
    const color = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(color).not.toBe("rgb(179, 38, 30)");
  });
});

// ---------------------------------------------------------------------------------------------
// Drag feel (owner, 2026-11-22: drag items to other statuses with an animation, on the Mac app,
// the web app and the phone). Desktop drags with the mouse; the phone drags with a finger:
// Chromium sends real CDP touches, WebKit gets TouchEvents dispatched on the touched element
// (Playwright has no native touch drag in WebKit). Frames go to SHOTS_DIR as drag-<engine>-<width>-*.

type Pt = { x: number; y: number };
const ACCT = id(107); // Not started, third card
const EDIT = id(103); // In progress, second card

const frame = (page: Page, info: TestInfo, engine: string, name: string) =>
  page.screenshot({ path: path.join(SHOTS, `drag-${engine}-${width(info)}-${name}.png`) });
const order = (page: Page, name: string) =>
  column(page, name).locator("[data-task-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-task-id")));
const nextFrame = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
/** One script animation a card got (a settle glide or the reduced-motion fade): its column and its layer then. */
type Motion = { id: string; col: string | null; keys: string[]; z: string };
/**
 * Records, from here on, every Element.animate call on a card: the column it sits in and its inline z-index at that
 * moment, and the properties of its first keyframe. A 200 ms glide can end before a loaded machine lets a check see it
 * running; the record of what was started cannot be missed. A second call clears the record.
 */
const recordMotion = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __motion?: Motion[] };
    if (w.__motion) {
      w.__motion.length = 0;
      return;
    }
    const log: Motion[] = (w.__motion = []);
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes, options) {
      const id = this.getAttribute("data-task-id");
      if (id) {
        const first = (Array.isArray(keyframes) ? keyframes[0] : keyframes) ?? {};
        const col = this.closest("[data-column-id]")?.getAttribute("aria-label") ?? null;
        log.push({ id, col, keys: Object.keys(first), z: (this as HTMLElement).style.zIndex });
      }
      return animate.call(this, keyframes, options);
    };
  });
const motionLog = (page: Page) => page.evaluate(() => (window as unknown as { __motion?: Motion[] }).__motion ?? []);
/** The first recorded glide (a transform) on a card, in `col` when given. */
const glideOf = (page: Page, taskId: string, col?: string) =>
  motionLog(page).then((log) => log.find((m) => m.id === taskId && m.keys.includes("transform") && (col === undefined || m.col === col)) ?? null);

/** Board to the top of the screen, so the cards and the next column are under the pointer. */
async function boardToTop(page: Page) {
  await page.getByTestId("board").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 90));
}

/** One pointer that picks up, moves and lets go: the mouse on desktop, a finger on the phone. */
async function hold(page: Page, info: TestInfo, engine: string, at: Pt) {
  let last = at;
  if (!isPhone(info)) {
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 4, at.y + 10, { steps: 4 });
    return {
      move: async (p: Pt, steps = 12) => {
        await page.mouse.move(p.x, p.y, { steps });
        last = p;
      },
      up: async () => page.mouse.up(),
    };
  }
  if (engine === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    const send = (type: "touchStart" | "touchMove" | "touchEnd", p?: Pt) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
    await send("touchStart", at);
    // Held past the 220 ms hold: the lifted copy is up. (A fixed wait moved the finger early on a loaded machine.)
    await expect(page.locator("[data-task-preview]")).toBeVisible();
    return {
      move: async (p: Pt, steps = 12) => {
        for (let i = 1; i <= steps; i++) await send("touchMove", { x: last.x + ((p.x - last.x) * i) / steps, y: last.y + ((p.y - last.y) * i) / steps });
        last = p;
      },
      up: async () => send("touchEnd"),
    };
  }
  const target = await page.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y)!, at);
  const touches = (p: Pt) => [{ identifier: 1, clientX: p.x, clientY: p.y }];
  const fire = (type: string, p: Pt, down: boolean) =>
    target.dispatchEvent(type, { touches: down ? touches(p) : [], targetTouches: down ? touches(p) : [], changedTouches: touches(p) });
  await fire("touchstart", at, true);
  await expect(page.locator("[data-task-preview]")).toBeVisible();
  return {
    move: async (p: Pt, steps = 12) => {
      const from = last;
      for (let i = 1; i <= steps; i++) {
        await fire("touchmove", { x: from.x + ((p.x - from.x) * i) / steps, y: from.y + ((p.y - from.y) * i) / steps }, true);
        await nextFrame(page);
      }
      last = p;
    },
    up: async () => fire("touchend", last, false),
  };
}

test.describe("/dev/planning drag feel", () => {
  test("a held card lifts, leaves a tinted slot, opens a slot in the next status and settles there", async ({ page, browserName }, info) => {
    await open(page);
    await boardToTop(page);
    const from = (await card(page, W9).boundingBox())!;
    const finger = await hold(page, info, browserName, { x: from.x + from.width / 2, y: from.y + 22 });

    const lifted = page.locator(`[data-task-preview="${W9}"]`);
    await expect(lifted).toBeVisible();
    await expect(card(page, W9)).toHaveAttribute("data-dragging", "true");
    // Lifted: up 2% and tilted 1 degree, with an ink hairline.
    await expect.poll(() => lifted.evaluate((el) => [getComputedStyle(el).scale, getComputedStyle(el).rotate].join(" "))).toBe("1.02 1deg");
    await frame(page, info, browserName, "1-lift");

    const target = (await column(page, "In progress").boundingBox())!;
    const second = (await card(page, EDIT).boundingBox())!;
    // Phone: the next column peeks in at the right edge; let go before the edge scroll moves on.
    await finger.move(isPhone(info) ? { x: 372, y: second.y + 8 } : { x: target.x + target.width / 2, y: second.y + 8 }, isPhone(info) ? 4 : 14);
    await nextFrame(page);
    if (isPhone(info)) {
      // The edge scroll brings the next column in; back to the middle stops it there.
      await expect(column(page, "In progress")).toHaveAttribute("data-drop-target", "true");
      await expect.poll(() => page.getByTestId("board").evaluate((el) => el.scrollLeft)).toBeGreaterThan(250);
      await finger.move({ x: 195, y: second.y + 8 }, 4);
      // The edge scroll has stopped: the board's scroll holds still across three frames.
      await expect
        .poll(() =>
          page.getByTestId("board").evaluate(async (el) => {
            const a = el.scrollLeft;
            for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
            return el.scrollLeft === a;
          }),
        )
        .toBe(true);
    }
    const over = page.locator("section[data-drop-target]");
    await expect(over).toHaveCount(1);
    const name = (await over.getAttribute("aria-label"))!.replace(/ column$/, "");
    expect(name).not.toBe("Not started");
    // The slot travels: the column under the card has opened a gap, Not started has closed its gap.
    await expect(column(page, name).locator("[data-dragging]")).toHaveCount(1);
    await expect(column(page, "Not started").locator(`[data-task-id="${W9}"]`)).toHaveCount(0);
    await frame(page, info, browserName, "2-over");

    // Slow the settle so the frames catch it (Chromium only; WebKit plays it at full speed).
    const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
    await cdp?.send("Animation.enable");
    await cdp?.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
    await recordMotion(page);
    await finger.up();
    // It glides into its slot in the new column, and the copy's ink outline carries over to the real card and
    // fades to its rule as it lands (one keyframe set: transform and borderColor).
    await expect.poll(() => glideOf(page, W9, `${name} column`).then((m) => m?.keys ?? [])).toEqual(expect.arrayContaining(["transform", "borderColor"]));
    await expect(page.locator("[data-task-preview]")).toHaveCount(0);
    await frame(page, info, browserName, "3-settle");
    await cdp?.send("Animation.setPlaybackRate", { playbackRate: 1 });

    await expect(column(page, name).locator(`[data-task-id="${W9}"]`)).toBeVisible();
    await expect(column(page, "Not started").getByLabel("2 tasks")).toBeVisible();
    await expect(page.locator("[data-drop-target]")).toHaveCount(0);
    await expect.poll(() => card(page, W9).evaluate((el) => el.getAnimations().length)).toBe(0);
    await frame(page, info, browserName, "4-done");
  });

  test("reorder inside a column: the others slide aside and the new order stays", async ({ page, browserName }, info) => {
    await open(page);
    await boardToTop(page);
    expect(await order(page, "Not started")).toEqual([FILM, W9, ACCT]);
    const film = (await card(page, FILM).boundingBox())!;
    const acct = (await card(page, ACCT).boundingBox())!;
    const finger = await hold(page, info, browserName, { x: film.x + film.width / 2, y: film.y + 22 });
    await finger.move({ x: acct.x + acct.width / 2, y: acct.y + acct.height - 6 });
    await nextFrame(page);
    // W-9 has slid up into Film's place while the card is held.
    await expect.poll(() => card(page, W9).evaluate((el) => getComputedStyle(el).transform)).not.toBe("none");
    await frame(page, info, browserName, "reorder-held");
    await finger.up();
    await expect.poll(() => order(page, "Not started")).toEqual([W9, ACCT, FILM]);
  });

  test("Escape lets go: the card settles back and nothing moves", async ({ page, browserName }, info) => {
    test.skip(isPhone(info), "Escape is a keyboard key; the phone cancels by letting go off the board (next test).");
    await open(page);
    await boardToTop(page);
    const from = (await card(page, W9).boundingBox())!;
    const target = (await column(page, "Blocked").boundingBox())!;
    const finger = await hold(page, info, browserName, { x: from.x + from.width / 2, y: from.y + 22 });
    await finger.move({ x: target.x + target.width / 2, y: target.y + 60 });
    await expect(column(page, "Blocked").locator("[data-dragging]")).toHaveCount(1);
    await recordMotion(page);
    await page.keyboard.press("Escape");
    // W-9 glides back into its own slot in Not started.
    await expect.poll(() => glideOf(page, W9).then((m) => m?.col)).toBe("Not started column");
    // The returning card paints over the cards sliding back aside: the settle starts every glide in one frame
    // (W-9 first), each on the layer it was given.
    const log = await motionLog(page);
    const mine = Number((await glideOf(page, W9))!.z);
    expect(mine).toBeGreaterThan(0);
    for (const m of log) if (m.id !== W9) expect(Number(m.z)).toBeLessThan(mine);
    await frame(page, info, browserName, "cancel-settle");
    await finger.up();
    expect(await order(page, "Not started")).toEqual([FILM, W9, ACCT]);
    await expect(column(page, "Blocked").getByLabel("1 tasks")).toBeVisible();
  });

  test("let go off the board: the card settles back to its slot", async ({ page, browserName }, info) => {
    await open(page);
    await boardToTop(page);
    const from = (await card(page, W9).boundingBox())!;
    const board = (await page.getByTestId("board").boundingBox())!;
    const finger = await hold(page, info, browserName, { x: from.x + from.width / 2, y: from.y + 22 });
    // Up past the top of the board, onto the toolbar.
    await finger.move({ x: from.x + from.width / 2, y: Math.max(8, board.y - 70) }, 10);
    await nextFrame(page);
    await expect(page.locator("[data-drop-target]")).toHaveCount(0);
    await recordMotion(page);
    await finger.up();
    // It glides back into its own slot.
    await expect.poll(() => glideOf(page, W9).then((m) => m?.col)).toBe("Not started column");
    expect(await order(page, "Not started")).toEqual([FILM, W9, ACCT]);
  });

  test("a failed move rolls back with a short message", async ({ page, browserName }, info) => {
    await page.goto("/dev/planning?fail=move");
    await expect(page.getByText("1 of 3 tasks")).toBeVisible();
    await boardToTop(page);
    const from = (await card(page, W9).boundingBox())!;
    const target = (await column(page, "In progress").boundingBox())!;
    const finger = await hold(page, info, browserName, { x: from.x + from.width / 2, y: from.y + 22 });
    await finger.move(isPhone(info) ? { x: 372, y: target.y + 60 } : { x: target.x + target.width / 2, y: target.y + 60 }, isPhone(info) ? 4 : 14);
    await nextFrame(page);
    await recordMotion(page);
    await finger.up();
    // Optimistic first: the drop settles W-9 into In progress. Then the rollback glides it back to Not started
    // (not a jump), after that.
    await expect.poll(() => glideOf(page, W9, "In progress column").then(Boolean)).toBe(true);
    await expect.poll(() => glideOf(page, W9, "Not started column").then(Boolean)).toBe(true);
    const log = await motionLog(page);
    const there = log.findIndex((m) => m.id === W9 && m.col === "In progress column" && m.keys.includes("transform"));
    const back = log.findIndex((m) => m.id === W9 && m.col === "Not started column" && m.keys.includes("transform"));
    expect(back).toBeGreaterThan(there);
    await expect(page.getByRole("alert").filter({ hasText: "Could not move it. Try again." })).toBeVisible();
    await frame(page, info, browserName, "rollback");
    await expect(column(page, "Not started").locator(`[data-task-id="${W9}"]`)).toBeVisible();
    await expect(column(page, "In progress").locator(`[data-task-id="${W9}"]`)).toHaveCount(0);
  });

  test("reduced motion: no lift or glide, the card just fades in at its new place", async ({ page, browserName }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    await boardToTop(page);
    const from = (await card(page, W9).boundingBox())!;
    const target = (await column(page, "In progress").boundingBox())!;
    const finger = await hold(page, info, browserName, { x: from.x + from.width / 2, y: from.y + 22 });
    const lifted = page.locator(`[data-task-preview="${W9}"]`);
    await expect(lifted).toBeVisible();
    // Whatever could move the copy has run its course (a lift would be a transition on scale and rotate).
    await lifted.evaluate((el) => Promise.allSettled(el.getAnimations().map((a) => a.finished)));
    expect(await lifted.evaluate((el) => [getComputedStyle(el).scale, getComputedStyle(el).rotate].join(" "))).toBe("none none");
    // The copy is drawn like the card: its Move row sits where the card's does, so the drop hands over without a shift.
    const rowIn = async (sel: string) =>
      page.locator(sel).evaluate((el) => {
        const b = el.getBoundingClientRect();
        const r = el.querySelector("[data-move-row]")!.getBoundingClientRect();
        return [r.left - b.left, r.top - b.top, r.width, r.height];
      });
    const inCopy = await rowIn(`[data-task-preview="${W9}"]`);
    const inCard = await rowIn(`[data-task-id="${W9}"]`);
    inCopy.forEach((v, i) => expect(Math.abs(v - inCard[i])).toBeLessThan(0.75));
    await finger.move(isPhone(info) ? { x: 372, y: target.y + 60 } : { x: target.x + target.width / 2, y: target.y + 60 }, isPhone(info) ? 4 : 14);
    await nextFrame(page);
    // The 150 ms fade can end before a loaded machine lets a running-animation check see it: read what was started.
    await recordMotion(page);
    await finger.up();
    // The dropped card only fades (opacity, never transform), and no card glides.
    await expect.poll(() => motionLog(page).then((log) => log.filter((m) => m.id === W9).flatMap((m) => m.keys))).toEqual(["opacity"]);
    expect((await motionLog(page)).flatMap((m) => m.keys)).not.toContain("transform");
    await expect(column(page, "In progress").locator(`[data-task-id="${W9}"]`)).toBeVisible();
  });

  test("phone: holding presses the card in, then it lifts", async ({ page, browserName }, info) => {
    test.skip(!isPhone(info), "Touch only.");
    test.skip(browserName !== "chromium", "Dispatched TouchEvents fire no pointer events; the press cue needs a real touch (CDP).");
    await open(page);
    await boardToTop(page);
    const box = (await card(page, W9).boundingBox())!;
    // At the class change where the card starts to press in, is the lifted copy already up? (A fixed 120 ms wait
    // read the scale before a loaded machine had rendered the press.)
    await card(page, W9).evaluate((el) => {
      const w = window as unknown as { __press?: { preview: boolean } };
      const pressing = () => getComputedStyle(el).scale !== "none" || el.getAnimations().some((a) => a instanceof CSSTransition && a.transitionProperty === "scale");
      new MutationObserver((_, obs) => {
        if (!pressing()) return;
        w.__press = { preview: !!document.querySelector("[data-task-preview]") };
        obs.disconnect();
      }).observe(el, { attributes: true, attributeFilter: ["class"] });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + 22 }] });
    // Pressed in, and not lifted yet: the hold is 220 ms.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __press?: { preview: boolean } }).__press ?? null)).toEqual({ preview: false });
    await frame(page, info, browserName, "0-press");
    await expect(page.locator(`[data-task-preview="${W9}"]`)).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(await order(page, "Not started")).toEqual([FILM, W9, ACCT]);
  });

  test("phone: a tap opens the card and never lifts it", async ({ page }, info) => {
    test.skip(!isPhone(info), "Touch only.");
    await open(page);
    await boardToTop(page);
    const box = (await card(page, FILM).boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 20);
    await expect(page.getByRole("dialog", { name: "Task" })).toBeVisible();
    await expect(page.locator("[data-task-preview]")).toHaveCount(0);
    // The drawer makes the board inert, so ask the DOM where the card is.
    expect(await card(page, FILM).evaluate((el) => el.closest("[data-column-id]")?.getAttribute("aria-label"))).toBe("Not started column");
  });

  test("phone: at the screen edge the board scrolls to the next column; the page stays still", async ({ page, browserName }, info) => {
    test.skip(!isPhone(info), "Touch only.");
    await open(page);
    await boardToTop(page);
    const board = page.getByTestId("board");
    const scrollY = await page.evaluate(() => window.scrollY);
    const from = (await card(page, W9).boundingBox())!;
    const finger = await hold(page, info, browserName, { x: from.x + from.width / 2, y: from.y + 22 });
    // Snap is off while a card is held, so the edge scroll glides instead of jumping.
    await expect(board).toHaveClass(/snap-none/);
    await finger.move({ x: 384, y: from.y + 22 }, 8);
    await expect.poll(() => board.evaluate((el) => el.scrollLeft), { timeout: 4000 }).toBeGreaterThan(300);
    await frame(page, info, browserName, "edge-scroll");
    // Back to the middle: drop on whichever column now sits there.
    await finger.move({ x: 195, y: from.y + 40 }, 6);
    await nextFrame(page);
    const under = await page.evaluate(() => document.elementFromPoint(195, 300)?.closest("[data-column-id]")?.getAttribute("aria-label") ?? null);
    const over = await page.locator("[data-drop-target]").getAttribute("aria-label");
    // Held the whole way: the page never scrolled (the board keeps its height while a card is out).
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    const resting = await board.evaluate((el) => el.scrollLeft);
    await finger.up();
    // Through the drop and the settle: the board does not snap in one frame and the page stays still.
    await nextFrame(page);
    expect(Math.abs((await board.evaluate((el) => el.scrollLeft)) - resting)).toBeLessThan(1);
    expect(over).not.toBe("Not started column");
    expect(under === null || under === over).toBe(true);
    await expect(page.getByRole("region", { name: over! }).locator(`[data-task-id="${W9}"]`)).toBeVisible();
    await expect(board).toHaveClass(/snap-mandatory/);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    // Then it rests on a column: one column's left edge is the board's (or the board is scrolled to its end).
    expect(
      await board.evaluate((el) => {
        const left = el.getBoundingClientRect().left;
        const atEnd = Math.abs(el.scrollLeft - (el.scrollWidth - el.clientWidth)) < 1;
        return atEnd || Array.from(el.children).some((c) => Math.abs(c.getBoundingClientRect().left - left) < 1);
      }),
    ).toBe(true);
  });

  test("phone: near the bottom edge the page scrolls with the held card", async ({ page, browserName }, info) => {
    test.skip(!isPhone(info), "Touch only.");
    await open(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    const box = (await card(page, FILM).boundingBox())!;
    test.skip(box.y + 40 > 800, "The card starts too low to drag down.");
    const finger = await hold(page, info, browserName, { x: box.x + box.width / 2, y: box.y + 20 });
    await finger.move({ x: box.x + box.width / 2, y: 836 }, 8);
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 4000 }).toBeGreaterThan(40);
    await finger.up();
  });

  test("phone: a drop out of the tallest column, page scrolled to the bottom, keeps the page still", async ({ page, browserName }, info) => {
    test.skip(!isPhone(info), "The page scrolls under the board on the phone.");
    await page.goto("/dev/planning?fail=move");
    await expect(page.getByText("1 of 3 tasks")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const boardTop = () => page.getByTestId("board").evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const top = await boardTop();
    const from = (await card(page, W9).boundingBox())!;
    const finger = await hold(page, info, browserName, { x: from.x + from.width / 2, y: from.y + 22 });
    await finger.move({ x: 372, y: from.y + 22 }, 4);
    await nextFrame(page);
    await finger.up();
    // Every frame through the settle, the release of the held height and the rollback (300 ms;
    // its message shows above the board and the browser keeps the board where it is on screen).
    const seen = await page.evaluate(
      () =>
        new Promise<number[]>((done) => {
          const tops: number[] = [];
          const board = document.querySelector<HTMLElement>("[data-testid=board]")!;
          const t0 = performance.now();
          const tick = () => {
            tops.push(Math.round(board.getBoundingClientRect().top));
            if (performance.now() - t0 < 1200) requestAnimationFrame(tick);
            else done(tops);
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(new Set(seen)).toEqual(new Set([top]));
    await expect(column(page, "Not started").locator(`[data-task-id="${W9}"]`)).toBeVisible();
  });

  test("the slot follows the store: a rollback that lands while the next card is held shows at once", async ({ page, browserName }, info) => {
    test.skip(isPhone(info), "Two drags back to back with the mouse.");
    await page.goto("/dev/planning?fail=move");
    await expect(page.getByText("1 of 3 tasks")).toBeVisible();
    await boardToTop(page);
    const w9 = (await card(page, W9).boundingBox())!;
    const film = (await card(page, FILM).boundingBox())!;
    const target = (await column(page, "In progress").boundingBox())!;
    let finger = await hold(page, info, browserName, { x: w9.x + w9.width / 2, y: w9.y + 22 });
    await finger.move({ x: target.x + target.width / 2, y: target.y + 60 }, 8);
    await nextFrame(page);
    await finger.up();
    await page.evaluate(() => new Promise((done) => setTimeout(done, 60)));
    // Pick up Film while the failed move is still on its way back, and hold it over In progress.
    finger = await hold(page, info, browserName, { x: film.x + film.width / 2, y: film.y + 22 });
    await finger.move({ x: target.x + target.width / 2, y: target.y + 60 }, 8);
    await expect(column(page, "In progress").locator("[data-dragging]")).toHaveCount(1);
    // The rollback lands mid-hold: W-9 is back in Not started on the held board.
    await expect(column(page, "Not started").locator(`[data-task-id="${W9}"]`)).toHaveCount(1, { timeout: 2000 });
    await expect(column(page, "In progress").locator(`[data-task-id="${W9}"]`)).toHaveCount(0);
    await finger.up();
  });

  test("two drops close together: no card keeps a raised layer afterwards", async ({ page, browserName }, info) => {
    test.skip(isPhone(info), "Two drags back to back with the mouse.");
    await open(page);
    await boardToTop(page);
    // Slow the glides so the second drop lands while the first card is still gliding (Chromium).
    const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
    await cdp?.send("Animation.enable");
    await cdp?.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
    const film = (await card(page, FILM).boundingBox())!;
    const blocked = (await column(page, "Blocked").boundingBox())!;
    let finger = await hold(page, info, browserName, { x: film.x + film.width / 2, y: film.y + 22 });
    await finger.move({ x: blocked.x + blocked.width / 2, y: blocked.y + 60 }, 6);
    await nextFrame(page);
    await finger.up();
    await nextFrame(page);
    const w9 = (await card(page, W9).boundingBox())!;
    const done = (await column(page, "Done").boundingBox())!;
    finger = await hold(page, info, browserName, { x: w9.x + w9.width / 2, y: w9.y + 22 });
    await finger.move({ x: done.x + done.width / 2, y: done.y + 60 }, 6);
    await nextFrame(page);
    await finger.up();
    await nextFrame(page);
    await cdp?.send("Animation.setPlaybackRate", { playbackRate: 1 });
    await expect.poll(() => page.locator("[data-task-id]").evaluateAll((els) => els.flatMap((e) => e.getAnimations().filter((a) => !(a instanceof CSSTransition)))).then((a) => a.length)).toBe(0);
    expect(await page.locator("[data-task-id]").evaluateAll((els) => els.map((e) => (e as HTMLElement).style.zIndex).filter(Boolean))).toEqual([]);
  });

  test("into another column, the card lands below the card under the pointer's lower half", async ({ page, browserName }, info) => {
    test.skip(isPhone(info), "Mouse geometry.");
    await open(page);
    await boardToTop(page);
    const film = (await card(page, FILM).boundingBox())!;
    const plaid = (await card(page, PLAID).boundingBox())!;
    // Film held by its middle; the pointer goes three quarters down Plaid, the last card in Blocked.
    const finger = await hold(page, info, browserName, { x: film.x + film.width / 2, y: film.y + film.height / 2 });
    await finger.move({ x: plaid.x + plaid.width / 2, y: plaid.y + plaid.height * 0.75 }, 14);
    await nextFrame(page);
    expect(await order(page, "Blocked")).toEqual([PLAID, FILM]);
    await finger.up();
    await expect.poll(() => order(page, "Blocked")).toEqual([PLAID, FILM]);
  });

  test("keyboard: the handle keeps the focus across columns and the live region names the column", async ({ page }, info) => {
    test.skip(isPhone(info), "Keyboard.");
    await open(page);
    await boardToTop(page);
    const handle = page.getByRole("button", { name: "Reorder Send W-9 to Brightleaf" });
    const live = page.locator('[id^="DndLiveRegion"]');
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(live).toContainText("Send W-9 to Brightleaf: Not started, 2 of 3");
    // dnd-kit listens for the arrow keys from the next task on.
    await page.evaluate(() => new Promise((done) => setTimeout(done, 50)));
    await page.keyboard.press("ArrowRight");
    await expect(column(page, "In progress").locator(`[data-task-id="${W9}"][data-dragging]`)).toHaveCount(1);
    await nextFrame(page);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Reorder Send W-9 to Brightleaf");
    await expect(live).toContainText("Send W-9 to Brightleaf: In progress");
    await expect(live).not.toContainText("00000000-");
    await page.keyboard.press("Space");
    await expect(column(page, "In progress").locator(`[data-task-id="${W9}"]`)).toHaveCount(1);
    await expect(live).toContainText("Dropped Send W-9 to Brightleaf in In progress");
  });
});
