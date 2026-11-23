"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { z } from "zod";

import { offerUndo } from "@/components/activity/undo-bar";
import { Button, DetailDrawer, FadeIn, InfoDot, Money, SkeletonPanel } from "@/components/kit";
import { FieldRow, SaveLabel, useAutosave, type SaveState } from "@/components/planning/controls";
import { Select } from "@/components/ui/select";
import { DrawerHeader } from "@/components/planning/drawer-header";
import { ColorPicker } from "@/components/ui/color-picker";

import { ConfirmButton } from "./confirm";
import { accountName, categoryReason, effectiveTaxLineId, longDate, seedFromRow } from "./describe";
import { CategorySelect, EntitySelect } from "./pickers";
import { useTx } from "./store";
import { Switch } from "./switch";
import type { TxRow } from "./types";

const nameSchema = z.string().trim().min(1).max(200);

/** The kit's slide-out for `?tx=<id>`. Every field saves by itself. */
export function TransactionDrawer() {
  return (
    <DetailDrawer param="tx" label="Transaction">
      {(id) => <TxPanel key={id} id={id} />}
    </DetailDrawer>
  );
}

function TxPanel({ id }: { id: string }): ReactNode {
  const s = useTx();
  const { ensureRow } = s;
  const [tried, setTried] = useState(false);
  useEffect(() => {
    let live = true;
    void ensureRow(id).finally(() => live && setTried(true));
    return () => {
      live = false;
    };
  }, [id, ensureRow]);
  const row = s.rowFor(id);
  // A row not in the list yet (a link from elsewhere) loads: the skeleton shows, then the fields fade in.
  const [waited] = useState(() => !row);
  if (!row) return tried ? <p className="text-label text-ink-3">This transaction is gone.</p> : <SkeletonPanel rows={6} />;
  // Keyed by id: opening another transaction starts its fields fresh.
  return waited ? (
    <FadeIn>
      <TxFields key={row.id} row={row} />
    </FadeIn>
  ) : (
    <TxFields key={row.id} row={row} />
  );
}

function useSaveState() {
  const [state, setState] = useState<SaveState>("idle");
  const track = useCallback(async (done: Promise<boolean>) => {
    setState("saving");
    const ok = await done;
    setState(ok ? "saved" : "error");
    return ok;
  }, []);
  return { state, track };
}

