"use client";

import { Check, ChevronDown, SquareArrowDownLeft, SquareArrowOutUpRight } from "lucide-react";
import { Popover, RadioGroup } from "radix-ui";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { InfoDot } from "@/components/kit/hover-card";
import { EFFORT_INFO, EFFORT_LABEL, effortsOf, MODELS, modelsOf, PROVIDER_LABEL, PROVIDERS, providerOf, type Provider } from "@/lib/agent/models";
import { cn } from "@/lib/utils";
import { useAgent } from "./context";
import { APPROVE_ALL_INFO, LEVELS, type Level } from "./controller";

const row = "flex min-h-9 w-full items-center gap-3 px-3 text-label text-ink";
const press =
  "outline-none transition-colors duration-200 ease-hydra hover:bg-tint focus-visible:bg-tint disabled:pointer-events-none disabled:opacity-40";
const tag = "flex items-center gap-1.5 text-tag text-ink-3";
const LEVEL_ITEMS = LEVELS.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));

/**
 * Hydra's options (owner: "if I tapped on the hydra visualizer icon it would give me options and sleep word would be an
 * option"). Opens from the small orb in the panel header (and the name beside it); the big orb keeps its tap map.
 * Wake phrase, sleep word, model, effort, clap sensitivity, avatar (0220), approve all (all shared through PATCH /api/agent/state), mute, and on
 * Hydra Desktop detach or attach. Every edit happens inside it: a popover, not a menu, so a field never closes it.
 * `children` is the header group it anchors to; it holds <OrbMenuName>.
 */
