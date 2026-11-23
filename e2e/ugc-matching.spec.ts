/* Video matching on the UGC Videos tab (fixture /dev/ugc): Needs matching with suggested twins, one-click Link,
 * Keep apart, a linked video's platforms with the paid one, Unlink, and the undo bar after each. */
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/ugc-matching";
const width = (info: TestInfo) => (info.project.name === "phone" ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `matching-${name}-${width(info)}.png`), fullPage });

async function openVideos(page: Page) {
  await page.goto("/dev/ugc?tab=videos");
  await expect(page.getByRole("tab", { name: "Videos" })).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(300);
}

const needs = (page: Page) => page.getByTestId("needs-matching");
const bar = (page: Page) => page.getByTestId("undo-bar");

test.describe("video matching", () => {
  test("a suggested twin links in one click, and Undo puts it back", async ({ page }, info) => {
    await openVideos(page);
    const card = needs(page);
    await expect(card).toBeVisible();
    await expect(card.locator("[data-needs]")).toHaveCount(2);
    await expect(card.getByText(/Same caption · \d+ (min|h) apart/).filter({ visible: true }).first()).toBeVisible();
    await expect(card.getByText("Held", { exact: true }).filter({ visible: true })).toHaveCount(1);
    // DESIGN.md section 7: one filled button per page. The Link buttons are outline.
    await expect(card.locator("button.bg-ink")).toHaveCount(0);
    await expect(page.locator("button.bg-ink, a.bg-ink").filter({ visible: true })).toHaveCount(1);
    await shot(page, info, "needs");

    const summary = page.getByTestId("video-summary");
    const before = Number((await summary.innerText()).match(/^(\d+) videos/)![1]);
    // The first Link: the unlinked Wordwise twin (not held).
    await card.getByRole("button", { name: /^Link .* on (TikTok|Reels) with / }).first().click();
    await expect(card.locator("[data-needs]")).toHaveCount(1);
    await expect(summary).toContainText(`${before - 1} videos`);
    await expect(bar(page)).toContainText(/^Linked (TikTok and Reels|Reels and TikTok) for ".*"\./);
    await shot(page, info, "linked-undo-bar");

    await bar(page).getByRole("button", { name: "Undo" }).click();
    await expect(card.locator("[data-needs]")).toHaveCount(2);
    await expect(summary).toContainText(`${before} videos`);
  });

  test("Keep apart takes a post off the list, with Undo", async ({ page }) => {
    await openVideos(page);
    const card = needs(page);
    await card.getByRole("button", { name: /^Keep .* apart$/ }).first().click();
    await expect(card.locator("[data-needs]")).toHaveCount(1);
    await expect(bar(page)).toContainText(/^Kept ".*" apart\./);
    await bar(page).getByRole("button", { name: "Undo" }).click();
    await expect(card.locator("[data-needs]")).toHaveCount(2);
  });

  test("a linked video shows its platforms, views each, the paid one, and Unlink from the keyboard", async ({ page }, info) => {
    await openVideos(page);
    const toggle = page.getByRole("button", { name: /On 2 platforms, paid once/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = page.getByRole("list", { name: /^Platforms of / });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByText("Paid", { exact: true })).toHaveCount(1);
    // The paid post is the one with the most views, listed first.
    await expect(list.getByRole("listitem").first().getByText("Paid", { exact: true })).toBeVisible();
    await toggle.scrollIntoViewIfNeeded();
    await shot(page, info, "platforms");

    const summary = page.getByTestId("video-summary");
    const before = Number((await summary.innerText()).match(/^(\d+) videos/)![1]);
    const unlink = list.getByRole("button", { name: /^Unlink / }).last();
    await unlink.focus();
    await page.keyboard.press("Enter");
    await expect(summary).toContainText(`${before + 1} videos`);
    await expect(bar(page)).toContainText(/^Unlinked (TikTok|Reels) from ".*"\./);
    await bar(page).getByRole("button", { name: "Undo" }).click();
    await expect(summary).toContainText(`${before} videos`);
    await expect(page.getByRole("button", { name: /On 2 platforms, paid once/ })).toBeVisible();
  });
});
