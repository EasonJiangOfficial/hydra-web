"use client";

import { Check, Minus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { InfoDot } from "@/components/kit/hover-card";
import { Button } from "@/components/ui/button";
import { HydraMark } from "@/components/shell/nav";
import { desktopBridge } from "@/components/agent/desktop";
import type { DesktopSetup, PermKind } from "@/components/agent/types";
import { cn } from "@/lib/utils";
import { isPerm, pairMac, readSkipped, setupBridge, setupComplete, stepStatus, STEPS, writeSkipped, type SetupBridge, type StepId } from "./steps";

/** How long the last check stays on screen before the app shows. */
const DONE_MS = 600;
/** Pairing this long without an answer: Retry shows next to "Pairing". */
export const PAIR_SLOW_MS = 20_000;
/** The longest the app waits, covered, for the desktop's first setup() answer. Then it shows (fail open). */
export const FIRST_ANSWER_MS = 3_000;

type Flags = Partial<Record<StepId, boolean>>;

/**
 * "Set up this Mac": inside Hydra Desktop (bridge v3), when setup() reports anything missing, one full-window step
 * list covers the app: Pair (automatic), Sign in with Claude, Microphone, Control apps, Screen. Done -> the app.
 * The app stays mounted under the cover (inert), so it never flashes and never remounts. No bridge, or an older
 * desktop without setup(): the children, untouched (the website and the phone never see it).
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const [bridge, setBridge] = useState<SetupBridge | null>(null);
  const [setup, setSetup] = useState<DesktopSetup | null>(null);
  /** Covered, blank, until the desktop's first answer (at most FIRST_ANSWER_MS). */
  const [first, setFirst] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Flags>({});
  const [failed, setFailed] = useState<Flags>({});
  const [slow, setSlow] = useState<Flags>({});
  /** Read once on the client; it only matters once the gate shows, after the first answer. */
  const [skipped, setSkipped] = useState<PermKind[]>(() => readSkipped());
  const autoPaired = useRef(false);
  /** One number per step: a Retry or a Cancel moves it on, so an older try's answer changes nothing. */
  const tries = useRef<Partial<Record<StepId, number>>>({});

  const flag = (set: typeof setBusy, id: StepId, v: boolean) => set((x) => ({ ...x, [id]: v }));

  const check = useCallback(async (b: SetupBridge) => {
    const s = await b.setup().catch(() => null);
    if (s) setSetup(s);
    return s;
  }, []);

  // Before paint, so the app never flashes before the gate.
  useLayoutEffect(() => {
    const b = setupBridge(desktopBridge(window.hydraDesktop));
    if (!b) return;
    const skip = readSkipped();
    // Covered before the first paint is the point (no flash of the app): a layout effect is the only place to know.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFirst(true);
    let live = true;
    const give = setTimeout(() => live && setFirst(false), FIRST_ANSWER_MS);
    b.setup().then(
      (s) => {
        if (!live) return;
        clearTimeout(give);
        setFirst(false);
        // An answer the web does not know (a failed ask, a broken desktop) opens nothing and pairs nothing.
        if (!s) return;
        setBridge(b);
        setSetup(s);
        if (!setupComplete(s, skip)) setOpen(true);
      },
      () => {
        clearTimeout(give);
        if (live) setFirst(false);
      },
    );
    return () => {
      live = false;
      clearTimeout(give);
    };
  }, []);

  const run = useCallback(
    async (id: StepId, act: (b: SetupBridge) => Promise<boolean>) => {
      if (!bridge) return;
      const n = (tries.current[id] = (tries.current[id] ?? 0) + 1);
      flag(setBusy, id, true);
      flag(setFailed, id, false);
      flag(setSlow, id, false);
      const ok = await act(bridge).catch(() => false);
      const s = await check(bridge);
      if (tries.current[id] !== n) return; // retried or cancelled: a newer try owns the step
      flag(setBusy, id, false);
      // Done only when the desktop says so: an ok answer with the step still missing (or no answer) is a failure.
      if (!ok || !s || stepStatus(s, id) !== "done") flag(setFailed, id, true);
    },
    [bridge, check],
  );

  const cancel = (id: StepId) => {
    tries.current[id] = (tries.current[id] ?? 0) + 1;
    flag(setBusy, id, false);
  };

  const pair = useCallback(() => run("pair", (b) => pairMac(b)), [run]);

  // Pair runs on its own, once, only when a valid setup() says this Mac is not paired. Never when it is paired.
  useEffect(() => {
    if (!open || !setup || setup.paired || autoPaired.current) return;
    autoPaired.current = true;
    void pair();
  }, [open, setup, pair]);

  // Pairing with no answer for 20 s: Retry shows.
  useEffect(() => {
    if (!busy.pair) return;
    const t = setTimeout(() => flag(setSlow, "pair", true), PAIR_SLOW_MS);
    return () => clearTimeout(t);
  }, [busy.pair]);

  // All done: hold the last check a beat, then the app.
  const complete = !!setup && setupComplete(setup, skipped);
  useEffect(() => {
    if (!open || !complete) return;
    const t = setTimeout(() => setOpen(false), DONE_MS);
    return () => clearTimeout(t);
  }, [open, complete]);

  const showing = open && !!setup && !!bridge;
  const covered = first || showing;
  useEffect(() => {
    if (!covered) return;
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    return () => void (html.style.overflow = before);
  }, [covered]);

  const act = (id: StepId) => {
    if (id === "pair") return void pair();
    if (id === "claude") return void run("claude", async (b) => (await b.signInClaude())?.ok === true);
    return void run(id, async (b) => (await b.requestPermission(id)) === "granted");
  };
  const skip = (id: PermKind) => {
    const next = [...new Set([...skipped, id])];
    setSkipped(next);
    writeSkipped(next);
  };

  return (
    <>
      <div data-testid="setup-app" className="contents" inert={covered || undefined}>
        {children}
      </div>
      {covered && (
        <div data-testid={showing ? "setup-mac" : "setup-wait"} data-complete={(showing && complete) || undefined} className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-surface">
          {showing && (
            <div className="flex min-h-full items-start justify-center px-4 pt-[18vh] pb-10">
              <section aria-labelledby="setup-mac-title" className="flex w-full max-w-[440px] flex-col gap-7 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
                <div className="flex items-center gap-2.5 text-ink">
                  <HydraMark />
                  <h1 id="setup-mac-title" className="text-title text-ink">
                    Set up this Mac
                  </h1>
                </div>
                <ol className="flex flex-col">
                  {STEPS.map((step) => (
                    <Step
                      key={step.id}
                      step={step}
                      setup={setup}
                      next={STEPS.find((s) => stepStatus(setup, s.id) !== "done" && !(isPerm(s.id) && skipped.includes(s.id)))?.id}
                      working={!!busy[step.id]}
                      failed={!!failed[step.id]}
                      slow={!!slow[step.id]}
                      skipped={isPerm(step.id) && skipped.includes(step.id)}
                      onAct={() => act(step.id)}
                      onCancel={() => cancel(step.id)}
                      onSkip={() => isPerm(step.id) && skip(step.id)}
                    />
                  ))}
                </ol>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  data-testid="setup-later"
                  className="self-start rounded-md text-label text-ink-3 outline-none transition-colors duration-200 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  Later
                </button>
              </section>
            </div>
          )}
        </div>
      )}
    </>
  );
}

