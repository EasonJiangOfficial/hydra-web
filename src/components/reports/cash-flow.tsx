"use client";

import { Bar, Bars, Card, InfoDot, Label, ListRow, Money, Sankey, Seg, formatMoney } from "@/components/kit";
import { sankeyData } from "@/lib/reports/queries";
import { ChartHits, type HitTarget } from "./chart-hits";
import { destinationColor, nodeCategoryKey, percent, type ReportsData } from "./model";

export type ChartKind = "sankey" | "bars";
export const parseChart = (v: string | null | undefined): ChartKind => (v === "bars" ? "bars" : "sankey");

/** Cash flow tab: the Sankey (income side ink and gray, destinations in color) or the same figures as bars. */
export function CashFlowCard({
  data,
  chart,
  onChart,
  onOpen,
}: {
  data: ReportsData;
  chart: ChartKind;
  onChart: (c: ChartKind) => void;
  /** Opens the category panel for a category key. */
  onOpen: (key: string) => void;
}) {
  const { flow, spending } = data;
  // Everything into Income, refunds and drawn included, so the destination shares add up to 100% (RM-02).
  const hub = flow.hubCents;
  const share = (cents: number) => (hub > 0 ? percent(cents / hub) : "0.0%");
  const label = (id: string) => flow.nodes.find((n) => n.id === id)?.label ?? id;
  const keyOf = (id: string) => nodeCategoryKey(id, spending);
  const count = (n: number) => `${n} ${n === 1 ? "transaction" : "transactions"}`;

  // Destinations carry their own color when the owner set one; the income side stays ink and gray.
  const colorOf = (id: string, name: string) => destinationColor(id, name, spending.rows.find((r) => r.categoryId === keyOf(id))?.color);
  const base = sankeyData(flow);
  const nodes = base.nodes.map((n, i) => {
    const node = flow.nodes[i]!;
    return node.column === 2 ? { ...n, color: colorOf(node.id, node.label) } : n;
  });

  const linkHit = (i: number) => {
    const l = flow.links[i];
    if (!l) return null;
    const key = keyOf(l.target) ?? (l.target === "income" ? keyOf(l.source) : null);
    return {
      lines: [`${label(l.source)} → ${label(l.target)}`, `${formatMoney(l.cents)} · ${share(l.cents)}`, ...(l.rowIds.length ? [count(l.rowIds.length)] : [])],
      open: key ? () => onOpen(key) : undefined,
    };
  };
  const nodeHit = (i: number) => {
    const n = flow.nodes[i];
    if (!n) return null;
    const rows = flow.links.filter((l) => (n.column === 2 ? l.target : l.source) === n.id).flatMap((l) => l.rowIds);
    const cents = n.column === 1 ? hub : n.cents;
    return {
      lines: [n.label, `${formatMoney(cents)} · ${share(cents)}`, ...(n.column === 1 ? [count(flow.rowIds.length)] : rows.length ? [count(rows.length)] : [])],
      open: keyOf(n.id) ? () => onOpen(keyOf(n.id)!) : undefined,
    };
  };
  const targets: HitTarget[] = [
    { selector: ".recharts-sankey-links > g", at: linkHit },
    { selector: ".recharts-sankey-nodes > g", at: nodeHit },
  ];

  // The destinations as bars: every place the money went, largest first.
  const dest = flow.nodes.filter((n) => n.column === 2).sort((a, b) => b.cents - a.cents);
  const barTargets: HitTarget[] = [
    {
      selector: ".recharts-bar-rectangle",
      at: (i) => {
        const n = dest[i];
        if (!n) return null;
        const rows = flow.links.filter((l) => l.target === n.id).flatMap((l) => l.rowIds);
        return {
          lines: [n.label, `${formatMoney(n.cents)} · ${share(n.cents)}`, ...(rows.length ? [count(rows.length)] : [])],
          open: keyOf(n.id) ? () => onOpen(keyOf(n.id)!) : undefined,
        };
      },
    },
  ];

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <Label>Cash flow</Label>
        <InfoDot>
          Hover a band to see its amount, share and count. Click a band or a category to open the transactions behind it. Taxes set aside is the money Hydra tells you to hold for the IRS.
        </InfoDot>
        <div className="flex-1" />
        <Seg
          aria-label="Chart type"
          items={[
            { value: "sankey", label: "Sankey" },
            { value: "bars", label: "Bars" },
          ]}
          value={chart}
          onValueChange={(v) => onChart(parseChart(v))}
          className="max-md:hidden"
        />
      </div>
      {flow.links.length === 0 ? (
        <p className="py-16 text-center text-label text-ink-3">Nothing came in or went out this month</p>
      ) : (
        <>
        {/* Phone: where the money went as rows, so no amount hides behind a sideways scroll. */}
        <div className="md:hidden" data-testid="cash-flow-list">
          {dest.map((n) => {
            const key = keyOf(n.id);
            const color = colorOf(n.id, n.label);
            const row = (
              <>
                <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="truncate">{n.label}</span>
                  <Bar value={hub > 0 ? n.cents / hub : 0} aria-label={`${n.label} share of income`} />
                </span>
                <span className="flex shrink-0 flex-col items-end text-right">
                  <Money cents={n.cents} whole className="tabular-nums" />
                  <span className="text-tag text-ink-3 tabular-nums">{share(n.cents)}</span>
                </span>
              </>
            );
            return key ? (
              <ListRow key={n.id} as="button" type="button" onClick={() => onOpen(key)} aria-label={`Open ${n.label}`}>
                {row}
              </ListRow>
            ) : (
              <ListRow key={n.id}>{row}</ListRow>
            );
          })}
        </div>
        <div className="-mx-1 overflow-x-auto px-1 pb-1 max-md:hidden" data-testid="cash-flow-chart" data-row-ids={flow.rowIds.join(" ")}>
          {chart === "sankey" ? (
            <ChartHits targets={targets} className="min-w-[720px]">
              <Sankey nodes={nodes} links={base.links} height={440} label="Cash flow: income sources into income, then savings, taxes and expense categories" />
            </ChartHits>
          ) : (
            <ChartHits targets={barTargets} className="min-w-[560px]">
              <Bars
                data={dest.map((n) => ({ label: n.label, values: [n.cents] }))}
                series={["Amount"]}
                money={{ whole: true }}
                height={380}
                label="Where the money went, by destination"
              />
            </ChartHits>
          )}
        </div>
        </>
      )}
      {/* The phone list already has a button per category. */}
      <ul className="sr-only max-md:hidden">
        {flow.nodes
          .filter((n) => n.column !== 1 && keyOf(n.id))
          .map((n) => (
            <li key={n.id}>
              <button type="button" onClick={() => onOpen(keyOf(n.id)!)}>
                Open {n.label} transactions
              </button>
            </li>
          ))}
      </ul>
    </Card>
  );
}
