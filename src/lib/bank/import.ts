import { createHash } from "node:crypto";
import { toCents } from "./provider";

/**
 * CSV, OFX and QFX import (the fallback that always works, DESIGN.md section 5).
 * Amounts follow Hydra's sign: money in positive, money out negative. OFX already does; most bank
 * CSVs do; a card export that lists purchases as positive needs `invertSign`.
 * Duplicate skip: every row gets a stable hash of account + date + amount + normalized description
 * (+ the file's FITID when present). Identical rows in one file (two coffees) get an occurrence
 * number, so they stay two rows while a re-import of the same file skips both.
 */

export type ImportFormat = "csv" | "ofx" | "qfx";

export interface ImportRow {
  row: number;
  postedOn: string;
  amountCents: number;
  name: string;
  rawDescription: string;
  fitid: string | null;
}

export interface ParsedImport {
  rows: ImportRow[];
  /** OFX ledger balance, as the file states it (a card owes as a negative). */
  balance: { asOf: string; amountCents: number } | null;
  errors: { row: number; message: string }[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO, US M/D/Y (2- or 4-digit year), or OFX YYYYMMDD[...]. null when not a real date. */
export function parseDate(input: string): string | null {
  const s = input.trim();
  let parts: [number, number, number] | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s))) parts = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) parts = [+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1], +m[2]];
  else if ((m = /^(\d{4})(\d{2})(\d{2})[\d.]*(?:\[.*\])?$/.exec(s))) parts = [+m[1], +m[2], +m[3]];
  if (!parts) return null;
  const [y, mo, d] = parts;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** "$1,234.56", "-12.34", "(12.34)", "12.34-" to cents. null when not a number. */
export function parseAmount(input: string): number | null {
  let s = input.replace(/−/g, "-").replace(/USD|[$,\s]/gi, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const cents = toCents(s);
  return negative ? -cents || 0 : cents;
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') field += text[++i];
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      rows.push([...row, field]);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

const COLUMNS = {
  date: ["posted date", "post date", "posting date", "date", "transaction date", "trans. date", "trans date"],
  description: ["description", "payee", "name", "merchant", "details", "transaction description", "memo"],
  amount: ["amount", "transaction amount"],
  debit: ["debit", "debit amount", "withdrawal", "withdrawals", "money out"],
  credit: ["credit", "credit amount", "deposit", "deposits", "money in"],
};

function columnsOf(header: string[]) {
  const cells = header.map((c) => c.trim().toLowerCase());
  const find = (names: string[]) => names.map((n) => cells.indexOf(n)).find((i) => i >= 0) ?? -1;
  const col = {
    date: find(COLUMNS.date),
    description: find(COLUMNS.description),
    amount: find(COLUMNS.amount),
    debit: find(COLUMNS.debit),
    credit: find(COLUMNS.credit),
  };
  return col.date >= 0 && col.description >= 0 && (col.amount >= 0 || col.debit >= 0 || col.credit >= 0) ? col : null;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function parseCsv(text: string): ParsedImport {
  const all = csvRows(text.replace(/^﻿/, ""));
  // Some banks put a summary above the header: the header is the first row naming the columns.
  const headerAt = all.findIndex((r) => columnsOf(r));
  if (headerAt < 0) return { rows: [], balance: null, errors: [{ row: 1, message: "No header row with date, description and amount columns" }] };
  const col = columnsOf(all[headerAt])!;
  const rows: ImportRow[] = [];
  const errors: ParsedImport["errors"] = [];
  all.slice(headerAt + 1).forEach((cells, i) => {
    const row = headerAt + i + 2;
    if (cells.every((c) => !c.trim())) return;
    const cell = (at: number) => (at >= 0 ? (cells[at] ?? "") : "");
    const postedOn = parseDate(cell(col.date));
    let amountCents: number | null;
    if (cell(col.amount).trim()) amountCents = parseAmount(cell(col.amount));
    else {
      const debit = cell(col.debit).trim() ? parseAmount(cell(col.debit)) : null;
      const credit = cell(col.credit).trim() ? parseAmount(cell(col.credit)) : null;
      amountCents = debit === null && credit === null ? null : Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
    }
    if (!postedOn) return errors.push({ row, message: `Bad date "${cell(col.date)}"` });
    if (amountCents === null) return errors.push({ row, message: "Bad or missing amount" });
    const rawDescription = clean(cell(col.description));
    rows.push({ row, postedOn, amountCents, name: rawDescription || "(no description)", rawDescription, fitid: null });
  });
  return { rows, balance: null, errors };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

/** First value of an OFX leaf element. SGML (v1) leaves are unclosed; XML (v2) leaves are closed. */
function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block);
  return m ? m[1].replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e]).trim() : null;
}

function parseOfx(text: string): ParsedImport {
  const rows: ImportRow[] = [];
  const errors: ParsedImport["errors"] = [];
  text
    .split(/<STMTTRN>/i)
    .slice(1)
    .forEach((chunk, i) => {
      const block = chunk.split(/<\/STMTTRN>/i)[0];
      const row = i + 1;
      const postedOn = parseDate(tag(block, "DTPOSTED") ?? "");
      const amountCents = parseAmount(tag(block, "TRNAMT") ?? "");
      if (!postedOn) return errors.push({ row, message: "Bad or missing DTPOSTED" });
      if (amountCents === null) return errors.push({ row, message: "Bad or missing TRNAMT" });
      const name = clean(tag(block, "NAME") ?? "");
      const memo = clean(tag(block, "MEMO") ?? "");
      const rawDescription = clean([name, memo].filter(Boolean).join(" "));
      rows.push({ row, postedOn, amountCents, name: name || memo || "(no description)", rawDescription, fitid: tag(block, "FITID") || null });
    });
  const ledger = text.split(/<LEDGERBAL>/i)[1];
  const asOf = ledger ? parseDate(tag(ledger, "DTASOF") ?? "") : null;
  const amount = ledger ? parseAmount(tag(ledger, "BALAMT") ?? "") : null;
  return { rows, balance: asOf && amount !== null ? { asOf, amountCents: amount } : null, errors };
}

export function parseImport(format: ImportFormat, text: string, options: { invertSign?: boolean } = {}): ParsedImport {
  const parsed = format === "csv" ? parseCsv(text) : parseOfx(text);
  if (options.invertSign) parsed.rows = parsed.rows.map((r) => ({ ...r, amountCents: -r.amountCents || 0 }));
  return parsed;
}

export const normalizeDescription = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function withImportHashes<T extends ImportRow>(accountId: string, rows: T[]): (T & { hash: string })[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const parts = [accountId, r.postedOn, String(r.amountCents), normalizeDescription(r.rawDescription)];
    const key = (r.fitid ? [...parts, `fitid:${r.fitid}`] : parts).join("\u001f");
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const hash = createHash("sha256").update(occurrence ? `${key}\u001f#${occurrence}` : key).digest("hex");
    return { ...r, hash };
  });
}
