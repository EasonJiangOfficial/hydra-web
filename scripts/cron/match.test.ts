// @vitest-environment node
import { describe, expect, it } from "vitest";
import crons from "../../vercel.json";
import { dueJobs } from "./match.mjs";
import { formatTick, tick } from "./run.mjs";

describe("cron schedules", () => {
  it("fires the five vercel.json routes at the right UTC minute", () => {
    expect(crons.crons).toHaveLength(5);
    const paths = (iso: string) => dueJobs(crons.crons, new Date(iso)).map((job: { path: string }) => job.path);
    expect(paths("2026-11-23T15:07:00Z")).toEqual(["/api/cron/agent"]);
    expect(paths("2026-11-23T09:15:00Z")).toEqual(["/api/cron/agent", "/api/cron/planning"]);
    expect(paths("2026-11-23T09:30:00Z")).toContain("/api/google/cron");
    expect(paths("2026-11-23T09:45:00Z")).toContain("/api/instagram/cron");
    expect(paths("2026-11-23T10:00:00Z")).toEqual(["/api/cron/agent", "/api/cron/bank"]);
  });

  it("sends the bearer token and does not put it in the log line", async () => {
    const secret = "cron-secret-value-not-for-logs";
    const seen: { url: string; authorization: string }[] = [];
    const fired = await tick([{ path: "/api/cron/agent", schedule: "* * * * *" }], new Date("2026-11-23T15:07:30Z"), {
      origin: "http://app:3000",
      secret,
      fetchFn: async (url: string, init: { headers: { authorization: string } }) => {
        seen.push({ url, authorization: init.headers.authorization });
        return { status: 200 };
      },
    });
    expect(seen).toEqual([{ url: "http://app:3000/api/cron/agent", authorization: `Bearer ${secret}` }]);
    expect(formatTick(fired)).toBe("/api/cron/agent 200");
    expect(formatTick(fired)).not.toContain(secret);
  });
});
