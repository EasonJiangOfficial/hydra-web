import { z } from "zod";
import { DEFAULT_MODEL, EFFORTS, KEYED_PROVIDERS, MODEL_IDS, PROVIDERS, type Effort, type KeyedProvider, type ModelId, type Provider } from "./models";

/**
 * The shared agent settings, one source for every surface (W6 contract, 2026-11-22): the web orb menu, the
 * Settings page Agent tab, Hydra Desktop and the server brain. GET /api/agent/state returns them under
 * `settings`; PATCH /api/agent/state takes any subset and answers `{ ok: true, settings }` (400 on invalid).
 * The route stores all eight (0190, 0200 approve all, 0220 active avatar); a missing or invalid field reads as its default.
 * Models and efforts come from models.ts; GET also answers `providers`, the ones the owner can pick now (Claude always,
 * Grok with its key, ChatGPT while a Mac is signed in). PATCH refuses a model whose provider is not connected (409) and
 * an effort the model does not offer (400); a model change clamps both efforts to the new model's levels.
 */

/** Clap sensitivity's levels. */
export const LEVELS = ["low", "medium", "high"] as const;
export type Level = (typeof LEVELS)[number];

export const agentSettingsPatch = z
  .object({
    sleepWord: z.string().trim().min(2, "2 to 60 characters").max(60, "2 to 60 characters"),
    wakePhrase: z.string().trim().min(2, "2 to 40 characters").max(40, "2 to 40 characters"),
    clapSensitivity: z.enum(LEVELS),
    model: z.enum(MODEL_IDS),
    effortLive: z.enum(EFFORTS),
    effortRoutine: z.enum(EFFORTS),
    approveAll: z.boolean(),
    activeAvatarId: z.uuid().nullable(),
  })
  .partial()
  .strict();
export type AgentSettingsPatch = z.input<typeof agentSettingsPatch>;

export interface AgentSettingsView {
  sleepWord: string;
  wakePhrase: string;
  clapSensitivity: Level;
  model: ModelId;
  effortLive: Effort;
  effortRoutine: Effort;
  /** 0200: Hydra acts without asking; deletions still ask. */
  approveAll: boolean;
  /** 0220: the avatar Hydra speaks and talks as; null is Hydra's own voice. */
  activeAvatarId: string | null;
}

export const AGENT_DEFAULTS: AgentSettingsView = {
  sleepWord: "Hydra, sleep",
  wakePhrase: "Hey Hydra",
  clapSensitivity: "medium",
  model: DEFAULT_MODEL,
  effortLive: "low",
  effortRoutine: "medium",
  approveAll: false,
  activeAvatarId: null,
};

/** The fields of `raw` that meet the contract; anything else is dropped. */
export function readAgentSettings(raw: unknown): Partial<AgentSettingsView> {
  const out: Partial<AgentSettingsView> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    const one = agentSettingsPatch.safeParse({ [k]: v });
    if (one.success && k in AGENT_DEFAULTS) Object.assign(out, one.data);
  }
  return out;
}

/** The providers the owner can pick now, in catalog order (Claude always first). */
export function readProviders(raw: unknown): Provider[] {
  const given = Array.isArray(raw) ? raw : [];
  return PROVIDERS.filter((p) => p === "anthropic" || given.includes(p));
}

/**
 * `settings`: the valid fields the server sent. Merge them over what the page shows (GET: over AGENT_DEFAULTS).
 * `providers`: GET's connected providers (absent from an older server and from PATCH).
 */
export type AgentSettingsResult = { ok: true; settings: Partial<AgentSettingsView>; providers?: Provider[] } | { ok: false; message: string };

const URL_ = "/api/agent/state";
/** Refusals whose own words say what to do. */
const SAYS = new Set(["model_not_connected", "effort_not_offered"]);

