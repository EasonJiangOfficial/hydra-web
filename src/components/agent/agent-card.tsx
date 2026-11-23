"use client";

import { SquareArrowDownLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { InfoDot } from "@/components/kit/hover-card";
import { EASE } from "@/components/kit/seg";
import { cn } from "@/lib/utils";
import { AgentControls, Tip } from "./controls";
import { Orb } from "./orb";
import { useAgent } from "./context";
import type { AgentState, MacIssue } from "./controller";
import { statusWord } from "./thread/model";
import { usePhone } from "./thread/use-phone";
import { STATUS_LABEL } from "./types";

/** The card's words when a turn ended because the brain did not answer (brain_offline, mac_offline, mac_timeout, ...). */
export const MAC_ISSUE: Record<MacIssue, { label: string; info: string }> = {
  brain_offline: { label: "Hydra is offline.", info: "Hydra's server and your Mac are both offline." },
  brain_timeout: { label: "Hydra did not answer", info: "Hydra's server took too long to answer. Try again." },
  brain_failed: { label: "Hydra stopped answering", info: "Hydra's server went quiet in the middle of the answer. Try again." },
  offline: { label: "Your Mac is offline", info: "Hydra thinks on your Mac. Open Hydra Desktop there, then try again." },
  timeout: { label: "Your Mac did not answer", info: "Hydra Desktop took too long to answer. Try again." },
  bad_event: { label: "Problem on your Mac", info: "Hydra Desktop sent an answer Hydra could not use. Try again." },
  failed: { label: "Your Mac stopped answering", info: "Hydra Desktop went quiet in the middle of the answer. Try again." },
  claude: { label: "Sign in on your Mac", info: "Open Hydra on your Mac and sign in with Claude." },
};
export const OFFLINE_LABEL = MAC_ISSUE.offline.label;

/** The status word, or why the Mac did not answer (phone and web, after a turn ended with a mac_* code). */
export function StatusWord({ state, testId, info = true, word, className }: { state: AgentState; testId: string; info?: boolean; word?: string; className?: string }) {
  const issue = state.desktop ? null : state.macIssue;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span role="status" data-testid={testId} data-mac-issue={issue ?? undefined} className={cn("truncate text-label", issue ? "text-ink" : "text-ink-3")}>
        {issue ? MAC_ISSUE[issue].label : (word ?? statusWord(state, STATUS_LABEL[state.status]))}
      </span>
      {issue && info && <InfoDot label="Why">{MAC_ISSUE[issue].info}</InfoDot>}
    </span>
  );
}

/** The tail of a long streamed reply, so the newest words stay in the card. The panel has the whole text. */
const tail = (t: string, n = 160) => (t.length > n ? `…${t.slice(-n).replace(/^\S*\s/, "")}` : t);

/** What the Mac heard and is saying, under the orb (Hydra Desktop attached). */
function Live({ state }: { state: AgentState }) {
  if (!state.desktop || (!state.heard && !state.reply)) return null;
  return (
    <div data-testid="agent-live" aria-live="polite" className="flex w-full flex-col gap-1.5 border-t border-rule px-1.5 pt-2.5">
      {state.heard && (
        <p data-testid="agent-heard" className="line-clamp-2 text-label text-ink-3">
          {state.heard}
        </p>
      )}
      {state.reply && (
        <p data-testid="agent-reply" className="line-clamp-5 text-label text-ink">
          {tail(state.reply)}
        </p>
      )}
    </div>
  );
}

/** Detached (Hydra Desktop v2+): the orb floats on the Mac, and this slot is one compact "Attached" toggle, off. */
function AttachRow() {
  const { ctl } = useAgent();
  return (
    <section aria-label="Hydra Agent" data-testid="agent-card" data-detached="" className="mt-auto flex flex-none">
      <Tip label="Attach the orb to this window" side="right">
        <button
          type="button"
          role="switch"
          aria-checked={false}
          onClick={ctl.attach}
          aria-label="Attached"
          data-testid="agent-attach"
          className="group/att flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 whitespace-nowrap text-ink-3 outline-none transition-colors duration-200 ease-hydra hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-ink group-data-[sidebar=closed]/shell:pl-[11px]"
        >
          <SquareArrowDownLeft aria-hidden className="size-[18px] flex-none" strokeWidth={1.4} />
          <span className="transition-opacity duration-200 group-data-[sidebar=closed]/shell:opacity-0">Attached</span>
          <span aria-hidden className="ml-auto flex h-4 w-7 flex-none items-center rounded-full border border-rule-2 px-[3px] transition-opacity duration-200 group-hover/att:border-ink-3 group-data-[sidebar=closed]/shell:opacity-0">
            <span className="size-2 rounded-full bg-ink-3" />
          </span>
        </button>
      </Tip>
    </section>
  );
}

/** What a tap on the orb does where it sits: its tap map (asleep wakes, listening sleeps, speaking interrupts), or a menu. */
export type OrbTap = { label: string; onTap: () => void; expanded?: boolean };

