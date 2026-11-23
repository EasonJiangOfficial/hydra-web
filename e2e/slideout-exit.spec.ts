import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

/** Every slide-out leaves with the same exit: still on screen mid-way, gone after, and the page takes clicks at once. */

const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/slideout";
const isPhone = (info: TestInfo) => info.project.name === "phone";
const width = (info: TestInfo) => (isPhone(info) ? 390 : 1440);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const PANEL = '[data-slot="detail-drawer"]';

/** Samples the panel every frame from now on: whether it is there, and its opacity. */
async function startSampling(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const w = window as unknown as { __samples: (number | null)[]; __stop: boolean };
    w.__samples = [];
    w.__stop = false;
    const tick = () => {
      const el = document.querySelector(sel) as HTMLElement | null;
      w.__samples.push(el ? Number(getComputedStyle(el).opacity) : null);
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, selector);
}

/** Records the target of every click from now on (capture phase, before anything can stop it). */
async function recordClicks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __clicks: string[] };
    w.__clicks = [];
    document.addEventListener(
      "click",
      (e) => {
        const t = e.target as Element;
        const r = t.getBoundingClientRect();
        const scrim = getComputedStyle(t).position === "fixed" && r.width >= innerWidth && r.height >= innerHeight;
        const panel = t.closest('[data-slot^="detail-drawer"], [data-slot="agent-panel"], [role="dialog"]');
        w.__clicks.push(scrim || panel ? "layer" : "page");
      },
      { capture: true },
    );
  });
}

/** After the close: the panel was seen part-way through the fade (still mounted), then it is gone. */
async function expectExit(page: Page, selector: string) {
  await expect(page.locator(selector)).toHaveCount(0);
  const samples = await page.evaluate(() => {
    const w = window as unknown as { __samples: (number | null)[]; __stop: boolean };
    w.__stop = true;
    return w.__samples;
  });
  const mid = samples.filter((s): s is number => s !== null && s > 0.05 && s < 0.95);
  expect(mid.length, `mid-exit frames in ${JSON.stringify(samples.slice(0, 30))}`).toBeGreaterThan(1);
}

/** A point on the page outside the panel: left of it on desktop, above the sheet on the phone. */
const outside = (info: TestInfo) => (isPhone(info) ? { x: 195, y: 30 } : { x: 120, y: 450 });

type Kind = { name: string; url: string; open?: (page: Page) => Promise<void> };
const KINDS: Kind[] = [
  { name: "task", url: `/dev/planning?task=${id(100)}` },
  { name: "goal", url: "/dev/kit?goal=1" },
  { name: "planning-day", url: "/dev/planning-page?day=2026-11-25" },
  { name: "ugc-day", url: "/dev/ugc?day=2026-11-18" },
  { name: "deal", url: `/dev/ugc?tab=deals&deal=${id(101)}` },
  { name: "routine", url: "/dev/routines?routine=00000000-0000-4000-8000-0000000000a4" },
  { name: "category", url: "/dev/reports?category=c0000000-0000-4000-8000-000000000010" },
  { name: "taxline", url: "/dev/taxes", open: (p) => p.getByRole("link", { name: "Line 18, Office expense" }).click() },
  { name: "account", url: "/dev/accounts", open: (p) => p.getByRole("link", { name: /Chase Checking/ }).first().click() },
  { name: "tx", url: "/dev/transactions", open: (p) => p.getByTestId("tx-table").getByRole("button", { name: /^Open / }).first().click() },
];

async function openKind(page: Page, kind: Kind) {
  await page.goto(kind.url);
  await page.waitForLoadState("networkidle");
  if (kind.open) await kind.open(page);
  await expect(page.locator(PANEL)).toBeVisible();
  await page.waitForTimeout(450); // the enter slide
}

