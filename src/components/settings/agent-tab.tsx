"use client";

import { useEffect, useId, useRef, useState } from "react";

import { APPROVE_ALL_INFO } from "@/components/agent/controller";
import { Switch } from "@/components/agent/orb-menu";
import { Card, InfoDot, Input, Label, Seg } from "@/components/kit";
import { FieldRow, SaveLabel, type SaveState } from "@/components/planning/controls";
import { Select } from "@/components/ui/select";
import { clampEffort, EFFORT_LABEL, effortsOf, MODEL_IDS, MODELS, providerOf, type Effort, type Provider } from "@/lib/agent/models";
import { AGENT_DEFAULTS, LEVELS, type AgentSettingsPatch, type AgentSettingsView } from "@/lib/agent/settings-client";

import { AvatarsCard } from "./avatars-card";
import { ModelsCard } from "./models-card";
import { useSettings } from "./store";

const LEVEL_ITEMS = LEVELS.map((l) => ({ value: l, label: l[0]!.toUpperCase() + l.slice(1) }));
/** The models of the connected providers, and the picked one even when its provider just went away. */
const modelItems = (providers: Provider[], picked: string) =>
  MODEL_IDS.filter((id) => id === picked || providers.includes(MODELS[id].provider)).map((id) => ({ value: id, label: MODELS[id].name }));
const effortItems = (model: string) => effortsOf(model).map((e) => ({ value: e, label: EFFORT_LABEL[e] }));

/**
 * An effort row: the model's levels (up to five) as a Seg that fills the row. In a narrow card (a phone, two columns on a
 * tablet) the label sits above it, so Low..Max never spill out of the card.
 */
function EffortRow({ label, model, value, onChange }: { label: string; model: string; value: Effort; onChange: (v: Effort) => void }) {
  return (
    <div className="flex min-h-[46px] flex-col gap-2 border-t border-rule py-2 first:border-t-0 @md:flex-row @md:items-center @md:gap-3">
      <Label as="span" className="w-24 shrink-0">
        {label}
      </Label>
      <Seg
        aria-label={`Effort ${label.toLowerCase()}`}
        items={effortItems(model)}
        value={value}
        onValueChange={(v) => onChange(v as Effort)}
        className="flex w-full min-w-0 shrink *:flex-1 *:px-1"
      />
    </div>
  );
}

/** A text setting saved on blur or Enter. A refused value goes back to the saved one. */
function TextField({ id, value, max, onSave }: { id: string; value: string; max: number; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value);
  }
  return (
    <Input
      id={id}
      value={text}
      maxLength={max}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() !== value && onSave(text.trim())}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="flex-1"
    />
  );
}

/**
 * The shared agent settings (W6 contract): model, effort live and for routines, approve all (0200), wake phrase, sleep
 * word, clap sensitivity, the active avatar (0220, with the Avatars card). Read from GET /api/agent/state, each change saved with PATCH; Hydra Desktop and the orb menu read
 * the same values (0190). The fields show once GET answers; if it fails, only the error shows (nothing to save over).
 */
