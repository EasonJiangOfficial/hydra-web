import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/grid";
const KEY = "hydra.dev.grid";

const isPhone = (info: TestInfo) => info.project.name === "phone";
const bp = (info: TestInfo) => (isPhone(info) ? "phone" : "desktop");
/** One grid row is rowHeight + gap tall (see GRID in src/lib/layout/model.ts). */
const pitch = (info: TestInfo) => (isPhone(info) ? 56 + 12 : 42 + 20);
const gap = (info: TestInfo) => (isPhone(info) ? 12 : 20);

/**
 * DASHBOARD_BLOCKS (src/lib/layout/blocks.ts): 10 blocks. Some start hidden per breakpoint (DESIGN.md 6.1,
 * Mobile.dc.html): the phone's summary tiles are off on desktop; the full cash, month and UGC cards are off
 * on the phone. Add block lists exactly the hidden ones, so it starts enabled on both.
 */
const OFF = { desktop: ["Cash, cards and UGC"], phone: ["Cash and cards", "This month", "UGC revenue"] };
const ALL = 10;
const off = (info: TestInfo) => OFF[bp(info)];
const shown = (info: TestInfo) => ALL - off(info).length;
const sorted = (a: readonly string[]) => [...a].sort();

const block = (page: Page, id: string) => page.getByTestId(`block-${id}`);
const edit = (page: Page) => page.getByRole("button", { name: "Edit", exact: true });
const done = (page: Page) => page.getByRole("button", { name: "Done", exact: true });

async function open(page: Page) {
  await page.goto("/dev/grid");
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
  await expect(page.getByTestId("drag-handle")).toHaveCount(shown(info));
}

const addBlock = (page: Page) => page.getByRole("button", { name: "Add block" });
/** Open Add block and expect exactly these titles (order is the grid's, so compare as sets). */
async function expectMenu(page: Page, titles: readonly string[]) {
  await addBlock(page).click();
  await expect(page.getByRole("menuitem")).toHaveCount(titles.length);
  expect(sorted(await page.getByRole("menuitem").allTextContents())).toEqual(sorted(titles));
}

