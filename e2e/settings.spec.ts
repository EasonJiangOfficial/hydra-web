import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { pickOption } from "./helpers/controls";
import { expectScope, pickScope } from "./helpers/scope";

/**
 * Settings (owner, 2026-11-22): one page for every setting. /dev/settings runs the real workspace on in-memory
 * businesses with the server's rules; the Agent tab talks to a mocked /api/agent/state that keeps the W6 contract.
 */

const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/settings";
const isPhone = (info: TestInfo) => info.project.name === "phone";
const width = (info: TestInfo) => (isPhone(info) ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `settings-${name}-${width(info)}.png`), fullPage });

async function open(page: Page, query = "") {
  await page.goto(`/dev/settings${query}`);
  await expect(page.getByRole("tab", { name: "Businesses" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

const list = (page: Page) => page.getByRole("region", { name: "Businesses" });
const row = (page: Page, slug: string) => page.locator(`[data-business="${slug}"]`);
const panel = (page: Page, name = "Business") => page.getByRole("dialog", { name });

/** The W6 agent settings route as AGENT-FEEL-2 ships it: GET returns every field, PATCH merges, 400 on a bad value. */
const W6_SETTINGS = {
  sleepWord: "Hydra, sleep",
  brain: "mac",
  wakePhrase: "Hey Hydra",
  clapSensitivity: "medium",
  model: "claude-opus-5-5",
  effortLive: "low",
  effortRoutine: "medium",
};

async function agentRoute(page: Page, initial: Record<string, unknown> = W6_SETTINGS) {
  let settings: Record<string, unknown> = { ...initial };
  const patches: unknown[] = [];
  await page.route("**/api/agent/state", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      const body = req.postDataJSON() as Record<string, unknown>;
      patches.push(body);
      if (typeof body.wakePhrase === "string" && body.wakePhrase.length > 40) return route.fulfill({ status: 400, json: { error: "invalid_input" } });
      settings = { ...settings, ...body };
      return route.fulfill({ json: { ok: true, settings } });
    }
    return route.fulfill({ json: { threads: [], pendingApprovals: [], activity: [], notifications: [], settings } });
  });
  return patches;
}

test.describe("/dev/settings", () => {
  test("every tab opens; Settings is last in the nav", async ({ page }, info) => {
    await agentRoute(page);
    await open(page);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(list(page)).toContainText("Personal");
    await expect(row(page, "ugc")).toContainText("Sole proprietor");
    await expect(row(page, "ugc")).toContainText("1 account");
    await expect(row(page, "ugm")).toContainText("Closed");
    await page.waitForTimeout(300);
    await shot(page, info, "businesses", true);

    for (const [name, region, file] of [
      ["General", "Time zone", "general"],
      ["Agent", "Brain", "agent"],
      ["Connections", "Bank feed", "connections"],
    ] as const) {
      await page.getByRole("tab", { name }).click();
      await expect(page.getByRole("region", { name: region })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`tab=${file}`));
      await page.waitForTimeout(300);
      await shot(page, info, file, true);
    }
    await expect(page.getByRole("region", { name: "Connectors" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Backups" })).toBeVisible();

    if (!isPhone(info)) {
      const nav = page.getByRole("navigation").first().getByRole("link");
      await expect(nav.last()).toHaveText("Settings");
      await expect(nav.last()).toHaveAttribute("aria-current", "page");
    }
  });

  test("add a business in the slide-out; it lists as active with no accounts", async ({ page }, info) => {
    await open(page);
    await list(page).getByRole("link", { name: "Add business" }).click();
    const add = panel(page, "Add business");
    await expect(add).toBeVisible();
    await expect(page).toHaveURL(/business=new/);
    await add.getByLabel("Name").fill("Studio Co");
    await pickOption(add.getByLabel("Type"), { label: "LLC" });
    await page.waitForTimeout(300);
    await shot(page, info, "add-slideout");
    await add.getByRole("button", { name: "Add business" }).click();
    await expect(add).toBeHidden();
    await expect(page).not.toHaveURL(/business=/);
    await expect(row(page, "studio-co")).toContainText("Studio Co");
    await expect(row(page, "studio-co")).toContainText("Active");
    await expect(page.getByRole("status").filter({ hasText: "Added Studio Co." })).toBeVisible();

    // The same name again is refused in the slide-out.
    await list(page).getByRole("link", { name: "Add business" }).click();
    await panel(page, "Add business").getByLabel("Name").fill("studio co");
    await panel(page, "Add business").getByRole("button", { name: "Add business" }).click();
    await expect(panel(page, "Add business").getByRole("alert")).toHaveText("That name is taken");
  });

  test("edit: rename, change the type, close (kept with history) and reopen", async ({ page }, info) => {
    await open(page, "?added=on");
    await row(page, "studio-co").click();
    const p = panel(page);
    await expect(p).toBeVisible();
    await p.getByLabel("Name").fill("Studio Collective");
    await p.getByLabel("Name").press("Enter");
    await expect(p.getByText("Saved")).toBeVisible();
    await pickOption(p.getByLabel("Type"), { label: "Partnership" });
    await expect(row(page, "studio-co")).toContainText("Studio Collective");
    await expect(row(page, "studio-co")).toContainText("Partnership");

    await p.getByRole("button", { name: "Close business" }).click();
    await expect(p.getByRole("button", { name: "Reopen" })).toBeVisible();
    await expect(row(page, "studio-co")).toContainText("Closed");
    await page.keyboard.press("Escape");
    await expect(p).toBeHidden();
    await page.waitForTimeout(300);
    await shot(page, info, "closed-row");

    await row(page, "studio-co").click();
    await panel(page).getByRole("button", { name: "Reopen" }).click();
    await expect(row(page, "studio-co")).toContainText("Active");
  });

  test("Personal has no Close or Delete; a business in use cannot be deleted, with the reason on hover", async ({ page }, info) => {
    await open(page);
    await row(page, "personal").click();
    await expect(panel(page).getByLabel("Name")).toHaveValue("Personal");
    await expect(panel(page).getByLabel("Type")).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "Close business" })).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: /Delete/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await row(page, "ugc").click();
    const del = panel(page).getByRole("button", { name: /Delete/ });
    await expect(del).toBeDisabled();
    const reason = panel(page).locator("span[tabindex='0']").filter({ has: page.getByRole("button", { name: /Delete/ }) });
    if (isPhone(info)) await reason.tap();
    else await reason.hover();
    await expect(page.getByText("In use: close it instead").first()).toBeVisible();
    await page.waitForTimeout(250);
    await shot(page, info, "delete-blocked");
  });

  test("delete an unused business: it asks first, Keep it backs out", async ({ page }) => {
    await open(page, "?added=on");
    await row(page, "studio-co").click();
    await panel(page).getByRole("button", { name: "Delete" }).click();
    const ask = panel(page).getByRole("alertdialog", { name: "Delete business" });
    await expect(ask).toContainText("Delete Studio Co?");
    await ask.getByRole("button", { name: "Keep it" }).click();
    await expect(ask).toHaveCount(0);
    await expect(row(page, "studio-co")).toHaveCount(1);

    await panel(page).getByRole("button", { name: "Delete" }).click();
    await panel(page).getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(panel(page)).toBeHidden();
    await expect(row(page, "studio-co")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Deleted Studio Co." })).toBeVisible();
  });

  test("a new business shows in the scope switch on Reports", async ({ page }, info) => {
    await open(page);
    await list(page).getByRole("link", { name: "Add business" }).click();
    await panel(page, "Add business").getByLabel("Name").fill("North Partners");
    await pickOption(panel(page, "Add business").getByLabel("Type"), { label: "Partnership" });
    await panel(page, "Add business").getByRole("button", { name: "Add business" }).click();
    await expect(row(page, "north-partners")).toBeVisible();

    await page.goto("/dev/reports");
    const name = "North Partners";
    await pickScope(page, name);
    await expect(page).toHaveURL(/scope=north-partners/);
    await expectScope(page, name);
    // Nothing is booked to the new business yet: the figures settle at zero (they count down from All's).
    await expect(page.getByText("Nothing came in or went out this month")).toBeVisible();
    await page.waitForTimeout(1500);
    await shot(page, info, "reports-switch");
  });

  test("the time zone takes an IANA name and refuses an offset", async ({ page }) => {
    await open(page, "?tab=general");
    const tz = page.getByRole("region", { name: "Time zone" });
    const field = tz.getByRole("combobox", { name: "Time zone" });
    await expect(field).toHaveValue("America/Toronto");
    await field.fill("+05:00");
    await field.press("Enter");
    await expect(tz.getByRole("alert")).toContainText("Not a time zone");
    await field.fill("Europe/London");
    await field.press("Enter");
    await expect(tz.getByText("Saved")).toBeVisible();
    await expect(field).toHaveValue("Europe/London");
  });

  test("Agent: all six fields show from the route's answer (0190)", async ({ page }, info) => {
    // The real route's settings object (settingsOut in the /api/agent/state route), brain included.
    await agentRoute(page, { ...W6_SETTINGS, brain: "mac" });
    await open(page, "?tab=agent");
    const brain = page.getByRole("region", { name: "Brain" });
    const voice = page.getByRole("region", { name: "Voice" });
    await expect(brain.getByLabel("Model")).toContainText("Opus 5.5");
    await expect(brain.getByRole("radiogroup", { name: "Effort live" }).getByRole("radio", { name: "Low" })).toBeChecked();
    await expect(brain.getByRole("radiogroup", { name: "Effort routines" }).getByRole("radio", { name: "Medium" })).toBeChecked();
    await expect(voice.getByLabel("Wake phrase")).toHaveValue("Hey Hydra");
    await expect(voice.getByLabel("Sleep word")).toHaveValue("Hydra, sleep");
    await expect(voice.getByRole("radiogroup", { name: "Clap sensitivity" }).getByRole("radio", { name: "Medium" })).toBeChecked();
    await page.waitForTimeout(250);
    await shot(page, info, "agent-six");
  });

  test("Agent: each change PATCHes /api/agent/state with only that field", async ({ page }, info) => {
    const patches = await agentRoute(page);
    await open(page, "?tab=agent");
    const brain = page.getByRole("region", { name: "Brain" });
    const voice = page.getByRole("region", { name: "Voice" });
    await expect(voice.getByLabel("Sleep word")).toHaveValue("Hydra, sleep");
    await expect(voice.getByLabel("Wake phrase")).toHaveValue("Hey Hydra");

    await pickOption(brain.getByLabel("Model"), { label: "Sonnet 5.5" });
    await brain.getByRole("radiogroup", { name: "Effort live" }).getByRole("radio", { name: "Medium" }).click();
    await brain.getByRole("radiogroup", { name: "Effort routines" }).getByRole("radio", { name: "High", exact: true }).click();
    await voice.getByLabel("Wake phrase").fill("Okay Hydra");
    await voice.getByLabel("Wake phrase").press("Enter");
    await voice.getByRole("radiogroup", { name: "Clap sensitivity" }).getByRole("radio", { name: "Low" }).click();
    await voice.getByLabel("Sleep word").fill("Goodnight Hydra");
    await voice.getByLabel("Sleep word").press("Enter");
    await expect.poll(() => patches.length).toBe(6);
    expect(patches).toEqual([
      { model: "claude-sonnet-5-5" },
      { effortLive: "medium" },
      { effortRoutine: "high" },
      { wakePhrase: "Okay Hydra" },
      { clapSensitivity: "low" },
      { sleepWord: "Goodnight Hydra" },
    ]);
    await expect(brain.getByText("Saved")).toBeVisible();
    await page.waitForTimeout(250);
    await shot(page, info, "agent-saved");

    // A one-letter wake phrase is refused before it is sent, and the field goes back.
    await voice.getByLabel("Wake phrase").fill("x");
    await voice.getByLabel("Wake phrase").press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "2 to 40 characters" })).toBeVisible();
    await expect(voice.getByLabel("Wake phrase")).toHaveValue("Okay Hydra");
    expect(patches).toHaveLength(6);
  });
});

