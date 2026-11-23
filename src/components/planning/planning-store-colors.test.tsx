import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The undo bar's server action reaches server-only code; a client render never calls it here.
vi.mock("@/lib/activity/actions", () => ({ undoActivity: vi.fn() }));

import { fixtureSnapshot } from "@/lib/planning/fixtures";
import { createMemoryActions } from "@/lib/planning/memory-actions";
import type { PlanningResult } from "@/lib/planning/types";

import { PlanningProvider, usePlanning, type PlanningStore } from "./planning-store";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/planning",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const refused = { ok: false, error: { code: "unknown", message: "Refused" } } as unknown as PlanningResult<never>;

describe("label color rollback", () => {
  it("an older refused pick does not undo a newer color that saved", async () => {
    const snap = fixtureSnapshot(new Date("2026-11-21T15:00:00Z"));
    const status = snap.statuses[0];
    const option = snap.properties.flatMap((p) => p.options.map((o) => ({ p, o })))[0];
    const memory = createMemoryActions(snap);
    const pending: ReturnType<typeof deferred<PlanningResult<unknown>>>[] = [];
    const hold = () => {
      const d = deferred<PlanningResult<unknown>>();
      pending.push(d);
      return d.promise as never;
    };
    const actions = { ...memory.actions, updateStatus: vi.fn(hold), updateOption: vi.fn(hold) };
    let store!: PlanningStore;
    const Probe = () => {
      store = usePlanning();
      return null;
    };
    render(
      <PlanningProvider initial={snap} actions={actions} now="2026-11-21T15:00:00Z">
        <Probe />
      </PlanningProvider>,
    );

    let first!: Promise<boolean>, second!: Promise<boolean>;
    act(() => {
      first = store.setStatusColor(status.id, "#4b8a8c");
      second = store.setStatusColor(status.id, "#4f7cb8");
    });
    await act(async () => {
      pending[1].resolve({ ok: true, value: { ...status, color: "#4f7cb8" } });
      await second;
      pending[0].resolve(refused);
      await first;
    });
    expect(store.snapshot.statuses.find((s) => s.id === status.id)?.color).toBe("#4f7cb8");

    let third!: Promise<boolean>, fourth!: Promise<boolean>;
    act(() => {
      third = store.setOptionColor(option.p.id, option.o.id, "#4b8a8c");
      fourth = store.setOptionColor(option.p.id, option.o.id, "#4f7cb8");
    });
    await act(async () => {
      pending[3].resolve({ ok: true, value: { ...option.o, color: "#4f7cb8" } });
      await fourth;
      pending[2].resolve(refused);
      await third;
    });
    const after = store.snapshot.properties.find((p) => p.id === option.p.id)?.options.find((o) => o.id === option.o.id);
    expect(after?.color).toBe("#4f7cb8");
  });

  it("the latest refused pick still rolls back to the color before it", async () => {
    const snap = fixtureSnapshot(new Date("2026-11-21T15:00:00Z"));
    const status = snap.statuses[0];
    const memory = createMemoryActions(snap);
    const actions = { ...memory.actions, updateStatus: vi.fn(async () => refused as never) };
    let store!: PlanningStore;
    const Probe = () => {
      store = usePlanning();
      return null;
    };
    render(
      <PlanningProvider initial={snap} actions={actions} now="2026-11-21T15:00:00Z">
        <Probe />
      </PlanningProvider>,
    );
    await act(async () => {
      await store.setStatusColor(status.id, "#4b8a8c");
    });
    expect(store.snapshot.statuses.find((s) => s.id === status.id)?.color).toBe(status.color);
  });

  it("a category color shows at once, clears with None, and rolls back when refused", async () => {
    const snap = { ...fixtureSnapshot(new Date("2026-11-21T15:00:00Z")), categoryColors: { Taxes: "#c29a2e" } };
    const memory = createMemoryActions(snap);
    let refuse = false;
    const actions = {
      ...memory.actions,
      setCategoryColor: vi.fn((c: string, color: string | null) => (refuse ? Promise.resolve(refused as never) : memory.actions.setCategoryColor(c, color))),
    };
    let store!: PlanningStore;
    const Probe = () => {
      store = usePlanning();
      return null;
    };
    render(
      <PlanningProvider initial={snap} actions={actions} now="2026-11-21T15:00:00Z">
        <Probe />
      </PlanningProvider>,
    );
    await act(async () => {
      expect(await store.setCategoryColor("UGC", "#4f7cb8")).toBe(true);
    });
    expect(store.snapshot.categoryColors).toEqual({ Taxes: "#c29a2e", UGC: "#4f7cb8" });
    await act(async () => {
      expect(await store.setCategoryColor("Taxes", null)).toBe(true);
    });
    expect(store.snapshot.categoryColors).toEqual({ UGC: "#4f7cb8" });
    expect(memory.snapshot().categoryColors).toEqual({ UGC: "#4f7cb8" });
    refuse = true;
    await act(async () => {
      expect(await store.setCategoryColor("UGC", "#8466ae")).toBe(false);
    });
    expect(store.snapshot.categoryColors).toEqual({ UGC: "#4f7cb8" });
  });
});
