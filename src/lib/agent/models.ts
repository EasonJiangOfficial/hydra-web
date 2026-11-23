/**
 * The models Hydra may think with, one source for every surface (owner, 2026-11-22: "also could you allow me to connected
 * different models and switch between them and their effort levels like grok, chatgpt"). Client-safe: the routes, the
 * Settings page, the orb menu and the server loop read it.
 *
 * - Claude runs on the owner's Claude login on the relay brains (Hydra Desktop and the Hydra server); always connected.
 * - ChatGPT runs only on the Mac, on its "Sign in with ChatGPT" (owner decision): pickable while a live Mac reports the
 *   sign-in (relay-schema.ts capabilitiesSchema signedIn ["chatgpt"]).
 * - Grok runs on the relay brains with the xAI API key pasted once in Settings > Agent > Models (0225, sealed).
 * The Vercel server loop runs Claude only (loop.ts): another model there runs on the default and says so.
 *
 * Effort: low..max map 1:1 to Claude's output_config.effort and to reasoning.effort on GPT and Grok. No model offers
 * Off. A level a model does not offer clamps to the nearest level above it, else its highest (clampEffort).
 */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const PROVIDERS = ["anthropic", "openai", "xai"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_LABEL: Record<Provider, string> = { anthropic: "Claude", openai: "ChatGPT", xai: "Grok" };
/** Providers connected with an API key the owner pastes (agent_model_keys, 0225). */
export const KEYED_PROVIDERS = ["xai"] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];
/** Providers a Mac runs on its own sign-in, by the name the Mac reports in its capabilities. */
export const MAC_SIGN_IN: Partial<Record<Provider, string>> = { openai: "chatgpt" };

export const MODEL_IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-6.2-astra", "gpt-6.2-sol", "grok-4.7"] as const;
export type ModelId = (typeof MODEL_IDS)[number];
export const DEFAULT_MODEL: ModelId = "claude-opus-5-5";

// GPT-6.2: max is not confirmed by OpenAI (add it after one live call passes). Grok 4.7: no max, reasoning is always on.
const TO_XHIGH = ["low", "medium", "high", "xhigh"] as const satisfies readonly Effort[];
export interface ModelInfo {
  provider: Provider;
  /** The short name inside its provider ("Sol"). */
  label: string;
  /** The name alone, outside its provider ("ChatGPT · Sol"). */
  name: string;
  efforts: readonly Effort[];
}
export const MODELS: Record<ModelId, ModelInfo> = {
  "claude-opus-5-5": { provider: "anthropic", label: "Opus 5.5", name: "Opus 5.5", efforts: EFFORTS },
  "claude-sonnet-5-5": { provider: "anthropic", label: "Sonnet 5.5", name: "Sonnet 5.5", efforts: EFFORTS },
  "claude-haiku-5-5": { provider: "anthropic", label: "Haiku 5.5", name: "Haiku 5.5", efforts: EFFORTS },
  "gpt-6.2-astra": { provider: "openai", label: "Astra", name: "ChatGPT · Astra", efforts: TO_XHIGH },
  "gpt-6.2-sol": { provider: "openai", label: "Sol", name: "ChatGPT · Sol", efforts: TO_XHIGH },
  "grok-4.7": { provider: "xai", label: "Grok 4.7", name: "Grok 4.7", efforts: TO_XHIGH },
};

export const isModelId = (v: unknown): v is ModelId => typeof v === "string" && (MODEL_IDS as readonly string[]).includes(v);
export const isEffort = (v: unknown): v is Effort => typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
export const providerOf = (model: string): Provider | null => (isModelId(model) ? MODELS[model].provider : null);
/** The levels a model offers; an unknown id (an older row) offers every level. */
export const effortsOf = (model: string): readonly Effort[] => (isModelId(model) ? MODELS[model].efforts : EFFORTS);
export const modelsOf = (provider: Provider): ModelId[] => MODEL_IDS.filter((id) => MODELS[id].provider === provider);
export const modelName = (model: string) => (isModelId(model) ? MODELS[model].name : model);

/** The level `model` runs `effort` at: the same when offered, else the nearest level above it, else its highest. */
export function clampEffort(model: string, effort: Effort): Effort {
  const offered = effortsOf(model);
  if (offered.includes(effort)) return effort;
  const at = EFFORTS.indexOf(effort);
  return offered.find((e) => EFFORTS.indexOf(e) > at) ?? offered[offered.length - 1]!;
}

export const EFFORT_LABEL: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "X-High", max: "Max" };
/** What each level means, for the hover on it. */
export const EFFORT_INFO: Record<Effort, string> = {
  low: "Quick answers, light thinking.",
  medium: "Thinks a bit before it answers.",
  high: "Thinks hard. Slower.",
  xhigh: "Thinks very hard for tough problems. Slower still.",
  max: "The most thinking the model has. Slowest.",
};

/** Why a turn ran on another model than the one picked (the model event). */
export const FALLBACKS = ["not_connected", "provider_error", "server_claude_only"] as const;
export type ModelFallback = (typeof FALLBACKS)[number];

/** The hover on a reply: who answered and how hard ("Grok 4.7 · High"), and why when it was not the one picked. */
export function answeredBy(ev: { model: string; effort: string; fallback?: string }, picked?: string): string {
  const who = `${modelName(ev.model)} · ${isEffort(ev.effort) ? EFFORT_LABEL[ev.effort] : ev.effort}`;
  const wanted = picked && picked !== ev.model ? modelName(picked) : "the model you picked";
  if (ev.fallback === "not_connected") return `${who}. ${wanted} was not connected.`;
  if (ev.fallback === "provider_error") return `${who}. ${wanted} did not answer.`;
  if (ev.fallback === "server_claude_only") return `${who}. The server runs Claude only.`;
  return who;
}
