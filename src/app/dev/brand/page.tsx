import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";

import { BrandFixture } from "./fixture";

export const metadata: Metadata = { title: "Personal Brand fixture" };

/** Fixture: the Personal Brand page on in-memory data, inside the app shell. A saved count shows; a reload starts over. */
export default function BrandFixturePage() {
  return (
    <AppShell activeHref="/brand">
      <Suspense fallback={null}>
        <BrandFixture />
      </Suspense>
    </AppShell>
  );
}
