import { z } from "zod";
import { asOwner, json, readJson } from "@/lib/agent/caller";
import { checkModelKey, keyHint, sealModelKey } from "@/lib/agent/model-keys";
import { clampEffort, DEFAULT_MODEL, KEYED_PROVIDERS, providerOf } from "@/lib/agent/models";
import { modelKeyInput } from "@/lib/agent/settings-client";
import { settingsOut, supabaseStore } from "@/lib/agent/store";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 0225: the provider keys the owner pastes in Settings > Agent > Models (Grok's xAI key). Owner browser session only: a
 * paired device gets 403 (the relay brains read a key through /api/agent/relay/keys/[provider]).
 * GET {keys: [{provider, hint, updatedAt}]}, never a key.
 * PUT {provider, key} checks the key with the provider's free model list (no tokens billed), then stores it sealed:
 *   {key: {provider, hint, updatedAt}}; 400 key_refused or key_no_models, 502 key_check_failed (nothing stored).
 * DELETE {provider} removes it (the page asks first): {ok, settings?}. When that provider's model was picked, the same
 *   request puts Opus 5.5 back and clamps both efforts, and answers the settings. 404 when there was no key.
 * No answer ever holds the key.
 */
const bad = (error: z.ZodError) => json({ error: "invalid_input", message: error.issues[0]?.message ?? "Not valid" }, 400);
const deviceRefused = () => json({ error: "owner_only", message: "Connect models in Hydra, Settings, Agent." }, 403);

export async function GET(request: Request) {
  return asOwner(request, null, async (caller) => (caller.deviceId ? deviceRefused() : json({ keys: await supabaseStore(caller.db).modelKeys() })));
}

export async function PUT(request: Request) {
  return asOwner(request, null, async (caller) => {
    if (caller.deviceId) return deviceRefused();
    const body = modelKeyInput.safeParse(await readJson(request));
    if (!body.success) return bad(body.error);
    const { provider, key } = body.data;
    const check = await checkModelKey(provider, key);
    if (!check.ok) return json({ error: check.error, message: check.message }, check.status);
    // The owner reads only the hint and the dates (0225 grants): the service role writes.
    const row = await supabaseStore(createAdminClient()).putModelKey(provider, sealModelKey(provider, key), keyHint(key));
    return json({ key: row });
  });
}

export async function DELETE(request: Request) {
  return asOwner(request, null, async (caller) => {
    if (caller.deviceId) return deviceRefused();
    const body = z.object({ provider: z.enum(KEYED_PROVIDERS) }).safeParse(await readJson(request));
    if (!body.success) return bad(body.error);
    const { provider } = body.data;
    // The model goes back to Opus first: a failed settings write leaves the key in place for a retry, never a picked
    // model with no key.
    const store = supabaseStore(caller.db);
    const was = await store.settings();
    const settings =
      providerOf(was.model) === provider
        ? await store.updateSettings({
            model: DEFAULT_MODEL,
            effortLive: clampEffort(DEFAULT_MODEL, was.effortLive),
            effortRoutine: clampEffort(DEFAULT_MODEL, was.effortRoutine),
          })
        : null;
    const deleted = await supabaseStore(createAdminClient()).deleteModelKey(provider);
    if (!settings) return deleted ? json({ ok: true }) : json({ error: "not_found", message: "This key is already gone" }, 404);
    return json({ ok: true, settings: settingsOut(settings) });
  });
}
