// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const planning = vi.hoisted(() => {
  const status = { id: "00000000-0000-4000-8000-0000000000a1", label: "To do", color: "#1d1d1f", position: 1024, isDone: false };
  const task = {
    id: "00000000-0000-4000-8000-0000000000b1",
    title: "Send the W-9",
    notes: "",
    statusId: status.id,
    goalId: null,
    category: null,
    dueDate: "2026-11-21",
    position: 1024,
    alertAt: "2026-11-21T23:00:00.000Z",
    repeatRule: null,
    repeatSeriesId: null,
    createdAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    completedAt: null,
    values: {},
  };
  const tasks: (typeof task)[] = [task];
  return {
    status,
    task,
    tasks,
    loadPlanning: vi.fn(async () => ({ ok: true, value: { statuses: [status], tasks: [...tasks], goals: [], events: [], properties: [], timeZone: "America/Toronto" } })),
    createTask: vi.fn(async (input: { id: string; title: string }) => {
      const created = { ...task, ...input, id: input.id, title: input.title };
      tasks.push(created);
      return { ok: true, value: created };
    }),
    updateTask: vi.fn(async (taskId: string, patch: object) => ({ ok: true, value: { ...task, id: taskId, ...patch } })),
    setTaskPositions: vi.fn(async () => ({ ok: true, value: null })),
    deleteTask: vi.fn(async (taskId: string) => {
      const i = tasks.findIndex((t) => t.id === taskId);
      if (i >= 0) tasks.splice(i, 1);
      return { ok: true, value: null };
    }),
    setGoalPositions: vi.fn(async () => ({ ok: true, value: null })),
    updateGoalMetric: vi.fn(async (metricId: string, patch: object) => ({ ok: true, value: { id: metricId, ...patch } })),
    createOption: vi.fn(async (input: { id: string; label: string }) => ({ ok: true, value: { ...input, position: 9999 } })),
    deleteOption: vi.fn(async () => ({ ok: true, value: null })),
    reorderOptions: vi.fn(async () => ({ ok: true, value: null })),
    updateStatus: vi.fn(async (statusId: string, patch: object) => ({ ok: true, value: { ...status, id: statusId, ...patch } }) as object),
  };
});

vi.mock("server-only", () => ({}));
const bank = vi.hoisted(() => ({ deleteManualTransaction: vi.fn(), editTransaction: vi.fn() }));
const txReads = vi.hoisted(() => ({ getRow: vi.fn(async () => null as unknown), dealPayment: vi.fn(async () => null as unknown) }));
const accounts = vi.hoisted(() => ({ setTimeZone: vi.fn(), setIdleLock: vi.fn() }));
const activity = vi.hoisted(() => ({ listActivity: vi.fn(), undoActivity: vi.fn() }));
const owner = vi.hoisted(() => ({ upserts: [] as unknown[] }));

vi.mock("@/lib/planning/actions", () => ({
  loadPlanning: planning.loadPlanning,
  createTask: planning.createTask,
  updateTask: planning.updateTask,
  setTaskPositions: planning.setTaskPositions,
  deleteTask: planning.deleteTask,
  setGoalPositions: planning.setGoalPositions,
  updateGoalMetric: planning.updateGoalMetric,
  createOption: planning.createOption,
  deleteOption: planning.deleteOption,
  reorderOptions: planning.reorderOptions,
  updateStatus: planning.updateStatus,
}));
vi.mock("@/lib/bank/actions", () => bank);
vi.mock("@/lib/bank/server", () => ({
  NotOwnerError: class extends Error {},
  requireOwner: async () => ({
    userId: "owner",
    db: { from: () => ({ upsert: async (row: unknown) => (owner.upserts.push(row), { error: null }) }) },
  }),
}));
vi.mock("@/lib/activity/queries", () => ({ listActivity: activity.listActivity }));
vi.mock("@/lib/activity/actions", () => ({ undoActivity: activity.undoActivity }));
vi.mock("@/app/(app)/taxes/actions", () => ({}));
vi.mock("@/app/(app)/taxes/data", () => ({}));
vi.mock("@/app/(app)/accounts/actions", () => accounts);
vi.mock("@/app/(app)/accounts/data", () => ({}));
vi.mock("@/app/(app)/planning/actions", () => ({}));
vi.mock("@/app/(app)/settings/actions", () => ({}));
vi.mock("@/app/(app)/reports/actions", () => ({}));
vi.mock("@/app/(app)/transactions/reads", () => txReads);
vi.mock("@/lib/rules/actions", () => ({}));
vi.mock("@/lib/ugc/actions", () => ({}));
vi.mock("@/lib/layout/actions", () => ({}));

const { anthropicTools, executeTool, TOOLS, toolByName, undoAction, rowsLogged, ALL_GROUPS, STRICT_LIMITS, schemaCost } = await import("./tools");
const { gateFor, BULK_LIMIT } = await import("./registry");
const { memoryStore } = await import("./testing");
const { toolCtx } = await import("./fixtures");

const ID = "00000000-0000-4000-8000-000000000001";

/** A read-only owner client: from(table).select(..)[.eq(..)].maybeSingle() gives that table's one row. */
function fakeDb(rows: Record<string, unknown>) {
  const query = (table: string) => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) };
    return q;
  };
  return { from: query } as never;
}

/** A valid input for every tool whose name says it removes something. */
const DELETE_INPUTS: Record<string, unknown> = {
  close_account: { accountId: ID },
  delete_rule: { id: ID },
  unpair_transfer: { transactionId: ID },
  dismiss_recurring: { id: ID },
  delete_category: { id: ID },
  merge_categories: { fromId: ID, intoId: ID },
  delete_deal: { id: ID },
  delete_post: { id: ID },
  unmatch_payment: { transactionId: ID },
  remove_payout_rule: { dealId: ID, payerKey: "paypal" },
  delete_task: { id: ID },
  clear_reminder: { kind: "task", id: ID },
  delete_goal: { id: ID },
  remove_goal_metric: { id: ID },
  remove_goal_link: { id: ID },
  delete_event: { id: ID },
  delete_status: { id: ID, moveTo: null },
  delete_property: { id: ID },
  reset_layout: { breakpoint: "desktop" },
  delete_routine: { id: ID },
  forget: { key: "accountant" },
  delete_note: { id: ID },
  // Deletions by value:
  edit_transaction: { transactionId: ID, hidden: true },
  map_category_tax_line: { categoryId: ID, entityId: ID, taxLineId: null },
  set_day_target: { dealId: ID, day: "2026-11-21", target: null },
  set_task_value: { taskId: ID, propertyId: ID, value: null },
  update_task: { id: ID, patch: { alertAt: null } },
  update_event: { id: ID, patch: { alertAt: null } },
  gmail_trash: { threadId: "18c2f0a1b2" },
  calendar_confirm_delete: { linkId: ID },
  delete_transaction: { transactionId: ID },
  delete_tax_payment: { entity: "ugc", year: 2026, quarter: 3 },
  delete_tax_document: { id: ID },
  delete_property_option: { id: ID },
  close_business: { id: ID },
  delete_business: { id: ID },
};

