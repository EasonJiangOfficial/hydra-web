import { expect, test, type Page } from "@playwright/test";
import { DESKTOP_WINDOW, installBridge } from "./helpers/desktop-bridge";

/*
 * Hydra Desktop's window (WebKit, the real v2 bridge) with the desktop pushing at its real rate: host.js pushOrb sends
 * { state, micLevel, outputLevel, detached } every 66 ms while the levels move (about 15 a second). The owner felt lag
 * there on slide-outs and Planning drags. Measured in a production build (pnpm build, HYDRA_DEV_ROUTES=1).
 *
 * Frame budgets. A frame at 60 Hz is 16.7 ms. Headless WebKit on an idle Mac runs these at p95 18 ms; the budget is
 * two frames at the 95th percentile (34 ms) and at most 3 % of frames over 50 ms. Frame times depend on the machine's
 * load, so every test reports them (an annotation and a log line) and fails on them only with PERF_STRICT=1.
 * The structural checks hold under any load and always fail: level pushes make no React commit, only the visible orb
 * draws (once per frame, in shade batches; a hidden orb draws nothing), and the slide-out moves as a browser
 * animation, not a style write per frame. They count calls per frame or per open, never per wall-clock second.
 */
test.use(DESKTOP_WINDOW);
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "Hydra Desktop is the Mac app only"));

/**
 * Commits (a React DevTools hook works in production builds), canvas fills, frame gaps, slide-out style writes.
 * Each orb draw starts with one clearRect: `draws` counts them, `drawLog` keeps [canvas index, frame number, time]
 * of each, so a test can tell which canvas drew in which animation frame.
 */
const PROBE = `(() => {
  const P = (window.__perf = { commits: 0, fills: 0, draws: 0, frames: [], slideWrites: 0, t0: 0, frameNo: 0, drawLog: [], canvases: [] });
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), isDisabled: false, checkDCE() {}, inject() { return 1; },
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onCommitFiberRoot() { P.commits++; },
  };
  const fill = CanvasRenderingContext2D.prototype.fill;
  CanvasRenderingContext2D.prototype.fill = function (...a) { P.fills++; return fill.apply(this, a); };
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  let drawing = null;
  CanvasRenderingContext2D.prototype.clearRect = function (...a) {
    P.draws++;
    let i = P.canvases.indexOf(this.canvas);
    if (i < 0) i = P.canvases.push(this.canvas) - 1;
    drawing = [i, P.frameNo, performance.now(), 0];
    P.drawLog.push(drawing);
    queueMicrotask(() => (drawing = null));
    return clear.apply(this, a);
  };
  // A draw ends by asking for the next one: a timer (the asleep nap) or an animation frame. A timer set inside the
  // draw (same task, before its microtasks) marks that draw [3] with its delay.
  const timeout = window.setTimeout;
  window.setTimeout = function (fn, ms, ...rest) { if (drawing) drawing[3] = ms || 0; return timeout.call(window, fn, ms, ...rest); };
  let last = 0;
  const tick = (t) => { P.frameNo++; if (last) P.frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  addEventListener('DOMContentLoaded', () => new MutationObserver((ms) => {
    for (const m of ms) if (m.target.matches && m.target.matches('[data-slot=detail-drawer]')) P.slideWrites++;
  }).observe(document.body, { attributes: true, attributeFilter: ['style'], subtree: true }));
})();`;

/** The native side: a live mic while listening, levels moving on every push. */
const PUSHER = `(() => {
  let n = 0;
  setInterval(() => {
    if (!window.__hydraDesktopPush || window.__pushPaused) return;
    n++;
    window.__hydraDesktopPush({ state: 'Listening', micLevel: Math.round((0.2 + 0.6 * Math.abs(Math.sin(n * 0.7))) * 1000) / 1000, outputLevel: 0, detached: false });
  }, 66);
})();`;

type Perf = {
  commits: number;
  fills: number;
  draws: number;
  frames: number[];
  slideWrites: number;
  t0: number;
  frameNo: number;
  /** [canvas index, animation frame number, time, ms of the nap timer the draw set (0: next animation frame)] */
  drawLog: [number, number, number, number][];
  canvases: HTMLCanvasElement[];
};
const reset = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __perf: Perf }).__perf;
    Object.assign(p, { commits: 0, fills: 0, draws: 0, frames: [], slideWrites: 0, t0: performance.now(), drawLog: [] });
  });
