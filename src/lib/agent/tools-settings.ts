import { z } from "zod";
import { setIdleLock, setTimeZone } from "@/app/(app)/accounts/actions";
import { loadAccountsData } from "@/app/(app)/accounts/data";
import * as businesses from "@/app/(app)/settings/actions";
import { TAX_SHAPES } from "@/lib/entities/model";
import { entityUse, listEntities } from "@/lib/entities/queries";
import { defineTool, ToolError, unwrap, uuid, type ToolCtx, type ToolDef } from "./registry";
import { nextRun, type Schedule } from "./schedule";
import { namedDelete, q, rowOf } from "./tools-confirm";

/**
 * The owner's settings the agent may read and change: time zone, idle lock, sleep word, avatars (0220), businesses. The
 * agent's own model and effort are read here but never written by it; connector keys and device pairing
 * stay on the Settings page (Connections). Turning the idle lock off and changing the sleep word are
 * security changes: both ask first. Deleting a business asks first; one in use can only be closed.
 */

/** settings.time_zone as stored: null until a sign-in or the owner sets it (ctx.timeZone() falls back). */
async function storedTimeZone(ctx: ToolCtx): Promise<string | null> {
  const { data, error } = await ctx.db.from("settings").select("time_zone").maybeSingle();
  if (error) throw new Error(`time zone: ${error.message}`);
  return (data?.time_zone as string | null | undefined) ?? null;
}

/** A zone change moves every scheduled routine's next run to its clock time in the new zone. */
async function rescheduleRoutines(ctx: ToolCtx): Promise<number> {
  const tz = await ctx.timeZone();
  let n = 0;
  for (const r of await ctx.store.listRoutines()) {
    // Paused: no next run. null: claimed or new, and the cron sweep fills it in the new zone.
    if (r.paused || r.next_run_at === null) continue;
    await ctx.store.updateRoutine(r.id, { next_run_at: nextRun(r.schedule as Schedule, ctx.now(), tz).toISOString() });
    n++;
  }
  return n;
}