const REMOVING = /^(delete|remove|forget|clear|close|unmatch|unpair|dismiss|merge|reset)_?/;

describe("tool registry", () => {
  it("has unique names and a short description on every tool", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
      expect(t.description.length).toBeLessThan(260);
    }
  });

  it("covers every engine: ugc, bank, rules, recurring, ledger, planning with reminders, reports, layout", () => {
    for (const name of [
      "list_deals", "create_deal", "add_post", "set_views", "match_payment",
      "suggest_payout_matches", "confirm_payout_match",
      "list_accounts", "list_transactions", "add_transaction", "edit_transaction", "import_file",
      "create_rule", "apply_rules", "set_transaction_category", "list_categories",
      "list_recurring", "confirm_recurring", "detect_recurring",
      "pair_transfers", "auto_pair_transfers",
      "get_planning", "create_task", "set_reminder", "create_event", "create_goal",
      "get_report", "get_layouts", "save_layout",
      "navigate", "open_panel", "set_scope", "highlight",
      "create_routine", "update_routine", "pause_routine", "resume_routine", "run_routine_now", "delete_routine",
      "undo_action", "list_activity", "remember", "mac_do",
    ]) {
      expect(toolByName(name), name).toBeDefined();
    }
  });

  it("sends eager-streaming tools, strict within the API's budget (deletes first), cached at the last tool", () => {
    for (const groups of [ALL_GROUPS, new Set(["hydra", "memory"] as const), new Set(["mac"] as const)]) {
      const tools = anthropicTools(groups);
      const strict = tools.filter((t) => t.strict);
      expect(strict.length).toBeLessThanOrEqual(STRICT_LIMITS.tools);
      const cost = strict.map((t) => schemaCost(t.input_schema)).reduce((a, c) => ({ optional: a.optional + c.optional, unions: a.unions + c.unions }), { optional: 0, unions: 0 });
      expect(cost.optional).toBeLessThanOrEqual(STRICT_LIMITS.optional);
      expect(cost.unions).toBeLessThanOrEqual(STRICT_LIMITS.unions);
    }
    const tools = anthropicTools(ALL_GROUPS);
    expect(tools).toHaveLength(TOOLS.length);
    const strictNames = new Set(tools.filter((t) => t.strict).map((t) => t.name));
    // With every group there are more deletes than the API's 20 strict tools: strict goes to deletes
    // only, as many as the cap allows (zod still validates every input before a tool runs).
    const deletes = TOOLS.filter((d) => d.risk === "delete").map((d) => d.name);
    expect(strictNames.size).toBe(Math.min(deletes.length, STRICT_LIMITS.tools));
    for (const name of strictNames) expect(deletes, name).toContain(name);
    // Per caller set: at or over the cap, the 20 strict tools are all deletes; below it, every delete is strict.
    for (const groups of [new Set(["hydra", "memory", "routines"] as const), new Set(["hydra"] as const), new Set(["gmail", "calendar"] as const)]) {
      const strictHere = anthropicTools(groups).filter((t) => t.strict).map((t) => t.name);
      const deletesHere = TOOLS.filter((d) => d.risk === "delete" && groups.has(d.group as never)).map((d) => d.name);
      if (deletesHere.length >= STRICT_LIMITS.tools) {
        expect(strictHere).toHaveLength(STRICT_LIMITS.tools);
        for (const name of strictHere) expect(deletesHere, name).toContain(name);
      } else {
        for (const name of deletesHere) expect(strictHere, name).toContain(name);
      }
    }
    for (const t of tools) {
      expect(t.eager_input_streaming).toBe(true);
      expect(t.input_schema.type).toBe("object");
      expect((t.input_schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
    expect(tools.filter((t) => t.cache_control)).toHaveLength(1);
    expect(tools.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    // Same input, same bytes: the cached prefix holds.
    expect(JSON.stringify(anthropicTools(ALL_GROUPS))).toBe(JSON.stringify(tools));
  });

  it("only offers the groups a caller may use", () => {
    const names = anthropicTools(new Set(["hydra"])).map((t) => t.name);
    expect(names).toContain("create_task");
    expect(names).not.toContain("navigate");
    expect(names).not.toContain("mac_do");
    expect(names).not.toContain("create_routine");
  });
});

describe("confirm gate", () => {
  let mem: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    vi.clearAllMocks();
    mem = memoryStore();
  });

  it("every tool that removes anything is listed here, and every one of them asks first", async () => {
    const removing = TOOLS.filter((t) => REMOVING.test(t.name)).map((t) => t.name);
    for (const name of removing) expect(DELETE_INPUTS, `${name} needs a delete input`).toHaveProperty(name);
    for (const [name, input] of Object.entries(DELETE_INPUTS)) {
      const def = toolByName(name)!;
      const parsed = def.input.parse(input);
      const gate = await gateFor(def, toolCtx(mem.store), parsed);
      expect(gate, name).not.toBeNull();
      expect(gate!.reason, name).toBe("delete");
      expect(gate!.danger, name).toBe(true);
      const res = await executeTool(name, input, toolCtx(mem.store));
      expect(res.status, name).toBe("confirm");
    }
    expect(planning.deleteTask).not.toHaveBeenCalled();
    expect(mem.actions).toHaveLength(0);
  });

  it("asks first before each delete added for full coverage", async () => {
    for (const name of ["delete_transaction", "delete_tax_payment", "delete_tax_document", "delete_property_option"]) {
      expect(toolByName(name), name).toBeDefined();
      expect(toolByName(name)!.risk, name).toBe("delete");
      expect((await executeTool(name, DELETE_INPUTS[name], toolCtx(mem.store))).status, name).toBe("confirm");
    }
    expect(bank.deleteManualTransaction).not.toHaveBeenCalled();
    expect(mem.actions).toHaveLength(0);
  });

  it("asks before changing more than 10 rows, not at 10", async () => {
    const items = (n: number) => Array.from({ length: n }, () => ({ postId: ID, views: 5 }));
    const ctx = toolCtx(mem.store);
    expect(await gateFor(toolByName("set_views")!, ctx, { capturedAt: "2026-11-21T12:00:00Z", force: false, items: items(BULK_LIMIT) })).toBeNull();
    const gate = await gateFor(toolByName("set_views")!, ctx, { capturedAt: "2026-11-21T12:00:00Z", force: false, items: items(BULK_LIMIT + 1) });
    expect(gate?.reason).toBe("bulk");
    expect((await gateFor(toolByName("apply_rules")!, ctx, { from: "2026-01-01" }))?.reason).toBe("bulk");
    expect(await gateFor(toolByName("apply_rules")!, ctx, { transactionId: ID })).toBeNull();
  });

  it("asks before a risky Mac step, not a plain one", async () => {
    const ctx = toolCtx(mem.store);
    const reason = async (input: { instruction: string; risky: boolean; deletes?: boolean }) => (await gateFor(toolByName("mac_do")!, ctx, input))?.reason ?? null;
    // "mac" (the ask approve all may run) only when the model said the risky step deletes nothing.
    expect(await reason({ instruction: "Quit Xcode", risky: true, deletes: false })).toBe("mac");
    // A Mac deletion is a deletion (it asks even under approve all): by the flag, or by its words, whatever the flags say.
    expect(await reason({ instruction: "Empty the Trash", risky: true })).toBe("delete");
    expect(await reason({ instruction: "Tidy the Desktop", risky: false, deletes: true })).toBe("delete");
    expect(await reason({ instruction: "Quit Xcode, discard unsaved work", risky: true, deletes: false })).toBe("delete");
    expect(await reason({ instruction: "Delete ~/Downloads/old.zip", risky: false })).toBe("delete");
    // Fail closed: a risky step that did not say it deletes nothing asks as a deletion.
    expect(await reason({ instruction: "Quit Xcode", risky: true })).toBe("delete");
    expect(await reason({ instruction: "Open Notes", risky: false })).toBeNull();
    // A calm risky step the model said deletes nothing stays the one approve all may run.
    for (const instruction of ["Quit Safari", "Send the draft in Mail", "Close the Notes window"]) {
      expect(await reason({ instruction, risky: true, deletes: false }), instruction).toBe("mac");
    }
  });

  it.each([
    "Move ~/Downloads/old.zip to the Bin",
    "Clear out the Downloads folder",
    "Throw away the old screenshots on the Desktop",
    "Get rid of every .dmg in Downloads",
    "Format the external drive",
    "Clean up the Desktop: discard every file older than a year",
    "Close Pages without saving",
    "Overwrite report.pdf with the new one",
    // Round 3: macOS's own curly apostrophe, and losing data in other words.
    "Click “Don’t Save” in the TextEdit dialog",
    "Click Don’t Save and quit Pages",
    "Click Do not save",
    "In Finder, select Old.pdf and press Cmd+Backspace",
    "Select Old.pdf and press ⌘⌫",
    "Force quit TextEdit; the unsaved draft will be lost",
    "Kill the Xcode process",
    "Terminate the running export",
    "Run mv ~/Documents/report.pdf /dev/null",
    "Run cat /dev/null > notes.txt",
    "Drop the users table in TablePlus",
    "Close the window and lose the changes",
    "Truncate log.txt",
  ])("a Mac deletion in other words is a deletion, even flagged safe: %s", async (instruction) => {
    const ctx = toolCtx(mem.store);
    for (const flags of [{ risky: true }, { risky: true, deletes: false }, { risky: false }]) {
      expect((await gateFor(toolByName("mac_do")!, ctx, { instruction, ...flags }))?.reason).toBe("delete");
    }
  });

  it("does not gate a plain write", async () => {
    const res = await executeTool("create_task", { title: "Call the bank" }, toolCtx(mem.store));
    expect(res.status).toBe("ok");
  });

  it("validates input before a tool runs", async () => {
    const res = await executeTool("delete_task", { id: "not-a-uuid" }, toolCtx(mem.store));
    expect(res.status).toBe("invalid");
    expect(await executeTool("create_task", { title: "" }, toolCtx(mem.store))).toMatchObject({ status: "invalid" });
    expect(planning.createTask).not.toHaveBeenCalled();
  });

  it("refuses a tool outside the caller's groups", async () => {
    const res = await executeTool("navigate", { href: "/planning" }, toolCtx(mem.store, { allowed: new Set(["hydra"]) }));
    expect(res).toMatchObject({ status: "error" });
  });

  it("keeps navigation inside Hydra", async () => {
    for (const href of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      expect((await executeTool("navigate", { href }, toolCtx(mem.store))).status, href).toBe("invalid");
    }
    const ui = vi.fn();
    expect((await executeTool("navigate", { href: "/transactions?tx=1" }, toolCtx(mem.store, { ui }))).status).toBe("ok");
    expect(ui).toHaveBeenCalledWith({ kind: "navigate", href: "/transactions?tx=1" });
  });
});