const read = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __perf: Perf }).__perf;
    const f = [...p.frames].sort((a, b) => a - b);
    const secs = (performance.now() - p.t0) / 1000;
    // Draws per canvas in the window, and whether that canvas is on the page (a box) or display: none.
    const orbs = p.canvases.map((c, i) => {
      const box = c.getBoundingClientRect();
      return { shown: c.isConnected && box.width > 0 && box.height > 0, draws: p.drawLog.filter(([k]) => k === i).length };
    });
    return {
      commits: p.commits,
      fills: p.fills,
      draws: p.draws,
      fillsPerSec: p.fills / secs,
      orbs,
      slideWrites: p.slideWrites,
      frames: f.length,
      p95: f[Math.floor(0.95 * (f.length - 1))] ?? 0,
      over50: f.filter((x) => x > 50).length,
    };
  });

/** Frame times: always reported; a failure only with PERF_STRICT=1 (they depend on how loaded the machine is). */
function withinBudget(r: Awaited<ReturnType<typeof read>>, what: string) {
  const line = `${what}: ${r.frames} frames, p95 ${r.p95.toFixed(1)} ms, ${r.over50} over 50 ms (budget p95 <= 34 ms, <= 3 % over 50 ms)`;
  test.info().annotations.push({ type: "frame times", description: line });
  console.log(`[desktop-perf] ${line}`);
  if (process.env.PERF_STRICT !== "1") return;
  expect(r.frames).toBeGreaterThan(20);
  expect(r.p95, `p95 frame ${r.p95} ms`).toBeLessThanOrEqual(34);
  expect(r.over50 / r.frames, `${r.over50} of ${r.frames} frames over 50 ms`).toBeLessThanOrEqual(0.03);
}

/** Two frames on (so a motion that starts on the next frame has started), every finite animation has finished. */
const still = (page: Page) =>
  page.evaluate(async () => {
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished),
    );
  });

async function open(page: Page, path: string) {
  const errors: string[] = [];
  await installBridge(page, new URL(test.info().project.use.baseURL ?? "").origin, errors);
  await page.addInitScript(PROBE);
  await page.addInitScript(PUSHER);
  await page.goto(path);
  await expect(page.locator('[data-testid="agent-status"]:visible')).toHaveText("Listening");
  return errors;
}

test("level pushes at the desktop's full rate make no React commit, and only the visible orb draws", async ({ page }) => {
  const errors = await open(page, "/dev/planning");
  await page.getByTestId("board").waitFor();
  await still(page);
  /** Commits React makes while the desktop pushes `n` more level updates (counted in pushes, not in seconds). */
  const commitsOver = (n: number) =>
    page.evaluate(
      (n) =>
        new Promise<number>((done) => {
          const p = (window as unknown as { __perf: Perf }).__perf;
          const c0 = p.commits;
          let k = 0;
          const on = () => {
            if (++k < n) return;
            removeEventListener("hydradesktop", on);
            done(p.commits - c0);
          };
          addEventListener("hydradesktop", on);
        }),
      n,
    );
  // Loading is over once five pushes pass without a commit (if pushes themselves commit, this never settles: a fail).
  await expect.poll(() => commitsOver(5), { timeout: 15_000 }).toBe(0);
  await reset(page);
  const pushes = 30;
  await commitsOver(pushes);
  const r = await read(page);
  test.info().annotations.push({ type: "orb", description: `${r.fillsPerSec.toFixed(0)} fills a second, ${r.draws} draws in ${r.frames} frames` });
  expect(r.commits, `React commits from ${pushes} level pushes`).toBe(0);
  // One orb on the page (the sidebar's), and one hidden (the phone orb is display: none here): the hidden one draws
  // nothing, the shown one draws once in every animation frame.
  const shown = r.orbs.filter((o) => o.shown);
  expect(shown).toHaveLength(1);
  for (const o of r.orbs.filter((o) => !o.shown)) expect(o.draws, "draws on a display: none orb").toBe(0);
  expect(shown[0].draws).toBeGreaterThanOrEqual(r.frames - 2);
  expect(shown[0].draws).toBeLessThanOrEqual(r.frames + 2);
  // Its dots fill per shade, at most 9 fills a draw (one fill per dot was about 220 a draw, 26,000 a second).
  expect(r.fills / r.draws).toBeGreaterThan(1);
  expect(r.fills / r.draws).toBeLessThanOrEqual(9);
  // At 60 fps that is at most 540 fills a second; a loaded machine only draws fewer frames.
  expect(r.fillsPerSec).toBeLessThan(1200);
  withinBudget(r, "level pushes");
  expect(errors).toEqual([]);
});

