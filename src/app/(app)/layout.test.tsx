import type { ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const read = vi.hoisted(() => ({ result: { data: null as unknown, error: null as unknown }, throws: false }));
vi.mock("@/components/shell/app-shell", () => ({ AppShell: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/activity/undo-bar", () => ({ UndoHost: () => null }));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => {
    if (read.throws) throw new Error("no cookies");
    return { from: () => ({ select: () => ({ maybeSingle: async () => read.result }) }) };
  },
}));

const { default: AppLayout } = await import("./layout");
const minutes = () => (AppLayout({ children: null }) as ReactElement<{ minutes: Promise<unknown> }>).props.minutes;

beforeEach(() => {
  read.result = { data: null, error: null };
  read.throws = false;
});

it("reads the idle limit: minutes when set, null (off) only from a read that worked", async () => {
  read.result = { data: { idle_lock_minutes: 5 }, error: null };
  expect(await minutes()).toBe(5);
  read.result = { data: { idle_lock_minutes: null }, error: null };
  expect(await minutes()).toBeNull();
  read.result = { data: null, error: null };
  expect(await minutes()).toBeNull();
});

it("a failed settings read is 'unknown', never off", async () => {
  read.result = { data: null, error: { message: "permission denied" } };
  expect(await minutes()).toBe("unknown");
  read.throws = true;
  expect(await minutes()).toBe("unknown");
});
