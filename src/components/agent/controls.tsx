"use client";

import { Maximize2, Pause, Play, Square, SquareArrowOutUpRight, Volume2, VolumeX } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAgent } from "./context";

/** Hover info (no subtext on the page): a kit tooltip around one control. */
export function Tip({ label, children, side = "top" }: { label: string; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

const icon =
  "inline-grid size-7 flex-none place-items-center rounded-md border border-rule-2 text-ink-3 outline-none transition-colors duration-200 hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-tint aria-pressed:text-ink";

/**
 * Mute (Hydra's voice), pause (its speech), stop (speech, listening and the turn; never off), and optionally expand
 * and detach. Outlined icon buttons. Under an older Hydra Desktop (no v3 voice controls) mute and pause are off.
 */
export function AgentControls({ expand = false, detach = false, className }: { expand?: boolean; detach?: boolean; className?: string }) {
  const { ctl, state } = useAgent();
  const voiceOff = state.desktop && !state.can.voice;
  const speaking = state.status === "speaking";
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Tip label={state.muted ? "Unmute Hydra" : "Mute Hydra"}>
        <button type="button" aria-label={state.muted ? "Unmute Hydra" : "Mute Hydra"} aria-pressed={state.muted} disabled={voiceOff} onClick={ctl.toggleMute} className={icon}>
          {state.muted ? <VolumeX aria-hidden className="size-3.5" strokeWidth={1.5} /> : <Volume2 aria-hidden className="size-3.5" strokeWidth={1.5} />}
        </button>
      </Tip>
      <Tip label={state.paused ? "Resume" : "Pause"}>
        <button type="button" aria-label={state.paused ? "Resume" : "Pause"} aria-pressed={state.paused} disabled={!speaking || voiceOff} onClick={ctl.togglePause} className={icon}>
          {state.paused ? <Play aria-hidden className="size-3.5" strokeWidth={1.5} /> : <Pause aria-hidden className="size-3.5" strokeWidth={1.5} />}
        </button>
      </Tip>
      <Tip label="Stop">
        <button type="button" aria-label="Stop" onClick={ctl.stop} className={icon}>
          <Square aria-hidden className="size-3" strokeWidth={1.5} />
        </button>
      </Tip>
      {expand && (
        <Tip label="Open the thread">
          <button type="button" aria-label="Open the thread" onClick={() => ctl.setExpanded(true)} className={icon}>
            <Maximize2 aria-hidden className="size-3.5" strokeWidth={1.5} />
          </button>
        </Tip>
      )}
      {detach && state.desktop && state.can.detach && (
        <Tip label="Detach">
          <button type="button" aria-label="Detach" data-testid="agent-detach" onClick={ctl.detach} className={icon}>
            <SquareArrowOutUpRight aria-hidden className="size-3.5" strokeWidth={1.5} />
          </button>
        </Tip>
      )}
    </div>
  );
}
