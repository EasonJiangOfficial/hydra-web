import { expect, test, type Page, type TestInfo } from "@playwright/test";

/*
 * The Hydra Agent interface on /dev/agent: the real app shell, the real card and phone orb, over a scripted mock of
 * /api/agent/* and /api/voice/tts in the server's own wire contract (src/app/dev/agent/mock.ts). The same client
 * against the real route handlers is src/components/agent/contract.test.ts. A fake SpeechRecognition stands in for the owner's
 * voice: window.__say("...") is "the owner said it".
 */

function shot(info: TestInfo, name: string) {
  return process.env.SHOTS_DIR ? `${process.env.SHOTS_DIR}/${name}` : info.outputPath(name);
}
const phone = (info: TestInfo) => info.project.name === "phone";
const w = (info: TestInfo) => (phone(info) ? 390 : 1440);

const FAKE_SPEECH = `
  (() => {
    class Rec {
      constructor() { window.__rec = this; }
      start() { this.on = true; }
      stop() { this.on = false; }
      abort() { this.on = false; }
    }
    window.SpeechRecognition = Rec;
    window.webkitSpeechRecognition = Rec;
    // Hydra's voice: a silent stand-in that "speaks" for a time set by the text, so Speaking is a real state on
    // every OS (Linux CI has no voices) and no test ever makes a sound on the Mac.
    const synth = {
      speaking: false, pending: false, paused: false,
      getVoices: () => [],
      speak(u) {
        if (!String(u.text || "").trim()) { setTimeout(() => u.dispatchEvent(new Event("end")), 0); return; } /* the silent iPhone unlock (Speaker.unlock): instant, not speech */
        this.speaking = true; this.u = u;
        (window.__spoken ??= []).push(String(u.text || ""));
        setTimeout(() => u.dispatchEvent(new Event("start")), 0);
        this.t = setTimeout(() => { this.speaking = false; u.dispatchEvent(new Event("end")); }, Math.min(4000, 600 + 25 * String(u.text || "").length));
      },
      cancel() { clearTimeout(this.t); if (this.speaking && this.u) { this.speaking = false; this.u.dispatchEvent(new Event("end")); } },
      pause() { this.paused = true; }, resume() { this.paused = false; },
      addEventListener() {}, removeEventListener() {},
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    window.__say = (t) => {
      const r = window.__rec;
      if (!r || !r.on) return false;
      r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] });
      return true;
    };
  })();
`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(FAKE_SPEECH);
});

const orb = (page: Page) => page.locator('[data-testid="agent-orb"]:visible');
// While the panel is open the card (and the phone pill) fold away and the panel header carries the status word.
const status = (page: Page) =>
  page.locator('[data-testid="agent-status"]:visible, [data-testid="agent-status-phone"]:visible, [data-testid="agent-panel-status"]:visible');
const panel = (page: Page) => page.getByTestId("agent-panel");
const say = (page: Page, text: string) => expect.poll(() => page.evaluate((t) => (window as unknown as { __say(t: string): boolean }).__say(t), text)).toBe(true);

async function open(page: Page, path = "/dev/agent") {
  await page.goto(path);
  await expect(orb(page)).toBeVisible();
  await page.waitForLoadState("networkidle");
}

/** Opens the expanded panel the way each device does: the expand button on desktop, the status pill on the phone. */
async function expand(page: Page, info: TestInfo) {
  if (phone(info)) await page.getByTestId("agent-status-phone").click();
  else await page.getByRole("button", { name: "Open the thread" }).click();
  await expect(panel(page)).toBeVisible();
  await page.waitForTimeout(350); // the slide
}

const type = async (page: Page, text: string) => {
  await panel(page).getByLabel("Message Hydra").fill(text);
  await panel(page).getByRole("button", { name: "Send" }).click();
};

/** A snapshot of the orb's pixels, to tell a moving canvas from a still one. */
const pixels = (page: Page, root: string) =>
  page.locator(`${root} canvas`).first().evaluate((c: HTMLCanvasElement) => c.toDataURL());
const inked = (page: Page, root: string) =>
  page.locator(`${root} canvas`).first().evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
    return n;
  });

test("the orb renders in the sidebar card on desktop and floats above the tabs on the phone", async ({ page }, info) => {
  await open(page);
  await expect(status(page)).toHaveText("Asleep");
  await expect(orb(page)).toHaveCount(1);
  expect(await inked(page, '[data-testid="agent-orb"]:visible')).toBeGreaterThan(40);
  if (phone(info)) {
    await expect(page.getByTestId("agent-card")).toBeHidden();
    const float = (await page.getByTestId("agent-float").boundingBox())!;
    const tabs = (await page.getByRole("navigation", { name: "Tabs" }).boundingBox())!;
    expect(float.y + float.height).toBeLessThanOrEqual(tabs.y);
    expect(tabs.y - (float.y + float.height)).toBeLessThan(24);
    expect((await orb(page).boundingBox())!.width).toBe(48);
  } else {
    const card = page.getByTestId("agent-card");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("agent-float")).toBeHidden();
    for (const name of ["Mute Hydra", "Pause", "Stop", "Open the thread"]) await expect(card.getByRole("button", { name })).toBeVisible();
    // the card sits at the bottom of the sidebar, below the last nav link, with only Sign out under it
    const sidebar = (await page.getByTestId("sidebar").boundingBox())!;
    const box = (await card.boundingBox())!;
    const signOut = (await page.getByTestId("sign-out").boundingBox())!;
    expect(signOut.y + signOut.height).toBeGreaterThan(sidebar.y + sidebar.height - 40);
    expect(box.y + box.height).toBeLessThanOrEqual(signOut.y);
    expect(signOut.y - (box.y + box.height)).toBeLessThan(16);
    await expect(page.getByRole("link", { name: "Ask Hydra" })).toHaveCount(0);
  }
  await page.screenshot({ path: shot(info, `agent-${w(info)}-asleep.png`) });
});