export function AgentTab() {
  const { actions } = useSettings();
  const uid = useId();
  const [view, setView] = useState<AgentSettingsView>(AGENT_DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  /** The providers the owner can pick now (GET `providers`; Claude only from an older server). */
  const [providers, setProviders] = useState<Provider[]>(["anthropic"]);
  /** The newest save of each field: an older save's answer never paints over a newer one. */
  const newest = useRef<Partial<Record<keyof AgentSettingsView, number>>>({});
  const saves = useRef(0);

  useEffect(() => {
    let live = true;
    void actions.agentSettings().then((r) => {
      if (!live) return;
      setLoaded(true);
      if (r.ok) {
        setView((v) => ({ ...v, ...r.settings }));
        if (r.providers) setProviders(r.providers);
        setReady(true);
      } else setError(r.message);
    });
    return () => {
      live = false;
    };
  }, [actions]);

  async function save(patch: AgentSettingsPatch) {
    const id = ++saves.current;
    // A model change moves both efforts too (the server clamps them to the model's levels): this save owns them.
    const keys = [...new Set([...Object.keys(patch), ...(patch.model ? ["effortLive", "effortRoutine"] : [])])] as (keyof AgentSettingsView)[];
    const before = { ...view };
    for (const k of keys) newest.current[k] = id;
    setView((v) => {
      const next = { ...v, ...patch } as AgentSettingsView;
      return patch.model ? { ...next, effortLive: clampEffort(patch.model, next.effortLive), effortRoutine: clampEffort(patch.model, next.effortRoutine) } : next;
    });
    setState("saving");
    setError("");
    const r = await actions.saveAgentSettings(patch);
    // Only the fields this save is still the newest for: the server's value on success, the old one on failure.
    const from: AgentSettingsView = r.ok ? { ...before, ...r.settings } : before;
    const mine = keys.filter((k) => newest.current[k] === id);
    setView((v) => ({ ...v, ...Object.fromEntries(mine.map((k) => [k, from[k]])) }));
    if (id === saves.current) setState(r.ok ? "saved" : "error");
    if (!r.ok) setError(r.message);
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-5" data-loaded={loaded}>
      {ready && (
      <Card aria-label="Brain">
        <div className="flex items-center gap-2">
          <Label>Brain</Label>
          <InfoDot label="About the brain">The model Hydra thinks with, and how hard: Live is the voice and chat, Routines run on their own.</InfoDot>
          <div className="flex-1" />
          <SaveLabel state={state} />
        </div>
        <div className="@container">
          <FieldRow label="Model" htmlFor={`${uid}-model`}>
            <Select id={`${uid}-model`} aria-label="Model" options={modelItems(providers, view.model)} value={view.model} onValueChange={(v) => void save({ model: v as AgentSettingsView["model"] })} className="flex-1" />
            {providerOf(view.model) === "openai" && <InfoDot label="About ChatGPT">ChatGPT runs on your Mac, on its ChatGPT sign-in. When the Mac is off, Claude answers.</InfoDot>}
          </FieldRow>
          <EffortRow label="Live" model={view.model} value={view.effortLive} onChange={(v) => void save({ effortLive: v })} />
          <EffortRow label="Routines" model={view.model} value={view.effortRoutine} onChange={(v) => void save({ effortRoutine: v })} />
          <FieldRow label="Approve all">
            <button
              type="button"
              role="switch"
              aria-checked={view.approveAll}
              aria-label="Approve all"
              onClick={() => void save({ approveAll: !view.approveAll })}
              className="relative -m-1.5 inline-grid place-items-center rounded-md p-1.5 outline-none focus-visible:outline-2 focus-visible:outline-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:content-['']"
            >
              <Switch on={view.approveAll} />
            </button>
            <InfoDot label="About approve all">{APPROVE_ALL_INFO}</InfoDot>
          </FieldRow>
        </div>
      </Card>
      )}
      {ready && (
      <Card aria-label="Voice">
        <div className="flex items-center gap-2">
          <Label>Voice</Label>
          <InfoDot label="About the voice">Hydra Desktop wakes on the wake phrase or a double clap, and sleeps on the sleep word.</InfoDot>
          <div className="flex-1" />
        </div>
        <div>
          <FieldRow label="Wake phrase" htmlFor={`${uid}-wake`}>
            <TextField id={`${uid}-wake`} value={view.wakePhrase} max={40} onSave={(v) => void save({ wakePhrase: v })} />
          </FieldRow>
          <FieldRow label="Sleep word" htmlFor={`${uid}-sleep`}>
            <TextField id={`${uid}-sleep`} value={view.sleepWord} max={60} onSave={(v) => void save({ sleepWord: v })} />
          </FieldRow>
          <FieldRow label="Clap">
            <Seg aria-label="Clap sensitivity" items={LEVEL_ITEMS} value={view.clapSensitivity} onValueChange={(v) => void save({ clapSensitivity: v as AgentSettingsView["clapSensitivity"] })} />
          </FieldRow>
        </div>
      </Card>
      )}
      {ready && actions.modelKeys && (
        <ModelsCard client={actions.modelKeys} providers={providers} onProviders={setProviders} onSettings={(settings) => setView((v) => ({ ...v, ...settings }))} />
      )}
      {ready && actions.avatars && <AvatarsCard client={actions.avatars} active={view.activeAvatarId} onActivate={(id) => void save({ activeAvatarId: id })} />}
      {error && (
        <p role="alert" className="text-label text-ink-2 md:col-span-2">
          {error}
        </p>
      )}
    </div>
  );
}
