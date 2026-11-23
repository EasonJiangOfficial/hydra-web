/**
 * The UGC write paths against a scripted fake client: what each write sends,
 * and which guard stops it. No database; the fake records every query.
 */
import { describe, it, expect } from "vitest";

import {
  addPost,
  archivePatch,
  confirmPayoutMatch,
  createDeal,
  decidePayoutRule,
  rejectPayoutMatch,
  removePayoutRule,
  undoRejectPayoutMatch,
  restorePatch,
  editPost,
  endDeal,
  pauseDeal,
  resumeDeal,
  setViews,
  updateDeal,
  type Db,
} from "@/lib/ugc/writes";
import { DEAL_DEFAULTS, dealInputToRow, type DealDbRow } from "@/lib/ugc/schemas";

// ─── Fake client ─────────────────────────────────────────────────────────────

type Call = {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete" | "rpc";
  payload?: unknown;
  opts?: unknown;
  filters: [string, ...unknown[]][];
};
type Reply = { data?: unknown; error?: { code?: string; message: string; details?: string } | null };

function makeDb(handler: (c: Call) => Reply | undefined) {
  const calls: Call[] = [];
  const builder = (table: string, op: Call["op"], payload?: unknown, opts?: unknown) => {
    const call: Call = { table, op, payload, opts, filters: [] };
    const b: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
              calls.push(call);
              const r = handler(call) ?? {};
              return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(res, rej);
            };
          }
          return (...args: unknown[]) => {
            call.filters.push([prop, ...args]);
            return b;
          };
        },
      },
    );
    return b;
  };
  const from = (t: string) => ({
    select: (cols?: string) => builder(t, "select", cols),
    insert: (p: unknown) => builder(t, "insert", p),
    update: (p: unknown) => builder(t, "update", p),
    upsert: (p: unknown, o?: unknown) => builder(t, "upsert", p, o),
    delete: () => builder(t, "delete"),
  });
  const rpc = (name: string, args: unknown) => builder(`rpc:${name}`, "rpc", args);
  return { db: { from, rpc } as unknown as Db, calls };
}

const has = (c: Call, method: string, ...args: unknown[]) =>
  c.filters.some((f) => f[0] === method && args.every((a, i) => f[i + 1] === a));
const writes = (calls: Call[], table: string, op: Call["op"]) => calls.filter((c) => c.table === table && c.op === op);

const DEAL_ID = "3f0c6a52-7d3e-4c1b-9a51-2b8f0e6d4c11";
const OTHER_DEAL = "9a1d3c52-7d3e-4c1b-9a51-2b8f0e6d4c22";
const POST_ID = "5b7e3c52-7d3e-4c1b-9a51-2b8f0e6d4c33";
const NOW = new Date("2026-11-21T12:00:00Z");

function dealRow(over: Partial<DealDbRow> = {}): DealDbRow {
  return {
    ...dealInputToRow({ ...DEAL_DEFAULTS, brandName: "Acme", startDate: "2026-11-01" }),
    id: DEAL_ID,
    entity_id: "e1",
    status: "active",
    source: "hydra",
    source_id: null,
    created_at: "2026-11-21T11:59:00.000000+00:00",
    updated_at: "2026-11-21T11:59:00.000001+00:00",
    ...over,
  } as DealDbRow;
}

// ─── createDeal ──────────────────────────────────────────────────────────────

const base = { brandName: "Acme", startDate: "2026-11-01", source: "hydra" as const, sourceId: null };

