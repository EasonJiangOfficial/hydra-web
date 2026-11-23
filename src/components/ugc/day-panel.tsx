"use client";

import { useId, useState } from "react";

import { offerUndo } from "@/components/activity/undo-bar";
import { Button, DetailDrawer, Input, Label, Money, Pill, formatMoney } from "@/components/kit";
import { SaveLabel, useAutosave } from "@/components/planning/controls";
import { Select } from "@/components/ui/select";
import { DAY_KEY_REGEX } from "@/lib/ugc/days";
import { formatViewCount } from "@/lib/ugc/format-views";
import { PLATFORMS, type Platform } from "@/lib/ugc/schemas";

import { ConfirmDelete, DealLogo, ErrorText, Field, SectionLabel, useAct } from "./controls";
import { DealMenu, DealPicker } from "./deal-picker";
import { dayDetail, dealRunsOn, longDay, noonOn, type DayDeal } from "./model";
import { useUgc } from "./store";
import { useQueryParam } from "./url";
import { PayToggle } from "./videos";

const PLATFORM_LABEL: Record<Platform, string> = { TIKTOK: "TikTok", INSTAGRAM: "Instagram", YOUTUBE: "YouTube", FACEBOOK: "Facebook" };

/** The platform a post URL belongs to, or null when the host is unknown. */
export function platformOf(url: string): Platform | null {
  const host = url.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^(www|m)\./, "");
  if (host.startsWith("tiktok.com") || host.startsWith("vm.tiktok.com")) return "TIKTOK";
  if (host.startsWith("instagram.com")) return "INSTAGRAM";
  if (host.startsWith("youtube.com") || host.startsWith("youtu.be")) return "YOUTUBE";
  if (host.startsWith("facebook.com") || host.startsWith("fb.watch")) return "FACEBOOK";
  return null;
}

export function DayPanel() {
  return (
    <DetailDrawer param="day" label="Posting day">
      {(day) => (DAY_KEY_REGEX.test(day) ? <DayBody key={day} day={day} /> : <p className="text-body text-ink-3">Not a day.</p>)}
    </DetailDrawer>
  );
}

function DayBody({ day }: { day: string }) {
  const { model } = useUgc();
  const [add] = useQueryParam("add");
  const d = dayDetail(model, day);
  return (
    <div className="flex flex-col gap-5" data-testid="day-panel">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-section text-ink">{longDay(day)}</h2>
        <p className="flex flex-wrap items-baseline gap-x-3 text-label text-ink-3" data-testid="day-summary">
          {d.future ? (
            <span>{`Upcoming · target ${d.target}`}</span>
          ) : (
            <>
              <span>{d.target === 0 && d.posted === 0 ? "No target" : `${d.posted} of ${d.target} posted`}</span>
              {d.missedCents > 0 ? (
                <span className="text-neg">
                  <Money cents={-d.missedCents} whole /> missed
                </span>
              ) : d.earnedCents > 0 ? (
                <span>
                  <Money cents={d.earnedCents} signed whole /> earned
                </span>
              ) : null}
            </>
          )}
        </p>
      </div>

      {d.deals.length === 0 && <p className="text-body text-ink-3">No deal has a target or a video on this day.</p>}
      {d.deals.map((row) => (
        <DealDay key={row.deal.deal.id} day={day} row={row} />
      ))}

      <AddVideo day={day} defaultOpen={add === "1" || d.deals.every((r) => r.videos.length === 0)} />
      <DayNote day={day} />
    </div>
  );
}

