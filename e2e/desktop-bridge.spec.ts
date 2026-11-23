import { expect, test, type Page } from "@playwright/test";
import { BRIDGE_JS, DESKTOP_WINDOW, installBridge } from "./helpers/desktop-bridge";
import { emailCode, ownerEmail, bootstrapOwner } from "./helpers/supabase";

test.use(DESKTOP_WINDOW);

/** Hydra Desktop's real v2 bridge (e2e/helpers/desktop-bridge.ts) on this server's origin. */
const desktop = (page: Page, errors: string[]) => installBridge(page, new URL(test.info().project.use.baseURL ?? "").origin, errors);

const orb = (page: Page) => page.locator('[data-testid="agent-orb"]:visible');
const status = (page: Page) => page.locator('[data-testid="agent-status"]:visible');
const noErrorPage = async (page: Page) => expect(page.getByText(/This page couldn.t load/)).toHaveCount(0);

test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "Hydra Desktop is the Mac app only"));

test("the app shell runs under Hydra Desktop's real bridge, mirrors its state and sends wake", async ({ page }) => {
  const errors: string[] = [];
  await desktop(page, errors);
  await page.goto("/dev/agent");
  await expect(orb(page)).toBeVisible();
  await page.waitForLoadState("networkidle");
  await noErrorPage(page);
  expect(errors).toEqual([]);
  await expect(status(page)).toHaveText("Asleep");
  // The desktop pushes its state the way hydra.rs does: __hydraDesktopPush({ state, micLevel, outputLevel }).
  await page.evaluate(() => (window as unknown as { __hydraDesktopPush(m: unknown): void }).__hydraDesktopPush({ state: "Speaking", outputLevel: 0.6 }));
  await expect(status(page)).toHaveText("Speaking");
  await page.evaluate(() => (window as unknown as { __hydraDesktopPush(m: unknown): void }).__hydraDesktopPush({ state: "Asleep", outputLevel: 0 }));
  await expect(status(page)).toHaveText("Asleep");
  await orb(page).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __calls?: string[] }).__calls ?? [])).toContain("hydra-desktop://wake?t=t0ken");
  // Version 2 has no voice controls (stop, pause, mute): Mute and Pause are off, Stop stays on and sleeps the Mac.
  await page.evaluate(() => (window as unknown as { __hydraDesktopPush(m: unknown): void }).__hydraDesktopPush({ state: "Speaking" }));
  const card = page.getByTestId("agent-card");
  await expect(card.getByRole("button", { name: "Mute Hydra" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Pause" })).toBeDisabled();
  await card.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __calls?: string[] }).__calls ?? [])).toContain("hydra-desktop://sleep?t=t0ken");
  await noErrorPage(page);
  expect(errors).toEqual([]);
});

/*
 * Version 3 (W3 bridge v3): the same script with the voice controls and setup added, each a hydra-desktop:// call the
 * desktop answers through __hydraDesktopPush. setup() answers "all done", so the window opens with no gate.
 */
const V3_EXTRA = String.raw`
    stop: () => call('stop'),
    pause: () => call('pause'),
    resume: () => call('resume'),
    setMuted: (m) => call('mute', '&m=' + (m ? 1 : 0)),
    setup: () => Promise.resolve({ paired: true, claude: 'signed_in', permissions: { mic: 'granted', accessibility: 'granted', screen: 'granted' }, version: '0.3.0' }),
    pair: () => Promise.resolve({ ok: true }),
    signInClaude: () => Promise.resolve({ ok: true }),
    requestPermission: () => Promise.resolve('granted'),
    unpair: () => Promise.resolve(),`;

test("version 3: the card's voice controls reach the desktop, and its pushed reply and heard words show", async ({ page }) => {
  const errors: string[] = [];
  const origin = new URL(test.info().project.use.baseURL ?? "").origin;
  const script = BRIDGE_JS.replace("https://your-hydra.example.com", origin)
    .replace("__HYDRA_TOKEN__", "t0ken")
    .replace("version: 2,", "version: 3,")
    .replace("attach: () => call('attach'),", "attach: () => call('attach')," + V3_EXTRA)
    .replace("location.href = ", "(window.__calls = window.__calls || []).push(");
  await page.addInitScript(script.replace("+ extra; };", "+ extra); };"));
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  await page.goto("/dev/agent");
  await expect(orb(page)).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("setup-mac")).toHaveCount(0);
  const push = (m: unknown) => page.evaluate((x) => (window as unknown as { __hydraDesktopPush(m: unknown): void }).__hydraDesktopPush(x), m);
  await push({ state: "Speaking", outputLevel: 0.5, heard: { text: "Open planning", final: true }, reply: { id: "r1", text: "Opening Planning.", final: false } });
  await expect(status(page)).toHaveText("Speaking");
  const card = page.getByTestId("agent-card");
  await expect(card.getByTestId("agent-heard")).toHaveText("Open planning");
  await expect(card.getByTestId("agent-reply")).toContainText("Opening Planning.");
  await card.getByRole("button", { name: "Pause" }).click();
  await card.getByRole("button", { name: "Mute Hydra" }).click();
  await card.getByRole("button", { name: "Stop" }).click();
  const calls = () => page.evaluate(() => (window as unknown as { __calls?: string[] }).__calls ?? []);
  await expect.poll(calls).toEqual(expect.arrayContaining(["hydra-desktop://pause?t=t0ken", "hydra-desktop://mute?t=t0ken&m=1", "hydra-desktop://stop?t=t0ken"]));
  await noErrorPage(page);
  expect(errors).toEqual([]);
});

test.describe("signed in on local Supabase", () => {
  test.skip(!process.env.SUPABASE_E2E, "set SUPABASE_E2E=1 with local Supabase running");

  test("email-code sign-in inside Hydra Desktop lands on a working Dashboard", async ({ page }) => {
    test.setTimeout(90_000);
    bootstrapOwner();
    const errors: string[] = [];
    await desktop(page, errors);
    await page.goto("/login");
    // Inside the desktop the login offers one filled "Email me a code" (no passkeys in WKWebView).
    await page.getByRole("button", { name: "Email me a code" }).click();
    await page.getByRole("textbox", { name: "Email" }).fill(ownerEmail());
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByText("Check your email")).toBeVisible();
    await page.getByRole("textbox", { name: "Code" }).fill(await emailCode(ownerEmail()));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await page.waitForLoadState("networkidle");
    await noErrorPage(page);
    expect(errors).toEqual([]);
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    for (const path of ["/planning", "/reports", "/taxes", "/"]) {
      await page.goto(path);
      await expect(orb(page)).toBeVisible();
      await page.waitForLoadState("networkidle");
      await noErrorPage(page);
    }
    await page.reload();
    await expect(orb(page)).toBeVisible();
    await noErrorPage(page);
    expect(errors).toEqual([]);
  });
});
