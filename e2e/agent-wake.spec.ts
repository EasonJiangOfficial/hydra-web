import { expect, test, type Page } from "@playwright/test";
import { DESKTOP_WINDOW, installBridge } from "./helpers/desktop-bridge";

/*
 * The orb's wake look (owner: "when I clap or say hey hydra ... the orb should change texture or color"). Hydra Desktop
 * pushes `woke: {at, from}` on a clap or phrase wake; the real bridge merges and repeats the snapshot, so the web dedupes
 * on `at`. The look is texture only (orb-math tests the curve); here: it reaches the orb once, ends on sleep, never
 * comes from a web wake, and the /dev/agent gallery can replay it.
 */

test.use(DESKTOP_WINDOW);
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "hands-free wake is the Mac app only"));

const orb = (page: Page) => page.locator('[data-testid="agent-orb"]:visible');
const push = (page: Page, m: unknown) => page.evaluate((x) => (window as unknown as { __hydraDesktopPush(m: unknown): void }).__hydraDesktopPush(x), m);

test("a clap wake reaches the orb once, the repeats do not replay it, sleep ends it, a web wake never sets it", async ({ page }) => {
  const errors: string[] = [];
  await installBridge(page, new URL(test.info().project.use.baseURL ?? "").origin, errors);
  await page.goto("/dev/agent");
  await expect(orb(page)).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(orb(page)).not.toHaveAttribute("data-woke");

  const at = await page.evaluate(() => Date.now());
  await push(page, { state: "Listening", woke: { at, from: "clap" } });
  await expect(orb(page)).toHaveAttribute("data-woke", String(at));
  await expect(orb(page).locator("canvas")).toHaveAttribute("data-woke", String(at));
  await push(page, { micLevel: 0.3 }); // the bridge's repeat carries the same woke
  await expect(orb(page)).toHaveAttribute("data-woke", String(at));

  await push(page, { state: "Asleep", micLevel: 0 });
  await expect(orb(page)).not.toHaveAttribute("data-woke");
  await push(page, { micLevel: 0 }); // still the old woke in the merged snapshot
  await expect(orb(page)).not.toHaveAttribute("data-woke");

  await orb(page).click(); // the web asks the Mac to wake: no woke comes back with it
  await push(page, { state: "Listening" });
  await expect(orb(page)).not.toHaveAttribute("data-woke");

  const again = await page.evaluate(() => Date.now());
  await push(page, { woke: { at: again, from: "phrase" } });
  await expect(orb(page)).toHaveAttribute("data-woke", String(again));

  // A stamp ahead of the page clock (skew) plays from now, not from the future: wokeAt is clamped to the page's now.
  await push(page, { state: "Asleep" });
  await expect(orb(page)).not.toHaveAttribute("data-woke");
  const ahead = (await page.evaluate(() => Date.now())) + 4000;
  await push(page, { state: "Listening", woke: { at: ahead, from: "clap" } });
  await expect(orb(page)).toHaveAttribute("data-woke", /^\d+$/);
  const shown = Number(await orb(page).getAttribute("data-woke"));
  expect(shown).toBeGreaterThan(again);
  expect(shown).toBeLessThan(ahead);
  expect(errors).toEqual([]);
});

test("the gallery's Woke demo replays the burst", async ({ page }) => {
  await page.goto("/dev/agent");
  const demo = page.getByTestId("demo-woke");
  await expect(demo.locator("canvas")).not.toHaveAttribute("data-woke");
  await demo.getByTestId("replay-wake").click();
  await expect(demo.locator("canvas")).toHaveAttribute("data-woke", /^\d+$/);
});
