"use client";

import { CircleAlert } from "lucide-react";

import { InfoDot, cn } from "@/components/kit";
import { viewGapWarning, type ViewGapDay } from "@/lib/ugc/view-gaps";

/**
 * The missed-day warning: one line when Grokbot left open posts unread on a recent day, with each day in the
 * info dot. Ink, not red: no money is lost yet, but readings that come after a post's freeze window never count.
 */
export function ViewGapNotice({ days, className }: { days: readonly ViewGapDay[]; className?: string }) {
  const warning = viewGapWarning(days);
  if (!warning) return null;
  return (
    <div
      role="status"
      data-testid="view-gap"
      className={cn("flex min-w-0 items-center gap-2 rounded-lg border border-rule-2 bg-surface px-3 py-2 text-label text-ink", className)}
    >
      <CircleAlert aria-hidden strokeWidth={1.5} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{warning.title}</span>
      <InfoDot label="Missing views by day">{`${warning.lines.join("\n")}\nReadings after a video's view window do not count.`}</InfoDot>
    </div>
  );
}
