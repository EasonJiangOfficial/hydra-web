import { parseMonth, type ReportsData } from "@/components/reports/model";
import { parseScope } from "@/lib/entities/model";
import { ownerToday } from "@/lib/rules/engine";
import { createServerClient } from "@/lib/supabase/server";
import { loadReport } from "./load";
import { ReportsLive } from "./reports-live";

export const metadata = { title: "Reports" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** `?scope=` and `?month=YYYY-MM` pick the figures; `?tab=`, `?chart=` and `?category=` only change what shows. */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const db = await createServerClient();
  const today = await ownerToday(db);
  const scope = parseScope(first(q.scope));
  const month = parseMonth(first(q.month), today.slice(0, 7));
  const data: ReportsData = await loadReport(db, scope, month);
  return <ReportsLive data={data} />;
}