describe("undo", () => {
  let mem: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    vi.clearAllMocks();
    planning.tasks.splice(0, planning.tasks.length, planning.task);
    mem = memoryStore();
  });

  it("logs each write with its inverse and undoes it once", async () => {
    const ctx = toolCtx(mem.store, { surface: "routine" }); // a routine's writes are not logged: its tool inverse is the undo
    const created = await executeTool("create_task", { title: "Call the bank" }, ctx);
    expect(created.status).toBe("ok");
    const actionId = (created as { actionId: string }).actionId;
    const taskId = planning.createTask.mock.calls[0][0].id;
    expect(mem.actions[0]).toMatchObject({ tool: "create_task", inverse: { tool: "delete_task", input: { id: taskId } } });

    // Undoing a create deletes: without the owner's tap it asks first.
    expect((await undoAction(actionId, ctx, { approved: false })).status).toBe("confirm");
    expect(planning.deleteTask).not.toHaveBeenCalled();

    // Two taps at once: one undo.
    const [a, b] = await Promise.all([undoAction(actionId, ctx, { approved: true }), undoAction(actionId, ctx, { approved: true })]);
    expect([a.status, b.status].sort()).toEqual(["error", "ok"]);
    expect(planning.deleteTask).toHaveBeenCalledTimes(1);
    expect(planning.deleteTask).toHaveBeenCalledWith(taskId);
    expect(mem.actions[0].undone_at).not.toBeNull();
    expect(mem.actions[0].undo_action_id).toBe(mem.actions[1].id);
    expect(mem.actions[1]).toMatchObject({ tool: "delete_task", inverse: { tool: "create_task" } });
    expect((await undoAction(actionId, ctx, { approved: true })).status).toBe("error");
  });

  it("restores a deleted task from what it was", async () => {
    const ctx = toolCtx(mem.store, { surface: "routine" }); // a routine's writes are not logged: its tool inverse is the undo
    const res = await executeTool("delete_task", { id: planning.task.id }, ctx, { approved: true });
    expect(res.status).toBe("ok");
    const undone = await undoAction((res as { actionId: string }).actionId, ctx, { approved: true });
    expect(undone.status).toBe("ok");
    expect(planning.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: planning.task.id, title: "Send the W-9", alertAt: planning.task.alertAt, statusId: planning.status.id }),
    );
  });

  it("releases the claim when the inverse fails, and refuses what cannot be undone", async () => {
    const ctx = toolCtx(mem.store, { surface: "routine" }); // a routine's writes are not logged: its tool inverse is the undo
    const created = await executeTool("create_task", { title: "Call the bank" }, ctx);
    planning.deleteTask.mockResolvedValueOnce({ ok: false, error: "Database down" } as never);
    const failed = await undoAction((created as { actionId: string }).actionId, ctx, { approved: true });
    expect(failed).toMatchObject({ status: "error", message: "Database down" });
    expect(mem.actions[0].undone_at).toBeNull();

    const run = await executeTool("run_routine_now", { id: ID }, ctx);
    expect(run.status).toBe("error"); // no such routine
    const irreversible = await mem.store.logAction({
      thread_id: null, run_id: null, device_id: null, tool: "sync_bank", input: {}, result: null, summary: "Synced", inverse: null, surface: "web",
    });
    expect(await undoAction(irreversible, ctx, { approved: true })).toMatchObject({ status: "error", message: "That action cannot be undone." });
  });

  it("undo_action by voice asks first when the inverse deletes", async () => {
    const ctx = toolCtx(mem.store, { surface: "routine" }); // a routine's writes are not logged: its tool inverse is the undo
    const created = await executeTool("create_task", { title: "Call the bank" }, ctx);
    const res = await executeTool("undo_action", { actionId: (created as { actionId: string }).actionId }, ctx);
    expect(res).toMatchObject({ status: "confirm", gate: { reason: "delete", summary: expect.stringContaining("Undo:") } });
    expect(planning.deleteTask).not.toHaveBeenCalled();
  });

  it("a Hydra step outside a routine is undone in Activity only, not by its inverse too (F2)", async () => {
    const ctx = toolCtx(mem.store); // web: the write went through the owner's session, so it is logged
    const created = await executeTool("create_task", { title: "Call the bank" }, ctx);
    const actionId = (created as { actionId: string }).actionId;
    expect(await undoAction(actionId, ctx, { approved: true, refuseLogged: true })).toMatchObject({ status: "error", message: expect.stringContaining("Activity") });
    expect(await executeTool("undo_action", { actionId }, ctx)).toMatchObject({ status: "error", message: expect.stringContaining("Activity") });
    expect(planning.deleteTask).not.toHaveBeenCalled();
    expect(mem.actions[0].undone_at).toBeNull();
    // An outside step (Gmail) keeps its tool undo on every surface.
    expect(rowsLogged({ tool: "gmail_label", surface: "web" })).toBe(false);
    expect(rowsLogged({ tool: "create_task", surface: "routine" })).toBe(false);
    expect(rowsLogged({ tool: "delete_rule", surface: "phone" })).toBe(true);
  });
});