function TxFields({ row }: { row: TxRow }) {
  const s = useTx();
  const { lookups, api } = s;
  const uid = useId();
  const { state, track } = useSaveState();
  const note = useAutosave(row.note ?? "", (text) => track(s.edit(row.id, { note: text.trim() ? text : null })));
  const reason = categoryReason(row, s.rules, lookups);
  const entity = lookups.entities.find((e) => e.id === row.entity_id);
  const taxLineId = effectiveTaxLineId(row, lookups);
  const canMapTax = entity?.kind === "business" && !!row.category_id;
  // Reports rolls a subcategory into its top-level category, so the color goes on the top-level one.
  const category = lookups.categories.find((c) => c.id === row.category_id);
  const top = category?.parent_id ? (lookups.categories.find((c) => c.id === category.parent_id) ?? category) : category;

  return (
    <div className="flex flex-col gap-5" data-tx-panel={row.id}>
      <DrawerHeader
        title={row.name}
        label="Name"
        schema={nameSchema}
        onSave={(name) => void track(s.edit(row.id, { name }))}
        aside={<SaveLabel state={state} />}
      />
      <div className="flex flex-col gap-1 px-2">
        <span className="text-figure-s tabular-nums">
          <Money cents={row.amount_cents} signed />
        </span>
        <span className="text-label text-ink-3">
          {longDate(row.posted_on)} · {accountName(lookups, row.account_id)}
          {row.pending ? " · Pending" : ""}
        </span>
      </div>

      <div>
        <FieldRow label="Category" htmlFor={`${uid}-category`}>
          {/* The select gets the row's full width so its value never clips; "Edit rule" sits under it. */}
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
            <div className="flex w-full min-w-0 items-center gap-2">
              <CategorySelect
                id={`${uid}-category`}
                className="flex-1"
                lookups={lookups}
                entityId={row.entity_id}
                value={row.category_id}
                placeholder="No category"
                onChange={(next) => void track(s.categorize(row.id, next))}
              />
              {row.category_id && <InfoDot label="Who set the category">{reason.text}</InfoDot>}
            </div>
            {/* The color sits under the select so the select keeps the row's width. */}
            {reason.rule || top ? (
              <div className="flex items-center gap-1">
                {reason.rule && (
                  <Button variant="ghost" className="-ml-2.5 h-7 text-label" onClick={() => s.openRuleEditor({ kind: "edit", rule: reason.rule! })}>
                    Edit rule
                  </Button>
                )}
                {top ? (
                  <ColorPicker
                    value={top.color}
                    allowNone
                    label={top.name}
                    onChange={(color) =>
                      void track(
                        api.updateCategory({ id: top.id, color }).then((res) => {
                          if (!res.ok) {
                            s.notify(res.error.message);
                            return false;
                          }
                          s.updateLookups((l) => ({ ...l, categories: l.categories.map((c) => (c.id === top.id ? { ...c, color } : c)) }));
                          return true;
                        }),
                      )
                    }
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </FieldRow>
        <FieldRow label="Business" htmlFor={`${uid}-entity`}>
          <EntitySelect
            id={`${uid}-entity`}
            className="flex-1"
            lookups={lookups}
            value={row.entity_id}
            onChange={(next) => next && next !== row.entity_id && void track(s.edit(row.id, { entityId: next }))}
          />
        </FieldRow>
        <FieldRow label="Tax line" htmlFor={`${uid}-tax`}>
          <Select
            id={`${uid}-tax`}
            className="flex-1"
            value={taxLineId ?? ""}
            disabled={!canMapTax}
            onChange={(e) => {
              const next = e.target.value || null;
              if (!row.category_id) return;
              void track(
                api.mapCategoryTaxLine({ categoryId: row.category_id, entityId: row.entity_id, taxLineId: next }).then((res) => {
                  if (!res.ok) {
                    s.notify(res.error.message);
                    return false;
                  }
                  s.updateLookups((l) => ({
                    ...l,
                    categoryTaxLines: [
                      ...l.categoryTaxLines.filter((m) => !(m.category_id === row.category_id && m.entity_id === row.entity_id)),
                      ...(next ? [{ category_id: row.category_id!, entity_id: row.entity_id, tax_line_id: next }] : []),
                    ],
                  }));
                  return true;
                }),
              );
            }}
          >
            <option value="">{canMapTax ? "No tax line" : "Not on a tax form"}</option>
            {lookups.taxLines.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} {t.name}
              </option>
            ))}
          </Select>
          {canMapTax && (
            <InfoDot label="About the tax line">
              {`Sets the line for every ${category?.name ?? "category"} transaction in ${entity?.name}. Reports use it for Schedule C.`}
            </InfoDot>
          )}
        </FieldRow>
        <FieldRow label="Split">
          <Button variant="outline" disabled className="flex-1 justify-start">
            Split this transaction
          </Button>
          <InfoDot label="About splits">Splits are not built yet: the money engine has no split action to call.</InfoDot>
        </FieldRow>
        <FieldRow label="Receipt">
          <Button variant="outline" disabled className="flex-1 justify-start">
            Upload a receipt
          </Button>
          <InfoDot label="About receipts">Receipts are not built yet: there is no receipt store or action to call.</InfoDot>
        </FieldRow>
        <TransferRow row={row} />
        <RecurringRow row={row} />
        {row.amount_cents > 0 && !row.is_transfer && <DealRow row={row} />}
        <FieldRow label="Hide">
          <Switch label="Hide from reports" checked={row.hidden} onChange={(hidden) => void track(s.edit(row.id, { hidden }))} />
          <span className="text-label text-ink-3">From reports</span>
        </FieldRow>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-label text-ink-3">Note</span>
        <textarea
          aria-label="Note"
          rows={4}
          value={note.draft}
          onChange={(e) => note.edit(e.target.value)}
          onBlur={() => void note.flush()}
          className="w-full resize-none rounded-lg border border-rule-2 bg-surface p-3 text-body text-ink outline-none transition-colors duration-200 placeholder:text-ink-3 focus:border-ink"
          placeholder="Add a note"
        />
      </label>

      <div className="flex items-center gap-2 border-t border-rule pt-4">
        <Button variant="outline" onClick={() => s.openRuleEditor({ kind: "new", seed: seedFromRow(row) })}>
          Make a rule from this
        </Button>
        {row.source === "manual" && !row.transfer_pair_id && <DeleteManual row={row} />}
      </div>
    </div>
  );
}

/** A row the owner typed in can be deleted (a bank row is hidden instead). Undo brings it back with its deal payment. */
function DeleteManual({ row }: { row: TxRow }) {
  const s = useTx();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  // A deposit matched to a UGC deal loses that payment with it: the question names the deal.
  const [dealId, setDealId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    s.api.dealPayment(row.id).then(
      (p) => live && setDealId(p?.deal_id ?? null),
      () => live && setDealId(null),
    );
    return () => {
      live = false;
    };
  }, [s.api, row.id]);
  const deal = dealId ? (s.lookups.deals.find((d) => d.id === dealId)?.name ?? "a deal") : null;
  return (
    <ConfirmButton
      className="ml-auto text-ink-3"
      label="Delete"
      question={deal ? `Delete this transaction and its payment on "${deal}"?` : "Delete this transaction?"}
      confirmLabel="Delete"
      onConfirm={async () => {
        const res = await s.api.deleteManualTransaction({ transactionId: row.id });
        if (!res.ok) return s.notify(res.error.message);
        const next = new URLSearchParams(search);
        next.delete("tx");
        router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false });
        s.reload();
        s.refreshReviewCount();
        offerUndo(res.activityId, `"${row.name}"`, () => {
          s.reload();
          s.refreshReviewCount();
        });
      }}
    />
  );
}

