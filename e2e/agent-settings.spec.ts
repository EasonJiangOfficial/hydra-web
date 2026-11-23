import { expect, test, type Page, type TestInfo } from "@playwright/test";

/*
 * AGENT-FEEL-2 on /dev/agent (the scripted mock stands in for the server):
 * - the orb in the panel header opens Hydra's options (wake phrase, sleep word, model, effort, clap sensitivity,
 *   mute); every edit happens inside the menu and is saved through PATCH /api/agent/state; the big orb keeps its
 *   tap map (asleep wakes, listening turns off);
 * - words said or typed while Hydra thinks are added to that turn (POST /api/agent/turn/append), never a new turn;
 *   the sleep word while it thinks cancels and sleeps;
 * - the orb's voice: speaking erupts in one patch of swollen dots, listening in a quiet room stays calm.
 * Owner's words: "the sleep word should be moved into some settings thing and hidden"; "dont cancel but add onto the
 * prompt"; "the visualizer needs to be more unique with unique spikes depending on frequencies".
 */

const phone = (info: TestInfo) => info.project.name === "phone";
const shot = (info: TestInfo, name: string) =>
  process.env.SHOTS_DIR ? `${process.env.SHOTS_DIR}/${phone(info) ? 390 : 1440}-${name}.png` : info.outputPath(`${name}.png`);

const FAKES = `
  (() => {
    class Rec { constructor() { window.__rec = this; } start() { this.on = true; } stop() { this.on = false; } abort() { this.on = false; } }
    window.SpeechRecognition = Rec; window.webkitSpeechRecognition = Rec;
    window.__say = (t) => {
      const r = window.__rec;
      if (!r || !r.on) return false;
      r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] });
      return true;
    };
    const synth = {
      speaking: false, pending: false, paused: false, getVoices: () => [],
      speak(u) { if (!String(u.text || "").trim()) { setTimeout(() => u.dispatchEvent(new Event("end")), 0); return; } this.speaking = true; this.u = u;
        setTimeout(() => u.dispatchEvent(new Event("start")), 0);
        this.t = setTimeout(() => { this.speaking = false; u.dispatchEvent(new Event("end")); }, 2500 + 40 * String(u.text || "").length); },
      cancel() { clearTimeout(this.t); if (this.speaking && this.u) { this.speaking = false; this.u.dispatchEvent(new Event("end")); } },
      pause() { this.paused = true; }, resume() { this.paused = false; }, addEventListener() {}, removeEventListener() {},
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  })();
`;

type Win = { __patches: unknown[]; __turns?: unknown[]; __added?: { turnId: string; text: string }[]; __agentMockGap?: number; __say(t: string): boolean };
const orb = (page: Page) => page.locator('[data-testid="agent-orb"]:visible');
const panel = (page: Page) => page.getByTestId("agent-panel");
const menu = (page: Page) => page.getByTestId("agent-orb-options");
const status = (page: Page) => page.getByTestId("agent-panel-status");
const patches = (page: Page) => page.evaluate(() => (window as unknown as Win).__patches);
const recOn = (page: Page) => page.evaluate(() => !!(window as unknown as { __rec?: { on?: boolean } }).__rec?.on);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(FAKES);
});

async function open(page: Page) {
  await page.goto("/dev/agent");
  await expect(orb(page)).toHaveCount(1);
  await page.waitForLoadState("networkidle");
  // Record what the client sends to the shared settings (around the fixture's mock, which answers it).
  await page.evaluate(() => {
    const w = window as unknown as { __patches: unknown[]; fetch: typeof fetch };
    w.__patches = [];
    const inner = w.fetch;
    w.fetch = (input, init) => {
      if (init?.method === "PATCH") w.__patches.push([String(input), JSON.parse(String(init.body))]);
      return inner(input, init);
    };
  });
}
async function expand(page: Page, info: TestInfo) {
  if (phone(info)) await page.getByTestId("agent-status-phone").click();
  else await page.getByRole("button", { name: "Open the thread" }).click();
  await expect(panel(page)).toBeVisible();
  await page.waitForTimeout(600); // the slide and the orb's flight
}