test("every status on the live card, one screenshot each", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => ((window as unknown as { __agentMockGap: number }).__agentMockGap = 800));
  await open(page);
  await expect(status(page)).toHaveText("Asleep");
  await orb(page).click();
  await expect(status(page)).toHaveText("Listening");
  await page.screenshot({ path: shot(info, `agent-${w(info)}-listening.png`) });
  await say(page, "hello there");
  await expect(status(page)).toHaveText("Thinking");
  await page.screenshot({ path: shot(info, `agent-${w(info)}-thinking.png`) });
  await expect(status(page)).toHaveText("Speaking", { timeout: 8000 });
  await page.screenshot({ path: shot(info, `agent-${w(info)}-speaking.png`) });
  await expect(status(page)).toHaveText("Listening", { timeout: 15_000 });
});

test("the gallery shows all four statuses in both tones", async ({ page }, info) => {
  await open(page);
  for (const tone of ["ink", "white"]) {
    for (const s of ["asleep", "listening", "thinking", "speaking"]) {
      const demo = page.getByTestId(`demo-${tone}-${s}`);
      await expect(demo).toBeVisible();
      expect(await inked(page, `[data-testid="demo-${tone}-${s}"]`)).toBeGreaterThan(40);
    }
  }
  await page.getByTestId("demo-ink-speaking").scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot(info, `agent-${w(info)}-gallery.png`), fullPage: true });
});

test("a typed turn streams text, runs the navigate event, and the panel stays open", async ({ page }, info) => {
  await open(page);
  await expand(page, info);
  await type(page, "Go to planning");
  await expect(page.getByTestId("agent-thread")).toContainText("Opening Planning. Here is your week.");
  await expect(page.getByTestId("agent-thread").locator('[data-role="user"]')).toHaveText(/Go to planning/);
  await expect(page).toHaveURL(/\/dev\/agent\/planning$/);
  await expect(page.getByTestId("fixture-planning")).toBeVisible();
  await expect(panel(page)).toBeVisible();
  await page.screenshot({ path: shot(info, `agent-${w(info)}-panel.png`) });
});

test("an open-panel event sets the search param, and the activity list undoes in one tap", async ({ page }, info) => {
  await open(page);
  await expand(page, info);
  await page.getByTestId("agent-panel").getByLabel("Message Hydra").fill("Add a coffee");
  await panel(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/[?&]tx=demo-1/);
  // The list slides over the thread from the header: the dot says this chat has something to undo.
  await expect(panel(page).getByTestId("agent-activity-dot")).toBeVisible();
  await panel(page).getByRole("button", { name: "Activity" }).click();
  const row = page.getByTestId("agent-activity").getByText("Added Coffee, $4.50");
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "Undo: Added Coffee, $4.50" }).click();
  await expect(page.getByTestId("agent-activity").getByText("Undone")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo: Added Coffee, $4.50" })).toHaveCount(0);
  await expect(panel(page).getByTestId("agent-activity-dot")).toHaveCount(0);
});

