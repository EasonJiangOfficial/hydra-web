import type { Metadata } from "next";

import { ControlsFixture } from "./fixture";

export const metadata: Metadata = { title: "Controls" };

/** Fixture: every custom control (Select, DatePicker, TimePicker, DateTimePicker, Checkbox) in every state. */
export default function ControlsFixturePage() {
  return (
    <main className="mx-auto flex max-w-[960px] flex-col gap-8 px-4 py-8 sm:px-8">
      <h1 className="text-title">Controls</h1>
      <ControlsFixture />
    </main>
  );
}
