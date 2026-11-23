import { expect, test, type Page } from "@playwright/test";

/**
 * Tab press -> first paint on the UGC Tracker. A capture-phase pointerdown marks the press; a frame loop marks
 * the first frame where the pressed tab's panel shows anything (its skeleton or its content). The number is
 * logged (`tab-paint <tab> <ms>`) and must stay under 100 ms.
 */
async function pressToPaint(page: Page, name: string): Promise<number> {
  await page.evaluate((tab) => {
    const w = window as unknown as { __tabPaint?: Promise<number> };
    w.__tabPaint = new Promise<number>((resolve) => {
      const onDown = (e: Event) => {
        const t = (e.target as Element | null)?.closest('[role="tab"]');
        if (!t || t.textContent?.trim() !== tab) return;
        document.removeEventListener("pointerdown", onDown, true);
        const press = performance.mark("tab-press").startTime;
        const id = t.getAttribute("aria-controls");
        const frame = () => {
          const panel = id ? document.getElementById(id) : null;
          if (panel && panel.getAttribute("data-state") === "active" && panel.childElementCount > 0) {
            // The frame's paint follows this callback; one more frame makes sure it happened.
            requestAnimationFrame(() => {
              performance.mark("tab-paint");
              resolve(performance.measure("tab-press-to-paint", "tab-press", "tab-paint").duration ?? performance.now() - press);
            });
          } else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      };
      document.addEventListener("pointerdown", onDown, true);
    });
  }, name);
  await page.getByRole("tab", { name, exact: true }).click();
  return page.evaluate(() => (window as unknown as { __tabPaint: Promise<number> }).__tabPaint);
}

/** Holds every server round trip (RSC fetch) back 400 ms: the live page reads the database on each one. */
async function slowServer(page: Page) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.headers()["rsc"] === "1" || req.url().includes("_rsc=")) await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
}

for (const slow of [false, true]) {
  test(`every tab paints under 100 ms after the press, and the URL follows${slow ? " (slow server)" : ""}`, async ({ page }, info) => {
    if (slow) await slowServer(page);
    await page.goto("/dev/ugc");
    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
    await page.waitForTimeout(500);
    const times: Record<string, number[]> = { Videos: [], Deals: [], Overview: [] };
    for (let round = 0; round < 3; round++) {
      for (const tab of ["Videos", "Deals", "Overview"] as const) {
        const ms = await pressToPaint(page, tab);
        times[tab].push(ms);
        await expect(page.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("data-state", "active");
        if (tab === "Overview") await expect(page).not.toHaveURL(/tab=/);
        else await expect(page).toHaveURL(new RegExp(`tab=${tab.toLowerCase()}`));
        await page.waitForTimeout(400);
      }
    }
    for (const [tab, list] of Object.entries(times)) {
      const worst = Math.max(...list);
      console.log(`tab-paint ${slow ? "slow" : "fast"} ${info.project.name} ${tab} ${list.map((n) => n.toFixed(1)).join(" ")} worst ${worst.toFixed(1)}`);
      expect(worst, `${tab} press -> first paint`).toBeLessThan(100);
    }
    // A panel once shown stays mounted but hidden, so going back to it costs no render.
    await expect(page.getByTestId("video-summary")).toBeHidden();
    await page.getByRole("tab", { name: "Videos" }).click();
    await expect(page.getByTestId("video-summary")).toContainText("160 videos");
  });
}