/**
 * The orb as a button. By default its tap map: asleep wakes, listening turns off, speaking stops the speech and listens
 * (owner: "if I tap on the visualiser when it's listening it should shut off"). In the panel header it opens Hydra's
 * options instead (`menu`), except while Hydra speaks or listens: then a tap still interrupts or turns it off, the only
 * way on an iPhone with the sheet open (the name beside it always opens the options).
 */
export function OrbButton({ className, tone = "ink", menu: menuTap }: { className?: string; tone?: "ink" | "white"; menu?: OrbTap }) {
  const { ctl, state } = useAgent();
  const menu = state.status === "speaking" || state.status === "listening" ? undefined : menuTap;
  const label = menu?.label ?? (state.status === "asleep" ? "Wake Hydra" : state.status === "speaking" ? "Interrupt Hydra" : "Talk to Hydra");
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup={menu ? "dialog" : undefined}
      aria-expanded={menu ? !!menu.expanded : undefined}
      data-testid="agent-orb"
      data-status={state.status}
      data-woke={state.wokeAt ?? undefined}
      data-orb-menu={menu ? "" : undefined}
      onClick={menu?.onTap ?? ctl.tapOrb}
      className={cn("block flex-none rounded-full outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink", className)}
    >
      <Orb status={state.status} getLevel={ctl.level} getBands={ctl.bands} tone={tone} wokeAt={state.wokeAt} />
    </button>
  );
}

/** The flight's length. e2e raises window.__agentOrbSlowMo to catch the orb mid-flight in a screenshot. */
const flightSeconds = () => 0.36 * ((typeof window !== "undefined" && Number((window as unknown as { __agentOrbSlowMo?: number }).__agentOrbSlowMo)) || 1);

/** Where the orb last was, written as a slot unmounts: the next slot to mount flies in from there. */
let leftAt: { rect: DOMRect; t: number } | null = null;
const HANDOFF_MS = 250;

/**
 * The one orb on screen. Opening the panel moves it from the sidebar card (or the phone pill) into the panel header
 * and closing moves it back. A hand-made FLIP: the slot that unmounts notes its box; the slot that mounts in the same
 * commit starts at that box and eases to its own, 360 ms, the house ease (Web Animations, transform only). A slot
 * that only resizes (the sidebar collapsing) never flies. Only a slot that is showing takes part (`fly`), so a
 * CSS-hidden twin never does. Reduced motion: no flight, the orb fades in where it lands.
 */