describe("full coverage", () => {
  it("reads and writes every area: taxes, settings, statuses, options, bank detail", () => {
    for (const name of [
      "get_taxes", "set_tax_rate", "save_tax_payment", "delete_tax_payment", "delete_tax_document", "tax_line_transactions",
      "update_status", "set_status_done", "reorder_planning", "update_property", "add_property_option", "update_property_option", "delete_property_option",
      "update_goal_metric", "update_goal_link", "move_task",
      "delete_transaction", "get_balance_history", "get_transaction", "transfer_suggestions", "reject_transfer_suggestion",
      "create_deal_from_template", "list_deal_templates", "category_month", "goal_metric_value",
      "get_settings", "set_idle_lock", "set_sleep_word", "set_time_zone",
    ]) {
      expect(toolByName(name), name).toBeDefined();
    }
  });

  it("never offers API keys, device pairing or the agent's own model and effort", () => {
    for (const t of TOOLS) expect(t.name, t.name).not.toMatch(/api_key|device|set_model|set_effort|link_token|public_token/);
  });
});

describe("delete_transaction", () => {
  let mem: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    vi.clearAllMocks();
    txReads.getRow.mockResolvedValue(ROW);
    txReads.dealPayment.mockResolvedValue(null);
    mem = memoryStore();
  });

  const ROW = { id: ID, account_id: ID, posted_on: "2026-11-20", amount_cents: -1250, name: "Coffee", note: null, entity_id: null, source: "manual" };

  it("deletes a manual transaction, and undo is the activity undo (the exact row and its deal payment)", async () => {
    txReads.getRow.mockResolvedValue(ROW);
    bank.deleteManualTransaction.mockResolvedValueOnce({ ok: true, activityId: "00000000-0000-4000-8000-00000000ac71", dealPayment: true });
    const res = await executeTool("delete_transaction", { transactionId: ID }, toolCtx(mem.store), { approved: true });
    expect(res).toMatchObject({ status: "ok", data: { deleted: true, dealPayment: true }, summary: "Deleted Coffee and its deal payment" });
    expect(bank.editTransaction).not.toHaveBeenCalled();
    expect(mem.actions[0].inverse).toEqual({ tool: "undo_activity", input: { id: "00000000-0000-4000-8000-00000000ac71" } });
  });

  it("falls back to adding the row back only when the delete gives no activity id", async () => {
    txReads.getRow.mockResolvedValue(ROW);
    bank.deleteManualTransaction.mockResolvedValueOnce({ ok: true, data: { transactionId: ID } });
    const res = await executeTool("delete_transaction", { transactionId: ID }, toolCtx(mem.store), { approved: true });
    expect(res).toMatchObject({ status: "ok", data: { deleted: true } });
    expect(mem.actions[0].inverse).toEqual({ tool: "add_transaction", input: { accountId: ID, postedOn: "2026-11-20", amountCents: -1250, name: "Coffee", note: null } });
  });

  it("names the row in the confirm, and says when a deal payment goes with it", async () => {
    txReads.getRow.mockResolvedValue(ROW);
    const ctx = toolCtx(mem.store, { db: fakeDb({ deals: { brand_name: "Wordwise" } }) });
    expect(await gateFor(toolByName("delete_transaction")!, ctx, { transactionId: ID })).toMatchObject({ summary: 'Delete "Coffee" (2026-11-20, -$12.50)' });
    txReads.dealPayment.mockResolvedValueOnce({ deal_id: ID });
    expect(await gateFor(toolByName("delete_transaction")!, ctx, { transactionId: ID })).toMatchObject({
      reason: "delete",
      summary: 'Delete "Coffee" (2026-11-20, -$12.50) and its payment to deal "Wordwise"',
    });
    txReads.getRow.mockResolvedValue({ ...ROW, source: "csv" });
    expect((await gateFor(toolByName("delete_transaction")!, ctx, { transactionId: ID }))!.summary).toBe('Hide "Coffee" (2026-11-20, -$12.50): an imported row is hidden, not deleted');
  });

  it("hides a bank transaction and says why", async () => {
    txReads.getRow.mockResolvedValue({ ...ROW, source: "plaid" });
    bank.deleteManualTransaction.mockResolvedValueOnce({ ok: false, error: { code: "not_manual", message: "Only a manual transaction can be deleted" } });
    bank.editTransaction.mockResolvedValueOnce({ ok: true, data: { transactionId: ID, before: { hidden: false } } });
    const res = await executeTool("delete_transaction", { transactionId: ID }, toolCtx(mem.store), { approved: true });
    expect(bank.editTransaction).toHaveBeenCalledWith({ transactionId: ID, hidden: true });
    expect(res).toMatchObject({ status: "ok", data: { hidden: true, note: expect.stringContaining("bank or imported-file row is hidden, not deleted") } });
    expect(mem.actions[0].inverse).toEqual({ tool: "edit_transaction", input: { transactionId: ID, hidden: false } });
  });

  it("reports any other refusal", async () => {
    bank.deleteManualTransaction.mockResolvedValueOnce({ ok: false, error: { code: "paired", message: "Unpair this transfer first" } });
    expect(await executeTool("delete_transaction", { transactionId: ID }, toolCtx(mem.store), { approved: true })).toEqual({ status: "error", message: "Unpair this transfer first" });
    expect(bank.editTransaction).not.toHaveBeenCalled();
  });
});

