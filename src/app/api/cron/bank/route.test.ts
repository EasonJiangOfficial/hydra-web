// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  runSync: vi.fn(),
  processIngested: vi.fn(),
  detectAndSaveRecurring: vi.fn(),
  pruneActivity: vi.fn(),
  items: [] as { id: string }[],
}));
vi.mock("@/lib/activity/prune", () => ({ pruneActivity: m.pruneActivity }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/bank/server", () => ({ runSync: m.runSync, ownerTimeZone: async () => "America/Los_Angeles" }));
vi.mock("@/lib/bank/cron", async (load) => ({ ...(await load<typeof import("@/lib/bank/cron")>()), listSweepItems: async () => m.items }));
vi.mock("@/lib/rules/engine", () => ({ processIngested: m.processIngested, detectAndSaveRecurring: m.detectAndSaveRecurring }));

const { GET } = await import("./route");
const get = (auth?: string) => new Request("https://hydra.example/api/cron/bank", { headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", "");
  m.items = [{ id: "i1" }];
  m.runSync.mockResolvedValue({ status: "synced", pages: 1, added: 2, modified: 0, removed: 0 });
  m.processIngested.mockResolvedValue({ checked: 2, changed: 1, paired: 1 });
  m.detectAndSaveRecurring.mockResolvedValue({ found: 1, saved: 1 });
  m.pruneActivity.mockResolvedValue({ files: 2, failed: 0 });
});

describe("GET /api/cron/bank", () => {
  it("is closed without CRON_SECRET (503) and refuses a missing or wrong bearer (401)", async () => {
    expect((await GET(get("Bearer x"))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await GET(get())).status).toBe(401);
    expect((await GET(get("Bearer nope"))).status).toBe(401);
    expect((await GET(get("Bearer s3cret2"))).status).toBe(401);
    expect(m.runSync).not.toHaveBeenCalled();
    expect(m.pruneActivity).not.toHaveBeenCalled();
  });

  it("syncs each item, then runs rules, pairing and recurring detection for the owner's day", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await GET(get("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      items: [{ itemId: "i1", status: "synced" }],
      rules: { changed: 1, paired: 1 },
      recurring: { saved: 1 },
    });
    expect(m.runSync).toHaveBeenCalledWith("i1");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
    expect(m.detectAndSaveRecurring).toHaveBeenCalledWith({}, today);
  });

  it("runs the 30-day Activity prune first: a bank sweep that throws does not skip it (SEC-2)", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    m.processIngested.mockRejectedValueOnce(new Error("rules down"));
    await expect(GET(get("Bearer s3cret"))).rejects.toThrow("rules down");
    expect(m.pruneActivity).toHaveBeenCalledTimes(1);
    expect(m.pruneActivity.mock.invocationCallOrder[0]).toBeLessThan(m.processIngested.mock.invocationCallOrder[0]);
  });

  it("a failed prune does not fail the sweep", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(await (await GET(get("Bearer s3cret"))).json()).toMatchObject({ ok: true, activity: { files: 2, failed: 0 } });
    expect(m.pruneActivity).toHaveBeenCalledWith({});
    m.pruneActivity.mockRejectedValueOnce(new Error("prune activity: boom"));
    const res = await GET(get("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, items: [{ itemId: "i1" }], activity: { error: "prune_failed" } });
  });
});