export function FlyingOrb({ fly, className, menu, ...slot }: { fly: boolean; className?: string; menu?: OrbTap } & ComponentProps<"div">) {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = el.current;
    if (!fly || !node) return;
    const from = leftAt && performance.now() - leftAt.t < HANDOFF_MS ? leftAt.rect : null;
    leftAt = null;
    if (from) {
      const to = node.getBoundingClientRect();
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (still) node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: HOUSE_EASE });
      else if (to.width > 0) {
        // Fly in a fixed layer, so the sidebar's overflow never clips the orb on its way back.
        Object.assign(node.style, { position: "fixed", left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, zIndex: "60" });
        const flight = node.animate(
          [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})` }, { transform: "none" }],
          { duration: flightSeconds() * 1000, easing: HOUSE_EASE },
        );
        const land = () => Object.assign(node.style, { position: "", left: "", top: "", width: "", height: "", zIndex: "" });
        flight.onfinish = land;
        flight.oncancel = land;
      }
    }
    return () => {
      const r = node.getBoundingClientRect();
      if (r.width > 0) leftAt = { rect: r, t: performance.now() };
    };
  }, [fly]);
  return (
    <div {...slot} className={cn("flex-none", className)}>
      <div ref={el} data-slot="agent-orb-slot" className="size-full origin-top-left">
        <OrbButton className="size-full" menu={menu} />
      </div>
    </div>
  );
}
const HOUSE_EASE = `cubic-bezier(${EASE.join(",")})`;

/** Closed-sidebar rule (desktop): the card collapses to the orb alone. Keys off `data-sidebar` on the shell root. Opacity-only motion (DESIGN.md section 7): size and rows change at once. */
const shut = "group-data-[sidebar=closed]/shell:grid-rows-[0fr] group-data-[sidebar=closed]/shell:opacity-0 group-data-[sidebar=closed]/shell:invisible";

/**
 * The Hydra Agent card at the bottom of the desktop sidebar: the orb, one status word, mute, pause, stop and
 * expand. With the sidebar collapsed (64 px) it is the orb alone. Hidden on the phone.
 */
export function AgentCard() {
  const { ctl, state } = useAgent();
  const phone = usePhone();
  if (state.desktop && state.detached) return <AttachRow />;
  const asleep = state.status === "asleep";
  // The panel is open: the orb has flown into its header. The buttons fade, then the card folds away; on close the
  // card is back at once (so the returning orb lands on its final spot) and the buttons fade in.
  const open = state.expanded;
  const orb = "size-[96px] group-data-[sidebar=closed]/shell:size-10";
  return (
    <section
      aria-label="Hydra Agent"
      data-testid="agent-card"
      data-asleep={asleep ? "" : undefined}
      data-open={open ? "" : undefined}
      className={cn("relative mt-auto flex flex-none flex-col items-center px-2 pt-3 pb-3 group-data-[sidebar=closed]/shell:p-0", open && "pointer-events-none")}
    >
      {asleep && !open && (
        // Asleep, the whole card wakes Hydra to listen. The orb is the keyboard stop (Enter or Space); this layer is pointer only.
        <Tip label="Tap to talk" side="right">
          <button type="button" tabIndex={-1} aria-hidden data-testid="agent-card-wake" onClick={ctl.tapOrb} className="absolute inset-0 cursor-pointer outline-none" />
        </Tip>
      )}
      {!open && (
        <Tip label={asleep ? "Tap to talk" : "Hydra"} side="right">
          <FlyingOrb fly={!phone} className={cn("relative", orb)} />
        </Tip>
      )}
      <div
        aria-hidden={open || undefined}
        className={cn(
          "grid w-full",
          open
            ? "invisible grid-rows-[0fr] opacity-0 transition-[opacity,visibility,grid-template-rows] delay-[0ms,0ms,160ms] duration-[160ms,160ms,240ms] ease-hydra"
            : "grid-rows-[1fr] transition-opacity duration-200 ease-hydra",
        )}
      >
        <div className="flex min-h-0 flex-col items-center overflow-hidden">
          {open && <div aria-hidden className={orb} />}
          <div className={cn("pointer-events-none relative grid w-full grid-rows-[1fr] transition-[opacity,visibility] duration-200 ease-hydra [&_button]:pointer-events-auto", shut)}>
            <div className="flex min-h-0 flex-col items-center gap-3 overflow-hidden pt-2">
          {/* Folding away: a quiet copy, so only the panel header reports the status. */}
          <StatusWord state={state} testId={open ? "agent-status-folding" : "agent-status"} />
          {!state.desktop && state.typedOnly && (
            <span data-testid="agent-no-voice" className="inline-flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => ctl.setExpanded(true)}
                className="rounded-md text-label text-ink underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ink"
              >
                Type to Hydra
              </button>
              <InfoDot label="No voice">This browser has no speech recognition, or the microphone is off.</InfoDot>
            </span>
          )}
          <Live state={state} />
          <AgentControls expand detach />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** How long the pill shows an error (the thread keeps it). */
export const NOTE_MS = 4000;

/** An error over the phone pill for NOTE_MS, then it fades. Mounted once per error (keyed on it). */
function BriefNote({ text }: { text: string }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setOn(false), NOTE_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <p
      role="alert"
      data-testid="agent-note-phone"
      aria-hidden={!on || undefined}
      className={cn(
        "pointer-events-none absolute right-0 bottom-full mb-2 w-max max-w-[calc(100vw-32px)] rounded-full border border-rule bg-surface px-3.5 py-2 text-label text-ink transition-[opacity,visibility] duration-300 ease-hydra",
        !on && "invisible opacity-0",
      )}
    >
      {text}
    </p>
  );
}

/**
 * The phone's floating orb, above the bottom tabs (68 px plus the safe area). A pill: the status word, which
 * opens the thread, and the orb, which talks. Hidden from 768 px up.
 */
export function AgentFloat() {
  const { ctl, state } = useAgent();
  const phone = usePhone();
  // Open, the orb is in the sheet's header: the pill keeps its place and fades out under the sheet.
  const open = state.expanded;
  // Voice off (no recognizer, the mic refused, or not hearing him): the pill says so instead of Listening.
  const word = !state.desktop && state.typedOnly && state.status === "listening" ? "Type to Hydra" : undefined;
  // A Mac issue is the status word already.
  const note = state.error && !(state.macIssue && !state.desktop) ? state.error : null;
  return (
    <div
      data-testid="agent-float"
      data-open={open ? "" : undefined}
      className={cn(
        "fixed right-4 bottom-[calc(68px+env(safe-area-inset-bottom)+12px)] z-40 flex items-center gap-1 rounded-full border border-rule bg-surface py-1 pr-1 pl-3.5 transition-opacity duration-200 ease-hydra md:hidden",
        open && "invisible opacity-0 transition-[opacity,visibility]",
      )}
    >
      <button
        type="button"
        onClick={() => ctl.setExpanded(true)}
        aria-label="Open the thread"
        className="rounded-full py-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <StatusWord state={state} testId="agent-status-phone" info={false} word={word} />
      </button>
      {note && !open && <BriefNote key={note} text={note} />}
      {open ? <div aria-hidden className="size-12 flex-none" /> : <FlyingOrb fly={phone} className="size-12" />}
    </div>
  );
}