test("a confirm shows Approve and Decline; Approve resumes the turn", async ({ page }, info) => {
  await open(page);
  await expand(page, info);
  await type(page, "Delete the Costco row");
  const confirm = page.getByTestId("agent-confirm");
  await expect(confirm).toContainText("Delete the Costco transaction of $84.12 from Nov 3?");
  await expect(confirm.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Decline" })).toBeVisible();
  await page.screenshot({ path: shot(info, `agent-${w(info)}-confirm.png`) });
  await confirm.getByRole("button", { name: "Approve" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId("agent-thread")).toContainText("Deleted.");
  await panel(page).getByRole("button", { name: "Activity" }).click();
  await expect(page.getByTestId("agent-activity")).toContainText("Deleted Costco, $84.12");
});

test("Decline leaves the row alone", async ({ page }, info) => {
  await open(page);
  await expand(page, info);
  await type(page, "Delete the Costco row");
  await page.getByTestId("agent-confirm").getByRole("button", { name: "Decline" }).click();
  await expect(page.getByTestId("agent-thread")).toContainText("I left it alone.");
  await panel(page).getByRole("button", { name: "Activity" }).click();
  await expect(page.getByTestId("agent-activity")).toContainText("No changes yet.");
});

test("a spoken yes approves, a spoken no declines", async ({ page }) => {
  await open(page);
  await orb(page).click();
  await expect(status(page)).toHaveText("Listening");
  await say(page, "Delete the Costco row");
  await expect(page.getByTestId("agent-confirm")).toBeVisible(); // the panel opens by itself for a confirm
  await expect(panel(page).locator('[data-testid="agent-panel-status"]')).toHaveText("Listening", { timeout: 10_000 });
  await say(page, "Yes.");
  await expect(page.getByTestId("agent-thread")).toContainText("Deleted.");
  // The yes answered the paused turn through /api/agent/confirm: no second turn, the same stream went on.
  expect(await page.evaluate(() => (window as unknown as { __turns: unknown[] }).__turns.length)).toBe(1);

  await expect(panel(page).locator('[data-testid="agent-panel-status"]')).toHaveText("Listening", { timeout: 15_000 });
  await say(page, "Delete the Costco row");
  await expect(page.getByTestId("agent-confirm")).toBeVisible();
  await expect(panel(page).locator('[data-testid="agent-panel-status"]')).toHaveText("Listening", { timeout: 10_000 });
  await say(page, "No");
  await expect(page.getByTestId("agent-thread")).toContainText("I left it alone.");
});

test("routine approvals wait in the panel with Approve and Decline", async ({ page }, info) => {
  await open(page);
  await expand(page, info);
  const strip = page.getByTestId("agent-approvals");
  await expect(strip).toContainText("Send the Monday summary to your email?");
  await expect(strip.getByRole("button", { name: "Decline" })).toBeVisible();
  await strip.getByRole("button", { name: "Approve" }).click();
  await expect(strip).toHaveCount(0);
});

test('"Hydra, sleep" puts it to sleep at once; a tap wakes it', async ({ page }) => {
  await open(page);
  await orb(page).click();
  await expect(status(page)).toHaveText("Listening");
  await say(page, "Hydra, sleep");
  await expect(status(page)).toHaveText("Asleep");
  await expect(orb(page)).toHaveAttribute("data-status", "asleep");
  await orb(page).click();
  await expect(status(page)).toHaveText("Listening");
});

test("it sleeps after 5 minutes without talking", async ({ page }) => {
  await page.clock.install();
  await open(page);
  await orb(page).click();
  await expect(status(page)).toHaveText("Listening");
  await page.clock.fastForward("04:30");
  await expect(status(page)).toHaveText("Listening");
  await page.clock.fastForward("00:45");
  await expect(status(page)).toHaveText("Asleep");
});

/** The orb's outline: the outermost inked pixel per angle sector, as its mean and its spread over the mean. */
const outline = (page: Page, root: string) =>
  page.locator(`${root} canvas`).first().evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const sectors = new Array(36).fill(0);
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] < 60) continue;
        const dx = x - c.width / 2;
        const dy = y - c.height / 2;
        const s = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 36) % 36;
        sectors[s] = Math.max(sectors[s], Math.hypot(dx, dy));
      }
    const mean = sectors.reduce((a, b) => a + b, 0) / 36;
    return { mean, spread: Math.sqrt(sectors.reduce((a, b) => a + (b - mean) ** 2, 0) / 36) / mean };
  });

test("reduced motion: no turn, ripple or spikes, only a gentle pulse; otherwise a speaking orb moves", async ({ page }) => {
  const root = '[data-testid="demo-ink-speaking"]';
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  // The asleep orb holds one still frame.
  const asleep = '[data-testid="demo-ink-asleep"]';
  const z = await pixels(page, asleep);
  await page.waitForTimeout(400);
  expect(await pixels(page, asleep)).toBe(z);
  // Speaking: a round sphere that only swells a few percent with the voice.
  const shapes = [];
  for (let i = 0; i < 6; i++) {
    shapes.push(await outline(page, root));
    await page.waitForTimeout(120);
  }
  for (const s of shapes) expect(s.spread).toBeLessThan(0.03);
  const means = shapes.map((s) => s.mean);
  expect(Math.max(...means) / Math.min(...means)).toBeLessThan(1.08);
  expect(await inked(page, root)).toBeGreaterThan(40);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  await expect(page.getByTestId("demo-ink-speaking")).toBeVisible();
  const b = await pixels(page, root);
  await page.waitForTimeout(300);
  expect(await pixels(page, root)).not.toBe(b);
});

test("the panel is a right drawer on desktop and a bottom sheet on the phone", async ({ page }, info) => {
  await open(page);
  await expand(page, info);
  const box = (await panel(page).boundingBox())!;
  const vp = page.viewportSize()!;
  if (phone(info)) {
    expect(box.width).toBe(vp.width);
    expect(Math.round(box.y + box.height)).toBe(vp.height);
    expect(box.y).toBeGreaterThan(40);
  } else {
    expect(Math.round(box.x + box.width)).toBe(vp.width);
    expect(box.height).toBe(vp.height);
    expect(box.width).toBeLessThan(500);
  }
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
});

test("the collapsed sidebar shows the orb alone", async ({ page }, info) => {
  test.skip(phone(info), "desktop only");
  await open(page);
  await page.keyboard.press("[");
  await expect.poll(async () => (await page.getByTestId("sidebar").boundingBox())?.width).toBe(64);
  await page.waitForTimeout(300);
  await expect(page.getByTestId("agent-status")).toBeHidden();
  await expect(page.getByRole("button", { name: "Mute Hydra" })).toBeHidden();
  await expect(orb(page)).toBeVisible();
  expect((await orb(page).boundingBox())!.width).toBe(40);
  await page.screenshot({ path: shot(info, "agent-1440-collapsed.png") });
});

