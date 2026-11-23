import type { Metadata } from "next";
import { HydraMark, Wordmark } from "@/components/shell/nav";
import Link from "next/link";
import { Plus } from "lucide-react";
import {
  Bar,
  Bars,
  Button,
  Card,
  DayCell,
  DayLegend,
  Donut,
  HoverCard,
  InfoDot,
  Input,
  Label,
  ListRow,
  Money,
  Pill,
  Sankey,
  Seg,
  SkeletonCard,
  SkeletonChart,
  SkeletonHero,
  SkeletonPanel,
  SkeletonRows,
  SkeletonStrip,
  Sparkline,
  Stat,
  Strip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TrendLine,
} from "@/components/kit";
import { MotionNumberDemo, TabsDrawerDemo, TaskDrawerDemo } from "./demos";
import * as fx from "./fixtures";

export const metadata: Metadata = { title: "Kit" };

/** Full figure from 768 px up, compact on the phone (Mobile.dc.html). */
function Fig({ cents, loss }: { cents: number; loss?: boolean }) {
  const tone = loss ? "loss" : "default";
  return (
    <>
      <Money cents={cents} whole tone={tone} className="max-md:hidden" />
      <Money cents={cents} compact tone={tone} className="md:hidden" />
    </>
  );
}

function CardHead({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <Label className="flex-1">{children}</Label>
      {aside}
    </div>
  );
}

