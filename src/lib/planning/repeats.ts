import type { SupabaseClient } from "@supabase/supabase-js";

import { shiftAlertForCopy } from "./alerts";
import { addDays, todayIn } from "./dates";
import { dueRepeatDates, repeatRuleSchema } from "./repeat";

interface SeriesRow {
  series_id: string;
  latest_id: string;
  latest_period: string;
  rule: string;
  anchor_day: number | null;
  since: string | null;
}

export interface RepeatRun {
  /** Series looked at. */
  readonly series: number;
  /** Copies made. */
  readonly created: number;
  /** The new copies' ids (the cron puts each on Google). */
  readonly ids: readonly string[];
  /** Series whose copy failed this run (logged; the others still run and their copies still push). */
  readonly failed: readonly string[];
}

/**
 * The cron side of repeating tasks: make the copies that are due. Pass a SERVICE-ROLE client
 * (planning_repeat_series and planning_repeat_copy are service-role only). Safe to run twice and
 * to overlap: a copy is keyed on (series, period), so a second run makes nothing new.
 *
 * `aheadDays` (default 1) makes tomorrow's copy today, so a reminder set for 09:00 exists before
 * its day starts. A copy keeps the source's alert as the same wall clock time, the same number of
 * days from its due date. `cap` bounds copies per series per run (a long gap never floods).
 */
export async function extendRepeatSeries(
  db: SupabaseClient,
  now: Date,
  timeZone: string,
  { aheadDays = 1, cap = 10 }: { aheadDays?: number; cap?: number } = {},
): Promise<RepeatRun> {
  const through = addDays(todayIn(now, timeZone), aheadDays);
  const { data, error } = await db.rpc("planning_repeat_series");
  if (error) throw new Error(error.message);
  const series = (data ?? []) as SeriesRow[];
  if (series.length === 0) return { series: 0, created: 0, ids: [], failed: [] };

  const latest = await db
    .from("planning_tasks")
    .select("id, due_date, alert_at")
    .in("id", series.map((s) => s.latest_id));
  if (latest.error) throw new Error(latest.error.message);
  const byId = new Map((latest.data ?? []).map((t) => [t.id as string, t as { due_date: string | null; alert_at: string | null }]));

  const ids: string[] = [];
  const failed: string[] = [];
  for (const s of series) {
    const rule = repeatRuleSchema.safeParse(s.rule);
    if (!rule.success) continue;
    const anchor = s.anchor_day ?? Number(s.latest_period.slice(8, 10));
    const src = byId.get(s.latest_id);
    // Per series: a failed copy must not drop the ids already made (a made copy is never returned
    // again, so it would never reach Google) nor skip the series after it.
    try {
      for (const due of dueRepeatDates(s.latest_period, rule.data, anchor, through, cap, s.since ?? "")) {
        const alertAt =
          src?.alert_at && src.due_date ? shiftAlertForCopy(src.alert_at, src.due_date, due, timeZone) : null;
        const copied = await db.rpc("planning_repeat_copy", { p_from: s.latest_id, p_due: due, p_alert_at: alertAt });
        if (copied.error) throw new Error(copied.error.message);
        if (copied.data) ids.push(copied.data as string);
      }
    } catch (e) {
      console.error("[planning] repeat copy failed", s.series_id, e instanceof Error ? e.message : e);
      failed.push(s.series_id);
    }
  }
  return { series: series.length, created: ids.length, ids, failed };
}
