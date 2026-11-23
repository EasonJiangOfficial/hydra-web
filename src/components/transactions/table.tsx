"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { HoverCard, Money, Pill, SkeletonRows, cn, drawerHref, setDrawerUrl } from "@/components/kit";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorDot } from "@/components/ui/color-picker";
import { categoryColor as labelColorOf } from "@/lib/label-colors";

import { categoryName, categoryReason, dateLabel, entityName, visibleWindow } from "./describe";
import { CategorySelect } from "./pickers";
import { useTx } from "./store";
import type { TxRow } from "./types";

const PHONE = "(max-width: 767px)";
const onPhone = (cb: () => void) => {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const usePhone = () =>
  useSyncExternalStore(
    onPhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );

const ROW_H = 48;
const ROW_H_PHONE = 64;
const HEAD_H = 36;
const COLS = "grid-cols-[28px_76px_minmax(0,1fr)_minmax(0,170px)_100px] lg:grid-cols-[28px_92px_minmax(0,1fr)_minmax(0,220px)_120px_110px]";
const COLS_PHONE = "grid-cols-[28px_minmax(0,1fr)_auto]";

/**
 * The transaction table. Only the rows in view are in the page (a fixed row height, a window of
 * rows around the scroll position), so 5,000 rows scroll as smoothly as 50. More rows load from the
 * server as the end comes near.
 * ponytail: the table scrolls inside its own box; page-level scroll would need the window's offset.
 */
export function TransactionsTable() {
  const s = useTx();
  const phone = usePhone();
  const rowH = phone ? ROW_H_PHONE : ROW_H;
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 640 });
  const pathname = usePathname();
  const search = useSearchParams();
  const openId = search.get("tx");

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setView((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A new view starts at the top.
  const filterKey = JSON.stringify(s.filters);
  useEffect(() => {
    if (box.current) box.current.scrollTop = 0; // the scroll event updates the window
  }, [filterKey]);

  const { first, last } = visibleWindow(view.top, view.height, rowH, s.rows.length);
  const { loadMore, rows, total } = s;
  useEffect(() => {
    if (last >= rows.length - 40 && rows.length < total) loadMore();
  }, [last, rows.length, total, loadMore]);

  const open = (id: string) => setDrawerUrl(drawerHref(pathname, search, "tx", id), true);

  const allSelected = rows.length > 0 && rows.every((r) => s.selected.has(r.id));
  const someSelected = !allSelected && rows.some((r) => s.selected.has(r.id));

  const empty = !s.loading && rows.length === 0;

  return (
    <div
      ref={box}
      role="table"
      aria-label="Transactions"
      aria-rowcount={total + 1}
      aria-busy={s.loading}
      data-testid="tx-table"
      data-filters={filterKey}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setView((v) => (Math.floor(v.top / rowH) === Math.floor(top / rowH) ? v : { ...v, top }));
      }}
      className="relative h-[calc(100dvh-300px)] min-h-[360px] overflow-y-auto rounded-xl border border-rule bg-surface max-md:h-[calc(100dvh-380px)]"
    >
      <div
        role="row"
        className={cn(
          "sticky top-0 z-10 grid items-center gap-3 border-b border-rule bg-surface px-4 text-label text-ink-3 max-md:hidden",
          COLS,
        )}
        style={{ height: HEAD_H }}
      >
        <span role="columnheader" className="grid place-items-center">
          <Checkbox
            aria-label="Select all loaded transactions"
            checked={allSelected}
            indeterminate={someSelected}
            onChange={() => s.setSelected(allSelected ? [] : rows.map((r) => r.id))}
          />
        </span>
        <span role="columnheader">Date</span>
        <span role="columnheader">Name</span>
        <span role="columnheader">Category</span>
        <span role="columnheader" className="max-lg:hidden">
          Business
        </span>
        <span role="columnheader" className="text-right">
          Amount
        </span>
      </div>

      {s.loading && rows.length === 0 && <SkeletonRows n={12} className="px-4 pt-2" />}
      {empty && (
        <p role="status" className="px-4 py-12 text-center text-label text-ink-3">
          {s.error ?? "Nothing here"}
        </p>
      )}

      <div role="rowgroup" className={cn("relative transition-opacity duration-200", s.loading && rows.length > 0 && "opacity-60")} style={{ height: rows.length * rowH }}>
        {rows.slice(first, last).map((row, k) => (
          <Row key={row.id} row={row} index={first + k} rowH={rowH} phone={phone} active={openId === row.id} open={open} />
        ))}
      </div>
    </div>
  );
}

