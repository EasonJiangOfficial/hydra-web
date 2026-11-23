"use client";

import Link from "next/link";
import { DashboardGrid, defineRegistry, type DashboardGridProps } from "@/components/grid";
import { Label, buttonVariants, cn } from "@/components/kit";
import { ScopeSwitch, useScopePending } from "@/components/shell/scope";
import type { Breakpoint, Fit } from "@/lib/layout/model";
import { showsUgc } from "@/lib/entities/model";
import { DASHBOARD_BLOCKS } from "@/lib/layout/blocks";
import { AccountsCard, ComingUpCard, GoalsCard, MonthCard, NetWorthCard, PostingCard, RecentCard, SummaryCard, UgcCard, recentWideRows } from "./cards";
import { DashboardProvider } from "./context";
import { IncomeExpensesCard, legendRows, quietFlow } from "./flow-card";
import { longDate } from "./derive";
import type { DashboardData } from "./types";

/** The blocks of `DASHBOARD_BLOCKS`, each with its card. */
export const dashboardRegistry = defineRegistry(DASHBOARD_BLOCKS, {
  "net-worth": NetWorthCard,
  "income-expenses": IncomeExpensesCard,
  summary: SummaryCard,
  accounts: AccountsCard,
  month: MonthCard,
  ugc: UgcCard,
  posting: PostingCard,
  recent: RecentCard,
  goals: GoalsCard,
  "coming-up": ComingUpCard,
});

/** Phone rows for a block `px` tall: a block of h rows is 68h - 12 px (blocks.ts). */
const phoneRows = (px: number) => Math.ceil((px + 12) / 68);
/** Desktop rows for a block `px` tall: 62h - 20 px. */
const deskRows = (px: number) => Math.ceil((px + 20) / 62);
/** A list card's height: 2 px border, the pads (24 px desktop, 16 phone), the 17 px label, 6 px gap, 40 px rows. */
const listPx = (rows: number, bp: Breakpoint) => (bp === "desktop" ? 48 : 32) + 25 + 40 * rows;
/** Grid rows for a list card of `n` 40 px rows: the fewest that hold it, so the card ends at its last row. */
const listRows = (n: number, bp: Breakpoint) => (bp === "phone" ? phoneRows : deskRows)(listPx(n, bp));
/**
 * A list card fits its rows at their own height (`even`: a side-by-side list card in the same row evens up to it,
 * and a height the owner set in Edit wins). An empty list keeps its small one-line height and never evens up.
 */
const listFit = (n: number, bp: Breakpoint): Fit => (n > 0 ? { h: listRows(n, bp), even: true, list: true } : { h: listRows(1, bp), list: true });

/**
 * What the scope's data asks of each block (DESIGN.md 7: a block with nothing to show goes, it leaves no gap).
 * UGC blocks only apply to All and UGC. A scope with no accounts of its own shows net worth as one row and drops
 * the account cards; a scope with no money in a year shows the income strip alone.
 */
export function fitFor(data: DashboardData) {
  const scoped = data.scope !== "all";
  const noAccounts = scoped && !data.hasAccounts;
  // With no accounts Cash and Cards are only $0: the tiles keep UGC alone (one compact row), or go.
  const ugcTile = showsUgc(data.scope) && data.ugc !== null;
  return (id: string, bp: Breakpoint): Fit => {
    switch (id) {
      case "ugc":
      case "posting":
        return data.ugc ? undefined : false;
      case "net-worth":
        return noAccounts ? { w: bp === "desktop" ? 12 : 2, h: 1 } : undefined;
      case "accounts":
        return noAccounts ? false : undefined;
      case "summary":
        // Outside UGC the third tile is Income, which the income strip already shows.
        if (data.hasAccounts) return undefined;
        return ugcTile ? { h: 1 } : false;
      case "month":
        return noAccounts && data.month.incomeCents === 0 && data.month.spendingCents === 0 ? false : undefined;
      case "recent":
        if (scoped && data.recent.length === 0) return false;
        // Beside UGC revenue and Posting (not lists) on the desktop, Recent keeps the row's height so the row stays whole.
        if (bp === "desktop" && data.ugc) return undefined;
        // With the UGC blocks gone Recent spans the board in two columns; on the phone it is one list.
        // ponytail: assumes Recent sits in its default row; one the owner moved beside another block keeps two columns.
        return listFit(bp === "desktop" && !data.ugc ? recentWideRows(data.recent.length) : data.recent.length, bp);
      case "goals":
        return listFit(data.goals.length, bp);
      case "coming-up":
        return listFit(data.comingUp.length, bp);
      case "income-expenses": {
        if (quietFlow(data)) return { h: bp === "desktop" ? 3 : 2 };
        if (bp === "desktop") return undefined;
        // Phone: the strip and a 160 px chart (274 px), then the 132 px donut and 32 px legend rows (16 px gaps).
        const rows = legendRows(data);
        return { h: phoneRows(274 + (rows > 0 ? 164 + 32 * rows : 0)) };
      }
    }
  };
}

/**
 * The Dashboard (DESIGN.md section 6 item 1): the editable grid with the date on the left of the top
 * bar and the scope switch, Add account and Edit on the right. On the phone the scope switch lives in
 * the shell header and Edit sits beside it (the header's `phone-header-slot`), so the bar row shows only
 * while editing (Add block, Reset, Done); Add account is an empty-state link there.
 */
export function Dashboard({
  data,
  initial,
  persistence,
}: { data: DashboardData } & Pick<DashboardGridProps, "initial" | "persistence">) {
  // The switch's transition: the board dims while the new scope loads, as Reports does for its month.
  const busy = useScopePending();
  return (
    <DashboardProvider value={data}>
      <h1 className="sr-only">Dashboard</h1>
      <DashboardGrid
        registry={dashboardRegistry}
        initial={initial}
        persistence={persistence}
        phoneEditSlot="phone-header-slot"
        fit={fitFor(data)}
        reloading={busy}
        lead={
          <Label as="time" className="max-md:hidden">
            {longDate(data.today)}
          </Label>
        }
        trail={
          <>
            <div className="max-md:hidden">
              <ScopeSwitch />
            </div>
            <Link href="/accounts" className={cn(buttonVariants({ variant: "ghost" }), "max-md:hidden")} data-testid="add-account">
              Add account
            </Link>
          </>
        }
      />
    </DashboardProvider>
  );
}