describe("set_status_done", () => {
  let mem: ReturnType<typeof memoryStore>;
  const ACT = "00000000-0000-4000-8000-00000000ac72";
  beforeEach(() => {
    vi.clearAllMocks();
    planning.tasks.splice(0, planning.tasks.length, planning.task);
    mem = memoryStore();
  });

  it("asks first, naming the status and how many tasks change", async () => {
    const res = await executeTool("set_status_done", { id: planning.status.id, isDone: true }, toolCtx(mem.store));
    expect(res).toMatchObject({ status: "confirm", gate: { reason: "bulk", summary: 'Mark status "To do" as done; completed dates change on its 1 task' } });
    expect(planning.updateStatus).not.toHaveBeenCalled();
  });

  it("sets isDone through updateStatus and undoes it through the activity log", async () => {
    planning.updateStatus.mockResolvedValueOnce({ ok: true, value: { ...planning.status, isDone: true }, activityId: ACT });
    const res = await executeTool("set_status_done", { id: planning.status.id, isDone: true }, toolCtx(mem.store), { approved: true });
    expect(planning.updateStatus).toHaveBeenCalledWith(planning.status.id, { isDone: true });
    expect(res).toMatchObject({ status: "ok", data: { isDone: true, activityId: ACT }, summary: "Marked status To do as done" });
    expect(mem.actions[0].inverse).toEqual({ tool: "undo_activity", input: { id: ACT } });
  });

  it("gives no undo when the write reports no activity, and update_status still refuses isDone", async () => {
    const res = await executeTool("set_status_done", { id: planning.status.id, isDone: false }, toolCtx(mem.store), { approved: true });
    expect(res).toMatchObject({ status: "ok", data: { activityId: null } });
    expect(mem.actions[0].inverse).toBeNull();
    expect(await executeTool("update_status", { id: planning.status.id, patch: { isDone: true } }, toolCtx(mem.store))).toMatchObject({ status: "invalid" });
  });
});

describe("statuses: move_task and update_task", () => {
  const TODO = planning.status;
  const PROGRESS = { id: "00000000-0000-4000-8000-0000000000a2", label: "In Progress", color: "#1d1d1f", position: 2048, isDone: false };
  const REVIEW = { id: "00000000-0000-4000-8000-0000000000a3", label: "In review", color: "#1d1d1f", position: 3072, isDone: false };
  const DONE = { id: "00000000-0000-4000-8000-0000000000a4", label: "Done", color: "#1d1d1f", position: 4096, isDone: true };
  const OTHER_1 = { ...planning.task, id: "00000000-0000-4000-8000-0000000000c1", title: "Other 1", statusId: PROGRESS.id, position: 1024 };
  const OTHER_2 = { ...planning.task, id: "00000000-0000-4000-8000-0000000000c2", title: "Other 2", statusId: PROGRESS.id, position: 2048 };
  const board = (statuses = [TODO, PROGRESS, REVIEW, DONE]) =>
    ({ ok: true, value: { statuses, tasks: [planning.task, OTHER_1, OTHER_2], goals: [], events: [], properties: [], timeZone: "America/Toronto" } }) as never;
  const move = (status: string, extra: object = {}) => executeTool("move_task", { id: planning.task.id, status, ...extra }, toolCtx(mem.store));
  let mem: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    vi.clearAllMocks();
    mem = memoryStore();
  });

  it.each(["In Progress", "in progress", "IN-PROGRESS", "inprogress", "in_progress", " In  Progress ", PROGRESS.id])("moves by status %j to the end of it", async (status) => {
    planning.loadPlanning.mockResolvedValueOnce(board());
    expect(await move(status)).toMatchObject({ status: "ok", data: { statusId: PROGRESS.id, status: "In Progress" } });
    expect(planning.setTaskPositions).toHaveBeenCalledWith([{ id: planning.task.id, position: 3072, statusId: PROGRESS.id }]);
    expect(mem.actions[0].inverse).toEqual({ tool: "update_task", input: { id: planning.task.id, patch: { statusId: TODO.id, position: planning.task.position } } });
  });

  it("places after a task in the column, and moves to done by a word", async () => {
    planning.loadPlanning.mockResolvedValueOnce(board());
    await move("in progress", { afterTaskId: OTHER_1.id });
    expect(planning.setTaskPositions).toHaveBeenCalledWith([{ id: planning.task.id, position: 1536, statusId: PROGRESS.id }]);
    planning.loadPlanning.mockResolvedValueOnce(board());
    expect(await move("done")).toMatchObject({ status: "ok", data: { statusId: DONE.id } });
  });

  it("asks which status when a name fits two, and moves nothing", async () => {
    planning.loadPlanning.mockResolvedValueOnce(board());
    expect(await move("in p")).toMatchObject({ status: "ok", data: { statusId: PROGRESS.id } }); // a prefix of 3+ fits one
    planning.setTaskPositions.mockClear();
    mem.actions.splice(0);
    planning.loadPlanning.mockResolvedValueOnce(board([TODO, PROGRESS, { ...REVIEW, label: "Progress check" }]));
    expect(await move("progress")).toEqual({ status: "error", message: "Which status: In Progress or Progress check?" });
    planning.loadPlanning.mockResolvedValueOnce(board([TODO, PROGRESS, { ...REVIEW, label: "in-progress" }]));
    expect(await move("In progress")).toEqual({ status: "error", message: "Which status: In Progress or in-progress?" });
    planning.loadPlanning.mockResolvedValueOnce(board());
    expect(await move("Blocked")).toMatchObject({ status: "error", message: expect.stringContaining('No status named "Blocked"') });
    expect(planning.setTaskPositions).not.toHaveBeenCalled();
    expect(mem.actions).toHaveLength(0);
  });

  it("update_task with a new status and no position lands at the end of the new column", async () => {
    planning.loadPlanning.mockResolvedValueOnce(board());
    const res = await executeTool("update_task", { id: planning.task.id, patch: { statusId: PROGRESS.id } }, toolCtx(mem.store));
    expect(res.status).toBe("ok");
    expect(planning.updateTask).toHaveBeenCalledWith(planning.task.id, { statusId: PROGRESS.id, position: 3072 });
    expect(mem.actions[0].inverse).toEqual({ tool: "update_task", input: { id: planning.task.id, patch: { statusId: TODO.id, position: planning.task.position } } });
  });

  it("update_task keeps a position it was given, and the column it is already in", async () => {
    planning.loadPlanning.mockResolvedValueOnce(board());
    await executeTool("update_task", { id: planning.task.id, patch: { statusId: PROGRESS.id, position: 10 } }, toolCtx(mem.store));
    expect(planning.updateTask).toHaveBeenLastCalledWith(planning.task.id, { statusId: PROGRESS.id, position: 10 });
    planning.loadPlanning.mockResolvedValueOnce(board());
    await executeTool("update_task", { id: planning.task.id, patch: { statusId: TODO.id } }, toolCtx(mem.store));
    expect(planning.updateTask).toHaveBeenLastCalledWith(planning.task.id, { statusId: TODO.id });
  });
});

