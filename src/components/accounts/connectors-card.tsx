"use client";

import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { Button, Card, InfoDot, Input, Label, ListRow, Pill } from "@/components/kit";
import { PushButton } from "@/components/pwa/push-button";
import { INSTAGRAM_SIGN_IN, instagramEnvNote, instagramNeedsGrant, instagramState } from "@/lib/instagram/model";

import { CONNECTORS } from "./connectors";
import { ago } from "./format";
import { useAccounts } from "./store";
import type { ActionResult, DeviceView, PairKind } from "./types";

type Key = keyof typeof CONNECTORS;

/** One connector: name, info dot, state on the right, its controls; lists and prompts below. */
function Row({ id, state, on, detail, controls, children }: { id: Key; state: string; on: boolean; detail?: ReactNode; controls?: ReactNode; children?: ReactNode }) {
  const { name, info } = CONNECTORS[id];
  return (
    <div data-connector={id} className="flex flex-col gap-3 border-t border-rule py-3.5 first:border-t-0 first:pt-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <span className="font-medium">{name}</span>
        <InfoDot label={`About ${name}`}>{info}</InfoDot>
        {detail && <span className="min-w-0 truncate text-label text-ink-3 max-md:order-last max-md:basis-full">{detail}</span>}
        <span className="flex-1" />
        <Pill tone={on ? "strong" : "default"}>{state}</Pill>
        {controls && <div className="flex items-center gap-2 max-md:order-last max-md:basis-full">{controls}</div>}
      </div>
      {children}
    </div>
  );
}

/** Every revoke and disconnect asks first, in place. */
function Confirm({ label, prompt, yes, onYes, onNo }: { label: string; prompt: string; yes: string; onYes: () => void; onNo: () => void }) {
  return (
    <div role="alertdialog" aria-label={label} className="flex flex-col gap-3 rounded-lg bg-tint px-3.5 py-3">
      <p>{prompt}</p>
      <div className="flex gap-2">
        <Button onClick={onYes}>{yes}</Button>
        <Button variant="ghost" onClick={onNo}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

function Problem({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-label text-ink-2">
      {error}
    </p>
  ) : null;
}

/** Runs one action, keeping its busy flag and its error message. */
function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<ActionResult<T>>): Promise<T | null> {
    setBusy(true);
    setError(null);
    const r = await action();
    setBusy(false);
    if (!r.ok) setError(r.error.message);
    return r.ok ? r.data : null;
  }
  return { busy, error, run };
}

/** Where Google's sign-in sent the owner back (/api/google/callback adds ?google=). */
const SIGN_IN_RESULT: Record<string, string> = {
  denied: "Google sign-in was cancelled.",
  error: "Google sign-in failed. Try again.",
  not_configured: "Google is not set up on the host yet.",
};

function GoogleRow() {
  const { data, actions } = useAccounts();
  const back = useSearchParams().get("google");
  const { google } = data;
  const [sure, setSure] = useState(false);
  const { busy, error, run } = useRun();
  const signedIn = !!google.email;
  const stale = signedIn && google.status !== "active";
  const connect = (label: string) =>
    google.configured ? (
      <Button asChild>
        <a href="/api/google/start">{label}</a>
      </Button>
    ) : (
      <>
        <Button disabled>{label}</Button>
        <InfoDot label="Why Google is off">Google is not set up yet. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and HYDRA_TOKEN_KEY on the host.</InfoDot>
      </>
    );
  return (
    <Row
      id="google"
      on={signedIn && !stale}
      state={stale ? "Sign in again" : signedIn ? "Connected" : "Not connected"}
      detail={google.email}
      controls={
        signedIn ? (
          <>
            {stale && connect("Sign in again")}
            <Button variant="ghost" disabled={busy || sure} onClick={() => setSure(true)}>
              Disconnect
            </Button>
          </>
        ) : (
          connect("Connect")
        )
      }
    >
      {sure && (
        <Confirm
          label="Disconnect Google"
          prompt={`Disconnect ${google.email}? Routines lose Gmail and Calendar.`}
          yes="Disconnect"
          onNo={() => setSure(false)}
          onYes={async () => {
            setSure(false);
            await run(() => actions.disconnectGoogle());
          }}
        />
      )}
      <Problem error={error ?? SIGN_IN_RESULT[back ?? ""] ?? null} />
    </Row>
  );
}