function DealDay({ day, row }: { day: string; row: DayDeal }) {
  const { actions } = useUgc();
  const { busy, error, act } = useAct();
  const id = useId();
  const deal = row.deal.deal;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(row.target ?? 0);
  const set = (target: number | null) =>
    act(() => actions.setDayTarget({ dealId: deal.id, day, target }));
  const commit = async () => {
    if (draft === null) return;
    const n = Math.floor(Number(draft));
    setDraft(null);
    if (!Number.isFinite(n) || n < 0 || n > 30 || n === row.target) return;
    await set(n);
  };
  return (
    <section aria-label={deal.brand_name} className="flex flex-col gap-2 rounded-lg bg-tint p-3" data-deal-day={deal.id}>
      <div className="flex items-center gap-2.5">
        <DealLogo name={deal.brand_name} url={row.deal.logoUrl} size={28} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium">{deal.brand_name}</div>
          <div className="text-tag text-ink-3 tabular-nums">
            {`${row.posted} of ${row.target ?? 0} posted`}
            {row.missedCents > 0 && (
              <>
                {" · "}
                <span className="text-neg">
                  <Money cents={-row.missedCents} whole />
                </span>
              </>
            )}
            {row.missedCents === 0 && row.earnedCents > 0 && (
              <>
                {" · "}
                <Money cents={row.earnedCents} signed whole />
              </>
            )}
          </div>
        </div>
        {row.override !== null && <Pill tone="strong">{row.override === 0 ? "Day off" : "Override"}</Pill>}
        <DealMenu view={row.deal} className="-mr-1" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label as="label" htmlFor={`${id}-t`}>
          Target
        </Label>
        <Input
          id={`${id}-t`}
          type="number"
          min={0}
          max={30}
          inputMode="numeric"
          aria-label={`Target for ${deal.brand_name}`}
          value={shown}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="h-[30px] w-16 bg-surface text-right tabular-nums"
        />
        {row.target !== 0 && (
          <Button variant="outline" className="h-[30px] bg-surface" disabled={busy} onClick={() => void set(0)}>
            Day off
          </Button>
        )}
        {row.override !== null && (
          <ConfirmDelete what={`Remove the override for ${deal.brand_name}`} label="Reset" confirmLabel="Reset" busy={busy} onConfirm={() => void set(null)} />
        )}
      </div>
      <ErrorText>{error}</ErrorText>

      {row.videos.length > 0 && (
        <div className="flex flex-col">
          {row.videos.map((v) => (
            <DayVideo key={v.key} video={v} />
          ))}
        </div>
      )}
    </section>
  );
}