function Row({ row, index, rowH, phone, active, open }: { row: TxRow; index: number; rowH: number; phone: boolean; active: boolean; open: (id: string) => void }) {
  const s = useTx();
  const { lookups } = s;
  const checked = s.selected.has(row.id);
  const category = row.is_transfer ? "Transfer" : categoryName(lookups, row.category_id);
  const reason = categoryReason(row, s.rules, lookups);
  const categoryColor = labelColorOf(lookups.categories, row.category_id);
  const review = s.params.review;

  const categoryCell = review && !row.category_id ? (
    <CategorySelect
      aria-label={`Category for ${row.name}`}
      lookups={lookups}
      entityId={row.entity_id}
      value={null}
      onChange={(id) => id && void s.categorize(row.id, id)}
      placeholder="Pick a category"
      className="w-full"
      onClick={(e) => e.stopPropagation()}
    />
  ) : (
    <HoverCard content={row.is_transfer ? "A transfer or card payment between your own accounts. Left out of income and spending." : reason.text} side="top" align="start" className="w-[240px]">
      <span className="inline-flex max-w-full items-center gap-1.5 truncate align-middle">
        {row.is_transfer ? null : <ColorDot color={categoryColor} />}
        <Pill tone={category ? "soft" : "default"} className="max-w-full truncate text-label font-normal">
          {category ?? "Uncategorized"}
        </Pill>
      </span>
    </HoverCard>
  );

  const nameBtn = (
    <button
      type="button"
      className="min-w-0 truncate text-left text-body text-ink outline-none focus-visible:underline"
      aria-label={`Open ${row.name}`}
      onClick={(e) => {
        e.stopPropagation();
        open(row.id);
      }}
    >
      {row.name}
      {row.pending && <span className="ml-2 text-tag text-ink-3">Pending</span>}
    </button>
  );

  const check = (
    <Checkbox
      aria-label={`Select ${row.name}`}
      checked={checked}
      onClick={(e) => e.stopPropagation()}
      onChange={() => s.toggleSelected(row.id)}
    />
  );

  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={checked || undefined}
      data-tx-id={row.id}
      data-active={active || undefined}
      onClick={() => open(row.id)}
      className={cn(
        "absolute inset-x-0 top-0 grid cursor-pointer items-center gap-3 border-b border-rule px-4 transition-colors duration-200 hover:bg-tint",
        phone ? COLS_PHONE : COLS,
        (active || checked) && "bg-tint",
      )}
      style={{ height: rowH, transform: `translateY(${index * rowH}px)` }}
    >
      {phone ? (
        <>
          <span role="cell" className="grid place-items-center">
            {check}
          </span>
          <span role="cell" className="flex min-w-0 flex-col gap-0.5">
            {nameBtn}
            <span className="flex min-w-0 items-center gap-1.5 text-label text-ink-3">
              <span className="shrink-0">{dateLabel(row.posted_on)}</span>
              <span aria-hidden>·</span>
              {row.is_transfer ? null : <ColorDot color={categoryColor} className="size-1.5" />}
              <span className="min-w-0 flex-1 truncate">{review && !row.category_id ? "Uncategorized" : (category ?? "Uncategorized")}</span>
            </span>
          </span>
          <span role="cell" className="text-right text-body tabular-nums">
            <Money cents={row.amount_cents} signed />
          </span>
        </>
      ) : (
        <>
          <span role="cell" className="grid place-items-center">
            {check}
          </span>
          <span role="cell" className="text-label text-ink-3 tabular-nums">
            {dateLabel(row.posted_on)}
          </span>
          <span role="cell" className="flex min-w-0 items-center">
            {nameBtn}
          </span>
          <span role="cell" className="min-w-0">
            {categoryCell}
          </span>
          <span role="cell" className="truncate text-label text-ink-3 max-lg:hidden">
            {entityName(lookups, row.entity_id)}
          </span>
          <span role="cell" className="text-right text-body tabular-nums">
            <Money cents={row.amount_cents} signed />
          </span>
        </>
      )}
    </div>
  );
}