/** Press on a handle, move in steps, release. */
async function dragBy(page: Page, handle: Locator, to: (from: { x: number; y: number }) => { x: number; y: number }) {
  await handle.scrollIntoViewIfNeeded();
  const b = await box(handle);
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const end = to(from);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 3 });
  await page.mouse.move(end.x, end.y, { steps: 16 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(450); // settle: 200 ms ease
}

const stored = (page: Page) => page.evaluate((k) => window.localStorage.getItem(k), KEY);
const savedWith = (page: Page, text: string) => expect.poll(() => stored(page), { timeout: 5000 }).toContain(text);

/** The two blocks the drag test swaps: side by side on desktop, stacked on the phone. */
const drag = (info: TestInfo) =>
  isPhone(info) ? { moving: "coming-up", target: "goals" } : { moving: "posting", target: "ugc" };

test.describe("/dev/grid", () => {
  test("outside edit mode there are no controls and nothing moves", async ({ page }, info) => {
    await open(page);
    await expect(edit(page)).toBeVisible();
    await expect(page.getByTestId("drag-handle")).toHaveCount(0);
    await expect(page.getByTestId("remove-block")).toHaveCount(0);
    await expect(page.getByTestId("resize-handle")).toHaveCount(0);
    await page.waitForTimeout(1400); // charts draw in once
    await page.screenshot({ path: path.join(SHOTS, `view-${bp(info)}.png`), fullPage: true });

    // A drag on the card body does nothing.
    const { moving } = drag(info);
    await block(page, moving).scrollIntoViewIfNeeded();
    const top = () => page.evaluate(() => window.scrollY);
    // Page coordinates: a drag may scroll the page, but the block must not move within it.
    const at = async () => {
      const r = await box(block(page, moving));
      return { x: r.x, y: r.y + (await top()), width: r.width, height: r.height };
    };
    const b0 = await at();
    const b = await box(block(page, moving));
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 - 200, b.y + b.height / 2 - 120, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    expect(await at()).toEqual(b0);
  });

  test("edit mode shows a handle, a resize corner and a remove x on every block", async ({ page }, info) => {
    await open(page);
    await startEdit(page, info);
    await expect(page.getByTestId("remove-block")).toHaveCount(shown(info));
    await expect(page.getByTestId("resize-handle")).toHaveCount(shown(info));
    await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();
    // The edit controls fit the width: no sideways scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(SHOTS, `edit-${bp(info)}.png`), fullPage: true });
    // Add block lists the blocks this breakpoint starts without; adding them all shows every block
    // with its controls, and Add block has nothing left.
    for (const left = [...off(info)]; left.length; ) {
      await expectMenu(page, left);
      await page.getByRole("menuitem", { name: left.shift(), exact: true }).click();
      await expect(page.getByRole("menuitem")).toHaveCount(0);
    }
    await expect(page.getByTestId("remove-block")).toHaveCount(ALL);
    await expect(page.getByTestId("resize-handle")).toHaveCount(ALL);
    await expect(addBlock(page)).toBeDisabled();
    await done(page).click();
    await expect(edit(page)).toBeVisible();
    await expect(page.getByTestId("drag-handle")).toHaveCount(0);
  });

  test("drag moves a block and snaps it into the slot", async ({ page }, info) => {
    await open(page);
    await startEdit(page, info);
    const { moving, target } = drag(info);
    await block(page, target).scrollIntoViewIfNeeded();
    const t0 = await box(block(page, target));
    const m0 = await box(block(page, moving));
    await dragBy(page, block(page, moving).getByTestId("drag-handle"), () => ({ x: t0.x + 40, y: t0.y + 30 }));
    const m1 = await box(block(page, moving));
    // It took the target's slot: same x (desktop) or same y (phone).
    if (isPhone(info)) expect(Math.abs(m1.y - t0.y)).toBeLessThan(4);
    else expect(Math.abs(m1.x - t0.x)).toBeLessThan(4);
    expect(Math.abs(m1.x - m0.x) + Math.abs(m1.y - m0.y)).toBeGreaterThan(20);
    expect(m1.width).toBeCloseTo(m0.width, 0);
    // No overlap with the block it displaced.
    const t1 = await box(block(page, target));
    const apart = m1.x + m1.width <= t1.x + 1 || t1.x + t1.width <= m1.x + 1 || m1.y + m1.height <= t1.y + 1 || t1.y + t1.height <= m1.y + 1;
    expect(apart).toBe(true);
  });

  test("resize snaps to the grid and stops at the block's minimum and maximum", async ({ page }, info) => {
    await open(page);
    await startEdit(page, info);
    const handle = block(page, "recent").getByTestId("resize-handle");
    await block(page, "recent").scrollIntoViewIfNeeded();
    const h0 = (await box(block(page, "recent"))).height;
    // One row smaller.
    await dragBy(page, handle, (f) => ({ x: f.x, y: f.y - pitch(info) + 6 }));
    const h1 = (await box(block(page, "recent"))).height;
    expect(h1).toBeCloseTo(h0 - pitch(info), 0);
    // Far past the minimum (3 rows on both layouts): it stops at 3 rows.
    await dragBy(page, handle, (f) => ({ x: f.x, y: f.y - 900 }));
    const h2 = (await box(block(page, "recent"))).height;
    expect(h2).toBeCloseTo(3 * pitch(info) - gap(info), 0);
    // Far past the maximum (desktop 10 rows, phone 8): it stops there.
    await dragBy(page, handle, (f) => ({ x: f.x, y: f.y + 1500 }));
    const h3 = (await box(block(page, "recent"))).height;
    expect(h3).toBeCloseTo((isPhone(info) ? 8 : 10) * pitch(info) - gap(info), 0);
  });

  test("remove hides a block, Add block brings it back", async ({ page }, info) => {
    await open(page);
    await startEdit(page, info);
    await block(page, "recent").getByTestId("remove-block").click();
    await expect(block(page, "recent")).toHaveCount(0);
    await expect(page.getByTestId("drag-handle")).toHaveCount(shown(info) - 1);
    await expectMenu(page, [...off(info), "Recent"]);
    await page.getByRole("menuitem", { name: "Recent" }).click();
    await expect(block(page, "recent")).toBeVisible();
    await expect(page.getByTestId("drag-handle")).toHaveCount(shown(info));
    await expectMenu(page, off(info));
  });

  test("reset restores the default layout", async ({ page }, info) => {
    await open(page);
    const { moving } = drag(info);
    const original = await box(block(page, moving));
    await startEdit(page, info);
    await block(page, "recent").getByTestId("remove-block").click();
    const { target } = drag(info);
    await block(page, target).scrollIntoViewIfNeeded();
    const t0 = await box(block(page, target));
    await dragBy(page, block(page, moving).getByTestId("drag-handle"), () => ({ x: t0.x + 40, y: t0.y + 30 }));
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(block(page, "recent")).toBeVisible();
    await page.waitForTimeout(450);
    await page.evaluate(() => window.scrollTo(0, 0));
    const after = await box(block(page, moving));
    expect(after.x).toBeCloseTo(original.x, 0);
    expect(after.y).toBeCloseTo(original.y, 0);
    // The saved layout is gone, so a reload shows the default too.
    await expect.poll(() => stored(page)).not.toContain(bpKey(info));
  });

  test("a reload keeps the layout", async ({ page }, info) => {
    await open(page);
    await startEdit(page, info);
    await block(page, "recent").getByTestId("remove-block").click();
    const { moving, target } = drag(info);
    await block(page, target).scrollIntoViewIfNeeded();
    const t0 = await box(block(page, target));
    await dragBy(page, block(page, moving).getByTestId("drag-handle"), () => ({ x: t0.x + 40, y: t0.y + 30 }));
    await block(page, "goals").scrollIntoViewIfNeeded();
    await dragBy(page, block(page, "goals").getByTestId("resize-handle"), (f) => ({ x: f.x, y: f.y - pitch(info) + 6 }));
    await done(page).click();
    await savedWith(page, `"hidden":true`);
    await page.evaluate(() => window.scrollTo(0, 0));
    const want = Object.fromEntries(
      await Promise.all(
        ["net-worth", moving, target, "goals"].map(async (id) => [id, await box(block(page, id))] as const),
      ),
    );

    await page.reload();
    await expect(block(page, "net-worth")).toBeVisible();
    await page.waitForTimeout(450);
    await expect(block(page, "recent")).toHaveCount(0);
    for (const [id, w] of Object.entries(want)) {
      const got = await box(block(page, id));
      expect(got.x, `${id}.x`).toBeCloseTo(w.x, 0);
      expect(got.y, `${id}.y`).toBeCloseTo(w.y, 0);
      expect(got.width, `${id}.width`).toBeCloseTo(w.width, 0);
      expect(got.height, `${id}.height`).toBeCloseTo(w.height, 0);
    }
    // Edit, Add block shows the one that was removed.
    await startEditCount(page, shown(info) - 1);
    await expectMenu(page, [...off(info), "Recent"]);
    await page.screenshot({ path: path.join(SHOTS, `edit-reloaded-${bp(info)}.png`), fullPage: true });
  });

  test("a layout saved by a bad or older app is repaired", async ({ page }, info) => {
    await page.addInitScript((k) => {
      window.localStorage.setItem(
        k,
        JSON.stringify({
          desktop: { updatedAt: "x", items: [{ id: "ghost", x: 0, y: 0, w: 4, h: 4 }, { id: "recent", x: 0, y: 0, w: 4, h: 5 }, 7] },
          phone: { updatedAt: "y", items: "nonsense" },
        }),
      );
    }, KEY);
    await open(page);
    // Junk dropped, missing blocks filled in at their defaults (hidden where the spec hides them).
    await expect(page.locator("[data-block]")).toHaveCount(shown(info));
    await expect(block(page, "ghost")).toHaveCount(0);
    await expect(block(page, "recent")).toBeVisible();
  });

  test("the losing tab reloads the newer layout", async ({ context }, info) => {
    const a = await context.newPage();
    const b = await context.newPage();
    await open(a);
    await open(b);
    await startEdit(a, info);
    await block(a, "recent").getByTestId("remove-block").click();
    await savedWith(a, `"hidden":true`);
    await startEdit(b, info);
    await block(b, "goals").getByTestId("remove-block").click();
    // B saves against a stale token, loses, and shows A's layout: Recent gone, Goals back.
    await expect(block(b, "goals")).toBeVisible({ timeout: 5000 });
    await expect(block(b, "recent")).toHaveCount(0);
  });
});

const bpKey = (info: TestInfo) => `"${bp(info)}"`;

async function startEditCount(page: Page, handles: number) {
  await edit(page).click();
  await expect(page.getByTestId("drag-handle")).toHaveCount(handles);
}
