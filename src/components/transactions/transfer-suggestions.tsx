"use client";

import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, InfoDot, Money, cn } from "@/components/kit";

import { accountName, dateLabel } from "./describe";
import { useTx } from "./store";
import type { TransferSuggestion, TxRow } from "./types";

/**
 * Needs review: possible transfers between two cash accounts. Automatic pairing never takes these (a
 * payout and a bill can share an amount), so both rows keep counting until the owner marks the pair.
 * "Not a transfer" is remembered and the pair is not suggested again.
 */
export function TransferSuggestions() {
  const s = useTx();
  const { api, lookups } = s;
  const review = s.params.review;
  const [items, setItems] = useState<TransferSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!review) return;
    let live = true;
    api.transferSuggestions().then(
      (list) => live && setItems(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, review]);

  const entityId = s.filters.entityId;
  const shown = items.filter((p) => !entityId || p.out.entity_id === entityId || p.into.entity_id === entityId);
  if (!review || !shown.length) return null;

  async function decide(p: TransferSuggestion, pair: boolean) {
    const key = p.out.id;
    setBusy(key);
    const input = { aId: p.out.id, bId: p.into.id };
    const res = pair ? await api.pairTransfers(input) : await api.rejectTransfer(input);
    setBusy(null);
    if (!res.ok) return s.notify(res.error.message);
    setItems((list) => list.filter((x) => x.out.id !== key));
    if (pair) {
      s.patchRow(p.out.id, { is_transfer: true, transfer_pair_id: p.into.id });
      s.patchRow(p.into.id, { is_transfer: true, transfer_pair_id: p.out.id });
      s.reload();
      s.refreshReviewCount();
    }
  }

  return (
    <section aria-label="Possible transfers" data-testid="transfer-suggestions" className="rounded-xl border border-rule bg-surface">
      <header className="flex items-center gap-2 border-b border-rule px-4 py-2.5 text-label text-ink-3">
        <span>Possible transfers</span>
        <span className="tabular-nums">{shown.length}</span>
        <InfoDot label="About possible transfers">
          The same amount left one of your accounts and reached another within 5 days. Both count as income and spending until you mark them.
        </InfoDot>
      </header>
      <ul>
        {shown.map((p) => (
          <li
            key={p.out.id}
            data-testid="transfer-suggestion"
            className={cn(
              "grid items-center gap-x-3 gap-y-2 border-b border-rule px-4 py-3 transition-opacity duration-200 last:border-b-0",
              "grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[92px_minmax(0,1fr)_16px_minmax(0,1fr)_110px_auto]",
              busy === p.out.id && "opacity-60",
            )}
          >
            <span className="text-label text-ink-3 tabular-nums max-md:hidden">{dateLabel(p.out.posted_on)}</span>
            <Side row={p.out} account={accountName(lookups, p.out.account_id)} />
            <ArrowRight aria-hidden strokeWidth={1.5} className="size-4 text-ink-3 max-md:hidden" />
            <Side row={p.into} account={accountName(lookups, p.into.account_id)} className="max-md:col-start-1" arrow />
            <span className="text-right text-body tabular-nums max-md:col-start-2 max-md:row-start-1">
              <Money cents={p.into.amount_cents} />
            </span>
            <span className="flex justify-end gap-2 max-md:col-span-2">
              <Button variant="ghost" disabled={busy === p.out.id} onClick={() => void decide(p, false)}>
                Not a transfer
              </Button>
              <Button variant="outline" disabled={busy === p.out.id} onClick={() => void decide(p, true)}>
                Mark as transfer
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Side({ row, account, className, arrow = false }: { row: TxRow; account: string; className?: string; arrow?: boolean }) {
  return (
    <span className={cn("flex min-w-0 flex-col", className)}>
      <span className="flex min-w-0 items-center gap-1.5 text-body text-ink">
        {arrow && <ArrowRight aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0 text-ink-3 md:hidden" />}
        <span className="truncate">{row.name}</span>
      </span>
      <span className="truncate text-label text-ink-3">
        {account}
        <span className="md:hidden"> · {dateLabel(row.posted_on)}</span>
      </span>
    </span>
  );
}