export default function KitPage() {
  const ugcTotal = fx.ugc.filter((r) => !r.loss && r.name !== "Projected, 30 days").reduce((a, r) => a + r.cents, 0);
  return (
    <main className="mx-auto flex max-w-[1440px] flex-col gap-5 px-4 pt-5 pb-16 md:px-10 md:pt-6">
      {/* Dashboard, composed like Main.dc.html */}
      <div className="flex min-h-10 items-center gap-2">
        <Label className="max-md:hidden">Saturday, November 21</Label>
        <span className="flex items-center gap-2 md:hidden">
          <HydraMark />
          <Wordmark />
        </span>
        <div className="flex-1" />
        <Seg aria-label="Scope" items={fx.scopes} defaultValue="all" className="max-md:hidden" />
        <Seg aria-label="Scope" items={fx.scopesShort} defaultValue="all" size="touch" className="md:hidden" />
        <Button variant="ghost" className="max-md:hidden">
          Add account
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-12 md:gap-5">
        <Card tone="hero" className="gap-3 overflow-hidden px-8 pt-8 pb-0 max-md:px-5 max-md:pt-5 max-md:pb-0 md:col-span-8">
          <div className="flex items-start gap-3">
            <div className="flex flex-col gap-2 md:gap-3">
              <Label>Net worth</Label>
              <span data-testid="hero-figure" className="text-hero max-md:text-[52px]">
                <Money cents={fx.netWorth.cents} dimCents className="max-md:hidden" />
                <Money cents={fx.netWorth.cents} whole className="md:hidden" />
              </span>
              <span className="flex items-center gap-2.5">
                <Money cents={fx.netWorth.change} signed className="max-md:hidden" />
                <Money cents={fx.netWorth.change} signed whole className="md:hidden" />
                <Label>{fx.netWorth.pct} this month</Label>
              </span>
            </div>
            <div className="flex-1" />
            <Seg tone="dark" aria-label="Range" items={fx.ranges} defaultValue="1m" className="max-md:hidden" />
          </div>
          <div className="-mx-5 mt-auto h-[70px] md:-mx-8 md:h-[120px]">
            <TrendLine tone="hero" data={fx.trend} height="100%" label="Net worth trend" />
          </div>
        </Card>

        <Card className="gap-5 md:col-span-4">
          <div className="flex flex-col gap-1.5">
            <CardHead>Cash</CardHead>
            <span className="text-figure-s">
              <Fig cents={fx.cash.total} />
            </span>
            <div className="border-t border-rule">
              {fx.cash.rows.map((r) => (
                <ListRow key={r.name}>
                  <span className="flex-1 text-ink-2">{r.name}</span>
                  <Money cents={r.cents} />
                </ListRow>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <CardHead aside={<Pill tone="strong">{fx.cards.due}</Pill>}>Credit cards</CardHead>
            <span className="text-figure-s">
              <Fig cents={fx.cards.total} />
            </span>
            <div className="border-t border-rule">
              {fx.cards.rows.map((r) => (
                <HoverCard key={r.name} content={`${r.name}\nStatement balance ${"$"}1,280.00\nDue Nov 27 · 16% of limit`}>
                  <ListRow as="button" type="button">
                    <span className="flex-1 text-ink-2">{r.name}</span>
                    <Money cents={r.cents} />
                  </ListRow>
                </HoverCard>
              ))}
            </div>
          </div>
        </Card>

        <Strip cols={4} className="md:col-span-12">
          {fx.month.map((m) => (
            <Stat
              key={m.label}
              label={m.label}
              info={m.info}
              aside={
                m.pill ? <Pill tone="loss">{m.pill}</Pill> : m.unit ? <Label>{m.unit}</Label> : undefined
              }
            >
              <Fig cents={m.cents} />
            </Stat>
          ))}
        </Strip>

        <Card className="gap-1.5 md:col-span-4">
          <CardHead>UGC revenue</CardHead>
          <span className="text-figure-s">
            <Fig cents={ugcTotal} />
          </span>
          <div className="border-t border-rule">
            {fx.ugc.map((r) => (
              <ListRow key={r.name}>
                <span className="flex-1 text-ink-2">{r.name}</span>
                <Money cents={r.cents} whole tone={r.loss ? "loss" : "default"} />
              </ListRow>
            ))}
          </div>
        </Card>

        <Card className="md:col-span-4">
          <CardHead
            aside={
              <>
                <Pill tone="soft">Streak 5</Pill>
                <Pill tone="loss">-$420</Pill>
              </>
            }
          >
            Posting
          </CardHead>
          <div className="grid grid-cols-7 gap-1.5" data-testid="posting-calendar">
            {fx.days.map((d) => (
              <DayCell key={d.day} {...d} />
            ))}
          </div>
          <DayLegend />
        </Card>

        <Card className="gap-1.5 md:col-span-4">
          <CardHead>Recent</CardHead>
          <div>
            {fx.recent.map((t) => (
              <ListRow key={t.name}>
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <Pill>{t.cat}</Pill>
                <Money cents={t.cents} signed className="w-[84px] text-right" />
              </ListRow>
            ))}
          </div>
        </Card>

        <Card className="gap-1.5 md:col-span-6">
          <CardHead>Goals</CardHead>
          <div>
            {fx.goals.map((g) => (
              <ListRow key={g.name}>
                <span className="w-[42%] shrink-0 truncate md:w-[230px]">{g.name}</span>
                <HoverCard content={g.info}>
                  <div className="flex-1 py-2">
                    <Bar value={g.value} aria-label={g.name} />
                  </div>
                </HoverCard>
                <span className="w-24 text-right text-label text-ink-3 tabular-nums">{g.text}</span>
              </ListRow>
            ))}
          </div>
        </Card>

        <Card className="gap-1.5 md:col-span-6">
          <CardHead>Coming up</CardHead>
          <div>
            {fx.comingUp.map((c) => (
              <ListRow key={c.name}>
                <Label className="w-14 tabular-nums">{c.date}</Label>
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <Money cents={c.cents} signed={c.signed} />
              </ListRow>
            ))}
          </div>
        </Card>
      </div>

      {/* Reference: every other component in its states */}
      <h2 className="mt-12 text-section">Reference</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-12 md:gap-5">
        <Card className="items-start md:col-span-6">
          <Label>Segmented control</Label>
          <Seg aria-label="Group by" items={[{ value: "cat", label: "By category" }, { value: "group", label: "By group" }, { value: "both", label: "Both" }]} />
          <Card tone="hero" className="items-start self-stretch">
            <Label>Dark tone, inside the hero</Label>
            <Seg tone="dark" aria-label="Range (dark)" items={fx.ranges} defaultValue="3m" />
          </Card>
        </Card>

        <Card className="md:col-span-6">
          <Label>Tabs</Label>
          <Tabs defaultValue="flow">
            <TabsList aria-label="Reports">
              <TabsTrigger value="flow">Cash flow</TabsTrigger>
              <TabsTrigger value="spending">Spending</TabsTrigger>
              <TabsTrigger value="income">Income</TabsTrigger>
              <TabsTrigger value="trends">Trends</TabsTrigger>
            </TabsList>
            <TabsContent value="flow">Income $6,480 in, $6,480 out.</TabsContent>
            <TabsContent value="spending">Spending $2,905, 12% above October.</TabsContent>
            <TabsContent value="income">Wordwise $3,200, Brightleaf $2,080, other $1,200.</TabsContent>
            <TabsContent value="trends">Six months of income and spending.</TabsContent>
          </Tabs>
        </Card>

        <Card className="md:col-span-6">
          <Label>Buttons and input</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Save</Button>
            <Button>Export</Button>
            <Button variant="ghost">Add account</Button>
            <Button size="icon" aria-label="Add">
              <Plus strokeWidth={1.5} />
            </Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input placeholder="Search transactions" className="max-w-64" />
            <Input defaultValue="Amex Gold" aria-invalid className="max-w-40" />
          </div>
        </Card>

        <Card className="md:col-span-6">
          <Label>Pills and money</Label>
          <div className="flex flex-wrap items-center gap-5">
            <Pill>Default</Pill>
            <Pill tone="strong">Due in 6 days</Pill>
            <Pill tone="soft">Streak 5</Pill>
            <Pill tone="loss">Overdue</Pill>
          </div>
          <div className="flex flex-wrap items-baseline gap-5 tabular-nums">
            <Money cents={4821240} />
            <Money cents={-231800} whole />
            <Money cents={210418} signed />
            <Money cents={3184000} compact />
            <Money cents={-42000} whole tone="loss" />
            <span className="text-figure-s">
              <Money cents={4821240} dimCents />
            </span>
          </div>
        </Card>

        <Card className="md:col-span-12">
          <Label>Table</Label>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="max-md:hidden">Category</TableHead>
                <TableHead className="max-md:hidden">Account</TableHead>
                <TableHead numeric>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fx.transactions.map((t) => (
                <TableRow key={t.name} clickable>
                  <TableCell className="whitespace-nowrap text-ink-3 tabular-nums">{t.date}</TableCell>
                  <TableCell>{t.name}</TableCell>
                  <TableCell className="max-md:hidden">
                    <Pill>{t.cat}</Pill>
                  </TableCell>
                  <TableCell className="text-ink-2 max-md:hidden">{t.account}</TableCell>
                  <TableCell numeric>
                    <Money cents={t.cents} signed />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card className="md:col-span-4">
          <CardHead aside={<InfoDot>Formula with the real numbers: $6,480 income minus $2,318 on cards. Updated 2 hours ago.</InfoDot>}>
            Info dot
          </CardHead>
          <HoverCard content={"Wordwise payout\nNov 20 · Checking\nUGC income"}>
            <ListRow as="button" type="button">
              <span className="flex-1">Hover card on a row</span>
              <Money cents={142000} signed />
            </ListRow>
          </HoverCard>
        </Card>

        <Card className="items-start md:col-span-4">
          <Label>Motion number</Label>
          <MotionNumberDemo />
        </Card>

        <Card className="items-start md:col-span-4">
          <Label>Detail drawer</Label>
          <Button asChild>
            <Link href="/dev/kit?task=1" scroll={false}>
              Open task
            </Link>
          </Button>
        </Card>

        <div className="grid gap-3 md:col-span-12 md:grid-cols-2 md:gap-5">
          <SkeletonHero />
          <Card tone="hero">
            <Label>Hero (loaded)</Label>
            <span className="text-hero max-md:text-[52px]">
              <Money cents={4821240} dimCents />
            </span>
          </Card>
          <SkeletonCard rows={2} />
          <Card className="gap-1.5">
            <CardHead>Cash</CardHead>
            <span className="text-figure-s">
              <Money cents={3184000} whole />
            </span>
            <div className="border-t border-rule">
              {fx.cash.rows.map((r) => (
                <ListRow key={r.name}>
                  <span className="flex-1 text-ink-2">{r.name}</span>
                  <Money cents={r.cents} />
                </ListRow>
              ))}
            </div>
          </Card>
          <SkeletonStrip cells={2} />
          <Strip cols={2}>
            <Stat label="Income this month">
              <Money cents={648000} whole />
            </Stat>
            <Stat label="Spending">
              <Money cents={290500} whole />
            </Stat>
          </Strip>
          <SkeletonChart height={180} />
          <Card>
            <Label>Income and spending</Label>
            <Bars data={fx.months} series={["Income", "Spending"]} money={{ whole: true }} height={180} label="Income and spending by month" />
          </Card>
          <Card>
            <Label>Rows skeleton</Label>
            <SkeletonRows n={3} />
          </Card>
          <Card data-testid="kit-skeleton-panel">
            <Label>Slide-out skeleton</Label>
            <SkeletonPanel rows={4} />
          </Card>
          <Card className="flex-row items-center gap-6">
            <Donut data={fx.spending} money={{ whole: true }} size={140} label="Spending by category" />
            <div className="min-w-0 flex-1">
              {fx.spending.slice(0, 3).map((s) => (
                <ListRow key={s.label}>
                  <span className="flex-1">{s.label}</span>
                  <Money cents={s.value} whole />
                </ListRow>
              ))}
            </div>
          </Card>
        </div>

        <Card className="md:col-span-4">
          <Label>Sparkline</Label>
          <div className="flex items-end gap-4">
            <span className="text-figure-s tabular-nums">48.2k</span>
            <Sparkline data={[12, 14, 13, 18, 22, 21, 26, 31, 29, 34]} height={32} label="Views, last 10 days" className="flex-1" />
          </div>
        </Card>
        <Card className="md:col-span-8">
          <Label>Trend line, default tone</Label>
          <TrendLine data={fx.trend} height={120} label="Net worth trend, light" />
        </Card>

        <Card className="md:col-span-12">
          <CardHead aside={<InfoDot>Hover a band to see its amount. Taxes set aside is the money to hold for the IRS.</InfoDot>}>
            Cash flow
          </CardHead>
          <div className="overflow-x-auto">
            <Sankey nodes={fx.sankey.nodes} links={fx.sankey.links} height={440} className="min-w-[720px]" />
          </div>
        </Card>
      </div>

      <TaskDrawerDemo />
      <TabsDrawerDemo />
    </main>
  );
}
