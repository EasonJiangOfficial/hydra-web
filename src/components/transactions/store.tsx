"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { createContext, use, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";

import { setDrawerUrl } from "@/components/kit/drawer";
import { useScope } from "@/components/shell/scope";
import { NO_ENTITY_ID } from "@/lib/entities/model";
import type { Action, Condition } from "@/lib/rules/model";

import { categoryFamily, matchesFilters } from "./describe";
import { PAGE_SIZE, type Lookups, type RowFilters, type StoredRule, type TxApi, type TxRow } from "./types";

/** What the rule editor starts from: a new rule (maybe seeded), or an existing one. */
export type RuleEditorTarget = { kind: "new"; seed?: { conditions: Condition[]; actions: Action[] } } | { kind: "edit"; rule: StoredRule };

export interface Offer {
  /** The row's name, for the bar's text. */
  name: string;
  suggestion: { conditions: Condition[]; actions: Action[] };
}

export type Tab = "transactions" | "rules";

export interface TxStore {
  api: TxApi;
  /** The owner's today, YYYY-MM-DD. */
  today: string;
  lookups: Lookups;
  /** Change the pickers' data in place (a tax line map, a recurring series' status). */
  updateLookups(fn: (l: Lookups) => Lookups): void;
  tab: Tab;
  /** Search params that make up the view. */
  params: { q: string; account: string; entity: string; category: string; from: string; to: string; review: boolean; hidden: boolean };
  setParams(next: Partial<Record<"q" | "account" | "entity" | "category" | "from" | "to" | "view" | "tab", string | null>>): void;
  filters: RowFilters;
  rows: TxRow[];
  total: number;
  loading: boolean;
  error: string | null;
  loadMore(): void;
  reload(): void;
  reviewCount: number;
  rowFor(id: string): TxRow | undefined;
  /** Load a row that is not in the list (a deep link to `?tx=`). */
  ensureRow(id: string): Promise<void>;
  patchRow(id: string, patch: Partial<TxRow>): void;
  /** Set a category by hand, show it at once, offer a rule when one would help. */
  categorize(id: string, categoryId: string | null): Promise<boolean>;
  /** Edit rename, note, hidden or business. Shows at once; a refusal puts it back and says why. */
  edit(id: string, input: { name?: string; note?: string | null; hidden?: boolean; entityId?: string }): Promise<boolean>;
  rules: StoredRule[];
  setRules(next: StoredRule[] | ((prev: StoredRule[]) => StoredRule[])): void;
  selected: ReadonlySet<string>;
  toggleSelected(id: string): void;
  setSelected(ids: Iterable<string>): void;
  clearSelected(): void;
  ruleEditor: RuleEditorTarget | null;
  openRuleEditor(target: RuleEditorTarget | null): void;
  offer: Offer | null;
  setOffer(next: Offer | null): void;
  notice: string | null;
  notify(text: string): void;
  refreshReviewCount(): void;
}

const Ctx = createContext<TxStore | null>(null);

export function useTx(): TxStore {
  const store = use(Ctx);
  if (!store) throw new Error("useTx outside TxProvider");
  return store;
}

const FIELD_ERROR = "Could not load transactions";

