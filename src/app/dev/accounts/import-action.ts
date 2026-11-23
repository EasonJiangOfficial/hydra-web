"use server";

import type { ActionResult, ImportSummary } from "@/lib/bank/actions";
import { parseImport, withImportHashes, type ImportRow } from "@/lib/bank/import";

/**
 * The fixture's file import. It runs the real CSV/OFX/QFX parser and the real duplicate hashing (the same code as
 * `importFile` in src/lib/bank/actions.ts) against a fixed list of rows "already stored", so the dry run in /dev/accounts
 * is the real one. It stores nothing and reads no data. Closed in production unless HYDRA_DEV_ROUTES=1, like the /dev pages.
 */

const ALREADY_STORED: ImportRow[] = [
  { row: 0, postedOn: "2026-11-18", amountCents: -1250, name: "BLUE BOTTLE COFFEE", rawDescription: "BLUE BOTTLE COFFEE", fitid: null },
];

const enabled = () => process.env.NODE_ENV !== "production" || process.env.HYDRA_DEV_ROUTES === "1";

export async function fixtureImport(input: {
  accountId: string;
  format: "csv" | "ofx" | "qfx";
  content: string;
  dryRun?: boolean;
  invertSign?: boolean;
}): Promise<ActionResult<ImportSummary>> {
  if (!enabled()) return { ok: false, error: { code: "not_found", message: "Not found" } };
  if (typeof input.content !== "string" || input.content.length === 0 || input.content.length > 5_000_000) {
    return { ok: false, error: { code: "invalid_input", message: "Send a file between 1 byte and 5 MB" } };
  }
  const parsed = parseImport(input.format, input.content, { invertSign: input.invertSign === true });
  const rows = withImportHashes(input.accountId, parsed.rows);
  const stored = new Set(withImportHashes(input.accountId, ALREADY_STORED).map((r) => r.hash));
  const fresh = rows.filter((r) => !stored.has(r.hash));
  return {
    ok: true,
    data: {
      rows: rows.length,
      new: fresh.length,
      duplicates: rows.length - fresh.length,
      inserted: input.dryRun === false ? fresh.length : 0,
      errors: parsed.errors,
      balance: parsed.balance,
      preview: fresh.slice(0, 20).map((r) => ({ row: r.row, postedOn: r.postedOn, amountCents: r.amountCents, name: r.name, rawDescription: r.rawDescription, fitid: r.fitid })),
    },
  };
}
