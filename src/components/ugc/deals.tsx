"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { z } from "zod";

import { offerUndo } from "@/components/activity/undo-bar";
import { Button, Card, DetailDrawer, InfoDot, Input, Label, ListRow, Money, Pill, cn, formatMoney } from "@/components/kit";
import { DrawerHeader } from "@/components/planning/drawer-header";
import { DatePicker } from "@/components/ui/date-picker";
import { dealRowToInput, matchesPayoutRule, type DealInput } from "@/lib/ugc/schemas";
import { shortDay, paySummary, type DealView } from "./model";

import { ConfirmDelete, DealLogo, ErrorText, Field, LogoPicker, SectionLabel, useAct } from "./controls";
import { PayStructureForm, payValuesOf } from "./pay-form";
import { PayoutForm, payoutValuesOf } from "./payout-form";
import { useUgc } from "./store";
import { useHrefWith, useQueryParam } from "./url";

const STATUS = { active: "Active", paused: "Paused", ended: "Archived" } as const;
const usd = (c: number) => formatMoney(c, { whole: c % 100 === 0 });

export function DealsTab({ onNew, onExisting }: { onNew: () => void; onExisting: () => void }) {
  const { model } = useUgc();
  const href = useHrefWith();
  return (
    <Card aria-label="Deals">
      <SectionLabel>Deals</SectionLabel>
      {model.deals.length === 0 ? (
        <div className="flex flex-col items-start gap-3 py-4">
          <p className="text-body text-ink-3">No deals yet.</p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={onNew}>
              New deal
            </Button>
            <Button onClick={onExisting}>Add existing</Button>
          </div>
        </div>
      ) : (
        <div>
          {model.deals.map((d) => (
            <ListRow
              key={d.deal.id}
              as={Link}
              href={href("deal", d.deal.id)}
              scroll={false}
              aria-label={`Open ${d.deal.brand_name}`}
              data-deal={d.deal.id}
              className="gap-3.5 px-2 py-3"
            >
              <DealLogo name={d.deal.brand_name} url={d.logoUrl} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium">{d.deal.brand_name}</span>
                <span className="block truncate text-tag text-ink-3">{paySummary(d.deal)}</span>
              </span>
              <span className="hidden text-right text-tag text-ink-3 tabular-nums sm:block">
                <span className="block text-body text-ink">
                  <Money cents={d.summary.owedCents} whole /> owed
                </span>
                <Money cents={d.summary.earnedCents} whole /> earned
              </span>
              <Pill tone={d.deal.status === "active" ? "strong" : "default"} className="w-16 justify-end">
                {STATUS[d.deal.status]}
              </Pill>
              <ChevronRight aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-ink-3" />
            </ListRow>
          ))}
        </div>
      )}
    </Card>
  );
}

export function DealPanel() {
  return (
    <DetailDrawer param="deal" label="Deal">
      {(id) => <DealBody key={id} id={id} />}
    </DetailDrawer>
  );
}

function DealBody({ id }: { id: string }) {
  const { model } = useUgc();
  const deal = model.deals.find((d) => d.deal.id === id);
  if (!deal) return <p className="text-body text-ink-3">This deal no longer exists.</p>;
  return <DealEditor key={deal.deal.id} view={deal} />;
}

const nameSchema = z.string().trim().min(1).max(200);