function TransferRow({ row }: { row: TxRow }) {
  const s = useTx();
  const { api, lookups } = s;
  const [candidates, setCandidates] = useState<TxRow[]>([]);
  const [pick, setPick] = useState("");
  const { ensureRow } = s;
  const partnerId = row.transfer_pair_id;

  useEffect(() => {
    if (partnerId) void ensureRow(partnerId);
  }, [partnerId, ensureRow]);
  useEffect(() => {
    let live = true;
    if (!row.is_transfer && !partnerId)
      api.pairCandidates(row.id).then(
        (c) => live && setCandidates(c),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [api, row.id, row.is_transfer, partnerId]);

  const partner = partnerId ? s.rowFor(partnerId) : undefined;
  const afterChange = () => {
    s.refreshReviewCount();
    if (s.filters.review) s.reload();
  };

  if (row.is_transfer)
    return (
      <FieldRow label="Transfer">
        <span className="min-w-0 flex-1 truncate text-body">
          {partner ? `${partner.name}, ${accountName(lookups, partner.account_id)}` : "Marked as a transfer"}
        </span>
        <Button
          variant="outline"
          onClick={async () => {
            const res = await api.unpairTransfer({ transactionId: row.id });
            if (!res.ok) return s.notify(res.error.message);
            for (const id of [row.id, partnerId]) if (id) s.patchRow(id, { is_transfer: false, transfer_pair_id: null, category_source: "manual" });
            afterChange();
          }}
        >
          Not a transfer
        </Button>
      </FieldRow>
    );

  return (
    <FieldRow label="Transfer" htmlFor={`${row.id}-pair`}>
      {candidates.length ? (
        <Select
          id={`${row.id}-pair`}
          className="flex-1"
          value={pick}
          onChange={async (e) => {
            const other = e.target.value;
            setPick(other);
            if (!other) return;
            const res = await api.pairTransfers({ aId: row.id, bId: other });
            setPick("");
            if (!res.ok) return s.notify(res.error.message);
            s.patchRow(row.id, { is_transfer: true, transfer_pair_id: other });
            s.patchRow(other, { is_transfer: true, transfer_pair_id: row.id });
            afterChange();
          }}
        >
          <option value="">Pair with a match</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}, {accountName(lookups, c.account_id)}, {c.posted_on}
            </option>
          ))}
        </Select>
      ) : (
        <span className="flex-1 text-body text-ink-3">Not a transfer</span>
      )}
      <InfoDot label="About transfers">
        A transfer or card payment moves money between your own accounts. Paired rows are left out of income and spending. Matches have the same amount, the other sign, another account, within 5 days.
      </InfoDot>
    </FieldRow>
  );
}

