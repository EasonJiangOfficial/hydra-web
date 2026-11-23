import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  addVirtualAuthenticator,
  bootstrapOwner,
  deleteOwnerPasskeys,
  ownerEmail,
  ownerTimeZone,
  emailCode,
} from "./helpers/supabase";

const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/auth";
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, name), animations: "disabled" });
const width = (page: Page) => page.viewportSize()?.width ?? 0;
/** The fixture's own storage prefix (the real app uses `hydra:`). */
const FIXTURE_LOCKED = "hydra-dev-lock:locked";

test.describe("auth gate", () => {
  for (const [from, next] of [
    ["/", "%2F"],
    ["/planning", "%2Fplanning"],
  ]) {
    test(`unauthenticated ${from} redirects to /login`, async ({ page }) => {
      await page.goto(from);
      await expect(page).toHaveURL(`/login?next=${next}`);
    });
  }

  test("login shows the lockup and exactly one filled button", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("lockup")).toBeVisible();
    await expect(page.locator("[data-filled]:visible")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Email me a code" })).toBeVisible();
    await shot(page, `login-${width(page)}.png`);
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(page.getByRole("textbox", { name: "Email" })).toBeFocused();
    await expect(page.locator("[data-filled]:visible")).toHaveCount(1);
  });

  test("an off-site next is not followed", async ({ page, baseURL }) => {
    // A protocol-relative path never becomes next=//evil.example: it stays a same-origin path.
    await page.goto(`${baseURL}//evil.example/x`);
    await expect(page).toHaveURL("/login?next=%2Fevil.example%2Fx");
    // The login page stays put; the full flow below proves where a sign-in with this next lands.
    await page.goto("/login?next=https://evil.example");
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/login\?next=https/);
  });

  test("a bad email link lands on login with a short error", async ({ page }) => {
    await page.goto("/auth/callback?code=bogus&next=https%3A%2F%2Fevil.example");
    await expect(page).toHaveURL("/login?error=link");
    await expect(page.getByText("Link failed.")).toBeVisible();
  });

  test("the link error does not follow the owner into the email step", async ({ page }) => {
    await page.goto("/login?error=link");
    await expect(page.getByText("Link failed.")).toBeVisible();
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
    await expect(page.getByText("Link failed.")).toHaveCount(0);
  });

  test("inside Hydra Desktop: no passkey, one filled button to email a code", async ({ page }) => {
    // The desktop window adds window.hydraDesktop before the page runs; its web view has no passkeys.
    await page.addInitScript(() => Object.defineProperty(window, "hydraDesktop", { value: Object.freeze({ version: 1 }) }));
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in with passkey" })).toHaveCount(0);
    await expect(page.locator("[data-filled]:visible")).toHaveCount(1);
    await shot(page, `login-desktop-${width(page)}.png`);
    await page.getByRole("button", { name: "Email me a code" }).click();
    await page.getByRole("textbox", { name: "Email" }).fill("nobody@example.com");
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
    await shot(page, `login-desktop-email-${width(page)}.png`);
  });

  test("the login HTML already holds both buttons, so nothing jumps on hydration", async ({ request }) => {
    const html = await (await request.get("/login")).text();
    expect(html).toContain("Sign in with passkey");
    expect(html).toContain("Email me a code");
  });
});

test.describe("idle lock fixture", () => {
  test("locked state shows only the lock screen", async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, "1"), FIXTURE_LOCKED);
    await page.goto("/dev/auth-lock");
    const lock = page.getByTestId("idle-lock");
    await expect(lock).toBeVisible();
    await expect(lock.locator("[data-filled]")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Unlock with passkey" })).toBeFocused();
    // The app is unmounted, not hidden: no page data stays in the DOM.
    await expect(page.getByTestId("fixture-content")).toHaveCount(0);
    await shot(page, `lock-${width(page)}.png`);
  });

  test("locks after the limit, removes open portals, ignores activity on the lock, survives reload", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.clock.install();
    await page.goto("/dev/auth-lock");
    await expect(page.getByTestId("fixture-content")).toBeVisible();
    await page.getByRole("button", { name: "Open sheet" }).click();
    await expect(page.getByTestId("fixture-sheet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Inside the sheet" })).toBeFocused();
    await page.clock.fastForward("00:50");
    await expect(page.getByTestId("idle-lock")).toHaveCount(0);
    await page.clock.fastForward("00:15");
    await expect(page.getByTestId("idle-lock")).toBeVisible();
    // The sheet's portal and focus trap are gone with the app; Unlock keeps focus.
    await expect(page.getByTestId("fixture-sheet")).toHaveCount(0);
    await expect(page.getByTestId("fixture-content")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Unlock with passkey" })).toBeFocused();
    await page.mouse.move(100, 100);
    await page.keyboard.press("Shift");
    await expect(page.getByTestId("idle-lock")).toBeVisible();
    // The fixture never touches the real app's lock.
    expect(await page.evaluate(() => localStorage.getItem("hydra:locked"))).toBeNull();
    await page.reload();
    await expect(page.getByTestId("idle-lock")).toBeVisible();
    await expect(page.getByTestId("fixture-content")).toHaveCount(0);
    expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
  });

  test("before JS runs, the app paints when unlocked and is hidden when locked", async ({ page }) => {
    // Block the app's JS: only the server HTML and the inline pre-paint script run.
    await page.route("**/_next/static/chunks/**", (route) => route.abort());
    await page.goto("/dev/auth-lock");
    await expect(page.getByTestId("fixture-content")).toBeVisible();
    await page.evaluate((key) => localStorage.setItem(key, "1"), FIXTURE_LOCKED);
    await page.reload();
    await expect(page.getByTestId("fixture-content")).toBeHidden();
  });
});

