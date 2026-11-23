"use client";

import { startTransition, useEffect, useState } from "react";

import { Button, Card, FadeIn, Skeleton, SkeletonCard, SkeletonRows, SkeletonStrip, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/kit";
import { PageHeader } from "@/components/shell/page-header";

import { DayPanel } from "./day-panel";
import { DealPicker } from "./deal-picker";
import { DealPanel, DealsTab } from "./deals";
import { Overview } from "./overview";
import { parsePeriod, periodParams, type PeriodRange } from "./period";
import { useUgc } from "./store";
import { useQueryParam } from "./url";
import { Videos } from "./videos";
import { DealWizard } from "./wizard";

const TABS = ["overview", "videos", "deals"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = { overview: "Overview", videos: "Videos", deals: "Deals" };
const toTab = (v: string | null): Tab => TABS.find((t) => t === v) ?? "overview";

/** The UGC Tracker page body. Needs a Suspense boundary above it (it reads the URL). */
export function UgcWorkspace() {
  const { model } = useUgc();
  const [tabParam, setTabParam] = useQueryParam("tab");
  const [flow, setFlow] = useQueryParam("flow");
  const [, setDay] = useQueryParam("day");
  const [periodParam, setPeriodParam] = useQueryParam("period");
  const [fromParam] = useQueryParam("from");
  const [toParam] = useQueryParam("to");
  const [dealId, setDealId] = useState<string | null>(null);
  // The pressed tab is local state, so its trigger and skeleton paint in the same frame as the press; the URL
  // follows (replaceState) and a URL change from elsewhere (a new deal opens Deals) still moves it.
  const urlTab = toTab(tabParam);
  const [tab, setTab] = useState<Tab>(urlTab);
  const [seenUrlTab, setSeenUrlTab] = useState(urlTab);
  if (urlTab !== seenUrlTab) {
    setSeenUrlTab(urlTab);
    setTab(urlTab);
  }
  // A tab's first press paints its skeleton; its real panel renders after that frame, as a transition. Once
  // rendered a panel stays mounted and only hides, so going back to it (or leaving a heavy one) costs no render.
  const [rendered, setRendered] = useState<readonly Tab[]>([tab]);
  const ready = rendered.includes(tab);
  useEffect(() => {
    if (ready) return;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => startTransition(() => setRendered((r) => (r.includes(tab) ? r : [...r, tab]))));
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [tab, ready]);
  const range = parsePeriod({ period: periodParam, from: fromParam, to: toParam }, model.today);
  const setRange = (r: PeriodRange) => {
    const { period, ...rest } = periodParams(r);
    setPeriodParam(period, rest);
  };
  const mode = flow === "new" || flow === "existing" ? flow : null;
  const filter = model.deals.some((d) => d.deal.id === dealId) ? dealId : null;

  if (mode) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="UGC Tracker" />
        <DealWizard
          mode={mode}
          onExit={() => setFlow(null)}
          onCreated={(id, logoFailed) => setFlow(null, { tab: "deals", deal: id, logofail: logoFailed ? id : null })}
        />
      </div>
    );
  }

  const panel = (t: Tab) => {
    if (t === "deals") return <DealsTab onNew={() => setFlow("new")} onExisting={() => setFlow("existing")} />;
    if (model.deals.length === 0) return <NoDeals />;
    return t === "overview" ? <Overview dealId={filter} range={range} onRange={setRange} /> : <Videos dealId={filter} />;
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="UGC Tracker" />
      <div className="flex flex-wrap items-center gap-2">
        {tab !== "deals" && model.deals.length > 0 && (
          <DealPicker
            aria-label="Deal"
            deals={model.deals}
            value={filter}
            onChange={setDealId}
            allLabel="All deals"
            menus
            className="w-full sm:w-[220px]"
          />
        )}
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2 max-sm:justify-start">
          <Button onClick={() => setDay(model.today, { add: "1" })} disabled={model.deals.length === 0}>
            Add video
          </Button>
          <Button onClick={() => setFlow("existing")}>Add existing</Button>
          <Button variant="primary" onClick={() => setFlow("new")}>
            New deal
          </Button>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => {
          const next = toTab(v);
          setTab(next);
          setSeenUrlTab(next);
          setTabParam(next === "overview" ? null : next);
        }}
      >
        <TabsList aria-label="UGC Tracker">
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {LABEL[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((t) => (
          <TabsContent key={t} value={t} forceMount={rendered.includes(t) || undefined} className="data-[state=inactive]:hidden">
            {rendered.includes(t) ? <FadeIn>{panel(t)}</FadeIn> : <TabSkeleton tab={t} />}
          </TabsContent>
        ))}
      </Tabs>

      <DayPanel />
      <DealPanel />
    </div>
  );
}

/** What a tab looks like while it renders: the same skeleton blocks as the page's loading state. */
function TabSkeleton({ tab }: { tab: Tab }) {
  return (
    <div role="status" aria-label={`Loading ${LABEL[tab]}`} data-tab-skeleton={tab} className="flex flex-col gap-5">
      {tab === "overview" ? (
        <>
          <SkeletonStrip cells={4} />
          <div className="grid gap-5 lg:grid-cols-12">
            <SkeletonCard rows={6} className="lg:col-span-7" />
            <SkeletonCard rows={4} className="lg:col-span-5" />
          </div>
        </>
      ) : tab === "videos" ? (
        <div className="flex flex-col gap-3 rounded-xl border border-rule p-6 max-md:p-4">
          <Skeleton className="h-[17px] w-40 rounded-sm" />
          <SkeletonRows n={8} />
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </div>
      )}
      <span className="sr-only">Loading</span>
    </div>
  );
}

function NoDeals() {
  return (
    <Card>
      <p className="text-body text-ink-3">No deals yet. Add a deal to see earnings.</p>
    </Card>
  );
}
