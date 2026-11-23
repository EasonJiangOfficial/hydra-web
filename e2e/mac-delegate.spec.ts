import { expect, test, type TestInfo } from "@playwright/test";

/*
 * The phone controls the Mac (0160): the brain's sub-turn ask reaches the browser's stream as a confirm in the
 * Mac's own words, full target and all, on the phone and the website alike (the /dev/agent mock, src/app/dev/agent/mock.ts).
 * The routes and SQL behind it: src/app/api/agent/relay/relay.routes.test.ts and supabase/tests/0160_mac_delegate.test.sql.
 */
const ASK = "Quit Safari on Studio Mac: 2 windows, 9 tabs, 1 unsent form on mail.google.com";
const shot = (info: TestInfo, name: string) => (process.env.SHOTS_DIR ? `${process.env.SHOTS_DIR}/${name}` : info.outputPath(name));
const w = (info: TestInfo) => (info.project.name === "phone" ? 390 : 1440);

test.beforeEach(async ({ page }) => {
  // No microphone in tests: typed turns only.
  await page.addInitScript(() => {
    Object.defineProperty(window, "speechSynthesis", {
      value: { speaking: false, pending: false, paused: false, getVoices: () => [], speak(u: EventTarget) { setTimeout(() => u.dispatchEvent(new Event("end")), 0); }, cancel() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {} },
      configurable: true,
    });
  });
});

for (const approve of [true, false]) {
  test(`a Mac ask from the phone shows its full target; ${approve ? "Approve" : "Decline"} answers it`, async ({ page }, info) => {
    await page.goto("/dev/agent");
    await expect(page.locator('[data-testid="agent-orb"]:visible')).toBeVisible();
    await page.waitForLoadState("networkidle");
    if (info.project.name === "phone") await page.getByTestId("agent-status-phone").click();
    else await page.getByRole("button", { name: "Open the thread" }).click();
    const panel = page.getByTestId("agent-panel");
    await expect(panel).toBeVisible();
    await panel.getByLabel("Message Hydra").fill("Close Safari on my Mac");
    await panel.getByRole("button", { name: "Send" }).click();

    const confirm = page.getByTestId("agent-confirm");
    await expect(confirm).toContainText(ASK);
    await page.waitForTimeout(350); // the slide
    if (approve) await page.screenshot({ path: shot(info, `mac-delegate-${w(info)}-ask.png`) });
    await confirm.getByRole("button", { name: approve ? "Approve" : "Decline" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId("agent-thread")).toContainText(approve ? "Done. Safari is closed on your Mac." : "Okay. Safari stays open.");
    await page.screenshot({ path: shot(info, `mac-delegate-${w(info)}-${approve ? "approved" : "declined"}.png`) });
  });
}
