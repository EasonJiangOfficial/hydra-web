import { expect, test, type Page, type TestInfo } from "@playwright/test";

/*
 * One whole conversation on /dev/agent, voice and panel together: wake, open the panel (the orb flies), ask, a filler
 * in Hydra's voice while a step shows, the answer streams and is spoken, the owner talks over it (a fake mic level on
 * desktop; a tap on iOS, which cannot keep the mic open over audio), Hydra stops and answers the interruption, Stop,
 * a tap while listening turns it off, and the panel closes with the orb flying back.
 * Hydra's voice is a silent speechSynthesis stand-in (the mock's /api/voice/tts is 503, so the browser voice runs).
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
      speak(u) { if (!String(u.text || "").trim()) { setTimeout(() => u.dispatchEvent(new Event("end")), 0); return; } /* the silent iPhone unlock (Speaker.unlock): instant, not speech */ this.speaking = true; this.u = u; (window.__spoken ??= []).push(String(u.text || ""));
        setTimeout(() => u.dispatchEvent(new Event("start")), 0);
        this.t = setTimeout(() => { this.speaking = false; u.dispatchEvent(new Event("end")); }, 900 + 30 * String(u.text || "").length); },
      cancel() { clearTimeout(this.t); if (this.speaking && this.u) { this.speaking = false; this.u.dispatchEvent(new Event("end")); } },
      pause() { this.paused = true; }, resume() { this.paused = false; }, addEventListener() {}, removeEventListener() {},
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    // The owner's microphone: a silent stream whose meter reads window.__micLevel (0..1).
    window.__micLevel = 0;
    // On the prototype: WebKit has no navigator.mediaDevices yet when an init script runs.
    if (window.MediaDevices) MediaDevices.prototype.getUserMedia = async () => {
      const c = new (window.AudioContext || window.webkitAudioContext)();
      const s = c.createMediaStreamDestination().stream; s.__fake = true; return s;
    };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (to, ...rest) {
      if (this.mediaStream && this.mediaStream.__fake) to.__mic = true;
      return connect.call(this, to, ...rest);
    };
    const read = AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData = function (buf) { if (this.__mic) { buf.fill(window.__micLevel / 5); return; } return read.call(this, buf); };
  })();