test("the header orb opens Hydra's options; edits stay inside and are saved; the big orb keeps its tap map", async ({ page }, info) => {
  await open(page);
  // The big orb (sidebar card, phone pill): asleep wakes, listening turns off.
  await orb(page).click();
  await expect.poll(() => recOn(page)).toBe(true);
  await orb(page).click();
  await expect.poll(() => recOn(page)).toBe(false);

  // Listening, the header orb keeps the tap map (on an iPhone with the sheet open it is the only orb): it turns off.
  await orb(page).click();
  await expect.poll(() => recOn(page)).toBe(true);
  await expand(page, info);
  await expect(status(page)).toHaveText("Listening");
  const header = orb(page);
  await expect(header).toHaveAttribute("aria-label", "Talk to Hydra");
  await header.click();
  await expect.poll(() => recOn(page)).toBe(false);
  await expect(status(page)).toHaveText("Asleep");
  await expect(menu(page)).toBeHidden();

  await expect(panel(page).getByTestId("agent-sleep-word")).toHaveCount(0); // hidden in the options, not the panel
  await expect(header).toHaveAttribute("aria-label", "Hydra options");
  await header.click();
  await expect(menu(page)).toBeVisible();
  await expect(status(page)).toHaveText("Asleep"); // the header orb did not wake it
  await expect(menu(page).getByTestId("agent-wake-phrase")).toHaveValue("Hey Hydra");
  await expect(menu(page).getByRole("radio", { name: "Opus 5.5" })).toHaveAttribute("aria-checked", "true");
  await expect(menu(page).getByRole("radiogroup", { name: "Effort" }).getByRole("radio", { name: "Low" })).toHaveAttribute("aria-checked", "true");
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot(info, "01-menu-open") });

  // Inline edits: the menu never closes.
  const wake = menu(page).getByTestId("agent-wake-phrase");
  await wake.fill("Okay Hydra");
  await wake.press("Enter");
  await expect.poll(() => patches(page)).toContainEqual(["/api/agent/state", { wakePhrase: "Okay Hydra" }]);
  await menu(page).getByRole("radio", { name: "Sonnet 5.5" }).click();
  await expect.poll(() => patches(page)).toContainEqual(["/api/agent/state", { model: "claude-sonnet-5-5" }]);
  await menu(page).getByRole("radiogroup", { name: "Effort" }).getByRole("radio", { name: "High", exact: true }).click();
  await expect.poll(() => patches(page)).toContainEqual(["/api/agent/state", { effortLive: "high" }]);
  await menu(page).getByRole("radiogroup", { name: "Clap sensitivity" }).getByRole("radio", { name: "Low" }).click();
  await expect.poll(() => patches(page)).toContainEqual(["/api/agent/state", { clapSensitivity: "low" }]);
  const sleep = menu(page).getByTestId("agent-sleep-word");
  await sleep.fill("Hydra, good night");
  await sleep.press("Enter");
  await expect.poll(() => patches(page)).toContainEqual(["/api/agent/state", { sleepWord: "Hydra, good night" }]);
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("radio", { name: "Sonnet 5.5" })).toHaveAttribute("aria-checked", "true");

  // Clap sensitivity says on hover (or tap on the phone) that it is Hydra Desktop's.
  const dot = menu(page).getByRole("button", { name: "About clap sensitivity" });
  if (phone(info)) await dot.tap();
  else await dot.hover();
  await expect(page.getByText("Applies to Hydra Desktop", { exact: false }).first()).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: shot(info, "02-menu-edited-clap-info") });

  // The header orb closes it again; reopened, the saved values show.
  await page.mouse.move(5, 5);
  await header.click();
  await expect(menu(page)).toBeHidden();
  await header.click();
  await expect(menu(page).getByTestId("agent-wake-phrase")).toHaveValue("Okay Hydra");
  await expect(menu(page).getByTestId("agent-sleep-word")).toHaveValue("Hydra, good night");
  // In a field with an unsaved edit, the first Escape only undoes it; the next one closes the menu.
  const sent = (await patches(page)).length;
  const wake2 = menu(page).getByTestId("agent-wake-phrase");
  await wake2.fill("Yo Hydra");
  await wake2.press("Escape");
  await expect(menu(page)).toBeVisible();
  await expect(wake2).toHaveValue("Okay Hydra");
  await wake2.press("Escape");
  await expect(menu(page)).toBeHidden();
  expect((await patches(page)).length).toBe(sent); // the undone edit was never saved
  await header.click();
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(panel(page)).toBeVisible();
});

