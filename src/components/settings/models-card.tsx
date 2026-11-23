"use client";

import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";

import { Button, Card, HoverCard, InfoDot, Input, Label, cn } from "@/components/kit";
import { SaveLabel, type SaveState } from "@/components/planning/controls";
import { PROVIDER_LABEL, type Provider } from "@/lib/agent/models";
import type { AgentSettingsView, ModelKeysClient, ModelKeyView } from "@/lib/agent/settings-client";

const CLAUDE_INFO = "Runs on your Claude login on Hydra Desktop and the Hydra server.";
const CHATGPT_INFO = "ChatGPT runs on your Mac. Sign in with ChatGPT in Hydra Desktop; it shows here while the Mac is on.";
const GROK_INFO = "Paste an xAI API key from console.x.ai. xAI bills it per token, apart from SuperGrok.";

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const added = (k: ModelKeyView) => `Key ending ••${k.hint}, added ${DAY.format(new Date(k.updatedAt))}`;

/**
 * Settings > Agent > Models (owner: "also could you allow me to connected different models and switch between them and
 * their effort levels like grok, chatgpt"). One row per provider, a filled dot when connected. Claude: always. ChatGPT:
 * signed in on the Mac (nothing to paste here). Grok: Connect pastes an xAI key (checked with xAI, stored sealed);
 * Remove always asks first. `onProviders` and `onSettings` tell the Agent tab what changed.
 */
export function ModelsCard({
  client,
  providers,
  onProviders,
  onSettings,
}: {
  client: ModelKeysClient;
  providers: Provider[];
  onProviders: (next: Provider[]) => void;
  onSettings: (settings: Partial<AgentSettingsView>) => void;
}) {
  const [keys, setKeys] = useState<ModelKeyView[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void client.list().then((r) => {
      if (!live) return;
      if (r.ok) setKeys(r.data);
      else setError(r.message);
    });
    return () => {
      live = false;
    };
  }, [client]);

  const grok = keys?.find((k) => k.provider === "xai") ?? null;
  const set = (p: Provider, on: boolean) => onProviders(on ? [...new Set([...providers, p])] : providers.filter((x) => x !== p));

  return (
    <Card aria-label="Models" className="md:col-span-2">
      <div className="flex items-center gap-2">
        <Label>Models</Label>
        <InfoDot label="About models">The models Hydra can think with. Pick one in the Brain card or the orb menu.</InfoDot>
        <div className="flex-1" />
      </div>
      <div data-testid="model-providers">
        <Row provider="anthropic" on info={CLAUDE_INFO} />
        <Row provider="openai" on={providers.includes("openai")} info={CHATGPT_INFO}>
          <span className="text-label text-ink-3">{providers.includes("openai") ? "On your Mac" : "Sign in on the Mac"}</span>
        </Row>
        <GrokRow
          client={client}
          keyRow={grok}
          loading={keys === null && !error}
          onConnected={(k) => {
            setKeys((list) => [...(list ?? []).filter((x) => x.provider !== k.provider), k]);
            set("xai", true);
          }}
          onRemoved={(settings) => {
            setKeys((list) => list?.filter((x) => x.provider !== "xai") ?? null);
            set("xai", false);
            if (settings) onSettings(settings);
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-label text-ink-2">
          {error}
        </p>
      )}
    </Card>
  );
}

function Row({ provider, on, info, children }: { provider: Provider; on: boolean; info: string; children?: ReactNode }) {
  return (
    <div data-provider={provider} data-connected={on} className="flex min-h-[46px] items-center gap-3 border-t border-rule py-2 first:border-t-0">
      <HoverCard content={info} align="start">
        <span tabIndex={0} className="flex min-w-0 items-center gap-2.5 rounded-md text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ink">
          <span aria-hidden className={cn("size-2 flex-none rounded-full border transition-colors duration-200 ease-hydra", on ? "border-ink bg-ink" : "border-ink-3")} />
          <span className="font-medium">{PROVIDER_LABEL[provider]}</span>
          <span className="sr-only">{on ? "connected" : "not connected"}</span>
        </span>
      </HoverCard>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

/** Grok: Connect opens the key field in the row; Save checks it with xAI. Connected: Remove, which asks first. */
function GrokRow({
  client,
  keyRow,
  loading,
  onConnected,
  onRemoved,
}: {
  client: ModelKeysClient;
  keyRow: ModelKeyView | null;
  loading: boolean;
  onConnected: (k: ModelKeyView) => void;
  onRemoved: (settings: Partial<AgentSettingsView> | null) => void;
}) {
  const uid = useId();
  const [mode, setMode] = useState<"idle" | "connect" | "remove">("idle");
  const [key, setKey] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");

  async function connect(e: FormEvent) {
    e.preventDefault();
    setState("saving");
    setError("");
    const r = await client.connect("xai", key);
    if (!r.ok) {
      setState("error");
      setError(r.message);
      return;
    }
    setKey("");
    setMode("idle");
    setState("saved");
    onConnected(r.data);
  }

  async function remove() {
    setState("saving");
    setError("");
    const r = await client.remove("xai");
    if (!r.ok) {
      setState("error");
      setError(r.message);
      return;
    }
    setMode("idle");
    setState("idle");
    onRemoved(r.data);
  }

  const cancel = () => {
    setMode("idle");
    setKey("");
    setError("");
    setState("idle");
  };

  return (
    <div className="border-t border-rule">
      <Row provider="xai" on={!!keyRow} info={keyRow ? added(keyRow) : GROK_INFO}>
        <SaveLabel state={state} />
        {!loading && mode === "idle" && (
          <Button type="button" variant="ghost" onClick={() => setMode(keyRow ? "remove" : "connect")} className="-mr-2.5">
            {keyRow ? "Remove" : "Connect"}
          </Button>
        )}
      </Row>
      {mode === "connect" && (
        <form onSubmit={(e) => void connect(e)} className="flex flex-col gap-2 pb-3">
          <div className="flex items-center gap-2">
            <label htmlFor={`${uid}-key`} className="sr-only">
              xAI API key
            </label>
            <Input
              id={`${uid}-key`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="xai-…"
              value={key}
              autoFocus
              aria-invalid={!!error || undefined}
              onChange={(e) => {
                setKey(e.target.value);
                if (error) setError("");
              }}
              onKeyDown={(e) => e.key === "Escape" && cancel()}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="primary" disabled={state === "saving" || key.trim().length === 0}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-label text-ink-2">
              {error}
            </p>
          )}
        </form>
      )}
      {mode === "remove" && (
        <div role="alertdialog" aria-label="Remove the Grok key" className="mb-3 flex flex-col gap-3 rounded-lg bg-tint px-3.5 py-3">
          <p>Remove the Grok key? Hydra goes back to Opus 5.5 if Grok is picked.</p>
          {error && (
            <p role="alert" className="text-label text-ink-2">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="primary" disabled={state === "saving"} onClick={() => void remove()}>
              Remove
            </Button>
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
