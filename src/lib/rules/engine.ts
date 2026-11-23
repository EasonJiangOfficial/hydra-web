import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, todayIn } from "@/lib/planning/dates";
import { loadTimeZone } from "@/lib/planning/repository";
import { DEFAULT_PAIR_WINDOW_DAYS, findClearPairs, findTransferSuggestions, pairKey, type AutoPairRow, type PairCandidate } from "@/lib/ledger/pairing";
import { detectRecurring, type RecurringRow } from "@/lib/recurring/detect";
import { planRun } from "./match";
import { actionsSchema, conditionsSchema, type Rule, type RuleTarget } from "./model";

/**
 * The money-rule runs, on any client: the owner's (actions.ts) or the service role (daily cron,
 * bank ingest). Nothing here checks the caller, so never export it from a "use server" file.
 * Writes go through the 0030 functions, which hold the guards (manual wins, pair compare-and-set).
 */

export const TARGET_COLUMNS =
  "id, account_id, amount_cents, name, merchant, note, renamed, entity_id, entity_manual, category_id, category_source, " +
  "tax_line_id, is_transfer, recurring_id, posted_on";
const PAGE = 1000; // PostgREST max_rows
/** Recurring detection looks back this far: two years and a month, so a yearly charge can show three times. */
const RECURRING_LOOKBACK_DAYS = 760;

type Result<T> = { data: T[] | null; error: { message: string } | null };

