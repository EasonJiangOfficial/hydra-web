import { Dashboard } from "@/components/dashboard/dashboard";
import { scopeFrom } from "@/components/dashboard/derive";
import { loadLayouts, resetLayout, saveLayout } from "@/lib/layout/actions";
import { loadDashboard } from "./load";

export const metadata = { title: "Dashboard" };

/** Explicit props, not the generated PageProps: the pre-push hook runs plain tsc, which sees stale route types. */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The Dashboard. The loading.tsx beside it is the Suspense boundary while the data and the saved layouts load. */
export default async function DashboardPage(props: { searchParams: SearchParams }) {
  const q = await props.searchParams;
  const scope = scopeFrom(typeof q.scope === "string" ? q.scope : null);
  const [data, layouts] = await Promise.all([loadDashboard(scope), loadLayouts()]);
  return <Dashboard data={data} initial={layouts} persistence={{ save: saveLayout, reset: resetLayout }} />;
}
