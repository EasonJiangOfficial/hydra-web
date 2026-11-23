import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { expectScope, pickScope, scopeMenu } from "./helpers/scope";

/** The Dashboard (U6) on /dev/dashboard: the real cards on fixture data, at 1440 and 390. Screenshots go to SHOTS_DIR when set. */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/dashboard";
const KEY = "hydra.dev.grid";

const isPhone = (info: TestInfo) => info.project.name === "phone";
const bp = (info: TestInfo) => (isPhone(info) ? "phone" : "desktop");
/** One grid row is rowHeight + gap tall (see GRID in src/lib/layout/model.ts). */
const pitch = (info: TestInfo) => (isPhone(info) ? 56 + 12 : 42 + 20);
const gap = (info: TestInfo) => (isPhone(info) ? 12 : 20);

const block = (page: Page, id: string) => page.getByTestId(`block-${id}`);
/** Blocks shown by default (src/lib/layout/blocks.ts): the phone follows Mobile.dc.html and starts three full cards hidden. */
const shownCount = (info: TestInfo) => (isPhone(info) ? 7 : 9);
const edit = (page: Page) => page.getByRole("button", { name: "Edit", exact: true });
const done = (page: Page) => page.getByRole("button", { name: "Done", exact: true });

async function open(page: Page, query = "") {
  await page.goto(`/dev/dashboard${query}`);
  await expect(block(page, "net-worth")).toBeVisible();
  // Blocks fade in once; wait for the grid to hold still before measuring.
  await page.waitForTimeout(450);
}

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
}

async function startEdit(page: Page, info: TestInfo) {
  await edit(page).click();
  await expect(done(page)).toBeVisible();
  await expect(page.getByTestId("drag-handle")).toHaveCount(shownCount(info));
}

type Point = { x: number; y: number };
/** The block's box in page coordinates: stable across the scrolls a drag makes. */
async function pageBox(page: Page, l: Locator) {
  const b = await box(l);
  return { ...b, y: b.y + (await page.evaluate(() => window.scrollY)) };
}
/** A drop point inside `target`, measured after dragBy has scrolled the handle (viewport coordinates). */
const onto = (target: Locator) => async () => {
  const t = await box(target);
  return { x: t.x + 40, y: t.y + 30 };
};

