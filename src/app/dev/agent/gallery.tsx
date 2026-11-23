"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Orb } from "@/components/agent/orb";
import { useAgent } from "@/components/agent/context";
import { STATUS_LABEL, type AgentStatus } from "@/components/agent/types";
import { applyPanelPreset } from "./panel-presets";

const STATUSES: AgentStatus[] = ["asleep", "listening", "thinking", "speaking"];

/** Deterministic noise per syllable: the demo voice is the same on every replay, so frames compare. */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const bump = (d: number, w: number) => Math.exp(-(d * d) / (2 * w * w));
const SYL = 0.19;
const PER_PHRASE = 9;
const PHRASE = PER_PHRASE * SYL + 0.45;

/**
 * A made-up voice, speech-like: syllables of about 190 ms in phrases of nine, then a breath. Each syllable has its own
 * stress, two formants and a pitch band; some open with a hiss in the top bands. Writes 24 bands (0..1, low to high)
 * into `out` when given; returns the level. `voice` picks a second speaker (the owner while listening).
 */
function speechDemo(t: number, out?: Float32Array, voice = 0): number {
  const k = Math.floor(t / PHRASE);
  const u = t - k * PHRASE;
  const j = Math.floor(u / SYL);
  if (j >= PER_PHRASE) {
    out?.fill(0);
    return 0;
  }
  const f = (u - j * SYL) / SYL;
  const id = (k * PER_PHRASE + j) * 1.37 + voice * 91;
  const env = Math.sin(Math.PI * Math.min(1, f * 1.15)) ** 2;
  const level = (0.5 + 0.5 * hash(id)) * env;
  if (out) {
    const f1 = 4 + 5 * hash(id + 0.3) + voice;
    const f2 = 11 + 7 * hash(id + 0.7);
    const pitch = 1.5 + 1.5 * hash(k + voice) + 1.2 * f;
    const hiss = hash(id + 0.9) > 0.7 && f < 0.3 ? (1 - f / 0.3) * 0.8 : 0;
    for (let b = 0; b < out.length; b++) {
      const v = level * (0.95 * bump(b - f1, 1.6) + 0.65 * bump(b - f2, 2.1) + 0.55 * bump(b - pitch, 1.1)) + hiss * bump(b - 20.5, 2);
      out[b] = Math.min(1, v);
    }
  }
  return level;
}

/** A demo voice for an orb: level and bands from speechDemo, counted from `start` (performance.now() ms). */
function demoSource(start: () => number, voice: number) {
  return {
    level: () => speechDemo((performance.now() - start()) / 1000, undefined, voice),
    bands: (out: Float32Array) => (speechDemo((performance.now() - start()) / 1000, out, voice), true),
  };
}
const ALWAYS = demoSource(() => 0, 0);
const OWNER = demoSource(() => 0, 1);
/** The lab's replay clock (one lab per page): a replay sets it, its voices count from it. */
const lab = { start: 0 };
const LAB_HYDRA = demoSource(() => lab.start, 0);
const LAB_OWNER = demoSource(() => lab.start, 1);

function Demo({ status, tone }: { status: AgentStatus; tone: "ink" | "white" }) {
  const dark = tone === "white";
  return (
    <figure
      data-testid={`demo-${tone}-${status}`}
      className={`m-0 flex flex-col items-center gap-3 rounded-xl p-5 ${dark ? "bg-ink text-white" : "border border-rule text-ink"}`}
    >
      <div className="size-[140px]">
        <Orb
          status={status}
          tone={tone}
          getLevel={status === "speaking" ? ALWAYS.level : status === "listening" ? OWNER.level : undefined}
          getBands={status === "speaking" ? ALWAYS.bands : status === "listening" ? OWNER.bands : undefined}
        />
      </div>
      <figcaption className={`text-label ${dark ? "text-ink-on-dark-3" : "text-ink-3"}`}>{STATUS_LABEL[status]}</figcaption>
    </figure>
  );
}