export function TxProvider({
  api,
  lookups: initialLookups,
  initialRules,
  initialReviewCount,
  today,
  children,
}: {
  api: TxApi;
  today: string;
  lookups: Lookups;
  initialRules: StoredRule[];
  initialReviewCount: number;
  children: ReactNode;
}) {
  const search = useSearchParams();
  const pathname = usePathname();
  const { scope } = useScope();
  const [lookups, updateLookups] = useReducer((l: Lookups, fn: (l: Lookups) => Lookups) => fn(l), initialLookups);

  const tab: Tab = search.get("tab") === "rules" ? "rules" : "transactions";
  const params = {
    q: search.get("q") ?? "",
    account: search.get("account") ?? "",
    entity: search.get("entity") ?? "",
    category: search.get("category") ?? "",
    from: search.get("from") ?? "",
    to: search.get("to") ?? "",
    review: search.get("view") === "review",
    hidden: search.get("view") === "hidden",
  };
  // The header's scope switch is a business filter too, unless a business is picked here.
  const scopeEntity = scope === "all" ? "" : (lookups.entities.find((e) => e.slug === scope)?.id ?? NO_ENTITY_ID);
  const entityId = params.entity || scopeEntity;

  const filters = useMemo<RowFilters>(
    () => ({
      q: params.q.trim() || undefined,
      accountId: params.account || undefined,
      entityId: entityId || undefined,
      categoryIds: params.category ? categoryFamily(lookups, params.category) : undefined,
      from: params.from || undefined,
      to: params.to || undefined,
      review: params.review || undefined,
      hidden: params.hidden || undefined,
    }),
    [params.q, params.account, entityId, params.category, params.from, params.to, params.review, params.hidden, lookups],
  );
  const filterKey = JSON.stringify(filters);

  const setParams = useCallback<TxStore["setParams"]>(
    (next) => {
      const q = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v) q.set(k, v);
        else q.delete(k);
      }
      const s = q.toString();
      setDrawerUrl(s ? `${pathname}?${s}` : pathname);
    },
    [search, pathname],
  );

  // --- rows: one page at a time from `offset`; a changed filter starts over ---------------------
  const [rows, setRows] = useState<TxRow[]>([]);
  const [total, setTotal] = useState(0);
  /** The view the rows on screen belong to; a different `viewKey` means a load is under way. */
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [extra, setExtra] = useState<Record<string, TxRow>>({});
  const generation = useRef(0);
  const fetching = useRef(false);
  /** Rows of the server's list already loaded (a row that leaves the list shortens it). */
  const offset = useRef(0);
  const filtersRef = useRef(filters);
  const rowsRef = useRef(rows);
  const extraRef = useRef(extra);
  useEffect(() => {
    filtersRef.current = filters;
    rowsRef.current = rows;
    extraRef.current = extra;
  });
  const viewKey = `${filterKey}#${version}`;
  const loading = loadedKey !== viewKey;

  useEffect(() => {
    const gen = ++generation.current;
    fetching.current = true;
    api.listRows(JSON.parse(filterKey) as RowFilters, 0).then(
      (page) => {
        if (gen !== generation.current) return;
        fetching.current = false;
        offset.current = page.rows.length;
        setRows(page.rows);
        setTotal(page.total);
        setError(null);
        setLoadedKey(viewKey);
      },
      () => {
        if (gen !== generation.current) return;
        fetching.current = false;
        setError(FIELD_ERROR);
        setLoadedKey(viewKey);
      },
    );
  }, [api, filterKey, viewKey]);

  const loadMore = useCallback(() => {
    if (fetching.current || offset.current >= total) return;
    const gen = generation.current;
    fetching.current = true;
    api.listRows(filtersRef.current, offset.current).then(
      (page) => {
        if (gen !== generation.current) return;
        fetching.current = false;
        offset.current += page.rows.length;
        setRows((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...page.rows.filter((r) => !seen.has(r.id))];
        });
        setTotal(page.total);
      },
      () => {
        if (gen === generation.current) {
          fetching.current = false;
          setError(FIELD_ERROR);
        }
      },
    );
  }, [api, total]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // --- review count ----------------------------------------------------------------------------
  const [reviewCount, setReviewCount] = useState(initialReviewCount);
  const refreshReviewCount = useCallback(() => {
    api.reviewCount(entityId || undefined).then(setReviewCount, () => {});
  }, [api, entityId]);
  const firstCount = useRef(true);
  useEffect(() => {
    // The first count came with the page, for all businesses; a scope or business pick changes it.
    if (firstCount.current && !entityId) {
      firstCount.current = false;
      return;
    }
    firstCount.current = false;
    refreshReviewCount();
  }, [entityId, refreshReviewCount]);

  // --- rows by id, edits ---------------------------------------------------------------------------
  const rowFor = useCallback((id: string) => rowsRef.current.find((r) => r.id === id) ?? extraRef.current[id], []);
  const rowForRender = (id: string) => rows.find((r) => r.id === id) ?? extra[id];

  const ensureRow = useCallback(
    async (id: string) => {
      // Keep the open row apart from the list: it stays when a filter or an edit drops it from the list.
      const known = rowFor(id) ?? (await api.getRow(id));
      if (known) setExtra((e) => (e[id] ? e : { ...e, [id]: known }));
    },
    [api, rowFor],
  );

  const patchRow = useCallback((id: string, patch: Partial<TxRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setExtra((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
  }, []);

  /** In the review queue a row leaves as soon as it has a category; hiding or unhiding moves a row between lists. */
  const dropIfGone = useCallback((id: string, next: TxRow, force = false) => {
    if (!(force || filtersRef.current.review) || matchesFilters(next, filtersRef.current)) return;
    setRows((prev) => prev.filter((r) => r.id !== id));
    setTotal((t) => Math.max(0, t - 1));
    offset.current = Math.max(0, offset.current - 1);
  }, []);

  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 5000);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const [offer, setOffer] = useState<Offer | null>(null);

  const categorize = useCallback<TxStore["categorize"]>(
    async (id, categoryId) => {
      const prev = rowFor(id);
      if (!prev) return false;
      const next = { ...prev, category_id: categoryId, category_source: "manual" as const };
      patchRow(id, { category_id: categoryId, category_source: "manual" });
      dropIfGone(id, next);
      const res = await api.setCategory({ transactionId: id, categoryId });
      if (!res.ok) {
        patchRow(id, { category_id: prev.category_id, category_source: prev.category_source });
        if (filtersRef.current.review) reload();
        notify(res.error.message);
        return false;
      }
      if (res.data.suggestion) setOffer({ name: prev.merchant?.trim() || prev.name, suggestion: res.data.suggestion });
      else setOffer(null);
      refreshReviewCount();
      return true;
    },
    [api, rowFor, patchRow, dropIfGone, reload, notify, refreshReviewCount],
  );

  const edit = useCallback<TxStore["edit"]>(
    async (id, input) => {
      const prev = rowFor(id);
      if (!prev) return false;
      const patch: Partial<TxRow> = {};
      if (input.name !== undefined) Object.assign(patch, { name: input.name, renamed: true });
      if (input.note !== undefined) patch.note = input.note || null;
      if (input.hidden !== undefined) patch.hidden = input.hidden;
      if (input.entityId !== undefined) patch.entity_id = input.entityId;
      const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, prev[k as keyof TxRow]])) as Partial<TxRow>;
      patchRow(id, patch);
      dropIfGone(id, { ...prev, ...patch }, input.hidden !== undefined);
      const res = await api.editTransaction({ transactionId: id, ...input });
      if (!res.ok) {
        patchRow(id, undo);
        if (input.hidden !== undefined) reload();
        notify(res.error.message);
        return false;
      }
      if (input.hidden !== undefined) refreshReviewCount();
      return true;
    },
    [api, rowFor, patchRow, dropIfGone, reload, notify, refreshReviewCount],
  );

  // --- rules, selection, rule editor -------------------------------------------------------------
  const [rules, setRules] = useState(initialRules);
  const [selected, setSelectedState] = useState<ReadonlySet<string>>(new Set());
  const toggleSelected = useCallback(
    (id: string) =>
      setSelectedState((s) => {
        const next = new Set(s);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const setSelected = useCallback((ids: Iterable<string>) => setSelectedState(new Set(ids)), []);
  const clearSelected = useCallback(() => setSelectedState(new Set()), []);
  // A new view starts with nothing selected.
  const [selectedFor, setSelectedFor] = useState(filterKey);
  if (selectedFor !== filterKey) {
    setSelectedFor(filterKey);
    setSelectedState(new Set());
  }
  const [ruleEditor, openRuleEditor] = useState<RuleEditorTarget | null>(null);

  const value: TxStore = {
    api,
    today,
    lookups,
    updateLookups,
    tab,
    params,
    setParams,
    filters,
    rows,
    total,
    loading,
    error,
    loadMore,
    reload,
    reviewCount,
    rowFor: rowForRender,
    ensureRow,
    patchRow,
    categorize,
    edit,
    rules,
    setRules,
    selected,
    toggleSelected,
    setSelected,
    clearSelected,
    ruleEditor,
    openRuleEditor,
    offer,
    setOffer,
    notice,
    notify,
    refreshReviewCount,
  };
  return <Ctx value={value}>{children}</Ctx>;
}

export { PAGE_SIZE };
