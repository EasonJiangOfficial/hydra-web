import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

/*
 * Avatars (0220; owner: "like I should be able to create new avatars, how they talk if they curse, use slang ect, and
 * enter the id from fish audio and it should work"). /dev/settings?tab=agent runs the real Agent tab; this spec answers
 * /api/agent/state, /api/agent/avatars, /api/voice/fish/model and /api/voice/tts itself (no Fish call, no spend).
 * /dev/agent?avatars=on: the orb menu's quick switch.
 */

const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/avatars";
const phone = (info: TestInfo) => info.project.name === "phone";
const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: path.join(SHOTS, `avatars-${name}-${phone(info) ? 375 : 1440}.png`) });

const GOOD = "0123456789abcdef0123456789abcdef";
const UNKNOWN = "ffffffffffffffffffffffffffffffff";
const VOICES: Record<string, string> = { [GOOD]: "Tony from Brooklyn", fedcba9876543210fedcba9876543210: "Calm British butler" };
const SETTINGS = { sleepWord: "Hydra, sleep", brain: "mac", wakePhrase: "Hey Hydra", clapSensitivity: "medium", model: "claude-opus-5-5", effortLive: "low", effortRoutine: "medium", approveAll: false, activeAvatarId: null };

type Avatar = { id: string; name: string; voiceId: string; curse: boolean; slang: boolean; styleNotes: string };

async function routes(page: Page) {
  let settings: Record<string, unknown> = { ...SETTINGS };
  const avatars: Avatar[] = [{ id: "00000000-0000-4000-8000-00000000a7a2", name: "Butler", voiceId: "fedcba9876543210fedcba9876543210", curse: false, slang: false, styleNotes: "Formal." }];
  const log = { patches: [] as unknown[], created: [] as unknown[], deleted: [] as string[], tts: [] as unknown[] };
  let n = 0;
  await page.route("**/api/agent/state", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      const body = req.postDataJSON() as Record<string, unknown>;
      log.patches.push(body);
      settings = { ...settings, ...body };
      return route.fulfill({ json: { ok: true, settings } });
    }
    return route.fulfill({ json: { threads: [], pendingApprovals: [], activity: [], notifications: [], settings } });
  });
  await page.route("**/api/agent/avatars**", async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === "GET") return route.fulfill({ json: { avatars } });
    if (method === "POST") {
      const body = req.postDataJSON() as Avatar;
      log.created.push(body);
      const a = { ...body, id: `00000000-0000-4000-8000-0000000000${String(++n).padStart(2, "0")}`, name: body.name.trim(), styleNotes: body.styleNotes.trim() };
      avatars.push(a);
      return route.fulfill({ status: 201, json: { avatar: a } });
    }
    if (method === "PATCH") {
      const { id, ...patch } = req.postDataJSON() as Avatar;
      const a = avatars.find((x) => x.id === id)!;
      Object.assign(a, patch);
      return route.fulfill({ json: { avatar: a } });
    }
    const id = new URL(req.url()).searchParams.get("id")!;
    log.deleted.push(id);
    avatars.splice(avatars.findIndex((x) => x.id === id), 1);
    if (settings.activeAvatarId === id) settings.activeAvatarId = null;
    return route.fulfill({ json: { ok: true, activityId: null } });
  });
  await page.route("**/api/voice/fish/model**", async (route) => {
    const id = new URL(route.request().url()).searchParams.get("id")!;
    const title = VOICES[id];
    if (!title) return route.fulfill({ status: 404, json: { error: "unknown_voice", message: "Fish has no voice with this ID" } });
    return route.fulfill({ json: { id, title, sampleUrl: null, languages: ["en"] } });
  });
  await page.route("**/api/voice/tts", async (route) => {
    log.tts.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, headers: { "content-type": "audio/mpeg" }, body: Buffer.from([0xff, 0xfb, 0x90, 0x00]) });
  });
  return log;
}

test.beforeEach(async ({ page }, info) => {
  if (phone(info)) await page.setViewportSize({ width: 375, height: 812 });
});

