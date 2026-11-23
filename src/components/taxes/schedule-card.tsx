"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { shortDate, sumCents, type LineTx, type TaxActions, type TaxesData, type TaxLineRow } from "@/app/(app)/taxes/model";
import {
  Card,
  DetailDrawer,
  Label,
  ListRow,
  Money,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/kit";

/** Schedule C Part II lines that have money on them. A row opens that line's panel (`?taxline=<tax line id>`). */
export function ScheduleCard({ data, actions }: { data: TaxesData; actions: TaxActions }) {
  const pathname = usePathname();
  const href = (line: TaxLineRow) => `${pathname}?entity=${data.entity}&year=${data.year}&taxline=${line.id}`;
  return (
    <Card aria-label="Schedule C expenses">
      <Label>Schedule C expenses</Label>
      {data.lines.length === 0 ? (
        <p className="py-6 text-center text-body text-ink-3">No expenses on a tax line in {data.year}</p>
      ) : (
        <Table>
          <TableHeader>
            <tr>
              <TableHead className="w-14">Line</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="max-md:hidden">From categories</TableHead>
              <TableHead numeric className="max-md:hidden">
                Transactions
              </TableHead>
              <TableHead numeric>Amount</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {data.lines.map((l) => (
              <TableRow key={l.id} clickable className="relative">
                <TableCell className="text-ink-3 tabular-nums">{l.code}</TableCell>
                <TableCell className="font-medium">
                  <Link
                    href={href(l)}
                    scroll={false}
                    aria-label={`Line ${l.code}, ${l.name}`}
                    className="outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ink"
                  >
                    {l.name}
                  </Link>
                </TableCell>
                <TableCell className="text-ink-3 max-md:hidden">{l.categories.join(", ")}</TableCell>
                <TableCell numeric className="max-md:hidden">
                  {l.count}
                </TableCell>
                <TableCell numeric>
                  <Money cents={l.cents} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <tr>
              <TableCell className="border-b-0" />
              <TableCell className="border-b-0">Total</TableCell>
              <TableCell className="border-b-0 max-md:hidden" />
              <TableCell numeric className="border-b-0 max-md:hidden">
                {data.lines.reduce((a, l) => a + l.count, 0)}
              </TableCell>
              <TableCell numeric className="border-b-0">
                <Money cents={sumCents(data.lines)} />
              </TableCell>
            </tr>
          </TableFooter>
        </Table>
      )}
      <DetailDrawer param="taxline" label="Schedule C line">
        {(id) => <LinePanel key={id} data={data} actions={actions} lineId={id} />}
      </DetailDrawer>
    </Card>
  );
}

type Loaded = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; rows: LineTx[]; truncated: boolean };

function LinePanel({ data, actions, lineId }: { data: TaxesData; actions: TaxActions; lineId: string }) {
  const line = data.lines.find((l) => l.id === lineId);
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const known = line !== undefined;

  useEffect(() => {
    let live = true;
    if (known) {
      actions.lineTransactions({ entity: data.entity, year: data.year, taxLineId: lineId }).then((r) => {
        if (live) setState(r.ok ? { status: "ready", ...r.data } : { status: "error", message: r.error.message });
      });
    }
    return () => {
      live = false;
    };
  }, [actions, data.entity, data.year, lineId, known]);

  if (!line) return <p className="text-body text-ink-3">That line has no expenses in {data.year}</p>;
  return (
    <div className="flex min-h-0 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-title text-ink">
          Line {line.code}, {line.name}
        </h2>
        <div className="flex items-baseline gap-2">
          <span className="text-figure-s tabular-nums">
            <Money cents={line.cents} />
          </span>
          <Label>
            {line.count} {line.count === 1 ? "transaction" : "transactions"}
          </Label>
        </div>
      </div>
      {line.categories.length > 0 && (
        <div className="flex flex-col gap-1">
          <Label>From categories</Label>
          <p className="text-body text-ink">{line.categories.join(", ")}</p>
        </div>
      )}
      <div className="flex flex-col">
        <Label className="pb-1">Transactions</Label>
        {state.status === "loading" && <SkeletonRows n={5} />}
        {state.status === "error" && (
          <p role="alert" className="py-2 text-body text-ink">
            {state.message}
          </p>
        )}
        {state.status === "ready" && (
          <>
            <ul>
              {state.rows.map((t) => (
                <li key={t.id}>
                  <ListRow>
                    <span className="w-14 shrink-0 text-ink-3 tabular-nums">{shortDate(t.postedOn)}</span>
                    <span className="min-w-0 flex-1 truncate">{t.payer}</span>
                    <Money cents={t.cents} />
                  </ListRow>
                </li>
              ))}
            </ul>
            {state.truncated && <Label className="pt-2">Showing the newest {state.rows.length}</Label>}
          </>
        )}
      </div>
    </div>
  );
}