export const SETTINGS_TOOLS: ToolDef[] = [
  defineTool({
    name: "get_settings",
    description:
      "Settings: time zone, idle lock, sleep word, the agent's model and effort, businesses (Personal and each business: slug, tax type, open or closed, in use, accounts), bank logins, Google and Instagram connections.",
    group: "hydra",
    kind: "read",
    input: z.object({}),
    run: async (ctx) => {
      const [a, agent, timeZone, entities, use] = await Promise.all([
        loadAccountsData(),
        ctx.store.settings(),
        ctx.timeZone(),
        listEntities(ctx.db),
        entityUse(ctx.db),
      ]);
      return {
        data: {
          timeZone,
          idleLockMinutes: a.idleLockMinutes,
          sleepWord: agent.sleepWord,
          agent: { model: agent.model, effortLive: agent.effortLive, effortRoutine: agent.effortRoutine, avatar: agent.activeAvatar?.name ?? null },
          businesses: entities.map((e) => ({ ...e, inUse: use[e.id]?.inUse ?? true, accounts: use[e.id]?.accounts ?? 0 })),
          bankLogins: a.items,
          google: a.google,
          instagram: a.instagram,
        },
        summary: "Read settings",
      };
    },
  }),
  defineTool({
    name: "set_time_zone",
    description: "Set the owner's time zone by IANA name (America/Toronto, Europe/London, UTC), never an offset. Today, due dates, reminders and routines follow it.",
    group: "hydra",
    kind: "write",
    input: z.object({ timeZone: z.string().min(1).max(100).nullable() }),
    run: async (ctx, input) => {
      const before = await storedTimeZone(ctx);
      const r = unwrap(await setTimeZone(input));
      const routinesRescheduled = await rescheduleRoutines(ctx);
      return {
        data: { ...r, routinesRescheduled },
        summary: r.timeZone ? `Time zone: ${r.timeZone}` : "Time zone cleared",
        inverse: { tool: "set_time_zone", input: { timeZone: before } },
      };
    },
  }),
  defineTool({
    name: "set_idle_lock",
    description: "Lock Hydra after 1 to 60 idle minutes; null turns the idle lock off (asks first).",
    group: "hydra",
    kind: "write",
    input: z.object({ minutes: z.int().min(1).max(60).nullable() }),
    gate: async (_ctx, { minutes }) => (minutes === null ? { reason: "delete", summary: "Turn the idle lock off", danger: true } : null),
    run: async (_ctx, input) => {
      const before = (await loadAccountsData()).idleLockMinutes;
      const r = unwrap(await setIdleLock(input));
      return { data: r, summary: r.minutes ? `Idle lock: ${r.minutes} minutes` : "Idle lock off", inverse: { tool: "set_idle_lock", input: { minutes: before } } };
    },
  }),
  defineTool({
    name: "set_sleep_word",
    description: "Set the phrase that puts the voice agent to sleep (asks first).",
    group: "hydra",
    kind: "write",
    input: z.object({ word: z.string().trim().min(1).max(60) }),
    gate: async (_ctx, { word }) => ({ reason: "delete", summary: `Change the sleep word to "${word}"`, danger: true }),
    run: async (ctx, { word }) => {
      const before = (await ctx.store.settings()).sleepWord;
      await ctx.store.setSleepWord(word);
      return { data: { sleepWord: word }, summary: `Sleep word: ${word}`, inverse: { tool: "set_sleep_word", input: { word: before } } };
    },
  }),
  defineTool({
    name: "list_avatars",
    description:
      "The owner's avatars (personas Hydra speaks as: a Fish Audio voice, cursing on or off, slang on or off, style notes) and which one is active. None active: Hydra's own voice and manner.",
    group: "hydra",
    kind: "read",
    input: z.object({}),
    run: async (ctx) => {
      const [avatars, settings] = await Promise.all([ctx.store.listAvatars(), ctx.store.settings()]);
      return { data: { active: settings.activeAvatar?.id ?? null, avatars }, summary: "Read avatars" };
    },
  }),
  defineTool({
    name: "switch_avatar",
    description: "Switch the avatar Hydra speaks and talks as on every device (an id from list_avatars), or null for Hydra's own voice. Avatars are made on Settings > Agent.",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid.nullable() }),
    run: async (ctx, { id }) => {
      const before = (await ctx.store.settings()).activeAvatar?.id ?? null;
      const avatar = id === null ? null : (await ctx.store.listAvatars()).find((a) => a.id === id);
      if (avatar === undefined) throw new ToolError("No such avatar: call list_avatars for the ids.");
      await ctx.store.updateSettings({ activeAvatarId: id });
      return {
        data: { active: avatar && { id: avatar.id, name: avatar.name } },
        summary: avatar ? `Avatar: ${avatar.name}` : "Avatar: Hydra's own voice",
        inverse: { tool: "switch_avatar", input: { id: before } },
      };
    },
  }),
  defineTool({
    name: "add_business",
    description:
      "Add a business. Its slug comes from the name. taxShape: sole_prop or llc (single-member) get Schedule C on Taxes like UGC; s_corp, partnership, other show income and expenses only.",
    group: "hydra",
    kind: "write",
    input: z.object({ name: z.string().trim().min(1).max(60), taxShape: z.enum(TAX_SHAPES) }),
    run: async (_ctx, input) => {
      const e = unwrap(await businesses.addBusiness(input));
      return { data: e, summary: `Added the business ${e.name}`, inverse: { tool: "delete_business", input: { id: e.id } } };
    },
  }),
  defineTool({
    name: "update_business",
    description: "Rename a business (Personal too) or change its tax type. The slug never changes.",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid, name: z.string().trim().min(1).max(60).optional(), taxShape: z.enum(TAX_SHAPES).optional() }),
    run: async (ctx, input) => {
      const before = await rowOf<{ name: string; tax_shape: (typeof TAX_SHAPES)[number] | null }>(ctx, "entities", input.id, "name, tax_shape");
      const e = unwrap(await businesses.updateBusiness(input));
      const back = { id: input.id, ...(input.name !== undefined && before ? { name: before.name } : {}), ...(input.taxShape !== undefined && before?.tax_shape ? { taxShape: before.tax_shape } : {}) };
      return { data: e, summary: `Updated ${e.name}`, inverse: Object.keys(back).length > 1 ? { tool: "update_business", input: back } : null };
    },
  }),
  defineTool({
    name: "close_business",
    description: "Close a business (asks first): it leaves the scope switch and the pickers; its history stays in reports and Taxes. Personal cannot be closed.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Close this business",
    // Like close_account: a removal from the lists asks first (reopen_business puts it back).
    gate: namedDelete("Close this business", async (ctx, { id }: { id: string }) => {
      const row = await rowOf<{ name: string }>(ctx, "entities", id, "name");
      return row && `Close the business ${q(row.name)}`;
    }),
    input: z.object({ id: uuid }),
    run: async (_ctx, input) => {
      const e = unwrap(await businesses.closeBusiness(input));
      return { data: e, summary: `Closed ${e.name}`, inverse: { tool: "reopen_business", input } };
    },
  }),
  defineTool({
    name: "reopen_business",
    description: "Reopen a closed business.",
    group: "hydra",
    kind: "write",
    input: z.object({ id: uuid }),
    run: async (_ctx, input) => {
      const e = unwrap(await businesses.reopenBusiness(input));
      return { data: e, summary: `Reopened ${e.name}`, inverse: { tool: "close_business", input } };
    },
  }),
  defineTool({
    name: "delete_business",
    description: "Delete a business nothing uses (asks first). One with accounts, transactions, rules, deals or tax rows cannot be deleted: close it instead.",
    group: "hydra",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this business",
    gate: namedDelete("Delete this business", async (ctx, { id }: { id: string }) => {
      const row = await rowOf<{ name: string }>(ctx, "entities", id, "name");
      return row && `Delete the business ${q(row.name)}`;
    }),
    input: z.object({ id: uuid }),
    run: async (_ctx, input) => ({ data: unwrap(await businesses.deleteBusiness(input)), summary: "Deleted a business", inverse: null }),
  }),
];
