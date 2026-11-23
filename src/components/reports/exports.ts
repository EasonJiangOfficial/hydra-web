import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatMoney } from "@/components/kit/money";
import { headline, incomeSources, monthLabel, percent, type ExportInput, type ExportKind, type ExportTransaction, type ReportsData } from "./model";
import type { PayerRow, TaxLineTotal } from "@/lib/reports/queries";

/**
 * Report downloads (DESIGN.md section 6.4): the monthly PDF, the transactions CSV, income by payer CSV and
 * the year-end tax pack (one PDF plus the CSVs, in one zip). Pure: bytes in, bytes out, no database. The
 * route handlers load the numbers (from src/lib/reports) and call `buildExport`.
 */

export interface ExportFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Dollars with two decimals from integer cents, no grouping (spreadsheets sum it). */
export function dollars(cents: number) {
  const abs = Math.abs(Math.round(cents));
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** One cell. Text that a spreadsheet would run as a formula (bank text is untrusted) gets a leading quote. */
function cell(v: string | number, text = true) {
  let s = String(v);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csv = (header: string[], rows: (string | number)[][], numeric: number[] = []) =>
  [header, ...rows].map((r, i) => r.map((v, c) => cell(v, i === 0 || !numeric.includes(c))).join(",")).join("\r\n") + "\r\n";

export function transactionsCsv(rows: readonly ExportTransaction[]) {
  return csv(
    ["id", "date", "name", "payer", "category", "business", "amount"],
    rows.map((t) => [t.id, t.day, t.name, t.payer, t.category, t.business, dollars(t.cents)]),
    [0, 1, 6],
  );
}

export function payersCsv(rows: readonly PayerRow[]) {
  return csv(
    ["payer", "transactions", "amount", "share_percent"],
    rows.map((r) => [r.payer, r.count, dollars(r.cents), (r.share * 100).toFixed(1)]),
    [1, 2, 3],
  );
}

export function taxLinesCsv(rows: readonly TaxLineTotal[]) {
  return csv(
    ["business", "year", "line", "name", "transactions", "amount"],
    rows.map((r) => [r.entitySlug, r.year, r.code, r.name, r.count, dollars(r.cents)]),
    [1, 4, 5],
  );
}

// ---------------------------------------------------------------------------
// Zip (stored, no compression: the PDF is already compressed and the CSVs are small)
// ---------------------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files: readonly { name: string; bytes: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: DataView, at: number, n: number) => v.setUint16(at, n, true);
  const u32 = (v: DataView, at: number, n: number) => v.setUint32(at, n, true);
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const local = new DataView(new ArrayBuffer(30));
    u32(local, 0, 0x04034b50);
    u16(local, 4, 20);
    u16(local, 6, 0x0800); // names are UTF-8
    u16(local, 10, 0);
    u16(local, 12, 0x21); // 1980-01-01, a fixed date keeps the bytes the same each run
    u32(local, 14, crc);
    u32(local, 18, f.bytes.length);
    u32(local, 22, f.bytes.length);
    u16(local, 26, name.length);
    const head = new DataView(new ArrayBuffer(46));
    u32(head, 0, 0x02014b50);
    u16(head, 4, 20);
    u16(head, 6, 20);
    u16(head, 8, 0x0800);
    u16(head, 14, 0x21);
    u32(head, 16, crc);
    u32(head, 20, f.bytes.length);
    u32(head, 24, f.bytes.length);
    u16(head, 28, name.length);
    u32(head, 42, offset);
    parts.push(new Uint8Array(local.buffer), name, f.bytes);
    central.push(new Uint8Array(head.buffer), name);
    offset += 30 + name.length + f.bytes.length;
  }
  const size = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  u32(end, 0, 0x06054b50);
  u16(end, 8, files.length);
  u16(end, 10, files.length);
  u32(end, 12, size);
  u32(end, 16, offset);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PDF, in the design language: off-black on white, hairlines, regular and medium weight, no color
// ---------------------------------------------------------------------------

const INK = rgb(0.114, 0.114, 0.122); // #1D1D1F
const GRAY = rgb(0.431, 0.431, 0.451); // #6E6E73
const RULE = rgb(0.898, 0.898, 0.918); // #E5E5EA
const TRACK = rgb(0.961, 0.961, 0.969); // #F5F5F7
const PAGE = { w: 612, h: 792, margin: 48 } as const;
const WIDTH = PAGE.w - PAGE.margin * 2;

/** The standard fonts hold Latin-1 only; anything else prints as "?" rather than failing the file. */
const safe = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

class Sheet {
  page!: PDFPage;
  y = 0;
  private pages = 0;
  private constructor(
    readonly pdf: PDFDocument,
    readonly regular: PDFFont,
    readonly medium: PDFFont,
    private readonly footer: string,
  ) {}

  static async create(title: string, footer: string) {
    const pdf = await PDFDocument.create();
    pdf.setTitle(title);
    pdf.setProducer("Hydra");
    pdf.setCreator("Hydra");
    const s = new Sheet(pdf, await pdf.embedFont(StandardFonts.Helvetica), await pdf.embedFont(StandardFonts.HelveticaBold), footer);
    s.addPage();
    return s;
  }

  addPage() {
    this.page = this.pdf.addPage([PAGE.w, PAGE.h]);
    this.pages++;
    this.y = PAGE.h - PAGE.margin;
    this.page.drawText(safe(`${this.footer}   Page ${this.pages}`), { x: PAGE.margin, y: 28, size: 8, font: this.regular, color: GRAY });
  }

  /** Room for `h` more points, else a new page. */
  need(h: number) {
    if (this.y - h < PAGE.margin) this.addPage();
  }

  text(s: string, x: number, size: number, opts: { bold?: boolean; gray?: boolean; right?: number } = {}) {
    const font = opts.bold ? this.medium : this.regular;
    const t = safe(s);
    const w = font.widthOfTextAtSize(t, size);
    this.page.drawText(t, { x: opts.right === undefined ? x : opts.right - w, y: this.y, size, font, color: opts.gray ? GRAY : INK });
  }

  /** Cuts `s` to `max` points wide with an ellipsis. */
  fit(s: string, size: number, max: number, bold = false) {
    const font = bold ? this.medium : this.regular;
    let t = safe(s);
    if (font.widthOfTextAtSize(t, size) <= max) return t;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > max) t = t.slice(0, -1);
    return `${t}...`;
  }

  rule(gap = 0) {
    this.page.drawLine({ start: { x: PAGE.margin, y: this.y - gap }, end: { x: PAGE.w - PAGE.margin, y: this.y - gap }, thickness: 0.5, color: RULE });
  }

  /** The logo: three linked rings (stroke as thick as the word's stem), then the word. */
  logo() {
    const r = 7;
    const cy = this.y - 6;
    for (let i = 0; i < 3; i++) {
      this.page.drawCircle({ x: PAGE.margin + r + i * r * 1.15, y: cy, size: r, borderColor: INK, borderWidth: 1.1 });
    }
    this.text("Hydra", PAGE.margin + r * 4.6 + 6, 13);
    this.y -= 34;
  }

  heading(s: string) {
    this.need(60);
    this.y -= 18;
    this.text(s, PAGE.margin, 11, { bold: true });
    this.y -= 8;
    this.rule();
    this.y -= 4;
  }

  /** A strip: cells inside one outline, hairlines between them. */
  strip(cells: { label: string; value: string }[]) {
    this.need(70);
    const h = 54;
    const w = WIDTH / cells.length;
    this.page.drawRectangle({ x: PAGE.margin, y: this.y - h, width: WIDTH, height: h, borderColor: RULE, borderWidth: 0.75 });
    cells.forEach((c, i) => {
      const x = PAGE.margin + i * w;
      if (i) this.page.drawLine({ start: { x, y: this.y }, end: { x, y: this.y - h }, thickness: 0.75, color: RULE });
      const top = this.y;
      this.y = top - 18;
      this.text(c.label, x + 12, 8.5, { gray: true });
      this.y = top - 40;
      this.text(c.value, x + 12, 17, { bold: true });
      this.y = top;
    });
    this.y -= h + 4;
  }

  /** A table row: first cell left, the rest right-aligned at `cols` (x of each right edge). Optional bar under the label. */
  row(label: string, cols: string[], rights: number[], opts: { bar?: number; head?: boolean } = {}) {
    this.need(22);
    this.y -= 15;
    const size = opts.head ? 8.5 : 10;
    this.text(this.fit(label, size, opts.bar !== undefined ? 215 : rights[0]! - PAGE.margin - 90), PAGE.margin, size, { gray: opts.head });
    cols.forEach((c, i) => this.text(c, 0, size, { right: rights[i]!, gray: opts.head }));
    if (opts.bar !== undefined) {
      const bx = PAGE.margin + 230;
      const bw = Math.max(0, rights[0]! - 96 - bx);
      this.page.drawRectangle({ x: bx, y: this.y + 2, width: bw, height: 3, color: TRACK });
      this.page.drawRectangle({ x: bx, y: this.y + 2, width: bw * Math.min(1, Math.max(0, opts.bar)), height: 3, color: INK });
    }
    this.y -= 6;
    if (!opts.head) this.rule();
  }

  async save() {
    return this.pdf.save({ useObjectStreams: false });
  }
}