function InstagramRow() {
  const { data, actions } = useAccounts();
  const back = useSearchParams().get("instagram");
  const { instagram } = data;
  const [sure, setSure] = useState(false);
  // After Disconnect has answered, its answer replaces how the sign-in came back (?instagram=).
  const [acted, setActed] = useState(false);
  const { busy, error, run } = useRun();
  const state = instagramState(instagram);
  const handle = instagram.username ? `@${instagram.username}` : undefined;
  const connect = (label: string) =>
    instagram.missing.length === 0 ? (
      <Button asChild>
        <a href="/api/instagram/start?from=settings">{label}</a>
      </Button>
    ) : (
      <>
        <Button disabled>{label}</Button>
        <InfoDot label="Why Instagram is off">{instagramEnvNote(instagram.missing)}</InfoDot>
      </>
    );
  return (
    <Row
      id="instagram"
      // Login needed is bold, as in Bank feed: the owner has to act.
      on={!!handle}
      state={state === "reconnect" ? "Login needed" : handle ? "Connected" : "Not connected"}
      detail={handle && instagram.lastSyncedAt ? `${handle} · synced ${ago(instagram.lastSyncedAt, data.now)}` : handle}
      controls={
        handle ? (
          <>
            {/* Insights not granted or all refused: the sync runs, and Reconnect is there to allow them. */}
            {(state === "reconnect" || instagramNeedsGrant(instagram)) && connect("Reconnect")}
            <Button variant="ghost" disabled={busy || sure} onClick={() => setSure(true)}>
              Disconnect
            </Button>
          </>
        ) : (
          connect("Connect")
        )
      }
    >
      {sure && (
        <Confirm
          label="Disconnect Instagram"
          prompt={`Disconnect ${handle}? Hydra deletes its Instagram token and stops the daily sync. Saved posts and follower counts stay.`}
          yes="Disconnect"
          onNo={() => setSure(false)}
          onYes={async () => {
            setSure(false);
            setActed(true);
            await run(() => actions.disconnectInstagram());
          }}
        />
      )}
      <Problem error={error ?? (acted ? null : (INSTAGRAM_SIGN_IN[back ?? ""] ?? null))} />
    </Row>
  );
}

