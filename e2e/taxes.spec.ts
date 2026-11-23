import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/taxes";

const isPhone = (info: TestInfo) => info.project.name === "phone";
const width = (info: TestInfo) => (isPhone(info) ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `taxes-${name}-${width(info)}.png`), fullPage });

// The fixture clock is Saturday, November 21, 2026 (src/app/dev/taxes/fixtures.ts).
// A stat's text starts with its label (its info text, also in the DOM, may name other stats).
const stat = (page: Page, label: string | RegExp) =>
  page.locator('[data-slot="stat"]').filter({ hasText: typeof label === "string" ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) : label });
const quarter = (page: Page, q: number) => page.getByRole("button", { name: new RegExp(`^Q${q}, due`) });
const payments = (page: Page) => page.getByRole("region", { name: "Estimated tax payments" });
const entities = (page: Page) => page.getByRole("radiogroup", { name: "Entity" });
const years = (page: Page) => page.getByRole("radiogroup", { name: "Tax year" });

async function open(page: Page, query = "") {
  await page.goto(`/dev/taxes${query}`);
  await expect(stat(page, "Net profit")).toBeVisible();
}

test.describe("/dev/taxes", () => {
  test("shows the year's figures and the estimated payment timeline", async ({ page }, info) => {
    await open(page);
    await expect(page.getByRole("heading", { name: "Taxes" })).toBeVisible();
    await expect(stat(page, "Business income")).toContainText("$45,155.00");
    await expect(stat(page, "Deductible expenses")).toContainText("$6,240.18");
    await expect(stat(page, "Net profit")).toContainText("$38,914.82");
    await expect(stat(page, "Set aside at 25%")).toContainText("$9,728.71");
    await expect(payments(page)).toContainText("Short $1,328.71");
    for (const q of [1, 2, 3]) await expect(quarter(page, q)).toContainText("Paid");
    await expect(quarter(page, 1)).toContainText("Q1 · Apr 15");
    await expect(quarter(page, 1)).toContainText("$2,100.00");
    await expect(quarter(page, 4)).toContainText("Due in 55 days");
    await expect(quarter(page, 4)).toContainText("Q4 · Jan 15");
    await expect(quarter(page, 4)).toContainText("$1,328.71 suggested");
    await page.waitForTimeout(400);
    await shot(page, info, "overview", true);
  });

  test("the disclaimer sits behind one info dot, not in the page text", async ({ page }) => {
    await open(page);
    await expect(page.getByText("not a tax adviser")).toHaveCount(1); // the hidden description of the one dot
    await expect(page.getByText("not a tax adviser")).toBeHidden();
    await stat(page, "Set aside at 25%").getByRole("button", { name: "More info" }).focus();
    await expect(page.getByRole("dialog").or(page.locator('[data-side]')).getByText("not a tax adviser")).toBeVisible();
  });

  test("typing a set-aside rate changes the set-aside and what is short", async ({ page }) => {
    await open(page);
    const rate = page.getByRole("textbox", { name: "Set-aside rate" });
    await rate.fill("30");
    await rate.press("Enter");
    await expect(stat(page, /^Set aside at 30%/)).toContainText("$11,674.45");
    await expect(payments(page)).toContainText("Short $3,274.45");
    await expect(quarter(page, 4)).toContainText("$3,274.45 suggested");
    await expect(rate).toHaveValue("30%");
  });

  test("an unreadable rate goes back to the saved one", async ({ page }) => {
    await open(page);
    const rate = page.getByRole("textbox", { name: "Set-aside rate" });
    await rate.fill("lots");
    await rate.press("Enter");
    await expect(rate).toHaveValue("25%");
    await expect(stat(page, "Set aside at 25%")).toBeVisible();
  });

  test("record the January payment, then remove it after a confirm", async ({ page }, info) => {
    await open(page);
    await quarter(page, 4).click();
    const form = page.getByRole("form", { name: "Payment for Q4" });
    await expect(form.getByLabel("Amount paid")).toHaveValue("1328.71");
    await shot(page, info, "payment-editor");
    await form.getByLabel("Paid on").fill("2026-11-22");
    await form.getByRole("button", { name: "Save payment" }).click();
    await expect(quarter(page, 4)).toContainText("Paid");
    await expect(quarter(page, 4)).toContainText("$1,328.71");
    await expect(payments(page)).toContainText("Covered");

    await quarter(page, 4).click();
    await page.getByRole("form", { name: "Payment for Q4" }).getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Remove this payment?")).toBeVisible();
    await page.getByRole("button", { name: "Keep it" }).click();
    await expect(quarter(page, 4)).toContainText("Paid");
    await page.getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Yes, remove it" }).click();
    await expect(quarter(page, 4)).toContainText("Due in 55 days");
  });

  test("a bad amount is refused with a plain message", async ({ page }) => {
    await open(page);
    await quarter(page, 4).click();
    const form = page.getByRole("form", { name: "Payment for Q4" });
    await form.getByLabel("Amount paid").fill("abc");
    await form.getByRole("button", { name: "Save payment" }).click();
    await expect(form.getByRole("alert")).toContainText("Type the amount you paid");
    await expect(quarter(page, 4)).toContainText("Due in 55 days");
  });

  test("a Schedule C line opens its panel with every transaction", async ({ page }, info) => {
    await open(page);
    await expect(page.getByRole("link", { name: "Line 18, Office expense" })).toBeVisible();
    await page.getByRole("link", { name: "Line 18, Office expense" }).click();
    const panel = page.getByRole("dialog", { name: "Schedule C line" });
    await expect(panel.getByRole("heading", { name: "Line 18, Office expense" })).toBeVisible();
    await expect(panel).toContainText("$1,284.40");
    await expect(panel).toContainText("38 transactions");
    await expect(panel).toContainText("Software, Subscriptions");
    await expect(panel.locator("li")).toHaveCount(38);
    await expect(page).toHaveURL(/taxline=/);
    await page.waitForTimeout(400);
    await shot(page, info, "line-panel");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page).not.toHaveURL(/taxline=/);
  });

  test("a line with more than the page limit says so", async ({ page }) => {
    await open(page);
    await page.getByRole("link", { name: "Line 27b, Other expenses" }).click();
    const panel = page.getByRole("dialog", { name: "Schedule C line" });
    await expect(panel).toContainText("91 transactions");
    await expect(panel).toContainText("Showing the newest 40");
  });

  test("switching year and entity changes the data; UGM LLC is marked closed", async ({ page }) => {
    await open(page);
    await years(page).getByRole("radio", { name: "2025" }).click();
    await expect(stat(page, "Business income")).toContainText("$31,800.00");
    await expect(stat(page, /^Set aside at 22%/)).toBeVisible();
    for (const q of [1, 2, 3, 4]) await expect(quarter(page, q)).toContainText("Paid");
    await expect(page).toHaveURL(/year=2025/);

    await entities(page).getByRole("radio", { name: "UGM LLC" }).click();
    await expect(page.getByText("Closed, kept for history")).toBeVisible();
    await expect(stat(page, "Business income")).toContainText("$12,400.00");
    await expect(page.getByRole("link", { name: "Line 17, Legal and professional services" })).toBeVisible();
    await expect(quarter(page, 1)).toContainText("Not paid");

    await entities(page).getByRole("radio", { name: "Personal" }).click();
    await expect(stat(page, /^Income/)).toBeVisible();
    await expect(page.getByText("No expenses on a tax line in 2025")).toBeVisible();
  });

  test("documents: a missing W-9 shows, an upload lists, a delete asks first", async ({ page }, info) => {
    await open(page);
    const docs = page.getByRole("region", { name: "Documents" });
    await expect(docs.getByText("w9-wordwise.pdf")).toBeVisible();
    await expect(docs.getByText("Canvasly")).toBeVisible();
    await expect(docs.getByText("W-9 missing")).toHaveCount(1);

    await docs.getByRole("button", { name: "Upload" }).click();
    await docs.getByRole("radio", { name: "W-9" }).click();
    await expect(docs.getByRole("button", { name: "Choose file" })).toBeDisabled(); // a W-9 needs its payer
    await docs.getByPlaceholder("Who sent it").fill("Canvasly");
    await docs.getByLabel("Choose a file").setInputFiles({ name: "w9-canvasly.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") });
    await expect(docs.getByText("w9-canvasly.pdf")).toBeVisible();
    await expect(docs.getByText("W-9 missing")).toHaveCount(0);
    await page.waitForTimeout(300);
    await shot(page, info, "documents");

    await docs.getByRole("button", { name: "Delete w9-canvasly.pdf" }).click();
    await expect(docs.getByText("Delete this file?")).toBeVisible();
    await docs.getByRole("button", { name: "Keep" }).click();
    await expect(docs.getByText("w9-canvasly.pdf")).toBeVisible();
    await docs.getByRole("button", { name: "Delete w9-canvasly.pdf" }).click();
    await docs.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(docs.getByText("w9-canvasly.pdf")).toHaveCount(0);
    await expect(docs.getByText("W-9 missing")).toHaveCount(1);
  });

  test("no horizontal scroll, and the page has no Ask Hydra panel", async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByText("Ask Hydra")).toHaveCount(0);
  });
});