const RIGHTS = [PAGE.w - PAGE.margin - 100, PAGE.w - PAGE.margin - 40, PAGE.w - PAGE.margin];

function totals(sheet: Sheet, d: Pick<ReportsData["flow"], "incomeCents" | "spendingCents">) {
  const h = headline(d);
  sheet.strip([
    { label: "Net income", value: formatMoney(h.netCents) },
    { label: "Income", value: formatMoney(h.incomeCents) },
    { label: "Expenses", value: formatMoney(h.spendingCents) },
    { label: "Savings rate", value: h.savingsRate === null ? "-" : percent(h.savingsRate) },
  ]);
}

function payerRows(sheet: Sheet, payers: readonly PayerRow[], limit: number) {
  sheet.row("Payer", ["Transactions", "Amount"], [RIGHTS[1]! - 30, RIGHTS[2]!], { head: true });
  for (const p of payers.slice(0, limit)) sheet.row(p.payer, [String(p.count), formatMoney(p.cents)], [RIGHTS[1]! - 30, RIGHTS[2]!], { bar: p.share });
  if (payers.length > limit) {
    const rest = payers.slice(limit);
    sheet.row(`${rest.length} more`, [String(rest.reduce((a, p) => a + p.count, 0)), formatMoney(rest.reduce((a, p) => a + p.cents, 0))], [RIGHTS[1]! - 30, RIGHTS[2]!]);
  }
}

