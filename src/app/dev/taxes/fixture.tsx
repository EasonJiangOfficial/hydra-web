"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { SEEDED_SECTIONS, yearChoices } from "@/app/(app)/taxes/model";
import { TaxesWorkspace } from "@/components/taxes/taxes-workspace";
import { ADDED_SECTIONS, TODAY } from "./fixtures";
import { createMemoryActions } from "./memory-actions";

/**
 * The Taxes workspace on in-memory data. `?entity=` and `?year=` pick the data, as on the real page.
 * `?added=on`: two businesses added in Settings (a sole proprietor and a partnership) join the switch.
 */
export function TaxesFixture() {
  const params = useSearchParams();
  const sections = params.get("added") === "on" ? ADDED_SECTIONS : SEEDED_SECTIONS;
  const [memory] = useState(() => createMemoryActions(sections));
  const entity = params.get("entity") ?? "";
  const year = Number(params.get("year"));
  const y = yearChoices(TODAY).includes(year) ? year : Number(TODAY.slice(0, 4));
  const data = useMemo(() => memory.snapshot(entity, y), [memory, entity, y]);
  return <TaxesWorkspace data={data} actions={memory.actions} />;
}
