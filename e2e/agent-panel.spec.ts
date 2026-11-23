import { expect, test, type Page, type TestInfo } from "@playwright/test";

/*
 * The Hydra Agent panel on /dev/agent: the conversation on assistant-ui, the working line, steps, the one orb that
 * flies between the sidebar (or the phone pill) and the panel header, and the orb options menu. Panel states come
 * from the fixture's presets (src/app/dev/agent/panel-presets.ts). Hydra's voice is a silent stand-in.
 */

function shot(info: TestInfo, name: string) {
  return process.env.SHOTS_DIR ? `${process.env.SHOTS_DIR}/${info.project.name}-${name}` : info.outputPath(name);
}
const phone = (info: TestInfo) => info.project.name.startsWith("phone");

const SILENT = `
  (() => {
    class Rec { constructor() { window.__rec = this; } start() { this.on = true; } stop() { this.on = false; } abort() { this.on = false; } }
    window.SpeechRecognition = Rec;
    window.webkitSpeechRecognition = Rec;
    const synth = {
      speaking: false, pending: false, paused: false, getVoices: () => [],
      speak(u) { if (!String(u.text || "").trim()) { setTimeout(() => u.dispatchEvent(new Event("end")), 0); return; } /* the silent iPhone unlock (Speaker.unlock): instant, not speech */ this.speaking = true; this.u = u; setTimeout(() => u.dispatchEvent(new Event("start")), 0);
        this.t = setTimeout(() => { this.speaking = false; u.dispatchEvent(new Event("end")); }, Math.min(4000, 600 + 25 * String(u.text || "").length)); },
      cancel() { clearTimeout(this.t); if (this.speaking && this.u) { this.speaking = false; this.u.dispatchEvent(new Event("end")); } },
      pause() { this.paused = true; }, resume() { this.paused = false; }, addEventListener() {}, removeEventListener() {},
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  })();
`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(SILENT);
});

const orbs = (page: Page) => page.locator('[data-testid="agent-orb"]:visible');
const panel = (page: Page) => page.getByTestId("agent-panel");

async function open(page: Page, path = "/dev/agent") {
  await page.goto(path);
  await expect(orbs(page)).toHaveCount(1);
  await page.waitForLoadState("networkidle");
}

async function expand(page: Page, info: TestInfo) {
  if (phone(info)) await page.getByTestId("agent-status-phone").click();
  else await page.getByRole("button", { name: "Open the thread" }).click();
  await expect(panel(page)).toBeVisible();
}

async function preset(page: Page, name: string) {
  await open(page, `/dev/agent?panel=${name}`);
  await expect.poll(() => page.evaluate((n) => (window as unknown as { __agentPreset?: (n: string) => boolean }).__agentPreset?.(n) ?? false, name)).toBe(true);
  await expect(panel(page)).toBeVisible();
  await page.waitForTimeout(500); // the slide and the flight
}

