"use client";

import { SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, Input, Seg, cn } from "@/components/kit";
import { DatePicker } from "@/components/ui/date-picker";

import { AccountSelect, CategorySelect, EntitySelect } from "./pickers";
import { useTx } from "./store";

/** The review switch, the search box and the filters. Every choice lives in the URL. */
export function TransactionFilters() {
  const { params, setParams, lookups, reviewCount, total, loading, filters } = useTx();
  const [q, setQ] = useState(params.q);
  const [open, setOpen] = useState(false);

  // Follow the URL (Clear, a link); search the URL 250 ms after the last key.
  const [seen, setSeen] = useState(params.q);
  if (seen !== params.q) {
    setSeen(params.q);
    setQ(params.q);
  }
  useEffect(() => {
    if (q === params.q) return;
    const t = window.setTimeout(() => setParams({ q: q.trim() ? q : null }), 250);
    return () => window.clearTimeout(t);
  }, [q, params.q, setParams]);

  const active = Boolean(params.q || params.account || params.entity || params.category || params.from || params.to);

  const controls = (
    <>
      <AccountSelect
        aria-label="Account"
        lookups={lookups}
        value={params.account || null}
        onChange={(id) => setParams({ account: id })}
        placeholder="All accounts"
        className="w-[170px] max-md:w-full"
      />
      <EntitySelect
        aria-label="Business"
        lookups={lookups}
        value={params.entity || null}
        onChange={(id) => setParams({ entity: id })}
        placeholder="All businesses"
        className="w-[170px] max-md:w-full"
      />
      <CategorySelect
        aria-label="Category"
        lookups={lookups}
        value={params.category || null}
        onChange={(id) => setParams({ category: id })}
        placeholder="All categories"
        className="w-[200px] max-md:w-full"
      />
      <DatePicker aria-label="From date" placeholder="From" rangeEnd={params.to || null} className="w-[150px] max-md:w-full" value={params.from} max={params.to || undefined} onChange={(e) => setParams({ from: e.target.value || null })} />
      <DatePicker aria-label="To date" placeholder="To" rangeStart={params.from || null} className="w-[150px] max-md:w-full" value={params.to} min={params.from || undefined} onChange={(e) => setParams({ to: e.target.value || null })} />
    </>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Seg
          aria-label="Which transactions"
          value={params.hidden ? "hidden" : params.review ? "review" : "all"}
          onValueChange={(v) => setParams({ view: v === "all" ? null : v })}
          items={[
            { value: "all", label: "All" },
            { value: "review", label: <>Needs review <span className="tabular-nums">{reviewCount}</span></> },
            { value: "hidden", label: "Hidden" },
          ]}
        />
        <Input
          aria-label="Search transactions"
          type="search"
          placeholder="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-[260px] min-w-[120px] flex-1 max-md:max-w-none [&::-webkit-search-cancel-button]:appearance-none"
        />
        <Button
          variant="outline"
          className="md:hidden"
          aria-expanded={open}
          aria-controls="tx-filters"
          onClick={() => setOpen((o) => !o)}
        >
          <SlidersHorizontal strokeWidth={1.5} /> Filters
        </Button>
        <div
          id="tx-filters"
          className={cn("items-center gap-3 max-md:order-last max-md:w-full max-md:grid-cols-2", open ? "grid" : "hidden", "md:flex md:flex-wrap")}
        >
          {controls}
          {active && (
            <Button variant="ghost" onClick={() => setParams({ q: null, account: null, entity: null, category: null, from: null, to: null })}>
              Clear
            </Button>
          )}
        </div>
        <span aria-live="polite" className="ml-auto text-label text-ink-3 tabular-nums max-md:hidden" data-testid="tx-count">
          {loading && !total ? "" : `${total.toLocaleString("en-US")} ${filters.review ? "to review" : filters.hidden ? "hidden" : "transactions"}`}
        </span>
      </div>
    </div>
  );
}
