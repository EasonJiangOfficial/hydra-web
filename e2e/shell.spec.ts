import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { pickScope, scopeMenu } from "./helpers/scope";

/* The app shell on its /dev fixture: the real routes sit behind login once auth lands. */

const ORDER = ["Dashboard", "Planning", "Notes", "Routines", "UGC Tracker", "Personal Brand", "Reports", "Transactions", "Taxes", "Accounts", "Activity", "Settings"];
const PAGES = [
  ["dashboard", "Dashboard"],
  ["planning", "Planning"],
  ["notes", "Notes"],
  ["ugc", "UGC Tracker"],
  ["brand", "Personal Brand"],
  ["reports", "Reports"],
  ["transactions", "Transactions"],
  ["taxes", "Taxes"],
  ["accounts", "Accounts"],
  ["routines", "Routines"],
  ["settings", "Settings"],
] as const;

/** Screenshots go to SHOTS_DIR when set (the lane's shots folder), else into the test output. */
function shot(info: TestInfo, name: string) {
  return process.env.SHOTS_DIR ? `${process.env.SHOTS_DIR}/${name}` : info.outputPath(name);
}

const desktopOnly = (info: TestInfo) => test.skip(info.project.name !== "desktop", "desktop only");
const phoneOnly = (info: TestInfo) => test.skip(info.project.name !== "phone", "phone only");

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Main" });
const width = async (page: Page) => (await sidebar(page).boundingBox())?.width;

async function settle(page: Page) {
  // Content fades in and the scope switch hydrates; wait for both before measuring or shooting.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(350);
}