describe("delete confirms name the item", () => {
  /** Deletes whose card names the item from the input alone (no lookup needed). */
  const NAMED_BY_INPUT = new Set(["reset_layout", "delete_tax_payment", "forget"]);

  it("every delete reads the item's name for its confirm", () => {
    for (const name of Object.keys(DELETE_INPUTS)) {
      if (!NAMED_BY_INPUT.has(name)) expect(toolByName(name)!.gate, `${name} needs a naming gate`).toBeTypeOf("function");
    }
  });

  it("says which task, reminder, routine, category, deal and post", async () => {
    vi.clearAllMocks();
    const mem = memoryStore();
    const routine = await mem.store.createRoutine({
      name: "Morning money", instruction: "x", schedule: { kind: "daily", time: "08:00" }, tools: ["hydra"], delivery: ["notification"], when_mac_off: "skip", paused: false, next_run_at: null,
    });
    const ctx = toolCtx(mem.store, {
      db: fakeDb({ categories: { name: "Food" }, deals: { brand_name: "Wordwise" }, posts: { title: null, url: "https://tiktok.com/v/1", posted_at: "2026-11-02T10:00:00Z", deal_id: ID } }),
    });
    const summary = async (tool: string, input: unknown) => (await gateFor(toolByName(tool)!, ctx, input))!.summary;
    expect(await summary("delete_task", { id: planning.task.id })).toBe('Delete task "Send the W-9" and its reminder');
    expect(await summary("clear_reminder", { kind: "task", id: planning.task.id })).toBe('Remove the reminder on "Send the W-9"');
    expect(await summary("update_task", { id: planning.task.id, patch: { alertAt: null } })).toBe('Remove the reminder on "Send the W-9"');
    expect(await summary("delete_routine", { id: routine.id })).toBe('Delete routine "Morning money" and its run history');
    expect(await summary("delete_category", { id: ID })).toBe('Delete category "Food"');
    expect(await summary("merge_categories", { fromId: ID, intoId: ID })).toBe('Merge "Food" into "Food" ("Food" is deleted)');
    expect(await summary("delete_deal", { id: ID })).toBe('Delete deal "Wordwise" with its posts and payments');
    expect(await summary("delete_post", { id: ID })).toBe('Delete the post "https://tiktok.com/v/1" from 2026-11-02 on "Wordwise" and its view readings');
    // A write that deletes only by value does not ask otherwise.
    expect(await gateFor(toolByName("update_task")!, ctx, { id: planning.task.id, patch: { title: "x" } })).toBeNull();
    // An item that cannot be read still asks, with the generic line.
    expect(await summary("delete_task", { id: ID })).toBe("Delete this task");
  });
});