/* ---- Hydra Desktop (window.hydraDesktop): the fixture's fake bridge, `?desktop=<preset>` (src/app/dev/agent/fake-bridge.ts) ---- */

type Fake = { calls: string[]; push(m: Record<string, unknown>): void };
/** What the window asked the Mac to do (the setup gate's own setup() checks left out). */
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __bridge: Fake }).__bridge.calls.filter((c) => c !== "setup"));
const push = (page: Page, m: Record<string, unknown>) => page.evaluate((x) => (window as unknown as { __bridge: Fake }).__bridge.push(x), m);

test("v3: the card mirrors the Mac agent: state, reply and heard text, and its buttons drive the Mac voice", async ({ page }, info) => {
  await open(page, "/dev/agent?desktop=speaking");
  await expect(status(page)).toHaveText("Speaking");
  if (phone(info)) return; // the bridge only lives in the Mac window; the phone has no card
  const card = page.getByTestId("agent-card");
  await expect(card.getByTestId("agent-heard")).toHaveText("What did I spend on food this week?");
  await expect(card.getByTestId("agent-reply")).toContainText("You spent $212 on food this week.");
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot(info, "agent-1440-desktop-speaking.png") });

  await card.getByRole("button", { name: "Pause" }).click();
  await expect(card.getByRole("button", { name: "Resume" })).toBeVisible();
  await card.getByRole("button", { name: "Resume" }).click();
  await card.getByRole("button", { name: "Mute Hydra" }).click();
  await expect(card.getByRole("button", { name: "Unmute Hydra" })).toBeVisible();
  await card.getByRole("button", { name: "Stop" }).click();
  await expect(status(page)).toHaveText("Listening");
  await expect(card.getByTestId("agent-reply")).toHaveCount(0);
  await push(page, { state: "Asleep" });
  await orb(page).click();
  // Stop silences the Mac and puts it to sleep (owner: "stop button still doesnt put it to sleep").
  expect(await calls(page)).toEqual(["pause", "resume", "muted:true", "stop", "sleep", "wake"]);
  await expect(status(page)).toHaveText("Asleep"); // the Mac decides when it wakes

  // The expanded panel shows the same live words.
  await push(page, { state: "Speaking", heard: { text: "Open planning", final: true }, reply: { id: "r2", text: "Opening Planning.", final: false } });
  await expand(page, info);
  await expect(panel(page).getByTestId("agent-panel-live")).toContainText("Opening Planning.");
  await page.screenshot({ path: shot(info, "agent-1440-desktop-speaking-panel.png") });
  // Done (the final reply, then back to listening): the live words clear, and level pushes do not bring them back.
  await push(page, { reply: { id: "r2", text: "Opening Planning.", final: true } });
  await push(page, { state: "Listening" });
  await push(page, { micLevel: 0.4 });
  await expect(panel(page).getByTestId("agent-panel-live")).toHaveCount(0);
});

test("v3: interface steps from the Mac run through the router only when they are safe app paths", async ({ page }, info) => {
  test.skip(phone(info), "the bridge lives in the Mac window");
  await open(page, "/dev/agent?desktop=asleep");
  await push(page, { ui: { kind: "navigate", href: "https://evil.example/" } });
  await push(page, { ui: { kind: "navigate", href: "/api/agent/turn" } });
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/dev\/agent\?desktop=asleep$/);
  await push(page, { ui: { kind: "navigate", href: "/dev/agent/planning" } });
  await expect(page).toHaveURL(/\/dev\/agent\/planning$/);
});

test("v3: Detach sends the orb to the Mac; the card becomes one Attach row that brings it back", async ({ page }, info) => {
  test.skip(phone(info), "the bridge lives in the Mac window");
  await open(page, "/dev/agent?desktop=asleep");
  const card = page.getByTestId("agent-card");
  await card.getByTestId("agent-detach").hover();
  await expect(page.getByRole("tooltip")).toHaveText("Detach");
  await card.getByTestId("agent-detach").click();
  await expect(page.getByRole("switch", { name: "Attached" })).toHaveAttribute("aria-checked", "false");
  await expect(orb(page)).toHaveCount(0);
  await page.mouse.move(700, 400);
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot(info, "agent-1440-desktop-detached.png") });
  await page.getByTestId("agent-attach").click();
  await expect(orb(page)).toBeVisible();
  expect(await calls(page)).toEqual(["detach", "attach"]);
  // Detached from the Mac's menu bar: the window follows the pushed flag.
  await push(page, { detached: true });
  await expect(page.getByTestId("agent-attach")).toBeVisible();
});

