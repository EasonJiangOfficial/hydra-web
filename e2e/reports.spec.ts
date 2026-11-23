import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { pickOption } from "./helpers/controls";
import { pickScope } from "./helpers/scope";

/** Screenshots go to SHOTS_DIR when set, else into test-results (git-ignored). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots/reports";

const isPhone = (info: TestInfo) => info.project.name === "phone";
const width = (info: TestInfo) => (isPhone(info) ? 390 : 1440);
const shot = (page: Page, info: TestInfo, name: string, fullPage = false) =>
  page.screenshot({ path: path.join(SHOTS, `reports-${name}-${width(info)}.png`), fullPage });

// The fixture (src/app/dev/reports/fixture-db.ts): November 2026 has income 6,480.00 and spending 4,230.00.
// Earlier months scale the same transactions, so the year to date is computed here from the same rows.
const FACTORS = [0.82, 0.9, 1.05, 0.95, 1.1, 1.0, 0.88, 1.12, 0.97, 1.04];
const INCOME = [160000, 160000, 104000, 104000, 70000, 50000];
const SOFTWARE = [5999, 2000, 23001];
const scaled = (rows: number[], f: number) => rows.reduce((a, c) => a + Math.round(c * f), 0);
const ytd = (rows: number[]) => FACTORS.reduce((a, f) => a + scaled(rows, f), 0) + rows.reduce((a, c) => a + c, 0);
/** Whole dollars, as the page shows a total. */
const whole = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

async function open(page: Page, query = "") {
  await page.goto(`/dev/reports${query}`);
  await expect(page.getByTestId("strip")).toContainText("$6,480", { timeout: 15_000 });
}

/** Charts draw in the first time they are seen. */
async function reveal(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.page().waitForTimeout(1400);
}

const band = (page: Page, color: string) => page.locator(`.recharts-sankey-links path[stroke="${color}"]`);
/** The cash flow: the Sankey on desktop; on the phone, rows (no money behind a sideways scroll). */
const flowView = (page: Page, info: TestInfo) => page.getByTestId(isPhone(info) ? "cash-flow-list" : "cash-flow-chart");

// ---- downloads ----

async function download(page: Page, kind: string) {
  await page.getByRole("button", { name: "Download" }).click();
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByTestId(`download-${kind}`).click()]);
  return { name: file.suggestedFilename(), bytes: readFileSync((await file.path())!) };
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i]!])));
}
const cents = (v: string) => Math.round(Number(v) * 100);
const total = (rows: Record<string, string>[], col: string) => rows.reduce((a, r) => a + cents(r[col]!), 0);

/** The text a PDF draws: pdf-lib compresses page content and writes strings as hex. */
function pdfText(bytes: Buffer) {
  const raw = bytes.toString("latin1");
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try {
      body = inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const t of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(t[1]!, "hex").toString("latin1"));
  }
  return out.join("\n");
}

/** A stored zip: entry name to bytes, from the central directory. */
function unzip(bytes: Buffer) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const size = bytes.readUInt32LE(at + 24);
    const nameLen = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    files.set(name, bytes.subarray(start, start + size));
    at += 46 + nameLen + extra;
  }
  return files;
}