/** The monthly report: the four figures, where the money came from and went, income by payer to date. */
export async function monthlyPdf(d: ReportsData, scopeName?: string): Promise<Uint8Array> {
  const scope = scopeName ?? (d.scope === "all" ? "All" : d.scope === "ugc" ? "UGC" : d.scope === "personal" ? "Personal" : d.scope);
  const label = monthLabel(d.month);
  const sheet = await Sheet.create(`Hydra report, ${label}`, `Hydra monthly report, ${label}, ${scope}`);
  sheet.logo();
  sheet.text("Monthly report", PAGE.margin, 22, { bold: true });
  sheet.y -= 18;
  sheet.text(`${label}  -  ${scope}  -  ${d.range.from} to ${d.range.to}`, PAGE.margin, 10, { gray: true });
  sheet.y -= 22;
  totals(sheet, d.flow);

  sheet.heading("Where the money came from");
  const sources = incomeSources(d.flow);
  const earned = d.flow.incomeCents || 1;
  for (const l of sources) {
    const n = d.flow.nodes.find((x) => x.id === l.source);
    sheet.row(n?.label ?? l.source, [String(l.rowIds.length), formatMoney(l.cents)], [RIGHTS[1]! - 30, RIGHTS[2]!], { bar: l.cents / earned });
  }
  if (!sources.length) sheet.row("Nothing came in", [], [RIGHTS[2]!]);
  const refunds = d.flow.links.find((l) => l.source === "refunds" && l.target === "income");
  if (refunds) sheet.row("Refunds", [String(refunds.rowIds.length), formatMoney(refunds.cents)], [RIGHTS[1]! - 30, RIGHTS[2]!]);
  if (d.flow.drawnCents) sheet.row("Drawn from savings", ["", formatMoney(d.flow.drawnCents)], [RIGHTS[1]! - 30, RIGHTS[2]!]);

  sheet.heading("Where it went");
  const out = d.flow.links.filter((l) => l.source === "income");
  const spent = out.reduce((a, l) => a + l.cents, 0) || 1;
  for (const l of out) {
    const n = d.flow.nodes.find((x) => x.id === l.target);
    sheet.row(n?.label ?? l.target, [l.rowIds.length ? String(l.rowIds.length) : "", formatMoney(l.cents)], [RIGHTS[1]! - 30, RIGHTS[2]!], { bar: l.cents / spent });
  }

  sheet.heading(`Income by payer, ${d.payers.range.from} to ${d.payers.range.to}`);
  payerRows(sheet, d.payers.rows, 10);
  sheet.y -= 14;
  sheet.text(`${d.flow.rowIds.length} transactions in ${label}. Transfers and card payments are left out.`, PAGE.margin, 8.5, { gray: true });
  return sheet.save();
}

