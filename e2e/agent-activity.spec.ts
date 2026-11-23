import { expect, test, type Page, type TestInfo } from "@playwright/test";

/*
 * The agent panel's activity (owner: "the activity list is blocking the side chat, redesign this"): no list in the
 * panel's flow; a header button opens it as a slide-over inside the panel. "This chat" and "Earlier", repeats folded
 * into a count, Undo per row, a failed undo said on its row. The fixture seeds rows with `?activity=one|many`.
 */

const phone = (info: TestInfo) => info.project.name.startsWith("phone");
const SILENT = `
  (() => {
    class Rec { start() {} stop() {} abort() {} }
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
const sheet = (page: Page) => page.getByTestId("agent-activity");

async function open(page: Page, info: TestInfo, query = "") {
  await page.goto(`/dev/agent${query}`);
  await expect(page.locator('[data-testid="agent-orb"]:visible')).toHaveCount(1);
  await page.waitForLoadState("networkidle");
  if (phone(info)) await page.getByTestId("agent-status-phone").click();
  else await page.getByRole("button", { name: "Open the thread" }).click();
  await expect(panel(page)).toBeVisible();
}

test("the thread takes the panel; the header button opens the activity over it and every way out closes it", async ({ page }, info) => {
  await open(page, info, "?activity=one");
  await expect(sheet(page)).toHaveCount(0);
  await page.waitForTimeout(400); // the panel's slide
  const thread = await page.getByTestId("agent-thread").boundingBox();
  const composer = await panel(page).getByLabel("Message Hydra").boundingBox();
  expect(composer!.y).toBeGreaterThan(thread!.y + thread!.height - 1); // nothing between the thread and the composer

  const button = panel(page).getByRole("button", { name: "Activity", exact: true });
  await expect(panel(page).getByTestId("agent-activity-dot")).toBeVisible();
  await button.click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(sheet(page).getByRole("region", { name: "This chat" })).toContainText("Added Coffee, $4.50");
  const all = sheet(page).getByRole("link", { name: "All activity" });
  await expect(all).toHaveAttribute("href", "/activity");
  if (phone(info)) {
    // A finger-sized target on touch: the link's hit area (its ::after) is at least 32 px tall.
    const hit = await all.evaluate((el) => {
      const a = getComputedStyle(el, "::after");
      const r = el.getBoundingClientRect();
      return a.position === "absolute" ? r.height - 2 * parseFloat(a.top) : r.height;
    });
    expect(hit).toBeGreaterThanOrEqual(32);
  }
  // The slide-over covers everything under the header; the header stays.
  const s = (await sheet(page).boundingBox())!;
  const header = (await button.boundingBox())!;
  expect(s.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(s.y + s.height).toBeGreaterThanOrEqual(composer!.y + composer!.height - 1);
  // What it covers is out of reach: Shift+Tab from the sheet goes to the header, never to the hidden composer.
  await sheet(page).getByRole("button", { name: "Close activity" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(panel(page).getByLabel("Message Hydra")).not.toBeFocused();
  await expect(panel(page).getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await sheet(page).focus();

  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible(); // Escape closed the activity, not the panel
  await expect(button).toBeFocused();
  // Focus came back without opening the button's tooltip over the thread.
  await page.waitForTimeout(300);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await button.click();
  const x = sheet(page).getByRole("button", { name: "Close activity" });
  if (phone(info)) await x.tap();
  else await x.click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.waitForTimeout(300);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await button.click();
  await button.click();
  await expect(sheet(page)).toHaveCount(0);
});

test("two groups; repeats fold into a count that opens to single rows; undone and failed undo show on their row", async ({ page }, info) => {
  await open(page, info, "?activity=many");
  await panel(page).getByRole("button", { name: "Activity" }).click();
  const here = sheet(page).getByRole("region", { name: "This chat" });
  const earlier = sheet(page).getByRole("region", { name: "Earlier" });
  await expect(here).toBeVisible();
  await expect(earlier).toContainText("Edited a transaction");
  const run = here.locator("button[aria-expanded]");
  await expect(run).toContainText("×6");
  await expect(run).toHaveAttribute("aria-expanded", "false");
  await expect(here.getByRole("button", { name: "Undo: Added a rule" })).toHaveCount(0); // no undo all
  await run.click();
  await expect(run).toHaveAttribute("aria-expanded", "true");
  await expect(here.getByRole("button", { name: "Undo: Added a rule" })).toHaveCount(5);
  await expect(here.getByText("Undone")).toHaveCount(1);

  // When and where show on hover, never as a line of their own.
  await expect(earlier.getByText("Edited a transaction")).toHaveAttribute("title", /· Phone$/);

  // The server refuses one: that row says so, the rest are untouched, and the thread's error shows too.
  await earlier.getByRole("button", { name: "Undo: Hid a transaction" }).click();
  const failedRow = earlier.locator("li", { hasText: "Hid a transaction" });
  await expect(failedRow).toContainText("Not undone");
  await expect(failedRow.getByRole("button", { name: "Undo: Hid a transaction" })).toBeEnabled();

  // A good one: struck through, Undone, and its button gone.
  await here.getByRole("button", { name: "Undo: Added Coffee, $4.50" }).click();
  await expect(here.locator("li", { hasText: "Added Coffee, $4.50" })).toContainText("Undone");
  await expect(here.getByRole("button", { name: "Undo: Added Coffee, $4.50" })).toHaveCount(0);
});

test("Undo hides until hover with a mouse, and is always there on touch", async ({ page }, info) => {
  await open(page, info, "?activity=one");
  await panel(page).getByRole("button", { name: "Activity" }).click();
  const undo = sheet(page).getByRole("button", { name: "Undo: Added Coffee, $4.50" });
  const opacity = () => undo.evaluate((el) => getComputedStyle(el).opacity);
  if (phone(info)) {
    await expect.poll(opacity).toBe("1");
  } else {
    await page.mouse.move(0, 0);
    await expect.poll(opacity).toBe("0");
    await sheet(page).getByText("Added Coffee, $4.50").hover();
    await expect.poll(opacity).toBe("1");
  }
});