test.describe("/dev/reports", () => {
  test("four tabs, the four figures, and a screenshot of each", async ({ page }, info) => {
    await open(page);
    const strip = page.getByTestId("strip");
    await expect(strip).toContainText("Net income");
    await expect(strip).toContainText("$2,250");
    await expect(strip).toContainText("$6,480");
    await expect(strip).toContainText("$4,230");
    await expect(page.getByTestId("savings-rate")).toHaveText("34.7%");
    for (const name of ["Cash flow", "Spending", "Income", "Trends"]) await expect(page.getByRole("tab", { name })).toBeVisible();

    await reveal(flowView(page, info));
    await shot(page, info, "cash-flow", true);

    await page.getByRole("tab", { name: "Spending" }).click();
    await expect(page).toHaveURL(/tab=spending/);
    await expect(page.getByRole("button", { name: "Open Housing" })).toBeVisible();
    await reveal(page.getByRole("img", { name: "Expenses by category" }));
    await shot(page, info, "spending", true);

    await page.getByRole("tab", { name: "Income" }).click();
    await expect(page.getByTestId("payers-total")).toHaveText(whole(ytd(INCOME)));
    await expect(page.getByTestId("payer-row").first()).toContainText("Wordwise");
    await shot(page, info, "income", true);

    await page.getByRole("tab", { name: "Trends" }).click();
    await expect(page.getByTestId("trend-row")).toHaveCount(12);
    await expect(page.getByTestId("trend-row").first()).toContainText("November 2026");
    await expect(page.getByTestId("trend-row").first()).toContainText("$2,250");
    await reveal(page.getByRole("img", { name: "Income and spending by month" }));
    await shot(page, info, "trends", true);

    await page.getByRole("tab", { name: "Cash flow" }).click();
    await expect(page).not.toHaveURL(/tab=/);
  });

  test("the phone shows where the money went as rows, every amount in view", async ({ page }, info) => {
    test.skip(!isPhone(info), "the phone layout");
    await open(page);
    const list = page.getByTestId("cash-flow-list");
    await reveal(list);
    await expect(page.getByTestId("cash-flow-chart")).toBeHidden();
    await expect(list.getByRole("button", { name: "Open Housing", exact: true })).toContainText("$1,450");
    const wide = await list.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(wide).toBe(false);
    await shot(page, info, "cash-flow-list", true);
  });

  test("Sankey and Bars switch", async ({ page }, info) => {
    test.skip(isPhone(info), "the phone shows rows, not a chart");
    await open(page);
    await reveal(page.getByTestId("cash-flow-chart"));
    await expect(page.locator(".recharts-sankey-links > g")).toHaveCount(12);
    await page.getByRole("radio", { name: "Bars" }).click();
    await expect(page).toHaveURL(/chart=bars/);
    await expect(page.locator(".recharts-sankey-links")).toHaveCount(0);
    await reveal(page.getByRole("img", { name: "Where the money went, by destination" }));
    await expect(page.locator(".recharts-bar-rectangle")).toHaveCount(9);
    await shot(page, info, "bars", true);
    await page.getByRole("radio", { name: "Sankey" }).click();
    await expect(page.locator(".recharts-sankey-links > g")).toHaveCount(12);
  });

  test("hover a Sankey band for its card, click it to open the category panel", async ({ page }, info) => {
    await open(page);
    const housing = isPhone(info) ? page.getByTestId("cash-flow-list").getByRole("button", { name: "Open Housing", exact: true }) : band(page, "var(--sankey-housing)");
    await reveal(flowView(page, info));
    await housing.scrollIntoViewIfNeeded();
    if (!isPhone(info)) {
      await housing.hover();
      const card = page.getByRole("presentation").filter({ hasText: "Income → Housing" });
      await expect(card).toBeVisible();
      await expect(card).toContainText("$1,450.00 · 22.4%");
      await expect(card).toContainText("1 transaction");
      await shot(page, info, "sankey-hover");
    }
    await housing.click();
    await expect(page).toHaveURL(/category=c0000000-0000-4000-8000-000000000010/);
    const panel = page.getByTestId("category-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("textbox", { name: "Category name" })).toHaveValue("Housing");
    await expect(page.getByTestId("panel-total")).toHaveText("$1,450.00");
    await expect(page.getByTestId("panel-transactions")).toContainText("Maple Court");
    await page.waitForTimeout(500);
    await shot(page, info, "panel");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page).not.toHaveURL(/category=/);
  });

  test("a donut slice and a table row open their category, with the month's transactions", async ({ page }, info) => {
    await open(page, "?tab=spending");
    const donut = page.getByRole("img", { name: "Expenses by category" });
    await reveal(donut);
    if (!isPhone(info)) {
      const box = (await donut.boundingBox())!;
      // 12 o'clock, just inside the ring: the first slice, Housing (the largest).
      await page.mouse.move(box.x + box.width / 2 + 14, box.y + box.height * 0.1);
      await expect(page.getByRole("presentation").filter({ hasText: "Housing" })).toContainText("$1,450.00 · 34.3%");
      await page.mouse.click(box.x + box.width / 2 + 14, box.y + box.height * 0.1);
      await expect(page.getByTestId("panel-total")).toHaveText("$1,450.00");
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "Open Food" }).click();
    await expect(page.getByTestId("panel-total")).toHaveText("$520.00");
    // Food holds its Groceries subcategory: four charges, newest first.
    await expect(page.getByTestId("panel-transactions").locator("[data-tx-id]")).toHaveCount(4);
    await expect(page.getByTestId("panel-transactions").locator("[data-tx-id]").first()).toContainText("Corner cafe");
    await expect(page.getByTestId("panel-transactions").getAttribute("data-row-ids")).resolves.toMatch(/^f0000000-/);
  });

  test("row hover cards", async ({ page }, info) => {
    test.skip(isPhone(info), "hover is a mouse gesture");
    await open(page, "?tab=spending");
    await page.getByRole("button", { name: "Open Housing" }).hover();
    await expect(page.getByText("$1,450.00 · 34.3%")).toBeVisible();
    await shot(page, info, "row-hover");
    await page.getByRole("tab", { name: "Income" }).click();
    await page.getByTestId("payer-row").first().hover();
    await expect(page.getByText("Wordwise").last()).toBeVisible();
    await expect(page.getByText(/\d+ transactions/).last()).toBeVisible();
  });

  test("scope and month change every figure", async ({ page }, info) => {
    await open(page);
    await pickScope(page, "UGC");
    await expect(page.getByTestId("strip")).toContainText("$4,870");
    await expect(page.getByTestId("savings-rate")).toHaveText("75.2%");
    await pickScope(page, isPhone(info) ? "Me" : "Personal");
    await expect(page.getByTestId("strip")).toContainText("-$2,620");
    await pickScope(page, "All");
    await expect(page.getByTestId("strip")).toContainText("$2,250");

    await page.getByRole("button", { name: "Previous month" }).click();
    await expect(page.getByTestId("month-label")).toHaveText("October 2026");
    await expect(page.getByTestId("strip")).toContainText(whole(scaled(INCOME, 1.04)));
    await page.getByRole("button", { name: "Next month" }).click();
    await expect(page.getByTestId("month-label")).toHaveText("November 2026");
  });

  test("rename, color, tax line, merge and delete in the panel; merge and delete ask first", async ({ page }, info) => {
    await open(page, "?tab=spending");
    const food = page.getByRole("button", { name: "Open Food" });

    // Rename saves on blur.
    await food.click();
    const name = page.getByRole("textbox", { name: "Category name" });
    await name.fill("Eating out");
    await name.blur();
    await expect(name).toHaveValue("Eating out");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open Eating out" })).toBeVisible();

    // Color.
    await page.getByRole("button", { name: "Open Housing" }).click();
    await page.getByRole("button", { name: /^Color for Housing/ }).click();
    await page.getByRole("textbox", { name: "Custom color" }).fill("#c77a9b");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Color for Housing: #c77a9b" })).toBeVisible();
    // The picker's closing fade holds the top layer for ~100 ms; Escape then goes to the panel.
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Cash flow" }).click();
    await reveal(flowView(page, info));
    if (isPhone(info)) await expect(flowView(page, info).locator('[style*="c77a9b"], [style*="199, 122, 155"]').first()).toBeAttached();
    else await expect(band(page, "#c77a9b").first()).toBeAttached();

    // Tax line: Software is mapped to line 18 for UGC; move it to Advertising and reopen to see it kept.
    await page.getByRole("tab", { name: "Spending" }).click();
    await page.getByRole("button", { name: "Open Software" }).click();
    const line = page.getByRole("combobox", { name: "UGC Schedule C line" });
    await expect(line).toHaveText(/18\s+Office expense/);
    await pickOption(line, { label: /^8\s+Advertising$/ });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open Software" }).click();
    await expect(page.getByRole("combobox", { name: "UGC Schedule C line" })).toHaveText(/8\s+Advertising/);
    await page.keyboard.press("Escape");

    // Merge asks first: cancel changes nothing, confirm moves everything.
    await page.getByRole("button", { name: "Open Shopping" }).click();
    await pickOption(page.getByRole("combobox", { name: "Merge into" }), { label: "Other" });
    await page.getByRole("button", { name: "Merge", exact: true }).click();
    const ask = page.getByRole("alertdialog", { name: "Confirm merge" });
    await expect(ask).toContainText("into Other and delete Shopping?");
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(ask).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Category name" })).toHaveValue("Shopping");
    await page.getByRole("button", { name: "Merge", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Confirm merge" }).getByRole("button", { name: "Merge" }).click();
    await expect(page.getByTestId("category-panel")).toBeHidden();
    await expect(page.getByRole("button", { name: "Open Shopping" })).toHaveCount(0);
    await expect(page.getByRole("row", { name: /Other/ })).toContainText("$445");

    // Delete asks first, and a category with transactions is refused.
    await page.getByRole("button", { name: "Open Transport" }).click();
    await page.getByRole("button", { name: "Delete category" }).click();
    await page.getByRole("alertdialog", { name: "Confirm delete" }).getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("alert")).toContainText("in use");
    await expect(page.getByTestId("category-panel")).toBeVisible();
  });

  test("downloads: the PDF, the CSVs and the tax pack carry the right totals", async ({ page }) => {
    await open(page);

    const pdf = await download(page, "monthly-pdf");
    expect(pdf.name).toBe("hydra-report-2026-11.pdf");
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const text = pdfText(pdf.bytes);
    for (const s of ["Monthly report", "November 2026", "$2,250.00", "$6,480.00", "$4,230.00", "34.7%", "Wordwise", "Housing", "Taxes set aside", "Savings"]) expect(text).toContain(s);

    const tx = await download(page, "transactions-csv");
    expect(tx.name).toBe("hydra-transactions-2026-11.csv");
    const rows = parseCsv(tx.bytes.toString("utf8"));
    // 24 November rows less the card payment (a transfer); the hidden test charge is not in the report either.
    expect(rows).toHaveLength(23);
    expect(new Set(rows.map((r) => r.id)).size).toBe(23);
    expect(rows.every((r) => r.date.startsWith("2026-11"))).toBe(true);
    // Signed as money moved, the column sums to net income: the figure in the strip.
    expect(total(rows, "amount")).toBe(225000);
    expect(total(rows.filter((r) => cents(r.amount) > 0), "amount")).toBe(648000 + 4500);

    const payers = await download(page, "payers-csv");
    expect(payers.name).toBe("hydra-income-by-payer-2026-ytd.csv");
    const byPayer = parseCsv(payers.bytes.toString("utf8"));
    expect(total(byPayer, "amount")).toBe(ytd(INCOME));
    expect(byPayer.map((r) => r.payer)).toEqual(["Wordwise", "Brightleaf", "Zoe Studio"]);
    await page.getByRole("tab", { name: "Income" }).click();
    await expect(page.getByTestId("payers-total")).toHaveText(whole(ytd(INCOME)));

    const pack = unzip((await download(page, "tax-pack")).bytes);
    expect([...pack.keys()].sort()).toEqual(["income-by-payer-2026.csv", "schedule-c-lines-2026.csv", "tax-pack-2026.pdf", "transactions-2026.csv"]);
    const year = parseCsv(pack.get("transactions-2026.csv")!.toString("utf8"));
    expect(year.length).toBeGreaterThan(200);
    const yearNet = total(year, "amount");
    expect(total(parseCsv(pack.get("income-by-payer-2026.csv")!.toString("utf8")), "amount")).toBe(ytd(INCOME));
    // The year's net is the twelve-month trend's net for 2026.
    await page.getByRole("tab", { name: "Trends" }).click();
    await expect(page.getByTestId("trend-row")).toHaveCount(12);
    let trendNet = 0;
    for (const row of await page.getByTestId("trend-row").all()) {
      if ((await row.getAttribute("data-month"))!.startsWith("2026")) {
        const text = await row.locator("td").last().innerText();
        trendNet += cents(text.replace(/[$,+]/g, ""));
      }
    }
    expect(Math.abs(yearNet - trendNet)).toBeLessThan(11 * 100); // the table shows whole dollars
    const lines = parseCsv(pack.get("schedule-c-lines-2026.csv")!.toString("utf8"));
    expect(lines.find((l) => l.line === "23")).toMatchObject({ business: "ugc", year: "2026", amount: "14300.00", transactions: "11" });
    expect(cents(lines.find((l) => l.line === "18")!.amount)).toBe(FACTORS.reduce((a, f) => a + scaled(SOFTWARE, f), 0) + SOFTWARE.reduce((a, c) => a + c, 0));
    const packText = pdfText(pack.get("tax-pack-2026.pdf")!);
    for (const s of ["Year-end tax pack", "Schedule C lines, ugc", "Taxes and licenses", "Office expense", "$14,300.00"]) expect(packText).toContain(s);
  });

  test("a UGC-only download carries only UGC rows", async ({ page }) => {
    await open(page, "?scope=ugc");
    await expect(page.getByTestId("strip")).toContainText("$4,870");
    const rows = parseCsv((await download(page, "transactions-csv")).bytes.toString("utf8"));
    expect(new Set(rows.map((r) => r.business))).toEqual(new Set(["UGC"]));
    expect(total(rows, "amount")).toBe(487000);
  });
});
