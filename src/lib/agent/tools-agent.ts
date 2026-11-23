import { z } from "zod";
import { PANEL_PARAMS } from "./events";
import { internalHref } from "./relay-schema";
import { defineTool, macDeletes, scopeSchema, ToolError, uuid, type ToolDef } from "./registry";
import { describeSchedule, nextRun, scheduleSchema, type Schedule } from "./schedule";
import { DESKTOP_FRESH_MS, type RoutineFields, type RoutineRow } from "./store";
import { namedDelete, q } from "./tools-confirm";

/**
 * The agent's own tools: the interface (navigate, panels, scope, highlight), routines, memory and
 * Mac steps for Hydra Desktop. Interface tools change nothing on the server: they emit a `ui`
 * event the window acts on.
 */

/** A path inside Hydra: one leading slash, no scheme, no host, no backslash (the relay's shared rule). */
export { internalHref };

const uiTools: ToolDef[] = [
  defineTool({
    name: "navigate",
    description: "Go to a page: /, /planning, /notes (?note=id opens one), /routines, /ugc, /brand (Personal Brand), /reports, /transactions, /taxes, /accounts (Accounts, Recurring), /activity, /settings (Businesses, General, Agent, Connections) (query strings allowed).",
    group: "ui",
    kind: "read",
    input: z.object({ href: internalHref }),
    run: async (_ctx, { href }) => ({ data: { ok: true }, summary: `Opened ${href}`, ui: { kind: "navigate", href } }),
  }),
  defineTool({
    name: "open_panel",
    description: "Open the side panel for one row: tx, day, account, task, goal, deal, category or routine, with its id (day: YYYY-MM-DD).",
    group: "ui",
    kind: "read",
    input: z.object({ param: z.enum(PANEL_PARAMS), value: z.string().min(1).max(100).regex(/^[\w-]+$/) }),
    run: async (_ctx, { param, value }) => ({ data: { ok: true }, summary: `Opened ${param}`, ui: { kind: "openPanel", param, value } }),
  }),
  defineTool({
    name: "set_scope",
    description: "Switch the scope: all, or a business slug from get_settings (personal, ugc, ...).",
    group: "ui",
    kind: "read",
    input: z.object({ scope: scopeSchema }),
    run: async (_ctx, { scope }) => ({ data: { ok: true }, summary: `Scope: ${scope}`, ui: { kind: "setScope", scope } }),
  }),
  defineTool({
    name: "highlight",
    description: "Briefly highlight an element on the page, by CSS selector (for example [data-row-id=\"...\"]).",
    group: "ui",
    kind: "read",
    input: z.object({ selector: z.string().min(1).max(200) }),
    run: async (_ctx, { selector }) => ({ data: { ok: true }, summary: "Highlighted", ui: { kind: "highlight", selector } }),
  }),
];

// ── Routines ──────────────────────────────────────────────────────────────

const routineTool = z.enum(["hydra", "mac", "gmail", "calendar"]);
const delivery = z.enum(["spoken", "notification", "push", "email"]);
const routineInput = z.object({
  name: z.string().min(1).max(120),
  instruction: z.string().min(1).max(4000),
  schedule: scheduleSchema,
  tools: z.array(routineTool).min(1).max(4).optional(),
  delivery: z.array(delivery).max(4).optional(),
  whenMacOff: z.enum(["wait", "skip"]).optional(),
});

/** A routine row as the input of create_routine (the inverse of a delete). */
const asInput = (r: RoutineRow) => ({
  name: r.name,
  instruction: r.instruction,
  schedule: r.schedule,
  tools: r.tools,
  delivery: r.delivery,
  whenMacOff: r.when_mac_off,
});

async function mustRoutine(ctx: Parameters<ToolDef["run"]>[0], routineId: string): Promise<RoutineRow> {
  const r = await ctx.store.getRoutine(routineId);
  if (!r) throw new ToolError("That routine is gone.");
  return r;
}

async function patchRoutine(ctx: Parameters<ToolDef["run"]>[0], routineId: string, patch: Partial<RoutineFields>) {
  const r = await ctx.store.updateRoutine(routineId, patch);
  if (!r) throw new ToolError("That routine is gone.");
  return r;
}

