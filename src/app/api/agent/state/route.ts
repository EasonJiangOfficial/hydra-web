import { z } from "zod";
import { asOwner, json, readJson } from "@/lib/agent/caller";
import { SURFACES } from "@/lib/agent/events";
import { clampEffort, EFFORT_LABEL, EFFORTS, effortsOf, MODEL_IDS, modelName, PROVIDER_LABEL, providerOf } from "@/lib/agent/models";
import { CLAP_LEVELS, connectedProviders, settingsOut, supabaseStore, visibleText } from "@/lib/agent/store";

/**
 * GET /api/agent/state: the owner's recent conversation threads, newest first (web, phone, desktop: never a routine's or
 * an MCP client's, so a client continues the shared conversation; the newest carries its last messages, text only), approvals
 * waiting for the owner (live, routine and MCP), the last 50 actions with their undo ids and thread (never their input or result), the latest
 * notifications, and the shared settings (sleep word, wake phrase, clap sensitivity, model, efforts, brain, approve all,
 * active avatar id). 0220: `activeAvatar` {id, name, voiceId, curse, slang, styleNotes} or null (Hydra's own voice), and
 * `avatars` [{id, name}] for a quick switch. Models: `providers`, the ones the owner can pick now (models.ts; Claude
 * always, Grok with its key, ChatGPT while a Mac is signed in), outside `settings`. Owner session or a paired device
 * (scope "agent"). PATCH any subset of the settings (not the brain; the avatar as activeAvatarId, null for Hydra's own)
 * changes them for every device and answers {ok, settings, activeAvatar}; 400 on anything invalid (an avatar that does
 * not exist too; an effort the model does not offer: effort_not_offered); 409 model_not_connected for a model whose
 * provider is not connected; 403 when a paired device sends approveAll (owner session only). A model change clamps
 * both efforts to the new model's levels (models.ts clampEffort).
 */
const MESSAGES = 30;

export async function GET(request: Request) {
  return asOwner(request, "agent", async (caller) => {
    const store = supabaseStore(caller.db);
    const [threads, pendingApprovals, actions, notifications, settings, avatars, providers] = await Promise.all([
      store.recentThreads(20, SURFACES),
      store.pendingApprovals(),
      store.recentActions(50),
      store.recentNotifications(20),
      store.settings(),
      store.listAvatars(),
      connectedProviders(store),
    ]);
    const activity = actions.map((a) => ({
      id: a.id,
      tool: a.tool,
      summary: a.summary,
      surface: a.surface,
      createdAt: a.created_at,
      threadId: a.thread_id,
      undoId: a.inverse && !a.undone_at ? a.id : null,
      undoneAt: a.undone_at,
    }));
    const [latest, ...rest] = threads;
    const messages = latest
      ? (await store.threadMessages(latest.id, MESSAGES * 4))
          .map((m) => ({ id: m.id, role: m.role, text: visibleText(m), created_at: m.created_at }))
          .filter((m) => m.text)
          .slice(0, MESSAGES)
          .reverse()
      : [];
    return json({
      threads: latest ? [{ ...latest, messages }, ...rest] : [],
      pendingApprovals,
      activity,
      notifications,
      settings: settingsOut(settings),
      activeAvatar: settings.activeAvatar,
      avatars: avatars.map((a) => ({ id: a.id, name: a.name })),
      providers,
    });
  });
}

const patchSchema = z
  .object({
    sleepWord: z.string().trim().min(2).max(60),
    wakePhrase: z.string().trim().min(2).max(40),
    clapSensitivity: z.enum(CLAP_LEVELS),
    model: z.enum(MODEL_IDS),
    effortLive: z.enum(EFFORTS),
    effortRoutine: z.enum(EFFORTS),
    approveAll: z.boolean(),
    activeAvatarId: z.uuid().nullable(),
  })
  .partial()
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "nothing to change" });

export async function PATCH(request: Request) {
  return asOwner(request, "agent", async (caller) => {
    const body = patchSchema.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid_input", message: z.prettifyError(body.error) }, 400);
    // Approve all says yes for the owner: a paired device may not turn it on or off (it may not approve its own gates).
    if (body.data.approveAll !== undefined && caller.deviceId) return json({ error: "owner_only", message: "Change this in Hydra." }, 403);
    const store = supabaseStore(caller.db);
    const avatar = body.data.activeAvatarId;
    if (avatar && !(await store.listAvatars()).some((a) => a.id === avatar)) return json({ error: "invalid_input", message: "No such avatar" }, 400);
    const patch = { ...body.data };
    const { model: wanted, effortLive, effortRoutine } = patch;
    if (wanted !== undefined || effortLive !== undefined || effortRoutine !== undefined) {
      const was = await store.settings();
      const model = wanted ?? was.model;
      const provider = providerOf(model);
      if (wanted !== undefined && wanted !== was.model && provider && !(await connectedProviders(store)).includes(provider)) {
        const how = provider === "openai" ? "Sign in to ChatGPT in Hydra Desktop first." : `Connect ${PROVIDER_LABEL[provider]} in Settings, Agent first.`;
        return json({ error: "model_not_connected", message: how }, 409);
      }
      const offered = effortsOf(model);
      if ([effortLive, effortRoutine].some((e) => e !== undefined && !offered.includes(e))) {
        return json({ error: "effort_not_offered", message: `${modelName(model)} goes up to ${EFFORT_LABEL[offered[offered.length - 1]!]}` }, 400);
      }
      if (wanted !== undefined) {
        patch.effortLive = clampEffort(model, effortLive ?? was.effortLive);
        patch.effortRoutine = clampEffort(model, effortRoutine ?? was.effortRoutine);
      }
    }
    const settings = await store.updateSettings(patch);
    return json({ ok: true, settings: settingsOut(settings), activeAvatar: settings.activeAvatar });
  });
}
