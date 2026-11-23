// @vitest-environment node
/**
 * Every delete server action returns the activityId its client wrote under (so the page can offer
 * Undo), and the file deletes go to the trash instead of being removed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type Call, type Reply } from "@/lib/planning/test-db";
import { tagClient } from "./request";

const ACT = "a1000000-0000-4000-8000-0000000000ee";
const ID = "c0000000-0000-4000-8000-000000000001";

const m = vi.hoisted(() => ({
  db: null as unknown,
  calls: [] as unknown[],
  storage: [] as [string, string, unknown[]][],
}));

const has = (c: Call, op: string) => c.ops.some(([n]) => n === op);
function reply(c: Call): Reply {
  if (c.rpc === "is_owner") return { data: true };
  if (c.rpc) return { data: null };
  if (c.table === "entities") return { data: [{ id: "ent" }] };
  if (c.table === "tax_documents" && !has(c, "delete")) return { data: [{ storage_path: "ugc/2026/w9.pdf" }] };
  if (c.table === "deals" && has(c, "delete")) return { data: { id: ID } };
  if (c.table === "deals" && c.ops.some(([n, a]) => n === "select" && a[0] === "logo_path")) return { data: { logo_path: "deals/d1/a.png" } };
  if (c.table === "deals" || c.table === "deal_templates") return { data: [] };
  if (c.table === "posts") return { data: { id: ID } };
  if (c.table === "rules" && has(c, "delete")) return { data: { id: ID } };
  if (c.table === "rules") return { data: [] };
  if (c.table === "categories") return { data: { id: ID, name: "Food" } };
  if (c.table === "deal_payments") return { data: { id: "p1", deal_id: "d1" } };
  if (c.table === "transactions" && has(c, "delete")) return { data: { id: ID } };
  if (c.table === "transactions") return { data: { source: "manual", transfer_pair_id: null, account_id: "a", posted_on: "2026-11-20", amount_cents: 5000, name: "Glow", note: null, entity_id: "e" } };
  return { data: null };
}

function freshDb() {
  const { db, calls } = fakeDb(reply);
  const bucket = (b: string) => ({
    move: async (...a: unknown[]) => (m.storage.push([b, "move", a]), { error: null }),
    remove: async (...a: unknown[]) => (m.storage.push([b, "remove", a]), { error: null }),
  });
  Object.assign(db, {
    storage: { from: bucket },
    auth: { getClaims: async () => ({ data: { claims: { sub: "11111111-1111-1111-1111-111111111111" } } }) },
  });
  m.calls = calls;
  return tagClient(db, ACT);
}

vi.mock("@/lib/supabase/server", () => ({ createServerClient: async () => (m.db = freshDb()) }));
vi.mock("@/lib/planning/server", () => ({ ownerCtx: async () => ({ db: (m.db = freshDb()), now: () => new Date(), timeZone: async () => "UTC" }) }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("@/lib/google/calendar", () => ({ pushToGoogle: vi.fn(), removeFromGoogle: vi.fn() }));

const ugc = await import("@/lib/ugc/actions");
const rules = await import("@/lib/rules/actions");
const bank = await import("@/lib/bank/actions");
const planning = await import("@/lib/planning/actions");
const taxes = await import("@/app/(app)/taxes/actions");

beforeEach(() => {
  m.storage = [];
});

describe("delete actions return activityId", () => {
  it.each([
    ["deleteDeal", () => ugc.deleteDeal({ id: ID })],
    ["deletePost", () => ugc.deletePost({ id: ID })],
    ["deleteRule", () => rules.deleteRule({ id: ID })],
    ["deleteCategory", () => rules.deleteCategory({ id: ID })],
    ["deleteManualTransaction", () => bank.deleteManualTransaction({ transactionId: ID })],
    ["deleteTask", () => planning.deleteTask(ID)],
    ["deleteGoal", () => planning.deleteGoal(ID)],
    ["removeGoalMetric", () => planning.removeGoalMetric(ID)],
    ["removeGoalLink", () => planning.removeGoalLink(ID)],
    ["deleteEvent", () => planning.deleteEvent(ID)],
    ["deleteStatus", () => planning.deleteStatus(ID, null)],
    ["deleteProperty", () => planning.deleteProperty(ID)],
    ["deleteOption", () => planning.deleteOption(ID)],
    ["removePayment", () => taxes.removePayment({ entity: "ugc", year: 2026, quarter: 1 })],
    ["removeDocument", () => taxes.removeDocument({ id: ID })],
  ] as const)("%s", async (_name, run) => {
    const r = await run();
    expect(r).toMatchObject({ ok: true, activityId: ACT });
  });

  it("a failed delete carries no activityId", async () => {
    const r = await planning.deleteTask("not-a-uuid");
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("activityId");
  });
});

describe("files go to the trash of the delete's activity", () => {
  it("a tax document's file moves to trash/<activity>/<path>", async () => {
    await taxes.removeDocument({ id: ID });
    expect(m.storage).toEqual([["tax-docs", "move", ["ugc/2026/w9.pdf", `trash/${ACT}/ugc/2026/w9.pdf`]]]);
  });

  it("a deleted deal's own logo moves to the trash", async () => {
    await ugc.deleteDeal({ id: ID });
    expect(m.storage).toEqual([["deal-logos", "move", ["deals/d1/a.png", `trash/${ACT}/deals/d1/a.png`]]]);
  });
});

describe("deleteManualTransaction", () => {
  it("deletes on the owner's client with the manual and unpaired filters, and names the deal payment", async () => {
    const r = await bank.deleteManualTransaction({ transactionId: ID });
    expect(r).toMatchObject({ ok: true, activityId: ACT, data: { transactionId: ID, dealPayment: { id: "p1", dealId: "d1" } } });
    const del = (m.calls as Call[]).find((c) => c.table === "transactions" && has(c, "delete"))!;
    expect(del.ops).toEqual(
      expect.arrayContaining([
        ["eq", ["id", ID]],
        ["eq", ["source", "manual"]],
        ["is", ["transfer_pair_id", null]],
      ]),
    );
  });
});
