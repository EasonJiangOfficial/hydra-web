import { asDevice, json } from "@/lib/agent/caller";
import { bearer, RATE_LIMITS } from "@/lib/agent/devices";
import { openModelKey } from "@/lib/agent/model-keys";
import { KEYED_PROVIDERS, type KeyedProvider } from "@/lib/agent/models";
import { supabaseStore } from "@/lib/agent/store";
import { TokenDecryptError } from "@/lib/bank/crypto";

/**
 * GET /api/agent/relay/keys/[provider] (0225): a relay brain (Hydra Desktop or the Hydra server, device key with scope
 * "relay") reads the owner's key for `provider` ("xai") to run a Grok turn: {key}, never cached (no-store). It keeps the
 * key in memory only. 404 not_connected when there is none (or it no longer opens). An owner browser session (no
 * device key) gets 403: the page never sees a key. The key is never logged.
 */
const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  if (!bearer(request)) return json({ error: "forbidden", message: "Paired devices only" }, 403);
  return asDevice(request, "relay", RATE_LIMITS.deviceRelay, async (_device, admin) => {
    const { provider } = await params;
    if (!(KEYED_PROVIDERS as readonly string[]).includes(provider)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const sealed = await supabaseStore(admin).sealedModelKey(provider as KeyedProvider);
    let key: string | null = null;
    try {
      key = sealed ? openModelKey(provider as KeyedProvider, sealed) : null;
    } catch (error) {
      // A key sealed under another HYDRA_TOKEN_KEY: the brain runs Claude and says the model was not connected.
      if (!(error instanceof TokenDecryptError)) throw error;
    }
    if (!key) return Response.json({ error: "not_connected" }, { status: 404, headers: NO_STORE });
    return Response.json({ key }, { headers: NO_STORE });
  });
}
