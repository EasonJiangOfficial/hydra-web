"use client";

import { Button } from "@/components/kit";

import { describeActions, describeConditions } from "./describe";
import { useTx } from "./store";

/**
 * One ink bar at the bottom of the screen. After a manual category change it offers a rule ("Make a
 * rule?"); otherwise it carries a short message (saved, refused, how many rows changed).
 */
export function NoticeBar() {
  const s = useTx();
  const { offer, notice, lookups } = s;
  if (!offer && !notice) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={offer ? "rule-offer" : "notice"}
      className="fixed bottom-20 left-1/2 z-[60] flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-ink px-4 py-3 text-label text-white motion-safe:animate-hy-fade md:bottom-6"
    >
      {offer ? (
        <>
          <span className="min-w-0 flex-1 max-md:basis-full">
            <span className="block">Make a rule for “{offer.name}”?</span>
            <span className="block text-ink-on-dark-3 md:truncate">
              When {describeConditions(offer.suggestion.conditions, lookups)}, then {describeActions(offer.suggestion.actions, lookups)}
            </span>
          </span>
          <Button
            variant="ghost"
            className="text-white hover:bg-white/12 max-md:ml-auto"
            onClick={() => s.setOffer(null)}
          >
            Not now
          </Button>
          <Button
            variant="outline"
            className="border-white/40 text-white hover:bg-white/12"
            onClick={() => {
              s.openRuleEditor({ kind: "new", seed: offer.suggestion });
              s.setOffer(null);
            }}
          >
            Make rule
          </Button>
        </>
      ) : (
        <span>{notice}</span>
      )}
    </div>
  );
}