test("v1 and v2 desktops still work: state mirrors, the missing controls are off", async ({ page }, info) => {
  test.skip(phone(info), "the bridge lives in the Mac window");
  await open(page, "/dev/agent?desktop=v1");
  await expect(status(page)).toHaveText("Listening");
  const card = page.getByTestId("agent-card");
  for (const name of ["Mute Hydra", "Pause"]) await expect(card.getByRole("button", { name })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Stop" })).toBeEnabled(); // never off: an older Mac sleeps on it
  await expect(card.getByTestId("agent-detach")).toHaveCount(0);
  await expect(page.getByTestId("setup-mac")).toHaveCount(0);
  await open(page, "/dev/agent?desktop=v2");
  await expect(status(page)).toHaveText("Asleep");
  await expect(page.getByTestId("agent-card").getByTestId("agent-detach")).toBeVisible();
  await expect(page.getByTestId("setup-mac")).toHaveCount(0);
});

for (const [mac, label, why] of [
  ["brain_offline", "Hydra is offline.", "Hydra's server and your Mac are both offline."],
  ["brain_timeout", "Hydra did not answer", "Hydra's server took too long to answer."],
  ["brain_failed", "Hydra stopped answering", "Hydra's server went quiet"],
  ["offline", "Your Mac is offline", "Hydra thinks on your Mac."],
  ["timeout", "Your Mac did not answer", "Hydra Desktop took too long"],
  ["bad_event", "Problem on your Mac", "Hydra Desktop sent an answer"],
  ["failed", "Your Mac stopped answering", "Hydra Desktop went quiet"],
  ["claude", "Sign in on your Mac", "Open Hydra on your Mac and sign in with Claude."],
  ["signed_out", "Sign in on your Mac", "Open Hydra on your Mac and sign in with Claude."],
]) {
  test(`the website and phone say plainly when the Mac brain fails: ${mac}`, async ({ page }, info) => {
    await open(page, `/dev/agent?mac=${mac}`);
    await expand(page, info);
    const sent = Date.now();
    await type(page, "how much did I spend");
    // The first turn ends with the words at once (no Mac online: the server answers before any wait).
    await expect(status(page)).toHaveText(label, { timeout: 3000 });
    expect(Date.now() - sent).toBeLessThan(3000);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    if (!phone(info)) {
      await page.getByTestId("agent-card").getByRole("button", { name: "Why" }).hover();
      await expect(page.getByText(why, { exact: false })).toBeVisible();
      await page.waitForTimeout(250);
    }
    await page.screenshot({ path: shot(info, `agent-${w(info)}-mac-${mac}.png`) });
  });
}

/* ---- Owner reports: "the stop button isnt doing anything", "it's not responding" ---- */

const speakingNow = (page: Page) => page.evaluate(() => window.speechSynthesis.speaking);

test("asleep, the whole card is the tap target: hover says Tap to talk, a click anywhere or Enter/Space on the orb listens", async ({ page }, info) => {
  test.skip(phone(info), "the card lives in the desktop sidebar");
  await open(page);
  const card = page.getByTestId("agent-card");
  await expect(status(page)).toHaveText("Asleep");
  const wake = page.getByTestId("agent-card-wake");
  await wake.hover({ position: { x: 12, y: 12 } }); // a corner of the card, away from the orb
  await expect(page.getByRole("tooltip")).toHaveText("Tap to talk");
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot(info, "agent-1440-asleep-hover.png") });
  await wake.click({ position: { x: 12, y: 12 } }); // not the orb: the card itself
  await expect(status(page)).toHaveText("Listening");
  // Asleep again by Stop, then the keyboard: Enter and Space on the orb.
  await card.getByRole("button", { name: "Stop" }).click();
  await expect(status(page)).toHaveText("Asleep");
  await card.getByRole("button", { name: "Stop" }).click(); // asleep: nothing breaks
  await expect(status(page)).toHaveText("Asleep");
  await orb(page).focus();
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText("Listening");
  await card.getByRole("button", { name: "Stop" }).click();
  await orb(page).focus();
  await page.keyboard.press("Space");
  await expect(status(page)).toHaveText("Listening");
  // The controls keep their own job: Open the thread does not wake it twice or sleep it.
  await card.getByRole("button", { name: "Stop" }).click();
  await card.getByRole("button", { name: "Open the thread" }).click();
  await expect(panel(page)).toBeVisible();
  await expect(status(page)).toHaveText("Asleep");
});

test("Stop mid-speech ends the voice, the turn and the listening", async ({ page }, info) => {
  test.setTimeout(30_000);
  await open(page);
  await orb(page).click();
  await expect(status(page)).toHaveText("Listening");
  await say(page, "hello there");
  await expect(status(page)).toHaveText("Speaking", { timeout: 8000 });
  expect(await speakingNow(page)).toBe(true);
  const scope = phone(info) ? panel(page) : page.getByTestId("agent-card");
  if (phone(info)) await expand(page, info);
  const stop = scope.getByRole("button", { name: "Stop" });
  await stop.hover();
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot(info, `agent-${w(info)}-stop-mid-speech.png`) });
  await stop.click();
  await expect(status(page).first()).toHaveText("Asleep");
  expect(await speakingNow(page)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __say(t: string): boolean }).__say("are you there"))).toBe(false); // not listening
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot(info, `agent-${w(info)}-stopped.png`) });
});

type VoiceWin = { __spoken?: string[]; __turns?: { interruptedAfter?: string }[]; __agentMockGap?: number; __say(t: string): boolean };