test.describe("full flow on local Supabase", () => {
  test.skip(!process.env.SUPABASE_E2E, "set SUPABASE_E2E=1 with local Supabase running");

  test("email code, add passkey, sign out, passkey sign-in, fixture unlock, stays signed in", async ({ page }) => {
    // One owner is shared state: run the flow on one project only (the phone, for the 390 px shots).
    test.skip(test.info().project.name !== "phone", "phone project only");
    test.setTimeout(90_000);
    bootstrapOwner();
    const userId = await deleteOwnerPasskeys();
    await addVirtualAuthenticator(page);

    // Email-code sign-in, with an off-site next that must be ignored. One email only: sends are rate-limited.
    await page.goto("/login?next=https%3A%2F%2Fevil.example");
    await page.getByRole("button", { name: "Email me a code" }).click();
    await page.getByRole("textbox", { name: "Email" }).fill(ownerEmail());
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByText("Check your email")).toBeVisible();
    const codeBox = page.getByRole("textbox", { name: "Code" });
    await expect(codeBox).toBeFocused();
    await expect(page.getByRole("button", { name: "Use a passkey" })).toBeVisible();
    // A pasted code with a space keeps all six digits; a wrong code says so.
    await codeBox.fill("123 456");
    await expect(codeBox).toHaveValue("123456");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Code failed.")).toBeVisible();
    await shot(page, `login-code-${width(page)}.png`);
    // After a reload the code box is one tap away, with no new email.
    await page.reload();
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(codeBox).toBeVisible();
    await codeBox.fill(await emailCode(ownerEmail()));
    await page.getByRole("button", { name: "Sign in" }).click();

    // No passkey yet: one screen to add one.
    const add = page.getByRole("button", { name: "Add a passkey" });
    await expect(add).toBeVisible();
    await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
    await shot(page, `add-passkey-${width(page)}.png`);
    await add.click();
    await page.waitForURL((url) => url.pathname === "/" && url.host.startsWith("localhost"));
    expect(await ownerTimeZone(userId)).toBeTruthy();

    // Sign out, then the gate is closed again.
    await page.request.post("/auth/signout", { maxRedirects: 0 });
    await page.goto("/planning");
    await expect(page).toHaveURL("/login?next=%2Fplanning");

    // Passkey sign-in honors next.
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await page.waitForURL((url) => url.pathname === "/planning");

    // Unlock the fixture's lock screen with the passkey (the virtual authenticator lives on this page).
    // Locking signs the session out; the passkey unlock signs it back in.
    await page.evaluate((key) => localStorage.setItem(key, "1"), FIXTURE_LOCKED);
    await page.goto("/dev/auth-lock");
    await page.getByRole("button", { name: "Unlock with passkey" }).click();
    await expect(page.getByTestId("idle-lock")).toHaveCount(0);
    await expect(page.getByTestId("fixture-content")).toBeVisible();

    // Stay signed in: close the tab, open a new one in the same browser. Cookies carry the session.
    const context = page.context();
    await page.close();
    const tab = await context.newPage();
    await tab.clock.install();
    await tab.goto("/");
    await expect(tab).toHaveURL("/");
    await expect(tab.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await shot(tab, `signed-in-dashboard-${width(tab)}.png`);
    // /login goes straight to the Dashboard, or to a same-origin next.
    await tab.goto("/login");
    await expect(tab).toHaveURL("/");
    await tab.goto("/login?next=/planning");
    await expect(tab).toHaveURL("/planning");
    await tab.goto("/login?next=https%3A%2F%2Fevil.example");
    await expect(tab).toHaveURL("/");
    // An error message still shows the login page.
    await tab.goto("/login?error=link");
    await expect(tab).toHaveURL("/login?error=link");
    await expect(tab.getByText("Link failed.")).toBeVisible();

    // No idle lock in the app: well past the old 5-minute limit, the page stays and the session holds.
    await tab.goto("/planning");
    await tab.clock.fastForward("10:00");
    await expect(tab.getByTestId("idle-lock")).toHaveCount(0);
    await expect(tab.getByRole("heading", { level: 1, name: "Planning" })).toBeVisible();
    expect((await context.cookies()).some((c) => c.name.startsWith("sb-"))).toBe(true);
    await tab.reload();
    await expect(tab).toHaveURL("/planning");
    await expect(tab.getByTestId("idle-lock")).toHaveCount(0);
  });
});
