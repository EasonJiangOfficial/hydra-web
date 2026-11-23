import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/ugc-payouts";
const width = (info: TestInfo) => (info.project.name === "phone" ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string) =>
  page.locator('[aria-label="Match payouts"]').screenshot({ path: path.join(SHOTS, `payouts-${name}-${width(info)}.png`) });

const stat = (page: Page, label: string) => page.locator('[data-slot="stat"]').filter({ hasText: label }).first();
const dollars = async (page: Page, label: string) =>
  Number((await stat(page, label).locator(".text-figure-s").innerText()).replace(/[^0-9.-]/g, ""));

async function open(page: Page) {
  await page.goto("/dev/ugc");
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await page.waitForTimeout(800);
}

test("Match payouts: suggests unnamed PayPal payouts, Confirm updates Paid and Owed, a rule is offered after two, Not this hides", async ({ page }, info) => {
  await open(page);
  const card = page.locator('[aria-label="Match payouts"]');
  await expect(card).toBeVisible();
  const paypal = card.locator("[data-payout-match]").filter({ hasText: "PAYPAL TRANSFER" });
  await expect(paypal).toHaveCount(2);
  await expect(paypal.first()).toContainText("Brightleaf");
  await card.scrollIntoViewIfNeeded();
  await shot(page, info, "suggested");
  await page.screenshot({ path: path.join(SHOTS, `payouts-overview-${width(info)}.png`) });

  // The hover says why.
  await paypal.first().getByRole("button", { name: "Why Brightleaf" }).hover();
  await expect(page.getByText(/Owed \$[\d,.]+ for the cycle that closed/).filter({ visible: true }).first()).toBeVisible();
  await page.mouse.move(0, 0);

  const paidBefore = await dollars(page, "Paid");
  const owedBefore = await dollars(page, "Owed");
  const amount = Number(await paypal.first().getAttribute("data-amount")) / 100;
  await paypal.first().getByRole("button", { name: /^Confirm / }).click();
  await expect(paypal).toHaveCount(1);
  await expect.poll(() => dollars(page, "Paid")).toBeCloseTo(paidBefore + amount, -1);
  await expect.poll(() => dollars(page, "Owed")).toBeCloseTo(owedBefore - amount, -1);

  await paypal.first().getByRole("button", { name: /^Confirm / }).click();
  await expect(paypal).toHaveCount(0);
  const offer = card.locator('[data-rule-offer="paypal transfer"]');
  await expect(offer).toContainText("Paypal Transfer is Brightleaf");
  await shot(page, info, "rule-offer");
  await offer.getByRole("button", { name: /^Use rule/ }).click();
  await expect(offer).toHaveCount(0);
  const kept = card.locator('[data-kept-rule="paypal transfer"]');
  await expect(kept).toContainText("Paypal Transfer is Brightleaf");
  await expect(card.locator("[data-payout-undo]")).toContainText("Kept: Paypal Transfer is Brightleaf");
  await shot(page, info, "rule-kept");

  // A kept rule can be removed later. Remove asks first; then the offer comes back, and Undo puts the rule back.
  const removeRule = async () => {
    await kept.getByRole("button", { name: /^Remove rule/ }).click();
    const ask = kept.getByRole("group", { name: "Confirm remove" });
    await expect(ask).toContainText("Remove this rule?");
    await shot(page, info, "remove-ask");
    await ask.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(kept).toHaveCount(0);
    await expect(offer).toContainText("Paypal Transfer is Brightleaf");
  };
  await removeRule();
  await expect(card.locator("[data-payout-undo]")).toContainText("Removed: Paypal Transfer is Brightleaf");
  await shot(page, info, "removed");
  await card.locator("[data-payout-undo]").getByRole("button", { name: "Undo" }).click();
  await expect(kept).toContainText("Paypal Transfer is Brightleaf");
  await expect(offer).toHaveCount(0);
  await removeRule();

  // Not this hides the Canvasly deposit; Undo brings it back; Not this again keeps it hidden (this session's memory store).
  const stripe = card.locator("[data-payout-match]").filter({ hasText: "STRIPE TRANSFER CANVASLY" });
  await expect(stripe).toHaveCount(1);
  await stripe.getByRole("button", { name: /^Not / }).click();
  await expect(stripe).toHaveCount(0);
  const undo = card.locator("[data-payout-undo]");
  await expect(undo).toContainText("Not Canvasly: STRIPE TRANSFER CANVASLY");
  await shot(page, info, "undo");
  await undo.getByRole("button", { name: "Undo" }).click();
  await expect(stripe).toHaveCount(1);
  await expect(undo).toHaveCount(0);
  await stripe.getByRole("button", { name: /^Not / }).click();
  await expect(stripe).toHaveCount(0);
});
