import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";

import { NotesFixture } from "./fixture";

export const metadata: Metadata = { title: "Notes fixture" };

/** Fixture: the Notes page on in-memory data, inside the app shell. */
export default function NotesFixturePage() {
  return (
    <AppShell activeHref="/notes">
      <Suspense fallback={null}>
        <NotesFixture />
      </Suspense>
    </AppShell>
  );
}
