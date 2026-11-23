"use client";

import { ChevronDown, Download } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import {
  Button,
  Card,
  HoverCard,
  Input,
  Label,
  Money,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
  formatMoney,
} from "@/components/kit";
import { formatViewCount } from "@/lib/ugc/format-views";

import { ErrorText, useAct } from "./controls";
import { NeedsMatching, PLATFORM, VideoPosts } from "./matching";
import { shortDay, videosToCsv, type VideoView } from "./model";
import { useUgc } from "./store";

const PAGE = 50;
const usd = (c: number) => formatMoney(c, { whole: c % 100 === 0 });

/** A reading history as a white line, for the ink hover card. */
function Spark({ data }: { data: readonly number[] }) {
  const w = 148;
  const h = 32;
  const min = Math.min(...data);
  const span = Math.max(1, Math.max(...data) - min);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * (w - 4) + 2},${h - 2 - ((v - min) / span) * (h - 4)}`).join(" ");
  return (
    <svg width={w} height={h} role="img" aria-label="View history" className="mt-1.5 block">
      <polyline points={pts} fill="none" stroke="white" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function viewsCard(v: VideoView) {
  return (
    <div>
      <div>{v.hasReading ? `${v.views.toLocaleString("en-US")} views` : "No reading yet"}</div>
      {v.lastCapturedDay && <div>{`Last read ${shortDay(v.lastCapturedDay)}`}</div>}
      {v.heldReading && <div>{`Held: ${v.heldReading.views.toLocaleString("en-US")} views`}</div>}
      {v.history.length > 1 ? <Spark data={v.history} /> : v.hasReading ? <div>Only one reading</div> : null}
    </div>
  );
}

function totalCard(v: VideoView) {
  if (v.excluded) return "Excluded from pay.\nIt pays $0 and does not count toward the target.";
  if (v.overridden) return `Your own price ${usd(v.baseCents)} replaces the pay rules.`;
  return `Base ${usd(v.baseCents)}\nCPM ${usd(v.cpmCents)}\nBonus ${usd(v.bonusCents)}`;
}

export function PayToggle({ video }: { video: VideoView }) {
  const { actions } = useUgc();
  const { busy, error, act } = useAct();
  return (
    <span className="flex flex-col items-start gap-0.5">
      <button
        type="button"
        aria-pressed={video.excluded}
        aria-label={`${video.excluded ? "Count" : "Exclude"} ${video.title} ${video.excluded ? "in" : "from"} pay`}
        disabled={busy}
        onClick={() =>
          void act(async () => {
            // One video on several accounts is one video: flip every post that carries the flag.
            let last;
            for (const id of video.postIds) {
              last = await (video.excluded ? actions.unexcludePost({ id }) : actions.excludePost({ id }));
              if (!last.ok) return last;
            }
            return last!;
          })
        }
        className={cn(
          "text-tag font-medium transition-colors duration-200 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40",
          video.excluded ? "text-ink-3 underline underline-offset-2 hover:text-ink" : "text-ink hover:text-ink-3",
        )}
      >
        {video.excluded ? "Excluded" : "Counted"}
      </button>
      <ErrorText>{error}</ErrorText>
    </span>
  );
}

/** A reading held for review (a jump over 10x) is not paid until the owner accepts it here. */
export function AcceptHeld({ video }: { video: VideoView }) {
  const { actions } = useUgc();
  const { busy, error, act } = useAct();
  const held = video.heldReading;
  if (!held) return null;
  return (
    <span className="flex flex-col items-end gap-0.5 max-md:order-last">
      <Button
        variant="outline"
        className="h-7 px-2 text-tag"
        disabled={busy}
        aria-label={`Accept ${formatViewCount(held.views)} views for ${video.title}`}
        onClick={() =>
          void act(() => actions.setViews({ capturedAt: held.capturedAt, force: true, items: [{ postId: held.postId, views: held.views }] }))
        }
      >
        Accept<span className="max-md:hidden">{` ${formatViewCount(held.views)}`}</span>
      </Button>
      <ErrorText>{error}</ErrorText>
    </span>
  );
}

export function Videos({ dealId }: { dealId: string | null }) {
  const { model } = useUgc();
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return model.videos.filter(
      (v) => (!dealId || v.dealId === dealId) && (!needle || v.title.toLowerCase().includes(needle) || v.url.toLowerCase().includes(needle)),
    );
  }, [model.videos, dealId, q]);
  const counted = rows.filter((v) => !v.excluded);
  const countedCents = counted.reduce((s, v) => s + v.payCents, 0);

  function exportCsv() {
    const blob = new Blob([videosToCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hydra-videos-${model.today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-5">
    <NeedsMatching dealId={dealId} />
    <Card aria-label="Videos">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Label>Videos</Label>
        <span className="text-label text-ink-3" data-testid="video-summary">
          {`${rows.length} ${rows.length === 1 ? "video" : "videos"} · `}
          <Money cents={countedCents} whole /> counted · {rows.length - counted.length} excluded
        </span>
        <div className="flex-1" />
        <Input
          aria-label="Search videos"
          placeholder="Search title or link"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setLimit(PAGE);
          }}
          className="w-full sm:w-[220px]"
        />
        <Button onClick={exportCsv} disabled={rows.length === 0}>
          <Download strokeWidth={1.5} />
          Export CSV
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-body text-ink-3">{model.videos.length === 0 ? "No videos yet." : "No video matches."}</p>
      ) : (
        // The phone keeps title, views, total and pay on screen: no sideways scroll to reach the money.
        <Table className="max-md:[&_td]:px-1.5 max-md:[&_th]:px-1.5">
          <TableHeader>
            <TableRow>
              <TableHead>Video</TableHead>
              <TableHead className="max-md:hidden">Account</TableHead>
              <TableHead className="max-md:hidden">Deal</TableHead>
              <TableHead className="max-md:hidden">Posted</TableHead>
              <TableHead className="text-right">Views</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Pay</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, limit).map((v) => (
              <Fragment key={v.key}>
              <TableRow data-video={v.key} className={cn(v.excluded && "opacity-50")}>
                <TableCell className="max-w-[280px] max-md:max-w-[120px] max-md:whitespace-normal">
                  {v.url.startsWith("https://") ? (
                    <a
                      href={v.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate underline-offset-2 hover:underline"
                    >
                      {v.title}
                    </a>
                  ) : (
                    <span className="block truncate">{v.title}</span>
                  )}
                  <span className="block truncate text-tag text-ink-3 md:hidden">{`${v.brandName} · ${shortDay(v.day)}`}</span>
                  {v.postIds.length > 1 && (
                    <button
                      type="button"
                      aria-expanded={open.has(v.key)}
                      aria-controls={`platforms-${v.key}`}
                      aria-label={`On ${v.postIds.length} platforms, paid once`}
                      onClick={() => toggle(v.key)}
                      className="mt-0.5 inline-flex items-center gap-1 rounded-sm text-left text-tag font-medium whitespace-nowrap text-ink-2 transition-colors duration-200 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      <span className="md:hidden">{`${v.postIds.length} platforms`}</span>
                      <span className="max-md:hidden">{`On ${v.postIds.length} platforms, paid once`}</span>
                      <ChevronDown
                        aria-hidden
                        strokeWidth={1.5}
                        className={cn("size-3.5 transition-transform duration-200 ease-out", open.has(v.key) && "rotate-180")}
                      />
                    </button>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-ink-2 max-md:hidden">{v.handle ? `@${v.handle} · ${PLATFORM[v.platform]}` : PLATFORM[v.platform]}</TableCell>
                <TableCell className="max-md:hidden">{v.brandName}</TableCell>
                <TableCell className="whitespace-nowrap text-ink-2 max-md:hidden">{shortDay(v.day)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <span className="flex items-center justify-end gap-2 max-md:flex-col max-md:items-end max-md:gap-1">
                    <AcceptHeld video={v} />
                    <HoverCard content={viewsCard(v)} describe={false} className="w-[180px]">
                      <button type="button" className="tabular-nums underline decoration-rule-2 decoration-dotted underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-ink">
                        {formatViewCount(v.hasReading ? v.views : null)}
                      </button>
                    </HoverCard>
                  </span>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  <HoverCard content={totalCard(v)} describe={false}>
                    <button type="button" className="tabular-nums underline decoration-rule-2 decoration-dotted underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-ink">
                      {usd(v.payCents)}
                    </button>
                  </HoverCard>
                </TableCell>
                <TableCell>
                  <PayToggle video={v} />
                </TableCell>
              </TableRow>
              {open.has(v.key) && v.postIds.length > 1 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={7} className="pt-0 pb-2 whitespace-normal md:pl-6">
                    <VideoPosts video={v} id={`platforms-${v.key}`} />
                  </TableCell>
                </TableRow>
              )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}
      {rows.length > limit && (
        <Button className="self-center" onClick={() => setLimit((l) => l + PAGE)}>
          {`Show ${Math.min(PAGE, rows.length - limit)} more`}
        </Button>
      )}
    </Card>
    </div>
  );
}
