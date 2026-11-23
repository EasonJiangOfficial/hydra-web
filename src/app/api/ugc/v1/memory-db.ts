/**
 * Test support: an in-memory stand-in for the service-role Supabase client, with the UGC tables
 * and the connector RPCs. Enough of PostgREST (select with one-level embeds, eq/is/in, order,
 * limit, range, single/maybeSingle, insert/update/upsert/delete, unique keys, foreign keys) for U1's
 * writes and the connector tools to run for real. The SQL versions of the RPCs are proven in
 * supabase/tests/0080_keys.test.sql; these mirror them. Every table and RPC touched is recorded.
 * Not a route: Next only serves route.ts.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code: string; message: string; details?: string } | null };

const UNIQUE: Record<string, string[][]> = {
  deal_accounts: [["deal_id", "platform", "handle"]],
  posts: [["url"]],
  post_view_snapshots: [["post_id", "captured_day"]],
};
const FOREIGN: Record<string, Record<string, string>> = {
  deal_accounts: { deal_id: "deals" },
  posts: { deal_id: "deals" },
  post_view_snapshots: { post_id: "posts" },
};
const EMBED: Record<string, Record<string, { table: string; local: string; foreign: string; many: boolean }>> = {
  posts: { deals: { table: "deals", local: "deal_id", foreign: "id", many: false } },
  deals: { deal_accounts: { table: "deal_accounts", local: "id", foreign: "deal_id", many: true } },
};
const DEFAULTS: Record<string, Row> = {
  deals: { status: "active", end_date: null, daily_target_posts: 1, view_freeze_days: null },
  posts: { account_id: null, title: null, video_group_id: null, video_group_manual: false, exclude_from_pay: false, manual_override_cents: null, source: "hydra" },
  post_view_snapshots: { likes: null, comments: null, held: false, source: "hydra" },
};

export interface MemoryKey {
  id: string;
  key_hash: string;
  scope: string;
  revoked_at: string | null;
  rate_limit_per_minute: number;
  window: string | null;
  count: number;
  last_used_at: string | null;
}

const err = (code: string, message: string): Result => ({ data: null, error: { code, message } });

/** Split "a, b, c(d, e)" at top-level commas. */
function splitColumns(columns: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of columns) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function memoryDb(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = { deals: [], deal_accounts: [], posts: [], post_view_snapshots: [], settings: [{ time_zone: "UTC" }] };
  for (const [t, rows] of Object.entries(seed)) tables[t] = (rows ?? []).map((r) => ({ ...r }));
  const keys: MemoryKey[] = [];
  const touched = new Set<string>();

  const project = (table: string, row: Row, columns: string): Row => {
    const out: Row = {};
    for (const col of splitColumns(columns)) {
      const embed = col.match(/^(\w+)\((.*)\)$/);
      if (col === "*") Object.assign(out, row);
      else if (embed) {
        const rel = EMBED[table]?.[embed[1]];
        if (!rel) throw new Error(`memoryDb: no embed ${table}.${embed[1]}`);
        touched.add(rel.table);
        const related = tables[rel.table].filter((r) => r[rel.foreign] === row[rel.local]).map((r) => project(rel.table, r, embed[2]));
        out[embed[1]] = rel.many ? related : (related[0] ?? null);
      } else out[col] = row[col] ?? null;
    }
    return out;
  };

  const violates = (table: string, row: Row, self?: Row): Result | null => {
    for (const [col, parent] of Object.entries(FOREIGN[table] ?? {})) {
      if (row[col] != null && !tables[parent].some((p) => p.id === row[col])) return err("23503", `${table}.${col} has no ${parent} row`);
    }
    for (const cols of UNIQUE[table] ?? []) {
      if (tables[table].some((r) => r !== self && cols.every((c) => r[c] === row[c]))) return err("23505", `duplicate ${table} (${cols})`);
    }
    // 0010's posts_guard_exclude: the service role (no owner session) never sets exclude.
    if (table === "posts" && row.exclude_from_pay !== (self?.exclude_from_pay ?? false)) {
      return err("42501", "only the owner can exclude a video from pay");
    }
    return null;
  };

  function query(table: string | null, run?: () => Row[]) {
    let action: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let columns: string | null = table ? "*" : null;
    let returning = false;
    let values: Row[] = [];
    let patch: Row = {};
    let onConflict: string[] = [];
    let mode: "many" | "single" | "maybe" = "many";
    let limitN = Infinity;
    let offset = 0;
    let orderBy: { col: string; asc: boolean } | null = null;
    const filters: ((r: Row) => boolean)[] = [];

    const exec = (): Result => {
      let rows: Row[];
      if (run) rows = run();
      else {
        const t = table!;
        const store = tables[t];
        const now = new Date().toISOString();
        const fresh = (v: Row): Row => ({ id: randomUUID(), created_at: now, updated_at: now, ...DEFAULTS[t], ...v });
        if (action === "select") rows = store.filter((r) => filters.every((f) => f(r)));
        else if (action === "insert" || action === "upsert") {
          rows = [];
          for (const v of values) {
            const existing = action === "upsert" ? store.find((r) => onConflict.every((c) => r[c] === v[c])) : undefined;
            const next = existing ? { ...existing, ...v, updated_at: now } : fresh(v);
            const bad = violates(t, next, existing);
            if (bad) return bad;
            if (existing) Object.assign(existing, next);
            else store.push(next);
            rows.push(existing ?? next);
          }
        } else if (action === "update") {
          rows = store.filter((r) => filters.every((f) => f(r)));
          for (const r of rows) {
            const next = { ...r, ...patch, updated_at: now };
            const bad = violates(t, next, r);
            if (bad) return bad;
            Object.assign(r, next);
          }
        } else {
          rows = store.filter((r) => filters.every((f) => f(r)));
          tables[t] = store.filter((r) => !rows.includes(r));
        }
        if (action !== "select" && !returning) return { data: null, error: null };
      }
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      }
      rows = rows.slice(offset, offset + limitN);
      const data = columns && table ? rows.map((r) => project(table, r, columns!)) : rows;
      if (mode === "many") return { data, error: null };
      if (data.length > 1 || (mode === "single" && data.length === 0)) return err("PGRST116", `${data.length} rows`);
      return { data: data[0] ?? null, error: null };
    };

    const builder = {
      select(cols = "*") {
        columns = cols;
        returning = true;
        return builder;
      },
      insert(v: Row | Row[]) {
        action = "insert";
        values = Array.isArray(v) ? v : [v];
        return builder;
      },
      upsert(v: Row | Row[], opts?: { onConflict?: string }) {
        action = "upsert";
        values = Array.isArray(v) ? v : [v];
        onConflict = (opts?.onConflict ?? "id").split(",").map((c) => c.trim());
        return builder;
      },
      update(v: Row) {
        action = "update";
        patch = v;
        return builder;
      },
      delete() {
        action = "delete";
        return builder;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] === v);
        return builder;
      },
      is(col: string, v: unknown) {
        filters.push((r) => (r[col] ?? null) === v);
        return builder;
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[col]));
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderBy = { col, asc: opts?.ascending ?? true };
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      range(from: number, to: number) {
        offset = from;
        limitN = to - from + 1;
        return builder;
      },
      single() {
        mode = "single";
        return builder;
      },
      maybeSingle() {
        mode = "maybe";
        return builder;
      },
      then(resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve().then(exec).then(resolve, reject);
      },
    };
    return builder;
  }

  const dayOf = (iso: string) => iso.slice(0, 10); // the tests run in UTC
  const freezeEnd = (post: Row) => {
    const deal = tables.deals.find((d) => d.id === post.deal_id);
    return new Date(post.posted_at as string).getTime() + 24 * 3600_000 * ((deal?.view_freeze_days as number | null) ?? 14);
  };

  const RPC: Record<string, (args: Record<string, unknown>) => Row[]> = {
    api_key_authenticate({ p_key_hash, p_scope }) {
      const k = keys.find((x) => x.key_hash === p_key_hash);
      if (!k) return [{ key_id: null, status: "invalid", retry_after_seconds: null }];
      if (k.revoked_at) return [{ key_id: k.id, status: "revoked", retry_after_seconds: null }];
      if (k.scope !== p_scope) return [{ key_id: k.id, status: "forbidden", retry_after_seconds: null }];
      const win = new Date().toISOString().slice(0, 16);
      k.count = k.window === win ? k.count + 1 : 1;
      k.window = win;
      if (k.count > k.rate_limit_per_minute) return [{ key_id: k.id, status: "rate_limited", retry_after_seconds: 42 }];
      k.last_used_at = new Date().toISOString();
      return [{ key_id: k.id, status: "ok", retry_after_seconds: null }];
    },
    ugc_last_trusted_views({ p_post_ids, p_at }) {
      return (p_post_ids as string[]).flatMap((id) => {
        const last = tables.post_view_snapshots
          .filter((s) => s.post_id === id && !s.held && (s.captured_at as string) <= (p_at as string))
          .sort((a, b) => ((a.captured_at as string) < (b.captured_at as string) ? 1 : -1))[0];
        return last ? [{ post_id: id, views: last.views }] : [];
      });
    },
    ugc_posts_needing_views({ p_now }) {
      const now = new Date(p_now as string);
      return tables.posts
        .filter((p) => !p.exclude_from_pay && new Date(p.posted_at as string) <= now && now.getTime() <= freezeEnd(p))
        .filter((p) => !tables.post_view_snapshots.some((s) => s.post_id === p.id && s.captured_day === dayOf(now.toISOString())))
        .map((p) => {
          const latest = tables.post_view_snapshots
            .filter((s) => s.post_id === p.id)
            .sort((a, b) => ((a.captured_at as string) < (b.captured_at as string) ? 1 : -1))[0];
          const account = tables.deal_accounts.find((a) => a.id === p.account_id);
          return {
            post_id: p.id,
            deal_id: p.deal_id,
            url: p.url,
            platform: p.platform,
            account_handle: account?.handle ?? null,
            posted_at: p.posted_at,
            freeze_ends_at: new Date(freezeEnd(p)).toISOString(),
            last_views: latest ? String(latest.views) : null, // bigint arrives as a string
            last_captured_at: latest?.captured_at ?? null,
          };
        });
    },
    ugc_missed_view_days: () => missedDays,
  };
  let missedDays: Row[] = [];

  const client = {
    from(table: string) {
      if (!(table in tables)) throw new Error(`memoryDb: unknown table ${table}`);
      touched.add(table);
      return query(table);
    },
    rpc(name: string, args: Record<string, unknown> = {}) {
      const fn = RPC[name];
      if (!fn) throw new Error(`memoryDb: unknown rpc ${name}`);
      touched.add(`rpc:${name}`);
      return query(null, () => fn(args));
    },
  };

  return {
    db: client as unknown as SupabaseClient,
    tables,
    keys,
    touched,
    setMissedDays(rows: Row[]) {
      missedDays = rows;
    },
  };
}