test("every panel state: thinking, checking with steps, filler, streaming, answered, confirm, error, wake phrase", async ({ page }, info) => {
  test.setTimeout(90_000);

  await preset(page, "thinking");
  await expect(panel(page).getByTestId("agent-working")).toHaveAttribute("data-phase", "thinking");
  await expect(panel(page).getByRole("status", { name: "Thinking" })).toBeVisible();
  await page.screenshot({ path: shot(info, "thinking.png") });

  await preset(page, "checking");
  const steps = panel(page).getByTestId("agent-step");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(1)).toHaveAttribute("data-status", "running");
  await expect(panel(page).getByTestId("agent-working")).toHaveAttribute("data-phase", "checking");
  await expect(panel(page).getByTestId("agent-filler")).toHaveText("Let me check that.");
  await page.screenshot({ path: shot(info, "checking.png") });
  // A step line opens to its whole text and tool.
  await steps.nth(1).getByRole("button").click();
  await expect(steps.nth(1).getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(steps.nth(1)).toContainText("ugc_earnings");

  await preset(page, "filler");
  await expect(panel(page).getByTestId("agent-filler")).toHaveText("Let me see.");
  await page.screenshot({ path: shot(info, "filler.png") });

  await preset(page, "streaming");
  await expect(panel(page).locator('[data-role="hydra"]')).toContainText("You've earned $3,525");
  await expect(panel(page).getByTestId("agent-working")).toHaveCount(0);
  // The narration is a step, never glued to the answer.
  await expect(panel(page).locator('[data-role="hydra"] p')).not.toContainText("2026-11-22");
  await page.screenshot({ path: shot(info, "streaming.png") });

  await preset(page, "answered");
  await expect(panel(page).getByTestId("agent-thread")).toContainText("Goodnight, sir.");
  await expect(panel(page).getByTestId("agent-thread")).not.toContainText("[wave]");
  await page.screenshot({ path: shot(info, "answered.png") });

  await preset(page, "confirm");
  const confirm = panel(page).getByTestId("agent-confirm");
  await expect(confirm.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Decline" })).toBeVisible();
  await page.screenshot({ path: shot(info, "confirm.png") });

  await preset(page, "error");
  await expect(panel(page).getByTestId("agent-error")).toHaveText("Could not reach Hydra");
  await page.screenshot({ path: shot(info, "error.png") });

  // A brain failure says itself once, in the header, with its info dot.
  await preset(page, "offline");
  await expect(panel(page).getByTestId("agent-panel-status")).toHaveText("Hydra is offline.");
  await expect(panel(page).getByTestId("agent-error")).toHaveCount(0);
  await page.screenshot({ path: shot(info, "offline.png") });

  await preset(page, "wake");
  await expect(panel(page).getByTestId("agent-panel-status")).toHaveText("Say “Hey Hydra”");
  await page.screenshot({ path: shot(info, "wake-panel.png") });
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  const word = phone(info) ? page.getByTestId("agent-status-phone") : page.getByTestId("agent-status");
  await expect(word).toHaveText("Say “Hey Hydra”");
  await page.waitForTimeout(450);
  await page.screenshot({ path: shot(info, "wake-card.png") });
});

test("one orb: opening the panel flies it into the header and the card folds; closing flies it back", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => ((window as unknown as { __agentOrbSlowMo: number }).__agentOrbSlowMo = 8));
  await open(page);
  const start = (await orbs(page).boundingBox())!;
  await expand(page, info);
  await page.waitForTimeout(1400); // half of the slowed 2.9 s flight
  await expect(orbs(page)).toHaveCount(1);
  const mid = (await orbs(page).boundingBox())!;
  await page.screenshot({ path: shot(info, "orb-mid-flight-open.png") });
  await page.waitForTimeout(2000);
  await expect(orbs(page)).toHaveCount(1);
  const end = (await orbs(page).boundingBox())!;
  // Mid-flight it is between the two spots; it lands inside the panel's header.
  expect(Math.abs(mid.x - start.x) + Math.abs(mid.y - start.y)).toBeGreaterThan(20);
  expect(Math.abs(mid.x - end.x) + Math.abs(mid.y - end.y)).toBeGreaterThan(20);
  const box = (await panel(page).boundingBox())!;
  expect(end.width).toBe(48);
  expect(end.x).toBeGreaterThan(box.x);
  expect(end.y - box.y).toBeLessThan(40);
  if (phone(info)) {
    await expect(page.getByTestId("agent-float")).toHaveCSS("opacity", "0");
  } else {
    await expect(page.getByTestId("agent-card").getByRole("button", { name: "Open the thread" })).toBeHidden();
    await expect(page.getByTestId("agent-status")).toBeHidden();
  }
  await page.screenshot({ path: shot(info, "orb-landed-open.png") });

  await panel(page).getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(1400);
  await expect(orbs(page)).toHaveCount(1);
  await page.screenshot({ path: shot(info, "orb-mid-flight-close.png") });
  await page.waitForTimeout(2200);
  const back = (await orbs(page).boundingBox())!;
  expect(Math.round(back.x)).toBe(Math.round(start.x));
  expect(Math.round(back.y)).toBe(Math.round(start.y));
  expect(back.width).toBe(start.width);
  if (!phone(info)) await expect(page.getByTestId("agent-card").getByRole("button", { name: "Open the thread" })).toBeVisible();
});

