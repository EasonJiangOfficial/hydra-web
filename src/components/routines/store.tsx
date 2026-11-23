"use client";

import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";

import type { Result, RoutinesActions, RoutinesData } from "./types";

interface RoutinesContext {
  data: RoutinesData;
  actions: RoutinesActions;
  /** One status line at the top of the page. */
  notice: string | null;
  say(message: string | null): void;
  /** Run an action; a refusal becomes the status line. True when it worked. */
  attempt(run: Promise<Result>, done?: string): Promise<boolean>;
  creating: boolean;
  setCreating(open: boolean): void;
}

const Ctx = createContext<RoutinesContext | null>(null);

export function useRoutines(): RoutinesContext {
  const ctx = use(Ctx);
  if (!ctx) throw new Error("useRoutines outside RoutinesProvider");
  return ctx;
}

/** Holds the page's data and actions so the list, the strip, the panel and the form share them. */
export function RoutinesProvider({ data, actions, children }: { data: RoutinesData; actions: RoutinesActions; children: ReactNode }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const say = useCallback((message: string | null) => setNotice(message), []);
  const attempt = useCallback(
    async (run: Promise<Result>, done?: string) => {
      const r = await run;
      // A delete with an activity shows the undo bar instead of a notice.
      setNotice(r.ok ? (r.activityId ? null : (done ?? r.message ?? null)) : r.message);
      return r.ok;
    },
    [],
  );
  const value = useMemo(() => ({ data, actions, notice, say, attempt, creating, setCreating }), [data, actions, notice, say, attempt, creating]);
  return <Ctx value={value}>{children}</Ctx>;
}
