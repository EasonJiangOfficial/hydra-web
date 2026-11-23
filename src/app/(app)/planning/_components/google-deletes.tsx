"use client";

import { useState } from "react";

import { Button, InfoDot, Label, ListRow } from "@/components/kit";
import { usePlanning } from "@/components/planning/planning-store";

import { usePlanningExtras } from "./extras";

/** An item whose Google Calendar event was deleted (src/lib/google/calendar.ts PendingDelete). */
export interface GoogleDelete {
  readonly linkId: string;
  readonly kind: "task" | "event";
  readonly itemId: string;
  readonly title: string;
}

export interface GoogleDeletesProps {
  readonly initial: readonly GoogleDelete[];
  /** No: keep the Hydra item and put it back on the Hydra calendar. */
  keep(linkId: string): Promise<boolean>;
}

function Row({ item, onDone, keep }: { item: GoogleDelete; onDone: () => void; keep: GoogleDeletesProps["keep"] }) {
  const { deleteTask } = usePlanning();
  const { deleteEvent } = usePlanningExtras();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function act(run: () => Promise<boolean>) {
    setBusy(true);
    if (await run()) onDone();
    else setBusy(false);
  }

  return (
    <ListRow data-google-delete={item.linkId}>
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      {asking ? (
        <span className="flex shrink-0 items-center gap-1" role="group" aria-label={`Delete ${item.title}?`}>
          <span className="text-label text-ink-3 max-md:hidden">Delete in Hydra?</span>
          <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
            No
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => (item.kind === "task" ? deleteTask(item.itemId) : deleteEvent(item.itemId)))}
          >
            Delete
          </Button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" disabled={busy} aria-label={`Keep ${item.title}`} onClick={() => void act(() => keep(item.linkId))}>
            Keep
          </Button>
          <Button variant="outline" disabled={busy} aria-label={`Delete ${item.title}`} onClick={() => setAsking(true)}>
            Delete
          </Button>
        </span>
      )}
    </ListRow>
  );
}

/**
 * Items deleted in Google Calendar wait here: a delete there never deletes here by itself. Delete
 * asks first; Keep puts the item back on the Hydra calendar. Nothing waiting, nothing shown.
 */
export function GoogleDeletes({ initial, keep }: GoogleDeletesProps) {
  const [items, setItems] = useState(initial);
  if (items.length === 0) return null;
  return (
    <section aria-label="Deleted in Google" className="flex flex-col gap-1 rounded-xl border border-rule bg-surface px-4 py-3">
      <div className="flex items-center gap-2">
        <Label className="flex-1">Deleted in Google</Label>
        <InfoDot label="About items deleted in Google">
          Deleted in Google Calendar. Delete removes it here too. Keep puts it back on the calendar.
        </InfoDot>
      </div>
      <div>
        {items.map((item) => (
          <Row key={item.linkId} item={item} keep={keep} onDone={() => setItems((all) => all.filter((x) => x.linkId !== item.linkId))} />
        ))}
      </div>
    </section>
  );
}
