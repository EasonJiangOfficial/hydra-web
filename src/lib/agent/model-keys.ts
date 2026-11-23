import "server-only";
import { decryptToken, encryptToken } from "@/lib/bank/crypto";
import { modelsOf, type KeyedProvider } from "./models";

/**
 * 0225: provider API keys at rest (Grok's xAI key). Sealed with HYDRA_TOKEN_KEY like the Plaid and Google tokens
 * (src/lib/bank/crypto.ts), the AAD binding each to its provider. Never log a key or put it in an error.
 */
const aad = (provider: KeyedProvider) => `agent_model_key:${provider}`;
export const sealModelKey = (provider: KeyedProvider, key: string) => encryptToken(key, aad(provider));
export const openModelKey = (provider: KeyedProvider, sealed: string) => decryptToken(sealed, aad(provider));
export const keyHint = (key: string) => key.slice(-4);

/** The provider's free model list: listing models bills nothing. */
const LIST_URL: Record<KeyedProvider, string> = { xai: "https://api.x.ai/v1/models" };
const NAME: Record<KeyedProvider, string> = { xai: "xAI" };
const CHECK_MS = 10_000;

export type KeyCheck = { ok: true } | { ok: false; status: 400 | 502; error: "key_refused" | "key_no_models" | "key_check_failed"; message: string };

/**
 * Asks the provider whether `key` works: its model list, 10 s at most. Refused (400, 401, 403): key_refused. A list with
 * none of Hydra's models for that provider (an id equal to one, or one plus a dated suffix): key_no_models. Anything
 * else (5xx, 429, a timeout, no network): key_check_failed, and nothing is stored.
 */
export async function checkModelKey(provider: KeyedProvider, key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  const name = NAME[provider];
  let res: Response;
  try {
    res = await fetchImpl(LIST_URL[provider], { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(CHECK_MS), cache: "no-store" });
  } catch {
    return { ok: false, status: 502, error: "key_check_failed", message: `Could not reach ${name}. Try again.` };
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, status: 400, error: "key_refused", message: `${name} refused this key` };
  if (!res.ok) return { ok: false, status: 502, error: "key_check_failed", message: `Could not reach ${name}. Try again.` };
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  const ids = Array.isArray(body?.data) ? body.data.flatMap((m) => (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" ? [(m as { id: string }).id] : [])) : [];
  const wanted = modelsOf(provider);
  if (!ids.some((id) => wanted.some((w) => id === w || id.startsWith(`${w}-`)))) {
    return { ok: false, status: 400, error: "key_no_models", message: `This key has no ${wanted.join(" or ")}` };
  }
  return { ok: true };
}
