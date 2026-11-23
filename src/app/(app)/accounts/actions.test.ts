// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), upsert: vi.fn(), balanceHistory: vi.fn() }));

vi.mock("@/lib/bank/server", () => ({
  NotOwnerError: class NotOwnerError extends Error {},
  requireOwner: mocks.requireOwner,
}));
vi.mock("@/lib/bank/queries", () => ({ balanceHistory: mocks.balanceHistory }));

const { setIdleLock, loadBalanceHistory } = await import("./actions");
const { NotOwnerError } = await import("@/lib/bank/server");

const ACCOUNT = "bbbbbbbb-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.requireOwner.mockResolvedValue({ userId: "user-1", db: { from: () => ({ upsert: mocks.upsert }) } });
});

describe("setIdleLock", () => {
  it.each([1, 15, 60])("saves %i minutes for the owner", async (minutes) => {
    expect(await setIdleLock({ minutes })).toEqual({ ok: true, data: { minutes } });
    expect(mocks.upsert).toHaveBeenCalledWith({ user_id: "user-1", idle_lock_minutes: minutes }, { onConflict: "user_id" });
  });

  it("null turns it off", async () => {
    expect(await setIdleLock({ minutes: null })).toEqual({ ok: true, data: { minutes: null } });
    expect(mocks.upsert).toHaveBeenCalledWith({ user_id: "user-1", idle_lock_minutes: null }, { onConflict: "user_id" });
  });

  it.each([0, 61, -1, 2.5, Number.NaN])("refuses %s before touching the database", async (minutes) => {
    const r = await setIdleLock({ minutes });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(mocks.requireOwner).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not the owner", async () => {
    mocks.requireOwner.mockRejectedValue(new NotOwnerError());
    expect(await setIdleLock({ minutes: 5 })).toMatchObject({ ok: false, error: { code: "not_owner" } });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("reports a database failure without its text", async () => {
    mocks.upsert.mockResolvedValue({ error: { message: "secret detail" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await setIdleLock({ minutes: 5 })).toEqual({ ok: false, error: { code: "internal", message: "Something went wrong" } });
  });
});

describe("loadBalanceHistory", () => {
  it("reads one account's history as the owner", async () => {
    mocks.balanceHistory.mockResolvedValue([{ as_of: "2026-11-21", current_cents: 5, available_cents: null, limit_cents: null }]);
    const r = await loadBalanceHistory({ accountId: ACCOUNT });
    expect(r).toMatchObject({ ok: true });
    expect(mocks.balanceHistory).toHaveBeenCalledWith(expect.anything(), { accountId: ACCOUNT });
  });

  it("refuses an id that is not a uuid", async () => {
    expect(await loadBalanceHistory({ accountId: "nope" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(mocks.balanceHistory).not.toHaveBeenCalled();
  });
});
