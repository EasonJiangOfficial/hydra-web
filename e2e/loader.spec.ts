import { expect, test, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/loader";
const FRAMES = [0.2, 0.6, 1.0, 1.4, 1.8, 2.1];
const width = (info: TestInfo) => (info.project.name === "phone" ? 390 : 1440);
const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
/** The contact sheet and the video are review artifacts made with ffmpeg; they run only when shots are asked for. */
const REVIEW = Boolean(process.env.SHOTS_DIR);

async function openFrozen(page: import("@playwright/test").Page, t: number) {
  await page.goto(`/dev/loader?t=${t}`);
  await expect(page.locator('[data-testid="loader-256"] [data-state="frozen"] path').first()).toBeAttached();
}

test.describe("/dev/loader", () => {
  test("renders every loader with a status label and animates live", async ({ page }) => {
    await page.goto("/dev/loader");
    for (const id of ["loader-64", "loader-128", "loader-256", "loader-hero"]) {
      await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.getByTestId(id)).toHaveAttribute("role", "status");
    }
    await expect(page.getByTestId("loader-64")).toHaveText("Loading");
    const path = page.locator('[data-testid="loader-256"] [data-state="live"] path').first();
    await expect(path).toBeAttached();
    const a = await path.getAttribute("d");
    await page.waitForTimeout(250);
    expect(await path.getAttribute("d")).not.toBe(a);
  });

  test("frozen frames and the contact sheet", async ({ page }, info) => {
    test.setTimeout(60_000);
    const dir = path.join(SHOTS, "frames");
    mkdirSync(dir, { recursive: true });
    const w = width(info);
    for (const t of FRAMES) {
      await openFrozen(page, t);
      await page.screenshot({ path: path.join(SHOTS, `loader-${w}-t${t.toFixed(1)}.png`), fullPage: true });
      if (w === 1440) {
        await page.getByTestId("loader-256").screenshot({ path: path.join(dir, `ink-${t.toFixed(1)}.png`) });
        await page.getByTestId("loader-hero").screenshot({ path: path.join(dir, `hero-${t.toFixed(1)}.png`) });
      }
    }
    if (w !== 1440 || !REVIEW) return;
    const inputs = FRAMES.flatMap((t) => ["-i", path.join(dir, `ink-${t.toFixed(1)}.png`)]).concat(
      FRAMES.flatMap((t) => ["-i", path.join(dir, `hero-${t.toFixed(1)}.png`)]),
    );
    const n = FRAMES.length;
    const row = (from: number) => FRAMES.map((_, i) => `[${from + i}:v]`).join("");
    ffmpeg([
      ...inputs,
      "-filter_complex",
      `${row(0)}hstack=inputs=${n}[a];${row(n)}hstack=inputs=${n}[b];[a][b]vstack=inputs=2`,
      "-frames:v",
      "1",
      path.join(SHOTS, "loader-contact.png"),
    ]);
  });

  test("two loops at 256 px as MP4 and GIF", async ({ page }, info) => {
    test.skip(width(info) !== 1440, "recorded once, on desktop");
    test.skip(!REVIEW, "review artifact: set SHOTS_DIR to record the video (needs ffmpeg)");
    test.setTimeout(180_000);
    const dir = path.join(SHOTS, "video");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const fps = 30;
    const count = Math.round(2 * 2.4 * fps);
    for (let i = 0; i < count; i++) {
      await openFrozen(page, i / fps);
      await page.getByTestId("loader-256").screenshot({ path: path.join(dir, `f${String(i).padStart(3, "0")}.png`) });
    }
    const input = ["-framerate", String(fps), "-i", path.join(dir, "f%03d.png")];
    ffmpeg([...input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", path.join(SHOTS, "loader.mp4")]);
    ffmpeg([
      ...input,
      "-filter_complex",
      "[0:v]split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=none",
      "-loop",
      "0",
      path.join(SHOTS, "loader.gif"),
    ]);
  });

  test("shows the still mark under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/dev/loader");
    const host = page.locator('[data-testid="loader-256"] [data-state="still"]');
    await expect(host).toBeAttached();
    const d = await host.locator("path").first().getAttribute("d");
    expect(d).toMatch(/^M/);
    await page.waitForTimeout(250);
    expect(await host.locator("path").first().getAttribute("d")).toBe(d);
    await page.screenshot({ path: path.join(SHOTS, `loader-reduced-${page.viewportSize()?.width}.png`) });
  });
});
