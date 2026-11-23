import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { pickOption } from "./helpers/controls";

/*
 * Models (owner: "also could you allow me to connected different models and switch between them and their effort levels
 * like grok, chatgpt"). /dev/settings?tab=agent runs the real Agent tab; this spec answers /api/agent/state and
 * /api/agent/models/keys itself (no xAI call, no spend). /dev/agent?models=all: the orb menu with three providers.
 */

const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/models";
const phone = (info: TestInfo) => info.project.name === "phone";
const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: path.join(SHOTS, `models-${name}-${phone(info) ? 375 : 1440}.png`) });

const SETTINGS = { sleepWord: "Hydra, sleep", brain: "mac", wakePhrase: "Hey Hydra", clapSensitivity: "medium", model: "claude-opus-5-5", effortLive: "max", effortRoutine: "medium", approveAll: false, activeAvatarId: null };
const GOOD = "xai-e2e-0000000000000000004f2a";

async function routes(page: Page) {
  let settings: Record<string, unknown> = { ...SETTINGS };
  let key: { provider: string; hint: string; updatedAt: string } | null = null;
  const log = { patches: [] as unknown[], puts: [] as unknown[], deletes: 0 };
  const providers = () => ["anthropic", ...(key ? ["xai"] : [])];
  await page.route("**/api/agent/state", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      const body = req.postDataJSON() as Record<string, unknown>;
      log.patches.push(body);
      if (body.model === "grok-4.7" && !key) return route.fulfill({ status: 409, json: { error: "model_not_connected", message: "Connect Grok in Settings, Agent first." } });
      settings = { ...settings, ...body };
      if (settings.model === "grok-4.7") for (const k of ["effortLive", "effortRoutine"]) if (settings[k] === "max") settings[k] = "xhigh";
      return route.fulfill({ json: { ok: true, settings } });
    }
    return route.fulfill({ json: { threads: [], pendingApprovals: [], activity: [], notifications: [], settings, providers: providers() } });
  });
  await page.route("**/api/agent/avatars**", (route) => route.fulfill({ json: { avatars: [] } }));
  await page.route("**/api/agent/models/keys", async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      const body = req.postDataJSON() as { key: string };
      log.puts.push(body);
      if (body.key !== GOOD) return route.fulfill({ status: 400, json: { error: "key_refused", message: "xAI refused this key" } });
      key = { provider: "xai", hint: "4f2a", updatedAt: "2026-11-22T18:00:00Z" };
      return route.fulfill({ json: { key } });
    }
    if (req.method() === "DELETE") {
      log.deletes++;
      key = null;
      const moved = settings.model === "grok-4.7";
      if (moved) settings = { ...settings, model: "claude-opus-5-5" };
      return route.fulfill({ json: moved ? { ok: true, settings } : { ok: true } });
    }
    return route.fulfill({ json: { keys: key ? [key] : [] } });
  });
  return log;
}

test.beforeEach(async ({ page }, info) => {
  if (phone(info)) await page.setViewportSize({ width: 375, height: 812 });
});

test("Models card: Grok not connected, a refused key, connected, then Remove asks first", async ({ page }, info) => {
  const log = await routes(page);
  await page.goto("/dev/settings?tab=agent");
  const card = page.getByRole("region", { name: "Models" });
  await expect(card).toBeVisible();
  await expect(card.locator('[data-provider="xai"]')).toHaveAttribute("data-connected", "false");
  await expect(card.getByText("Sign in on the Mac")).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await shot(page, info, "01-not-connected");

  await card.getByRole("button", { name: "Connect" }).click();
  const field = card.getByLabel("xAI API key");
  await expect(field).toHaveAttribute("type", "password");
  await field.fill("xai-wrong-000000000000000000000");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("alert")).toHaveText("xAI refused this key");
  await page.waitForTimeout(250);
  await shot(page, info, "02-key-refused");

  await field.fill(GOOD);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("button", { name: "Remove" })).toBeVisible();
  await expect(card.locator('[data-provider="xai"]')).toHaveAttribute("data-connected", "true");
  expect(JSON.stringify(log.puts)).toContain(GOOD); // sent once to Hydra, never shown back
  await expect(page.getByText(GOOD)).toHaveCount(0);
  // The Brain card offers Grok now; picking it clamps Max to X-High and drops Max from the levels.
  await pickOption(page.getByRole("combobox", { name: "Model" }), { label: "Grok 4.7" });
  const live = page.getByRole("radiogroup", { name: "Effort live" });
  await expect(live.getByRole("radio", { name: "X-High" })).toHaveAttribute("aria-checked", "true");
  await expect(live.getByRole("radio", { name: "Max" })).toHaveCount(0);
  // Hover (a tap on the phone) on Grok: when the key was added, never the key.
  const grok = card.locator('[data-provider="xai"]').getByText("Grok");
  if (phone(info)) await grok.tap();
  else await grok.hover();
  await expect(page.getByText("Key ending ••4f2a, added 22 Nov").first()).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, info, "03-connected");

  await card.getByRole("button", { name: "Remove" }).click();
  const ask = card.getByRole("alertdialog", { name: "Remove the Grok key" });
  await expect(ask).toBeVisible();
  expect(log.deletes).toBe(0);
  await page.waitForTimeout(250);
  await shot(page, info, "04-remove-confirm");
  await ask.getByRole("button", { name: "Remove" }).click();
  await expect(card.getByRole("button", { name: "Connect" })).toBeVisible();
  expect(log.deletes).toBe(1);
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(/Opus 5\.5/);
});