const routineTools: ToolDef[] = [
  defineTool({
    name: "list_routines",
    description: "Routines with their schedule, next run and the last runs.",
    group: "routines",
    kind: "read",
    input: z.object({}),
    run: async (ctx) => {
      const [routines, runs] = await Promise.all([ctx.store.listRoutines(), ctx.store.recentRuns(null, 30)]);
      return {
        data: routines.map((r) => ({
          ...r,
          scheduleText: describeSchedule(r.schedule as Schedule),
          lastRuns: runs.filter((run) => run.routine_id === r.id).slice(0, 3),
        })),
        summary: "Read routines",
      };
    },
  }),
  defineTool({
    name: "create_routine",
    description:
      "Make a routine: a plain-words instruction Hydra runs on a schedule (owner's time zone), with the tools it may use (hydra, mac, gmail, calendar) and where the result goes.",
    group: "routines",
    kind: "write",
    input: routineInput,
    run: async (ctx, input) => {
      const tz = await ctx.timeZone();
      const routine = await ctx.store.createRoutine({
        name: input.name,
        instruction: input.instruction,
        schedule: input.schedule,
        tools: input.tools ?? ["hydra"],
        delivery: input.delivery ?? ["notification"],
        when_mac_off: input.whenMacOff ?? "wait",
        paused: false,
        next_run_at: nextRun(input.schedule, ctx.now(), tz).toISOString(),
      });
      return {
        data: routine,
        summary: `Routine: ${routine.name} (${describeSchedule(input.schedule)})`,
        inverse: { tool: "delete_routine", input: { id: routine.id } },
        ui: { kind: "openPanel", param: "routine", value: routine.id },
      };
    },
  }),
  defineTool({
    name: "update_routine",
    description: "Change a routine's name, instruction, schedule, tools, delivery or what to do when the Mac is off.",
    group: "routines",
    kind: "write",
    input: routineInput.partial().extend({ id: uuid }),
    run: async (ctx, { id, ...input }) => {
      const patch: Partial<RoutineFields> = {
        name: input.name,
        instruction: input.instruction,
        schedule: input.schedule,
        tools: input.tools,
        delivery: input.delivery,
        when_mac_off: input.whenMacOff,
      };
      if (input.schedule) patch.next_run_at = nextRun(input.schedule, ctx.now(), await ctx.timeZone()).toISOString();
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<RoutineFields>;
      if (!Object.keys(clean).length) throw new ToolError("Nothing to change.");
      const { before, after } = await patchRoutine(ctx, id, clean);
      return { data: after, summary: `Changed routine ${after.name}`, inverse: { tool: "update_routine", input: { id, ...asInput(before) } } };
    },
  }),
  defineTool({
    name: "pause_routine",
    description: "Pause a routine.",
    group: "routines",
    kind: "write",
    input: z.object({ id: uuid }),
    run: async (ctx, { id }) => {
      const { after } = await patchRoutine(ctx, id, { paused: true });
      return { data: after, summary: `Paused ${after.name}`, inverse: { tool: "resume_routine", input: { id } } };
    },
  }),
  defineTool({
    name: "resume_routine",
    description: "Resume a paused routine from its next scheduled time.",
    group: "routines",
    kind: "write",
    input: z.object({ id: uuid }),
    run: async (ctx, { id }) => {
      const r = await mustRoutine(ctx, id);
      const next = nextRun(r.schedule as Schedule, ctx.now(), await ctx.timeZone()).toISOString();
      const { after } = await patchRoutine(ctx, id, { paused: false, next_run_at: next });
      return { data: after, summary: `Resumed ${after.name}`, inverse: { tool: "pause_routine", input: { id } } };
    },
  }),
  defineTool({
    name: "run_routine_now",
    description: "Run a routine now (it starts within a minute).",
    group: "routines",
    kind: "write",
    input: z.object({ id: uuid }),
    run: async (ctx, { id }) => {
      const r = await mustRoutine(ctx, id);
      if (r.paused) throw new ToolError("Resume it first.");
      const { after } = await patchRoutine(ctx, id, { next_run_at: ctx.now().toISOString() });
      return { data: after, summary: `Running ${after.name}`, inverse: null };
    },
  }),
  defineTool({
    name: "delete_routine",
    description: "Delete a routine and its run history.",
    group: "routines",
    kind: "write",
    risk: "delete",
    describe: () => "Delete this routine",
    gate: namedDelete("Delete this routine", async (ctx, { id }: { id: string }) => {
      const r = await ctx.store.getRoutine(id);
      return r && `Delete routine ${q(r.name)} and its run history`;
    }),
    input: z.object({ id: uuid }),
    run: async (ctx, { id }) => {
      const before = await ctx.store.deleteRoutine(id);
      if (!before) throw new ToolError("That routine is gone.");
      return { data: { id }, summary: `Deleted routine ${before.name}`, inverse: { tool: "create_routine", input: asInput(before) } };
    },
  }),
];