test.describe("moved pages", () => {
  test("/accounts?tab=connections goes to Settings > Connections (then sign-in without a session)", async ({ page }) => {
    await page.goto("/accounts?tab=connections");
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent("/settings?tab=connections").replace(/[?]/g, "\\?")}`));
  });
});

test.describe("Taxes for added businesses", () => {
  const stat = (page: Page, label: string) => page.locator('[data-slot="stat"]').filter({ hasText: new RegExp(`^${label}`) });
  const entities = (page: Page) => page.getByRole("radiogroup", { name: "Entity" });

  test("a sole proprietor gets the Schedule C section; a partnership shows income and expenses only", async ({ page }, info) => {
    await page.goto("/dev/taxes?added=on&entity=studio-co");
    await expect(entities(page).getByRole("radio", { name: "Studio Co" })).toBeChecked();
    await expect(entities(page).getByRole("radio")).toHaveCount(5);
    for (const name of ["UGC", "Studio Co", "North Partners", "Personal", "UGM LLC"]) await expect(entities(page).getByRole("radio", { name })).toBeVisible();
    await expect(stat(page, "Business income")).toContainText("$18,600.00");
    await expect(stat(page, "Deductible expenses")).toContainText("$1,446.00");
    await expect(stat(page, "Set aside at 25%")).toBeVisible();
    await expect(page.getByRole("region", { name: "Estimated tax payments" })).toBeVisible();
    await page.waitForTimeout(1200);
    await shot(page, info, "taxes-new-section", true);

    await entities(page).getByRole("radio", { name: "North Partners" }).click();
    await expect(page).toHaveURL(/entity=north-partners/);
    await expect(page.getByText("Return not computed")).toBeVisible();
    await expect(stat(page, "Business income")).toContainText("$9,400.00");
    await expect(stat(page, "Expenses")).toContainText("$3,125.00");
    await expect(stat(page, "Net")).toContainText("$6,275.00");
    await expect(page.locator('[data-slot="stat"]').filter({ hasText: /^Set aside/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Estimated tax payments" })).toHaveCount(0);
    await page.waitForTimeout(1200);
    await shot(page, info, "taxes-summary", true);
  });
});