describe("planning fixes: goal order, metric undo, option place", () => {
  const GOAL = (id: string, position: number, metrics: object[] = []) => ({
    id, title: `Goal ${position}`, notes: "", category: null, startDate: null, deadline: null, position, achievedAt: null, metrics, links: [],
  });
  const G1 = "00000000-0000-4000-8000-0000000000d1";
  const G2 = "00000000-0000-4000-8000-0000000000d2";
  const PROP = "00000000-0000-4000-8000-0000000000e1";
  const O1 = "00000000-0000-4000-8000-0000000000e2";
  const O2 = "00000000-0000-4000-8000-0000000000e3";
  const O3 = "00000000-0000-4000-8000-0000000000e4";
  const opt = (id: string, position: number) => ({ id, label: `Opt ${position}`, color: "#1d1d1f", position });
  const prop = (options: object[]) => ({ id: PROP, name: "Platform", type: "select", numberFormat: "plain", position: 1, showOnBoard: true, showInList: true, options });
  const snap = (extra: object) =>
    ({ ok: true, value: { statuses: [planning.status], tasks: [planning.task], goals: [], events: [], properties: [], timeZone: "America/Toronto", ...extra } }) as never;
  let mem: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    vi.clearAllMocks();
    mem = memoryStore();
  });

  it("reorders goals only with every goal id, once", async () => {
    for (const ids of [[G2], [G2, G2], [G2, ID]]) {
      planning.loadPlanning.mockResolvedValueOnce(snap({ goals: [GOAL(G1, 1024), GOAL(G2, 2048)] }));
      expect(await executeTool("reorder_planning", { kind: "goals", ids }, toolCtx(mem.store)), ids.join()).toMatchObject({ status: "error", message: expect.stringContaining("every goal id") });
    }
    expect(planning.setGoalPositions).not.toHaveBeenCalled();
    planning.loadPlanning.mockResolvedValueOnce(snap({ goals: [GOAL(G1, 1024), GOAL(G2, 2048)] }));
    expect((await executeTool("reorder_planning", { kind: "goals", ids: [G2, G1] }, toolCtx(mem.store))).status).toBe("ok");
    expect(planning.setGoalPositions).toHaveBeenCalledWith([{ id: G2, position: 1024 }, { id: G1, position: 2048 }]);
  });

  it("refuses a category on a metric that has none, so every metric change can be undone", async () => {
    const M = "00000000-0000-4000-8000-0000000000f1";
    planning.loadPlanning.mockResolvedValueOnce(snap({ goals: [GOAL(G1, 1024, [{ id: M, goalId: G1, metric: "net_worth", target: 5, param: null, position: 1 }])] }));
    expect(await executeTool("update_goal_metric", { id: M, patch: { param: "Food" } }, toolCtx(mem.store))).toMatchObject({ status: "error" });
    expect(planning.updateGoalMetric).not.toHaveBeenCalled();
    planning.loadPlanning.mockResolvedValueOnce(snap({ goals: [GOAL(G1, 1024, [{ id: M, goalId: G1, metric: "category_spend", target: 5, param: "Food", position: 1 }])] }));
    expect((await executeTool("update_goal_metric", { id: M, patch: { target: 9, param: "Rent" } }, toolCtx(mem.store))).status).toBe("ok");
    expect(mem.actions[0].inverse).toEqual({ tool: "update_goal_metric", input: { id: M, patch: { target: 5, param: "Food" } } });
  });

  it("undoing an option delete puts it back in its place", async () => {
    planning.loadPlanning.mockResolvedValueOnce(snap({ properties: [prop([opt(O1, 1), opt(O2, 2), opt(O3, 3)])] }));
    const ctx = toolCtx(mem.store, { surface: "routine" });
    expect((await executeTool("delete_property_option", { id: O2 }, ctx, { approved: true })).status).toBe("ok");
    expect(mem.actions[0].inverse).toEqual({ tool: "add_property_option", input: { id: O2, propertyId: PROP, label: "Opt 2", color: "#1d1d1f", afterOptionId: O1 } });
    // The undo: the option comes back last, then moves after O1.
    planning.loadPlanning.mockResolvedValueOnce(snap({ properties: [prop([opt(O1, 1), opt(O3, 3), opt(O2, 9999)])] }));
    expect((await undoAction(mem.actions[0].id, ctx, { approved: true })).status).toBe("ok");
    expect(planning.createOption).toHaveBeenCalledWith({ id: O2, propertyId: PROP, label: "Opt 2", color: "#1d1d1f" });
    expect(planning.reorderOptions).toHaveBeenCalledWith(PROP, [O1, O2, O3]);
  });

  it("names the option and its property in the confirm", async () => {
    planning.loadPlanning.mockResolvedValueOnce(snap({ properties: [prop([opt(O1, 1)])] }));
    expect((await gateFor(toolByName("delete_property_option")!, toolCtx(mem.store), { id: O1 }))!.summary).toBe(
      'Delete option "Opt 1" of "Platform"; tasks set to it lose that value',
    );
  });

  it("matches a status by a word or prefix of 3 or more, never by 2 letters or mid-word", async () => {
    const { resolveStatus } = await import("./tools-hydra");
    const statuses = [planning.status, { ...planning.status, id: G1, label: "In Progress" }];
    expect(resolveStatus({ statuses }, "prog").id).toBe(G1);
    expect(resolveStatus({ statuses }, "in pro").id).toBe(G1);
    expect(() => resolveStatus({ statuses }, "in")).toThrow('No status named "in"');
    expect(() => resolveStatus({ statuses }, "ogress")).toThrow('No status named "ogress"');
    expect(() => resolveStatus({ statuses }, "do")).toThrow('No status named "do"');
  });
});

describe("settings: time zone, idle lock, sleep word", () => {
  let mem: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    vi.clearAllMocks();
    owner.upserts.splice(0);
    mem = memoryStore();
  });

  it("accepts IANA names only and stores the canonical name", async () => {
    const { canonicalTimeZone, isTimeZone } = await import("@/lib/planning/dates");
    expect(canonicalTimeZone("america/toronto")).toBe("America/Toronto");
    expect(canonicalTimeZone(" UTC ")).toBe("UTC");
    expect(canonicalTimeZone("US/Eastern")).toBe("America/New_York");
    // Postgres reads these POSIX-style, with the opposite sign: never accepted.
    for (const tz of ["+05:00", "-05", "-05:00", "UTC+5", "EST", "PST", "GMT+2", "Nope/Zone", ""]) expect(isTimeZone(tz), tz).toBe(false);

    const { setTimeZone } = await vi.importActual<typeof import("@/app/(app)/accounts/actions")>("@/app/(app)/accounts/actions");
    expect(await setTimeZone({ timeZone: "+05:00" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await setTimeZone({ timeZone: "europe/london" })).toEqual({ ok: true, data: { timeZone: "Europe/London" } });
    expect(await setTimeZone({ timeZone: null })).toEqual({ ok: true, data: { timeZone: null } });
    expect(owner.upserts).toEqual([{ user_id: "owner", time_zone: "Europe/London" }, { user_id: "owner", time_zone: null }]);
  });

  it("undo puts back a zone that was never set, and a zone change moves each routine's next run", async () => {
    accounts.setTimeZone.mockResolvedValueOnce({ ok: true, data: { timeZone: "Europe/London" } });
    const base = { instruction: "x", tools: ["hydra"], delivery: ["notification"], when_mac_off: "skip", schedule: { kind: "daily", time: "08:00" } };
    const daily = await mem.store.createRoutine({ ...base, name: "Daily", paused: false, next_run_at: "2026-11-22T13:00:00.000Z" } as never);
    const paused = await mem.store.createRoutine({ ...base, name: "Paused", paused: true, next_run_at: null } as never);
    const ctx = toolCtx(mem.store, { db: fakeDb({ settings: { time_zone: null } }), timeZone: async () => "Europe/London" });
    const res = await executeTool("set_time_zone", { timeZone: "Europe/London" }, ctx);
    expect(res).toMatchObject({ status: "ok", data: { timeZone: "Europe/London", routinesRescheduled: 1 } });
    expect(mem.actions[0].inverse).toEqual({ tool: "set_time_zone", input: { timeZone: null } });
    // 08:00 in London on 2026-11-22 (the next one after now, 2026-11-21 15:00Z) is 08:00Z.
    expect((await mem.store.getRoutine(daily.id))!.next_run_at).toBe("2026-11-22T08:00:00.000Z");
    expect((await mem.store.getRoutine(paused.id))!.next_run_at).toBeNull();
  });

  it("asks before turning the idle lock off or changing the sleep word, not before turning the lock on", async () => {
    const ctx = toolCtx(mem.store);
    expect(await executeTool("set_idle_lock", { minutes: null }, ctx)).toMatchObject({ status: "confirm", gate: { summary: "Turn the idle lock off", danger: true } });
    expect(await executeTool("set_sleep_word", { word: "goodnight" }, ctx)).toMatchObject({ status: "confirm", gate: { summary: 'Change the sleep word to "goodnight"' } });
    expect(accounts.setIdleLock).not.toHaveBeenCalled();
    expect((await mem.store.settings()).sleepWord).not.toBe("goodnight");
    expect(await gateFor(toolByName("set_idle_lock")!, ctx, { minutes: 5 })).toBeNull();
  });
});

