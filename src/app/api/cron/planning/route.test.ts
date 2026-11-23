// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  extendRepeatSeries: vi.fn(),
  pushToGoogle: vi.fn(),
  loadTimeZone: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/lib/planning/repeats", () => ({ extendRepeatSeries: mocks.extendRepeatSeries }));
vi.mock("@/lib/planning/repository", () => ({ loadTimeZone: mocks.loadTimeZone }));
vi.mock("@/lib/google/calendar", () => ({ pushToGoogle: mocks.pushToGoogle }));

const { GET } = await import("./route");

const get = (auth?: string) =>
  GET(new Request("https://hydra.example/api/cron/planning", { headers: auth ? { authorization: auth } : {} }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", "s3cret");
  mocks.loadTimeZone.mockResolvedValue("America/Toronto");
  mocks.extendRepeatSeries.mockResolvedValue({ series: 2, created: 2, ids: ["t1", "t2"], failed: [] });
  mocks.pushToGoogle.mockResolvedValue({ ok: true, data: "created" });
});

describe("GET /api/cron/planning", () => {
  it("fails closed with 503 when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await get("Bearer ");
    expect(res.status).toBe(503);
    expect(mocks.extendRepeatSeries).not.toHaveBeenCalled();
  });

  it("is 401 without the bearer or with a wrong one", async () => {
    expect((await get()).status).toBe(401);
    expect((await get("Bearer nope")).status).toBe(401);
    expect((await get("s3cret")).status).toBe(401);
    expect(mocks.extendRepeatSeries).not.toHaveBeenCalled();
  });

  it("extends every series in the owner's zone and pushes each new copy to Google", async () => {
    const res = await get("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, series: 2, created: 2, pushed: 2, failed: 0 });
    expect(mocks.extendRepeatSeries).toHaveBeenCalledWith({ admin: true }, expect.any(Date), "America/Toronto");
    expect(mocks.pushToGoogle.mock.calls).toEqual([
      ["task", "t1"],
      ["task", "t2"],
    ]);
  });

  it("pushes every copy made before a failed series, then answers 500 with the failure count", async () => {
    mocks.extendRepeatSeries.mockResolvedValue({ series: 3, created: 2, ids: ["t1", "t3"], failed: ["s2"] });
    const res = await get("Bearer s3cret");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, series: 3, created: 2, pushed: 2, failed: 1 });
    expect(mocks.pushToGoogle.mock.calls).toEqual([
      ["task", "t1"],
      ["task", "t3"],
    ]);
  });

  it("still answers 200 when Google is not connected; nothing new means no push", async () => {
    mocks.pushToGoogle.mockResolvedValue({ ok: true, data: "not_connected" });
    expect(await (await get("Bearer s3cret")).json()).toMatchObject({ created: 2, pushed: 0 });
    vi.clearAllMocks();
    mocks.extendRepeatSeries.mockResolvedValue({ series: 1, created: 0, ids: [], failed: [] });
    mocks.loadTimeZone.mockResolvedValue("America/Toronto");
    expect(await (await get("Bearer s3cret")).json()).toMatchObject({ created: 0, pushed: 0 });
    expect(mocks.pushToGoogle).not.toHaveBeenCalled();
  });
});
