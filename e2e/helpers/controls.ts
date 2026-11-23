import { expect, type Locator } from "@playwright/test";

/**
 * Drives Hydra's custom Select (src/components/ui/select.tsx): opens it and clicks the option. `choice` is
 * an option value or its exact label, `{ label }` (string or RegExp), or `{ index }`.
 */
export async function pickOption(field: Locator, choice: string | { label: string | RegExp } | { index: number }) {
  const page = field.page();
  await field.click();
  const list = page.getByRole("listbox").last();
  await expect(list).toBeVisible();
  const multiple = (await list.getAttribute("aria-multiselectable")) === "true";
  let option: Locator;
  if (typeof choice === "string") {
    const byValue = list.locator(`[role="option"][data-value="${choice.replace(/"/g, '\\"')}"]`);
    option = (await byValue.count()) ? byValue : list.getByRole("option", { name: choice, exact: true });
  } else if ("index" in choice) option = list.getByRole("option").nth(choice.index);
  else option = list.getByRole("option", { name: choice.label, exact: typeof choice.label === "string" });
  await option.first().click();
  // A multi-select stays open; a single one closes.
  if (multiple) await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
}