/** Press on a handle, move in steps, release. `to` runs after the scroll, so it measures live coordinates. */
async function dragBy(page: Page, handle: Locator, to: (from: Point) => Point | Promise<Point>) {
  // Centered, not just in view: at the bottom edge the phone's fixed tab bar would take the mouse.
  await handle.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(100);
  const b = await box(handle);
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const end = await to(from);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 3 });
  await page.mouse.move(end.x, end.y, { steps: 16 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(450); // settle: 200 ms ease
}

const stored = (page: Page) => page.evaluate((k) => window.localStorage.getItem(k), KEY);

/** The two blocks the drag test swaps: side by side on desktop, stacked on the phone. */
const drag = (info: TestInfo) =>
  isPhone(info) ? { moving: "coming-up", target: "goals" } : { moving: "posting", target: "ugc" };

/** Hover cards open on a mouse; the phone opens them with a tap, which also follows a row's link. */
const desktopOnly = (info: TestInfo) => test.skip(isPhone(info), "hover cards are mouse-only here; the phone taps");

test.describe("/dev/dashboard cards", () => {
  test("every card draws its figures", async ({ page }, info) => {
    await open(page);
    const nw = block(page, "net-worth");
    await expect(nw).toContainText(isPhone(info) ? "$48,212" : "$48,212.40");
    await expect(nw.getByTestId("net-worth-figure")).toBeVisible();
    await expect(nw).toContainText("past month");

    if (isPhone(info)) {
      // Mobile.dc.html: three tiles, the posting week with the picked day, then recent.
      for (const id of ["accounts", "month", "ugc"]) await expect(block(page, id)).toHaveCount(0);
      const tiles = block(page, "summary");
      for (const t of ["Cash", "$31.8k", "Cards", "-$2.3k", "UGC", "$3.9k"]) await expect(tiles).toContainText(t);
      const posting = block(page, "posting");
      await expect(posting).toContainText("Streak 5");
      await expect(posting).toContainText("-$420");
      await expect(posting.getByTestId("posting-grid")).toBeHidden();
      await expect(posting.locator("[data-testid=posting-week] [data-state-day]")).toHaveCount(7);
      await expect(posting.getByTestId("posting-week-day")).toContainText("Nov 21 · 3 of 3");
      await posting.getByRole("radio", { name: /^Nov 19/ }).click();
      await expect(posting.getByTestId("posting-week-day")).toContainText("Nov 19 · 0 of 3");
      await expect(posting.getByTestId("posting-week-day")).toContainText("-$90 missed");
      // Recent starts on the first screen and a half.
      expect((await box(block(page, "recent"))).y).toBeLessThan(844);
      await expect(block(page, "recent")).toContainText("Wordwise payout");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.waitForTimeout(1400);
      await page.screenshot({ path: path.join(SHOTS, `loaded-${bp(info)}.png`), fullPage: true });
      return;
    }
    await expect(block(page, "summary")).toHaveCount(0);

    const accounts = block(page, "accounts");
    await expect(accounts.getByTestId("cash-total")).toHaveText("$31,840");
    await expect(accounts.getByTestId("cards-total")).toHaveText("-$2,318");
    await expect(accounts).toContainText("Due in 6 days");
    await expect(accounts).toContainText("Amex Gold");
    await expect(accounts).toContainText("Sapphire");

    const month = block(page, "month");
    for (const [label, figure] of [
      ["Income this month", "$6,480"],
      ["Net after card bills", "$4,162"],
      ["Spending", "$2,905"],
      ["Recurring", "$413"],
    ]) {
      await expect(month).toContainText(label);
      await expect(month).toContainText(figure);
    }
    await expect(month).toContainText("+12%");

    const ugc = block(page, "ugc");
    await expect(ugc.getByTestId("ugc-earned")).toHaveText("$3,940");
    for (const t of ["Paid", "$2,680", "Owed to you", "$1,260", "Missed", "-$420", "Projected, 30 days", "$3,750"]) {
      await expect(ugc).toContainText(t);
    }

    const posting = block(page, "posting");
    await expect(posting).toContainText("Streak 5");
    await expect(posting.getByTestId("posting-grid").locator("[data-state-day]")).toHaveCount(30);
    await expect(posting.getByTestId("posting-grid").locator('[data-state-day="hit"]').first()).toBeVisible();
    await expect(posting.getByTestId("posting-week")).toBeHidden();

    const recent = block(page, "recent");
    await expect(recent).toContainText("Wordwise payout");
    await expect(recent).toContainText("+$1,420.00");
    await expect(recent).toContainText("Needs review");

    await expect(block(page, "goals").getByRole("progressbar")).toHaveCount(3);
    await expect(block(page, "goals")).toContainText("$3.9k / $10k");
    await expect(block(page, "coming-up")).toContainText("Nov 27");
    await expect(block(page, "coming-up")).toContainText("Amex Gold statement due");
    await expect(block(page, "coming-up")).toContainText("+$1,260.00");

    // No card scrolls sideways or spills out of its block.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.waitForTimeout(1400); // charts draw in once
    // Goal bars grow in when first seen: bring them into view so the screenshot shows them filled.
    await block(page, "goals").scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);
    await expect(block(page, "goals").getByRole("progressbar").first().locator("div")).toHaveCSS("transform", /matrix\(0\.72/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(SHOTS, `loaded-${bp(info)}.png`), fullPage: true });
  });

  test("the range switch changes the net worth change", async ({ page }, info) => {
    desktopOnly(info);
    await open(page);
    const nw = block(page, "net-worth");
    const range = nw.getByRole("radiogroup", { name: "Range" });
    await range.getByRole("radio", { name: "1W", exact: true }).click();
    await expect(nw).toContainText("this week");
    await range.getByRole("radio", { name: "All", exact: true }).click();
    await expect(nw).toContainText("all time");
    // The figure is today's value in every range.
    await expect(nw).toContainText("$48,212.40");
  });

  test("hover cards carry the numbers", async ({ page }, info) => {
    desktopOnly(info);
    await open(page);
    await page.waitForTimeout(1400);

    // Net worth line: date, value, change, assets and debts.
    const chart = page.getByTestId("net-worth-chart");
    const c = await box(chart);
    await page.mouse.move(c.x + c.width * 0.6, c.y + c.height * 0.6, { steps: 6 });
    const tip = page.getByTestId("net-worth-tip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("since");
    await expect(tip).toContainText("Assets");
    await expect(tip).toContainText("Debts $2,318");
    await page.screenshot({ path: path.join(SHOTS, "hover-net-worth-desktop.png") });
    await page.mouse.move(5, 5);

    // Card account row: statement balance, due date, use of limit.
    await block(page, "accounts").getByRole("link", { name: /Amex Gold/ }).hover();
    await expect(page.getByText("Statement $1,604.10")).toBeVisible();
    await expect(page.getByText("Due Nov 27")).toBeVisible();
    await expect(page.getByText("Using 12% of $13,000 limit")).toBeVisible();
    await page.mouse.move(5, 5);

    // Stat info dot: the formula with the real numbers.
    await block(page, "month").getByRole("button", { name: "More info" }).nth(1).hover();
    await expect(page.getByText("Income $6,480 minus card balances $2,318 owed now = $4,162.")).toBeVisible();
    await page.mouse.move(5, 5);

    // Goal bar: metric, window, pace per day.
    await block(page, "goals").getByRole("progressbar").first().hover();
    await expect(page.getByText("Needs 3.1 a day")).toBeVisible();
    await page.mouse.move(5, 5);

    // Posting day: date, posted of target, per deal, earned or missed.
    await block(page, "posting").locator("[data-state-day]").nth(18).hover();
    await expect(page.getByText("0 of 3 posted")).toBeVisible();
    await expect(page.getByText("Wordwise 0 of 2")).toBeVisible();
    await expect(page.getByText("Brightleaf 0 of 1")).toBeVisible();
    await expect(page.getByText("-$90 missed")).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "hover-posting-day-desktop.png") });
  });

  test("missed-day view warning: one line, the days behind an info dot", async ({ page }, info) => {
    await open(page, "?state=views");
    if (isPhone(info)) {
      await expect(block(page, "summary").getByRole("img", { name: "Views missing for 2 days" })).toBeVisible();
    } else {
      const ugc = block(page, "ugc");
      await expect(ugc.getByTestId("view-gap")).toHaveText(/Views missing for 2 days/);
      await ugc.getByRole("button", { name: "Missing views by day" }).hover();
      await expect(page.getByText("Nov 19: 6 of 9 posts read")).toBeVisible();
      await expect(page.getByText("Nov 20: 0 of 9 posts read")).toBeVisible();
    }
    await page.waitForTimeout(1400);
    await page.screenshot({ path: path.join(SHOTS, `views-warning-${bp(info)}.png`), fullPage: !isPhone(info) });
    await page.mouse.move(5, 5);
    await open(page);
    await expect(page.getByTestId("view-gap")).toHaveCount(0);
  });

  const clicks = [
    {
      name: "a posting day opens that day",
      pick: (p: Page, phone: boolean) =>
        phone ? block(p, "posting").getByTestId("posting-week-day") : block(p, "posting").getByRole("link", { name: /^Nov 18/ }),
      url: (phone: boolean) => (phone ? /ugc(\?|%3F)day(=|%3D)2026-11-21/ : /ugc(\?|%3F)day(=|%3D)2026-11-18/),
    },
    { name: "a recent row opens the transaction", pick: (p: Page) => block(p, "recent").getByRole("link", { name: /Adobe/ }), url: () => /transactions(\?|%3F)tx(=|%3D)tx-2/ },
    {
      name: "a card row opens the account",
      pick: (p: Page, phone: boolean) =>
        phone ? block(p, "summary").getByRole("link", { name: /Cards/ }) : block(p, "accounts").getByRole("link", { name: /Sapphire/ }),
      url: (phone: boolean) => (phone ? /accounts/ : /accounts(\?|%3F)account(=|%3D)acct-sapphire/),
    },
    { name: "a goal row opens the goal", pick: (p: Page) => block(p, "goals").getByRole("link", { name: /Net worth/ }), url: () => /planning(\?|%3F)goal(=|%3D)goal-net/ },
  ];
  for (const c of clicks) {
    // Signed out, the app sends these to /login?next=<the path>, so the target shows in either place.
    test(c.name, async ({ page }, info) => {
      await open(page);
      const link = c.pick(page, isPhone(info));
      await link.scrollIntoViewIfNeeded();
      await link.click();
      await expect(page).toHaveURL(c.url(isPhone(info)));
    });
  }

  test("the scope switch filters by entity", async ({ page }, info) => {
    await open(page);
    // The scope switch is in the top bar on desktop and a menu in the shell header on the phone.
    await pickScope(page, isPhone(info) ? "Me" : "Personal");
    await expect(page).toHaveURL(/scope=personal/);
    // UGC blocks do not apply to Personal: they go, with no line and no gap.
    await expect(block(page, "posting")).toHaveCount(0);
    await expect(page.getByText("UGC is not in this scope.")).toHaveCount(0);
    if (isPhone(info)) {
      // The third tile is the scope's own income outside All and UGC.
      await expect(block(page, "summary")).toContainText("Income");
      await expect(block(page, "summary")).toContainText("$2.5k");
      await pickScope(page, "UGC");
      await expect(page).toHaveURL(/scope=ugc/);
      await expect(block(page, "summary")).toContainText("$3.9k");
      return;
    }
    await expect(block(page, "ugc")).toHaveCount(0);
    await expect(block(page, "month")).toContainText("$2,540");
    await pickScope(page, "UGC");
    await expect(page).toHaveURL(/scope=ugc/);
    await expect(block(page, "ugc")).toContainText("Owed to you");
    await expect(block(page, "month")).toContainText("$3,940");
    await pickScope(page, "All");
    await expect(page).not.toHaveURL(/scope=/);
    await expect(block(page, "month")).toContainText("$6,480");
  });

  test("income and expenses follow the scope: figures, chart and categories, with the board dimmed while it loads", async ({ page }, info) => {
    await open(page, "?added=on");
    const flow = block(page, "income-expenses");
    /** The chart's bar shapes: a different scope draws different bars. */
    const bars = async () => {
      await page.waitForTimeout(700);
      return (await flow.getByTestId("flow-chart").locator(".recharts-rectangle").evaluateAll((els) => els.map((e) => e.getAttribute("d")))).join("|");
    };
    const cases = [
      { radio: isPhone(info) ? "Me" : "Personal", url: /scope=personal/, income: "$2,540", expenses: "$2,285", net: "$255", top: "Housing" },
      { radio: "UGC", url: /scope=ugc/, income: "$3,940", expenses: "$620", net: "$3,320", top: "Software" },
      { radio: "Studio Co", url: /scope=studio-co/, income: "$4,200", expenses: "$1,180", net: "$3,020", top: "Contractors" },
    ];
    await expect(flow.getByTestId("flow-income")).toContainText("$6,480");
    await expect(flow.getByTestId("flow-expenses")).toContainText("$2,905");
    let before = await bars();
    expect(before.length).toBeGreaterThan(0);
    // Hold the server's answer so the in-between state can be seen: the board dims and says aria-busy.
    let held = Promise.resolve();
    await page.route("**/dev/dashboard**", async (route) => {
      if (route.request().headers()["rsc"]) await held;
      await route.continue();
    });
    for (const c of cases) {
      let release = () => {};
      held = new Promise<void>((r) => (release = r));
      await pickScope(page, c.radio);
      const grid = page.locator(".hy-grid-root");
      await expect(grid).toHaveAttribute("aria-busy", "true");
      // The pick shows at once, before the new scope has loaded.
      await expectScope(page, c.radio);
      release();
      await expect(page).toHaveURL(c.url);
      await expect(grid).toHaveAttribute("aria-busy", "false");
      await expect(flow.getByTestId("flow-income")).toContainText(c.income);
      await expect(flow.getByTestId("flow-expenses")).toContainText(c.expenses);
      await expect(flow.getByTestId("flow-net")).toContainText(c.net);
      await expect(flow.getByTestId("flow-categories")).toContainText(c.top);
      await expect(flow.getByRole("link", { name: "Income and expenses" })).toHaveAttribute("href", `/reports?scope=${c.url.source.split("=")[1]}`);
      const now = await bars();
      expect(now).not.toBe(before);
      before = now;
    }
    // Studio Co has no accounts of its own: net worth is one row, the UGC blocks are gone, the chart leads.
    await expect(block(page, "net-worth")).toContainText("No accounts in Studio Co");
    await expect(block(page, "net-worth").getByRole("link", { name: "Assign an account" })).toHaveAttribute("href", "/accounts");
    await expect(block(page, "posting")).toHaveCount(0);
    // No $0 Cash and Cards tiles on the phone: the income strip carries Income.
    await expect(block(page, "summary")).toHaveCount(0);
    // A refund that pushed a category below zero is its own legend row, so the rows add up to Expenses.
    await expect(flow.getByTestId("flow-refunds")).toContainText("-$30");
    const [nw, ie] = [await box(block(page, "net-worth")), await box(flow)];
    expect(nw.height).toBeLessThan(80);
    expect(ie.y).toBeLessThan(nw.y + nw.height + gap(info) + 2);
  });

  test("a business with nothing in it: the income strip at $0 and one quiet line, no chart", async ({ page }) => {
    await open(page, "?scope=ugm");
    const flow = block(page, "income-expenses");
    await expect(flow.getByTestId("flow-income")).toContainText("$0");
    await expect(flow.getByTestId("flow-quiet")).toBeVisible();
    await expect(flow.getByTestId("flow-chart")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectScope(page, "UGM LLC");
  });

  test("phone: the scope menu shows the scope's whole name, lists every scope with a check, and truncates only a long name", async ({ page }, info) => {
    test.skip(!isPhone(info), "the menu is the phone's switch; desktop keeps the Seg");
    await open(page, "?added=on");
    const menu = scopeMenu(page);
    await expect(menu).toHaveText("All");
    await pickScope(page, "Studio Co");
    await expect(page).toHaveURL(/scope=studio-co/);
    await expect(menu).toHaveText("Studio Co");
    await menu.click();
    const items = page.getByRole("menuitemradio");
    await expect(items).toHaveText(["All", "Me", "UGC", "Studio Co"]);
    await expect(page.getByRole("menuitemradio", { name: "Studio Co" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("menuitemradio", { name: "All" })).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(items).toHaveCount(0);

    // A long business name: the button stops at 40% of the header and ends in an ellipsis; the menu has it whole.
    const long = "Northwind Creative Partners Holdings LLC";
    await page.evaluate((name) => {
      const e = { id: "e7000000-0000-4000-8000-000000000009", slug: "northwind", name, kind: "business", taxShape: "llc", status: "active", closedOn: null };
      window.sessionStorage.setItem("hydra-dev-businesses", JSON.stringify([e]));
    }, long);
    await open(page, "?scope=northwind");
    await expect(menu).toHaveAccessibleName(`Scope: ${long}`);
    const [b, header] = [await box(menu), await box(page.locator("header").filter({ has: menu }))];
    expect(b.width).toBeLessThanOrEqual(header.width * 0.4 + 1);
    expect(await menu.locator("span").first().evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await menu.click();
    await expect(page.getByRole("menuitemradio", { name: long })).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("/dev/dashboard states", () => {
  test("no accounts: one plain line and an Add account link per card", async ({ page }, info) => {
    await open(page, "?state=empty");
    // Every shown card but the phone's tiles (which show $0) has its one line.
    await expect(page.getByTestId("empty-state")).toHaveCount(isPhone(info) ? 5 : 8);
    const nw = block(page, "net-worth");
    await expect(nw).toContainText("No accounts yet.");
    const link = nw.getByRole("link", { name: "Add account" });
    await expect(link).toHaveAttribute("href", "/accounts");
    await expect(block(page, "recent")).toContainText("No accounts yet.");
    await expect(block(page, "goals")).toContainText("No goals yet.");
    await page.screenshot({ path: path.join(SHOTS, `empty-${bp(info)}.png`), fullPage: true });
  });

  test("loading: the route skeleton", async ({ page }, info) => {
    await page.goto("/dev/dashboard?state=loading");
    await expect(page.getByRole("status", { name: "Loading Dashboard" })).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, `loading-${bp(info)}.png`), fullPage: true });
  });
});

test.describe("/dev/dashboard edit mode on the real blocks", () => {
  test("phone: Edit sits in the header row beside the scope switch; desktop keeps it in the bar", async ({ page }, info) => {
    await open(page);
    const bar = page.getByTestId("dashboard-grid").locator("> div").first();
    if (isPhone(info)) {
      const scope = scopeMenu(page);
      const header = page.locator("header").filter({ has: scope });
      await expect(header.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      const [e, s] = [await box(edit(page)), await box(scope)];
      expect(Math.abs(e.y - s.y)).toBeLessThanOrEqual(3);
      expect(Math.abs(e.height - s.height)).toBeLessThanOrEqual(2);
      expect(e.x).toBeGreaterThan(s.x + s.width);
      await expect(bar).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } else {
      await expect(page.getByTestId("phone-edit")).toBeHidden();
      await expect(bar).toBeVisible();
      await expect(bar.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      await expect(bar.getByRole("radiogroup", { name: "Scope" })).toBeVisible();
    }
    await page.screenshot({ path: path.join(SHOTS, `header-edit-${bp(info)}.png`) });
    await edit(page).click();
    await expect(bar).toBeVisible();
    for (const name of ["Add block", "Reset", "Done"]) await expect(bar.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(edit(page)).toHaveCount(0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, `header-edit-editing-${bp(info)}.png`) });
    await done(page).click();
    await expect(edit(page)).toBeVisible();
    if (isPhone(info)) await expect(bar).toBeHidden();
  });

  test("edit shows a handle, a resize corner and a remove x on every card", async ({ page }, info) => {
    await open(page);
    await expect(page.getByTestId("drag-handle")).toHaveCount(0);
    await startEdit(page, info);
    await expect(page.getByTestId("remove-block")).toHaveCount(shownCount(info));
    await expect(page.getByTestId("resize-handle")).toHaveCount(shownCount(info));
    // The blocks a breakpoint starts hidden are one click away.
    await page.getByRole("button", { name: "Add block" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(isPhone(info) ? ["Cash and cards", "This month", "UGC revenue"] : ["Cash, cards and UGC"]);
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.waitForTimeout(1400);
    await page.screenshot({ path: path.join(SHOTS, `edit-${bp(info)}.png`), fullPage: true });
    await done(page).click();
    await expect(edit(page)).toBeVisible();
    await expect(page.getByTestId("drag-handle")).toHaveCount(0);
  });

  test("drag moves a card and snaps it into the slot", async ({ page }, info) => {
    await open(page);
    await startEdit(page, info);
    const { moving, target } = drag(info);
    // Page coordinates: dragBy centers the handle, which scrolls the page on the phone.
    const t0 = await pageBox(page, block(page, target));
    const m0 = await pageBox(page, block(page, moving));
    await dragBy(page, block(page, moving).getByTestId("drag-handle"), onto(block(page, target)));
    const m1 = await pageBox(page, block(page, moving));
    if (isPhone(info)) expect(Math.abs(m1.y - t0.y)).toBeLessThan(4);
    else expect(Math.abs(m1.x - t0.x)).toBeLessThan(4);
    expect(Math.abs(m1.x - m0.x) + Math.abs(m1.y - m0.y)).toBeGreaterThan(20);
    expect(Math.abs(m1.width - m0.width)).toBeLessThan(2); // sub-pixel rounding between columns
    const t1 = await pageBox(page, block(page, target));
    const apart =
      m1.x + m1.width <= t1.x + 1 || t1.x + t1.width <= m1.x + 1 || m1.y + m1.height <= t1.y + 1 || t1.y + t1.height <= m1.y + 1;
    expect(apart).toBe(true);
  });

  test("resize snaps to the grid and stops at the card's minimum and maximum", async ({ page }, info) => {
    await open(page);
    await startEdit(page, info);
    const handle = block(page, "recent").getByTestId("resize-handle");
    await block(page, "recent").scrollIntoViewIfNeeded();
    const h0 = (await box(block(page, "recent"))).height;
    await dragBy(page, handle, (f) => ({ x: f.x, y: f.y - pitch(info) + 6 }));
    expect((await box(block(page, "recent"))).height).toBeCloseTo(h0 - pitch(info), 0);
    await dragBy(page, handle, (f) => ({ x: f.x, y: f.y - 900 }));
    expect((await box(block(page, "recent"))).height).toBeCloseTo(3 * pitch(info) - gap(info), 0);
    await dragBy(page, handle, (f) => ({ x: f.x, y: f.y + 1500 }));
    expect((await box(block(page, "recent"))).height).toBeCloseTo((isPhone(info) ? 8 : 10) * pitch(info) - gap(info), 0);
  });

  test("remove hides a card, Add block brings it back with its data", async ({ page }, info) => {
    await open(page);
    await startEdit(page, info);
    await block(page, "recent").getByTestId("remove-block").click();
    await expect(block(page, "recent")).toHaveCount(0);
    await expect(page.getByTestId("drag-handle")).toHaveCount(shownCount(info) - 1);
    await page.getByRole("button", { name: "Add block" }).click();
    await expect(page.getByRole("menuitem", { name: "Recent" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Recent" }).click();
    await expect(block(page, "recent")).toBeVisible();
    await expect(block(page, "recent")).toContainText("Wordwise payout");
  });

  test("reset restores the default layout, and a reload keeps a saved one", async ({ page }, info) => {
    await open(page);
    const { moving, target } = drag(info);
    // Measured in edit mode, like `after`: on the phone the edit controls' row shows only while editing.
    await startEdit(page, info);
    const original = await box(block(page, moving));
    await block(page, "recent").getByTestId("remove-block").click();
    await dragBy(page, block(page, moving).getByTestId("drag-handle"), onto(block(page, target)));
    await done(page).click();
    await expect.poll(() => stored(page), { timeout: 5000 }).toContain(`"hidden":true`);

    await page.reload();
    await expect(block(page, "net-worth")).toBeVisible();
    await page.waitForTimeout(450);
    await expect(block(page, "recent")).toHaveCount(0);

    await edit(page).click();
    await expect(page.getByTestId("drag-handle")).toHaveCount(shownCount(info) - 1);
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(block(page, "recent")).toBeVisible();
    await page.waitForTimeout(450);
    await page.evaluate(() => window.scrollTo(0, 0));
    const after = await box(block(page, moving));
    expect(after.x).toBeCloseTo(original.x, 0);
    expect(after.y).toBeCloseTo(original.y, 0);
  });
});