`;

type Win = { __spoken?: string[]; __turns?: { text?: string; interruptedAfter?: string }[]; __agentMockGap?: number; __micLevel: number; __say(t: string): boolean };
const spoken = (page: Page) => page.evaluate(() => (window as unknown as Win).__spoken ?? []);
const speaking = (page: Page) => page.evaluate(() => window.speechSynthesis.speaking);
const orb = (page: Page) => page.locator('[data-testid="agent-orb"]:visible');
const panel = (page: Page) => page.getByTestId("agent-panel");
const status = (page: Page) => page.getByTestId("agent-panel-status");
const FILLERS = ["Let me check.", "One sec.", "Let me see.", "Checking that now.", "Give me a second.", "Let me look.", "Hang on.", "Just a moment.", "Let me pull that up."];
const ANSWER = "You've earned $3,525 this week across 14 videos.";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(FAKES);
  await page.addInitScript(() => ((window as unknown as { __agentOrbSlowMo: number }).__agentOrbSlowMo = 6));
});

test("a whole conversation: wake, filler, step, spoken answer, barge-in, Stop, tap off, orb flight", async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.goto("/dev/agent");
  await expect(orb(page)).toHaveCount(1);
  await page.waitForLoadState("networkidle");

  // Wake.
  await orb(page).click();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __rec?: { on?: boolean } }).__rec?.on)).toBe(true);
  await page.screenshot({ path: shot(info, "01-wake-listening") });

  // Open the panel: one orb flies into its header.
  if (phone(info)) await page.getByTestId("agent-status-phone").click();
  else await page.getByRole("button", { name: "Open the thread" }).click();
  await expect(panel(page)).toBeVisible();
  await page.waitForTimeout(900);
  await expect(orb(page)).toHaveCount(1);
  await page.screenshot({ path: shot(info, "02-panel-orb-mid-flight") });
  await page.waitForTimeout(1600);
  await expect(status(page)).toHaveText("Listening");
  await page.screenshot({ path: shot(info, "03-panel-open-listening") });

  // Ask. A slow brain: the tool step holds on screen while the filler is spoken.
  await page.evaluate(() => void ((window as unknown as Win).__agentMockGap = 1500));
  expect(await page.evaluate(() => (window as unknown as Win).__say("what did I earn this week"))).toBe(true);
  await expect(panel(page).getByText("Adding up pay per video")).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => spoken(page).then((s) => s.length), { timeout: 5000 }).toBeGreaterThan(0);
  const filler = (await spoken(page))[0];
  expect(FILLERS).toContain(filler);
  await expect(panel(page).getByText(filler)).toBeVisible(); // the working line's filler
  await page.screenshot({ path: shot(info, "04-filler-and-step") });

  // The answer streams in text, then is spoken; the filler never lands in the thread.
  await expect(panel(page)).toContainText("You've earned $3,525", { timeout: 10_000 });
  await page.screenshot({ path: shot(info, "05-answer-streaming") });
  await expect.poll(() => spoken(page).then((s) => s.at(-1)), { timeout: 10_000 }).toBe(ANSWER);
  await expect(status(page)).toHaveText("Speaking");
  expect(await speaking(page)).toBe(true);
  await page.screenshot({ path: shot(info, "06-answer-spoken") });

  // The owner cuts in mid-sentence.
  await page.waitForTimeout(400); // the mic meter calibrates on the first frames of the sentence
  let stopMs: number;
  if (phone(info)) {
    // iOS: no voice barge-in; a tap on the orb interrupts, the sheet's header orb too (while Hydra speaks or listens
    // it keeps the tap map; asleep it opens Hydra's options).
    expect(await page.evaluate(() => (window as unknown as Win).__say("wait a second"))).toBe(false);
    await expect(orb(page)).toHaveAttribute("aria-label", "Interrupt Hydra");
    // Timed in the page, from the tap's pointerdown to silence (Playwright's own click overhead left out).
    const timing = page.evaluate(
      () =>
        new Promise<number>((done) => {
          document.addEventListener(
            "pointerdown",
            () => {
              const t0 = performance.now();
              const iv = setInterval(() => !window.speechSynthesis.speaking && (clearInterval(iv), done(performance.now() - t0)), 2);
              setTimeout(() => (clearInterval(iv), done(-1)), 3000);
            },
            { capture: true, once: true },
          );
        }),
    );
    await orb(page).click();
    stopMs = await timing;
    await expect(page.getByTestId("agent-orb-options")).toBeHidden(); // it interrupted; no menu
  } else {
    stopMs = await page.evaluate(
      () =>
        new Promise<number>((done) => {
          const w = window as unknown as Win;
          const t0 = performance.now();
          w.__micLevel = 0.6; // the owner's voice, over the floor
          const iv = setInterval(() => {
            // Silent: stopped, or paused (a voice barge-in pauses Hydra until his words come, F11).
            if (!window.speechSynthesis.speaking || window.speechSynthesis.paused) {
              clearInterval(iv);
              done(performance.now() - t0);
            }
          }, 2);
          setTimeout(() => (clearInterval(iv), done(-1)), 3000);
        }),
    );
    await page.evaluate(() => void ((window as unknown as Win).__micLevel = 0));
  }
  console.log(`[agent-feel] ${info.project.name}: Hydra went silent ${Math.round(stopMs)} ms after the owner ${phone(info) ? "tapped" : "started talking"}`);
  expect(stopMs).toBeGreaterThanOrEqual(0);
  // Voice: BARGE_MS (250 ms of voice over the floor) is the detection window; the stop follows within 150 ms of it.
  expect(stopMs).toBeLessThan(phone(info) ? 150 : 250 + 150);
  await expect(status(page)).not.toHaveText("Speaking");
  await page.screenshot({ path: shot(info, "07-barged-in") });

  // Hydra answers the interruption, knowing where it was cut off.
  await page.evaluate(() => void ((window as unknown as Win).__agentMockGap = 90));
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__say("and last week"))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__turns?.length)).toBe(2);
  const turns = await page.evaluate(() => (window as unknown as Win).__turns!);
  expect(turns[1].interruptedAfter).toContain("You've earned");
  await expect(panel(page)).toContainText("I heard you.");
  await expect.poll(() => spoken(page).then((s) => s.includes("I heard you.")), { timeout: 8000 }).toBe(true);
  await expect(panel(page)).not.toContainText(filler);
  await page.screenshot({ path: shot(info, "08-answers-interruption") });

  // Stop while it speaks: silent and asleep.
  await expect(status(page)).toHaveText("Speaking", { timeout: 8000 });
  await panel(page).getByRole("button", { name: "Stop" }).click();
  expect(await speaking(page)).toBe(false);
  await expect(status(page)).toHaveText("Asleep");
  await page.screenshot({ path: shot(info, "09-stopped") });

  // Asleep, the panel header's orb opens Hydra's options (it never wakes Hydra there).
  await page.evaluate(() => void ((window as unknown as { __agentOrbSlowMo: number }).__agentOrbSlowMo = 6));
  await orb(page).click();
  await expect(page.getByTestId("agent-orb-options")).toBeVisible();
  await expect(status(page)).toHaveText("Asleep");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-orb-options")).toBeHidden();

  // Close: the orb flies back.
  await panel(page).getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(900);
  await expect(orb(page)).toHaveCount(1);
  await page.screenshot({ path: shot(info, "11-close-orb-mid-flight") });
  await page.waitForTimeout(1800);
  await expect(panel(page)).toBeHidden();
  await page.screenshot({ path: shot(info, "12-closed") });

  // The big orb keeps its tap map: wake, then a tap while listening turns it off.
  const recOn = () => page.evaluate(() => !!(window as unknown as { __rec?: { on?: boolean } }).__rec?.on);
  await orb(page).click();
  await expect.poll(recOn).toBe(true);
  await orb(page).click();
  await expect.poll(recOn).toBe(false);
  await expect(orb(page)).toHaveAttribute("data-status", "asleep");
  await page.screenshot({ path: shot(info, "10-tap-while-listening-off") });
});
