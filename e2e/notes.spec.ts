import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

/* The Notes page on its /dev fixture (in-memory notes): list, editor, autosave, slash menu, search, pin, delete, phone. */

const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/notes";
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `notes-${name}-${page.viewportSize()?.width}.png`) });

const desktopOnly = (info: TestInfo) => test.skip(info.project.name !== "desktop", "desktop only");
const phoneOnly = (info: TestInfo) => test.skip(info.project.name !== "phone", "phone only");

const LISBON = "00000000-0000-4000-8000-000000000001";
const rows = (page: Page) => page.getByTestId("note-row");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const editor = (page: Page) => page.getByTestId("note-editor");
const body = (page: Page) => editor(page).locator(".bn-editor");
const title = (page: Page) => page.getByRole("textbox", { name: "Title" });
const saveState = (page: Page) => page.locator("[data-save-state]");

async function open(page: Page, url = "/dev/notes") {
  await page.goto(url);
  await expect(page.getByRole("button", { name: "New note" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test.describe("desktop", () => {
  test.beforeEach(({}, info) => desktopOnly(info));

  test("no notes yet: the empty list", async ({ page }) => {
    await open(page, "/dev/notes?empty=1");
    await expect(page.getByText("No notes yet.")).toBeVisible();
    await shot(page, "empty");
  });

  test("the list: pinned first then newest, title and first line; the editor shows every block type", async ({ page }) => {
    await open(page);
    await expect(rows(page)).toHaveCount(4);
    await expect(rows(page).nth(0)).toContainText("Lisbon trip");
    await expect(rows(page).nth(0).getByLabel("Pinned")).toBeVisible();
    await expect(rows(page).nth(1)).toContainText("Groceries");
    await expect(rows(page).nth(1)).toContainText("Oat milk");
    // No title: "Untitled" over its first line.
    await expect(rows(page).nth(2)).toContainText("Untitled");
    await expect(rows(page).nth(2)).toContainText("Call Sam about the Glow deal");
    // The source and time show on hover.
    await rows(page).nth(2).hover();
    await expect(rows(page).nth(2)).toContainText(/Mac · .+ ago/);
    // The desktop opens the top note: the right side is never empty.
    await expect(page).toHaveURL(new RegExp(`note=${LISBON}`));
    await page.waitForTimeout(300);
    await shot(page, "list");

    await row(page, "Lisbon trip").click();
    await expect(title(page)).toHaveValue("Lisbon trip");
    for (const type of ["heading", "paragraph", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "quote", "codeBlock", "divider", "table"]) {
      await expect(editor(page).locator(`[data-content-type="${type}"]`).first(), type).toBeAttached();
    }
    await expect(editor(page).locator('[data-content-type="heading"][data-level="2"]')).toHaveText("Packing");
    await expect(editor(page).locator('[data-content-type="heading"][data-level="3"]')).toHaveText("Days");
    // Links are ink, not blue; no color menu exists.
    const link = editor(page).getByRole("link", { name: "Casa do Rio" });
    expect(await link.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(29, 29, 31)");
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await shot(page, "editor");
  });

  test("New note: type a title and blocks, it saves by itself and the list follows", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "New note" }).click();
    await expect(title(page)).toBeFocused();
    await expect(rows(page)).toHaveCount(5);
    await page.keyboard.type("Packing list");
    // The list row follows the title as it is typed.
    await expect(rows(page).filter({ hasText: "Packing list" })).toHaveCount(1);
    await page.keyboard.press("Enter");
    // Markdown shortcuts: "- " makes a bullet, "[] " a to-do.
    await page.keyboard.type("- socks");
    await page.keyboard.press("Enter");
    await page.keyboard.type("charger");
    await expect(body(page).locator('[data-content-type="bulletListItem"]')).toHaveCount(2);
    await expect(saveState(page)).toHaveAttribute("data-save-state", "saved", { timeout: 5000 });
    await expect(row(page, "Packing list")).toContainText("socks");
  });

  test("New note: keys typed at once go to the title, and a double click makes one note", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "New note" }).click();
    await page.keyboard.type("Hi there", { delay: 0 });
    await expect(title(page)).toHaveValue("Hi there");
    await expect(rows(page)).toHaveCount(5);
    await page.getByRole("button", { name: "New note" }).dblclick();
    await expect(title(page)).toBeFocused();
    await page.keyboard.type("Second");
    await expect(title(page)).toHaveValue("Second");
    await expect(rows(page)).toHaveCount(6);
  });

  test("New note: an Enter typed before the title shows moves on to the text, with the keys after it", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "New note" }).click();
    await page.keyboard.type("Hi", { delay: 0 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("milk", { delay: 0 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("eggs", { delay: 0 });
    await expect(title(page)).toHaveValue("Hi");
    await expect(body(page).locator('[data-content-type="paragraph"]')).toHaveText(["milk", "eggs"]);
    // The caret is in the text, after the last key.
    await page.keyboard.type(" too");
    await expect(body(page).locator('[data-content-type="paragraph"]').nth(1)).toHaveText("eggs too");
  });

  test("New note that cannot be made says so and drops its keys: the next New note starts empty", async ({ page, context }) => {
    await open(page);
    await context.setOffline(true);
    await page.getByRole("button", { name: "New note" }).click();
    await page.keyboard.type("Groc", { delay: 0 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("milk", { delay: 0 });
    const failed = page.getByRole("alert").filter({ hasText: "Couldn’t make the note" });
    await expect(failed).toBeVisible();
    await expect(failed.getByRole("button", { name: "Try again" })).toBeVisible();
    // The alert lines up with the note rows under it.
    const [box, first] = await Promise.all([failed.boundingBox(), rows(page).first().boundingBox()]);
    expect([box?.x, box?.width]).toEqual([first?.x, first?.width]);
    await page.mouse.move(0, 0);
    await shot(page, "create-failed");
    await context.setOffline(false);
    await page.getByRole("button", { name: "New note" }).click();
    await page.keyboard.type("Meeting with Sam", { delay: 0 });
    await expect(title(page)).toHaveValue("Meeting with Sam");
    await expect(failed).toHaveCount(0);
    await expect(body(page)).not.toContainText("milk");
  });

  test("a / typed right after New note opens the slash menu", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "New note" }).click();
    await page.keyboard.type("Quick", { delay: 0 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("/", { delay: 0 });
    await expect(page.locator(".bn-suggestion-menu")).toBeVisible();
    await expect(title(page)).toHaveValue("Quick");
    await page.keyboard.type("quote", { delay: 0 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("Less is more");
    await expect(body(page).locator('[data-content-type="quote"]')).toHaveText("Less is more");
  });

  test("the toggle's hover square stays off its text", async ({ page }) => {
    await open(page, `/dev/notes?note=${LISBON}`);
    const button = page.getByRole("button", { name: "Expand or collapse" });
    await button.hover();
    const [square, text] = await Promise.all([
      button.evaluate((b) => {
        const r = b.getBoundingClientRect();
        const inset = parseFloat(getComputedStyle(b, "::after").left);
        return { right: r.right - inset, bg: getComputedStyle(b).backgroundColor, after: getComputedStyle(b, "::after").backgroundColor };
      }),
      page.locator('[data-content-type="toggleListItem"] .bn-inline-content').first().boundingBox(),
    ]);
    expect(square.bg).toBe("rgba(0, 0, 0, 0)");
    expect(square.after).not.toBe("rgba(0, 0, 0, 0)");
    expect(square.right).toBeLessThanOrEqual(text?.x ?? 0);
  });

  test("a pasted h4 to h6 becomes h3, and one undo takes the paste away", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "New note" }).click();
    await page.keyboard.type("Paste test");
    await page.keyboard.press("Enter");
    await page.keyboard.type("first line");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700); // past the undo history's 500 ms grouping, so the paste is its own step
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/html", "<h4>Deep</h4><h5>Five</h5><p>y</p>");
      data.setData("text/plain", "Deep\nFive\ny");
      document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const blocks = body(page).locator("[data-content-type]");
    await expect(body(page).locator('[data-content-type="heading"][data-level="3"]')).toHaveText(["Deep", "Five"]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(body(page).locator('[data-content-type="heading"]')).toHaveCount(0);
    await expect(blocks.first()).toHaveText("first line");
  });

  test("an edit not saved yet stays while the tab lives: it retries across notes, and leaving asks first", async ({ page, context }) => {
    await open(page, `/dev/notes?note=${LISBON}`);
    await context.setOffline(true);
    await title(page).fill("Lisbon trip, typed offline");
    await expect(saveState(page)).toHaveAttribute("data-save-state", "error", { timeout: 5000 });
    await page.locator(".group\\/bar").hover();
    await expect(saveState(page)).toContainText("Not saved yet, retrying");
    await page.waitForTimeout(250);
    await shot(page, "retrying");
    // A link out of Notes asks first; Stay keeps the page.
    await page.getByRole("navigation").getByRole("link", { name: "Dashboard" }).first().click();
    const ask = page.getByRole("dialog", { name: "Changes not saved yet. Leave anyway?" });
    await expect(ask).toBeVisible();
    await page.waitForTimeout(250);
    await shot(page, "leave-ask");
    await ask.getByRole("button", { name: "Stay" }).click();
    await expect(ask).toBeHidden();
    await expect(page).toHaveURL(/\/dev\/notes/);
    // The sidebar still marks Notes: the click never reached it.
    await expect(page.getByRole("navigation").getByRole("link", { name: "Notes" }).first()).toHaveAttribute("aria-current", "page");
    // Another note cannot be read offline: it says so, and the edit above keeps its retries.
    await row(page, "Groceries").click();
    await expect(page.getByText("Could not open this note.")).toBeVisible();
    await shot(page, "offline-open");
    // Back online: the edit saves at once, and the note shows it.
    await context.setOffline(false);
    await expect(row(page, "Lisbon trip, typed offline")).toHaveCount(1, { timeout: 5000 });
    await row(page, "Lisbon trip, typed offline").click();
    await expect(title(page)).toHaveValue("Lisbon trip, typed offline");
    await expect(saveState(page)).toHaveAttribute("data-save-state", "saved");
  });

  test("closing the tab with an edit not saved yet shows the browser's leave warning", async ({ page, context }) => {
    await open(page, `/dev/notes?note=${LISBON}`);
    await context.setOffline(true);
    await title(page).fill("Unsent");
    const warned = page.waitForEvent("dialog");
    await page.close({ runBeforeUnload: true });
    const dialog = await warned;
    expect(dialog.type()).toBe("beforeunload");
    await dialog.accept();
  });

  test("Back out of Notes with an edit not saved yet asks first; after Leave, closing the tab still warns", async ({ page }) => {
    await page.goto("/dev/kit");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    // Into Notes in the app, as the sidebar link does from another page.
    await page.evaluate((id) => (window as unknown as { next: { router: { push: (h: string) => void } } }).next.router.push(`/dev/notes?offline=1&note=${id}`), LISBON);
    await title(page).fill("Typed, never saved");
    await expect(saveState(page)).toHaveAttribute("data-save-state", "error", { timeout: 5000 });
    const ask = page.getByRole("dialog", { name: "Changes not saved yet. Leave anyway?" });
    // The browser's Back: the page stops the step, so it never completes as a navigation.
    const back = () => page.goBack({ timeout: 2000 }).catch(() => null);
    const stopped = back();
    await expect(ask).toBeVisible();
    await page.waitForTimeout(250);
    await shot(page, "back-ask");
    await expect(page).toHaveURL(new RegExp(`/dev/notes\\?offline=1&note=${LISBON}$`));
    await ask.getByRole("button", { name: "Stay" }).click();
    await expect(ask).toBeHidden();
    await expect(title(page)).toHaveValue("Typed, never saved");
    await stopped;
    void back();
    await ask.getByRole("button", { name: "Leave" }).click();
    await expect(page).toHaveURL(/\/dev\/kit$/);
    // Leave took the Back step itself: history is still [kit, notes] and sits on kit, so a second Back does not
    // land on Notes again.
    const at = () =>
      page.evaluate(() => {
        const n = (window as unknown as { navigation: { currentEntry: { index: number }; entries: () => unknown[] } }).navigation;
        return [n.currentEntry.index, n.entries().length];
      });
    await expect.poll(at).toEqual([0, 2]);
    // The app never reloaded: the saver is still in memory, and the tab still guards its edit.
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
    const warned = page.waitForEvent("dialog");
    await page.close({ runBeforeUnload: true });
    const dialog = await warned;
    expect(dialog.type()).toBe("beforeunload");
    await dialog.accept();
  });

  test("the slash menu turns a line into any block", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "New note" }).click();
    await expect(title(page)).toBeFocused();
    await page.keyboard.type("Slash test");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const menu = page.locator(".bn-suggestion-menu");
    await expect(menu).toBeVisible();
    for (const item of ["Heading 1", "Heading 2", "Heading 3", "Quote", "Toggle List", "Numbered List", "Bullet List", "Check List", "Code Block", "Divider", "Table"]) {
      await expect(menu.getByText(item, { exact: true }), item).toBeAttached();
    }
    // No file blocks (there is nowhere to upload to), no toggle headings or emoji, and titles only: no
    // subtext, group labels or shortcut chips.
    for (const item of ["Image", "Toggle Heading 1", "Emoji"]) await expect(menu.getByText(item, { exact: true }), item).toHaveCount(0);
    await expect(menu.getByText("Top-level heading")).toHaveCount(0);
    await expect(menu.locator(".bn-suggestion-menu-label")).toHaveCount(0);
    await page.waitForTimeout(300);
    await shot(page, "slash");
    await page.keyboard.type("heading 2");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Budget");
    await expect(body(page).locator('[data-content-type="heading"][data-level="2"]')).toHaveText("Budget");
  });

  test("search matches words in the title or the text, by prefix", async ({ page }) => {
    await open(page);
    const search = page.getByRole("searchbox", { name: "Search notes" });
    await search.fill("oat");
    // Only matches show: the open note (Lisbon trip) is not one.
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, "Groceries")).toBeVisible();
    await search.fill("glow");
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, "Call Sam")).toBeVisible();
    await shot(page, "search");
    // The open note, when it matches, is marked.
    await search.fill("lisbon");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toHaveAttribute("aria-current", "true");
    await search.fill("zzz");
    await expect(page.getByText("No notes match “zzz”", { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await shot(page, "search-none");
    await search.fill("");
    await expect(rows(page)).toHaveCount(4);
  });

  test("pin moves a note to the top; unpin puts it back", async ({ page }) => {
    await open(page);
    await row(page, "Video ideas").click();
    await page.getByRole("button", { name: "Pin to top" }).click();
    await expect(rows(page).nth(1)).toContainText("Video ideas");
    await expect(rows(page).nth(1).getByLabel("Pinned")).toBeVisible();
    await page.getByRole("button", { name: "Unpin" }).click();
    await expect(rows(page).nth(3)).toContainText("Video ideas");
  });

  test("changed elsewhere: saving stops, the local copy stays, Reload brings the saved one", async ({ page }) => {
    await open(page, `/dev/notes?conflict=1&note=${LISBON}`);
    await title(page).fill("Lisbon trip, my edit");
    const alert = page.getByRole("alert").filter({ hasText: "Changed elsewhere" });
    await expect(alert).toBeVisible();
    await expect(title(page)).toHaveValue("Lisbon trip, my edit");
    await expect(saveState(page)).toHaveAttribute("data-save-state", "conflict");
    await page.waitForTimeout(250);
    await shot(page, "conflict");
    await alert.getByRole("button", { name: "Reload" }).click();
    await expect(title(page)).toHaveValue("Lisbon trip");
    await expect(alert).toHaveCount(0);
  });

  test("changed elsewhere: Keep mine saves the local copy over it", async ({ page }) => {
    await open(page, `/dev/notes?conflict=1&note=${LISBON}`);
    await title(page).fill("Lisbon trip, my edit");
    const alert = page.getByRole("alert").filter({ hasText: "Changed elsewhere" });
    await alert.getByRole("button", { name: "Keep mine" }).click();
    await expect(alert).toHaveCount(0);
    await expect(saveState(page)).toHaveAttribute("data-save-state", "saved");
    await expect(row(page, "Lisbon trip, my edit")).toHaveCount(1);
    await expect(editor(page).locator('[data-content-type="table"]')).toBeAttached();
  });

  test("delete asks first, naming the note", async ({ page }) => {
    await open(page);
    await row(page, "Video ideas").click();
    await page.getByRole("button", { name: "Delete note" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete “Video ideas”?" });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(250);
    await shot(page, "delete");
    await dialog.getByRole("button", { name: "Keep it" }).click();
    await expect(dialog).toBeHidden();
    await expect(rows(page)).toHaveCount(4);
    await page.getByRole("button", { name: "Delete note" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(rows(page)).toHaveCount(3);
    await expect(row(page, "Video ideas")).toHaveCount(0);
    // The desktop opens the top note in its place.
    await expect(title(page)).toHaveValue("Lisbon trip");
  });
});

test.describe("phone", () => {
  test.beforeEach(({}, info) => phoneOnly(info));

  test("the list, then a note full screen with a back button", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page);
    await expect(rows(page)).toHaveCount(4);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await shot(page, "phone-list");

    await row(page, "Lisbon trip").click();
    await expect(title(page)).toHaveValue("Lisbon trip");
    await expect(rows(page).first()).toBeHidden();
    await expect(editor(page).locator('[data-content-type="table"]')).toBeAttached();
    // The toggle's button is a 32 px target.
    const toggle = await page.getByRole("button", { name: "Expand or collapse" }).boundingBox();
    expect([toggle?.width, toggle?.height]).toEqual([32, 32]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.waitForTimeout(300);
    await shot(page, "phone-note");

    await page.getByRole("button", { name: "Notes" }).click();
    await expect(rows(page)).toHaveCount(4);
    await expect(page).not.toHaveURL(/note=/);

    // Back, then the same note again: it shows the edit saved on the first visit, and saves on.
    await row(page, "Groceries").click();
    await body(page).getByText("Eggs").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" and butter");
    await page.getByRole("button", { name: "Notes" }).click();
    await row(page, "Groceries").click();
    await expect(body(page)).toContainText("Eggs and butter");
    await body(page).getByText("Oat milk").click();
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await expect(saveState(page)).toHaveAttribute("data-save-state", "saved", { timeout: 5000 });
    // No drag handle on the phone (no hover, no room); the bar's buttons are 36 px.
    await expect(page.locator(".bn-side-menu")).toBeHidden();
    expect((await page.getByRole("button", { name: "Delete note" }).boundingBox())?.width).toBeGreaterThanOrEqual(32);
    // The delete dialog (its button takes the focus) leaves the note where it was: nothing scrolls sideways.
    const titleX = async () => (await title(page).boundingBox())?.x;
    expect(await titleX()).toBe(16);
    await page.getByRole("button", { name: "Delete note" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Keep it" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await titleX()).toBe(16);
    await page.getByRole("button", { name: "Notes" }).click();

    // A new note opens full screen too, and types.
    await page.getByRole("button", { name: "New note" }).click();
    await expect(title(page)).toBeFocused();
    await page.keyboard.type("From the phone");
    await expect(saveState(page)).toHaveAttribute("data-save-state", "saved", { timeout: 5000 });
    await page.getByRole("button", { name: "Notes" }).click();
    await expect(rows(page).filter({ hasText: "From the phone" })).toHaveCount(1);
  });

  test("an unsent edit says so, leaving asks first, and changed elsewhere offers Keep mine or Reload", async ({ page, context }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    // A note named in the URL opens full screen on the phone (no list, so no New note to wait for).
    const openNote = async (url: string) => {
      await page.goto(url);
      await expect(title(page)).toHaveValue("Lisbon trip");
      await page.waitForLoadState("networkidle");
    };
    await openNote(`/dev/notes?note=${LISBON}`);
    await context.setOffline(true);
    await title(page).fill("Lisbon, offline");
    await expect(saveState(page)).toContainText("Not saved yet, retrying", { timeout: 5000 });
    await expect(saveState(page).getByText("Not saved yet, retrying")).toHaveCSS("opacity", "1");
    await shot(page, "phone-retrying");
    await page.getByRole("link", { name: "Home" }).click();
    const ask = page.getByRole("dialog", { name: "Changes not saved yet. Leave anyway?" });
    await expect(ask).toBeVisible();
    await page.waitForTimeout(250);
    await shot(page, "phone-leave-ask");
    await ask.getByRole("button", { name: "Stay" }).click();
    await context.setOffline(false);
    await expect(saveState(page)).toHaveAttribute("data-save-state", "saved", { timeout: 5000 });

    await openNote(`/dev/notes?conflict=1&note=${LISBON}`);
    await title(page).fill("Lisbon, mine");
    const alert = page.getByRole("alert").filter({ hasText: "Changed elsewhere" });
    for (const name of ["Keep mine", "Reload"]) expect((await alert.getByRole("button", { name }).boundingBox())?.height).toBeGreaterThanOrEqual(32);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await shot(page, "phone-conflict");
  });

  test("Try again and the slash menu's rows are 32 px touch targets", async ({ page, context }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page);
    await context.setOffline(true);
    await page.getByRole("button", { name: "New note" }).click();
    const failed = page.getByRole("alert").filter({ hasText: "Couldn’t make the note" });
    for (const name of ["Try again", "Dismiss"]) expect((await failed.getByRole("button", { name }).boundingBox())?.height).toBeGreaterThanOrEqual(32);
    await shot(page, "phone-create-failed");
    await context.setOffline(false);
    await failed.getByRole("button", { name: "Try again" }).click();
    await expect(title(page)).toBeFocused();
    await page.keyboard.type("Slash");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    // Each row (its icon and title inside carry the same class).
    const items = page.locator(".bn-suggestion-menu-item:has(> .bn-suggestion-menu-item)");
    await expect(items.first()).toBeVisible();
    const heights = await items.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(10);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(32);
    await page.waitForTimeout(300);
    await shot(page, "phone-slash");
  });
});
