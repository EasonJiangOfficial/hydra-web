import { expect, test, type Page, type TestInfo } from "@playwright/test";

/*
 * Approve all (0200, owner: "there should be a mode that approves all actions"): a switch in the orb options menu
 * and in Settings > Agent, each with an info dot; while on, the panel header shows a quiet "Approve all" tag under the
 * status word, on a line kept while off (the thread never moves). Hover explains it; nothing on the page says it in
 * a sentence. Saved through PATCH /api/agent/state.
 */

const phone = (info: TestInfo) => info.project.name.startsWith("phone");
const INFO = "Hydra acts without asking. Deletions still ask.";

const SILENT = `
  (() => {
    class Rec { constructor() { window.__rec = this; } start() { this.on = true; } stop() { this.on = false; } abort() { this.on = false; } }
    window.SpeechRecognition = Rec;
    window.webkitSpeechRecognition = Rec;
    const synth = { speaking: false, pending: false, paused: false, getVoices: () => [], speak(u) { setTimeout(() => u.dispatchEvent(new Event("end")), 0); },
      cancel() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  })();
`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(SILENT);
});

const panel = (page: Page) => page.getByTestId("agent-panel");

async function patches(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __patches: unknown[]; fetch: typeof fetch };
    w.__patches = [];
    const inner = w.fetch;
    w.fetch = (input, init) => {
      if (init?.method === "PATCH") w.__patches.push([String(input), JSON.parse(String(init.body))]);
      return inner(input, init);
    };
  });
  return () => page.evaluate(() => (window as unknown as { __patches: unknown[] }).__patches);
}

test("the orb menu turns approve all on and off; the panel header tags it while on", async ({ page }, info) => {
  await page.goto("/dev/agent");
  await expect(page.locator('[data-testid="agent-orb"]:visible')).toHaveCount(1);
  await page.waitForLoadState("networkidle");
  const sent = await patches(page);
  if (phone(info)) await page.getByTestId("agent-status-phone").click();
  else await page.getByRole("button", { name: "Open the thread" }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId("agent-approve-all-tag")).toHaveCount(0);
  await page.waitForTimeout(400); // the panel's slide
  const threadY = async () => (await page.getByTestId("agent-thread").boundingBox())!.y;
  const before = await threadY();

  await panel(page).getByRole("button", { name: "Hydra options" }).click();
  const menu = page.getByTestId("agent-orb-options");
  const sw = menu.getByRole("switch", { name: "Approve all" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(menu.getByRole("button", { name: "About approve all" })).toHaveAccessibleDescription(INFO);
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect.poll(sent).toContainEqual(["/api/agent/state", { approveAll: true }]);
  await expect(menu.getByRole("switch", { name: "Mute" })).toHaveAttribute("aria-checked", "false"); // a different row

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  const tag = panel(page).getByTestId("agent-approve-all-tag");
  await expect(tag).toHaveText("Approve all");
  expect(await threadY()).toBe(before); // its line is kept while off: the thread never moves
  await expect(tag).toHaveAccessibleDescription(INFO);
  // The words show on both widths (not an icon with hidden text), and hover or a tap explains them.
  expect((await tag.boundingBox())!.width).toBeGreaterThan(50);
  if (phone(info)) await tag.tap();
  else await tag.hover();
  await expect(page.locator("[data-radix-popper-content-wrapper]").getByText(INFO)).toBeVisible();

  await panel(page).getByRole("button", { name: "Hydra options" }).click();
  await menu.getByRole("switch", { name: "Approve all" }).click();
  await expect.poll(sent).toContainEqual(["/api/agent/state", { approveAll: false }]);
  await page.keyboard.press("Escape");
  await expect(panel(page).getByTestId("agent-approve-all-tag")).toHaveCount(0);
});

test("a refused save puts the switch back", async ({ page }, info) => {
  test.skip(phone(info), "one run is enough: the same controller on both");
  await page.goto("/dev/agent");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    const w = window as unknown as { fetch: typeof fetch };
    const inner = w.fetch;
    w.fetch = (input, init) => (init?.method === "PATCH" ? Promise.resolve(Response.json({ error: "invalid_input" }, { status: 400 })) : inner(input, init));
  });
  await page.getByRole("button", { name: "Open the thread" }).click();
  await panel(page).getByRole("button", { name: "Hydra options" }).click();
  const sw = page.getByTestId("agent-orb-options").getByRole("switch", { name: "Approve all" });
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
});

test("Settings > Agent has the same switch, saved through PATCH", async ({ page }) => {
  let settings: Record<string, unknown> = { sleepWord: "Hydra, sleep", brain: "mac", wakePhrase: "Hey Hydra", clapSensitivity: "medium", model: "claude-opus-5-5", effortLive: "low", effortRoutine: "medium", approveAll: false };
  const sent: unknown[] = [];
  await page.route("**/api/agent/state", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      const body = req.postDataJSON() as Record<string, unknown>;
      sent.push(body);
      settings = { ...settings, ...body };
      return route.fulfill({ json: { ok: true, settings } });
    }
    return route.fulfill({ json: { threads: [], pendingApprovals: [], activity: [], notifications: [], settings } });
  });
  await page.goto("/dev/settings?tab=agent");
  const brain = page.getByRole("region", { name: "Brain" });
  const sw = brain.getByRole("switch", { name: "Approve all" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(brain.getByRole("button", { name: "About approve all" })).toHaveAccessibleDescription(INFO);
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => sent).toEqual([{ approveAll: true }]);
  await expect(brain.getByText("Saved")).toBeVisible();
});