export function OrbMenu({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const { ctl, state } = useAgent();
  const voiceOff = state.desktop && !state.can.voice;
  const s = state.settings;
  // While more of the menu is below (a phone with everything on), a fade at the bottom says it scrolls.
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = box.current;
    setMore(!!el && el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  }, []);
  // Each render: a row may have come or gone (providers, avatars).
  useLayoutEffect(measure);
  // The portal mounts a render after `open`, and the popper caps the height after that: watch the element itself.
  const watch = useCallback(
    (el: HTMLDivElement | null) => {
      box.current = el;
      if (!el) return;
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => {
        ro.disconnect();
        box.current = null;
      };
    },
    [measure],
  );
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor asChild>{children}</Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          ref={watch}
          onScroll={measure}
          align="start"
          sideOffset={8}
          collisionPadding={12}
          data-testid="agent-orb-options"
          onOpenAutoFocus={(e) => e.preventDefault()}
          // Radix hears Escape first (document, capture): in a field with an unsaved edit it only undoes the edit.
          onEscapeKeyDown={(e) => {
            if ((e.target as Element | null)?.closest?.("[data-dirty]")) e.preventDefault();
          }}
          // The header orb toggles it itself: its tap is not an outside tap.
          onInteractOutside={(e) => {
            if ((e.target as Element | null)?.closest?.("[data-orb-menu]")) e.preventDefault();
          }}
          className="z-[60] flex w-[288px] max-w-[calc(100vw-24px)] max-h-(--radix-popover-content-available-height) origin-(--radix-popover-content-transform-origin) flex-col overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border border-rule bg-surface py-1 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=open]:slide-in-from-top-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none"
        >
          <Field key={`w${s.wakePhrase}`} label="Wake phrase" value={s.wakePhrase} max={40} testId="agent-wake-phrase" onSave={(v) => void ctl.setSetting({ wakePhrase: v })} />
          <Field key={`s${state.sleepWord}`} label="Sleep word" value={state.sleepWord} max={60} testId="agent-sleep-word" onSave={(v) => void ctl.setSleepWord(v)} />
          <div className="mx-3 border-t border-rule" />
          <ModelPick providers={state.providers} model={s.model} onChange={(model) => void ctl.setSetting({ model })} />
          <Setting label="Effort" info="How hard Hydra thinks when you talk to it. Routines keep their own.">
            <Choice
              label="Effort"
              testId="agent-effort"
              // Five levels fit the 288 px menu with Medium as "Med" (its full name is the radio's name).
              items={effortsOf(s.model).map((e) => ({ value: e, label: e === "medium" ? "Med" : EFFORT_LABEL[e], name: EFFORT_LABEL[e], info: EFFORT_INFO[e] }))}
              value={s.effortLive}
              onChange={(effortLive) => void ctl.setSetting({ effortLive })}
            />
          </Setting>
          <Setting label="Clap sensitivity" info="Applies to Hydra Desktop: how easily a double clap wakes it.">
            <Choice label="Clap sensitivity" items={LEVEL_ITEMS} value={s.clapSensitivity} onChange={(v) => void ctl.setSetting({ clapSensitivity: v as Level })} />
          </Setting>
          {!!state.avatars?.length && (
            <Setting label="Avatar" info="Who Hydra speaks and talks as, on every device. Make avatars in Settings, Agent.">
              <AvatarPick avatars={state.avatars} value={state.activeAvatarId ?? null} onChange={(id) => void ctl.setAvatar(id)} />
            </Setting>
          )}
          <div className="mx-3 mt-1 border-t border-rule" />
          <button type="button" role="switch" aria-checked={state.muted} disabled={voiceOff} onClick={ctl.toggleMute} className={cn(row, press)}>
            <span className="flex-1 text-left">Mute</span>
            <Switch on={state.muted} />
          </button>
          {/* The whole row toggles; the info dot sits above it and only explains. */}
          <div className={cn(row, "relative")}>
            <button
              type="button"
              role="switch"
              aria-checked={s.approveAll}
              aria-label="Approve all"
              data-testid="agent-approve-all"
              onClick={() => void ctl.setSetting({ approveAll: !s.approveAll })}
              className={cn("absolute inset-0", press)}
            />
            <span className="pointer-events-none relative">Approve all</span>
            <InfoDot label="About approve all" className="relative -ml-1.5 size-4 text-[10px]">
              {APPROVE_ALL_INFO}
            </InfoDot>
            <span className="pointer-events-none relative ml-auto flex">
              <Switch on={s.approveAll} />
            </span>
          </div>
          {state.desktop && state.can.detach && (
            <button
              type="button"
              data-testid="agent-menu-detach"
              onClick={() => {
                onOpenChange(false);
                if (state.detached) ctl.attach();
                else ctl.detach();
              }}
              className={cn(row, press)}
            >
              <span className="flex-1 text-left">{state.detached ? "Attach" : "Detach"}</span>
              {state.detached ? (
                <SquareArrowDownLeft aria-hidden className="size-3.5 text-ink-3" strokeWidth={1.5} />
              ) : (
                <SquareArrowOutUpRight aria-hidden className="size-3.5 text-ink-3" strokeWidth={1.5} />
              )}
            </button>
          )}
          <div
            aria-hidden
            data-testid="agent-orb-more"
            data-more={more || undefined}
            className={cn(
              "pointer-events-none sticky -bottom-1 -mt-12 h-12 shrink-0 bg-linear-to-t from-surface from-15% to-transparent transition-opacity duration-200 ease-hydra",
              more ? "opacity-100" : "opacity-0",
            )}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** "Hydra" in the panel header: the same options as the header orb. */
export function OrbMenuName({ children }: { children: ReactNode }) {
  return (
    <Popover.Trigger
      aria-label="Hydra options"
      data-testid="agent-orb-menu"
      data-orb-menu=""
      className="group/om -ml-1.5 inline-flex h-[30px] items-center gap-1 rounded-md px-1.5 text-label text-ink-3 outline-none transition-colors duration-200 ease-hydra hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-ink data-[state=open]:bg-tint data-[state=open]:text-ink"
    >
      {children}
      <ChevronDown aria-hidden strokeWidth={1.5} className="size-3.5 flex-none transition-transform duration-200 ease-hydra group-data-[state=open]/om:rotate-180" />
    </Popover.Trigger>
  );
}

function Setting({ label, info, children }: { label: string; info?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 pt-2 pb-1.5">
      <span className={tag}>
        {label}
        {info && (
          <InfoDot label={`About ${label.toLowerCase()}`} className="size-4 text-[10px]">
            {info}
          </InfoDot>
        )}
      </span>
      {children}
    </div>
  );
}

/**
 * Model (owner: "allow me to connected different models and switch between them and their effort levels like grok,
 * chatgpt"): the connected providers first (hidden while Claude is the only one, so it looks as before), then that
 * provider's models. Picking a provider picks its first model; the server clamps the efforts to the new model.
 */
function ModelPick({ providers, model, onChange }: { providers?: Provider[]; model: string; onChange: (model: string) => void }) {
  const current = providerOf(model) ?? "anthropic";
  // The picked model's provider stays shown even when it just went away (a Mac signed out), so the pick is visible.
  const shown = PROVIDERS.filter((p) => p === "anthropic" || p === current || providers?.includes(p));
  const info =
    current === "openai"
      ? "ChatGPT runs on your Mac, on its ChatGPT sign-in. When the Mac is off, Claude answers."
      : "Connect Grok in Settings, Agent. ChatGPT shows while your Mac is signed in to it.";
  return (
    <Setting label="Model" info={info}>
      {shown.length > 1 && (
        <Choice
          label="Provider"
          testId="agent-provider"
          items={shown.map((p) => ({ value: p, label: PROVIDER_LABEL[p], info: p === "openai" ? "Runs on your Mac" : undefined }))}
          value={current}
          onChange={(p) => p !== current && onChange(modelsOf(p as Provider)[0]!)}
        />
      )}
      <Choice label="Model" testId="agent-model" items={modelsOf(current).map((id) => ({ value: id, label: MODELS[id].label }))} value={model} onChange={onChange} />
    </Setting>
  );
}

/**
 * The kit Seg's look (tint track, outlined white thumb) as a radio group that fills the menu's width. The thumb moves by
 * CSS: the kit Seg's shared-layout thumb (motion layoutId) breaks inside a Radix popover's presence (a ref to motion's
 * MeasureLayout lands on it).
 */
function Choice({
  label,
  items,
  value,
  onChange,
  testId,
}: {
  label: string;
  /** `info`: the item's hover; `name`: its accessible name when the label is shortened. */
  items: readonly { value: string; label: string; name?: string; info?: string }[];
  value: string;
  onChange: (v: string) => void;
  testId?: string;
}) {
  const at = Math.max(0, items.findIndex((i) => i.value === value));
  const known = items.some((i) => i.value === value);
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={onChange}
      orientation="horizontal"
      loop
      aria-label={label}
      data-testid={testId}
      className="relative grid rounded-lg bg-tint p-0.5"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {known && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-md border border-rule-2 bg-surface transition-transform duration-200 ease-hydra motion-reduce:transition-none"
          style={{ width: `calc((100% - 4px) / ${items.length})`, transform: `translateX(${at * 100}%)` }}
        />
      )}
      {items.map((item) => (
        <RadioGroup.Item
          key={item.value}
          value={item.value}
          title={item.info}
          aria-label={item.name}
          className="relative h-7 truncate rounded-md pointer-coarse:h-8 px-1 text-label whitespace-nowrap text-ink-3 outline-none transition-colors duration-200 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink data-[state=checked]:font-medium data-[state=checked]:text-ink"
        >
          {item.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

/** The quick avatar switch (0220): Hydra's own voice first, then each avatar; the active one has the check. */
function AvatarPick({ avatars, value, onChange }: { avatars: { id: string; name: string }[]; value: string | null; onChange: (id: string | null) => void }) {
  const items = [{ id: "", name: "Hydra" }, ...avatars];
  return (
    <RadioGroup.Root
      value={value ?? ""}
      onValueChange={(v) => onChange(v || null)}
      orientation="vertical"
      loop
      aria-label="Avatar"
      data-testid="agent-avatar-pick"
      className="-mx-1.5 flex max-h-[148px] flex-col overflow-y-auto"
    >
      {items.map((a) => (
        <RadioGroup.Item
          key={a.id}
          value={a.id}
          className="group/av flex h-7 min-w-0 pointer-coarse:h-9 items-center gap-2 rounded-md px-1.5 text-left text-label text-ink-2 outline-none transition-colors duration-200 ease-hydra hover:bg-tint hover:text-ink focus-visible:bg-tint data-[state=checked]:font-medium data-[state=checked]:text-ink"
        >
          <span className="min-w-0 flex-1 truncate">{a.name}</span>
          <Check aria-hidden strokeWidth={1.75} className="size-3.5 flex-none opacity-0 group-data-[state=checked]/av:opacity-100" />
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

/** The menu's switch look (aria-hidden: the row around it is the switch). Settings uses it too. */
export function Switch({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={cn("flex h-4 w-7 flex-none items-center rounded-full border px-[3px] transition-colors duration-200 ease-hydra", on ? "border-ink bg-ink" : "border-rule-2")}>
      <span className={cn("size-2 rounded-full transition-transform duration-200 ease-hydra", on ? "translate-x-[10px] bg-white" : "bg-ink-3")} />
    </span>
  );
}

/**
 * A shared word or phrase, edited in place: saved on Enter or when the field loses focus (never a prompt that could
 * close the menu); Escape puts the saved one back. Keyed on the saved value, so a save from elsewhere shows at once.
 */
function Field({ label, value, max, testId, onSave }: { label: string; value: string; max: number; testId: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  const save = () => text.trim() !== value && onSave(text);
  return (
    <label className="flex flex-col gap-1.5 px-3 pt-2 pb-2.5">
      <span className={tag}>{label}</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape" && text !== value) {
            e.preventDefault();
            e.stopPropagation(); // the first Escape undoes the edit (data-dirty keeps the menu open); the next closes it
            setText(value);
          }
        }}
        maxLength={max}
        autoComplete="off"
        spellCheck={false}
        data-testid={testId}
        data-dirty={text !== value ? "" : undefined}
        className="h-[30px] min-w-0 rounded-lg border border-rule-2 bg-transparent px-2.5 text-label text-ink outline-none transition-colors duration-200 ease-hydra focus-visible:border-ink"
      />
    </label>
  );
}