/** Hydra Desktop's clap or phrase wake (it never comes from the web): the burst, then the awake shimmer. */
function WokeDemo() {
  const [wokeAt, setWokeAt] = useState<number | null>(null);
  return (
    <figure data-testid="demo-woke" className="m-0 flex flex-col items-center gap-3 rounded-xl border border-rule p-5 text-ink">
      <div className="size-[140px]">
        <Orb status="listening" wokeAt={wokeAt} />
      </div>
      <figcaption className="flex flex-col items-center gap-2 text-label text-ink-3">
        Woke
        <Button size="default" variant="outline" data-testid="replay-wake" onClick={() => setWokeAt(Date.now())}>
          Replay wake
        </Button>
      </figcaption>
    </figure>
  );
}

const LAB: { look: AgentStatus | "woke"; label: string }[] = [
  { look: "asleep", label: "Asleep" },
  { look: "listening", label: "Listening" },
  { look: "thinking", label: "Pending" },
  { look: "speaking", label: "Speaking" },
  { look: "woke", label: "Wake" },
];

/**
 * The orb lab: one look at 240 px and at 96 px (the sidebar card's size), with a replay per look. A replay restarts the
 * demo voice from its first syllable (speaking is Hydra's voice, listening the owner's) and a wake replays the burst,
 * so frames from two runs line up. Hover and press the orbs to see them lean and ripple.
 */
function OrbLab() {
  const [look, setLook] = useState<AgentStatus | "woke">("listening");
  const [wokeAt, setWokeAt] = useState<number | null>(null);
  const status: AgentStatus = look === "woke" ? "listening" : look;
  const src = status === "speaking" ? LAB_HYDRA : status === "listening" ? LAB_OWNER : null;
  const orb = (px: number) => (
    <div className="flex flex-col items-center gap-2">
      <div style={{ width: px, height: px }}>
        <Orb status={status} getLevel={src?.level} getBands={src?.bands} wokeAt={look === "woke" ? wokeAt : null} />
      </div>
      <span className="text-label text-ink-3">{px} px</span>
    </div>
  );
  return (
    <section data-testid="orb-lab" data-look={look} className="flex flex-col gap-5 rounded-xl border border-rule p-6">
      <div className="flex flex-wrap items-center gap-2">
        {LAB.map((l) => (
          <Button
            key={l.look}
            size="default"
            variant={look === l.look ? "primary" : "outline"}
            data-testid={`lab-${l.look}`}
            onClick={() => {
              lab.start = performance.now();
              setLook(l.look);
              setWokeAt(l.look === "woke" ? Date.now() : null);
            }}
          >
            {l.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-end justify-center gap-12">
        {orb(240)}
        {orb(96)}
      </div>
    </section>
  );
}

export function Gallery() {
  const { ctl } = useAgent();
  // `?panel=<preset>` opens the panel in one of its states; e2e calls window.__agentPreset(name) after load.
  useEffect(() => {
    const w = window as unknown as { __agentPreset?: (name: string) => boolean };
    w.__agentPreset = (name) => applyPanelPreset(ctl, name);
    const name = new URLSearchParams(window.location.search).get("panel");
    const t = name ? setTimeout(() => applyPanelPreset(ctl, name), 600) : undefined;
    return () => {
      clearTimeout(t);
      delete w.__agentPreset;
    };
  }, [ctl]);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-4">
        <h1 className="flex-1 text-title text-ink">Hydra Agent</h1>
        <Button
          data-testid="run-script"
          onClick={() => {
            ctl.setExpanded(true);
            ctl.wake();
            ctl.submit("Add a coffee");
          }}
        >
          Run the script
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {STATUSES.map((s) => (
          <Demo key={s} status={s} tone="ink" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {STATUSES.map((s) => (
          <Demo key={s} status={s} tone="white" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <WokeDemo />
      </div>
      <OrbLab />
    </div>
  );
}