test.describe("desktop", () => {
  test.beforeEach(({}, info) => desktopOnly(info));

  test("sidebar lists the twelve pages (Settings last) in order and marks the active one", async ({ page }, info) => {
    await page.goto("/dev/shell");
    await settle(page);
    const links = sidebar(page).getByRole("link");
    await expect(links).toHaveCount(ORDER.length);
    const names = await links.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    expect(names).toEqual([...ORDER]);
    await expect(sidebar(page).getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(1);
    // "Ask Hydra" is gone (owner, 2026-11-21); the Hydra Agent orb replaces it in U13.
    await expect(page.getByRole("link", { name: "Ask Hydra" })).toHaveCount(0);
    expect(await width(page)).toBe(232);
    await expect(page.getByRole("navigation", { name: "Tabs" })).toBeHidden();
    await page.screenshot({ path: shot(info, "shell-1440-open.png") });
  });

  test("[ collapses to 64 and back to 232; the chevrons do the same; inputs swallow the key", async ({ page }) => {
    await page.goto("/dev/shell");
    await settle(page);
    await page.keyboard.press("[");
    await expect.poll(() => width(page)).toBe(64);
    await page.keyboard.press("[");
    await expect.poll(() => width(page)).toBe(232);

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect.poll(() => width(page)).toBe(64);
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect.poll(() => width(page)).toBe(232);

    await page.evaluate(() => {
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();
    });
    await page.keyboard.press("[");
    await page.waitForTimeout(300);
    expect(await width(page)).toBe(232);
  });

  test("the collapse and expand buttons hand focus to each other", async ({ page }) => {
    await page.goto("/dev/shell");
    await settle(page);
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => width(page)).toBe(232);
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeFocused();
  });

  test("closed state survives a reload with no width flash", async ({ page }, info) => {
    await page.goto("/dev/shell");
    await settle(page);
    await page.keyboard.press("[");
    await expect.poll(() => width(page)).toBe(64);

    // Record every width the sidebar ever lays out at, from its first frame on.
    await page.addInitScript(() => {
      const seen: number[] = [];
      (window as unknown as { __widths: number[] }).__widths = seen;
      new MutationObserver((_, mo) => {
        const nav = document.querySelector('[data-testid="sidebar"]');
        if (!nav) return;
        mo.disconnect();
        new ResizeObserver((entries) => {
          for (const e of entries) seen.push(e.borderBoxSize[0].inlineSize);
        }).observe(nav);
      }).observe(document, { childList: true, subtree: true });
    });
    await page.reload();
    await settle(page);
    const widths = await page.evaluate(() => (window as unknown as { __widths: number[] }).__widths);
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.every((w) => w === 64)).toBe(true);
    expect(await width(page)).toBe(64);
    await page.screenshot({ path: shot(info, "shell-1440-closed.png") });
  });

  test("a collapsed icon shows the page name on hover", async ({ page }, info) => {
    await page.goto("/dev/shell");
    await settle(page);
    await page.keyboard.press("[");
    await expect.poll(() => width(page)).toBe(64);
    await sidebar(page).getByRole("link", { name: "Planning" }).hover();
    await expect(page.getByRole("tooltip")).toHaveText("Planning");
    await page.waitForTimeout(250);
    await page.screenshot({ path: shot(info, "shell-1440-closed-tooltip.png") });
    // Open sidebars show labels, so no tooltip.
    await page.keyboard.press("[");
    await expect.poll(() => width(page)).toBe(232);
    await page.mouse.move(800, 400);
    await sidebar(page).getByRole("link", { name: "Reports" }).hover();
    await page.waitForTimeout(300);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  });

  test("scope switch writes ?scope= and the nav links keep it", async ({ page }) => {
    await page.goto("/dev/shell");
    await settle(page);
    const scope = page.getByRole("radiogroup", { name: "Scope" }).filter({ visible: true });
    await scope.getByRole("radio", { name: "UGC" }).click();
    await expect(page).toHaveURL(/\/dev\/shell\?scope=ugc$/);
    await expect(scope.getByRole("radio", { name: "UGC" })).toHaveAttribute("aria-checked", "true");
    await expect(sidebar(page).getByRole("link", { name: "Planning" })).toHaveAttribute("href", "/planning?scope=ugc");
    await expect(sidebar(page).getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/?scope=ugc");

    await scope.getByRole("radio", { name: "Personal" }).click();
    await expect(page).toHaveURL(/\?scope=personal$/);
    await expect(sidebar(page).getByRole("link", { name: "Taxes" })).toHaveAttribute("href", "/taxes?scope=personal");

    await scope.getByRole("radio", { name: "All" }).click();
    await expect(page).toHaveURL(/\/dev\/shell$/);
    await expect(sidebar(page).getByRole("link", { name: "Planning" })).toHaveAttribute("href", "/planning");

    // A hard load with a scope keeps it in the links too.
    await page.goto("/dev/shell?scope=ugc");
    await settle(page);
    await expect(sidebar(page).getByRole("link", { name: "Reports" })).toHaveAttribute("href", "/reports?scope=ugc");
  });

  test("collapse animates no layout property: width snaps, labels fade by opacity", async ({ page }, info) => {
    await page.goto("/dev/shell");
    await settle(page);
    const layoutTransitions = () =>
      sidebar(page).evaluate((nav) =>
        [nav, ...nav.querySelectorAll("*")].flatMap((el) => {
          // Every element computes `all 0s` by default; only properties with a real duration animate.
          const cs = getComputedStyle(el);
          const props = cs.transitionProperty.split(", ");
          const times = cs.transitionDuration.split(", ");
          return props.filter(
            (p, i) =>
              parseFloat(times[i % times.length]) > 0 &&
              /^(all|width|height|padding[\w-]*|margin[\w-]*|grid[\w-]*|inset|top|left|right|bottom)$/.test(p),
          );
        }),
      );
    expect(await layoutTransitions()).toEqual([]);

    // Right after the key the width is already final, and the only transitions running are opacity (and the
    // visibility flip that rides with it). getAnimations() flushes style, so this does not depend on frame timing.
    const label = sidebar(page).getByRole("link", { name: "Planning" }).locator("span");
    await expect(label).toHaveCSS("transition-property", "opacity, visibility");
    await expect(label).toHaveCSS("transition-duration", "0.2s");
    const mid = await page.evaluate(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "[" }));
      await new Promise((r) => requestAnimationFrame(r));
      const nav = document.querySelector('[data-testid="sidebar"]') as HTMLElement;
      const running = nav
        .getAnimations({ subtree: true })
        .map((a) => (a as CSSTransition).transitionProperty ?? "animation");
      return { width: nav.getBoundingClientRect().width, running: [...new Set(running)].sort() };
    });
    expect(mid.width).toBe(64);
    expect(mid.running).toContain("opacity");
    expect(mid.running.filter((p) => p !== "opacity" && p !== "visibility")).toEqual([]);
    await page.waitForTimeout(300);
    await expect(label).toHaveCSS("opacity", "0");
    expect(await layoutTransitions()).toEqual([]);
    await page.screenshot({ path: shot(info, "shell-1440-closed-live.png") });
  });

  test("the Dashboard top bar shows today's date", async ({ page }) => {
    await page.goto("/dev/shell");
    await settle(page);
    const today = await page.evaluate(() =>
      new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
    );
    await expect(page.locator("main time")).toHaveText(today);
  });
});

