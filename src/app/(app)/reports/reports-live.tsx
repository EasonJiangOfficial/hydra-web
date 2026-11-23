"use client";

import { useRouter } from "next/navigation";
import { ReportsView } from "@/components/reports/reports-view";
import type { ReportsActions, ReportsData } from "@/components/reports/model";
import { deleteCategory, mapCategoryTaxLine, mergeCategories, updateCategory } from "@/lib/rules/actions";
import { loadCategoryPanel } from "./actions";

const actions: ReportsActions = {
  loadCategory: loadCategoryPanel,
  rename: ({ id, name }) => updateCategory({ id, name }),
  setColor: ({ id, color }) => updateCategory({ id, color }),
  mapTaxLine: (m) => mapCategoryTaxLine(m),
  merge: (m) => mergeCategories(m),
  remove: (m) => deleteCategory(m),
};

/** The Reports page on the database: edits go through the typed rule actions, then the figures reload. */
export function ReportsLive({ data }: { data: ReportsData }) {
  const router = useRouter();
  return <ReportsView data={data} actions={actions} onChanged={() => router.refresh()} exportBase="/reports/export" />;
}
