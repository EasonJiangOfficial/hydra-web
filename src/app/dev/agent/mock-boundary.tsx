"use client";

import type { ReactNode } from "react";
import { PRESETS } from "./fake-bridge";
import { installAgentMock } from "./mock";

/** `?desktop=<preset>` puts a fake Hydra Desktop bridge in the window (unless the page already has one). */
function installFakeDesktop() {
  if (typeof window === "undefined" || window.hydraDesktop) return;
  const make = PRESETS[new URLSearchParams(window.location.search).get("desktop") ?? ""];
  if (!make) return;
  const fake = make();
  window.hydraDesktop = fake.bridge;
  (window as unknown as { __bridge: typeof fake }).__bridge = fake;
  // A made-up voice, so the mirrored orb ripples while the fake Mac speaks.
  setInterval(() => {
    if (fake.bridge.state !== "Speaking" || fake.bridge.snapshot().paused) return;
    const t = performance.now() / 1000;
    fake.push({ outputLevel: Math.max(0, 0.45 + 0.3 * Math.sin(t * 7.3) + 0.2 * Math.sin(t * 17.1)) });
  }, 66);
}

// Runs when the module loads, before React hydrates and before the agent's first request.
installAgentMock();
installFakeDesktop();

export function MockBoundary({ children }: { children: ReactNode }) {
  return children;
}
