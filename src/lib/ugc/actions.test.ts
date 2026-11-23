import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createDeal: vi.fn(), okWrite: async () => ({ ok: true, data: {} }) }));
// writes.ts imports "server-only", which vitest cannot resolve: stand in for it.
vi.mock("@/lib/ugc/writes", () => ({
  ok: (data: unknown) => ({ ok: true, data }),
  fail: (code: string, message: string) => ({ ok: false, error: { code, message } }),
  dbFail: (e: { message: string }) => ({ ok: false, error: { code: "db_error", message: e.message } }),
  zoneOf: async () => "UTC",
  createDeal: mocks.createDeal,
  removePayoutRule: mocks.okWrite,
}));
const createServerClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createServerClient: () => createServerClient() }));

import { tagClient } from "@/lib/activity/request";
import { createDealFromTemplate, removePayoutRule } from "@/lib/ugc/actions";

const ID = "11111111-1111-4111-8111-111111111111";

/** A client whose is_owner answers `owner` and whose template lookup finds nothing. */
function client(owner: boolean) {
  const chain: Record<string, unknown> = {};
  for (const op of ["select", "eq", "maybeSingle"]) chain[op] = () => chain;
  chain.then = (f: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(f);
  return { rpc: async () => ({ data: owner, error: null }), from: () => chain };
}

describe("createDealFromTemplate action", () => {
  beforeEach(() => createServerClient.mockReset());

  it("rejects bad input before touching the database", async () => {
    const r = await createDealFromTemplate({ templateId: "nope", startDate: "2026-11-01" });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("refuses anyone but the owner", async () => {
    createServerClient.mockResolvedValue(client(false));
    const r = await createDealFromTemplate({ templateId: ID, startDate: "2026-11-01" });
    expect(r).toMatchObject({ ok: false, error: { code: "not_owner" } });
  });

  it("answers not_found for an unknown template", async () => {
    createServerClient.mockResolvedValue(client(true));
    const r = await createDealFromTemplate({ templateId: ID, startDate: "2026-11-01" });
    expect(r).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("removing a payout rule returns an activityId for the shared Undo bar", () => {
  it("names the activity that undoes the delete", async () => {
    const ACT = "22222222-2222-4222-8222-222222222222";
    createServerClient.mockResolvedValue(tagClient(client(true), ACT));
    expect(await removePayoutRule({ dealId: ID, payerKey: "paypal transfer" })).toMatchObject({ ok: true, activityId: ACT });
  });
});
