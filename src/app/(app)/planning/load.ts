import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { listAccounts } from "@/lib/bank/queries";
import { goalWindow } from "@/lib/planning/metrics";
import { todayIn } from "@/lib/planning/dates";
import type { PlanningSnapshot } from "@/lib/planning/types";
import { NO_FINANCE, type FinanceFacts } from "@/lib/planning-metrics/finance-dates";
import { createLiveSource } from "@/lib/planning-metrics/live-source";
import { metricCacheKey, REMOTE_KEYS } from "@/lib/planning-metrics/remote";
import { createResolvers } from "@/lib/planning-metrics/resolvers";
import { listDeals } from "@/lib/ugc/queries";

/**
 * Card due dates and deal pay cycles, read once. The calendar works out any month from these.
 * A read that fails leaves the finance dates off the calendar; the rest of Planning still works.
 */
export async function loadFinanceFacts(db: SupabaseClient, now: Date): Promise<FinanceFacts> {
  try {
    const [accounts, { deals }] = await Promise.all([listAccounts(db), listDeals({ now })]);
    return {
      cards: accounts
        .filter((a) => a.kind === "card")
        .map((a) => ({
          id: a.id,
          name: `${a.nickname ?? a.name}${a.mask ? ` ${a.mask}` : ""}`,
          dueOn: a.statement_due_effective_on,
          balanceCents: a.statement_balance_effective_cents,
        })),
      deals: deals.map(({ deal, owedCents }) => ({
        id: deal.id,
        brand: deal.brand_name,
        status: deal.status,
        startDate: deal.start_date,
        endDate: deal.end_date,
        payCycle: deal.pay_cycle,
        anchorDay: deal.pay_cycle_anchor_day,
        anchorWeekday: deal.pay_cycle_anchor_weekday,
        anchorDays: deal.pay_cycle_anchor_days ?? [],
        owedCents,
      })),
    };
  } catch (error) {
    console.error("planning: finance dates unavailable", error);
    return NO_FINANCE;
  }
}

/**
 * The goal bars' first readings, made on the server so the page paints with live numbers. Keyed like the
 * remote registry's cache. A reading that fails is left out; the browser asks for it again.
 */
export async function seedMetrics(db: SupabaseClient, snapshot: PlanningSnapshot, now: Date): Promise<Record<string, number | null>> {
  const today = todayIn(now, snapshot.timeZone);
  const resolvers = createResolvers(createLiveSource(db, now));
  const reads = snapshot.goals.flatMap((goal) =>
    goal.metrics.flatMap((m) => {
      const resolver = (REMOTE_KEYS as readonly string[]).includes(m.metric) ? resolvers[m.metric as keyof typeof resolvers] : undefined;
      if (!resolver) return [];
      const window = goalWindow(goal, today, snapshot.timeZone);
      const key = metricCacheKey({ key: m.metric, param: m.param, window, today, timeZone: snapshot.timeZone });
      return [
        Promise.resolve(resolver(m.param, { goalId: goal.id, window, today, timeZone: snapshot.timeZone, tasks: [], statuses: [] })).then(
          (value): readonly [string, number | null] | null => [key, value],
          () => null,
        ),
      ];
    }),
  );
  const done = await Promise.all(reads);
  return Object.fromEntries(done.filter((r): r is readonly [string, number | null] => r !== null));
}
