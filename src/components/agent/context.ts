"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import type { AgentController, AgentState } from "./controller";

export const AgentContext = createContext<AgentController | null>(null);

export function useAgent(): { ctl: AgentController; state: AgentState } {
  const ctl = useContext(AgentContext);
  if (!ctl) throw new Error("useAgent needs <AgentProvider> (the app shell mounts it)");
  return { ctl, state: useSyncExternalStore(ctl.subscribe, ctl.getSnapshot, ctl.getServerSnapshot) };
}
