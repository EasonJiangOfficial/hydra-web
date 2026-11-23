/* Notes on the real local database: a typed note saves by itself and is there after a reload; search, pin, delete with
   its confirm and the undo bar. SUPABASE_E2E=1 only, with 0210_notes.sql applied to the local stack. */
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers/supabase";

const TITLE = "E2E note one";

/** SQL on the local stack's database (E2E_DB_URL, local only). These writes carry no actor, so Activity skips them. */
function sql(query: string): string {
  const url = process.env.E2E_DB_URL ?? "";
  if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("set E2E_DB_URL to the local stack's database");
  return execFileSync("psql", [url, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim();
}
const row = () => {
  const out = sql(`select row_to_json(n) from (select id, title, text, pinned from public.notes where title = '${TITLE}') n`);
  return out ? (JSON.parse(out) as { id: string; title: string; text: string; pinned: boolean }) : null;
};

const title = (page: Page) => page.getByRole("textbox", { name: "Title" });

test.describe("notes on local Supabase", () => {
  test.skip(!process.env.SUPABASE_E2E, "set SUPABASE_E2E=1 with local Supabase running");

  test("type, it saves, a reload shows it; search, pin, delete asks, Undo brings it back", async ({ page, baseURL }) => {
    test.skip(test.info().project.name !== "desktop", "desktop project only: one set of rows");
    test.setTimeout(120_000);
    sql(`delete from public.notes where title = '${TITLE}'`);
    await signIn(page, baseURL!);

    await page.goto("/notes");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New note" }).click();
    await expect(title(page)).toBeFocused();
    await page.keyboard.type(TITLE);
    await page.keyboard.press("Enter");
    await page.keyboard.type("- first line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second line");
    await expect(page.locator("[data-save-state]")).toHaveAttribute("data-save-state", "saved", { timeout: 10_000 });
    await expect.poll(() => row()?.text).toBe("- first line\n- second line");

    await page.reload();
    await expect(title(page)).toHaveValue(TITLE);
    await expect(page.getByTestId("note-editor").locator('[data-content-type="bulletListItem"]')).toHaveText(["first line", "second line"]);

    await page.getByRole("searchbox", { name: "Search notes" }).fill("second lin");
    await expect(page.getByTestId("note-row").filter({ hasText: TITLE })).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Search notes" }).fill("");

    await page.getByRole("button", { name: "Pin to top" }).click();
    await expect.poll(() => row()?.pinned).toBe(true);

    const id = row()!.id;
    await page.getByRole("button", { name: "Delete note" }).click();
    await page.getByRole("dialog", { name: `Delete “${TITLE}”?` }).getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => row()).toBeNull();
    const bar = page.getByTestId("undo-bar");
    await expect(bar).toContainText(`Deleted note "${TITLE}".`);
    await bar.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => row()?.id).toBe(id);
    await expect(page.getByTestId("note-row").filter({ hasText: TITLE })).toHaveCount(1);
    sql(`delete from public.notes where title = '${TITLE}'`);
  });
});
