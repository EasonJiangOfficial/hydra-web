import type { DesktopSetup, HydraDesktopBridge, Perm, PermKind } from "@/components/agent/types";

export type StepId = "pair" | "claude" | PermKind;
/** done; todo (needs a click); denied (a permission the owner refused: the button opens System Settings). */
export type StepStatus = "done" | "todo" | "denied";

export const PERM_KINDS: readonly PermKind[] = ["mic", "accessibility", "screen"];
const PERMS: readonly Perm[] = ["granted", "denied", "not_determined"];

export const STEPS: { id: StepId; label: string; info: string; action: string }[] = [
  { id: "pair", label: "Pair this Mac", info: "Links this Mac to your Hydra account, so the website and your phone can reach the agent here.", action: "Retry" },
  { id: "claude", label: "Sign in with Claude", info: "The agent thinks with your Claude login. Gmail and Calendar come from your claude.ai connectors.", action: "Sign in" },
  { id: "mic", label: "Microphone", info: "So Hydra hears you, the double clap and the sleep word.", action: "Allow" },
  { id: "accessibility", label: "Control apps", info: "So Hydra can click and type in your apps when you ask.", action: "Allow" },
  { id: "screen", label: "Screen", info: "So Hydra can see what is on screen when you ask about it.", action: "Allow" },
];

export const isPerm = (id: StepId): id is PermKind => (PERM_KINDS as readonly string[]).includes(id);

/**
 * The desktop's setup() answer, checked before the web acts on it. A failed ask comes back as `{ ok: false, error }`
 * and a broken one as anything at all: both are null, so the web never auto-pairs on a shape it does not know.
 */
export function parseSetup(v: unknown): DesktopSetup | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  const p = s.permissions as Record<string, unknown> | null | undefined;
  if (typeof s.paired !== "boolean" || (s.claude !== "signed_in" && s.claude !== "signed_out") || !p || typeof p !== "object") return null;
  if (!PERM_KINDS.every((k) => (PERMS as readonly unknown[]).includes(p[k]))) return null;
  return {
    paired: s.paired,
    claude: s.claude,
    permissions: { mic: p.mic as Perm, accessibility: p.accessibility as Perm, screen: p.screen as Perm },
    version: typeof s.version === "string" ? s.version : "",
  };
}

export function stepStatus(s: DesktopSetup, id: StepId): StepStatus {
  if (id === "pair") return s.paired ? "done" : "todo";
  if (id === "claude") return s.claude === "signed_in" ? "done" : "todo";
  const p = s.permissions[id];
  return p === "granted" ? "done" : p === "denied" ? "denied" : "todo";
}

/** Every step done, or a permission the owner chose to skip on this Mac. Pair and Claude can never be skipped. */
export const setupComplete = (s: DesktopSetup, skipped: readonly PermKind[] = []) =>
  STEPS.every((st) => stepStatus(s, st.id) === "done" || (isPerm(st.id) && skipped.includes(st.id)));

/**
 * Permissions skipped on this Mac. The web app inside Hydra Desktop has its own storage on each Mac, so this is
 * remembered per Mac, and the gate does not come back on every launch for a permission the owner refused.
 */
export const SKIP_KEY = "hydra:setup-skipped";

export function readSkipped(store: Pick<Storage, "getItem"> | undefined = localStore()): PermKind[] {
  try {
    const v: unknown = JSON.parse(store?.getItem(SKIP_KEY) ?? "[]");
    return Array.isArray(v) ? PERM_KINDS.filter((k) => v.includes(k)) : [];
  } catch {
    return [];
  }
}

export function writeSkipped(kinds: readonly PermKind[], store: Pick<Storage, "setItem"> | undefined = localStore()) {
  try {
    store?.setItem(SKIP_KEY, JSON.stringify(kinds));
  } catch {
    /* private mode: skipped for this load only */
  }
}

function localStore(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** The setup half of the v3 bridge, or null for an older desktop (v1/v2 have no setup: the gate never shows). */
export function setupBridge(b: HydraDesktopBridge | undefined) {
  if (!b) return null;
  const { setup, pair, signInClaude, requestPermission } = b;
  if (typeof setup !== "function" || typeof pair !== "function" || typeof signInClaude !== "function" || typeof requestPermission !== "function") return null;
  return {
    /** The validated setup(), or null when the desktop failed or answered something else. */
    setup: async () => parseSetup(await setup.call(b)),
    pair: (code: string) => pair.call(b, code),
    signInClaude: () => signInClaude.call(b),
    requestPermission: (kind: PermKind) => requestPermission.call(b, kind),
  };
}
export type SetupBridge = NonNullable<ReturnType<typeof setupBridge>>;

/**
 * Pairs this Mac: a one-time code from the owner's session, handed straight to the desktop (it never shows on screen).
 * The desktop trades it for a device key with the agent, mcp and relay scopes.
 */
export async function pairMac(bridge: SetupBridge, f: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  try {
    const res = await f("/api/agent/devices/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Hydra Desktop", scopes: ["agent", "mcp", "relay"] }),
    });
    if (!res.ok) return false;
    const body: unknown = await res.json().catch(() => null);
    const code = body && typeof body === "object" && "code" in body ? (body as { code: unknown }).code : null;
    if (typeof code !== "string" || !code) return false;
    const out = await bridge.pair(code);
    return out?.ok === true;
  } catch {
    return false;
  }
}