describe("createDeal", () => {
  it("merges DEAL_DEFAULTS under the sent fields; an explicit undefined never overrides a default", async () => {
    const { db, calls } = makeDb((c) => (c.op === "insert" ? { data: dealRow() } : undefined));
    const r = await createDeal(db, { ...base, dailyTargetPosts: undefined, cpmRate: 2.5 }, NOW);
    expect(r.ok).toBe(true);
    const sent = writes(calls, "deals", "insert")[0]!.payload as Record<string, unknown>;
    expect(sent).toMatchObject({
      brand_name: "Acme",
      start_date: "2026-11-01",
      daily_target_posts: DEAL_DEFAULTS.dailyTargetPosts,
      cpm_rate: 2.5,
      cpm_view_unit: DEAL_DEFAULTS.cpmViewUnit,
      source: "hydra",
      source_id: null,
    });
  });

  it("rejects a merged pay structure that is invalid, with no insert", async () => {
    const { db, calls } = makeDb(() => undefined);
    const r = await createDeal(db, { ...base, endDate: "2026-10-01" }, NOW);
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(calls).toHaveLength(0);
  });

  it("a retry with the same terms returns the deal already made and inserts nothing", async () => {
    const existing = dealRow();
    const { db, calls } = makeDb((c) => (c.op === "select" ? { data: [existing] } : undefined));
    const r = await createDeal(db, base, NOW);
    expect(r).toEqual({ ok: true, data: existing });
    expect(writes(calls, "deals", "insert")).toHaveLength(0);
    const q = calls[0]!;
    expect(has(q, "is", "source_id", null)).toBe(true);
    expect(has(q, "eq", "brand_name", "Acme")).toBe(true);
    expect(q.filters.some((f) => f[0] === "gte" && f[1] === "created_at")).toBe(true);
  });

  it("a retry that sends a fresh logo path is still the same deal", async () => {
    const existing = dealRow({ logo_path: "deals/aaaa/logo.png" });
    const { db, calls } = makeDb((c) => (c.op === "select" ? { data: [existing] } : undefined));
    const r = await createDeal(db, { ...base, logoPath: "deals/bbbb/logo.png" }, NOW);
    expect(r).toEqual({ ok: true, data: existing });
    expect(writes(calls, "deals", "insert")).toHaveLength(0);
  });

  it("the same brand and start date with different pay terms is a new deal", async () => {
    const other = dealRow({ cpm_rate: 9 as unknown as DealDbRow["cpm_rate"] });
    const created = dealRow({ id: OTHER_DEAL });
    let selects = 0;
    const { db, calls } = makeDb((c) => {
      if (c.op === "insert") return { data: created };
      if (c.op === "select") return { data: selects++ === 0 ? [other] : [other, created] };
    });
    const r = await createDeal(db, base, NOW);
    expect(r).toEqual({ ok: true, data: created });
    expect(writes(calls, "deals", "insert")).toHaveLength(1);
    expect(writes(calls, "deals", "delete")).toHaveLength(0);
  });

  it("a row stored with reordered jsonb keys and a string rate still counts as the same deal", async () => {
    const existing = dealRow({
      cpm_rate: "2.5" as unknown as DealDbRow["cpm_rate"],
      payout_rule: { maxCents: 9, minCents: 1 } as DealDbRow["payout_rule"],
    });
    const { db, calls } = makeDb((c) => (c.op === "select" ? { data: [existing] } : undefined));
    const r = await createDeal(db, { ...base, cpmRate: 2.5, payoutRule: { minCents: 1, maxCents: 9 } }, NOW);
    expect(r).toEqual({ ok: true, data: existing });
    expect(writes(calls, "deals", "insert")).toHaveLength(0);
  });

  it("a double click that races the check: the newer row removes itself and returns the older one", async () => {
    const older = dealRow({ id: OTHER_DEAL, created_at: "2026-11-21T11:59:59.000000+00:00" });
    const mine = dealRow({ id: DEAL_ID, created_at: "2026-11-21T11:59:59.500000+00:00" });
    let selects = 0;
    const { db, calls } = makeDb((c) => {
      if (c.op === "insert") return { data: mine };
      if (c.op === "select") return { data: selects++ === 0 ? [] : [older, mine] };
    });
    const r = await createDeal(db, base, NOW);
    expect(r).toEqual({ ok: true, data: older });
    const del = writes(calls, "deals", "delete");
    expect(del).toHaveLength(1);
    expect(has(del[0]!, "eq", "id", DEAL_ID)).toBe(true);
  });

  it("keeps its own row when it is the oldest", async () => {
    const mine = dealRow();
    let selects = 0;
    const { db, calls } = makeDb((c) => {
      if (c.op === "insert") return { data: mine };
      if (c.op === "select") return { data: selects++ === 0 ? [] : [mine] };
    });
    expect(await createDeal(db, base, NOW)).toEqual({ ok: true, data: mine });
    expect(writes(calls, "deals", "delete")).toHaveLength(0);
  });

  it("a source id makes a rerun idempotent: the existing deal comes back, any pay terms", async () => {
    const existing = dealRow({ source: "hydra", source_id: "c1" });
    const { db, calls } = makeDb((c) => (c.op === "select" ? { data: [existing] } : undefined));
    const r = await createDeal(db, { ...base, source: "hydra", sourceId: "c1", cpmRate: 7 }, NOW);
    expect(r).toEqual({ ok: true, data: existing });
    expect(has(calls[0]!, "eq", "source_id", "c1")).toBe(true);
    expect(writes(calls, "deals", "insert")).toHaveLength(0);
  });

  it("a source key collision on insert returns the winner", async () => {
    const winner = dealRow({ source: "hydra", source_id: "c1" });
    let selects = 0;
    const { db } = makeDb((c) => {
      if (c.op === "insert") return { error: { code: "23505", message: "dup" } };
      if (c.op === "select") return { data: selects++ === 0 ? [] : [winner] };
    });
    expect(await createDeal(db, { ...base, source: "hydra", sourceId: "c1" }, NOW)).toEqual({ ok: true, data: winner });
  });
});

