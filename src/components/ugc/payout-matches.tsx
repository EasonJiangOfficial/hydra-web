"use client";

import { useMemo, useState } from "react";

import { offerUndo } from "@/components/activity/undo-bar";
import { Button, Card, InfoDot, ListRow, Money } from "@/components/kit";
import type { WithActivity } from "@/lib/activity/request";
import { ruleText, title } from "@/lib/ugc/payout-match";
import type { ActionResult } from "@/lib/ugc/schemas";

import { ConfirmDelete, ErrorText, SectionLabel, useAct } from "./controls";
import { payoutMatchesFor, shortDay } from "./model";
import { useUgc } from "./store";

const FIRST = 5;

/**
 * "Match payouts": open deposits that look like a deal's payout (owed per pay cycle, payer history,
 * learned rules). Confirm matches through matchPayment, so Paid and Owed update. "Not this" and rule
 * answers show an Undo line; kept rules stay listed with Remove, which asks first and offers the app's
 * Undo bar (this card's line on in-memory fixtures, which log no activity). Hidden when empty.
 */
export function PayoutMatches({ dealId }: { dealId: string | null }) {
  const { model, raw, actions } = useUgc();
  const { busy, error, act } = useAct();
  const [all, setAll] = useState(false);
  const [undo, setUndo] = useState<{ text: string; run: () => Promise<ActionResult<unknown>> } | null>(null);
  const { suggestions, ruleOffers } = useMemo(() => payoutMatchesFor(model, raw, dealId), [model, raw, dealId]);
  const kept = useMemo(() => {
    const brand = new Map(model.deals.map((d) => [d.deal.id, d.deal.brand_name]));
    return raw.payoutRules
      .filter((r) => r.decision === "accepted" && brand.has(r.deal_id) && (!dealId || r.deal_id === dealId))
      .map((r) => ({
        dealId: r.deal_id,
        payerKey: r.payer_key,
        dayOfMonth: r.day_of_month,
        text: ruleText(title(r.payer_key), r.day_of_month, brand.get(r.deal_id)!),
      }));
  }, [model, raw, dealId]);
  if (suggestions.length === 0 && ruleOffers.length === 0 && kept.length === 0 && !undo) return null;
  const shown = all ? suggestions : suggestions.slice(0, FIRST);
  /** Run a write; on success, offer its inverse as the Undo line. */
  const answer = async (write: () => Promise<ActionResult<unknown>>, next: { text: string; run: () => Promise<ActionResult<unknown>> } | null) => {
    setUndo(null);
    if ((await act(write)) !== undefined) setUndo(next);
  };
  /** A delete: the app's Undo bar for its activity; with no activity logged (fixtures), `local` as the Undo line. */
  const remove = async (write: () => Promise<WithActivity<ActionResult<unknown>>>, thing: string, local: NonNullable<typeof undo>) => {
    setUndo(null);
    let activityId: string | null | undefined;
    const done = await act(async () => {
      const r = await write();
      if (r.ok) activityId = r.activityId;
      return r;
    });
    if (done === undefined) return;
    if (activityId) offerUndo(activityId, thing);
    else setUndo(local);
  };

  return (
    <Card aria-label="Match payouts">
      <SectionLabel
        strong
        aside={
          <InfoDot>
            {"Deposits that fit what a deal is owed for a closed pay cycle (within 5%), landed after it closed. Payers you confirmed before count more. Confirm adds the deposit to Paid."}
          </InfoDot>
        }
      >
        Match payouts
      </SectionLabel>

      {shown.length > 0 && (
        <div>
          {shown.map((s) => (
            <ListRow key={s.transactionId} data-payout-match={s.transactionId} data-deal={s.dealId} data-amount={s.amountCents} className="flex-wrap gap-y-1">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{s.depositName}</span>
                <span className="text-tag text-ink-3">{`${shortDay(s.postedOn)} · ${s.brandName}`}</span>
              </span>
              <span className="flex items-center gap-2">
                <InfoDot label={`Why ${s.brandName}`}>{s.reasons.join("\n")}</InfoDot>
                <span className="tabular-nums">
                  <Money cents={s.amountCents} />
                </span>
              </span>
              <span className="flex gap-1.5 max-sm:w-full max-sm:justify-end">
                <Button
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Not ${s.brandName}: ${s.depositName}`}
                  onClick={() => {
                    const pair = { dealId: s.dealId, transactionId: s.transactionId };
                    void answer(() => actions.rejectPayoutMatch(pair), {
                      text: `Not ${s.brandName}: ${s.depositName}`,
                      run: () => actions.undoRejectPayoutMatch(pair),
                    });
                  }}
                >
                  Not this
                </Button>
                <Button
                  disabled={busy}
                  aria-label={`Confirm ${s.depositName} pays ${s.brandName}`}
                  onClick={() =>
                    void answer(
                      () => actions.matchPayment({ dealId: s.dealId, transactionId: s.transactionId, amountCents: s.amountCents, paidOn: s.postedOn }),
                      null,
                    )
                  }
                >
                  Confirm
                </Button>
              </span>
            </ListRow>
          ))}
          {suggestions.length > FIRST && (
            <Button variant="ghost" className="mt-1 h-7 px-2 text-tag text-ink-3" onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${suggestions.length}`}
            </Button>
          )}
        </div>
      )}

      {(ruleOffers.length > 0 || kept.length > 0) && (
        <div className={shown.length > 0 ? "border-t border-rule pt-3" : undefined}>
          {kept.map((k) => (
            <ListRow key={`kept:${k.dealId}:${k.payerKey}`} data-kept-rule={k.payerKey} data-deal={k.dealId} className="flex-wrap gap-y-1">
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate">{k.text}</span>
                <InfoDot label="About this rule">{"A rule you kept. It suggests this payer's deposits while the deal is owed, even when the amount does not fit."}</InfoDot>
              </span>
              <span className="flex max-sm:w-full max-sm:justify-end">
                <ConfirmDelete
                  what="Remove this rule"
                  label="Remove"
                  confirmLabel="Remove"
                  ariaLabel={`Remove rule: ${k.text}`}
                  busy={busy}
                  onConfirm={() =>
                    remove(() => actions.removePayoutRule({ dealId: k.dealId, payerKey: k.payerKey }), `payout rule "${k.text}"`, {
                      text: `Removed: ${k.text}`,
                      run: () => actions.decidePayoutRule({ dealId: k.dealId, payerKey: k.payerKey, dayOfMonth: k.dayOfMonth, decision: "accepted" }),
                    })
                  }
                />
              </span>
            </ListRow>
          ))}
          {ruleOffers.map((o) => (
            <ListRow key={`${o.dealId}:${o.payerKey}`} data-rule-offer={o.payerKey} className="flex-wrap gap-y-1">
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate">{o.text}</span>
                <InfoDot label="Why this rule">{`Learned from ${o.confirmations} deposits you matched to ${o.brandName}. Kept rules suggest this payer's deposits even when the amount does not fit.`}</InfoDot>
              </span>
              <span className="flex gap-1.5 max-sm:w-full max-sm:justify-end">
                <Button
                  variant="ghost"
                  disabled={busy}
                  aria-label={`No rule: ${o.text}`}
                  onClick={() =>
                    void answer(() => actions.decidePayoutRule({ dealId: o.dealId, payerKey: o.payerKey, dayOfMonth: o.dayOfMonth, decision: "declined" }), {
                      text: `Turned down: ${o.text}`,
                      run: () => actions.removePayoutRule({ dealId: o.dealId, payerKey: o.payerKey }),
                    })
                  }
                >
                  Not this
                </Button>
                <Button
                  disabled={busy}
                  aria-label={`Use rule: ${o.text}`}
                  onClick={() =>
                    void answer(() => actions.decidePayoutRule({ dealId: o.dealId, payerKey: o.payerKey, dayOfMonth: o.dayOfMonth, decision: "accepted" }), {
                      text: `Kept: ${o.text}`,
                      run: () => actions.removePayoutRule({ dealId: o.dealId, payerKey: o.payerKey }),
                    })
                  }
                >
                  Use rule
                </Button>
              </span>
            </ListRow>
          ))}
        </div>
      )}
      {undo && (
        <div role="status" data-payout-undo className="mt-2 flex items-center gap-3 border-t border-rule pt-2 text-tag text-ink-3">
          <span className="min-w-0 flex-1 truncate">{undo.text}</span>
          <Button variant="ghost" className="h-7 px-2" disabled={busy} onClick={() => void answer(undo.run, null)}>
            Undo
          </Button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
