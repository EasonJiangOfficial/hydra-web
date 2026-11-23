"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { loadReport } from "@/components/reports/load-report";
import { parseMonth, type ReportsData } from "@/components/reports/model";
import { ReportsView } from "@/components/reports/reports-view";
import { parseScope } from "@/components/shell/scope";
import { FIRST_MONTH, fixtureActions, fixtureClient, fixtureDb, type FxDb } from "./fixture-db";

/** A tiny external store for the in-memory books: edits in the panel replace `db`, and the figures reload. */
function createStore() {
  const listeners = new Set<() => void>();
  const store = {
    db: fixtureDb(),
    version: 0,
    set(db: FxDb) {
      store.db = db;
      store.version++;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
  return store;
}

/** The Reports page on in-memory data. Edits work and show; a reload starts over. */
export function ReportsFixture() {
  const params = useSearchParams();
  const scope = parseScope(params.get("scope"));
  const month = parseMonth(params.get("month"), FIRST_MONTH);
  const [store] = useState(createStore);
  const version = useSyncExternalStore(store.subscribe, () => store.version, () => 0);
  const [data, setData] = useState<ReportsData | null>(null);

  useEffect(() => {
    let live = true;
    void loadReport(fixtureClient(() => store.db), scope, month).then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [store, scope, month, version]);

  const actions = useMemo(() => fixtureActions(store, () => month, () => scope), [store, month, scope]);
  if (!data) return null;
  return <ReportsView data={data} actions={actions} onChanged={() => {}} exportBase="/dev/reports/export" />;
}
