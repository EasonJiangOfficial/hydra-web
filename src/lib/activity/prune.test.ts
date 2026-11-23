// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pruneActivity } from "./prune";

type File = { bucket: string; path: string };

function fake(trash: File[], pruned: File[] = trash, failBucket?: string) {
  const removed: [string, string[]][] = [];
  const rpc = vi.fn(async (name: string) => ({ data: name === "activity_trash" ? trash : pruned, error: null }));
  const admin = {
    rpc,
    storage: {
      from: (b: string) => ({
        remove: async (paths: string[]) => (removed.push([b, paths]), { error: b === failBucket ? { message: "nope" } : null }),
      }),
    },
  } as unknown as SupabaseClient;
  return { admin, rpc, removed };
}

describe("pruneActivity", () => {
  it("removes the trash files the database names first, per bucket, then prunes past 30 days", async () => {
    const { admin, rpc, removed } = fake([
      { bucket: "tax-docs", path: "trash/a/ugc/2026/w9.pdf" },
      { bucket: "deal-logos", path: "trash/b/deals/d1/a.png" },
      { bucket: "tax-docs", path: "trash/c/ugc/2026/1099.pdf" },
    ]);
    expect(await pruneActivity(admin)).toEqual({ files: 3, failed: 0, pruned: true });
    expect(rpc.mock.calls).toEqual([
      ["activity_trash", { p_days: 30 }],
      ["prune_activity", { p_days: 30 }],
    ]);
    expect(removed).toEqual([
      ["tax-docs", ["trash/a/ugc/2026/w9.pdf", "trash/c/ugc/2026/1099.pdf"]],
      ["deal-logos", ["trash/b/deals/d1/a.png"]],
    ]);
  });

  it("keeps the rows when a file fails to go, so the next run tries again (SEC-2)", async () => {
    const { admin, rpc } = fake([{ bucket: "tax-docs", path: "trash/a/x.pdf" }], [], "tax-docs");
    expect(await pruneActivity(admin)).toEqual({ files: 0, failed: 1, pruned: false });
    expect(rpc).not.toHaveBeenCalledWith("prune_activity", expect.anything());
  });

  it("removes the files of rows that aged between the two calls; throws on a database error", async () => {
    const a = { bucket: "tax-docs", path: "trash/a/x.pdf" };
    const b = { bucket: "deal-logos", path: "trash/b/y.png" };
    const { admin, removed } = fake([a], [a, b]);
    expect(await pruneActivity(admin)).toEqual({ files: 2, failed: 0, pruned: true });
    expect(removed).toEqual([
      ["tax-docs", ["trash/a/x.pdf"]],
      ["deal-logos", ["trash/b/y.png"]],
    ]);
    const broken = { rpc: async () => ({ data: null, error: { message: "boom" } }) } as unknown as SupabaseClient;
    await expect(pruneActivity(broken)).rejects.toThrow("prune activity: boom");
  });
});
