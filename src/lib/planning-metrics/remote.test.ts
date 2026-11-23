import { describe, expect, it } from "vitest";

import type { MetricContext } from "@/lib/planning/metrics";

import { createRemoteRegistry, metricCacheKey, type MetricRequest } from "./remote";

const ctx: MetricContext = {
  goalId: "g",
  window: { from: "2026-11-01", to: "2026-12-31" },
  today: "2026-11-21",
  timeZone: "America/Toronto",
  tasks: [],
  statuses: [],
};

describe("remote registry", () => {
  it("asks the server once for the same reading, then again after the cache runs out", async () => {
    let calls = 0;
    let now = 0;
    const registry = createRemoteRegistry(async () => ++calls, {}, { ttlMs: 1000, clock: () => now });
    const [a, b] = await Promise.all([registry.resolve("net_worth", null, ctx), registry.resolve("net_worth", null, ctx)]);
    expect(a).toEqual({ value: 1, stub: false });
    expect(b.value).toBe(1);
    expect(calls).toBe(1);
    now = 999;
    expect((await registry.resolve("net_worth", null, ctx)).value).toBe(1);
    now = 1001;
    expect((await registry.resolve("net_worth", null, ctx)).value).toBe(2);
  });

  it("a different category is a different reading", async () => {
    const seen: (string | null)[] = [];
    const registry = createRemoteRegistry(async (r) => (seen.push(r.param), 1));
    await registry.resolve("category_spend", "Food", ctx);
    await registry.resolve("category_spend", "Rent", ctx);
    expect(seen).toEqual(["Food", "Rent"]);
  });

  it("uses the seed without asking", async () => {
    const request: MetricRequest = { key: "streak", param: null, window: ctx.window, today: ctx.today, timeZone: ctx.timeZone };
    const registry = createRemoteRegistry(
      async () => {
        throw new Error("should not be asked");
      },
      { [metricCacheKey(request)]: 9 },
    );
    expect((await registry.resolve("streak", null, ctx)).value).toBe(9);
  });

  it("a failed reading is null and is asked again next time", async () => {
    let calls = 0;
    const registry = createRemoteRegistry(async () => {
      calls += 1;
      if (calls === 1) throw new Error("down");
      return 5;
    });
    expect((await registry.resolve("total_views", null, ctx)).value).toBeNull();
    expect((await registry.resolve("total_views", null, ctx)).value).toBe(5);
  });

  it("task progress stays local", async () => {
    const registry = createRemoteRegistry(async () => {
      throw new Error("never");
    });
    expect((await registry.resolve("task_progress", null, ctx)).value).toBeNull();
  });
});
