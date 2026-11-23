"use client";

import { useState } from "react";

import { Button } from "@/components/kit";

import { categoryName, entityName } from "./describe";
import { CategorySelect, EntitySelect } from "./pickers";
import { useTx } from "./store";

/** More rows than this and a bulk change asks first. */
const ASK_OVER = 10;
const AT_ONCE = 6;

type Change = { kind: "category"; id: string } | { kind: "entity"; id: string } | { kind: "hide"; hidden: boolean };

/** Runs `fn` over `items`, `AT_ONCE` at a time. */
async function inBatches<T>(items: readonly T[], fn: (item: T) => Promise<boolean>): Promise<number> {
  let done = 0;
  for (let i = 0; i < items.length; i += AT_ONCE) {
    const results = await Promise.all(items.slice(i, i + AT_ONCE).map(fn));
    done += results.filter(Boolean).length;
  }
  return done;
}

/**
 * Bulk edit for the selected rows: category, business, hide. Over 10 rows it asks first.
 * (There is no bulk delete of transactions: bank rows are never deleted. Rules have their own, with a confirm.)
 */
export function BulkBar() {
  const s = useTx();
  const { api, lookups, selected } = s;
  const [pending, setPending] = useState<Change | null>(null);
  const [busy, setBusy] = useState(false);
  const n = selected.size;
  if (!n) return null;

  const label = (c: Change) =>
    c.kind === "category"
      ? `Set category ${categoryName(lookups, c.id)}`
      : c.kind === "entity"
        ? `Set business ${entityName(lookups, c.id)}`
        : c.hidden
          ? "Hide from reports"
          : "Show in reports";

  async function apply(change: Change) {
    setBusy(true);
    setPending(null);
    const ids = [...selected];
    const ok = await inBatches(ids, async (id) => {
      if (change.kind === "category") {
        const res = await api.setCategory({ transactionId: id, categoryId: change.id });
        if (res.ok) s.patchRow(id, { category_id: change.id, category_source: "manual" });
        return res.ok;
      }
      const res = await api.editTransaction(change.kind === "entity" ? { transactionId: id, entityId: change.id } : { transactionId: id, hidden: change.hidden });
      if (res.ok) s.patchRow(id, change.kind === "entity" ? { entity_id: change.id } : { hidden: change.hidden });
      return res.ok;
    });
    setBusy(false);
    s.clearSelected();
    s.refreshReviewCount();
    s.notify(ok === ids.length ? `Changed ${ok} rows` : `Changed ${ok} of ${ids.length} rows`);
    // Rows that left the view (review queue, hidden) go.
    if (s.filters.review || change.kind === "hide") s.reload();
  }

  const choose = (c: Change) => (n > ASK_OVER ? setPending(c) : void apply(c));

  return (
    <div role="region" aria-label="Bulk edit" className="flex flex-wrap items-center gap-3 rounded-xl border border-rule bg-tint px-4 py-2.5 motion-safe:animate-hy-fade">
      <span className="text-body tabular-nums">{n} selected</span>
      {pending ? (
        <span role="group" aria-label="Confirm bulk change" className="flex flex-wrap items-center gap-2">
          <span className="text-label text-ink-3 tabular-nums">
            {label(pending)} on {n} rows?
          </span>
          <Button variant="ghost" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void apply(pending)}>
            Apply
          </Button>
        </span>
      ) : (
        <>
          <CategorySelect
            aria-label="Set category for selected"
            lookups={lookups}
            value={null}
            placeholder="Set category"
            disabled={busy}
            onChange={(id) => id && choose({ kind: "category", id })}
            className="w-[190px]"
          />
          <EntitySelect
            aria-label="Set business for selected"
            lookups={lookups}
            value={null}
            placeholder="Set business"
            disabled={busy}
            onChange={(id) => id && choose({ kind: "entity", id })}
            className="w-[150px]"
          />
          <Button variant="outline" disabled={busy} onClick={() => choose({ kind: "hide", hidden: !s.filters.hidden })}>
            {s.filters.hidden ? "Show in reports" : "Hide from reports"}
          </Button>
        </>
      )}
      <div className="flex-1" />
      <Button variant="ghost" onClick={s.clearSelected}>
        Clear
      </Button>
    </div>
  );
}