function RecurringRow({ row }: { row: TxRow }) {
  const s = useTx();
  const { api, lookups } = s;
  const series = lookups.recurring.find((r) => r.id === row.recurring_id);
  if (!series)
    return (
      <FieldRow label="Recurring">
        <span className="flex-1 text-body text-ink-3">Not recurring</span>
        <InfoDot label="About recurring">Hydra finds repeats by itself: same name, steady amount, steady gap. You confirm or dismiss them here.</InfoDot>
      </FieldRow>
    );
  const status = { suggested: "Suggested", confirmed: "Confirmed", dismissed: "Dismissed" }[series.status];
  const setStatus = (next: "confirmed" | "dismissed") => async () => {
    const res = await (next === "confirmed" ? api.confirmRecurring({ id: series.id }) : api.dismissRecurring({ id: series.id }));
    if (!res.ok) return s.notify(res.error.message);
    s.updateLookups((l) => ({ ...l, recurring: l.recurring.map((r) => (r.id === series.id ? { ...r, status: next } : r)) }));
    if (next === "dismissed") {
      s.patchRow(row.id, { recurring_id: null });
      s.reload();
    }
  };
  return (
    <FieldRow label="Recurring">
      <span className="min-w-0 flex-1 text-body">
        {series.name}
        <span className="text-ink-3">, every {series.gap_days} days, {status.toLowerCase()}</span>
        {series.price_change_flagged && <span className="text-ink-3">, price changed</span>}
      </span>
      {series.status === "suggested" && (
        <Button variant="outline" onClick={setStatus("confirmed")}>
          Confirm
        </Button>
      )}
      {series.status !== "dismissed" && (
        <Button variant="ghost" className="text-ink-3" onClick={setStatus("dismissed")}>
          Dismiss
        </Button>
      )}
    </FieldRow>
  );
}

function DealRow({ row }: { row: TxRow }) {
  const s = useTx();
  const { api, lookups } = s;
  const [dealId, setDealId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api.dealPayment(row.id).then(
      (p) => live && setDealId(p?.deal_id ?? null),
      () => live && setDealId(null),
    );
    return () => {
      live = false;
    };
  }, [api, row.id]);
  const deal = lookups.deals.find((d) => d.id === dealId);

  return (
    <FieldRow label="UGC deal" htmlFor={`${row.id}-deal`}>
      {dealId === undefined ? null : dealId ? (
        <>
          <span className="min-w-0 flex-1 truncate text-body">{deal?.name ?? "A deal"}</span>
          <ConfirmButton
            label="Unlink"
            question="Unlink this deposit from the deal?"
            confirmLabel="Unlink"
            onConfirm={async () => {
              const was = dealId;
              const res = await api.unmatchPayment({ transactionId: row.id });
              if (!res.ok) return s.notify(res.error.message);
              setDealId(null);
              offerUndo(res.activityId, `match to "${deal?.name ?? "a deal"}"`, () => setDealId(was));
            }}
          />
        </>
      ) : (
        <Select
          id={`${row.id}-deal`}
          className="flex-1"
          value=""
          onChange={async (e) => {
            const next = e.target.value;
            if (!next) return;
            const res = await api.matchPayment({ dealId: next, transactionId: row.id, amountCents: row.amount_cents, paidOn: row.posted_on });
            if (!res.ok) return s.notify(res.error.message);
            setDealId(next);
          }}
        >
          <option value="">Link to a deal</option>
          {lookups.deals.filter((d) => !d.personal).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
      )}
    </FieldRow>
  );
}
