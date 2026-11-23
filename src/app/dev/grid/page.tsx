import type { Metadata } from "next";
import { GridDemo } from "./grid-demo";

export const metadata: Metadata = { title: "Grid" };

/** Fixture for the Dashboard grid (U17): kit cards as blocks, layouts kept in localStorage. */
export default function GridPage() {
  return (
    <main className="mx-auto max-w-[1440px] px-4 pt-5 pb-16 md:px-10 md:pt-6">
      <GridDemo />
    </main>
  );
}
