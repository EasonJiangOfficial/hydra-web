import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/kit";

const isPhone = (info: TestInfo) => info.project.name === "phone";
const width = (info: TestInfo) => (isPhone(info) ? 390 : 1440);

/** Hover on desktop, tap on the phone. */
async function reveal(page: Page, info: TestInfo, locator: ReturnType<Page["locator"]>) {
  await locator.scrollIntoViewIfNeeded();
  if (isPhone(info)) await locator.tap();
  else await locator.hover();
}

/** Scroll through the page so every chart draws in once, then back to the top. */
async function drawEverything(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 300) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1200);
}

test.describe("/dev/kit", () => {
  test("renders the hero figure", async ({ page }, info) => {
    await page.goto("/dev/kit");
    const hero = page.getByTestId("hero-figure");
    await expect(hero).toBeVisible();
    await expect(hero).toContainText(isPhone(info) ? "$48,212" : "$48,212.40");
  });

  test("clicking a Seg item moves the active state", async ({ page }, info) => {
    await page.goto("/dev/kit");
    // One scope switch per width (phone labels are short); only the visible one counts.
    const scope = page.getByRole("radiogroup", { name: "Scope" }).filter({ visible: true });
    const personal = isPhone(info) ? "Me" : "Personal";
    await expect(scope.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
    await scope.getByRole("radio", { name: personal }).click();
    await expect(scope.getByRole("radio", { name: personal })).toHaveAttribute("aria-checked", "true");
    await expect(scope.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("ArrowRight");
    await expect(scope.getByRole("radio", { name: "UGC" })).toHaveAttribute("aria-checked", "true");
  });

  test("an InfoDot shows its explanation", async ({ page }, info) => {
    await page.goto("/dev/kit");
    const text = page.getByText("Money in this month, before card bills are paid.");
    await expect(text).toBeHidden();
    await reveal(page, info, page.getByRole("button", { name: "More info" }).first());
    await expect(text).toBeVisible();
  });

  test("a DayCell shows its card", async ({ page }, info) => {
    await page.goto("/dev/kit");
    const day = page.getByTestId("posting-calendar").getByRole("button").nth(3);
    await reveal(page, info, day);
    await expect(page.getByText("0 of 3 posted")).toBeVisible();
    await expect(page.getByText("-$90 missed")).toBeVisible();
  });

  test("?task=1 opens the drawer, focus stays inside, Esc closes it", async ({ page }, info) => {
    await page.goto("/dev/kit?task=1");
    const drawer = page.getByRole("dialog", { name: "Task" });
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("Film three Wordwise hooks");
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, `kit-drawer-${width(info)}.png`) });

    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/task=/);
  });

  test("Tabs and Seg work inside the drawer with no page error", async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/dev/kit?goal=1");
    const drawer = page.getByRole("dialog", { name: "Goal" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("Post 3 videos a day")).toBeVisible();
    const range = drawer.getByRole("radiogroup", { name: "Range" });
    await range.getByRole("radio", { name: "October" }).click();
    await expect(range.getByRole("radio", { name: "October" })).toHaveAttribute("aria-checked", "true");
    await drawer.getByRole("tab", { name: "History" }).click();
    await expect(drawer.getByText("12 of 30 days met")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, `kit-drawer-tabs-${width(info)}.png`) });
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("the open-task button sets ?task=1", async ({ page }) => {
    await page.goto("/dev/kit");
    await page.getByRole("link", { name: "Open task" }).click();
    await expect(page).toHaveURL(/[?&]task=1/);
    const drawer = page.getByRole("dialog", { name: "Task" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/task=/);
  });

  test("closing the drawer returns focus to the control that opened it", async ({ page }) => {
    await page.goto("/dev/kit");
    // While the modal is open the page is aria-hidden, so find the opener by its href, not its role.
    const opener = page.locator('a[href="/dev/kit?task=1"]');
    await opener.click();
    const drawer = page.getByRole("dialog", { name: "Task" });
    await expect(drawer).toBeVisible();
    await expect(opener).not.toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("an InfoDot's text is its accessible description, closed and open", async ({ page }, info) => {
    await page.goto("/dev/kit");
    const text = "Money in this month, before card bills are paid. Updated 2 hours ago.";
    const dot = page.getByRole("button", { name: "More info" }).first();
    await expect(page.getByText(text)).toBeHidden();
    await expect(dot).toHaveAccessibleDescription(text);
    await reveal(page, info, dot);
    await expect(page.getByText(text)).toBeVisible();
    await expect(dot).toHaveAccessibleDescription(text);
  });

  test("charts are images with nothing focusable inside", async ({ page }) => {
    await page.goto("/dev/kit");
    await drawEverything(page);
    await expect(page.locator(".recharts-wrapper").first()).toBeAttached();
    const found = await page.locator('[role="img"]').evaluateAll((imgs) => ({
      charts: imgs.filter((el) => el.querySelector(".recharts-wrapper")).length,
      inner: imgs.flatMap((el) =>
        [...el.querySelectorAll('[tabindex]:not([tabindex="-1"]), [role="application"], a[href], button, input')].map(
          (n) => `${n.tagName} ${n.getAttribute("role") ?? ""} ${n.getAttribute("tabindex") ?? ""}`,
        ),
      ),
    }));
    expect(found.charts).toBeGreaterThanOrEqual(5);
    expect(found.inner).toEqual([]);
  });

  test("full-page screenshot", async ({ page }, info) => {
    await page.goto("/dev/kit");
    await drawEverything(page);
    await page.screenshot({ path: path.join(SHOTS, `kit-${width(info)}.png`), fullPage: true });
  });
});