test("Avatars: the list, a new avatar checked with Fish (invalid then valid), preview, curse and slang, switch, delete", async ({ page }, info) => {
  const log = await routes(page);
  await page.goto("/dev/settings?tab=agent");
  const card = page.getByRole("region", { name: "Avatars" });
  await expect(card).toBeVisible();
  const list = card.getByTestId("avatar-list");
  // Hydra's own voice first and active; each avatar with its Fish voice's title.
  await expect(list.getByRole("radio", { name: "Use Hydra" })).toHaveAttribute("aria-checked", "true");
  await expect(list.locator('[data-avatar="Butler"]')).toContainText("Calm British butler");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await shot(page, info, "01-list");

  // New avatar: a bad id shows the error inline; a good one shows Fish's title.
  await card.getByRole("link", { name: "New avatar" }).click();
  const panel = page.getByRole("dialog", { name: "New avatar" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("Name").fill("Tony");
  const voice = panel.getByTestId("avatar-voice-id");
  const check = panel.getByTestId("avatar-voice-check");
  await voice.fill("a1b2c3d4");
  await voice.press("Enter");
  await expect(check).toHaveAttribute("data-state", "bad");
  await expect(check).toContainText("Not a Fish voice ID");
  await expect(voice).toHaveAttribute("aria-invalid", "true");
  await voice.fill(UNKNOWN);
  await voice.press("Enter");
  await expect(check).toContainText("Fish has no voice with this ID");
  await page.waitForTimeout(250);
  await shot(page, info, "02-panel-invalid");

  await voice.fill(`  ${GOOD.toUpperCase()} `);
  await voice.press("Enter");
  await expect(check).toHaveAttribute("data-state", "ok");
  await expect(check).toContainText("Tony from Brooklyn");
  await expect(voice).toHaveValue(GOOD);
  await panel.getByRole("switch", { name: "Curse" }).click();
  await panel.getByRole("switch", { name: "Slang" }).click();
  await expect(panel.getByRole("switch", { name: "Curse" })).toHaveAttribute("aria-checked", "true");
  await panel.getByLabel("Style notes").fill("Brooklyn, fast, warm.");
  await panel.getByRole("button", { name: "Preview the voice" }).click();
  await expect.poll(() => log.tts).toEqual([{ text: "Hey, it's Tony. This is how I sound.", voice: GOOD }]);
  await page.waitForTimeout(250);
  await shot(page, info, "03-panel-valid");

  await panel.getByRole("button", { name: "Add avatar" }).click();
  await expect(panel).toBeHidden();
  expect(log.created).toEqual([{ name: "Tony", voiceId: GOOD, curse: true, slang: true, styleNotes: "Brooklyn, fast, warm." }]);
  await expect(list.locator('[data-avatar="Tony"]')).toContainText("Tony from Brooklyn");

  // The check makes it the one every device uses (PATCH /api/agent/state).
  await list.getByRole("radio", { name: "Use Tony" }).click();
  await expect.poll(() => log.patches).toContainEqual({ activeAvatarId: "00000000-0000-4000-8000-000000000001" });
  await expect(list.getByRole("radio", { name: "Use Tony" })).toHaveAttribute("aria-checked", "true");
  await expect(list.getByRole("radio", { name: "Use Hydra" })).toHaveAttribute("aria-checked", "false");

  // Edit saves a field at once; Delete asks first, and the active one going away puts Hydra back.
  await list.locator('[data-avatar="Tony"]').getByRole("link").click();
  const edit = page.getByRole("dialog", { name: "Avatar" });
  await expect(edit.getByTestId("avatar-voice-check")).toContainText("Tony from Brooklyn");
  await edit.getByRole("switch", { name: "Slang" }).click();
  await expect(edit.getByText("Saved")).toBeVisible();
  await edit.getByRole("button", { name: "Delete" }).click();
  const ask = edit.getByRole("alertdialog", { name: "Delete avatar" });
  await expect(ask).toContainText("Delete Tony?");
  expect(log.deleted).toEqual([]);
  await ask.getByRole("button", { name: "Delete" }).click();
  await expect(edit).toBeHidden();
  expect(log.deleted).toEqual(["00000000-0000-4000-8000-000000000001"]);
  await expect(list.locator('[data-avatar="Tony"]')).toHaveCount(0);
  await expect(list.getByRole("radio", { name: "Use Hydra" })).toHaveAttribute("aria-checked", "true");
});

test("a voice Fish could not check shows a short state with the message on hover, and is asked again", async ({ page }, info) => {
  await routes(page);
  const BUTLER = "fedcba9876543210fedcba9876543210";
  let fails = 1;
  // Registered after routes(): Playwright tries the newest handler first. Butler's first lookup fails.
  await page.route("**/api/voice/fish/model**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("id") === BUTLER && fails-- > 0) return route.fulfill({ status: 502, json: { error: "voice_upstream", message: "Could not reach Fish Audio. Try again." } });
    return route.fallback();
  });
  await page.goto("/dev/settings?tab=agent");
  const list = page.getByRole("region", { name: "Avatars" }).getByTestId("avatar-list");
  const butler = list.locator('[data-avatar="Butler"]');
  const problem = butler.getByTestId("avatar-voice-problem");
  await expect(problem).toHaveText(/Voice issue/);
  await expect(problem).toHaveAttribute("title", "Could not reach Fish Audio. Try again.");
  await expect(butler).not.toContainText("Calm British butler");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await shot(page, info, "05-voice-issue");

  // A change to the list (a new avatar) asks Fish again for the failed id.
  await page.getByRole("link", { name: "New avatar" }).click();
  const panel = page.getByRole("dialog", { name: "New avatar" });
  await panel.getByLabel("Name").fill("Tony");
  await panel.getByTestId("avatar-voice-id").fill(GOOD);
  await panel.getByRole("button", { name: "Add avatar" }).click();
  await expect(panel).toBeHidden();
  await expect(butler).toContainText("Calm British butler");
  await expect(problem).toHaveCount(0);
});

test("the orb menu's quick avatar switch", async ({ page }, info) => {
  await page.goto("/dev/agent?avatars=on");
  await expect(page.locator('[data-testid="agent-orb"]:visible')).toHaveCount(1);
  await page.waitForLoadState("networkidle");
  if (phone(info)) await page.getByTestId("agent-status-phone").click();
  else await page.getByRole("button", { name: "Open the thread" }).click();
  await expect(page.getByTestId("agent-panel")).toBeVisible();
  await page.waitForTimeout(600);
  await page.getByTestId("agent-orb-menu").click();
  const menu = page.getByTestId("agent-orb-options");
  await expect(menu).toBeVisible();
  const pick = menu.getByRole("radiogroup", { name: "Avatar" });
  await expect(pick.getByRole("radio", { name: "Hydra" })).toHaveAttribute("aria-checked", "true");
  await pick.getByRole("radio", { name: "Tony" }).click();
  await expect(pick.getByRole("radio", { name: "Tony" })).toHaveAttribute("aria-checked", "true");
  await expect(menu).toBeVisible(); // the switch keeps the menu open
  // Saved for every device: a fresh read of /api/agent/state has it.
  const active = await page.evaluate(async () => (await (await fetch("/api/agent/state")).json()).activeAvatar?.name);
  expect(active).toBe("Tony");
  await pick.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await shot(page, info, "04-orb-menu");
});
