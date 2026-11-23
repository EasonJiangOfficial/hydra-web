import { expect, test, type Locator, type Page } from "@playwright/test";

/*
 * The orb rebuild (owner, 2026-11-22: "the orb should interact and behave a different way for when it's pending, vs
 * when it's talking, vs when it's listening to me"; "I should be able to drag the orb and that automatically detaches
 * it"). The /dev/agent orb lab shows each look at 240 and 96 px with a demo voice; orb-math tests the curves. Here:
 * every look renders, moves, and differs from the others; reduced motion holds still; a drag inside Hydra Desktop
 * detaches and a click still taps.
 */

const LOOKS = ["asleep", "listening", "thinking", "speaking", "woke"] as const;

/** The big lab orb's pixels as one string (motion check) and its ink: alpha-weighted coverage and reach. */
const snap = (c: Locator) => c.evaluate((el: HTMLCanvasElement) => el.toDataURL());
const ink = (c: Locator) =>
  c.evaluate((el: HTMLCanvasElement) => {
    const d = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
    let sum = 0;
    let reach = 0;
    for (let y = 0; y < el.height; y++)
      for (let x = 0; x < el.width; x++) {
        const a = d[(y * el.width + x) * 4 + 3];
        if (!a) continue;
        sum += a / 255;
        if (a > 40) reach = Math.max(reach, Math.hypot(x - el.width / 2, y - el.height / 2) / (el.width / 2));
      }
    return { sum, reach };
  });

async function lab(page: Page) {
  await page.goto("/dev/agent");
  const root = page.getByTestId("orb-lab");
  await root.scrollIntoViewIfNeeded();
  return { root, big: root.locator("canvas").first(), small: root.locator("canvas").nth(1) };
}

test("the orb lab shows every look at 240 and 96 px, each moving and each its own", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { root, big, small } = await lab(page);
  await expect(big).toHaveAttribute("width", /\d+/);
  expect((await big.boundingBox())!.width).toBe(240);
  expect((await small.boundingBox())!.width).toBe(96);
  const seen: Record<string, { sum: number; reach: number }> = {};
  for (const look of LOOKS) {
    await root.getByTestId(`lab-${look}`).click();
    await expect(root).toHaveAttribute("data-look", look);
    await expect(big).toHaveAttribute("data-status", look === "woke" ? "listening" : look);
    await expect(small).toHaveAttribute("data-status", look === "woke" ? "listening" : look);
    if (look === "woke") await expect(big).toHaveAttribute("data-woke", /^\d+$/);
    // Past the 250 ms blend; pending past the 0.6 s wait for its pulse.
    await page.waitForTimeout(look === "thinking" ? 900 : 400);
    const a = await snap(big);
    await page.waitForTimeout(300);
    expect(await snap(big), `${look} moves`).not.toBe(a);
    seen[look] = await ink(big);
    expect(seen[look].sum, `${look} renders`).toBeGreaterThan(100);
  }
  // Asleep is the faintest and the smallest; every awake look carries more ink than it.
  for (const look of ["listening", "thinking", "speaking"]) expect(seen.asleep.sum).toBeLessThan(seen[look].sum * 0.7);
  for (const look of ["listening", "thinking", "speaking"]) expect(seen.asleep.reach).toBeLessThan(seen[look].reach);
  expect(errors).toEqual([]);
});

test("hover leans the orb toward the pointer, a press ripples, and an asleep orb runs smooth while touched", async ({ page }) => {
  const { root, big } = await lab(page);
  await root.getByTestId("lab-asleep").click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  const box = (await big.boundingBox())!;
  const rest = await ink(big);
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.4, { steps: 4 });
  await page.waitForTimeout(400);
  const hovered = await snap(big);
  // Pointer over it: the near dots grow and darken, so the orb carries more ink.
  expect((await ink(big)).sum).toBeGreaterThan(rest.sum * 1.02);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect(await snap(big)).not.toBe(hovered);
});

test("reduced motion: each look holds still and differs only in alpha", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { root, big } = await lab(page);
  const sums: Record<string, number> = {};
  for (const look of ["asleep", "thinking", "listening", "speaking"] as const) {
    await root.getByTestId(`lab-${look}`).click();
    await page.waitForTimeout(400);
    const a = await snap(big);
    await page.waitForTimeout(300);
    expect(await snap(big), `${look} holds still`).toBe(a);
    const { sum, reach } = await ink(big);
    sums[look] = sum;
    expect(reach).toBeLessThan(0.8); // the plain shell: 0.76 of the half width, no swell
  }
  expect(sums.asleep).toBeLessThan(sums.thinking);
  expect(sums.thinking).toBeLessThan(sums.listening);
  expect(sums.listening).toBeLessThan(sums.speaking);
});

test("inside Hydra Desktop (build 4): a click on the orb is its listen, a drag detaches under the cursor", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the sidebar orb is the Mac window's");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/dev/agent?desktop=build4");
  const orb = page.locator('[data-testid="agent-orb"]:visible');
  await expect(orb).toHaveAttribute("data-status", "listening");
  const calls = () => page.evaluate(() => (window as unknown as { __bridge: { calls: string[] } }).__bridge.calls.filter((c) => c !== "setup"));
  await orb.click();
  await expect.poll(calls).toEqual(["listen"]);
  // A wobble under 6 px is still a click.
  const b = (await orb.boundingBox())!;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 3, cy + 2, { steps: 3 });
  await page.mouse.up();
  await expect.poll(calls).toEqual(["listen", "listen"]);
  // A drag past 6 px: the desktop orb comes out at the pointer's screen point; this one goes.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy - 40, { steps: 6 });
  await expect.poll(async () => (await calls()).slice(2)).toEqual([expect.stringMatching(/^detach:-?\d+,-?\d+$/)]);
  await page.mouse.up();
  await expect(page.getByTestId("agent-attach")).toBeVisible();
  await expect(page.locator('[data-testid="agent-orb"]:visible')).toHaveCount(0);
  expect((await calls()).filter((c) => c === "listen")).toHaveLength(2); // the drag's release was no tap
  expect(errors).toEqual([]);
});
