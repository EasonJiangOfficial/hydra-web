/**
 * View snapshot write rules (replaces Ripple lib/analytics/view-snapshots.ts).
 *
 * Ripple appended a snapshot per sync and skipped an unchanged count under
 * 20 h old. Hydra keeps ONE snapshot per post per owner-zone day (a unique
 * index; a second reading that day replaces the first), so that throttle is
 * gone. What stays is the guard Grokbot's page reads need (DESIGN.md section 8):
 *   - a count lower than the last trusted one is rejected unless forced;
 *   - a jump over VIEW_JUMP_HOLD_MULTIPLE x the last trusted count is stored
 *     but held for review, so it is not paid until the owner forces it;
 *   - a reading captured after the freeze window is rejected (it would never count).
 */
import { freezeCutoff } from "@/lib/ugc/view-freeze";

/** A new count above this multiple of the last trusted count is held for review. */
export const VIEW_JUMP_HOLD_MULTIPLE = 10;
/** Jumps from a smaller last count are normal early growth, never held. */
export const VIEW_JUMP_HOLD_MIN_PREVIOUS = 1_000;

export type SnapshotDecision =
  | { kind: "write"; held: false }
  | { kind: "hold"; held: true; previous: number }
  | { kind: "reject_lower"; previous: number }
  | { kind: "reject_frozen"; cutoff: string };

export function decideViewSnapshot(args: {
  /** Latest trusted (not held) reading captured at or before `capturedAt`, if any. */
  previous: { views: number } | null;
  views: number;
  capturedAt: Date;
  postedAt: Date;
  freezeDays: number | null;
  force?: boolean;
}): SnapshotDecision {
  const cutoff = freezeCutoff(args.postedAt, args.freezeDays);
  if (args.capturedAt.getTime() > cutoff.getTime()) {
    return { kind: "reject_frozen", cutoff: cutoff.toISOString() };
  }
  if (args.force || !args.previous) return { kind: "write", held: false };
  const previous = args.previous.views;
  if (args.views < previous) return { kind: "reject_lower", previous };
  if (previous >= VIEW_JUMP_HOLD_MIN_PREVIOUS && args.views > previous * VIEW_JUMP_HOLD_MULTIPLE) {
    return { kind: "hold", held: true, previous };
  }
  return { kind: "write", held: false };
}
