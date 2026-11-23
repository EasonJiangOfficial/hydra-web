import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { signIn } from "./helpers/supabase";

/*
 * Clicks answer at once even when the server is slow. Every page render is held back HOLD_MS. A slide-out, a
 * tab or a nav item must still change on the click (it needs no server render); the loading states are
 * captured on the way. Times print as `feel <name> <ms>` lines.
 */

const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/load-feel";
mkdirSync(SHOTS, { recursive: true });
const HOLD_MS = 1500;
/** A click must show its result well before the held server render could arrive. */
const FAST_MS = 400;
const PANEL = '[data-slot="detail-drawer"]';
const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({ path: path.join(SHOTS, `${name}-${info.project.name === "phone" ? 390 : 1440}.png`) });

/** Holds every page render (not prefetches) and every server action back by `ms`. */
async function holdServer(page: Page, ms: number) {
  await page.route(
    (url) => url.searchParams.has("_rsc") || url.pathname.startsWith("/dev/"),
    async (route) => {
      const r = route.request();
      const render = r.url().includes("_rsc=") && !r.headers()["next-router-prefetch"];
      if (!render && !r.headers()["next-action"]) return route.continue();
      const response = await route.fetch();
      await new Promise((res) => setTimeout(res, ms));
      await route.fulfill({ response }).catch(() => {});
    },
  );
}

type Wait = { sel: string; text?: string };

/** Milliseconds from the click to the first frame where `wait` matches. */
async function timeTo(page: Page, wait: Wait, act: () => Promise<void>) {
  await page.evaluate(({ sel, text }) => {
    const w = window as unknown as { __t: { click: number; seen: number } };
    w.__t = { click: 0, seen: 0 };
    window.addEventListener("click", () => (w.__t.click = performance.now()), { capture: true, once: true });
    const hit = () => [...document.querySelectorAll(sel)].some((el) => (text ? el.textContent?.trim() === text : true));
    const tick = () => {
      if (w.__t.click && hit()) w.__t.seen = performance.now();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, wait);
  await act();
  await page.waitForFunction(() => (window as unknown as { __t: { seen: number } }).__t.seen > 0, null, { timeout: 20_000 });
  return page.evaluate(() => {
    const t = (window as unknown as { __t: { click: number; seen: number } }).__t;
    return Math.round(t.seen - t.click);
  });
}

type Case = { name: string; url: string; open: (p: Page) => Promise<void>; wait?: Wait; desktopOnly?: boolean };
const CASES: Case[] = [
  { name: "task", url: "/dev/planning", open: (p) => p.getByRole("button", { name: "Open Film 6 Wordwise videos" }).click() },
  { name: "planning-day", url: "/dev/planning-page?view=calendar", open: (p) => p.getByRole("button", { name: "Open Wednesday, November 25", exact: true }).click() },
  { name: "ugc-day", url: "/dev/ugc", open: (p) => p.locator('main a[href*="day=2026-11-18"]').first().click() },
  { name: "ugc-tab", url: "/dev/ugc", open: (p) => p.getByRole("tab", { name: "Deals" }).click(), wait: { sel: '[role="tab"][aria-selected="true"]', text: "Deals" } },
  { name: "deal", url: "/dev/ugc?tab=deals", open: (p) => p.locator("[data-deal]").first().click() },
  { name: "routine", url: "/dev/routines", open: (p) => p.getByTestId("routine-row").first().getByRole("link").first().click() },
  { name: "category", url: "/dev/reports?tab=spending", open: (p) => p.getByRole("button", { name: "Open Housing", exact: true }).filter({ visible: true }).first().click() },
  { name: "reports-tab", url: "/dev/reports", open: (p) => p.getByRole("tab", { name: "Income" }).click(), wait: { sel: '[role="tab"][aria-selected="true"]', text: "Income" } },
  { name: "taxline", url: "/dev/taxes", open: (p) => p.getByRole("link", { name: "Line 18, Office expense" }).click() },
  { name: "account", url: "/dev/accounts", open: (p) => p.getByRole("link", { name: /Chase Checking/ }).first().click() },
  { name: "tx", url: "/dev/transactions", open: (p) => p.getByTestId("tx-table").getByRole("button", { name: /^Open / }).first().click() },
];

for (const c of CASES) {
  test(`${c.name}: the click answers before a slow server could`, async ({ page }, info) => {
    await page.goto(c.url);
    await page.waitForLoadState("networkidle");
    await holdServer(page, HOLD_MS);
    const ms = await timeTo(page, c.wait ?? { sel: PANEL }, () => c.open(page));
    console.log(`feel ${c.name} ${info.project.name} ${ms}`);
    // The panel on its way in (slide 28 px and fade, 280 ms), then whatever loading state it shows.
    await page.waitForTimeout(90);
    await shot(page, info, `${c.name}-1-opening`);
    await page.waitForTimeout(400);
    await shot(page, info, `${c.name}-2-open`);
    expect(ms).toBeLessThan(FAST_MS);
  });
}

test("agent panel: opens on the click", async ({ page }, info) => {
  await page.goto("/dev/agent");
  await page.waitForLoadState("networkidle");
  const ms = await timeTo(page, { sel: '[data-testid="agent-panel"]' }, () =>
    info.project.name === "phone" ? page.getByTestId("agent-status-phone").click() : page.getByRole("button", { name: "Open the thread" }).click(),
  );
  console.log(`feel agent ${info.project.name} ${ms}`);
  await page.waitForTimeout(90);
  await shot(page, info, "agent-1-opening");
  expect(ms).toBeLessThan(FAST_MS);
});

test("the slide-out skeleton: structure-matched, pulsing", async ({ page }, info) => {
  // The fixtures answer in memory, too fast to see a panel load; the kit page shows the same skeleton.
  await page.goto("/dev/kit");
  const card = page.getByTestId("kit-skeleton-panel");
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole("status", { name: "Loading" })).toBeVisible();
  await card.screenshot({ path: path.join(SHOTS, `panel-skeleton-${info.project.name === "phone" ? 390 : 1440}.png`) });
});

/** Slows every animation 20 times while `arrive` resolves, so a capture lands inside the 150-200 ms fade. */
async function revealSlowly(page: Page, arrive: () => Promise<unknown>) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.05 });
  await arrive();
  await page.waitForTimeout(1500); // about 75 ms of animation time
  return async () => cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
}

