import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { MockBoundary } from "./mock-boundary";

/** Fixture: the real app shell (so the real sidebar card and phone orb) over a scripted /api/agent mock. */
export default function AgentFixtureLayout({ children }: { children: ReactNode }) {
  return (
    <MockBoundary>
      <AppShell>{children}</AppShell>
    </MockBoundary>
  );
}