test.describe("phone", () => {
  test.beforeEach(({}, info) => phoneOnly(info));

  test("bottom tabs replace the sidebar and More opens the sheet", async ({ page }, info) => {
    await page.goto("/dev/shell");
    await settle(page);
    await expect(sidebar(page)).toBeHidden();
    const tabs = page.getByRole("navigation", { name: "Tabs" });
    await expect(tabs).toBeVisible();
    const names = await tabs.locator("a, button").evaluateAll((els) => els.map((e) => e.textContent?.trim()));
    expect(names).toEqual(["Home", "Plan", "UGC", "Reports", "More"]);
    await expect(tabs.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    expect((await tabs.boundingBox())?.height).toBe(68);
    await expect(page.getByRole("link", { name: "Ask Hydra" })).toHaveCount(0);
    await page.screenshot({ path: shot(info, "shell-390.png") });

    await tabs.getByRole("button", { name: "More" }).click();
    const sheet = page.getByRole("dialog", { name: "More" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("link")).toHaveText(["Notes", "Routines", "Personal Brand", "Transactions", "Taxes", "Accounts", "Activity", "Settings"]);
    await page.waitForTimeout(350);
    await page.screenshot({ path: shot(info, "shell-390-more.png") });
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("phone scope menu lists All, Me and UGC, and the tabs keep the scope", async ({ page }) => {
    await page.goto("/dev/shell");
    await settle(page);
    await expect(page.getByRole("radiogroup", { name: "Scope" }).filter({ visible: true })).toHaveCount(0);
    await scopeMenu(page).click();
    await expect(page.getByRole("menuitemradio")).toHaveText(["All", "Me", "UGC"]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitemradio")).toHaveCount(0);
    await pickScope(page, "Me");
    await expect(page).toHaveURL(/\?scope=personal$/);
    await expect(scopeMenu(page)).toHaveText("Me");
    const tabs = page.getByRole("navigation", { name: "Tabs" });
    await expect(tabs.getByRole("link", { name: "Plan" })).toHaveAttribute("href", "/planning?scope=personal");
  });
});

test("the Dashboard has exactly one h1 at every width", async ({ page }) => {
  await page.goto("/dev/shell");
  await settle(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
});

for (const [key, title] of PAGES) {
  test(`loading skeleton: ${key}`, async ({ page }, info) => {
    await page.goto(`/dev/shell/loading/${key}`);
    await settle(page);
    await expect(page.getByRole("status", { name: `Loading ${title}` })).toBeVisible();
    if (key !== "dashboard") await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    const active = info.project.name === "desktop" ? sidebar(page).locator('[aria-current="page"]') : null;
    if (active) await expect(active).toHaveAttribute("aria-label", title);
    const size = info.project.name === "desktop" ? 1440 : 390;
    // Phone shots stay at viewport size: fixed tabs land mid-page in a full-page capture.
    await page.screenshot({ path: shot(info, `loading-${key}-${size}.png`), fullPage: info.project.name === "desktop" });
  });
}

/* next.config.ts headers: the voice agent needs the mic (Permissions-Policy microphone=(self)) and plays
   each Fish Audio reply from a blob: URL (CSP media-src 'self' blob:). Camera and the rest stay off. */
test("security headers let the agent hear and speak", async ({ page, context }, info) => {
  desktopOnly(info);
  await context.grantPermissions(["microphone"]);
  const res = await page.goto("/login");
  const headers = res!.headers();
  expect(headers["permissions-policy"]).toContain("microphone=(self)");
  expect(headers["content-security-policy"]).toContain("media-src 'self' blob:");

  const probe = await page.evaluate(async () => {
    const policy = (document as unknown as { featurePolicy?: { allowsFeature(f: string): boolean } }).featurePolicy;
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) => violations.push(`${e.effectiveDirective} ${e.blockedURI}`));
    // 0.1 s of silent 8 kHz mono PCM: a valid WAV the browser can decode.
    const n = 800;
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF"); v.setUint32(4, 36 + n, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, "data"); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
    const audio = new Audio();
    const loaded = await new Promise<string>((resolve) => {
      audio.oncanplay = () => resolve("canplay");
      audio.onerror = () => resolve(`error ${audio.error?.code}`);
      audio.src = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    });
    return {
      mic: policy?.allowsFeature("microphone") ?? null,
      camera: policy?.allowsFeature("camera") ?? null,
      loaded,
      violations,
    };
  });
  expect(probe).toEqual({ mic: true, camera: false, loaded: "canplay", violations: [] });
});
