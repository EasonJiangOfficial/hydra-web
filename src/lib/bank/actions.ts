"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { z } from "zod";
import { withActivity, type WithActivity } from "@/lib/activity/request";
import { detectAndSaveRecurring, processIngested } from "@/lib/rules/engine";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken, encryptToken } from "./crypto";
import { InvalidEnvError, MissingEnvError } from "./env";
import { parseImport, withImportHashes, type ImportRow } from "./import";
import { createPlaidProvider } from "./plaid";
import { BankProviderError } from "./provider";
import { NotOwnerError, ownerToday, requireOwner, runSync, webhookUrl } from "./server";
import type { SyncResult } from "./sync";

/**
 * Bank writes as typed actions: input validated, owner checked. The pages, the API routes and the
 * Hydra Agent (U13) all call these. Expected failures come back as `{ ok: false, error }`; the edit
 * actions return the values they replaced (`before`) so a caller can undo.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; itemId?: string } };

class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly itemId?: string,
  ) {
    super(message);
  }
}

type Owner = { db: SupabaseClient; userId: string };

async function act<S extends z.ZodType, T>(
  schema: S,
  input: unknown,
  run: (input: z.output<S>, owner: Owner) => Promise<T>,
): Promise<ActionResult<T>> {
  const fail = (code: string, message: string, itemId?: string): ActionResult<T> => ({
    ok: false,
    error: itemId ? { code, message, itemId } : { code, message },
  });
  try {
    const owner = await requireOwner();
    const parsed = schema.safeParse(input);
    if (!parsed.success) return fail("invalid_input", z.prettifyError(parsed.error));
    return { ok: true, data: await run(parsed.data, owner) };
  } catch (error) {
    if (error instanceof ActionError) return fail(error.code, error.message, error.itemId);
    if (error instanceof NotOwnerError) return fail("not_owner", "Sign in as the owner");
    if (error instanceof BankProviderError) return fail(error.code, "The bank feed refused the request");
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) return fail("not_configured", error.message);
    console.error(`[bank] ${(error as Error).message}`);
    return fail("internal", "Something went wrong");
  }
}

function must<T>(what: string, result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.data === null) throw new ActionError("not_found", `${what}: not found`);
  return result.data;
}

const id = z.guid();
const day = z.iso.date();
const cents = z.int().min(-1e13).max(1e13);
const kind = z.enum(["cash", "card", "loan", "asset"]);
const label = (max: number) => z.string().trim().min(1).max(max);
/** Optional text; "" or null clears it. */
const clearable = (max: number) =>
  z.string().trim().max(max).nullable().transform((s) => s || null).optional();

const chunk = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

const definedOnly = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function syncLater(itemId: string) {
  after(() =>
    runSync(itemId).then(
      (r) => r.status === "error" && console.error(`[bank] sync ${itemId}: ${r.code}`),
      (e) => console.error(`[bank] sync ${itemId}: ${(e as Error).message}`),
    ),
  );
}

async function sealedItem(itemId: string) {
  return must(
    "bank item",
    await createAdminClient().from("bank_items").select("provider_item_id, access_token").eq("id", itemId).maybeSingle(),
  ) as { provider_item_id: string; access_token: string };
}

async function loadAccount(db: SupabaseClient, accountId: string) {
  return must(
    "account",
    await db.from("accounts").select("id, kind, is_manual, closed_at").eq("id", accountId).maybeSingle(),
  ) as { id: string; kind: string; is_manual: boolean; closed_at: string | null };
}