describe("activity: list_activity and undo_activity", () => {
  const A1 = "00000000-0000-4000-8000-00000000a001";
  const A2 = "00000000-0000-4000-8000-00000000a002";
  const entry = (id: string, over: object = {}) => ({
    id, at: "2026-11-21T14:00:00Z", actor: "you", summary: `Entry ${id.slice(-1)}`, details: [], undoneAt: null, undoOf: null, canUndo: true, ...over,
  });
  let mem: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    vi.clearAllMocks();
    mem = memoryStore();
  });

  it("lists the activity newest first with paging, and Hydra's own undoable steps on the first page", async () => {
    activity.listActivity.mockResolvedValueOnce({ entries: [entry(A1)], next: "cursor-1" });
    await mem.store.logAction({
      thread_id: null, run_id: null, device_id: null, tool: "gmail_label", input: {}, result: null, summary: "Changed email labels", inverse: { tool: "gmail_label", input: {} }, surface: "web",
    });
    // A Hydra-data step from the web is already an entry (its rows are logged): not offered twice (F2).
    await mem.store.logAction({
      thread_id: null, run_id: null, device_id: null, tool: "delete_rule", input: {}, result: null, summary: "Deleted a rule", inverse: { tool: "create_rule", input: {} }, surface: "web",
    });
    const first = await executeTool("list_activity", {}, toolCtx(mem.store));
    expect(first).toMatchObject({ status: "ok", data: { entries: [{ id: A1 }], next: "cursor-1", hydraActions: [{ summary: "Changed email labels" }] } });
    expect((first as { data: { hydraActions: unknown[] } }).data.hydraActions).toHaveLength(1);
    expect(activity.listActivity).toHaveBeenLastCalledWith({ before: undefined, limit: 20 });
    activity.listActivity.mockResolvedValueOnce({ entries: [], next: null });
    const second = await executeTool("list_activity", { before: "cursor-1", limit: 5 }, toolCtx(mem.store));
    expect(activity.listActivity).toHaveBeenLastCalledWith({ before: "cursor-1", limit: 5 });
    expect((second as { data: object }).data).not.toHaveProperty("hydraActions");
  });

  it("\"undo that\" undoes the newest entry, by its id, without asking when the undo deletes nothing", async () => {
    activity.listActivity.mockResolvedValue({ entries: [entry(A2, { undoDeletes: false }), entry(A1)], next: null });
    activity.undoActivity.mockResolvedValueOnce({ ok: true, undoId: A1 });
    // SEC-3: no id, no undo: an approved call must undo the entry the owner saw, not whatever is newest then.
    expect((await executeTool("undo_activity", {}, toolCtx(mem.store))).status).toBe("invalid");
    const res = await executeTool("undo_activity", { id: A2 }, toolCtx(mem.store));
    expect(res).toMatchObject({ status: "ok", summary: "Undid: Entry 2" });
    expect(activity.undoActivity).toHaveBeenCalledWith(A2, { force: undefined });
    // Undoing the undo redoes it.
    expect(mem.actions[0].inverse).toEqual({ tool: "undo_activity", input: { id: A1 } });
  });

  it("asks first when the undo deletes what the owner made, when that is unknown, and with force", async () => {
    activity.listActivity.mockResolvedValue({ entries: [entry(A2, { undoDeletes: true }), entry(A1, { undoDeletes: false })], next: null });
    expect(await executeTool("undo_activity", { id: A2 }, toolCtx(mem.store))).toMatchObject({ status: "confirm", gate: { reason: "delete", summary: "Undo: Entry 2" } });
    expect(await executeTool("undo_activity", { id: A1, force: true }, toolCtx(mem.store))).toMatchObject({ status: "confirm", gate: { summary: expect.stringContaining("Undo anyway") } });
    activity.listActivity.mockResolvedValue({ entries: [entry(A1)], next: null });
    expect((await executeTool("undo_activity", { id: A1 }, toolCtx(mem.store))).status).toBe("confirm");
    expect(activity.undoActivity).not.toHaveBeenCalled();
  });

  it("finds an older entry by paging, and says why one cannot be undone", async () => {
    activity.listActivity
      .mockResolvedValueOnce({ entries: [entry(A2, { undoDeletes: false })], next: "c1" })
      .mockResolvedValueOnce({ entries: [entry(A1, { canUndo: false, cannotUndo: "outside" })], next: null });
    expect(await executeTool("undo_activity", { id: A1 }, toolCtx(mem.store), { approved: true })).toMatchObject({ status: "error", message: expect.stringContaining("outside Hydra") });
    expect(activity.listActivity).toHaveBeenNthCalledWith(2, { before: "c1", limit: 50 });
    activity.listActivity.mockResolvedValue({ entries: [entry(A1, { undoDeletes: false })], next: null });
    activity.undoActivity.mockResolvedValueOnce({ ok: false, error: "changed_since", changed: ["Status: In progress → Done"] });
    expect(await executeTool("undo_activity", { id: A1 }, toolCtx(mem.store))).toMatchObject({ status: "error", message: expect.stringContaining("Status: In progress → Done") });
    activity.undoActivity.mockResolvedValueOnce({ ok: false, error: "expired" });
    expect(await executeTool("undo_activity", { id: A1 }, toolCtx(mem.store))).toMatchObject({ status: "error", message: expect.stringContaining("30 days") });
    // Blocked (a name taken since): undoing anyway would not help, so the agent does not offer it.
    activity.undoActivity.mockResolvedValueOnce({ ok: false, error: "changed_since", changed: ["A category with the same name exists now"], blocked: true });
    const blocked = await executeTool("undo_activity", { id: A1 }, toolCtx(mem.store));
    expect(blocked).toMatchObject({ status: "error", message: expect.stringContaining("would not help") });
    expect((blocked as { message: string }).message).not.toContain("force");
    expect(mem.actions).toHaveLength(0);
  });

  it("no tool says an Activity-logged change cannot be undone (UI-3)", () => {
    expect(TOOLS.filter((t) => /cannot be undone/i.test(t.description)).map((t) => t.name)).toEqual([]);
  });
});