function DealEditor({ view }: { view: DealView }) {
  const { actions } = useUgc();
  const [, setDeal] = useQueryParam("deal");
  const { deal, summary } = view;
  const { busy, error, act } = useAct();
  // The new deal flow could not save the logo (RM-07): say so here, where the picker is, until a pick lands.
  const [logoFail, setLogoFail] = useQueryParam("logofail");
  const input = dealRowToInput(deal);
  const [saved, setSaved] = useState("");
  const patch = async (fields: Partial<DealInput>) => {
    setSaved("");
    const res = await act(() => actions.updateDeal({ id: deal.id, ...fields }));
    if (res) setSaved("Saved");
    return Boolean(res);
  };

  return (
    <div className="flex flex-col gap-6" data-testid="deal-panel">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <DealLogo name={deal.brand_name} url={view.logoUrl} size={40} />
          <div className="min-w-0 flex-1">
            <DrawerHeader title={deal.brand_name} schema={nameSchema} label="Brand name" onSave={(t) => void patch({ brandName: t })} />
          </div>
          <LogoPicker
            hasLogo={Boolean(deal.logo_path)}
            disabled={busy}
            onFile={(file) => {
              setSaved("");
              void act(() => actions.uploadDealLogo({ dealId: deal.id, file })).then((res) => {
                if (!res) return;
                setSaved("Saved");
                if (logoFail) setLogoFail(null);
              });
            }}
          />
        </div>
        <div className="flex items-center gap-2 px-1 text-tag text-ink-3">
          <span>{STATUS[deal.status]}</span>
          <span>·</span>
          <span>{paySummary(deal)}</span>
          <span role="status" className="ml-auto" data-testid="deal-saved">
            {busy ? "Saving" : saved}
          </span>
        </div>
        <ErrorText>{error ?? (logoFail === deal.id ? "Logo not saved" : null)}</ErrorText>
      </div>

      <dl className="grid grid-cols-2 overflow-hidden rounded-lg border border-rule md:grid-cols-4 [&>*]:border-rule max-md:[&>*:nth-child(-n+2)]:border-b max-md:[&>*:nth-child(odd)]:border-r md:[&>*:not(:first-child)]:border-l">
        {(
          [
            ["Earned", summary.earnedCents, false],
            ["Paid", summary.paidCents, false],
            ["Owed", summary.owedCents, false],
            ["Missed", -summary.missedCents, summary.missedCents > 0],
          ] as const
        ).map(([label, cents, loss]) => (
          <div key={label} className="flex min-w-0 flex-col gap-1.5 px-3 py-3">
            <dt className="text-tag text-ink-3">{label}</dt>
            <dd className={cn("text-section whitespace-nowrap tabular-nums", loss && "text-neg")}>
              <Money cents={cents} whole />
            </dd>
          </div>
        ))}
      </dl>

      <Status view={view} onGone={() => setDeal(null)} />
      <Schedule key={deal.updated_at} view={view} onPatch={patch} busy={busy} />

      <section aria-label="Pay structure" className="flex flex-col gap-3 border-t border-rule pt-5">
        <SectionLabel strong aside={<InfoDot label="About rate changes">Rate changes apply to new videos. Old videos keep the rate they were posted under.</InfoDot>}>
          Pay structure
        </SectionLabel>
        <PayStructureForm
          key={`${deal.id}:${deal.updated_at}`}
          initial={payValuesOf(input)}
          saving={busy}
          onSubmit={async (pay) => {
            await patch(pay);
          }}
        />
      </section>

      <Payout key={`p:${deal.updated_at}`} view={view} onPatch={patch} busy={busy} />
      <Payments view={view} />
    </div>
  );
}