function DayVideo({ video: v }: { video: DayDeal["videos"][number] }) {
  const { actions } = useUgc();
  const { busy, error, act } = useAct();
  return (
    <div data-day-video={v.key} className="flex flex-col gap-1 border-t border-rule-2 py-2.5 first:border-t-0">
      {v.url.startsWith("https://") ? (
        <a href={v.url} target="_blank" rel="noopener noreferrer" className="truncate text-body underline-offset-2 hover:underline">
          {v.title}
        </a>
      ) : (
        <span className="truncate text-body">{v.title}</span>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-tag text-ink-3">
        <span className="tabular-nums">{v.hasReading ? `${formatViewCount(v.views)} views` : "No reading yet"}</span>
        <span className="font-medium text-ink tabular-nums">{formatMoney(v.payCents, { whole: v.payCents % 100 === 0 })}</span>
        <PayToggle video={v} />
        <span className="flex-1" />
        <ConfirmDelete
          what={`Delete ${v.postIds.length > 1 ? "this video and its other accounts" : "this video"}`}
          label="Delete"
          busy={busy}
          className="-my-1 [&_button]:h-7"
          onConfirm={async () => {
            const ids: (string | null | undefined)[] = [];
            await act(async () => {
              let last;
              for (const id of v.postIds) {
                last = await actions.deletePost({ id });
                if (!last.ok) break;
                ids.push(last.activityId);
              }
              // A stop partway deleted only some of its posts: the bar says how many.
              offerUndo(ids, ids.length < v.postIds.length ? `${ids.length} of ${v.postIds.length} posts of "${v.title}"` : `video "${v.title}"`);
              return last!;
            });
          }}
        />
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function AddVideo({ day, defaultOpen }: { day: string; defaultOpen: boolean }) {
  const { model, actions } = useUgc();
  const { busy, error, act, clear } = useAct();
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  // Only deals that run on this day: a video outside a deal's dates would not show on the day.
  const choices = model.deals.filter((d) => dealRunsOn(d.deal, day));
  const [picked, setDealId] = useState<string | null>(null);
  const dealId =
    (choices.some((d) => d.deal.id === picked) ? picked : null) ??
    choices.find((d) => d.deal.status === "active")?.deal.id ??
    choices[0]?.deal.id ??
    "";
  const [url, setUrl] = useState("");
  const [platform, setPlatform] = useState<Platform>("TIKTOK");
  const [platformPicked, setPlatformPicked] = useState(false);
  const [account, setAccount] = useState("");
  const [title, setTitle] = useState("");
  const [added, setAdded] = useState(false);

  if (!open) {
    return (
      <Button variant="outline" className="self-start" onClick={() => setOpen(true)}>
        Add a video
      </Button>
    );
  }
  if (choices.length === 0) return <p className="text-body text-ink-3">No deal runs on this day.</p>;

  const submit = async () => {
    setAdded(false);
    const res = await act(() =>
      actions.addPost({
        dealId,
        url,
        platform,
        account: account.trim() || undefined,
        postedAt: noonOn(day, model.zone),
        title: title.trim() || undefined,
        source: "hydra",
      }),
    );
    if (res) {
      setUrl("");
      setTitle("");
      setAdded(true);
    }
  };

  return (
    <form
      aria-label="Add a video"
      className="flex flex-col gap-3 border-t border-rule pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <SectionLabel>Add a video</SectionLabel>
      <Field label="Deal" htmlFor={`${id}-deal`}>
        <DealPicker id={`${id}-deal`} aria-label="Deal" deals={choices} value={dealId} onChange={setDealId} className="w-full" />
      </Field>
      <Field label="Post link" htmlFor={`${id}-url`}>
        <Input
          id={`${id}-url`}
          type="url"
          required
          inputMode="url"
          placeholder="https://www.tiktok.com/@name/video/..."
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            clear();
            const p = platformOf(e.target.value);
            if (p && !platformPicked) setPlatform(p);
          }}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Platform" htmlFor={`${id}-pf`}>
          <Select
            id={`${id}-pf`}
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value as Platform);
              setPlatformPicked(true);
            }}
            aria-label="Platform"
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABEL[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Account" htmlFor={`${id}-acct`}>
          <Input id={`${id}-acct`} placeholder="@handle" value={account} onChange={(e) => setAccount(e.target.value)} />
        </Field>
      </div>
      <Field label="Title" htmlFor={`${id}-title`}>
        <Input id={`${id}-title`} placeholder="Optional" maxLength={500} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <ErrorText>{error}</ErrorText>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy || url.trim() === "" || !dealId}>
          Add video
        </Button>
        <span role="status" className="text-tag text-ink-3">
          {added ? "Added" : ""}
        </span>
      </div>
    </form>
  );
}

const noteKey = (day: string) => `hydra:ugc:day-note:${day}`;
function readNote(day: string): string {
  try {
    return localStorage.getItem(noteKey(day)) ?? "";
  } catch {
    return "";
  }
}

/**
 * A note for the day. ponytail: kept in this browser only (localStorage). `src/lib/ugc` has no day-note
 * column or action yet, and all writes go through its actions; move it there when U1 adds one.
 */
function DayNote({ day }: { day: string }) {
  const id = useId();
  const [saved] = useState(() => readNote(day));
  const note = useAutosave(saved, async (text) => {
    try {
      if (text.trim() === "") localStorage.removeItem(noteKey(day));
      else localStorage.setItem(noteKey(day), text);
      return true;
    } catch {
      return false;
    }
  });
  return (
    <div className="flex flex-col gap-1.5 border-t border-rule pt-4">
      <div className="flex items-center gap-2">
        <Label as="label" htmlFor={id} className="flex-1">
          Note
        </Label>
        <SaveLabel state={note.state} />
      </div>
      <textarea
        id={id}
        rows={3}
        value={note.draft}
        maxLength={2000}
        onChange={(e) => note.edit(e.target.value)}
        onBlur={() => void note.flush()}
        placeholder="Write a note for this day"
        className="w-full resize-none rounded-lg border border-rule-2 bg-surface p-3 text-body text-ink outline-none transition-colors duration-200 placeholder:text-ink-3 focus:border-ink"
      />
    </div>
  );
}
