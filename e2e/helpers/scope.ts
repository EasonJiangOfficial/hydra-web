import { expect, type Page } from "@playwright/test";

/*
 * The scope control on screen: the Seg ("Scope" radio group) in the desktop top bar, or the phone header's menu
 * button ("Scope: <name>"), which opens a menu of every scope. These helpers drive whichever one shows.
 */

/** The phone header's scope menu button. */
export const scopeMenu = (page: Page) => page.getByTestId("scope-menu").filter({ visible: true });
/** The desktop scope Seg. */
export const scopeSeg = (page: Page) => page.getByRole("radiogroup", { name: "Scope" }).filter({ visible: true });

const onPhone = async (page: Page) => (await scopeMenu(page).count()) > 0;

/** Picks a scope by its label ("Me" is Personal on the phone; desktop says "Personal"). */
export async function pickScope(page: Page, name: string) {
  if (await onPhone(page)) {
    await scopeMenu(page).click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
    // The menu fades out; the next step starts once it is gone.
    await expect(page.getByRole("menu")).toHaveCount(0);
  } else await scopeSeg(page).getByRole("radio", { name, exact: true }).click();
}

/** Waits until the switch shows `name` as the current scope. */
export async function expectScope(page: Page, name: string) {
  if (await onPhone(page)) await expect(scopeMenu(page)).toHaveAccessibleName(`Scope: ${name}`);
  else await expect(scopeSeg(page).getByRole("radio", { name, exact: true })).toHaveAttribute("aria-checked", "true");
}