async function openMenu(page: Page, info: TestInfo, url: string) {
  await page.goto(url);
  await expect(page.locator('[data-testid="agent-orb"]:visible')).toHaveCount(1);
  await page.waitForLoadState("networkidle");
  if (phone(info)) await page.getByTestId("agent-status-phone").click();
  else await page.getByRole("button", { name: "Open the thread" }).click();
  await expect(page.getByTestId("agent-panel")).toBeVisible();
  await page.waitForTimeout(600);
  await page.getByTestId("agent-orb-menu").click();
  const menu = page.getByTestId("agent-orb-options");
  await expect(menu).toBeVisible();
  return menu;
}

test("orb menu: Claude only looks as before; with ChatGPT and Grok connected it picks provider, model and effort", async ({ page }, info) => {
  let menu = await openMenu(page, info, "/dev/agent");
  await expect(menu.getByTestId("agent-provider")).toHaveCount(0);
  await expect(menu.getByTestId("agent-model").getByRole("radio")).toHaveText(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
  await expect(menu.getByTestId("agent-effort").getByRole("radio")).toHaveText(["Low", "Med", "High", "X-High", "Max"]);
  await expect(menu.getByTestId("agent-effort").getByRole("radio", { name: "Medium" })).toHaveAttribute("title", "Thinks a bit before it answers.");
  // Five levels fit the 288 px menu on one line, none cut.
  const cut = await menu.getByTestId("agent-effort").getByRole("radio").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).length);
  expect(cut).toBe(0);
  await page.waitForTimeout(250);
  await shot(page, info, "05-orb-claude-only");

  menu = await openMenu(page, info, "/dev/agent?models=all");
  const providers = menu.getByTestId("agent-provider");
  await expect(providers.getByRole("radio")).toHaveText(["Claude", "ChatGPT", "Grok"]);
  await menu.getByTestId("agent-effort").getByRole("radio", { name: "Max" }).click();
  await providers.getByRole("radio", { name: "Grok" }).click();
  await expect(menu.getByTestId("agent-model").getByRole("radio")).toHaveText(["Grok 4.7"]);
  await expect(menu.getByTestId("agent-effort").getByRole("radio")).toHaveText(["Low", "Med", "High", "X-High"]);
  await expect(menu.getByTestId("agent-effort").getByRole("radio", { name: "X-High" })).toHaveAttribute("aria-checked", "true");
  await expect(menu).toBeVisible();
  const saved = await page.evaluate(async () => (await (await fetch("/api/agent/state")).json()).settings);
  expect(saved).toMatchObject({ model: "grok-4.7", effortLive: "xhigh" });
  await page.waitForTimeout(250);
  await shot(page, info, "06-orb-grok");

  await providers.getByRole("radio", { name: "ChatGPT" }).click();
  await expect(menu.getByTestId("agent-model").getByRole("radio")).toHaveText(["Astra", "Sol"]);
  await menu.getByTestId("agent-model").getByRole("radio", { name: "Sol" }).click();
  await expect(menu.getByTestId("agent-model").getByRole("radio", { name: "Sol" })).toHaveAttribute("aria-checked", "true");
  const about = menu.getByRole("button", { name: "About model" });
  if (phone(info)) await about.tap();
  else await about.hover();
  await expect(page.getByText("ChatGPT runs on your Mac, on its ChatGPT sign-in. When the Mac is off, Claude answers.").first()).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, info, "07-orb-chatgpt");
});

test("orb menu fully loaded: 32 px segments on a touch screen, and a fade while more is below", async ({ page }, info) => {
  const menu = await openMenu(page, info, "/dev/agent?models=all&avatars=on");
  const hint = menu.getByTestId("agent-orb-more");
  const heights = await menu.locator('[role="radiogroup"]:not([data-testid="agent-avatar-pick"]) [role="radio"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetHeight));
  expect(heights.length).toBeGreaterThan(10);
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(phone(info) ? 32 : 28);
  const scrolls = await menu.evaluate((el) => el.scrollHeight - el.clientHeight > 2);
  // 375 x 812: the whole menu does not fit, so it says it scrolls (offsetHeight: the open animation scales it).
  if (phone(info)) expect(scrolls).toBe(true);
  if (scrolls) {
    await expect(hint).toHaveAttribute("data-more", "true");
    await page.waitForTimeout(300);
    await shot(page, info, "08-orb-full-more");
    await menu.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(hint).not.toHaveAttribute("data-more");
  } else {
    await expect(hint).not.toHaveAttribute("data-more");
  }
  await page.waitForTimeout(300);
  await shot(page, info, "09-orb-full-end");
});
