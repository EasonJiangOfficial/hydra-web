"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";

import { ActivityList } from "@/components/activity/activity-list";
import { UndoBar, type UndoItem } from "@/components/activity/undo-bar";
import { Button } from "@/components/kit";
import type { ActivityEntry, ActivityPage, UndoResult } from "@/lib/activity/types";

export const TZ = "America/Los_Angeles";
export const NOW = "2026-11-21T20:00:00.000Z";
const PAGE = 12;

const h = (hoursAgo: number) => new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString();
const base = { details: [], undoneAt: null, undoOf: null, canUndo: true } satisfies Partial<ActivityEntry>;

/** Every state the page draws, newest first; the tail is filler so paging has a second and third page. */
function entries(): ActivityEntry[] {
  const list: ActivityEntry[] = [
    { ...base, id: "a-task", at: h(0.2), actor: "you", summary: 'Deleted task "Film 6 Wordwise videos"', details: ["Status: In progress", "Due: Nov 24", "Goal: 60 videos in November"] },
    { ...base, id: "a-changed", at: h(0.9), actor: "hydra", summary: "Changed 3 transactions to Software", details: ["Figma: Shopping → Software", "Notion: Other → Software", "Linear: Other → Software"] },
    { ...base, id: "a-routine", at: h(1.5), actor: "routine", summary: 'Added 2 UGC deal payments from Gmail ("Brand payment emails")', details: ["Wordwise: +$450.00, Nov 20", "Brightleaf: +$300.00, Nov 20"] },
    { ...base, id: "a-outside", at: h(2), actor: "hydra", summary: "Sent W-9 to payments@wordwise.com", canUndo: false, cannotUndo: "outside" },
    { ...base, id: "a-undone", at: h(3), actor: "you", summary: 'Deleted rule "Uber → Transport"', undoneAt: h(2.5), canUndo: false, cannotUndo: "undone" },
    { ...base, id: "a-redo", at: h(2.5), actor: "you", summary: 'Undid: Deleted rule "Uber → Transport"', undoOf: "a-undone" },
    {
      ...base,
      id: "a-long",
      at: h(5),
      actor: "hydra",
      summary:
        'Renamed goal "Post every single day in November across TikTok, Instagram Reels and YouTube Shorts without missing a day" to "Post daily in November on all three platforms, and log each post in the UGC tracker the same day"',
      details: Array.from({ length: 20 }, (_, i) => `Task ${i + 1}: Goal: Post every single day in November → Post daily in November on all three platforms`),
    },
    { ...base, id: "a-fail", at: h(6), actor: "you", summary: "Hid 14 transactions from reports", details: Array.from({ length: 14 }, (_, i) => `Starbucks #${1000 + i}: Hidden: no → yes`) },
    { ...base, id: "a-taken", at: h(40), actor: "you", summary: 'Deleted category "Gear"' },
    { ...base, id: "a-y1", at: h(22), actor: "you", summary: 'Moved task "Send invoice to Brightleaf" to Done', details: ["Status: In progress → Done"] },
    { ...base, id: "a-y2", at: h(26), actor: "routine", summary: 'Ran "Morning money check"' , canUndo: false, cannotUndo: "outside" },
    { ...base, id: "a-old", at: h(24 * 31), actor: "you", summary: 'Deleted account "Old Chase checking"', canUndo: false, cannotUndo: "expired" },
  ];
  const filler: ActivityEntry[] = Array.from({ length: 20 }, (_, i) => ({
    ...base,
    id: `a-f${i}`,
    at: h(30 + i * 9),
    actor: (["you", "hydra", "routine"] as const)[i % 3],
    summary: `Changed category of "Trader Joe's #${i + 1}" to Groceries`,
    details: ["Category: Food → Groceries"],
  }));
  return [...list.slice(0, -1), ...filler, list.at(-1)!].sort((a, b) => b.at.localeCompare(a.at));
}

/** In-memory listActivity and undoActivity with the real answers: changed_since, failed, and an undo that logs itself. */
function useMemoryActivity(empty: boolean) {
  const [initial] = useState(() => (empty ? [] : entries()));
  const store = useRef<ActivityEntry[]>(initial);
  const load = useCallback(async ({ before, limit = PAGE }: { before?: string; limit?: number }): Promise<ActivityPage> => {
    const all = store.current;
    const start = before ? all.findIndex((e) => e.id === before) + 1 : 0;
    const page = all.slice(start, start + limit);
    return { entries: page.map((e) => ({ ...e })), next: start + limit < all.length ? page.at(-1)!.id : null };
  }, []);
  const undo = useCallback(async (id: string, { force = false }: { force?: boolean }): Promise<UndoResult> => {
    await new Promise((r) => setTimeout(r, 300));
    const e = store.current.find((x) => x.id === id);
    if (!e) return { ok: true, undoId: `u-${id}` }; // the undo bar's demo deletes
    if (e.id === "a-fail") return { ok: false, error: "failed" };
    if (e.id === "a-taken") return { ok: false, error: "changed_since", changed: ["A category with the same name exists now"], blocked: true };
    if (e.id === "a-changed" && !force) return { ok: false, error: "changed_since", changed: ["Figma: now Design (changed Nov 21, 12:40 PM)", "Notion: row deleted since"] };
    if (e.undoneAt) return { ok: false, error: "already_undone" };
    const at = new Date(Date.parse(NOW) + store.current.length * 1000).toISOString();
    e.undoneAt = at;
    e.canUndo = false;
    e.cannotUndo = "undone";
    const undoId = `u-${id}`;
    store.current = [{ ...base, id: undoId, at, actor: "you", summary: `Undid: ${e.summary}`, details: e.details, undoOf: id }, ...store.current];
    return { ok: true, undoId };
  }, []);
  return { load, undo, first: { entries: initial.slice(0, PAGE), next: initial.length > PAGE ? initial[PAGE - 1].id : null } };
}

/** `?state=empty | bar`; default: the full list. The skeleton is at /dev/activity/loading. */
export function ActivityFixture() {
  return <Live state={useSearchParams().get("state")} />;
}

function Live({ state }: { state: string | null }) {
  const { load, undo, first } = useMemoryActivity(state === "empty");
  const [bar, setBar] = useState<UndoItem | null>(state === "bar" ? { activityId: "d-1", thing: 'task "Film 6 Wordwise videos"' } : null);
  const n = useRef(1);
  const close = useCallback(() => setBar(null), []);
  return (
    <>
      {state === "bar" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setBar({ activityId: `d-${++n.current}`, thing: 'deal "Wordwise November"' })}>Delete a deal</Button>
          <Button onClick={() => setBar({ activityId: `d-${++n.current}`, thing: 'transaction "Uber Eats, an unusually long merchant name that will not fit on a phone"' })}>
            Delete a transaction
          </Button>
          <Button onClick={() => setBar({ activityId: "fail", thing: 'rule "Uber → Transport"' })}>Delete (undo fails)</Button>
        </div>
      )}
      <ActivityList first={first} timeZone={TZ} now={NOW} load={load} undo={undo} />
      <UndoBar item={bar} onClose={close} undo={async (id) => (id === "fail" ? { ok: false, error: "failed" } : undo(id, {}))} />
    </>
  );
}
