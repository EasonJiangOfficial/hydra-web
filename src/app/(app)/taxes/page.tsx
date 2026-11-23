import { LiveTaxes } from "@/components/taxes/live";
import { PageHeader } from "@/components/shell/page-header";
import { ownerToday } from "@/lib/rules/engine";
import { createServerClient } from "@/lib/supabase/server";
import { loadTaxes, parseParams } from "./data";

export const metadata = { title: "Taxes" };

/** Taxes (DESIGN.md section 6 item 6): `?entity=ugc|personal|ugm` and `?year=2026`; the Schedule C panel is `?category=`. */
export default async function TaxesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams; // first: it makes the page dynamic before anything reads env or cookies
  const db = await createServerClient();
  const today = await ownerToday(db);
  const { entity, year } = parseParams(params, today);
  const data = await loadTaxes(db, entity, year, today);
  return (
    <>
      <PageHeader title="Taxes" />
      <LiveTaxes data={data} />
    </>
  );
}
