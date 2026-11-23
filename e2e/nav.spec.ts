import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers/supabase";

/*
 * Page changes on the real (signed-in) app: the ink bar runs from the click, the new page's skeleton shows,
 * then the content, and the bar goes. Local Supabase only (SUPABASE_E2E=1), like the auth flow.
 */

const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/nav";
mkdirSync(SHOTS, { recursive: true });
const width = (page: Page) => page.viewportSize()?.width ?? 0;
const bar = (page: Page) => page.getByTestId("nav-progress");
const opacity = (page: Page) => bar(page).evaluate((el) => getComputedStyle(el).opacity);

/** Holds the next page's server data back, so the skeleton and the running bar can be seen. */
async function holdPageData(page: Page, ms: number) {
  await page.route(
    (url) => url.searchParams.has("_rsc"),
    async (route) => {
      if (route.request().headers()["next-router-prefetch"]) return route.continue();
      const response = await route.fetch();
      await new Promise((r) => setTimeout(r, ms));
      await route.fulfill({ response });
    },
  );
}

test.describe("page changes", () => {
  test.skip(!process.env.SUPABASE_E2E, "set SUPABASE_E2E=1 with local Supabase running");

  test.beforeEach(async ({ page, baseURL }) => {
    await signIn(page, baseURL!);
  });

  test("the bar runs from the click, the skeleton shows, then the content, then the bar goes", async ({ page }) => {
    await page.goto("/accounts");
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await opacity(page)).toBe("0");

    await holdPageData(page, 1500);
    const phone = width(page) < 768;
    const link = phone
      ? page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: "Reports" })
      : page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reports" });
    await link.click();

    // At once: the bar is on and the Reports skeleton is up.
    await expect.poll(() => opacity(page)).toBe("1");
    await expect(page.getByRole("status", { name: "Loading Reports" })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, `loading-${width(page)}.png`) });

    // The content replaces the skeleton and the bar fades out.
    await expect(page.getByRole("status", { name: "Loading Reports" })).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
    // The content that replaced the skeleton faded in (the layout's mount fade on each top block).
    expect(await page.locator("main > .contents > div > *").last().evaluate((el) => getComputedStyle(el).animationName)).toBe("hy-fade");
    await expect.poll(() => opacity(page)).toBe("0");
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, `loaded-${width(page)}.png`) });
  });

  test("on the UGC page the bar finishes while the analytics below the fold still wait for a scroll", async ({ page }) => {
    await page.goto("/accounts");
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await holdPageData(page, 800);
    const phone = width(page) < 768;
    const link = phone
      ? page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: "UGC" })
      : page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "UGC Tracker" });
    await link.click();
    await expect.poll(() => opacity(page)).toBe("1");
    await expect(page.getByRole("heading", { name: "UGC Tracker" })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => opacity(page), { timeout: 2_000 }).toBe("0");
    test.info().annotations.push({ type: "lazy skeletons", description: String(await page.locator("[data-lazy] [data-slot=skeleton]").count()) });
  });

  test("a page change that shows at once never flashes the bar (Back to a page in the cache)", async ({ page }) => {
    await page.goto("/accounts");
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const phone = width(page) < 768;
    const link = phone
      ? page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: "Reports" })
      : page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reports" });
    await link.click();
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => opacity(page), { timeout: 5_000 }).toBe("0");
    // Watch the bar's opacity from here on.
    await bar(page).evaluate((el) => {
      const w = window as unknown as { barSeen: string[] };
      w.barSeen = [];
      new MutationObserver(() => w.barSeen.push(el.style.opacity)).observe(el, { attributes: true, attributeFilter: ["style"] });
    });
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as unknown as { barSeen: string[] }).barSeen)).not.toContain("1");
  });

  test("with reduced motion the bar is a still, full bar", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/accounts");
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await holdPageData(page, 1500);
    const phone = width(page) < 768;
    const link = phone
      ? page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: "Plan" })
      : page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Taxes" });
    await link.click();
    await expect.poll(() => opacity(page)).toBe("1");
    const fill = await bar(page).evaluate((el) => ({ transform: getComputedStyle(el).transform, transition: el.style.transition }));
    expect(fill.transition).toBe("none");
    expect(fill.transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
    await page.screenshot({ path: path.join(SHOTS, `loading-reduced-${width(page)}.png`) });
    await expect.poll(() => opacity(page), { timeout: 10_000 }).toBe("0");
  });
});