async function writeBalance(db: SupabaseClient, accountId: string, asOf: string, currentCents: number) {
  const { error } = await db
    .from("balances")
    .upsert({ account_id: accountId, as_of: asOf, current_cents: currentCents }, { onConflict: "account_id,as_of" });
  if (error) throw new Error(`write balance: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

/** A Plaid Link token for a new bank login. */
export async function createLinkToken(): Promise<ActionResult<{ linkToken: string; expiration: string }>> {
  return act(z.undefined(), undefined, async (_, { userId }) =>
    createPlaidProvider().createLinkToken({ userId, webhookUrl: await webhookUrl() }),
  );
}

/** A Link token in update mode: repairs an existing login without using a new Plaid slot. */
export async function startUpdateMode(input: { itemId: string }): Promise<ActionResult<{ linkToken: string; expiration: string }>> {
  return act(z.object({ itemId: id }), input, async ({ itemId }, { userId }) => {
    const item = await sealedItem(itemId);
    return createPlaidProvider().createLinkToken({
      userId,
      webhookUrl: await webhookUrl(),
      accessToken: decryptToken(item.access_token, item.provider_item_id),
    });
  });
}

/**
 * Finish a link: exchange Link's public token, store the access token encrypted, start the first
 * sync. A second login to an institution that is already linked is refused (`duplicate_institution`
 * with the existing item's id, to repair it with update mode) and the new Plaid item is removed.
 */
export async function exchangePublicToken(input: {
  publicToken: string;
}): Promise<ActionResult<{ itemId: string; institutionName: string | null }>> {
  return act(z.object({ publicToken: label(500) }), input, async ({ publicToken }) => {
    const provider = createPlaidProvider();
    const linked = await provider.exchangePublicToken(publicToken);
    const admin = createAdminClient();
    const saved = await admin
      .from("bank_items")
      .insert({
        provider: "plaid",
        provider_item_id: linked.providerItemId,
        institution_id: linked.institutionId,
        institution_name: linked.institutionName,
        access_token: encryptToken(linked.accessToken, linked.providerItemId),
      })
      .select("id")
      .single();

    if (saved.error?.code === "23505") {
      // The same item saved already (a retried request): never remove it, it is the live link.
      const { data: same } = await admin
        .from("bank_items")
        .select("id")
        .eq("provider", "plaid")
        .eq("provider_item_id", linked.providerItemId)
        .maybeSingle();
      if (same) return { itemId: same.id as string, institutionName: linked.institutionName };
      // Another live link to this institution: the new item is the duplicate. Removing it stops its
      // billing; it does not give the Trial slot back.
      const { data: existing } = await admin
        .from("bank_items")
        .select("id")
        .eq("provider", "plaid")
        .eq("institution_id", linked.institutionId ?? "")
        .neq("status", "revoked")
        .maybeSingle();
      await provider.removeItem(linked.accessToken).catch((e: Error) => console.error(`[bank] remove duplicate item: ${e.message}`));
      throw new ActionError("duplicate_institution", "This bank is already linked. Repair it with update mode.", existing?.id as string | undefined);
    }
    const { id: itemId } = must("save bank item", saved) as { id: string };
    syncLater(itemId);
    return { itemId, institutionName: linked.institutionName };
  });
}

/** Pull new transactions, balances and card statements for one bank login now. */
export async function syncBankItem(input: { itemId: string }): Promise<ActionResult<SyncResult>> {
  return act(z.object({ itemId: id }), input, async ({ itemId }) => runSync(itemId));
}

// ---------------------------------------------------------------------------
// File import
// ---------------------------------------------------------------------------

export interface ImportSummary {
  rows: number;
  new: number;
  duplicates: number;
  inserted: number;
  errors: { row: number; message: string }[];
  balance: { asOf: string; amountCents: number } | null;
  /** The first 20 new rows. */
  preview: ImportRow[];
}

/** Import a CSV, OFX or QFX file into one account. Run with `dryRun: true` first, then commit. */
export async function importFile(input: {
  accountId: string;
  format: "csv" | "ofx" | "qfx";
  content: string;
  dryRun?: boolean;
  invertSign?: boolean;
}): Promise<ActionResult<ImportSummary>> {
  const schema = z.object({
    accountId: id,
    format: z.enum(["csv", "ofx", "qfx"]),
    content: z.string().min(1).max(5_000_000),
    dryRun: z.boolean().default(true),
    invertSign: z.boolean().default(false),
  });
  return act(schema, input, async ({ accountId, format, content, dryRun, invertSign }, { db }) => {
    const account = await loadAccount(db, accountId);
    if (account.closed_at) throw new ActionError("account_closed", "This account is closed");
    const parsed = parseImport(format, content, { invertSign });
    const rows = withImportHashes(account.id, parsed.rows);

    const existing = new Set<string>();
    for (const hashes of chunk(rows.map((r) => r.hash), 100)) {
      const found = must("find duplicates", await db.from("transactions").select("import_hash").in("import_hash", hashes));
      (found as { import_hash: string }[]).forEach((r) => existing.add(r.import_hash));
    }
    const fresh = rows.filter((r) => !existing.has(r.hash));
    const summary: ImportSummary = {
      rows: rows.length,
      new: fresh.length,
      duplicates: rows.length - fresh.length,
      inserted: 0,
      errors: parsed.errors,
      balance: parsed.balance,
      preview: fresh.slice(0, 20).map((r) => ({ row: r.row, postedOn: r.postedOn, amountCents: r.amountCents, name: r.name, rawDescription: r.rawDescription, fitid: r.fitid })),
    };
    if (dryRun) return summary;

    const startedAt = new Date();
    for (const batch of chunk(fresh, 500)) {
      const written = await db
        .from("transactions")
        .upsert(
          batch.map((r) => ({
            account_id: account.id,
            posted_on: r.postedOn,
            amount_cents: r.amountCents,
            name: r.name,
            raw_description: r.rawDescription || null,
            source: format === "csv" ? "csv" : "ofx",
            import_hash: r.hash,
          })),
          { onConflict: "import_hash", ignoreDuplicates: true },
        )
        .select("id");
      summary.inserted += (must("import rows", written) as unknown[]).length;
    }
    // Apply on ingest (DESIGN 9): rules, transfer pairing, recurring. The rows are in either way.
    if (summary.inserted) {
      try {
        await processIngested(db, startedAt);
        await detectAndSaveRecurring(db, await ownerToday(db));
      } catch (error) {
        console.error(`[bank] rules after import: ${(error as Error).message}`);
      }
    }
    // A file's balance only for a manual account: a linked account's balance comes from its feed.
    if (parsed.balance && account.is_manual) {
      const owed = account.kind === "card" || account.kind === "loan";
      await writeBalance(db, account.id, parsed.balance.asOf, owed ? -parsed.balance.amountCents || 0 : parsed.balance.amountCents);
    }
    return summary;
  });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** A manual account (cash, card, loan or asset). For a card or loan, `balanceCents` is the amount owed. */
export async function addManualAccount(input: {
  name: string;
  kind: "cash" | "card" | "loan" | "asset";
  entityId?: string;
  institution?: string | null;
  mask?: string | null;
  inNetWorth?: boolean;
  balanceCents?: number;
  balanceAsOf?: string;
}): Promise<ActionResult<{ accountId: string }>> {
  const schema = z.object({
    name: label(100),
    kind,
    entityId: id.optional(),
    institution: clearable(100),
    mask: clearable(8),
    inNetWorth: z.boolean().default(true),
    balanceCents: cents.optional(),
    balanceAsOf: day.optional(),
  });
  return act(schema, input, async (a, { db }) => {
    const created = must(
      "add account",
      await db
        .from("accounts")
        .insert(definedOnly({ name: a.name, kind: a.kind, entity_id: a.entityId, institution: a.institution, mask: a.mask, in_net_worth: a.inNetWorth, is_manual: true }))
        .select("id")
        .single(),
    ) as { id: string };
    if (a.balanceCents !== undefined) await writeBalance(db, created.id, a.balanceAsOf ?? (await ownerToday(db)), a.balanceCents);
    return { accountId: created.id };
  });
}

const ACCOUNT_EDIT_COLUMNS = {
  nickname: "nickname",
  entityId: "entity_id",
  inNetWorth: "in_net_worth",
  statementBalanceOverrideCents: "statement_balance_override_cents",
  statementDueOnOverride: "statement_due_on_override",
  name: "name",
  kind: "kind",
  institution: "institution",
  mask: "mask",
} as const;
const MANUAL_ONLY = ["name", "kind", "institution", "mask", "balanceCents"] as const;

/**
 * Edit an account. Any account: nickname, entity, in net worth, card statement overrides (null clears).
 * Manual accounts also: name, kind, institution, mask, and the balance (for a card or loan, the amount owed).
 */
export async function editAccount(input: {
  accountId: string;
  nickname?: string | null;
  entityId?: string;
  inNetWorth?: boolean;
  statementBalanceOverrideCents?: number | null;
  statementDueOnOverride?: string | null;
  name?: string;
  kind?: "cash" | "card" | "loan" | "asset";
  institution?: string | null;
  mask?: string | null;
  balanceCents?: number;
  balanceAsOf?: string;
}): Promise<ActionResult<{ accountId: string; before: Record<string, unknown> }>> {
  const schema = z.object({
    accountId: id,
    nickname: clearable(100),
    entityId: id.optional(),
    inNetWorth: z.boolean().optional(),
    statementBalanceOverrideCents: cents.nullable().optional(),
    statementDueOnOverride: day.nullable().optional(),
    name: label(100).optional(),
    kind: kind.optional(),
    institution: clearable(100),
    mask: clearable(8),
    balanceCents: cents.optional(),
    balanceAsOf: day.optional(),
  });
  return act(schema, input, async (e, { db }) => {
    const account = await loadAccount(db, e.accountId);
    if (!account.is_manual && MANUAL_ONLY.some((k) => e[k] !== undefined)) {
      throw new ActionError("not_manual", "Only a manual account's name, kind, institution, mask and balance can be edited");
    }
    const patch = definedOnly(
      Object.fromEntries(Object.entries(ACCOUNT_EDIT_COLUMNS).map(([key, column]) => [column, e[key as keyof typeof ACCOUNT_EDIT_COLUMNS]])),
    );
    const columns = Object.keys(patch);
    let before: Record<string, unknown> = {};
    if (columns.length) {
      before = must("account", await db.from("accounts").select(columns.join(", ")).eq("id", account.id).single()) as Record<string, unknown>;
      must("edit account", await db.from("accounts").update(patch).eq("id", account.id).select("id").single());
    }
    if (e.balanceCents !== undefined) await writeBalance(db, account.id, e.balanceAsOf ?? (await ownerToday(db)), e.balanceCents);
    return { accountId: account.id, before };
  });
}

/** Close an account: it leaves the account lists; its history stays. Closing twice is a no-op. */
export async function closeAccount(input: { accountId: string }): Promise<ActionResult<{ accountId: string; closedAt: string }>> {
  return act(z.object({ accountId: id }), input, async ({ accountId }, { db }) => {
    const account = await loadAccount(db, accountId);
    if (account.closed_at) return { accountId, closedAt: account.closed_at };
    const closed = must(
      "close account",
      await db.from("accounts").update({ closed_at: new Date().toISOString() }).eq("id", accountId).select("closed_at").single(),
    ) as { closed_at: string };
    return { accountId, closedAt: closed.closed_at };
  });
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** A manual transaction. Money in positive, money out negative. Entity defaults to the account's. */
export async function addManualTransaction(input: {
  accountId: string;
  postedOn: string;
  amountCents: number;
  name: string;
  note?: string | null;
  entityId?: string;
}): Promise<ActionResult<{ transactionId: string }>> {
  const schema = z.object({ accountId: id, postedOn: day, amountCents: cents, name: label(200), note: clearable(1000), entityId: id.optional() });
  return act(schema, input, async (t, { db }) => {
    const account = await loadAccount(db, t.accountId);
    if (account.closed_at) throw new ActionError("account_closed", "This account is closed");
    const created = must(
      "add transaction",
      await db
        .from("transactions")
        // A business named here is the owner's pick: no rule moves it (manual wins).
        .insert(definedOnly({ account_id: account.id, posted_on: t.postedOn, amount_cents: t.amountCents, name: t.name, note: t.note, entity_id: t.entityId, entity_manual: t.entityId ? true : undefined, source: "manual" }))
        .select("id")
        .single(),
    ) as { id: string };
    return { transactionId: created.id };
  });
}

const TRANSACTION_EDIT_COLUMNS = {
  name: "name",
  note: "note",
  hidden: "hidden",
  entityId: "entity_id",
  postedOn: "posted_on",
  amountCents: "amount_cents",
} as const;

/**
 * Edit what the owner owns on a transaction: rename, note (null clears), hide, entity. A manual
 * transaction also takes a new date and amount. A rename sticks: later feed updates keep it.
 */
export async function editTransaction(input: {
  transactionId: string;
  name?: string;
  note?: string | null;
  hidden?: boolean;
  entityId?: string;
  postedOn?: string;
  amountCents?: number;
}): Promise<ActionResult<{ transactionId: string; before: Record<string, unknown> }>> {
  const schema = z.object({
    transactionId: id,
    name: label(200).optional(),
    note: clearable(1000),
    hidden: z.boolean().optional(),
    entityId: id.optional(),
    postedOn: day.optional(),
    amountCents: cents.optional(),
  });
  return act(schema, input, async (e, { db }) => {
    const patch: Record<string, unknown> = definedOnly(
      Object.fromEntries(Object.entries(TRANSACTION_EDIT_COLUMNS).map(([key, column]) => [column, e[key as keyof typeof TRANSACTION_EDIT_COLUMNS]])),
    );
    if (!Object.keys(patch).length) throw new ActionError("invalid_input", "Nothing to change");
    if (patch.name !== undefined) patch.renamed = true;
    const columns = ["source", ...Object.keys(patch)];
    // A business picked by hand beats any rule (DESIGN 9), like a category picked by hand.
    if (patch.entity_id !== undefined) patch.entity_manual = true;
    const row = must("transaction", await db.from("transactions").select(columns.join(", ")).eq("id", e.transactionId).maybeSingle()) as Record<string, unknown>;
    if (row.source !== "manual" && (e.postedOn !== undefined || e.amountCents !== undefined)) {
      throw new ActionError("not_manual", "Only a manual transaction's date and amount can be edited");
    }
    must("edit transaction", await db.from("transactions").update(patch).eq("id", e.transactionId).select("id").single());
    const before = { ...row };
    delete before.source;
    return { transactionId: e.transactionId, before };
  });
}

type DeletedTransaction = { account_id: string; posted_on: string; amount_cents: number; name: string; note: string | null; entity_id: string | null };

/**
 * Delete a manual transaction (one the owner typed in). A bank row is refused (`not_manual`): the
 * feed would add it back, so hide it instead (editTransaction hidden). A paired row is refused until
 * it is unpaired. The owner's own session deletes it, so the delete is in Activity and `activityId`
 * undoes it (the row and its deal payment come back exactly). The database allows only
 * `source = 'manual' and transfer_pair_id is null` (0130 policy) and the delete re-checks both.
 * Returns what was deleted and the deal payment that went with it.
 */
export async function deleteManualTransaction(input: { transactionId: string }): Promise<
  WithActivity<ActionResult<{ transactionId: string; before: DeletedTransaction; dealPayment: { id: string; dealId: string } | null }>>
> {
  let used: SupabaseClient | undefined;
  const result = await act(z.object({ transactionId: id }), input, async ({ transactionId }, { db }) => {
    used = db;
    const row = must(
      "transaction",
      await db.from("transactions").select("source, transfer_pair_id, account_id, posted_on, amount_cents, name, note, entity_id").eq("id", transactionId).maybeSingle(),
    ) as DeletedTransaction & { source: string; transfer_pair_id: string | null };
    if (row.source !== "manual") throw new ActionError("not_manual", "Only a manual transaction can be deleted");
    if (row.transfer_pair_id) throw new ActionError("paired", "Unpair this transfer first");
    const payment = await db.from("deal_payments").select("id, deal_id").eq("transaction_id", transactionId).maybeSingle();
    if (payment.error) throw new Error(`deal payment: ${payment.error.message}`);
    const deleted = await db
      .from("transactions")
      .delete()
      .eq("id", transactionId)
      .eq("source", "manual")
      .is("transfer_pair_id", null)
      .select("id")
      .maybeSingle();
    if (deleted.error) throw new Error(`delete transaction: ${deleted.error.message}`);
    // Paired (or gone) between the read and the delete: the database deleted nothing.
    if (!deleted.data) throw new ActionError("paired", "This transaction changed. Reload and try again");
    const { account_id, posted_on, amount_cents, name, note, entity_id } = row;
    const p = payment.data as { id: string; deal_id: string } | null;
    return {
      transactionId,
      before: { account_id, posted_on, amount_cents, name, note, entity_id },
      dealPayment: p ? { id: p.id, dealId: p.deal_id } : null,
    };
  });
  return withActivity(result, used);
}
