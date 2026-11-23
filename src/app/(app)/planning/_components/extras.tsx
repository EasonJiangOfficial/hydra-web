"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { offerUndo } from "@/components/activity/undo-bar";
import { usePlanning } from "@/components/planning/planning-store";
import { addDays, wallClock, zonedInstant } from "@/lib/planning/dates";
import { moveEventToDay } from "@/lib/planning/events";
import type { EventPatch } from "@/lib/planning/schemas";
import type { PlanningActions, PlanningEvent, PlanningResult } from "@/lib/planning/types";
import type { FinanceFacts } from "@/lib/planning-metrics/finance-dates";

/**
 * What the Planning page adds to the U4 store: events (the store holds tasks and goals only) and
 * the read-only finance facts. Events write through the same PlanningActions, show at once and
 * roll back when the server refuses, like the store's tasks.
 */
export interface PlanningExtras {
  readonly events: readonly PlanningEvent[];
  readonly facts: FinanceFacts;
  /** The last refused event write, in words. Clears itself. */
  readonly error: string | null;
  dismissError(): void;
  /** The event open for editing in the day panel. */
  readonly selectedEventId: string | null;
  selectEvent(id: string | null): void;
  /** An all-day event on `date`. Null when refused. */
  createEvent(input: { title: string; date: string }): Promise<string | null>;
  updateEvent(id: string, patch: EventPatch): Promise<boolean>;
  /** The whole series moves: its first occurrence shifts by `days`. */
  shiftEvent(id: string, days: number): Promise<boolean>;
  deleteEvent(id: string): Promise<boolean>;
}

const Ctx = createContext<PlanningExtras | null>(null);

export function usePlanningExtras(): PlanningExtras {
  const extras = useContext(Ctx);
  if (!extras) throw new Error("usePlanningExtras needs a PlanningExtrasProvider");
  return extras;
}

const uuid = (): string => globalThis.crypto.randomUUID();

export function PlanningExtrasProvider({
  initialEvents,
  facts,
  actions,
  children,
}: {
  initialEvents: readonly PlanningEvent[];
  facts: FinanceFacts;
  actions: PlanningActions;
  children: ReactNode;
}) {
  const { timeZone, now } = usePlanning();
  const [events, setEvents] = useState(initialEvents);
  const latest = useRef(initialEvents);
  const apply = useCallback((fn: (list: readonly PlanningEvent[]) => readonly PlanningEvent[]) => {
    latest.current = fn(latest.current);
    setEvents(latest.current);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [selectedEventId, selectEvent] = useState<string | null>(null);
  const seq = useRef(new Map<string, number>());

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(t);
  }, [error]);

  const fail = useCallback(<T,>(r: PlanningResult<T>): r is Extract<PlanningResult<T>, { ok: false }> => {
    if (r.ok) return false;
    setError(r.error);
    return true;
  }, []);

  const value = useMemo<PlanningExtras>(() => {
    const replace = (id: string, fn: (e: PlanningEvent) => PlanningEvent) =>
      apply((list) => list.map((e) => (e.id === id ? fn(e) : e)));

    const updateEvent: PlanningExtras["updateEvent"] = async (id, patch) => {
      const before = latest.current.find((e) => e.id === id);
      if (!before) return false;
      const n = (seq.current.get(id) ?? 0) + 1;
      seq.current.set(id, n);
      replace(id, (e) => ({ ...e, ...patch }));
      const r = await actions.updateEvent(id, patch);
      if (fail(r)) {
        // A newer write to the same event owns the screen now.
        if (seq.current.get(id) === n) replace(id, () => before);
        return false;
      }
      if (seq.current.get(id) === n) replace(id, () => r.value);
      return true;
    };

    return {
      events,
      facts,
      error,
      dismissError: () => setError(null),
      selectedEventId,
      selectEvent,
      updateEvent,

      async createEvent({ title, date }) {
        const text = title.trim();
        if (!text) return null;
        const id = uuid();
        const stamp = now().toISOString();
        const startsAt = zonedInstant(date, "00:00", timeZone).toISOString();
        const event: PlanningEvent = {
          id,
          title: text,
          startsAt,
          endsAt: null,
          allDay: true,
          category: null,
          repeat: null,
          notes: "",
          alertAt: null,
          googleEventId: null,
          createdAt: stamp,
          updatedAt: stamp,
        };
        apply((list) => [...list, event]);
        const r = await actions.createEvent({ id, title: text, startsAt, endsAt: null, allDay: true, category: null, repeat: null, notes: "", alertAt: null });
        if (fail(r)) {
          apply((list) => list.filter((e) => e.id !== id));
          return null;
        }
        replace(id, () => r.value);
        return id;
      },

      async shiftEvent(id, days) {
        const e = latest.current.find((x) => x.id === id);
        if (!e || days === 0) return false;
        const first = wallClock(new Date(e.startsAt), timeZone).date;
        return updateEvent(id, moveEventToDay(e, addDays(first, days), timeZone));
      },

      async deleteEvent(id) {
        const before = latest.current.find((e) => e.id === id);
        if (!before) return false;
        apply((list) => list.filter((e) => e.id !== id));
        selectEvent((cur) => (cur === id ? null : cur));
        const r = await actions.deleteEvent(id);
        const putBack = () => apply((list) => (list.some((e) => e.id === id) ? list : [...list, before]));
        if (fail(r)) {
          putBack();
          return false;
        }
        offerUndo(r.activityId, `event "${before.title}"`, putBack);
        return true;
      },
    };
  }, [actions, apply, error, events, facts, fail, now, selectedEventId, timeZone]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