export const chunk = <T>(items: readonly T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

/** Every row of a query, page by page. `page` must order by a unique key. */
export async function loadAll<T>(page: (from: number, to: number) => PromiseLike<Result<T>>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

export async function ownerToday(db: SupabaseClient, now = new Date()): Promise<string> {
  return todayIn(now, await loadTimeZone(db));
}

/** Enabled and disabled rules in position order. A row that does not parse is skipped, never run. */
export async function loadRules(db: SupabaseClient): Promise<(Rule & { created_at: string; updated_at: string })[]> {
  const { data, error } = await db
    .from("rules")
    .select("id, position, conditions, actions, enabled, created_at, updated_at")
    .order("position")
    .order("created_at");
  if (error) throw new Error(`load rules: ${error.message}`);
  return (data ?? []).flatMap((r) => {
    const conditions = conditionsSchema.safeParse(r.conditions);
    const actions = actionsSchema.safeParse(r.actions);
    return conditions.success && actions.success ? [{ ...r, conditions: conditions.data, actions: actions.data }] : [];
  });
}

/** Which rows a run looks at. Rows the owner categorized by hand are never loaded. */
export type RowScope = { ids: string[] } | { from?: string; to?: string } | { updatedSince: string };

async function loadTargets(db: SupabaseClient, scope: RowScope): Promise<RuleTarget[]> {
  const base = () => db.from("transactions").select(TARGET_COLUMNS).neq("category_source", "manual");
  if ("ids" in scope) {
    const pages = await Promise.all(
      chunk(scope.ids, 200).map(async (ids) => {
        const { data, error } = await base().in("id", ids);
        if (error) throw new Error(error.message);
        return (data ?? []) as unknown as RuleTarget[];
      }),
    );
    return pages.flat();
  }
  return loadAll<RuleTarget>((from, to) => {
    let q = base();
    if ("updatedSince" in scope) q = q.gte("updated_at", scope.updatedSince);
    else {
      if (scope.from) q = q.gte("posted_on", scope.from);
      if (scope.to) q = q.lte("posted_on", scope.to);
    }
    return q.order("id").range(from, to) as unknown as PromiseLike<Result<RuleTarget>>;
  });
}

/** Run the rules over some rows: first match wins, manual rows skipped. Apply on ingest, on demand, after a rule edit. */
export async function applyRules(db: SupabaseClient, scope: RowScope): Promise<{ checked: number; changed: number }> {
  const rules = (await loadRules(db)).filter((r) => r.enabled);
  if (!rules.length) return { checked: 0, changed: 0 };
  const rows = await loadTargets(db, scope);
  let changed = 0;
  for (const batch of chunk(planRun(rules, rows), 500)) {
    const { data, error } = await db.rpc("rules_apply_patches", { p_patches: batch.map((p) => p.patch) });
    if (error) throw new Error(`apply rules: ${error.message}`);
    changed += data as number;
  }
  return { checked: rows.length, changed };
}

export { findClearPairs, findTransferSuggestions, pairKey, type AutoPairRow };

const kindsById = async (db: SupabaseClient, table: "accounts" | "categories") =>
  new Map((await loadAll<{ id: string; kind: string }>((s, e) => db.from(table).select("id, kind").order("id").range(s, e) as unknown as PromiseLike<Result<{ id: string; kind: string }>>)).map((r) => [r.id, r.kind]));

type OpenRow = PairCandidate & { category_id: string | null; name: string; raw_description: string | null };

/** Unpaired, posted rows not set by hand, with what the pair finders need, posted between `from` and `to` when given. */
async function loadPairRows(db: SupabaseClient, { from, to }: { from?: string; to?: string }): Promise<AutoPairRow[]> {
  const [rows, accounts, categories, deals] = await Promise.all([
    loadAll<OpenRow>((start, end) => {
      let q = db
        .from("transactions")
        .select("id, account_id, amount_cents, posted_on, pending, transfer_pair_id, category_source, category_id, name, raw_description")
        .is("transfer_pair_id", null)
        .eq("pending", false)
        .neq("category_source", "manual");
      if (from) q = q.gte("posted_on", from);
      if (to) q = q.lte("posted_on", to);
      return q.order("id").range(start, end) as unknown as PromiseLike<Result<OpenRow>>;
    }),
    kindsById(db, "accounts"),
    kindsById(db, "categories"),
    loadAll<{ transaction_id: string }>((s, e) =>
      db.from("deal_payments").select("transaction_id").order("transaction_id").range(s, e) as unknown as PromiseLike<Result<{ transaction_id: string }>>,
    ),
  ]);
  const matched = new Set(deals.map((d) => d.transaction_id));
  return rows.map((r) => ({
    ...r,
    account_kind: (accounts.get(r.account_id) ?? null) as AutoPairRow["account_kind"],
    category_kind: (r.category_id ? (categories.get(r.category_id) ?? null) : null) as AutoPairRow["category_kind"],
    deal_matched: matched.has(r.id),
  }));
}

/**
 * Pair the card and loan payments posted between `from` and `to` (default: all). Rows up to two
 * windows out are read so a rival candidate just outside the span still makes a match unclear.
 */
export async function pairTransfers(
  db: SupabaseClient,
  { from, to, windowDays = DEFAULT_PAIR_WINDOW_DAYS }: { from?: string; to?: string; windowDays?: number } = {},
): Promise<{ paired: number }> {
  const candidates = await loadPairRows(db, {
    from: from ? addDays(from, -2 * windowDays) : undefined,
    to: to ? addDays(to, 2 * windowDays) : undefined,
  });
  const day = new Map(candidates.map((r) => [r.id, r.posted_on]));
  const inSpan = (id: string) => (!from || day.get(id)! >= addDays(from, -windowDays)) && (!to || day.get(id)! <= addDays(to, windowDays));
  let paired = 0;
  for (const batch of chunk(findClearPairs(candidates, windowDays).filter((p) => inSpan(p.a) && inSpan(p.b)), 200)) {
    const { data, error } = await db.rpc("ledger_pair_transfers", { p_pairs: batch });
    if (error) throw new Error(`pair transfers: ${error.message}`);
    paired += data as number;
  }
  return { paired };
}

/** The possible transfers between cash accounts waiting for the owner (Needs review), oldest first. */
// ponytail: reads every open row on each call; a date floor if the ledger gets large.
export async function transferSuggestions(db: SupabaseClient): Promise<{ a: string; b: string }[]> {
  const [rows, rejected] = await Promise.all([
    loadPairRows(db, {}),
    loadAll<{ a_id: string; b_id: string }>((s, e) =>
      db.from("transfer_rejections").select("a_id, b_id").order("a_id").order("b_id").range(s, e) as unknown as PromiseLike<Result<{ a_id: string; b_id: string }>>,
    ),
  ]);
  const day = new Map(rows.map((r) => [r.id, r.posted_on]));
  return findTransferSuggestions(rows, new Set(rejected.map((r) => pairKey(r.a_id, r.b_id))))
    .sort((x, y) => day.get(x.a)!.localeCompare(day.get(y.a)!) || x.a.localeCompare(y.a));
}

/** Find recurring series and save them as suggestions (dismissed ones stay dismissed). */
export async function detectAndSaveRecurring(db: SupabaseClient, today: string): Promise<{ found: number; saved: number }> {
  const rows = await loadAll<RecurringRow>((from, to) =>
    db
      .from("transactions")
      .select("id, name, posted_on, amount_cents, pending, is_transfer, hidden")
      .gte("posted_on", addDays(today, -RECURRING_LOOKBACK_DAYS))
      .order("id")
      .range(from, to) as unknown as PromiseLike<Result<RecurringRow>>,
  );
  const series = detectRecurring(rows, today);
  let saved = 0;
  for (const batch of chunk(series, 50)) {
    const { data, error } = await db.rpc("recurring_apply_detection", { p_series: batch });
    if (error) throw new Error(`save recurring: ${error.message}`);
    saved += data as number;
  }
  return { found: series.length, saved };
}

/** Rows are stamped by the database clock and `since` comes from the app's: look back this far more. */
const INGEST_CLOCK_SLACK_MS = 5 * 60_000;

/**
 * After rows come in (a bank sync page, a file import, the daily sweep): run the rules over the rows
 * written since `since`, then pair the card and loan payments around their dates. Idempotent: a
 * second run over the same rows changes nothing (patches skip unchanged fields; paired rows are skipped).
 */
export async function processIngested(db: SupabaseClient, since: Date): Promise<{ checked: number; changed: number; paired: number }> {
  const updatedSince = new Date(since.getTime() - INGEST_CLOCK_SLACK_MS).toISOString();
  const rules = await applyRules(db, { updatedSince });
  const edge = async (ascending: boolean) => {
    const { data, error } = await db
      .from("transactions")
      .select("posted_on")
      .gte("updated_at", updatedSince)
      .order("posted_on", { ascending })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`ingested span: ${error.message}`);
    return (data as { posted_on: string } | null)?.posted_on ?? null;
  };
  const [from, to] = await Promise.all([edge(true), edge(false)]);
  const { paired } = from && to ? await pairTransfers(db, { from, to }) : { paired: 0 };
  return { ...rules, paired };
}