/** The year-end pack's PDF: the year's figures, income by payer, and Schedule C lines per business. */
export async function taxPackPdf(y: ExportInput["year"]): Promise<Uint8Array> {
  const year = y.range.from.slice(0, 4);
  const sheet = await Sheet.create(`Hydra tax pack, ${year}`, `Hydra year-end tax pack, ${year}`);
  sheet.logo();
  sheet.text("Year-end tax pack", PAGE.margin, 22, { bold: true });
  sheet.y -= 18;
  sheet.text(`${year}  -  ${y.range.from} to ${y.range.to}`, PAGE.margin, 10, { gray: true });
  sheet.y -= 22;
  totals(sheet, y.flow);

  sheet.heading("Income by payer");
  payerRows(sheet, y.payers.rows, 25);

  const bySlug = Map.groupBy(y.taxLines, (r) => r.entitySlug);
  for (const [slug, lines] of bySlug) {
    sheet.heading(`Schedule C lines, ${slug}`);
    sheet.row("Line", ["Transactions", "Amount"], [RIGHTS[1]! - 30, RIGHTS[2]!], { head: true });
    for (const l of [...lines].sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }))) {
      sheet.row(`${l.code}  ${l.name}`, [String(l.count), formatMoney(l.cents)], [RIGHTS[1]! - 30, RIGHTS[2]!]);
    }
    sheet.row("Total", [String(lines.reduce((a, l) => a + l.count, 0)), formatMoney(lines.reduce((a, l) => a + l.cents, 0))], [RIGHTS[1]! - 30, RIGHTS[2]!]);
  }
  if (!bySlug.size) sheet.row("No expense is mapped to a Schedule C line", [], [RIGHTS[2]!]);
  sheet.y -= 14;
  sheet.text(`${y.transactions.length} transactions in ${year}. The CSV files in this pack list each one.`, PAGE.margin, 8.5, { gray: true });
  return sheet.save();
}

// ---------------------------------------------------------------------------
// One entry point for both route handlers
// ---------------------------------------------------------------------------

const utf8 = (s: string) => new TextEncoder().encode(s);

export async function buildExport(kind: ExportKind, input: ExportInput): Promise<ExportFile> {
  const { data, year } = input;
  const tag = `${data.month}${data.scope === "all" ? "" : `-${data.scope}`}`;
  const y = year.range.from.slice(0, 4);
  switch (kind) {
    case "monthly-pdf":
      return { filename: `hydra-report-${tag}.pdf`, contentType: "application/pdf", bytes: await monthlyPdf(data, input.scopeName) };
    case "transactions-csv":
      return { filename: `hydra-transactions-${tag}.csv`, contentType: "text/csv; charset=utf-8", bytes: utf8(transactionsCsv(input.transactions)) };
    case "payers-csv":
      return { filename: `hydra-income-by-payer-${data.payers.range.to.slice(0, 4)}-ytd.csv`, contentType: "text/csv; charset=utf-8", bytes: utf8(payersCsv(data.payers.rows)) };
    case "tax-pack":
      return {
        filename: `hydra-tax-pack-${y}.zip`,
        contentType: "application/zip",
        bytes: zip([
          { name: `tax-pack-${y}.pdf`, bytes: await taxPackPdf(year) },
          { name: `transactions-${y}.csv`, bytes: utf8(transactionsCsv(year.transactions)) },
          { name: `income-by-payer-${y}.csv`, bytes: utf8(payersCsv(year.payers.rows)) },
          { name: `schedule-c-lines-${y}.csv`, bytes: utf8(taxLinesCsv(year.taxLines)) },
        ]),
      };
  }
}
