"use client";

import { usePathname, useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";

import { InfoDot, Money, Pill, Seg, Stat, Strip, cn } from "@/components/kit";
import {
  isEntitySlug,
  netProfit,
  paidCents,
  rateText,
  setAsideCents,
  sumCents,
  yearChoices,
  type EntitySlug,
  type Payment,
  type TaxActions,
  type TaxDoc,
  type TaxesData,
} from "@/app/(app)/taxes/model";
import { formatMoney } from "@/components/kit/money";
import { DocumentsCard } from "./documents-card";
import { PaymentsCard } from "./payments-card";
import { ScheduleCard } from "./schedule-card";

export type TaxesWorkspaceProps = { data: TaxesData; actions: TaxActions };

/**
 * The Taxes page body (DESIGN.md section 6 item 6). The year and entity switch sit above and keep
 * their place while the URL changes; everything under them restarts for the new entity and year.
 */
export function TaxesWorkspace({ data, actions }: TaxesWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [view, setView] = useOptimistic({ entity: data.entity, year: data.year });

  const go = (next: { entity: EntitySlug; year: number }) =>
    start(() => {
      setView(next);
      const q = new URLSearchParams(window.location.search);
      q.set("entity", next.entity);
      q.set("year", String(next.year));
      q.delete("taxline");
      router.replace(`${pathname}?${q}`, { scroll: false });
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Seg
          aria-label="Tax year"
          items={yearChoices(data.today).map((y) => ({ value: String(y), label: String(y) }))}
          value={String(view.year)}
          onValueChange={(y) => go({ entity: view.entity, year: Number(y) })}
        />
        {/* More businesses than the phone is wide: the switch scrolls on its own, the page never does. */}
        <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
          <Seg
            aria-label="Entity"
            items={data.sections.map((e) => ({ value: e.slug, label: e.label }))}
            value={view.entity}
            onValueChange={(e) => isEntitySlug(e) && go({ entity: e, year: view.year })}
          />
        </div>
        {data.sections.find((e) => e.slug === view.entity)?.closed && <Pill>Closed, kept for history</Pill>}
        {data.treatment === "summary" && data.entity === view.entity && (
          <span className="flex items-center gap-1.5 text-label text-ink-3">
            Return not computed
            <InfoDot label="About this business type">
              Hydra works out Schedule C for sole proprietors and single-member LLCs. For an S corp, a partnership or another type it shows income and expenses only.
            </InfoDot>
          </span>
        )}
      </div>
      <div className={cn("transition-opacity duration-200", pending && "opacity-60")} aria-busy={pending}>
        <TaxesBody key={`${data.entity}-${data.year}`} data={data} actions={actions} />
      </div>
    </div>
  );
}

function TaxesBody({ data, actions }: TaxesWorkspaceProps) {
  const [rateBps, setRateBps] = useState(data.rateBps);
  const [payments, setPayments] = useState<Payment[]>(data.payments);
  const [documents, setDocuments] = useState<TaxDoc[]>(data.documents);

  const expenseCount = data.lines.reduce((a, l) => a + l.count, 0);
  const business = data.treatment !== "personal";

  if (data.treatment === "summary") {
    const net = netProfit(data.incomeCents, data.spendingCents);
    return (
      <div className="grid gap-4 md:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-4 md:col-span-8">
          <Strip cols={3} aria-label="Year totals">
            <Stat label="Business income" info={data.payers.length ? data.payers.slice(0, 8).map((p) => `${p.name}  ${formatMoney(p.cents)}`).join("\n") : "No income yet this year"}>
              <Money cents={data.incomeCents} />
            </Stat>
            <Stat label="Expenses" info="Every expense this year, in any category">
              <Money cents={data.spendingCents} />
            </Stat>
            <Stat label="Net" info="Income minus expenses">
              <Money cents={net} />
            </Stat>
          </Strip>
          {data.lines.length > 0 && <ScheduleCard data={data} actions={actions} />}
        </div>
        <div className="min-w-0 md:col-span-4">
          <DocumentsCard data={data} actions={actions} documents={documents} onDocuments={setDocuments} />
        </div>
      </div>
    );
  }

  const expenses = sumCents(data.lines);
  const net = netProfit(data.incomeCents, expenses);
  const setAside = setAsideCents(net, rateBps);

  return (
    <div className="grid gap-4 md:grid-cols-12">
      <div className="flex min-w-0 flex-col gap-4 md:col-span-8">
        <Strip cols={4} aria-label="Year totals">
          <Stat
            label={business ? "Business income" : "Income"}
            info={
              data.payers.length
                ? data.payers
                    .slice(0, 8)
                    .map((p) => `${p.name}  ${formatMoney(p.cents)}`)
                    .join("\n")
                : "No income yet this year"
            }
          >
            <Money cents={data.incomeCents} />
          </Stat>
          <Stat label="Deductible expenses" info={`${expenseCount} transactions on ${data.lines.length} Schedule C lines`}>
            <Money cents={expenses} />
          </Stat>
          <Stat label="Net profit" info="Income minus deductible expenses">
            <Money cents={net} />
          </Stat>
          <Stat
            label={`Set aside at ${rateText(rateBps)}`}
            info={
              `Net profit ${formatMoney(net)} x ${rateText(rateBps)} = ${formatMoney(setAside)}\n` +
              `Paid so far ${formatMoney(paidCents(payments))}\n\n` +
              "An estimate from the rate you type. Hydra does not file taxes and is not a tax adviser."
            }
          >
            <Money cents={setAside} />
          </Stat>
        </Strip>
        <PaymentsCard
          data={data}
          actions={actions}
          rateBps={rateBps}
          onRate={setRateBps}
          payments={payments}
          onPayments={setPayments}
          setAside={setAside}
        />
        <ScheduleCard data={data} actions={actions} />
      </div>
      <div className="min-w-0 md:col-span-4">
        <DocumentsCard data={data} actions={actions} documents={documents} onDocuments={setDocuments} />
      </div>
    </div>
  );
}