// ── Memory ────────────────────────────────────────────────────────────────

const memoryTools: ToolDef[] = [
  defineTool({
    name: "remember",
    description: "Keep a short fact the owner asked Hydra to remember, under a key.",
    group: "memory",
    kind: "write",
    input: z.object({ key: z.string().min(1).max(100), value: z.string().min(1).max(2000) }),
    run: async (ctx, { key, value }) => {
      const before = await ctx.store.remember(key, value);
      return {
        data: { key },
        summary: `Remembered ${key}`,
        inverse: before === null ? { tool: "forget", input: { key } } : { tool: "remember", input: { key, value: before } },
      };
    },
  }),
  defineTool({
    name: "forget",
    description: "Forget a remembered fact.",
    group: "memory",
    kind: "write",
    risk: "delete",
    describe: (i) => `Forget "${i.key}"`,
    input: z.object({ key: z.string().min(1).max(100) }),
    run: async (ctx, { key }) => {
      const before = await ctx.store.forget(key);
      if (before === null) throw new ToolError("Nothing is remembered under that key.");
      return { data: { key }, summary: `Forgot ${key}`, inverse: { tool: "remember", input: { key, value: before } } };
    },
  }),
];

// ── Mac (Hydra Desktop) ──────────────────────────────────────────────────

const macTools: ToolDef[] = [
  defineTool({
    name: "mac_do",
    description:
      "Ask Hydra Desktop to do one step on the Mac (open or quit an app, arrange windows, open a file or site, click, type). risky=true if it sends, pays or quits with unsaved work. deletes=true if it deletes or loses data; false only if surely not.",
    group: "mac",
    kind: "write",
    // A Mac deletion is a deletion: it asks even under approve all (owner rule: every deletion of anything). Fail
    // closed: deletion words gate it whatever the flags say, and a risky step is a "mac" ask only when the model said
    // deletes=false; unsure (unset) asks as a deletion. Approve all runs a "mac" ask only for desktops that tag their
    // own deletions (autoApproves, 0200 capabilities).
    risk: (i) => (i.deletes !== false && (i.deletes || i.risky)) || macDeletes(i.instruction) ? "delete" : i.risky ? "mac" : null,
    describe: (i) => `On the Mac: ${i.instruction.slice(0, 200)}`,
    input: z.object({ instruction: z.string().min(1).max(4000), risky: z.boolean(), deletes: z.boolean().optional() }),
    run: async (ctx, { instruction, risky: flagged, deletes }) => {
      const risky = flagged || deletes === true;
      const online = await ctx.store.desktopOnline(new Date(ctx.now().getTime() - DESKTOP_FRESH_MS));
      const routine = ctx.runId ? await ctx.store.getRun(ctx.runId).then((run) => (run ? ctx.store.getRoutine(run.routine_id) : null)) : null;
      const skip = !online && routine?.when_mac_off === "skip";
      // A risky step approve all let through goes only to a desktop whose pull declares approveAllDeletionTags (0200):
      // the tags were checked at the gate, and an older Mac that pairs or a downgrade before the pull would not ask.
      const needs_tags = risky && ctx.autoApproved === true;
      const jobId = await ctx.store.queueDesktopJob({ run_id: ctx.runId, thread_id: ctx.threadId, instruction, risky, needs_tags }, skip ? "skipped" : "queued");
      const status = skip ? "skipped: the Mac is off" : online ? "sent to the Mac" : "queued until the Mac is on";
      return { data: { jobId, status }, summary: `Mac step ${status}`, inverse: null };
    },
  }),
];

export const AGENT_TOOLS: ToolDef[] = [...uiTools, ...routineTools, ...memoryTools, ...macTools];
