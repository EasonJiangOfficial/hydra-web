"use client";

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type DataMessagePartProps,
  type TextMessagePartProps,
} from "@assistant-ui/react";
import { useAuiState } from "@assistant-ui/react";
import { ChevronRight, Plus } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useState, type ReactNode, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAgent } from "../context";
import { fillerOf, phaseOf, toThreadMessage, type Phase, type StepStatus } from "./model";

/*
 * The panel's conversation on assistant-ui (@assistant-ui/react, external store runtime): Hydra's controller stays
 * the one source of truth and assistant-ui renders it. `isRunning` stays false on purpose: a running thread locks
 * the composer, and the owner talks over Hydra the way he would a person. Hydra's own phase drives the working line.
 */
export function AgentRuntime({ children }: { children: ReactNode }) {
  const { ctl, state } = useAgent();
  const runtime = useExternalStoreRuntime({
    messages: state.thread,
    convertMessage: toThreadMessage,
    isRunning: false,
    onNew: async (m: AppendMessage) => {
      const text = m.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("")
        .trim();
      if (text) ctl.heard(text);
    },
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

const body = "text-body whitespace-pre-wrap text-ink";

/** The orb's dot language, small: five dots that brighten in a slow wave. Still dots under reduced motion. */
export function Dots({ className }: { className?: string }) {
  const still = useReducedMotion();
  return (
    <span aria-hidden className={cn("inline-flex items-center gap-[3px]", className)}>
      {[0, 1, 2, 3, 4].map((i) =>
        still ? (
          <span key={i} className="size-[3px] rounded-full bg-ink-3 opacity-60" />
        ) : (
          <motion.span
            key={i}
            className="size-[3px] rounded-full bg-ink"
            initial={{ opacity: 0.18 }}
            animate={{ opacity: [0.18, 0.75, 0.18] }}
            transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity, delay: i * 0.14 }}
          />
        ),
      )}
    </span>
  );
}

/** While Hydra thinks or runs a tool: the dots, and the line it is saying meanwhile ("Let me check"), faint. */
function Working({ phase, filler }: { phase: Phase; filler: string | null }) {
  return (
    <motion.div
      role="status"
      aria-label={phase === "checking" ? "Checking" : "Thinking"}
      data-testid="agent-working"
      data-phase={phase}
      className="flex min-h-6 items-center gap-2.5"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.2 } }}
    >
      <Dots />
      {filler && (
        <span data-testid="agent-filler" className="text-body text-ink-3">
          {filler}
        </span>
      )}
    </motion.div>
  );
}

function Text({ text }: TextMessagePartProps) {
  return <p className={body}>{text}</p>;
}

function StepMark({ status }: { status: StepStatus }) {
  const still = useReducedMotion();
  if (status === "running")
    return still ? (
      <span className="size-1.5 flex-none rounded-full bg-ink-3" />
    ) : (
      <motion.span
        className="size-1.5 flex-none rounded-full bg-ink"
        initial={{ opacity: 0.25 }}
        animate={{ opacity: [0.25, 0.9, 0.25] }}
        transition={{ duration: 1.2, ease: "easeInOut", repeat: Infinity }}
      />
    );
  return <span className={cn("size-1.5 flex-none rounded-full", status === "error" ? "border border-ink" : "bg-rule-2")} />;
}

type StepData = { text: string; tool: string | null; status: StepStatus };

/** A tool run or the words before it: one small gray line, never spoken. Click to read all of it. */
function Step({ data }: DataMessagePartProps<StepData>) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="agent-step" data-status={data.status} className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group/step -mx-1 flex min-h-6 items-center gap-2 rounded-md px-1 text-left text-tag text-ink-3 outline-none transition-colors duration-200 ease-hydra hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
      >
        <StepMark status={data.status} />
        <span className={cn("min-w-0 flex-1", !open && "truncate")}>{data.text}</span>
        <ChevronRight
          aria-hidden
          strokeWidth={1.5}
          className={cn("size-3 flex-none opacity-0 transition-[opacity,transform] duration-200 ease-hydra group-hover/step:opacity-100", open && "rotate-90 opacity-100")}
        />
      </button>
      {open && data.tool && <span className="pl-[14px] text-tag text-ink-3">{data.tool}</span>}
    </div>
  );
}

