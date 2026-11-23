import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { pickOption } from "./helpers/controls";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/accounts";

const isPhone = (info: TestInfo) => info.project.name === "phone";
const width = (info: TestInfo) => (isPhone(info) ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `accounts-${name}-${width(info)}.png`), fullPage });

/** Hover on desktop, tap on the phone. */
async function reveal(page: Page, info: TestInfo, locator: ReturnType<Page["locator"]>) {
  await locator.scrollIntoViewIfNeeded();
  if (isPhone(info)) await locator.tap();
  else await locator.hover();
}

/** Opens the fixture and waits until React has taken over. */
async function open(page: Page, query = "") {
  await page.goto(`/dev/accounts${query}`);
  await expect(page.getByRole("tab", { name: "Accounts" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

/** Connections and the idle lock moved to Settings (owner, 2026-11-22): their tests open /dev/settings. */
async function openSettings(page: Page, query = "") {
  await page.goto(`/dev/settings${query}`);
  await expect(page.getByRole("tab", { name: "Businesses" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name });
const group = (page: Page, name: string) => page.getByRole("region", { name });

test.describe("/dev/accounts", () => {
  test("lists cash, cards and manual assets, and the two tabs open", async ({ page }, info) => {
    await open(page);
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
    for (const name of ["Cash", "Credit cards", "Manual assets"]) await expect(group(page, name)).toBeVisible();
    // Cash: $9,420.55 + $22,419.57. Cards show what is owed: $1,604.10 + $714.62.
    await expect(group(page, "Cash")).toContainText("$31,840.12");
    await expect(group(page, "Credit cards")).toContainText("-$2,318.72");
    await expect(group(page, "Credit cards")).toContainText("Statement $1,604.10 · due Nov 27");
    await expect(group(page, "Credit cards")).toContainText("Reconnect");
    await expect(group(page, "Manual assets")).toContainText("You typed this value · updated Oct 1");
    await page.waitForTimeout(500);
    await shot(page, info, "accounts", true);

    await tab(page, "Recurring").click();
    await expect(page.getByRole("region", { name: "Recurring" })).toBeVisible();
    await expect(page).toHaveURL(/tab=recurring/);
    await page.waitForTimeout(300);
    await shot(page, info, "recurring", true);

    await expect(tab(page, "Connections")).toHaveCount(0);

    await tab(page, "Accounts").click();
    await expect(group(page, "Cash")).toBeVisible();
  });

  test("with no Plaid keys the Link button shows its state and an InfoDot instead of failing", async ({ page }, info) => {
    await open(page);
    const connect = page.getByRole("button", { name: /Connect a bank or card/ });
    await expect(connect).toBeDisabled();
    await expect(connect).toContainText("Not set up");
    await reveal(page, info, page.getByRole("button", { name: "About connecting a bank" }));
    await expect(page.getByText(/Plaid is not set up yet\. Add PLAID_CLIENT_ID/)).toBeVisible();
    await shot(page, info, "plaid-unset");
  });

  test("the account panel edits an account, then closes it only after asking", async ({ page }, info) => {
    await open(page);
    await page.getByRole("link", { name: /Chase Checking/ }).click();
    const panel = page.getByRole("dialog", { name: "Account" });
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/account=/);

    await panel.getByLabel("Nickname").fill("Daily");
    await panel.getByLabel("Nickname").blur();
    await expect(panel.getByTestId("account-panel").getByText("Saved")).toBeVisible();

    const net = panel.getByRole("switch", { name: "Count this account in net worth" });
    await expect(net).toHaveAttribute("aria-checked", "true");
    await net.click();
    await expect(net).toHaveAttribute("aria-checked", "false");

    await pickOption(panel.getByLabel("Business"), { label: "UGC" });
    await expect(panel.getByLabel("Business")).toHaveAttribute("data-value", /.+/);
    await expect(panel.getByRole("img", { name: "Balance history of Daily" })).toBeVisible();
    await page.waitForTimeout(1200);
    await shot(page, info, "panel");

    // Close asks first; "Keep it" backs out.
    await panel.getByRole("button", { name: "Close account" }).click();
    const ask = panel.getByRole("alertdialog", { name: "Close this account" });
    await expect(ask).toContainText("Close Daily?");
    await shot(page, info, "panel-close-ask");
    await ask.getByRole("button", { name: "Keep it" }).click();
    await expect(ask).toHaveCount(0);

    await panel.getByRole("button", { name: "Close account" }).click();
    await panel.getByRole("alertdialog").getByRole("button", { name: "Close account" }).click();
    await expect(panel).toBeHidden();
    await expect(page).not.toHaveURL(/account=/);
    await expect(page.getByRole("link", { name: /Daily/ })).toHaveCount(0);
    await expect(group(page, "Cash")).toContainText("$22,419.57");
    await expect(group(page, "Cash")).not.toContainText("$31,840.12");
  });

  test("the Amex panel reconnects through Plaid update mode", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { Plaid: unknown }).Plaid = {
        create: (config: { token: string; onSuccess: (publicToken: string, metadata: unknown) => void }) => ({
          open: () => {
            (window as unknown as { __plaidToken: string }).__plaidToken = config.token;
            setTimeout(() => config.onSuccess("public-sandbox-fixture", {}), 30);
          },
        }),
      };
    });
    await openSettings(page, "?plaid=on&tab=connections");
    const amex = page.locator("[data-item-id]").filter({ hasText: "American Express" });
    await expect(amex).toContainText("Reconnect");
    await expect(amex).toContainText("Error: ITEM_LOGIN_REQUIRED");
    await amex.getByRole("button", { name: "Reconnect" }).click();
    await expect(amex).toContainText("Healthy");
    await expect(amex.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
    await expect(page.evaluate(() => (window as unknown as { __plaidToken: string }).__plaidToken)).resolves.toBe("link-sandbox-update-fixture");
    await expect(page.getByRole("status").filter({ hasText: "Reconnected" })).toBeVisible();
  });

  test("Plaid Link hands over to the bank login and the new account appears", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { Plaid: unknown }).Plaid = {
        create: (config: { token: string; onSuccess: (publicToken: string, metadata: unknown) => void }) => ({
          open: () => setTimeout(() => config.onSuccess("public-sandbox-fixture", {}), 30),
        }),
      };
    });
    await open(page, "?plaid=on");
    const connect = page.getByRole("button", { name: /Connect a bank or card/ });
    await expect(connect).toBeEnabled();
    await expect(connect).toContainText("2 of 10 logins used");
    await connect.click();
    await expect(page.getByRole("link", { name: /Platypus Checking/ })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Bank linked" })).toBeVisible();
    await expect(connect).toContainText("3 of 10 logins used");
  });

  test("while the CSP blocks cdn.plaid.com the page says so", async ({ page }) => {
    const response = await page.goto("/dev/accounts?plaid=on");
    const csp = (await response?.headerValue("content-security-policy")) ?? "";
    test.skip(csp.includes("cdn.plaid.com"), "The integrator has allowed cdn.plaid.com: Link loads for real");
    await expect(page.getByRole("link", { name: /Chase Checking/ })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /Connect a bank or card/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Plaid Link could not load" })).toBeVisible();
  });

  test("an import shows a dry run first, then commits", async ({ page }, info) => {
    await open(page);
    await page.getByRole("button", { name: "Add account" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add an account" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Import a file/ }).click();
    await expect(page.getByRole("dialog", { name: "Import a file" })).toBeVisible();

    const csv = ["Date,Description,Amount", "2026-11-18,BLUE BOTTLE COFFEE,-12.50", "2026-11-19,Trader Joes,-48.20", "2026-11-20,Payout Canvasly,1191.00"].join("\n");
    await page.getByLabel("File", { exact: true }).setInputFiles({ name: "chase.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });

    const dry = page.getByRole("region", { name: "Dry run" });
    await expect(dry).toContainText("2 new");
    await expect(dry).toContainText("1 already here");
    await expect(dry).toContainText("Preview, nothing saved yet");
    await expect(dry).toContainText("Trader Joes");
    await expect(dry).toContainText("+$1,191.00");
    await expect(dry).not.toContainText("BLUE BOTTLE");
    await shot(page, info, "import-dry-run");

    await dry.getByRole("button", { name: "Import 2 transactions" }).click();
    await expect(page.getByRole("dialog").getByRole("status").filter({ hasText: "Imported 2 transactions" })).toBeVisible();
    await shot(page, info, "import-done");
    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // A file that is not CSV, OFX or QFX is refused before anything is read.
    await page.getByRole("button", { name: "Add account" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: /Import a file/ }).click();
    await page.getByLabel("File", { exact: true }).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await expect(page.getByRole("alert").filter({ hasText: "Use a CSV, OFX or QFX file." })).toBeVisible();
  });

  test("a manual account is added to the list", async ({ page }, info) => {
    await open(page);
    await page.getByRole("button", { name: /Add a manual account/ }).click();
    const dialog = page.getByRole("dialog", { name: "Add a manual account" });
    await dialog.getByLabel("Name").fill("Bike");
    await pickOption(dialog.getByLabel("Type"), "asset");
    await dialog.getByLabel("Value").fill("1,250.5");
    await shot(page, info, "manual");
    await dialog.getByRole("button", { name: "Add account" }).click();
    await expect(dialog).toBeHidden();
    await expect(group(page, "Manual assets")).toContainText("Bike");
    await expect(group(page, "Manual assets")).toContainText("$1,250.50");

    await page.getByRole("button", { name: /Add a manual account/ }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Oops");
    await page.getByRole("dialog").getByLabel("Balance").fill("twelve");
    await page.getByRole("dialog").getByRole("button", { name: "Add account" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Type the amount as dollars" })).toBeVisible();
  });

  test("a repeating charge Hydra found is confirmed, and a price change is flagged", async ({ page }, info) => {
    await open(page, "?tab=recurring");
    const table = page.getByRole("table", { name: "Confirmed recurring" });
    await expect(table).toContainText("Adobe Creative Cloud");
    await expect(table).toContainText("Price up $5");
    await expect(table).not.toContainText("Notion");

    const found = page.getByLabel("Found by Hydra");
    await expect(found).toContainText("Notion");
    await shot(page, info, "recurring-found");
    await found.getByRole("button", { name: "Confirm" }).click();
    await expect(found).toHaveCount(0);
    await expect(table).toContainText("Notion");
    await expect(table.getByRole("row").filter({ hasText: "Notion" })).toContainText("$10.00");
    await shot(page, info, "recurring-confirmed", true);
  });

  test("Not recurring drops a suggestion for good", async ({ page }) => {
    await open(page, "?tab=recurring");
    await page.getByLabel("Found by Hydra").getByRole("button", { name: "Not recurring" }).click();
    await expect(page.getByLabel("Found by Hydra")).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Confirmed recurring" })).not.toContainText("Notion");
  });

  test("the idle lock is off by default and takes 1 to 60 minutes", async ({ page }, info) => {
    await openSettings(page, "?tab=general");
    const security = page.getByRole("region", { name: "Security" });
    const seg = security.getByRole("radiogroup", { name: "Idle lock" });
    await expect(security).toContainText("Idle lock off");
    await expect(seg.getByRole("radio", { name: "Off" })).toBeChecked();

    await seg.getByRole("radio", { name: "On" }).click();
    await expect(security).toContainText("Locks after 5 min");
    await expect(security.getByText("Saved")).toBeVisible();

    const minutes = security.getByLabel("Idle lock minutes");
    await minutes.fill("15");
    await minutes.press("Enter");
    await expect(security).toContainText("Locks after 15 min");
    await shot(page, info, "idle-lock-on");

    await minutes.fill("0");
    await minutes.press("Enter");
    await expect(security.getByRole("alert")).toContainText("whole number from 1 to 60");
    await expect(security).toContainText("Locks after 15 min");
    await expect(minutes).toHaveValue("15");

    await minutes.fill("61");
    await minutes.press("Enter");
    await expect(security.getByRole("alert")).toContainText("whole number from 1 to 60");

    await seg.getByRole("radio", { name: "Off" }).click();
    await expect(security).toContainText("Idle lock off");
    await expect(security.getByLabel("Idle lock minutes")).toHaveCount(0);
  });

  test("backups and the connector rows", async ({ page }, info) => {
    await openSettings(page, "?tab=connections");
    await reveal(page, info, page.getByRole("button", { name: "About backups" }));
    await expect(page.getByText("Nightly at 09:17 UTC. Each copy of the database is encrypted, and the last 30 are kept.")).toBeVisible();
    await shot(page, info, "backups-info");
    const connectors = page.getByRole("region", { name: "Connectors" });
    for (const [id, name] of [["google", "Google"], ["instagram", "Instagram"], ["grokbot", "Grokbot"], ["desktop", "Hydra Agent"], ["notifications", "Notifications"]]) {
      await expect(connectors.locator(`[data-connector="${id}"]`)).toContainText(name);
      await expect(connectors.locator(`[data-connector="${id}"]`)).toContainText("Not connected");
    }
    await expect(page.getByRole("region", { name: "Bank feed" })).toContainText("1 needs reconnect");
    await expect(connectors.locator('[data-connector="google"]').getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/api/google/start");
  });

  test("Instagram Login needed reads like Bank feed's; a sign-in note goes once Disconnect answers", async ({ page }, info) => {
    const size = isPhone(info) ? { width: 375, height: 812 } : { width: 1440, height: 900 };
    await page.setViewportSize(size);
    const igShot = (name: string) => page.screenshot({ path: path.join(SHOTS, `accounts-ig-${name}-${size.width}x${size.height}.png`), fullPage: true });
    await openSettings(page, "?tab=connections&connected=on&ig=error&instagram=error");
    const ig = page.locator('[data-connector="instagram"]');
    const pill = (scope: ReturnType<Page["locator"]>) => scope.locator('[data-slot="pill"]').filter({ hasText: "Login needed" }).first();
    const color = (l: ReturnType<Page["locator"]>) => l.evaluate((el) => getComputedStyle(el).color);
    await expect(pill(ig)).toBeVisible();
    expect(await color(pill(ig))).toBe(await color(pill(page.getByRole("region", { name: "Bank feed" }))));
    await expect(ig.getByRole("alert")).toHaveText("Instagram sign-in failed. Try again.");
    await igShot("login-needed");
    await ig.getByRole("button", { name: "Disconnect" }).click();
    await page.getByRole("alertdialog", { name: "Disconnect Instagram" }).getByRole("button", { name: "Disconnect" }).click();
    await expect(ig).toContainText("Not connected");
    await expect(ig.getByRole("alert")).toHaveCount(0);
    await igShot("disconnected");
  });

  test("Instagram without insights granted stays Connected and offers Reconnect to allow them", async ({ page }, info) => {
    const size = isPhone(info) ? { width: 375, height: 812 } : { width: 1440, height: 900 };
    await page.setViewportSize(size);
    await openSettings(page, "?tab=connections&connected=on&ig=nogrant");
    const ig = page.locator('[data-connector="instagram"]');
    await expect(ig).toContainText("Connected");
    await expect(ig.locator('[data-slot="pill"]').filter({ hasText: "Login needed" })).toHaveCount(0);
    await expect(ig.getByRole("link", { name: "Reconnect" })).toHaveAttribute("href", "/api/instagram/start?from=settings");
    await page.screenshot({ path: path.join(SHOTS, `accounts-ig-nogrant-${size.width}x${size.height}.png`), fullPage: true });
  });

  test("connectors: Google, Grokbot keys, Mac pairing and notifications; every revoke asks first", async ({ page }, info) => {
    await openSettings(page, "?tab=connections&connected=on");
    const row = (id: string) => page.locator(`[data-connector="${id}"]`);
    await expect(row("google")).toContainText("owner@example.test");
    for (const id of ["google", "instagram", "grokbot", "desktop", "notifications"]) await expect(row(id)).toContainText("Connected");
    await expect(row("notifications")).toContainText("1 device");
    await expect(row("notifications").getByRole("button", { name: /notifications/ })).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, info, "connectors-connected", true);

    // A new Grokbot key is shown once, then listed by name only.
    await row("grokbot").getByRole("button", { name: "New key" }).click();
    await row("grokbot").getByLabel("Key name").fill("Grokbot phone");
    await row("grokbot").getByRole("button", { name: "Create" }).click();
    await expect(page.getByTestId("new-key")).toHaveText(/^hyd_ugc_/);
    await shot(page, info, "connectors-new-key");
    await row("grokbot").getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("new-key")).toHaveCount(0);
    const keys = row("grokbot").getByRole("listitem");
    await expect(keys).toHaveCount(2);
    await keys.filter({ hasText: "Grokbot phone" }).getByRole("button", { name: "Revoke" }).click();
    const ask = page.getByRole("alertdialog", { name: "Revoke key" });
    await expect(ask).toContainText("Revoke Grokbot phone?");
    await shot(page, info, "connectors-revoke-asks");
    await ask.getByRole("button", { name: "Keep it" }).click();
    await expect(keys).toHaveCount(2);
    await keys.filter({ hasText: "Grokbot phone" }).getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("alertdialog", { name: "Revoke key" }).getByRole("button", { name: "Revoke" }).click();
    await expect(keys).toHaveCount(1);

    // The Hydra Agent's devices: each with its role and its last contact (the server's relay loop is live).
    const paired = row("desktop").getByRole("listitem");
    await expect(paired.filter({ hasText: "Hydra server" })).toHaveAttribute("data-role", "brain");
    await expect(paired.filter({ hasText: "Hydra server" })).toContainText("Server");
    await expect(paired.filter({ hasText: "Hydra server" })).toContainText("online");
    await expect(paired.filter({ hasText: "Studio Mac" })).toHaveAttribute("data-role", "mac");
    await expect(paired.filter({ hasText: "Studio Mac" })).toContainText("8 min ago");
    await expect(paired.filter({ hasText: "Studio Mac" }).getByText("last contact")).toBeVisible({ visible: !isPhone(info) });

    // Pairing a server: the code shows once, with Copy and the one line to run there; Done hides it for good.
    await row("desktop").getByRole("button", { name: "Pair a server" }).click();
    const serverCode = page.getByRole("region", { name: "Server pairing code" });
    await expect(serverCode.getByTestId("pairing-code")).toHaveText("K7Q4M2XP");
    await expect(serverCode).toContainText("Expires in 10 min");
    await serverCode.getByRole("button", { name: "Copy" }).click();
    await expect(serverCode.getByRole("button", { name: "Copied" })).toBeVisible();
    if (!isPhone(info)) {
      await serverCode.getByRole("button", { name: "How to pair the server" }).hover();
      await expect(page.getByText("hydra-brain pair K7Q4M2XP")).toBeVisible();
      await page.waitForTimeout(250);
    }
    await shot(page, info, "connectors-pairing-server");
    await page.mouse.move(0, 0);
    await serverCode.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("pairing-code")).toHaveCount(0);

    // Pairing a Mac: a one-time code; revoking asks first; with the Mac gone the server keeps the row connected.
    await row("desktop").getByRole("button", { name: "Pair a Mac" }).click();
    await expect(page.getByRole("region", { name: "Pairing code" }).getByTestId("pairing-code")).toHaveText("K7Q4M2XP");
    await expect(row("desktop")).toContainText("Expires in 10 min");
    await shot(page, info, "connectors-pairing");
    await paired.filter({ hasText: "Studio Mac" }).getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("alertdialog", { name: "Revoke device" }).getByRole("button", { name: "Revoke" }).click();
    await expect(paired).toHaveCount(1);
    await expect(row("desktop").locator("> div").first()).toContainText("Connected");
    await paired.filter({ hasText: "Hydra server" }).getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByRole("alertdialog", { name: "Revoke device" })).toContainText("Revoke Hydra server?");
    await page.getByRole("alertdialog", { name: "Revoke device" }).getByRole("button", { name: "Revoke" }).click();
    await expect(row("desktop")).toContainText("Not connected");

    // Instagram: the handle and last sync show; disconnect asks first and names what goes and what stays.
    await expect(row("instagram")).toContainText("@studio.notes · synced 2 h ago");
    await row("instagram").getByRole("button", { name: "Disconnect" }).click();
    const igConfirm = page.getByRole("alertdialog", { name: "Disconnect Instagram" });
    await expect(igConfirm).toContainText("Disconnect @studio.notes? Hydra deletes its Instagram token and stops the daily sync. Saved posts and follower counts stay.");
    await shot(page, info, "instagram-disconnect-confirm");
    await igConfirm.getByRole("button", { name: "Keep it" }).click();
    await expect(igConfirm).toHaveCount(0);
    await expect(row("instagram")).toContainText("Connected");
    await row("instagram").getByRole("button", { name: "Disconnect" }).click();
    await igConfirm.getByRole("button", { name: "Disconnect" }).click();
    await expect(row("instagram")).toContainText("Not connected");
    await expect(row("instagram").getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/api/instagram/start?from=settings");

    // Google: disconnect asks first, then Connect comes back.
    await row("google").getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByRole("alertdialog", { name: "Disconnect Google" })).toContainText("Disconnect owner@example.test?");
    await page.getByRole("alertdialog", { name: "Disconnect Google" }).getByRole("button", { name: "Disconnect" }).click();
    await expect(row("google")).toContainText("Not connected");
    await expect(row("google").getByRole("link", { name: "Connect" })).toBeVisible();
  });
});