// ─── updateDeal ──────────────────────────────────────────────────────────────

describe("updateDeal", () => {
  it("writes only the patched columns, at the version it read", async () => {
    const stored = dealRow();
    const { db, calls } = makeDb((c) => {
      if (c.op === "select") return { data: stored };
      if (c.op === "update") return { data: { ...stored, cpm_rate: 2 } };
    });
    const r = await updateDeal(db, { id: DEAL_ID, cpmRate: 2 });
    expect(r.ok).toBe(true);
    const up = writes(calls, "deals", "update")[0]!;
    expect(up.payload).toEqual({ cpm_rate: 2 });
    expect(has(up, "eq", "updated_at", stored.updated_at)).toBe(true);
    expect(has(up, "eq", "id", DEAL_ID)).toBe(true);
  });

  it("a concurrent write moves the version: it re-reads and never writes the stale end_date back", async () => {
    const first = dealRow();
    const second = dealRow({ status: "ended", end_date: "2026-11-20", updated_at: "2026-11-21T12:00:00.000000+00:00" });
    let reads = 0;
    const { db, calls } = makeDb((c) => {
      if (c.op === "select") return { data: reads++ === 0 ? first : second };
      if (c.op === "update") return has(c, "eq", "updated_at", second.updated_at) ? { data: { ...second, daily_target_posts: 3 } } : { data: null };
    });
    const r = await updateDeal(db, { id: DEAL_ID, dailyTargetPosts: 3 });
    expect(r.ok).toBe(true);
    const ups = writes(calls, "deals", "update");
    expect(ups).toHaveLength(2);
    for (const u of ups) expect(u.payload).toEqual({ daily_target_posts: 3 });
    expect(has(ups[1]!, "eq", "updated_at", second.updated_at)).toBe(true);
  });

  it("re-validates the merge against the fresh row: a new end date before the start fails", async () => {
    const { db, calls } = makeDb((c) => (c.op === "select" ? { data: dealRow() } : undefined));
    const r = await updateDeal(db, { id: DEAL_ID, endDate: "2026-10-01" });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(writes(calls, "deals", "update")).toHaveLength(0);
  });

  it("gives up with a conflict after three lost races", async () => {
    const { db, calls } = makeDb((c) => (c.op === "select" ? { data: dealRow() } : { data: null }));
    const r = await updateDeal(db, { id: DEAL_ID, cpmRate: 2 });
    expect(r).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(writes(calls, "deals", "update")).toHaveLength(3);
  });

  it("a patch that changes nothing writes nothing", async () => {
    const stored = dealRow({ cpm_rate: "2" as unknown as DealDbRow["cpm_rate"] });
    const { db, calls } = makeDb((c) => (c.op === "select" ? { data: stored } : undefined));
    const r = await updateDeal(db, { id: DEAL_ID, cpmRate: 2, brandName: "Acme" });
    expect(r).toEqual({ ok: true, data: stored });
    expect(writes(calls, "deals", "update")).toHaveLength(0);
  });

  it("not found", async () => {
    const { db } = makeDb(() => undefined);
    expect(await updateDeal(db, { id: DEAL_ID, cpmRate: 2 })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

// ─── pause / resume / end ────────────────────────────────────────────────────

describe("deal status guards", () => {
  it("pause only moves an active deal", async () => {
    const { db, calls } = makeDb((c) => (c.op === "update" ? { data: dealRow({ status: "paused" }) } : undefined));
    expect((await pauseDeal(db, DEAL_ID)).ok).toBe(true);
    const up = calls[0]!;
    expect(up.payload).toEqual({ status: "paused" });
    expect(up.filters).toContainEqual(["in", "status", ["active"]]);
  });

  it("an ended deal cannot be paused: rejected with its status", async () => {
    const { db } = makeDb((c) => (c.op === "select" ? { data: { status: "ended" } } : undefined));
    expect(await pauseDeal(db, DEAL_ID)).toEqual({
      ok: false,
      error: { code: "rejected", message: "The deal is ended" },
    });
  });

  it("resume only moves a paused deal", async () => {
    const { db, calls } = makeDb((c) =>
      c.op === "update" ? { data: dealRow() } : c.op === "select" ? { data: dealRow({ status: "paused" }) } : undefined,
    );
    expect((await resumeDeal(db, DEAL_ID)).ok).toBe(true);
    const up = writes(calls, "deals", "update")[0]!;
    expect(up.payload).toEqual({ status: "active" });
    expect(up.filters).toContainEqual(["in", "status", ["paused"]]);
  });

  it("an active deal cannot be resumed", async () => {
    const { db } = makeDb((c) => (c.op === "select" ? { data: { status: "active" } } : undefined));
    expect(await resumeDeal(db, DEAL_ID)).toMatchObject({ ok: false, error: { code: "rejected" } });
  });

  it("restore runs an archived deal again, and its archived days get a pause (no missed money)", async () => {
    const { db, calls } = makeDb((c) => {
      if (c.table === "settings") return { data: { time_zone: "UTC" } };
      if (c.op === "select") return { data: { status: "ended", start_date: "2026-10-01", end_date: "2026-10-31", paused_spans: [] } };
      if (c.op === "update") return { data: dealRow() };
    });
    expect((await resumeDeal(db, DEAL_ID, NOW)).ok).toBe(true);
    const ups = writes(calls, "deals", "update");
    expect(ups).toHaveLength(1);
    expect(ups[0]!.payload).toEqual({
      status: "active",
      end_date: null,
      paused_spans: [{ from: "2026-11-01", to: "2026-11-20" }],
    });
    expect(ups[0]!.filters).toContainEqual(["in", "status", ["ended"]]);
  });

  it("restore gives back a planned end date the archive kept", async () => {
    const { db, calls } = makeDb((c) => {
      if (c.table === "settings") return { data: { time_zone: "UTC" } };
      if (c.op === "select")
        return {
          data: { status: "ended", start_date: "2026-10-01", end_date: "2026-12-31", paused_spans: [{ from: "2026-11-11", to: "2026-12-31" }] },
        };
      if (c.op === "update") return { data: dealRow() };
    });
    await resumeDeal(db, DEAL_ID, NOW);
    expect(writes(calls, "deals", "update")[0]!.payload).toEqual({
      status: "active",
      end_date: "2026-12-31",
      paused_spans: [{ from: "2026-11-11", to: "2026-11-20" }],
    });
  });

  it("an unknown deal is not_found", async () => {
    const { db } = makeDb(() => undefined);
    expect(await pauseDeal(db, DEAL_ID)).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("end uses the given date", async () => {
    const { db, calls } = makeDb((c) => (c.op === "update" ? { data: dealRow({ status: "ended" }) } : undefined));
    await endDeal(db, { id: DEAL_ID, endDate: "2026-11-15" }, NOW);
    expect(calls[0]!.payload).toEqual({ status: "ended", end_date: "2026-11-15" });
    expect(calls[0]!.filters).toContainEqual(["in", "status", ["active", "paused", "ended"]]);
  });

  it("end without a date is today in the owner's zone", async () => {
    const { db, calls } = makeDb((c) => {
      if (c.table === "settings") return { data: { time_zone: "Pacific/Auckland" } };
      if (c.op === "select") return { data: dealRow({ end_date: null, paused_spans: [] }) };
      if (c.op === "update") return { data: dealRow({ status: "ended" }) };
    });
    await endDeal(db, { id: DEAL_ID }, new Date("2026-11-21T20:00:00Z")); // 09:00 on the 22nd in Auckland
    expect(writes(calls, "deals", "update")[0]!.payload).toEqual({ status: "ended", end_date: "2026-11-22", paused_spans: [] });
  });

  it("archive of a deal that starts next week keeps no end date (end_date >= start_date holds)", async () => {
    const { db, calls } = makeDb((c) => {
      if (c.table === "settings") return { data: { time_zone: "UTC" } };
      if (c.op === "select") return { data: dealRow({ start_date: "2026-11-28", end_date: null, paused_spans: [] }) };
      if (c.op === "update") return { data: dealRow({ status: "ended" }) };
    });
    await endDeal(db, { id: DEAL_ID }, NOW);
    expect(writes(calls, "deals", "update")[0]!.payload).toEqual({ status: "ended", end_date: null, paused_spans: [] });
  });
});

describe("archivePatch and restorePatch", () => {
  const T = "2026-11-21";
  const deal = (over: Partial<Parameters<typeof archivePatch>[0]> = {}) =>
    ({ status: "active", start_date: "2026-10-01", end_date: null, paused_spans: [], ...over }) as Parameters<typeof archivePatch>[0];

  it("archive never moves a past end date, never ends before the start, and keeps a planned end", () => {
    expect(archivePatch(deal(), T)).toEqual({ end_date: T, paused_spans: [] });
    expect(archivePatch(deal({ end_date: "2026-10-31" }), T)).toEqual({ end_date: "2026-10-31", paused_spans: [] });
    expect(archivePatch(deal({ start_date: "2026-11-28" }), T)).toEqual({ end_date: null, paused_spans: [] });
    expect(archivePatch(deal({ end_date: "2026-12-31" }), T)).toEqual({
      end_date: "2026-12-31",
      paused_spans: [{ from: "2026-11-22", to: "2026-12-31" }],
    });
    // A paused deal: its pause closes on yesterday, as the database trigger does.
    expect(archivePatch(deal({ status: "paused", paused_spans: [{ from: "2026-11-10", to: null }] }), T).paused_spans).toEqual([
      { from: "2026-11-10", to: "2026-11-20" },
    ]);
  });

  it("archive then restore: the plan comes back and no day in between has a target", () => {
    const planned = deal({ end_date: "2026-12-31" });
    const archived = { ...planned, status: "ended" as const, ...archivePatch(planned, T) };
    expect(restorePatch(archived, "2026-11-30")).toEqual({
      end_date: "2026-12-31",
      paused_spans: [{ from: "2026-11-22", to: "2026-11-29" }],
    });
    const open = deal();
    const shut = { ...open, status: "ended" as const, ...archivePatch(open, T) };
    expect(restorePatch(shut, T)).toEqual({ end_date: null, paused_spans: [] });
    expect(restorePatch(shut, "2026-11-25")).toEqual({ end_date: null, paused_spans: [{ from: "2026-11-22", to: "2026-11-24" }] });
    // Older pauses stay as they were.
    const withPause = { ...shut, paused_spans: [{ from: "2026-11-01", to: "2026-11-05" }] };
    expect(restorePatch(withPause, "2026-11-23").paused_spans).toEqual([
      { from: "2026-11-01", to: "2026-11-05" },
      { from: "2026-11-22", to: "2026-11-22" },
    ]);
  });
});

// ─── addPost / editPost ──────────────────────────────────────────────────────

const POST_URL = "https://tiktok.com/@me/video/1";
function postRow(over: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    deal_id: DEAL_ID,
    account_id: "acct-old",
    platform: "TIKTOK",
    url: POST_URL,
    title: "Old",
    posted_at: "2026-11-10T00:00:00Z",
    video_group_id: null,
    exclude_from_pay: false,
    manual_override_cents: null,
    source: "hydra",
    created_at: "x",
    updated_at: "x",
    ...over,
  };
}
const addInput = {
  dealId: DEAL_ID,
  url: POST_URL,
  platform: "TIKTOK" as const,
  postedAt: "2026-11-10T00:00:00Z",
  source: "hydra" as const,
};

describe("addPost", () => {
  it("a URL already on another deal is a conflict and nothing is written", async () => {
    const { db, calls } = makeDb((c) => (c.table === "posts" && c.op === "select" ? { data: postRow({ deal_id: OTHER_DEAL }) } : undefined));
    const r = await addPost(db, { ...addInput, account: "@Me" });
    expect(r).toEqual({ ok: false, error: { code: "conflict", message: "This URL is on another deal" } });
    expect(calls).toHaveLength(1);
  });

  it("a new URL is inserted with the deal's account, created on the way", async () => {
    const { db, calls } = makeDb((c) => {
      if (c.table === "deal_accounts") return { data: { id: "acct-1" } };
      if (c.table === "posts" && c.op === "insert") return { data: postRow({ account_id: "acct-1" }) };
    });
    const r = await addPost(db, { ...addInput, account: "@Me", title: "Hi" });
    expect(r).toMatchObject({ ok: true, data: { created: true } });
    expect(writes(calls, "deal_accounts", "upsert")[0]!.payload).toEqual({
      deal_id: DEAL_ID,
      platform: "TIKTOK",
      handle: "me",
    });
    expect(writes(calls, "posts", "insert")[0]!.payload).toMatchObject({
      deal_id: DEAL_ID,
      account_id: "acct-1",
      url: POST_URL,
      title: "Hi",
      source: "hydra",
    });
  });

  it("a retry returns the existing post and only fills account, group and title", async () => {
    const { db, calls } = makeDb((c) => {
      if (c.table === "posts" && c.op === "select") return { data: postRow() };
      if (c.table === "posts" && c.op === "update") return { data: postRow() };
    });
    const r = await addPost(db, { ...addInput, videoGroupId: "g1" });
    expect(r).toMatchObject({ ok: true, data: { created: false } });
    expect(writes(calls, "posts", "insert")).toHaveLength(0);
    const up = writes(calls, "posts", "update")[0]!;
    expect(up.payload).toEqual({ account_id: "acct-old", video_group_id: "g1", title: "Old" });
    expect(has(up, "eq", "id", POST_ID)).toBe(true);
  });
});

describe("editPost", () => {
  const withPost = (extra?: (c: Call) => Reply | undefined) =>
    makeDb((c) => {
      if (c.table === "posts" && c.op === "select") return { data: postRow() };
      if (c.table === "deal_accounts") return { data: { id: "acct-new" } };
      if (c.table === "posts" && c.op === "update") return { data: postRow() };
      return extra?.(c);
    });
  const patchOf = (calls: Call[]) => writes(calls, "posts", "update")[0]!.payload as Record<string, unknown>;

  it("not found", async () => {
    const { db } = makeDb(() => undefined);
    expect(await editPost(db, { id: POST_ID, title: "x" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("an edit that names no account leaves account_id alone", async () => {
    const { db, calls } = withPost();
    await editPost(db, { id: POST_ID, title: "New" });
    expect(patchOf(calls)).toEqual({ title: "New" });
  });

  it("account null clears it", async () => {
    const { db, calls } = withPost();
    await editPost(db, { id: POST_ID, account: null });
    expect(patchOf(calls)).toEqual({ account_id: null });
  });

  it("a handle is ensured on the post's deal and platform", async () => {
    const { db, calls } = withPost();
    await editPost(db, { id: POST_ID, account: "@New" });
    expect(writes(calls, "deal_accounts", "upsert")[0]!.payload).toEqual({ deal_id: DEAL_ID, platform: "TIKTOK", handle: "new" });
    expect(patchOf(calls)).toEqual({ account_id: "acct-new" });
  });

  it("moving to another deal drops the old deal's account", async () => {
    const { db, calls } = withPost();
    await editPost(db, { id: POST_ID, dealId: OTHER_DEAL });
    expect(patchOf(calls)).toEqual({ deal_id: OTHER_DEAL, account_id: null });
    expect(writes(calls, "deal_accounts", "upsert")).toHaveLength(0);
  });

  it("moving with a handle ensures the account on the NEW deal and the new platform", async () => {
    const { db, calls } = withPost();
    await editPost(db, { id: POST_ID, dealId: OTHER_DEAL, platform: "INSTAGRAM", account: "@New" });
    expect(writes(calls, "deal_accounts", "upsert")[0]!.payload).toEqual({
      deal_id: OTHER_DEAL,
      platform: "INSTAGRAM",
      handle: "new",
    });
    expect(patchOf(calls)).toMatchObject({ deal_id: OTHER_DEAL, platform: "INSTAGRAM", account_id: "acct-new" });
  });
});

// ─── setViews ────────────────────────────────────────────────────────────────

type Stored = { views: number; held: boolean; captured_at: string };
const CAPTURED = "2026-11-12T08:00:00Z";

/** A fake with one post, a prior-day trusted baseline, and the day's stored row (if any). */
function viewsDb(opts: { baseline?: number; today?: Stored; freezeDays?: number | null }) {
  return makeDb((c) => {
    if (c.table === "settings") return { data: { time_zone: "UTC" } };
    if (c.table === "posts") {
      return { data: [{ id: POST_ID, url: POST_URL, posted_at: "2026-11-10T00:00:00Z", deals: { view_freeze_days: opts.freezeDays ?? null } }] };
    }
    if (c.table === "rpc:ugc_last_trusted_views") {
      return { data: opts.baseline === undefined ? [] : [{ post_id: POST_ID, views: opts.baseline }] };
    }
    if (c.table === "post_view_snapshots" && c.op === "select") {
      return { data: opts.today ? [{ post_id: POST_ID, ...opts.today }] : [] };
    }
  });
}
const upserts = (calls: Call[]) => writes(calls, "post_view_snapshots", "upsert");
const rowsOf = (calls: Call[]) => upserts(calls).flatMap((u) => u.payload as Record<string, unknown>[]);
const item = (views: number) => ({ postId: POST_ID, views });
const send = (db: Db, views: number[], extra: { force?: boolean; capturedAt?: string } = {}) =>
  setViews(db, { capturedAt: extra.capturedAt ?? CAPTURED, force: extra.force ?? false, items: views.map(item) });

describe("setViews", () => {
  it("writes a first reading", async () => {
    const { db, calls } = viewsDb({});
    const r = await send(db, [1200]);
    expect(r).toMatchObject({ ok: true, data: { day: "2026-11-12", items: [{ status: "written" }] } });
    expect(rowsOf(calls)).toEqual([
      expect.objectContaining({ post_id: POST_ID, captured_day: "2026-11-12", views: 1200, held: false, source: "hydra" }),
    ]);
    expect(upserts(calls)[0]!.opts).toEqual({ onConflict: "post_id,captured_day" });
  });

  it("a late, lower reading cannot replace the day's later, higher trusted one", async () => {
    // day N-1 = 400 (what the SQL baseline sees at 08:00); day N 20:00 = 5000 is stored.
    const { db, calls } = viewsDb({ baseline: 400, today: { views: 5000, held: false, captured_at: "2026-11-12T20:00:00Z" } });
    const r = await send(db, [3000]);
    expect(r).toMatchObject({ ok: true, data: { items: [{ status: "rejected_lower", previous: 5000 }] } });
    expect(upserts(calls)).toHaveLength(0);
  });

  it("a late, higher reading is stored", async () => {
    const { db, calls } = viewsDb({ baseline: 400, today: { views: 5000, held: false, captured_at: "2026-11-12T20:00:00Z" } });
    const r = await send(db, [6000]);
    expect(r).toMatchObject({ ok: true, data: { items: [{ status: "written" }] } });
    expect(rowsOf(calls)[0]).toMatchObject({ views: 6000, held: false });
  });

  it("a lower reading is rejected against an earlier same-day reading", async () => {
    const { db, calls } = viewsDb({ baseline: 5000, today: { views: 5000, held: false, captured_at: "2026-11-12T01:00:00Z" } });
    expect(await send(db, [4999])).toMatchObject({ data: { items: [{ status: "rejected_lower", previous: 5000 }] } });
    expect(upserts(calls)).toHaveLength(0);
  });

  it("a held jump does not destroy the day's trusted reading", async () => {
    const { db, calls } = viewsDb({ baseline: 5000, today: { views: 5000, held: false, captured_at: "2026-11-12T01:00:00Z" } });
    const r = await send(db, [90000]);
    expect(r).toMatchObject({ ok: true, data: { items: [{ status: "held", previous: 5000, notStored: true }] } });
    expect(upserts(calls)).toHaveLength(0);
  });

  it("a held jump is stored, held, when the day has no trusted reading", async () => {
    const { db, calls } = viewsDb({ baseline: 5000 });
    const r = await send(db, [90000]);
    expect(r).toMatchObject({ data: { items: [{ status: "held", previous: 5000 }] } });
    expect(rowsOf(calls)[0]).toMatchObject({ views: 90000, held: true });
  });

  it("a forced reading replaces the day's trusted one (owner review)", async () => {
    const { db, calls } = viewsDb({ baseline: 5000, today: { views: 5000, held: false, captured_at: "2026-11-12T01:00:00Z" } });
    const r = await send(db, [90000], { force: true });
    expect(r).toMatchObject({ data: { items: [{ status: "written" }] } });
    expect(rowsOf(calls)[0]).toMatchObject({ views: 90000, held: false });
  });

  it("a trusted reading replaces a held one", async () => {
    const { db, calls } = viewsDb({ baseline: 5000, today: { views: 90000, held: true, captured_at: "2026-11-12T01:00:00Z" } });
    const r = await send(db, [5200]);
    expect(r).toMatchObject({ data: { items: [{ status: "written" }] } });
    expect(rowsOf(calls)[0]).toMatchObject({ views: 5200, held: false });
  });

  it("two readings for one post in one call: the lower second one is rejected, the higher row stays", async () => {
    const { db, calls } = viewsDb({});
    const r = await send(db, [5000, 4000]);
    expect(r).toMatchObject({ data: { items: [{ status: "written" }, { status: "rejected_lower", previous: 5000 }] } });
    expect(rowsOf(calls)).toHaveLength(1);
    expect(rowsOf(calls)[0]).toMatchObject({ views: 5000 });
  });

  it("a reading after the freeze window is rejected", async () => {
    const { db, calls } = viewsDb({ freezeDays: 1 });
    expect(await send(db, [10], { capturedAt: "2026-11-12T08:00:00Z" })).toMatchObject({
      data: { items: [{ status: "rejected_frozen" }] },
    });
    expect(upserts(calls)).toHaveLength(0);
  });

  it("an unknown post is not_found", async () => {
    const { db } = makeDb((c) => (c.table === "settings" ? { data: { time_zone: "UTC" } } : { data: [] }));
    const r = await setViews(db, { capturedAt: CAPTURED, force: false, items: [item(1)] });
    expect(r).toMatchObject({ ok: true, data: { items: [{ status: "not_found" }] } });
  });
});

describe("payout matching writes", () => {
  const TX = "7c2e3c52-7d3e-4c1b-9a51-2b8f0e6d4c44";

  it("confirm matches the deposit at its own amount and day (never a caller's numbers)", async () => {
    const { db, calls } = makeDb((c) => {
      if (c.table === "transactions") return { data: { id: TX, amount_cents: "120000", posted_on: "2026-11-02" } };
      if (c.table === "deal_payments") return { data: { id: "p", deal_id: DEAL_ID, transaction_id: TX, amount_cents: 120000, paid_on: "2026-11-02" } };
    });
    const r = await confirmPayoutMatch(db, { dealId: DEAL_ID, transactionId: TX });
    expect(r.ok).toBe(true);
    expect(writes(calls, "deal_payments", "insert")[0]!.payload).toEqual({
      deal_id: DEAL_ID,
      transaction_id: TX,
      amount_cents: 120000,
      paid_on: "2026-11-02",
    });
  });

  it("confirm refuses a missing deposit, a charge, and a deposit already matched", async () => {
    const gone = makeDb(() => ({ data: null }));
    expect(await confirmPayoutMatch(gone.db, { dealId: DEAL_ID, transactionId: TX })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(writes(gone.calls, "deal_payments", "insert")).toHaveLength(0);

    const charge = makeDb((c) => (c.table === "transactions" ? { data: { id: TX, amount_cents: -500, posted_on: "2026-11-02" } } : undefined));
    expect(await confirmPayoutMatch(charge.db, { dealId: DEAL_ID, transactionId: TX })).toMatchObject({ ok: false, error: { code: "rejected" } });
    expect(writes(charge.calls, "deal_payments", "insert")).toHaveLength(0);

    const taken = makeDb((c) =>
      c.table === "transactions"
        ? { data: { id: TX, amount_cents: 500, posted_on: "2026-11-02" } }
        : { error: { code: "23505", message: "duplicate" } },
    );
    expect(await confirmPayoutMatch(taken.db, { dealId: DEAL_ID, transactionId: TX })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("confirm refuses a hidden transaction (review 5)", async () => {
    const hidden = makeDb((c) => (c.table === "transactions" ? { data: { id: TX, amount_cents: 500, posted_on: "2026-11-02", hidden: true } } : undefined));
    expect(await confirmPayoutMatch(hidden.db, { dealId: DEAL_ID, transactionId: TX })).toMatchObject({ ok: false, error: { code: "rejected" } });
    expect(writes(hidden.calls, "deal_payments", "insert")).toHaveLength(0);
  });

  it("undo Not this deletes that one row; removing a rule deletes that deal's rule for that payer (review 3)", async () => {
    const a = makeDb(() => undefined);
    expect((await undoRejectPayoutMatch(a.db, { dealId: DEAL_ID, transactionId: TX })).ok).toBe(true);
    const [d] = writes(a.calls, "payout_match_rejections", "delete");
    expect(d!.filters).toEqual(expect.arrayContaining([["eq", "deal_id", DEAL_ID], ["eq", "transaction_id", TX]]));

    const b = makeDb(() => undefined);
    expect((await removePayoutRule(b.db, { dealId: DEAL_ID, payerKey: "paypal transfer" })).ok).toBe(true);
    const [r] = writes(b.calls, "payout_rules", "delete");
    expect(r!.filters).toEqual(expect.arrayContaining([["eq", "deal_id", DEAL_ID], ["eq", "payer_key", "paypal transfer"]]));
  });

  it("Not this upserts one row per deal and deposit", async () => {
    const { db, calls } = makeDb(() => undefined);
    expect((await rejectPayoutMatch(db, { dealId: DEAL_ID, transactionId: TX })).ok).toBe(true);
    const [w] = writes(calls, "payout_match_rejections", "upsert");
    expect(w!.payload).toEqual({ deal_id: DEAL_ID, transaction_id: TX });
    expect(w!.opts).toEqual({ onConflict: "deal_id,transaction_id", ignoreDuplicates: true });
  });

  it("a rule answer replaces the old one for that deal and payer", async () => {
    const { db, calls } = makeDb(() => ({ data: { id: "r", deal_id: DEAL_ID, payer_key: "paypal transfer", day_of_month: 1, day_window: 3, decision: "accepted" } }));
    const r = await decidePayoutRule(db, { dealId: DEAL_ID, payerKey: "paypal transfer", dayOfMonth: 1, decision: "accepted" });
    expect(r).toMatchObject({ ok: true, data: { decision: "accepted" } });
    const [w] = writes(calls, "payout_rules", "upsert");
    expect(w!.payload).toEqual({ deal_id: DEAL_ID, payer_key: "paypal transfer", day_of_month: 1, decision: "accepted" });
    expect(w!.opts).toEqual({ onConflict: "deal_id,payer_key" });
  });
});