test("words while Hydra thinks are added to the turn (no new turn); the sleep word while thinking sleeps", async ({ page }, info) => {
  test.setTimeout(60_000);
  await open(page);
  await orb(page).click(); // wake (the big orb)
  await expect.poll(() => recOn(page)).toBe(true);
  await expand(page, info);
  // Muted: no filler or answer voice, so the recognizer stays on through the turn on iOS too (it cannot listen over audio).
  await panel(page).getByRole("button", { name: "Mute Hydra" }).click();
  await page.evaluate(() => void ((window as unknown as Win).__agentMockGap = 1200));

  expect(await page.evaluate(() => (window as unknown as Win).__say("what did I earn this week"))).toBe(true);
  await expect(status(page)).toHaveText("Thinking");
  await expect(panel(page).getByText("Adding up pay per video")).toBeVisible({ timeout: 10_000 });
  // Still listening while it thinks: his words join the turn.
  expect(await page.evaluate(() => (window as unknown as Win).__say("Hey Hydra, and last week too"))).toBe(true);
  const line = panel(page).getByTestId("agent-added-line");
  await expect(line).toHaveText(/and last week too/);
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__added?.length ?? 0)).toBe(1);
  const added = await page.evaluate(() => (window as unknown as Win).__added![0]);
  expect(added.text).toBe("and last week too"); // the wake phrase is not part of it
  expect(added.turnId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await page.evaluate(() => (window as unknown as Win).__turns?.length)).toBe(1); // nothing cancelled, no new turn
  await page.screenshot({ path: shot(info, "03-added-line-thinking") });

  // Typed words while it still thinks are added too.
  const input = panel(page).getByLabel("Message Hydra");
  await input.fill("and the gas ones");
  await input.press("Enter");
  await expect(line).toHaveCount(2);
  await expect(panel(page)).toContainText("Also and last week too, and the gas ones: noted.", { timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as Win).__turns?.length)).toBe(1);
  await page.screenshot({ path: shot(info, "04-added-lines-answered") });

  // A new turn, and the sleep word while it thinks: it stops and sleeps.
  await expect(status(page)).toHaveText("Listening", { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__say("what did I earn today"))).toBe(true);
  await expect(status(page)).toHaveText("Thinking");
  expect(await page.evaluate(() => (window as unknown as Win).__say("Hydra, sleep"))).toBe(true);
  await expect(status(page)).toHaveText("Asleep");
  expect(await page.evaluate(() => (window as unknown as Win).__added?.length)).toBe(2);
});

/**
 * The orb's swollen dots: pixels at full ink (alpha 240 and up). The calm dust's dots are too small to cover a pixel
 * fully, so a quiet orb has almost none; the voice's patch swells its dots up to twice their size, and each swollen
 * dot has a solid core.
 */
async function swollen(page: Page) {
  return orb(page).locator("canvas").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] >= 240) n++;
    return n;
  });
}

test("the orb's voice: speaking erupts in one patch; listening in a quiet room stays calm", async ({ page }, info) => {
  test.setTimeout(60_000);
  await open(page);
  await orb(page).click();
  await expect.poll(() => recOn(page)).toBe(true);
  await page.waitForTimeout(400);
  const calm = await swollen(page);
  await orb(page).screenshot({ path: shot(info, "05-orb-listening-calm") });

  expect(await page.evaluate(() => (window as unknown as Win).__say("what did I earn this week"))).toBe(true);
  await expect(orb(page)).toHaveAttribute("data-status", "speaking", { timeout: 15_000 });
  await page.waitForTimeout(500);
  const talk: number[] = [];
  for (let i = 0; i < 6; i++) {
    talk.push(await swollen(page));
    await page.waitForTimeout(90);
  }
  await orb(page).screenshot({ path: shot(info, "06-orb-speaking-erupts") });
  await page.screenshot({ path: shot(info, "07-speaking-page") });
  console.log(`[agent-settings] ${info.project.name}: swollen px calm ${calm}, speaking ${talk.join(" ")}`);
  // Speaking erupts: at least three times the calm orb's swollen pixels, and never fewer than 8.
  expect(Math.max(...talk)).toBeGreaterThan(Math.max(8, 3 * calm));
});