test.describe("slide-out exit", () => {
  for (const kind of KINDS) {
    test(`${kind.name}: a click outside slides it out, and the next click reaches the page`, async ({ page }, info) => {
      await openKind(page, kind);
      await startSampling(page, PANEL);
      await recordClicks(page);
      const at = outside(info);
      await page.mouse.click(at.x, at.y); // closes
      await page.waitForTimeout(60);
      if (kind.name === "task") await page.screenshot({ path: path.join(SHOTS, `mid-exit-${width(info)}.png`) });
      await page.mouse.click(at.x, at.y); // right after closing, mid-exit
      await expectExit(page, PANEL);
      await expect(page.locator('[data-slot="detail-drawer-overlay"]')).toHaveCount(0);
      expect((await page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks)).at(-1)).toBe("page");
      expect(new URL(page.url()).search).not.toMatch(/(task|goal|day|deal|routine|category|taxline|account|tx)=/);
      if (kind.name === "task") await page.screenshot({ path: path.join(SHOTS, `closed-${width(info)}.png`) });
    });
  }

  test("Esc, the close button and the back button all play the exit", async ({ page }, info) => {
    // Esc
    await openKind(page, KINDS[0]!);
    await startSampling(page, PANEL);
    await page.keyboard.press("Escape");
    await expectExit(page, PANEL);

    // Close button
    await openKind(page, KINDS[0]!);
    if (!isPhone(info)) await page.screenshot({ path: path.join(SHOTS, `open-${width(info)}.png`) });
    await startSampling(page, PANEL);
    await page.locator(PANEL).getByRole("button", { name: "Close" }).click();
    await expectExit(page, PANEL);

    // Back: open from a link (a history entry), then go back.
    await page.goto("/dev/planning");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Open Film 6 Wordwise videos" }).click();
    await expect(page.locator(PANEL)).toBeVisible();
    await page.waitForTimeout(450);
    await startSampling(page, PANEL);
    await page.goBack();
    await expectExit(page, PANEL);
  });

  test("a click on the page right after Esc lands (no stuck layer)", async ({ page }) => {
    await openKind(page, KINDS[1]!); // /dev/kit?goal=1
    // The scope switch sits under the scrim; it must take a click while the panel is still leaving.
    // includeHidden: while a panel is mounted, Radix marks the page aria-hidden.
    const scope = page.getByRole("radiogroup", { name: "Scope", includeHidden: true }).filter({ visible: true });
    const target = scope.getByRole("radio", { includeHidden: true }).nth(1);
    const box = (await target.boundingBox())!;
    await page.keyboard.press("Escape");
    // The close commits a frame later (Next applies the URL change in a transition); click the moment it has.
    await page.locator(`${PANEL}[data-state="closed"]`).waitFor({ state: "attached" });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const stillLeaving = await page.locator(PANEL).count();
    await expect(target).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(PANEL)).toHaveCount(0);
    expect(stillLeaving, "the click landed while the panel was still on screen").toBe(1);
  });

  test("the Hydra Agent panel slides out too", async ({ page }, info) => {
    await page.goto("/dev/agent");
    await page.waitForLoadState("networkidle");
    if (isPhone(info)) await page.getByTestId("agent-status-phone").click();
    else await page.getByRole("button", { name: "Open the thread" }).click();
    const sel = '[data-slot="agent-panel"]';
    await expect(page.locator(sel)).toBeVisible();
    await page.waitForTimeout(450);
    await startSampling(page, sel);
    await page.locator(sel).getByRole("button", { name: "Close" }).click();
    await expectExit(page, sel);
  });

  test("phone: the More sheet slides out too", async ({ page }, info) => {
    test.skip(!isPhone(info), "the More sheet is the phone's");
    await page.goto("/dev/shell");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "More" }).click();
    const sel = '[role="dialog"]';
    await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
    await page.waitForTimeout(450);
    await startSampling(page, sel);
    await recordClicks(page);
    await page.mouse.click(195, 30); // the scrim: closes
    await page.waitForTimeout(40);
    await page.mouse.click(195, 30); // mid-exit: must reach the page
    await expectExit(page, sel);
    expect((await page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks)).at(-1)).toBe("page");
  });

  test("reduced motion: a fade only, no slide", async ({ browser }, info) => {
    const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: width(info), height: isPhone(info) ? 844 : 900 } });
    const page = await context.newPage();
    await page.goto(KINDS[0]!.url);
    await expect(page.locator(PANEL)).toBeVisible();
    await page.waitForTimeout(450);
    await page.evaluate((sel) => {
      const w = window as unknown as { __moves: string[]; __stop: boolean };
      w.__moves = [];
      const tick = () => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) w.__moves.push(getComputedStyle(el).transform);
        if (el) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, PANEL);
    await startSampling(page, PANEL);
    await page.keyboard.press("Escape");
    await expectExit(page, PANEL);
    const moves = await page.evaluate(() => (window as unknown as { __moves: string[] }).__moves);
    expect(moves.every((m) => m === "none" || m === "matrix(1, 0, 0, 1, 0, 0)"), JSON.stringify(moves)).toBe(true);
    await context.close();
  });
});