test("one orb also with the sidebar collapsed", async ({ page }, info) => {
  test.skip(phone(info), "desktop sidebar only");
  await open(page);
  await page.keyboard.press("[");
  await expect.poll(async () => (await page.getByTestId("sidebar").boundingBox())?.width).toBe(64);
  await page.waitForTimeout(400);
  // Collapsed, the card is the orb alone: open the panel the way a confirm does.
  await page.evaluate(() => (window as unknown as { __agentPreset(n: string): boolean }).__agentPreset("answered"));
  await page.waitForTimeout(500);
  await expect(orbs(page)).toHaveCount(1);
  await page.screenshot({ path: shot(info, "collapsed-open.png") });
});

test("reduced motion: no flight, the orb fades in where it lands, still one orb", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await expand(page, info);
  await page.waitForTimeout(80);
  await expect(orbs(page)).toHaveCount(1);
  await page.waitForTimeout(400);
  const end = (await orbs(page).boundingBox())!;
  const box = (await panel(page).boundingBox())!;
  expect(end.y - box.y).toBeLessThan(40);
});

test("the orb options menu: sleep word (shared PATCH), mute; the panel body has no sleep word field", async ({ page }, info) => {
  await open(page);
  await page.evaluate(() => {
    const w = window as unknown as { __patches: unknown[]; fetch: typeof fetch };
    w.__patches = [];
    const inner = w.fetch;
    w.fetch = (input, init) => {
      if (init?.method === "PATCH") w.__patches.push([String(input), JSON.parse(String(init.body))]);
      return inner(input, init);
    };
  });
  await expand(page, info);
  await expect(panel(page).getByTestId("agent-sleep-word")).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Hydra options" }).click();
  const menu = page.getByTestId("agent-orb-options");
  await expect(menu).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: shot(info, "orb-menu.png") });
  const field = menu.getByTestId("agent-sleep-word");
  await field.fill("Hydra, good night");
  await field.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __patches: unknown[] }).__patches)).toContainEqual(["/api/agent/state", { sleepWord: "Hydra, good night" }]);
  const mute = menu.getByRole("switch", { name: "Mute" });
  await expect(mute).toHaveAttribute("aria-checked", "false");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-checked", "true");
  await expect(panel(page).getByRole("button", { name: "Unmute Hydra" })).toBeVisible();
  await expect(menu.getByTestId("agent-menu-detach")).toHaveCount(0); // not in Hydra Desktop
});

test("in Hydra Desktop the menu detaches and attaches", async ({ page }, info) => {
  test.skip(phone(info), "the bridge lives in the Mac window");
  await open(page, "/dev/agent?desktop=asleep");
  await expand(page, info);
  await panel(page).getByRole("button", { name: "Hydra options" }).click();
  const item = page.getByTestId("agent-menu-detach");
  await expect(item).toHaveText("Detach");
  await page.waitForTimeout(200);
  await page.screenshot({ path: shot(info, "orb-menu-desktop.png") });
  await item.click();
  await expect(page.getByTestId("agent-attach")).toBeVisible();
  // F10: detached, the orb floats on the Mac: no orb in the window at all, not even in the panel header.
  await expect(orbs(page)).toHaveCount(0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot(info, "panel-detached.png") });
  await panel(page).getByRole("button", { name: "Hydra options" }).click();
  await expect(page.getByTestId("agent-menu-detach")).toHaveText("Attach");
  await page.getByTestId("agent-menu-detach").click();
  await expect(orbs(page)).toHaveCount(1); // attached again: the one orb is back in the header
  const calls = await page.evaluate(() => (window as unknown as { __bridge: { calls: string[] } }).__bridge.calls.filter((c) => c !== "setup"));
  expect(calls).toEqual(["detach", "attach"]);
});

test("the composer sends a typed turn through assistant-ui and the answer streams in", async ({ page }, info) => {
  await open(page);
  await expand(page, info);
  const input = panel(page).getByLabel("Message Hydra");
  await input.fill("What did I earn?");
  await input.press("Enter");
  await expect(panel(page).getByTestId("agent-thread").locator('[data-role="user"]')).toHaveText("What did I earn?");
  await expect(panel(page).getByTestId("agent-thread")).toContainText("this week across 14 videos.", { timeout: 10_000 });
  await expect(input).toHaveValue("");
  await page.screenshot({ path: shot(info, "typed-turn.png") });
});