async function call(init: RequestInit | undefined, fetchImpl: typeof fetch): Promise<AgentSettingsResult> {
  try {
    const res = await fetchImpl(URL_, { ...init, headers: { "content-type": "application/json" }, cache: "no-store" });
    const body = (await res.json().catch(() => null)) as { settings?: unknown; providers?: unknown; error?: unknown; message?: unknown } | null;
    if (body && typeof body.error === "string" && SAYS.has(body.error) && typeof body.message === "string") return { ok: false, message: body.message };
    if (res.status === 400) return { ok: false, message: "Not saved: check the value" };
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Sign in as the owner" };
    if (!res.ok || !body) return { ok: false, message: "Could not reach Hydra. Try again." };
    return { ok: true, settings: readAgentSettings(body.settings), ...(Array.isArray(body.providers) ? { providers: readProviders(body.providers) } : {}) };
  } catch {
    return { ok: false, message: "Could not reach Hydra. Try again." };
  }
}

export const getAgentSettings = (fetchImpl: typeof fetch = fetch) => call(undefined, fetchImpl);

/** Validates first (nothing is sent for a bad value), then PATCHes only the fields given. */
export async function patchAgentSettings(patch: AgentSettingsPatch, fetchImpl: typeof fetch = fetch): Promise<AgentSettingsResult> {
  const parsed = agentSettingsPatch.safeParse(patch);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Not a valid value" };
  return call({ method: "PATCH", body: JSON.stringify(parsed.data) }, fetchImpl);
}

/**
 * 0225: the provider keys the owner pastes (Settings > Agent > Models; Grok only). GET /api/agent/models/keys lists them
 * as {provider, hint, updatedAt}, never the key; PUT {provider, key} checks the key with the provider (its free model
 * list) and stores it sealed; DELETE {provider} removes it, and when that provider's model was picked Hydra goes back
 * to Opus 5.5 (the answer carries the settings then). Owner session only.
 */
export interface ModelKeyView {
  provider: KeyedProvider;
  /** The key's last four characters. */
  hint: string;
  updatedAt: string;
}
export const modelKeyInput = z.object({
  provider: z.enum(KEYED_PROVIDERS),
  key: z
    .string()
    .trim()
    .min(20, "Paste the whole key")
    .max(400, "That is not a key")
    .regex(/^\S+$/, "A key has no spaces"),
});
export type KeyResult<T> = { ok: true; data: T } | { ok: false; message: string };

async function keyCall<T>(init: RequestInit | undefined, fetchImpl: typeof fetch, pick: (b: Record<string, unknown>) => T): Promise<KeyResult<T>> {
  try {
    const res = await fetchImpl("/api/agent/models/keys", { ...init, headers: { "content-type": "application/json" }, cache: "no-store" });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && body) return { ok: true, data: pick(body) };
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Sign in as the owner" };
    return { ok: false, message: body && typeof body.message === "string" ? body.message : "Could not reach Hydra. Try again." };
  } catch {
    return { ok: false, message: "Could not reach Hydra. Try again." };
  }
}

const keyRows = (b: Record<string, unknown>): ModelKeyView[] =>
  Array.isArray(b.keys) ? (b.keys as ModelKeyView[]).filter((k) => (KEYED_PROVIDERS as readonly string[]).includes(k?.provider)) : [];

/** The client the Settings page uses (tests pass their own fetch). */
export function modelKeysClient(fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  return {
    list: () => keyCall(undefined, fetchImpl, keyRows),
    /** Validates first (nothing is sent for a bad key); the answer never holds the key. */
    connect: async (provider: KeyedProvider, key: string): Promise<KeyResult<ModelKeyView>> => {
      const parsed = modelKeyInput.safeParse({ provider, key });
      if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "That is not a key" };
      return keyCall({ method: "PUT", body: JSON.stringify(parsed.data) }, fetchImpl, (b) => b.key as ModelKeyView);
    },
    /** `data`: the settings after, when removing the key moved the model back to Opus 5.5. */
    remove: (provider: KeyedProvider) =>
      keyCall({ method: "DELETE", body: JSON.stringify({ provider }) }, fetchImpl, (b) => (b.settings ? readAgentSettings(b.settings) : null)),
  };
}
export type ModelKeysClient = ReturnType<typeof modelKeysClient>;