function Status({ view, onGone }: { view: DealView; onGone: () => void }) {
  const { actions } = useUgc();
  const { busy, error, act } = useAct();
  const { deal } = view;
  const videos = view.earnings.videos.length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {deal.status === "active" && (
          <Button disabled={busy} onClick={() => void act(() => actions.pauseDeal({ id: deal.id }))}>
            Pause
          </Button>
        )}
        {deal.status === "paused" && (
          <Button disabled={busy} onClick={() => void act(() => actions.resumeDeal({ id: deal.id }))}>
            Resume
          </Button>
        )}
        {/* Archive: no target days after today, a planned end date kept. Restore: it runs again, and the
            archived days make no missed money (writes.ts archivePatch, restorePatch). Neither adds missed money, so neither asks. */}
        {deal.status === "ended" ? (
          <Button disabled={busy} onClick={() => void act(() => actions.resumeDeal({ id: deal.id }))}>
            Restore
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => void act(() => actions.endDeal({ id: deal.id }))}>
            Archive
          </Button>
        )}
        <div className="flex-1" />
        <ConfirmDelete
          what={`Delete ${deal.brand_name} with its ${videos} ${videos === 1 ? "video" : "videos"}, readings and payments`}
          label="Delete deal"
          busy={busy}
          onConfirm={async () => {
            let activityId: string | null | undefined;
            const res = await act(async () => {
              const r = await actions.deleteDeal({ id: deal.id });
              if (r.ok) activityId = r.activityId;
              return r;
            });
            if (res) {
              onGone();
              offerUndo(activityId, `deal "${deal.brand_name}"`);
            }
          }}
        />
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** Start, end and the posting target. Each saves when it changes. */
function Schedule({ view, onPatch, busy }: { view: DealView; onPatch: (f: Partial<DealInput>) => Promise<boolean>; busy: boolean }) {
  const id = useId();
  const { deal } = view;
  const [target, setTarget] = useState(String(deal.daily_target_posts));
  return (
    <section aria-label="Schedule" className="grid grid-cols-2 gap-3 border-t border-rule pt-5">
      <div className="col-span-2">
        <SectionLabel strong>Schedule</SectionLabel>
      </div>
      <Field label="Start date" htmlFor={`${id}-start`}>
        <DatePicker
          id={`${id}-start`}
          clearable={false}
          rangeEnd={deal.end_date}
          defaultValue={deal.start_date}
          disabled={busy}
          onChange={(e) => e.target.value && e.target.value !== deal.start_date && void onPatch({ startDate: e.target.value })}
        />
      </Field>
      <Field label="End date" htmlFor={`${id}-end`}>
        <DatePicker
          id={`${id}-end`}
          rangeStart={deal.start_date}
          min={deal.start_date}
          defaultValue={deal.end_date ?? ""}
          disabled={busy}
          onChange={(e) => (e.target.value || null) !== deal.end_date && void onPatch({ endDate: e.target.value || null })}
        />
      </Field>
      <Field label="Posts per day" htmlFor={`${id}-target`}>
        <Input
          id={`${id}-target`}
          type="number"
          min={0}
          max={30}
          inputMode="numeric"
          value={target}
          disabled={busy}
          onChange={(e) => setTarget(e.target.value)}
          onBlur={() => {
            const n = Math.floor(Number(target));
            if (Number.isFinite(n) && n >= 0 && n <= 30 && n !== deal.daily_target_posts) void onPatch({ dailyTargetPosts: n });
            else setTarget(String(deal.daily_target_posts));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="tabular-nums"
        />
      </Field>
    </section>
  );
}

/** How a bank deposit finds this deal, and when the brand pays. */
function Payout({ view, onPatch, busy }: { view: DealView; onPatch: (f: Partial<DealInput>) => Promise<boolean>; busy: boolean }) {
  return (
    <section aria-label="Payout" className="flex flex-col gap-3 border-t border-rule pt-5">
      <SectionLabel strong>Payout matching</SectionLabel>
      <PayoutForm
        initial={payoutValuesOf(dealRowToInput(view.deal))}
        saving={busy}
        onSubmit={async (patch) => void (await onPatch(patch))}
      />
    </section>
  );
}

/** Deposits matched to this deal, and the open deposits that fit its rule. A match lowers Owed. */
function Payments({ view }: { view: DealView }) {
  const { raw, actions } = useUgc();
  const { busy, error, act } = useAct();
  const [all, setAll] = useState(false);
  const { deal, payments } = view;
  const rule = deal.payout_rule ?? {};
  const hasRule = Boolean(rule.payerContains) || rule.minCents !== undefined || rule.maxCents !== undefined;
  const open = raw.deposits
    .filter((d) => all || !hasRule || matchesPayoutRule(rule, { name: d.name, amountCents: Number(d.amount_cents) }))
    .sort((a, b) => b.posted_on.localeCompare(a.posted_on));
  return (
    <section aria-label="Payments" className="flex flex-col gap-3 border-t border-rule pt-5">
      <SectionLabel strong>Payments</SectionLabel>
      {payments.length === 0 ? (
        <p className="text-body text-ink-3">No deposits matched.</p>
      ) : (
        <div>
          {payments.map((p) => (
            <ListRow key={p.id} data-payment={p.transaction_id} className="flex-wrap gap-y-1">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{p.name ?? "Deposit"}</span>
                <span className="text-tag text-ink-3">{shortDay(p.paid_on)}</span>
              </span>
              <span className="tabular-nums">{usd(Number(p.amount_cents))}</span>
              <ConfirmDelete
                what="Unmatch this deposit"
                label="Unmatch"
                confirmLabel="Unmatch"
                busy={busy}
                onConfirm={async () => {
                  let activityId: string | null | undefined;
                  const res = await act(async () => {
                    const r = await actions.unmatchPayment({ transactionId: p.transaction_id });
                    if (r.ok) activityId = r.activityId;
                    return r;
                  });
                  if (res) offerUndo(activityId, `payment "${p.name ?? "Deposit"}"`);
                }}
              />
            </ListRow>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Label className="flex-1">{all || !hasRule ? "Open deposits" : "Open deposits that fit the rule"}</Label>
        {hasRule && (
          <Button variant="ghost" className="-my-1 h-7 px-2 text-tag" onClick={() => setAll((v) => !v)}>
            {all ? "Only matching" : "Show all"}
          </Button>
        )}
      </div>
      {open.length === 0 ? (
        <p className="text-body text-ink-3">No open deposits.</p>
      ) : (
        <div>
          {open.map((d) => (
            <ListRow key={d.id} data-deposit={d.id} className="flex-wrap gap-y-1">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{d.name}</span>
                <span className="text-tag text-ink-3">{shortDay(d.posted_on)}</span>
              </span>
              <span className="tabular-nums">{usd(Number(d.amount_cents))}</span>
              <Button
                disabled={busy}
                aria-label={`Match ${d.name} to ${deal.brand_name}`}
                onClick={() =>
                  void act(() => actions.matchPayment({ dealId: deal.id, transactionId: d.id, amountCents: Number(d.amount_cents), paidOn: d.posted_on }))
                }
              >
                Match
              </Button>
            </ListRow>
          ))}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
