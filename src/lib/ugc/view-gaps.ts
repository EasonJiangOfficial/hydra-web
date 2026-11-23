/**
 * The missed-day warning (DESIGN.md section 8, Grokbot guards: "A missed day shows a warning on the
 * dashboard"). Rows come from public.ugc_missed_view_days. Pure and client-safe.
 */
export interface ViewGapDay {
  /** YYYY-MM-DD, owner zone. */
  day: string;
  /** Posts inside their freeze window that needed a reading all that day. */
  needing: number;
  /** How many of them got one. */
  read: number;
}

const short = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

/** "Views missing for 2 days" and one hover line per day, or null when nothing was missed. */
export function viewGapWarning(days: readonly ViewGapDay[]): { title: string; lines: string[] } | null {
  const gaps = days.filter((d) => d.read < d.needing).sort((a, b) => a.day.localeCompare(b.day));
  if (gaps.length === 0) return null;
  return {
    title: `Views missing for ${gaps.length} ${gaps.length === 1 ? "day" : "days"}`,
    lines: gaps.map((d) => `${short(d.day)}: ${d.read} of ${d.needing} ${d.needing === 1 ? "post" : "posts"} read`),
  };
}
