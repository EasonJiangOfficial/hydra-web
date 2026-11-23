"use client";

import { createContext, use, useMemo, useState, type ReactNode } from "react";

import type { SettingsActions, SettingsData } from "./types";

interface SettingsContext {
  data: SettingsData;
  actions: SettingsActions;
  /** One status line under the tabs. */
  notice: string | null;
  say(message: string | null): void;
}

const Ctx = createContext<SettingsContext | null>(null);

export function useSettings(): SettingsContext {
  const ctx = use(Ctx);
  if (!ctx) throw new Error("useSettings outside SettingsProvider");
  return ctx;
}

export function SettingsProvider({ data, actions, children }: { data: SettingsData; actions: SettingsActions; children: ReactNode }) {
  const [notice, say] = useState<string | null>(null);
  const value = useMemo(() => ({ data, actions, notice, say }), [data, actions, notice]);
  return <Ctx value={value}>{children}</Ctx>;
}