test("a Planning drag and slide-outs open and close within the frame budget while the desktop pushes", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await open(page, "/dev/planning");
  const board = page.getByTestId("board");
  await board.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 90));
  await still(page);
  await reset(page);
  for (const [a, b] of [
    ["Not started", "In progress"],
    ["In progress", "Not started"],
  ]) {
    const card = page.getByRole("region", { name: `${a} column` }).locator("[data-task-id]").first();
    const id = await card.getAttribute("data-task-id");
    const from = (await card.boundingBox())!;
    const to = (await page.getByRole("region", { name: `${b} column` }).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + 22);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + 26, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 30 });
    await page.mouse.up();
    await expect(page.getByRole("region", { name: `${b} column` }).locator(`[data-task-id="${id}"]`)).toBeVisible();
    // The settle glide has landed.
    await still(page);
  }
  withinBudget(await read(page), "Planning drags");

  for (const [path, opener, name] of [
    ["/dev/planning", "Open Film 6 Wordwise videos", "Task"],
    ["/dev/accounts", "Chase Checking", "Account"],
  ] as const) {
    if (path !== "/dev/planning") await page.goto(path);
    const button = path === "/dev/planning" ? page.getByRole("button", { name: opener }) : page.getByRole("link", { name: new RegExp(opener) });
    await button.waitFor();
    await still(page);
    await reset(page);
    for (let i = 0; i < 3; i++) {
      await button.click();
      const panel = page.getByRole("dialog", { name });
      await expect(panel).toBeVisible();
      // Opened all the way: its slide-in (and the shade's fade) has finished.
      await still(page);
      await panel.getByRole("button", { name: "Close", exact: true }).click();
      // Closed all the way: the exit animation ran and the panel left the page.
      await expect(panel).toHaveCount(0);
      await still(page);
    }
    const r = await read(page);
    withinBudget(r, `${name} slide-outs`);
    // The slide stays a browser animation (motion hands transform and opacity to WAAPI, which WebKit runs off the
    // main thread): measured 6 style writes per open and close, at the start and the end. A slide stepped from
    // JavaScript writes one per frame, about 28 per open and close.
    expect(r.slideWrites, `${name} panel style writes in 3 open/close cycles`).toBeLessThanOrEqual(3 * 8);
  }
  expect(errors).toEqual([]);
});

test("falling asleep mid-ripple, the orb keeps 60 fps until the ripple settles, then naps", async ({ page }) => {
  const errors = await open(page, "/dev/planning");
  await page.getByTestId("board").waitFor();
  // Listening for a while: at least 20 pushes at mic 0.2..0.8 have built a ripple (lv about 0.5).
  await page.evaluate(() => new Promise<void>((done) => {
    let k = 0;
    const on = () => ++k === 20 && (removeEventListener("hydradesktop", on), done());
    addEventListener("hydradesktop", on);
  }));
  // Asleep drives the ripple to 0 at 0.25 a draw (about 14 draws). Then the orb naps: a 100 ms timer between draws.
  const r = await page.evaluate(async () => {
    const w = window as unknown as { __perf: Perf; __pushPaused: boolean; __hydraDesktopPush: (s: object) => void };
    const p = w.__perf;
    w.__pushPaused = true;
    w.__hydraDesktopPush({ state: "Asleep", micLevel: 0, outputLevel: 0, detached: false });
    const shown = p.canvases.findIndex((c) => c.getBoundingClientRect().width > 0);
    const from = p.drawLog.length;
    // Counted in draws: 40 draws of the shown orb cover the decay and more than 20 naps.
    await new Promise<void>((done) => {
      const check = () => (p.drawLog.slice(from).filter(([k]) => k === shown).length >= 40 ? done() : setTimeout(check, 50));
      check();
    });
    return p.drawLog.slice(from).filter(([k]) => k === shown).map(([, , t, nap]) => ({ t, nap }));
  });
  const naps = r.map((d) => d.nap);
  const timeGaps = r.slice(1).map((d, i) => d.t - r[i].t);
  test.info().annotations.push({ type: "nap", description: `naps per draw ${naps.join(",")}; last gaps ${timeGaps.slice(-20).map((g) => g.toFixed(0)).join(", ")} ms` });
  // Decaying: the first 8 draws each ask for the very next animation frame (no nap). Napping right away set a
  // 100 ms timer from the first draw on.
  expect(naps.slice(0, 8), "nap timer set by each draw while the ripple decays").toEqual(Array(8).fill(0));
  // Settled: the nap holds. Each of the last 20 draws set the 100 ms timer, and they came at least that far apart
  // (60 fps would be 16.7 ms). The orb keeps drawing while it naps: 40 draws arrived.
  expect(naps.slice(-20), "nap timer set by each settled draw").toEqual(Array(20).fill(100));
  for (const gap of timeGaps.slice(-19)) expect(gap, "ms between napping draws").toBeGreaterThanOrEqual(95);
  expect(errors).toEqual([]);
});