const PAGES = [
  { label: "Dashboard", href: "/", tab: "Home" },
  { label: "Planning", href: "/planning", tab: "Plan" },
  { label: "Routines", href: "/routines" },
  { label: "UGC Tracker", href: "/ugc", tab: "UGC" },
  { label: "Reports", href: "/reports", tab: "Reports" },
  { label: "Transactions", href: "/transactions" },
  { label: "Taxes", href: "/taxes" },
  { label: "Accounts", href: "/accounts" },
];
const SKELETON = 'main :is([role="status"][aria-label^="Loading"], [data-slot="skeleton"]):not([data-lazy] *)';

test.describe("sidebar pages (signed in)", () => {
  test.skip(!process.env.SUPABASE_E2E, "set SUPABASE_E2E=1 with local Supabase running");

  test("a nav click marks the item at once, the skeleton follows, then the page fades in", async ({ page, baseURL }, info) => {
    test.setTimeout(180_000);
    await signIn(page, baseURL!);
    const phone = info.project.name === "phone";
    for (let i = 0; i < PAGES.length; i++) {
      const from = PAGES[(i + PAGES.length - 1) % PAGES.length]!;
      const to = PAGES[i]!;
      await page.goto(from.href);
      await page.waitForLoadState("networkidle");
      await holdServer(page, HOLD_MS);
      // How strongly the skeleton shows: its opacity with every ancestor's, on its first frame and 50 ms later.
      await page.evaluate((sel) => {
        const w = window as unknown as { __op: number[] };
        w.__op = [];
        const seen = (el: Element | null) => {
          let o = 1;
          for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
          return Math.round(o * 100) / 100;
        };
        const tick = () => {
          const el = document.querySelector(sel);
          if (!el) return requestAnimationFrame(tick);
          w.__op.push(seen(el));
          setTimeout(() => w.__op.push(seen(document.querySelector(sel))), 50);
        };
        requestAnimationFrame(tick);
      }, SKELETON);
      const link = phone
        ? to.tab
          ? page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: to.tab })
          : null
        : page.getByRole("link", { name: to.label, exact: true });
      if (!link) {
        await page.getByRole("navigation", { name: "Tabs" }).getByRole("button", { name: "More" }).click();
        await page.getByRole("navigation", { name: "More" }).getByRole("link", { name: to.label }).click();
      }
      const pick = link ? () => link.click() : async () => {};
      if (link) {
        const marked = await timeTo(page, { sel: `a[aria-current="page"]:is([href="${to.href}"], [href^="${to.href}?"])` }, pick);
        console.log(`feel nav-marked ${to.href} ${info.project.name} ${marked}`);
      }
      const name = to.href === "/" ? "home" : to.href.slice(1);
      // A page the router already holds whole shows at once, with no skeleton.
      const skeleton = await page.locator(SKELETON).first().waitFor({ timeout: 4000 }).then(
        () => true,
        () => false,
      );
      console.log(`feel nav-skeleton ${to.href} ${info.project.name} ${skeleton}`);
      await page.waitForTimeout(80);
      const op = await page.evaluate(() => (window as unknown as { __op: number[] }).__op);
      console.log(`feel nav-skeleton-opacity ${to.href} ${info.project.name} ${op.join("/")}`);
      if (!skeleton) {
        await expect(page).toHaveURL(new RegExp(`${to.href === "/" ? "/$" : to.href}`));
        await shot(page, info, `page-${name}-0-instant`);
        await page.unrouteAll({ behavior: "ignoreErrors" });
        continue;
      }
      await shot(page, info, `page-${name}-1-skeleton`);
      const reset = await revealSlowly(page, () => page.locator(SKELETON).first().waitFor({ state: "detached", timeout: 20_000 }));
      await shot(page, info, `page-${name}-2-reveal`);
      // The title the skeleton already showed solid must stay solid when the page replaces it (UGM: no dip).
      const title = await page.evaluate(() => {
        let o = 1;
        for (let e: Element | null = document.querySelector("main h1"); e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
        return Math.round(o * 100) / 100;
      });
      console.log(`feel nav-title-opacity ${to.href} ${info.project.name} ${title}`);
      expect(title, `${to.href} title opacity at the reveal`).toBeGreaterThan(0.95);
      await reset();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });
});