test("barge-in: the owner talks over Hydra, it stops at once and the next turn knows where it was cut off (iOS: a tap)", async ({ page }, info) => {
  test.setTimeout(30_000);
  await open(page);
  await orb(page).click();
  await say(page, "hello there");
  await expect(status(page)).toHaveText("Speaking", { timeout: 8000 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: shot(info, `agent-${w(info)}-voice-speaking.png`) });
  if (phone(info)) {
    // iOS Safari cannot keep the mic open over audio: the recognizer is off while Hydra speaks, a tap interrupts.
    expect(await page.evaluate(() => (window as unknown as VoiceWin).__say("wait a second"))).toBe(false);
    await orb(page).click();
  } else {
    expect(await page.evaluate(() => (window as unknown as VoiceWin).__say("wait a second"))).toBe(true);
  }
  expect(await speakingNow(page)).toBe(false); // silenced on the spot
  await expect(status(page)).not.toHaveText("Speaking");
  await page.screenshot({ path: shot(info, `agent-${w(info)}-voice-barged.png`) });
  if (phone(info)) await say(page, "wait a second");
  await expect.poll(() => page.evaluate(() => (window as unknown as VoiceWin).__turns?.length)).toBe(2);
  const turns = await page.evaluate(() => (window as unknown as VoiceWin).__turns!);
  expect(turns[0].interruptedAfter).toBeUndefined();
  // It was cut while speaking: the next turn gets every sentence that had started. Under load the second sentence can
  // start before the tap lands (iOS plays the element directly, with no Web Audio hop), so either boundary is a real cut.
  expect(["I heard you.", "I heard you. What next?"]).toContain(turns[1].interruptedAfter);
});

test("a filler in Hydra's voice while it works, never in the thread", async ({ page }, info) => {
  test.setTimeout(30_000);
  await open(page);
  await page.evaluate(() => void ((window as unknown as VoiceWin).__agentMockGap = 1600)); // a slow brain
  await orb(page).click();
  await say(page, "hello there");
  await expect.poll(() => page.evaluate(() => (window as unknown as VoiceWin).__spoken?.length ?? 0), { timeout: 5000 }).toBe(1);
  await expect(status(page)).toHaveText("Speaking");
  await page.screenshot({ path: shot(info, `agent-${w(info)}-voice-filler.png`) });
  const filler = (await page.evaluate(() => (window as unknown as VoiceWin).__spoken!))[0];
  expect(["Let me check.", "One sec.", "Let me see.", "Checking that now.", "Give me a second.", "Let me look.", "Hang on.", "Just a moment.", "Let me pull that up."]).toContain(filler);
  await expect.poll(() => page.evaluate(() => (window as unknown as VoiceWin).__spoken), { timeout: 15_000 }).toEqual([filler, "I heard you.", "What next?"]);
  await expand(page, info);
  await expect(panel(page)).toContainText("What next?");
  await expect(panel(page)).not.toContainText(filler);
});

test("a browser with no speech recognition says so on the card and offers typing", async ({ page }, info) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
  });
  await open(page);
  if (phone(info)) {
    await orb(page).click(); // the phone has no card: a tap opens the typed thread
    await expect(panel(page)).toBeVisible();
    return;
  }
  const note = page.getByTestId("agent-card").getByTestId("agent-no-voice");
  await expect(note).toBeVisible();
  await note.getByRole("button", { name: "No voice" }).hover();
  await expect(page.getByText("This browser has no speech recognition", { exact: false })).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot(info, "agent-1440-no-voice.png") });
  await note.getByRole("button", { name: "Type to Hydra" }).click();
  await expect(panel(page)).toBeVisible();
  await type(page, "hello");
  await expect(page.getByTestId("agent-thread")).toContainText("I heard you.");
});

/* ---- Set up this Mac ---- */

const step = (page: Page, id: string) => page.getByTestId(`setup-step-${id}`);

for (const preset of ["setup-pairing", "setup-pair-failed", "setup-claude", "setup-permissions", "setup-denied"]) {
  test(`Set up this Mac: ${preset}`, async ({ page }, info) => {
    await page.goto(`/dev/agent?desktop=${preset}`);
    await expect(page.getByTestId("setup-mac")).toBeVisible();
    // The app stays mounted under the gate (no flash, no remount), inert until setup is done.
    await expect(page.getByTestId("setup-app")).toHaveAttribute("inert", "");
    const want: Record<string, Record<string, string>> = {
      "setup-pairing": { pair: "working", claude: "todo", mic: "todo" },
      "setup-pair-failed": { pair: "failed", claude: "todo" },
      "setup-claude": { pair: "done", claude: "todo", mic: "todo", accessibility: "todo", screen: "todo" },
      "setup-permissions": { pair: "done", claude: "done", mic: "done", accessibility: "todo", screen: "todo" },
      "setup-denied": { pair: "done", claude: "done", mic: "done", accessibility: "done", screen: "denied" },
    };
    for (const [id, s] of Object.entries(want[preset])) await expect(step(page, id)).toHaveAttribute("data-state", s);
    if (preset === "setup-pairing" || preset === "setup-pair-failed") {
      // Pair ran on load with the relay scope; the code never shows on screen.
      expect(await page.evaluate(() => (window as unknown as { __pairBodies: unknown[] }).__pairBodies)).toEqual([{ name: "Hydra Desktop", scopes: ["agent", "mcp", "relay"] }]);
      await expect(page.getByText("FIXTURE-PAIR-CODE")).toHaveCount(0);
    }
    await page.waitForTimeout(350);
    await page.screenshot({ path: shot(info, `setup-${w(info)}-${preset.slice(6)}.png`) });
  });
}

