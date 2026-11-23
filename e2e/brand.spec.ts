import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/brand";
const width = (info: TestInfo) => (info.project.name === "phone" ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = true) =>
  page.screenshot({ path: path.join(SHOTS, `brand-${name}-${width(info)}.png`), fullPage });

/** Scrolls through the page so every lazy block draws, then back to the top. */
async function revealAll(page: Page) {
  for (let y = 0; y < 6000; y += 500) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(60);
  }
  await expect(page.locator('[data-analytics-block="loading"]')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
}

async function open(page: Page, query = "") {
  await page.goto(`/dev/brand${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Personal Brand" })).toBeVisible();
  await page.waitForTimeout(300);
}

const tile = (page: Page, label: string) => page.locator('[data-slot="analytics-tile"]').filter({ hasText: label }).first();

test.describe("/dev/brand", () => {
  test("followers, engagement, consistency, top posts and the post grid", async ({ page }, info) => {
    await open(page);
    for (const label of ["Followers", "Views", "Likes", "Comments", "Engagement", "Posts"]) await expect(tile(page, label)).toBeVisible();
    await expect(tile(page, "Engagement")).toContainText("%");
    await revealAll(page);
    await expect(page.getByRole("region", { name: "Followers", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Followers over time" })).toBeVisible();
    await expect(page.getByRole("grid", { name: /Posting consistency/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Top posts" })).toBeVisible();
    // The grid: 12 tiles, a thumbnail or the neutral tile, each a link to the post.
    const grid = page.getByRole("region", { name: "Posts", exact: true });
    await expect(grid.locator("li[data-post]")).toHaveCount(12);
    await expect(grid.locator("li[data-post] img").first()).toBeVisible();
    await expect(grid.locator("li[data-post] a").first()).toHaveAttribute("href", /instagram\.com\/reel\//);
    await shot(page, info, "all");
    await grid.getByRole("button", { name: "Show more" }).click();
    await expect(grid.locator("li[data-post]")).toHaveCount(24);
  });

  test("the range narrows every windowed block", async ({ page }, info) => {
    await open(page);
    const allPosts = await tile(page, "Posts").locator(".text-figure-s").innerText();
    await page.getByRole("radio", { name: "1m" }).click();
    await expect(page).toHaveURL(/range=1m/);
    await expect.poll(async () => tile(page, "Posts").locator(".text-figure-s").innerText()).not.toBe(allPosts);
    await revealAll(page);
    await shot(page, info, "1m");
  });

  test("a typed follower count shows at once", async ({ page }, info) => {
    await open(page);
    await revealAll(page);
    const card = page.getByRole("region", { name: "Followers", exact: true });
    await card.scrollIntoViewIfNeeded();
    const input = card.getByLabel(/Followers on/);
    await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
    await input.fill("4,321");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(tile(page, "Followers").locator(".text-figure-s")).toHaveText("4.3K");
    await expect(input).toHaveValue("");
    await shot(page, info, "followers-saved", false);
  });

  test("empty: no deal and no counts", async ({ page }, info) => {
    await open(page, "?empty=1");
    await expect(tile(page, "Followers").locator(".text-figure-s")).toHaveText("—");
    await revealAll(page);
    await expect(page.getByText("No follower counts in this range")).toBeVisible();
    await expect(page.getByText("No posts in this range").first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Top posts" })).toContainText("No posts in this range");
    await shot(page, info, "empty");
  });

  test("Instagram in the header: not connected, off, connected with Sync now, and Reconnect", async ({ page }, info) => {
    // The owner's sizes: 375x812 on the phone, 1440x900 on desktop.
    const size = info.project.name === "phone" ? { width: 375, height: 812 } : { width: 1440, height: 900 };
    await page.setViewportSize(size);
    const igShot = async (name: string) => {
      await page.waitForTimeout(400); // the hover panel's fade
      await page.screenshot({ path: path.join(SHOTS, `brand-ig-${name}-${size.width}x${size.height}.png`) });
    };
    const hoverOrTap = async (name: string) => {
      const dot = page.getByRole("button", { name });
      if (info.project.name === "phone") await dot.tap();
      else await dot.hover();
    };
    const ctl = page.locator("[data-instagram]");

    await open(page, "?ig=none");
    await expect(ctl).toHaveAttribute("data-instagram", "none");
    await expect(ctl.getByRole("link", { name: "Connect Instagram" })).toHaveAttribute("href", "/api/instagram/start?from=brand");
    await igShot("none");

    await open(page, "?ig=off");
    await expect(ctl.getByRole("button", { name: "Connect Instagram" })).toBeDisabled();
    await hoverOrTap("Why Instagram is off");
    await expect(page.getByText("Add META_APP_ID, META_APP_SECRET, INSTAGRAM_CONFIG_ID and HYDRA_TOKEN_KEY on the host.")).toBeVisible();
    await igShot("off");

    await open(page);
    await expect(ctl).toHaveAttribute("data-instagram", "connected");
    await expect(ctl).toContainText("@studio.notes");
    await expect(ctl.getByRole("link", { name: "Connect Instagram" })).toHaveCount(0);
    await hoverOrTap("Instagram sync");
    await expect(page.getByText("@studio.notes. Synced 2 h ago. It syncs daily.")).toBeVisible();
    await igShot("connected");
    await page.mouse.move(0, size.height - 1);
    const sync = ctl.getByRole("button", { name: "Sync now" });
    await sync.click();
    await expect(sync).toBeDisabled();
    await expect(sync).toBeEnabled();
    await hoverOrTap("Instagram sync");
    await expect(page.getByText("@studio.notes. Synced just now. It syncs daily.")).toBeVisible();

    await open(page, "?ig=error");
    await expect(ctl).toHaveAttribute("data-instagram", "reconnect");
    await expect(ctl.getByRole("link", { name: "Reconnect" })).toHaveAttribute("href", "/api/instagram/start?from=brand");
    await expect(ctl.getByRole("button", { name: "Sync now" })).toHaveCount(0);
    await hoverOrTap("Instagram sync");
    await expect(page.getByText("Instagram signed Hydra out. Reconnect.", { exact: false })).toBeVisible();
    await igShot("reconnect");

    // A sync where Instagram refused some posts' views and the page cap left posts out: still connected, and the
    // hover names both.
    await open(page, "?ig=partial");
    await expect(ctl).toHaveAttribute("data-instagram", "connected");
    await expect(ctl.getByRole("button", { name: "Sync now" })).toBeVisible();
    await hoverOrTap("Instagram sync");
    await expect(
      page.getByText("@studio.notes. Synced 2 h ago. Instagram refused views for some posts. The last sync stopped at 500 posts; older ones were left out. It syncs daily."),
    ).toBeVisible();
    await igShot("partial");

    // A sign-in without insights: still connected with Sync now (no Reconnect here), and a quiet note.
    await open(page, "?ig=nogrant");
    await expect(ctl).toHaveAttribute("data-instagram", "connected");
    await expect(ctl.getByRole("button", { name: "Sync now" })).toBeVisible();
    await expect(ctl.getByRole("link", { name: "Reconnect" })).toHaveCount(0);
    await hoverOrTap("Instagram sync");
    await expect(page.getByText("Instagram did not share views. Reconnect in Settings to allow them.", { exact: false })).toBeVisible();
    await igShot("nogrant");

    await open(page, "?ig=none&instagram=denied");
    await expect(page.getByRole("alert").filter({ hasText: "Instagram sign-in was cancelled." })).toBeVisible();

    // A failed reconnect sends the owner back connected with ?instagram=error; once Sync now works, the note goes.
    await open(page, "?instagram=error");
    const note = page.getByRole("alert").filter({ hasText: "Instagram sign-in failed. Try again." });
    await expect(note).toBeVisible();
    await igShot("signin-note");
    await ctl.getByRole("button", { name: "Sync now" }).click();
    await expect(note).toHaveCount(0);
    await igShot("signin-note-cleared");
  });

  test("Personal Brand sits under UGC Tracker in the sidebar and in More on the phone", async ({ page }, info) => {
    await open(page);
    if (info.project.name === "phone") {
      await page.getByRole("navigation", { name: "Tabs" }).getByRole("button", { name: "More" }).click();
      await expect(page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Personal Brand" })).toBeVisible();
      await shot(page, info, "more-sheet", false);
    } else {
      const link = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Personal Brand" });
      await expect(link).toHaveAttribute("aria-current", "page");
    }
  });
});