function GrokbotRow() {
  const { data, actions } = useAccounts();
  const keys = data.apiKeys;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("Grokbot");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const { busy, error, run } = useRun();

  async function create() {
    const made = await run(() => actions.createApiKey({ name }));
    if (!made) return;
    setNaming(false);
    setCopied(false);
    setSecret(made.secret);
  }

  const target = keys.find((k) => k.id === revoking);
  return (
    <Row
      id="grokbot"
      on={keys.length > 0}
      state={keys.length ? "Connected" : "Not connected"}
      controls={
        <Button disabled={busy || naming} onClick={() => setNaming(true)}>
          New key
        </Button>
      }
    >
      {naming && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Input aria-label="Key name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} className="w-48 max-md:flex-1" autoFocus />
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            Create
          </Button>
          <Button variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </form>
      )}
      {secret && (
        <div role="region" aria-label="New key" className="flex flex-col gap-2.5 rounded-lg bg-tint px-3.5 py-3">
          <div className="flex items-center gap-2">
            <Label>New key</Label>
            <InfoDot label="About the new key">Shown once. Paste it into Grokbot as its Hydra key now; Hydra keeps only a hash of it.</InfoDot>
          </div>
          <p data-testid="new-key" className="text-body break-all select-all">
            {secret}
          </p>
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                await navigator.clipboard?.writeText(secret).catch(() => undefined);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="ghost" onClick={() => setSecret(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
      {keys.length > 0 && (
        <div aria-label="Grokbot keys" role="list" className="rounded-lg bg-tint px-3.5">
          {keys.map((k) => (
            <ListRow key={k.id} role="listitem" className="gap-3 py-1.5">
              <span className="min-w-0 flex-1 truncate">{k.name}</span>
              <span className="text-label text-ink-3 tabular-nums max-md:hidden">{k.prefix}…</span>
              <span className="text-label text-ink-3">{k.last_used_at ? `used ${ago(k.last_used_at, data.now)}` : "never used"}</span>
              <Button variant="ghost" disabled={busy || revoking === k.id} onClick={() => setRevoking(k.id)}>
                Revoke
              </Button>
            </ListRow>
          ))}
        </div>
      )}
      {target && (
        <Confirm
          label="Revoke key"
          prompt={`Revoke ${target.name}? Grokbot stops at once.`}
          yes="Revoke"
          onNo={() => setRevoking(null)}
          onYes={async () => {
            setRevoking(null);
            await run(() => actions.revokeApiKey({ id: target.id }));
          }}
        />
      )}
      <Problem error={error} />
    </Row>
  );
}

/** A Claude Code device holds the MCP scope only; anything with "agent" is a Hydra Desktop. */
const isClaudeCode = (d: { scopes?: string[] }) => !!d.scopes && !d.scopes.includes("agent");

/** The two lines that pair Claude Code: trade the code for a key, then add the MCP server with it. */
function ClaudeCodeSteps({ code }: { code: string }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <InfoDot label="How to pair Claude Code">
      <span className="flex flex-col gap-2 break-all">
        <span>1. Trade the code for a key:</span>
        <span className="text-white/75">
          curl -s -X POST {origin}/api/agent/devices/exchange -H &quot;content-type: application/json&quot; -d
          &apos;{`{"code":"${code}","name":"Claude Code"}`}&apos;
        </span>
        <span>2. Add Hydra with the key it returns:</span>
        <span className="text-white/75">
          claude mcp add --transport http hydra {origin}/api/mcp/agent --header &quot;Authorization: Bearer KEY&quot;
        </span>
      </span>
    </InfoDot>
  );
}

/** A relay loop seen this recently is online (RELAY_ONLINE_MS on the server). */
const ONLINE_MS = 45_000;

/** When the device last reached Hydra: its relay loop when it runs one, else any call. Phones drop "last contact" (the name keeps its room). */
function LastContact({ d, now }: { d: DeviceView; now: string }) {
  if (d.relay_seen_at && Date.parse(now) - Date.parse(d.relay_seen_at) < ONLINE_MS) return <>online</>;
  const at = d.relay_seen_at ?? d.last_seen_at;
  if (!at) return <>not seen yet</>;
  return (
    <>
      <span className="max-md:hidden">last contact </span>
      {ago(at, now)}
    </>
  );
}

/** On the server, after the deploy kit is on it: trade the code for the server's key. */
function ServerStep({ code }: { code: string }) {
  return (
    <InfoDot label="How to pair the server">
      <span className="flex flex-col gap-2 break-all">
        <span>On the server, run:</span>
        <span className="text-white/75">hydra-brain pair {code}</span>
      </span>
    </InfoDot>
  );
}

/**
 * Pairing rows: the Hydra Agent's devices (a Mac or the server, which takes every turn while it is
 * online) and Claude Code (MCP only). Each lists its own devices. A code shows once, with Copy: a
 * server cannot take it through the desktop bridge.
 */
function PairRow({ id }: { id: "desktop" | "claudeCode" }) {
  const { data, actions } = useAccounts();
  const claude = id === "claudeCode";
  const devices = data.devices.filter((d) => isClaudeCode(d) === claude);
  const [code, setCode] = useState<{ code: string; minutes: number; kind: PairKind } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  const target = devices.find((d) => d.id === revoking);
  const pair = async (kind: PairKind) => {
    const made = await run(() => actions.pairDevice({ kind }));
    setCopied(false);
    if (made) setCode({ code: made.code, kind, minutes: Math.max(1, Math.round((Date.parse(made.expiresAt) - Date.now()) / 60_000)) });
  };
  return (
    <Row
      id={id}
      on={devices.length > 0}
      state={devices.length ? "Connected" : "Not connected"}
      controls={
        claude ? (
          <Button disabled={busy} onClick={() => void pair("claude-code")}>
            Pair Claude Code
          </Button>
        ) : (
          <>
            <Button disabled={busy} onClick={() => void pair("server")}>
              Pair a server
            </Button>
            <Button disabled={busy} onClick={() => void pair("desktop")}>
              Pair a Mac
            </Button>
          </>
        )
      }
    >
      {code && (
        <div
          role="region"
          aria-label={code.kind === "server" ? "Server pairing code" : "Pairing code"}
          className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-tint px-3.5 py-3"
        >
          <span data-testid="pairing-code" className="text-section font-medium tracking-[0.18em] tabular-nums select-all">
            {code.code}
          </span>
          {code.kind === "claude-code" && <ClaudeCodeSteps code={code.code} />}
          {code.kind === "server" && <ServerStep code={code.code} />}
          <span className="text-label text-ink-3">Expires in {code.minutes} min</span>
          <span className="flex-1" />
          <Button
            onClick={async () => {
              await navigator.clipboard?.writeText(code.code).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="ghost" onClick={() => setCode(null)}>
            Done
          </Button>
        </div>
      )}
      {devices.length > 0 && (
        <div aria-label={claude ? "Paired Claude Code keys" : "Paired devices"} role="list" className="rounded-lg bg-tint px-3.5">
          {devices.map((d) => (
            <ListRow key={d.id} role="listitem" data-role={claude ? undefined : (d.role ?? "mac")} className="gap-3 py-1.5">
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              {!claude && <Pill tone={d.role === "brain" ? "strong" : "default"}>{d.role === "brain" ? "Server" : "Mac"}</Pill>}
              <span className="text-label text-ink-3">{claude ? (d.last_seen_at ? `seen ${ago(d.last_seen_at, data.now)}` : "not seen yet") : <LastContact d={d} now={data.now} />}</span>
              <Button variant="ghost" disabled={busy || revoking === d.id} onClick={() => setRevoking(d.id)}>
                Revoke
              </Button>
            </ListRow>
          ))}
        </div>
      )}
      {target && (
        <Confirm
          label="Revoke device"
          prompt={`Revoke ${target.name}? It stops at once and needs a new code to pair again.`}
          yes="Revoke"
          onNo={() => setRevoking(null)}
          onYes={async () => {
            setRevoking(null);
            await run(() => actions.revokeDevice({ id: target.id }));
          }}
        />
      )}
      <Problem error={error} />
    </Row>
  );
}

function NotificationsRow() {
  const { data } = useAccounts();
  const n = data.pushDevices;
  return <Row id="notifications" on={n > 0} state={n ? "Connected" : "Not connected"} detail={n ? `${n} device${n === 1 ? "" : "s"}` : undefined} controls={<PushButton />} />;
}

/** Settings > Connections: Google, Instagram, Grokbot keys, Claude Code and Hydra Agent (Mac or server) pairing, notifications. */
export function ConnectorsCard() {
  return (
    <Card aria-label="Connectors" className="md:col-span-3">
      <Label>Connectors</Label>
      <div>
        <GoogleRow />
        <InstagramRow />
        <GrokbotRow />
        <PairRow id="claudeCode" />
        <PairRow id="desktop" />
        <NotificationsRow />
      </div>
    </Card>
  );
}
