"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Orb } from "@/components/agent/orb";
import { useAgent } from "@/components/agent/context";
import { syntheticBands } from "@/components/agent/speaker";
import { STATUS_LABEL, type AgentStatus } from "@/components/agent/types";
import { applyPanelPreset } from "./panel-presets";

const STATUSES: AgentStatus[] = ["asleep", "listening", "thinking", "speaking"];

/** A made-up voice: a few sines, so the demo orbs ripple the way a real level would. */
const voice = () => {
  const t = performance.now() / 1000;
  return Math.max(0, 0.45 + 0.3 * Math.sin(t * 7.3) + 0.2 * Math.sin(t * 17.1));
};

/** A made-up spectrum for the speaking demos (the same stand-in the browser voice uses), so the gallery shows the spikes. */
const spectrum = (out: Float32Array) => (syntheticBands(out, performance.now() / 1000, voice()), true);

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
          getLevel={status === "listening" || status === "speaking" ? voice : undefined}
          getBands={status === "speaking" ? spectrum : undefined}
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
    </div>
  );
}