test("Set up this Mac: each step to done, then the app", async ({ page }, info) => {
  await page.goto("/dev/agent?desktop=setup-claude");
  await expect(page.getByTestId("setup-mac")).toBeVisible();
  if (!phone(info)) {
    await step(page, "mic").getByRole("button", { name: "Why Microphone" }).hover();
    await expect(page.getByText("So Hydra hears you", { exact: false })).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: shot(info, "setup-1440-infodot.png") });
  }
  await step(page, "claude").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(step(page, "claude")).toHaveAttribute("data-state", "working");
  await expect(step(page, "claude")).toHaveAttribute("data-state", "done");
  for (const id of ["mic", "accessibility", "screen"]) {
    await step(page, id).getByRole("button", { name: "Allow", exact: true }).click();
    await expect(step(page, id)).toHaveAttribute("data-state", "done");
  }
  await expect(page.getByTestId("setup-mac")).toHaveAttribute("data-complete", "true");
  await page.screenshot({ path: shot(info, `setup-${w(info)}-all-done.png`) });
  await expect(orb(page)).toBeVisible();
  await expect(page.getByTestId("setup-mac")).toHaveCount(0);
  expect(await calls(page)).toEqual(["signInClaude", "permission:mic", "permission:accessibility", "permission:screen"]);
});

test("Set up this Mac: Pair with no answer for 20 s offers Retry", async ({ page }, info) => {
  await page.clock.install();
  await page.goto("/dev/agent?desktop=setup-pairing");
  await expect(step(page, "pair")).toHaveAttribute("data-state", "working");
  await expect(step(page, "pair").getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.clock.fastForward(20_000);
  await expect(step(page, "pair").getByRole("button", { name: "Retry" })).toBeVisible();
  // The installed clock holds the fade-in: finish it for the shot.
  await page.screenshot({ path: shot(info, `setup-${w(info)}-pair-slow-retry.png`), animations: "disabled" });
  await step(page, "pair").getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __pairBodies: unknown[] }).__pairBodies.length)).toBe(2);
});

test("Set up this Mac: Claude sign-in can be cancelled", async ({ page }, info) => {
  await page.goto("/dev/agent?desktop=setup-claude-wait");
  await step(page, "claude").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(step(page, "claude")).toHaveAttribute("data-state", "working");
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot(info, `setup-${w(info)}-claude-cancel.png`) });
  await step(page, "claude").getByRole("button", { name: "Cancel" }).click();
  await expect(step(page, "claude")).toHaveAttribute("data-state", "todo");
  await expect(step(page, "claude").getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

test("Set up this Mac: a refused permission can be skipped, and the gate does not come back on this Mac", async ({ page }, info) => {
  await page.goto("/dev/agent?desktop=setup-denied");
  await expect(step(page, "screen")).toHaveAttribute("data-state", "denied");
  await expect(step(page, "screen").getByRole("button", { name: "Skip" })).toBeVisible();
  await page.waitForTimeout(350); // the fade-in
  await step(page, "screen").getByRole("button", { name: "Skip" }).click();
  await expect(page.getByTestId("setup-mac")).toHaveAttribute("data-complete", "true");
  await expect(step(page, "screen")).toHaveAttribute("data-state", "skipped");
  await expect(step(page, "screen").getByRole("button", { name: "Open Settings" })).toHaveAttribute("data-variant", "outline");
  await page.waitForTimeout(250); // the button's color change (the app shows at 600 ms)
  await page.screenshot({ path: shot(info, `setup-${w(info)}-skipped.png`) });
  await expect(orb(page)).toBeVisible();
  await expect(page.getByTestId("setup-mac")).toHaveCount(0);
  await expect(page.getByTestId("setup-app")).not.toHaveAttribute("inert");
  // The next launch on this Mac: Screen is still off, and no gate.
  await page.reload();
  await expect(orb(page)).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("setup-mac")).toHaveCount(0);
});

test("the TTS route's 503 falls back to the browser voice and the turn still ends", async ({ page }) => {
  await open(page);
  await orb(page).click();
  await say(page, "hello there");
  await expect(status(page)).toHaveText("Listening", { timeout: 15_000 });
  // the mock counts the requests the client made to the voice route
  expect(await page.evaluate(() => (window as unknown as { __ttsCalls?: number }).__ttsCalls)).toBeGreaterThan(0);
});

test("the sleep word is the shared server setting: saved with PATCH /api/agent/state, not on this device", async ({ page }, info) => {
  await open(page);
  // Record what the client sends (the mock stands in for the server and answers it).
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
  // The sleep word lives in the orb options menu (the name in the panel header), not the panel body.
  await panel(page).getByRole("button", { name: "Hydra options" }).click();
  const field = page.getByTestId("agent-orb-options").getByTestId("agent-sleep-word");
  await field.fill("Hydra, good night");
  await field.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __patches: unknown[] }).__patches)).toContainEqual(["/api/agent/state", { sleepWord: "Hydra, good night" }]);
  expect(await page.evaluate(() => localStorage.getItem("hydra:sleep-word"))).toBeNull();
  await page.keyboard.press("Escape");
  // In the panel header the orb opens the options; the big orb (card, phone pill) wakes Hydra.
  await panel(page).getByRole("button", { name: "Close" }).click();
  await expect(panel(page)).toBeHidden();
  await orb(page).click();
  await expect(status(page)).toHaveText("Listening");
  await say(page, "Hydra, sleep");
  await expect(status(page)).not.toHaveText("Asleep");
  await say(page, "hydra good night");
  await expect(status(page)).toHaveText("Asleep");
});

