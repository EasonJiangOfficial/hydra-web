"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { mayLeave } from "@/lib/leave-guard";
import { AgentContext } from "./context";
import { AgentController, defaultDeps } from "./controller";
import { AgentPanel } from "./agent-panel";
import { Speaker } from "./speaker";

/**
 * Owns the one AgentController for the window and the expanded panel. Mount once, inside the app shell, so the
 * sidebar card, the phone orb and the panel share one state.
 */
export function AgentProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ctl] = useState(
    () =>
      new AgentController(
        defaultDeps(
          {
            // A page with work not saved yet (Notes) asks the owner before the agent takes them away.
            push: (h) => void (mayLeave(h) && router.push(h)),
            replace: (h) => void (mayLeave(h) && router.replace(h, { scroll: false })),
          },
          new Speaker(),
        ),
      ),
  );
  useEffect(() => {
    const off = ctl.init();
    void ctl.refresh();
    return off;
  }, [ctl]);
  return (
    <AgentContext.Provider value={ctl}>
      {children}
      <AgentPanel />
    </AgentContext.Provider>
  );
}