function UserMessage() {
  // Words added while Hydra worked (0191): the same turn, so a quieter outlined line with a plus, not a new question.
  const added = useAuiState((s) => s.message.metadata.custom?.added === true);
  return (
    <MessagePrimitive.Root
      data-role="user"
      data-added={added ? "" : undefined}
      data-testid={added ? "agent-added-line" : undefined}
      className={cn(body, "ml-auto max-w-[85%] rounded-lg px-3 py-2", added ? "-mt-1 flex items-start gap-1.5 border border-rule text-ink-2" : "bg-tint")}
    >
      {added && (
        <>
          <Plus aria-hidden strokeWidth={1.5} className="mt-[3px] size-3.5 flex-none text-ink-3" />
          <span className="sr-only">Added: </span>
        </>
      )}
      <span>
        <MessagePrimitive.Parts>{({ part }) => (part.type === "text" ? part.text : null)}</MessagePrimitive.Parts>
      </span>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  // Who answered (the model event): a hover, never a line of its own.
  const model = useAuiState((s) => s.message.metadata.custom?.model);
  return (
    <MessagePrimitive.Root data-role="hydra" title={typeof model === "string" ? model : undefined} className="flex flex-col gap-1 empty:hidden">
      <MessagePrimitive.Parts components={{ Text, data: { by_name: { step: Step } } }} />
    </MessagePrimitive.Root>
  );
}

/** The conversation: the turns, the Mac's live words, the working line, a live confirm and the last error. */
export function Thread() {
  const { ctl, state } = useAgent();
  const phase = phaseOf(state);
  const filler = fillerOf(state);
  const live = state.desktop && (state.heard || state.reply);
  const empty = state.thread.length === 0 && !state.interim && !live;
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport
        autoScroll
        role="log"
        aria-label="Thread"
        aria-live="polite"
        data-testid="agent-thread"
        className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-1"
      >
        {empty && <p className="text-body text-ink-3">Nothing yet.</p>}
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        {live && (
          <div data-testid="agent-panel-live" className="flex flex-col gap-4">
            {state.heard && (
              <div data-role="user" className={cn(body, "ml-auto max-w-[85%] rounded-lg bg-tint px-3 py-2")}>
                {state.heard}
              </div>
            )}
            {state.reply && (
              <p data-role="hydra" className={body}>
                {state.reply}
              </p>
            )}
          </div>
        )}
        {state.interim && <p className={cn(body, "ml-auto max-w-[85%] rounded-lg border border-dashed border-rule-2 px-3 py-2 text-ink-3")}>{state.interim}</p>}
        {(phase === "thinking" || phase === "checking") && <Working phase={phase} filler={filler} />}
        {state.confirm && (
          <div
            role="alertdialog"
            aria-label="Confirm"
            data-testid="agent-confirm"
            data-danger={state.confirm.danger || undefined}
            className={cn("flex flex-col gap-2.5 rounded-lg border p-3", state.confirm.danger ? "border-ink" : "border-rule-2")}
          >
            <p className={body}>{state.confirm.prompt}</p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => ctl.decide(state.confirm!.id, true)}>
                Approve
              </Button>
              <Button onClick={() => ctl.decide(state.confirm!.id, false)}>Decline</Button>
            </div>
          </div>
        )}
        {/* A brain failure already says itself in the header, with its info dot. */}
        {state.error && !(state.macIssue && !state.desktop) && (
          <p role="alert" data-testid="agent-error" className="text-body text-ink-3">
            {state.error}
          </p>
        )}
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

/** The typed input, at the bottom. Enter sends; Shift+Enter is a new line. */
export function Composer({ inputRef }: { inputRef?: Ref<HTMLTextAreaElement> }) {
  return (
    <ComposerPrimitive.Root className="flex flex-none items-end gap-2">
      <ComposerPrimitive.Input
        ref={inputRef}
        aria-label="Message Hydra"
        placeholder="Type to Hydra"
        autoComplete="off"
        submitMode="enter"
        rows={1}
        maxRows={5}
        className="min-h-[34px] min-w-0 flex-1 resize-none rounded-lg border border-rule-2 bg-transparent px-3 py-[7px] text-body text-ink outline-none transition-colors duration-200 ease-hydra placeholder:text-ink-3 focus-visible:border-ink"
      />
      <ComposerPrimitive.Send asChild>
        <Button type="submit">Send</Button>
      </ComposerPrimitive.Send>
    </ComposerPrimitive.Root>
  );
}
