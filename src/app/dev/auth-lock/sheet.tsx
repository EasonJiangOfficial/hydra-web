"use client";

import { Dialog } from "radix-ui";

/** A portaled Radix sheet with a focus trap: the lock must remove it, not paint under it. */
export function FixtureSheet() {
  return (
    <Dialog.Root>
      <Dialog.Trigger className="mt-4 text-label text-ink-3">Open sheet</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/20" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="fixture-sheet"
          className="fixed inset-x-0 bottom-0 z-50 rounded-t-xl border-t border-rule bg-surface p-6"
        >
          <Dialog.Title className="text-section">Sheet</Dialog.Title>
          <button type="button" className="mt-2 text-label text-ink-2">
            Inside the sheet
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