test("the sleep word field shows in Hydra Desktop too", async ({ page }, info) => {
  await open(page, "/dev/agent?desktop=asleep");
  await expand(page, info);
  await panel(page).getByRole("button", { name: "Hydra options" }).click();
  await expect(page.getByTestId("agent-orb-options").getByTestId("agent-sleep-word")).toBeVisible();
  await page.screenshot({ path: shot(info, "agent-sleep-word-desktop-mode.png") });
});

test("sign out is in the sidebar footer and the phone More sheet, and posts to /auth/signout", async ({ page }, info) => {
  await open(page);
  let button;
  if (phone(info)) {
    await page.getByRole("navigation", { name: "Tabs" }).getByRole("button", { name: "More" }).click();
    button = page.getByTestId("sign-out-phone");
  } else {
    button = page.getByTestId("sign-out");
    const card = (await page.getByTestId("agent-card").boundingBox())!;
    expect((await button.boundingBox())!.y).toBeGreaterThan(card.y + card.height - 1);
  }
  await expect(button).toBeVisible();
  await expect(button).toHaveText(/Sign out/);
  await page.waitForTimeout(350); // the sheet's slide
  await page.screenshot({ path: shot(info, `signout-${w(info)}.png`) });
  const posted = page.waitForRequest((r) => new URL(r.url()).pathname === "/auth/signout" && r.method() === "POST");
  await button.click();
  await posted;
  await expect(page).toHaveURL(/\/login/);
});

test("on the phone the agent float never covers the bottom of the page", async ({ page }, info) => {
  test.skip(!phone(info), "phone only");
  const floatTop = async () => (await page.getByTestId("agent-float").boundingBox())!.y;
  const toBottom = () => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

  // A long page: at the bottom, the last content sits above the float.
  await open(page);
  await toBottom();
  await page.waitForTimeout(200);
  const lastBottom = await page.locator("main").evaluate((m) => {
    const kids = [...m.querySelectorAll<HTMLElement>("*")].filter((e) => e.getBoundingClientRect().height > 0);
    return Math.max(...kids.map((e) => e.getBoundingClientRect().bottom));
  });
  expect(lastBottom).toBeLessThanOrEqual(await floatTop());
  await page.screenshot({ path: shot(info, "float-390-long-page-bottom.png") });

  // The UGC wizard: pick a deal, scroll to the bottom, and the Continue button takes the tap, not the float.
  await page.goto("/dev/ugc?flow=existing");
  await page.getByRole("radio", { name: /^Wordwise .* in Hydra$/ }).click();
  const cont = page.getByRole("button", { name: "Continue" });
  await expect(cont).toBeEnabled();
  await toBottom();
  await page.waitForTimeout(200);
  const box = (await cont.boundingBox())!;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("button")?.textContent ?? "", [box.x + box.width / 2, box.y + box.height / 2]);
  expect(hit).toContain("Continue");
  expect(box.y + box.height).toBeLessThanOrEqual(await floatTop());
  await page.screenshot({ path: shot(info, "float-390-ugc-wizard-bottom.png") });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByText("2/6")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
});

test("on the phone a failed recognizer shows on the pill, not a silent Listening, and a tap tries it again", async ({ page }, info) => {
  test.skip(!phone(info), "phone only: the desktop card has its own No voice note");
  await open(page);
  await orb(page).click();
  const word = page.getByTestId("agent-status-phone");
  await expect(word).toHaveText("Listening");
  await page.screenshot({ path: shot(info, "pill-390-listening.png") });

  // The iPhone refuses the recognizer: the pill says how to talk now, and the reason floats over it for a moment.
  await page.evaluate(() => (window as unknown as { __rec: { onerror(e: { error: string }): void } }).__rec.onerror({ error: "not-allowed" }));
  await expect(word).toHaveText("Type to Hydra");
  const note = page.getByTestId("agent-note-phone");
  await expect(note).toBeVisible();
  await expect(note).toHaveText("The microphone is off. Type instead.");
  await page.screenshot({ path: shot(info, "pill-390-mic-off-note.png") });
  await expect(note).toBeHidden({ timeout: 6000 });
  await expect(word).toHaveText("Type to Hydra");
  await page.screenshot({ path: shot(info, "pill-390-typed-only.png") });

  // A tap on the orb tries the recognizer again.
  await orb(page).click();
  await expect(word).toHaveText("Listening");
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __rec?: { on?: boolean } }).__rec?.on)).toBe(true);

  // A tap with nothing said only turns it off: no error.
  await orb(page).click();
  await expect(word).toHaveText("Asleep");
  await expect(note).toBeHidden({ timeout: 1000 }); // an error note would stay 4 s

  // He spoke and the recognizer gave no words: the tap turns it off and says so.
  await orb(page).click();
  await expect(word).toHaveText("Listening");
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __rec?: { on?: boolean } }).__rec?.on)).toBe(true);
  await page.evaluate(() => (window as unknown as { __rec: { onspeechstart?(): void } }).__rec.onspeechstart?.());
  await orb(page).click();
  await expect(word).toHaveText("Asleep");
  await expect(note).toHaveText("Didn't catch that.");
  await page.screenshot({ path: shot(info, "pill-390-didnt-catch.png") });
});