type StepProps = {
  step: (typeof STEPS)[number];
  setup: DesktopSetup;
  next: StepId | undefined;
  working: boolean;
  failed: boolean;
  slow: boolean;
  skipped: boolean;
  onAct: () => void;
  onCancel: () => void;
  onSkip: () => void;
};

/** One row: the check, the label, its InfoDot, and on the right the one thing to do (or a short word). */
function Step({ step, setup, next, working, failed, slow, skipped, onAct, onCancel, onSkip }: StepProps) {
  const status = stepStatus(setup, step.id);
  const done = status === "done";
  const perm = isPerm(step.id);
  const shown = done ? "done" : working ? "working" : skipped ? "skipped" : failed ? "failed" : status;
  const word = (t: string) => <span className="text-label text-ink-3">{t}</span>;
  const main = (label: string) => (
    <Button variant={step.id === next ? "primary" : "outline"} onClick={onAct}>
      {label}
    </Button>
  );
  let right: ReactNode;
  if (done) right = <span className="sr-only">Done</span>;
  else if (working && step.id === "pair")
    right = (
      <>
        {word("Pairing")}
        {slow && main("Retry")}
      </>
    );
  else if (working)
    right = (
      <>
        {word("Waiting")}
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </>
    );
  else if (skipped)
    right = (
      <>
        {word("Skipped")}
        {main(status === "denied" ? "Open Settings" : step.action)}
      </>
    );
  else
    right = (
      <>
        {(failed || status === "denied") && word(status === "denied" ? "Off" : "Failed")}
        {main(status === "denied" ? "Open Settings" : step.action)}
        {perm && (failed || status === "denied") && (
          <Button variant="ghost" onClick={onSkip}>
            Skip
          </Button>
        )}
      </>
    );
  return (
    <li data-testid={`setup-step-${step.id}`} data-state={shown} className="flex min-h-14 items-center gap-3 border-t border-rule last:border-b">
      <span
        aria-hidden
        className={cn(
          "grid size-5 flex-none place-items-center rounded-full border transition-colors duration-200 ease-hydra",
          done ? "border-ink bg-ink text-white" : skipped ? "border-rule-2 text-ink-3" : "border-rule-2",
          working && "motion-safe:animate-pulse border-ink-3",
        )}
      >
        {done && <Check className="size-3" strokeWidth={2} />}
        {!done && skipped && <Minus className="size-3" strokeWidth={2} />}
      </span>
      <span className={cn("text-body", done || skipped ? "text-ink-3" : "text-ink")}>{step.label}</span>
      <InfoDot label={`Why ${step.label}`}>{step.info}</InfoDot>
      <span className="ml-auto flex items-center gap-2">{right}</span>
    </li>
  );
}
