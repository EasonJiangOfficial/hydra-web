// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * The agent's reach: every exported read and write in Hydra's actions, queries and "use server"
 * files maps to a tool the agent can call, or is excluded with a reason. A new export fails this
 * test until it is mapped (owner, 2026-11-22: "read all the data and write or delete based on what
 * is asked").
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/bank/actions", () => ({}));
vi.mock("@/lib/rules/actions", () => ({}));
vi.mock("@/lib/ugc/actions", () => ({}));
vi.mock("@/lib/brand/actions", () => ({}));
vi.mock("@/lib/layout/actions", () => ({}));
vi.mock("@/lib/planning/actions", () => ({}));
vi.mock("@/app/(app)/taxes/actions", () => ({}));
vi.mock("@/app/(app)/taxes/data", () => ({}));
vi.mock("@/app/(app)/accounts/actions", () => ({}));
vi.mock("@/app/(app)/accounts/data", () => ({}));
vi.mock("@/app/(app)/planning/actions", () => ({}));
vi.mock("@/app/(app)/settings/actions", () => ({}));
vi.mock("@/app/(app)/reports/actions", () => ({}));
vi.mock("@/app/(app)/transactions/reads", () => ({}));

const { toolByName } = await import("./tools");

/** A tool name; a tool and `via`, how it reaches the export without calling it by name; or why the agent must not have it. */
type Entry = string | { tool: string; via: string } | { excluded: string };

const PLAID_LINK = { excluded: "Plaid Link runs in the browser: the owner signs in to the bank there" };
const BROWSER_FILE = { excluded: "Browser file flow: the owner picks or opens the file in the page" };
const KEYS = { excluded: "Connector API keys: the owner manages them on Settings, never the agent" };
const HELPER = { excluded: "Pure helper for the page, no data of its own" };

/** module (path under src, no extension) : export -> tool name, or why the agent must not have it. */
const COVERAGE: Record<string, Entry> = {
  "lib/activity/queries:listActivity": "list_activity",
  "lib/activity/actions:undoActivity": "undo_activity",
  "lib/activity/actions:undoActivities": { excluded: "The undo bar's door for one page delete made of several calls; the agent undoes each entry with undo_activity" },
  "lib/agent/actions:routineAction": { excluded: "The Routines page's door into the routine tools, which the agent calls directly" },
  "lib/agent/actions:listRoutinesWithRuns": { tool: "list_routines", via: "The Routines page read; list_routines reads the same routines and runs from the store" },

  "lib/notes/queries:listNotes": "search_notes",
  "lib/notes/queries:getNote": "read_note",
  "lib/notes/queries:createNote": "create_note",
  "lib/notes/queries:updateNote": "update_note",
  "lib/notes/queries:deleteNote": "delete_note",
  "lib/notes/queries:searchQuery": HELPER,
  "lib/notes/queries:summary": HELPER,
  "lib/notes/queries:LIST_MAX": HELPER,
  "lib/notes/queries:NotesError": HELPER,
  "app/(app)/notes/actions:loadNote": { tool: "read_note", via: "The Notes page's open; read_note reads the same row through getNote" },
  "app/(app)/notes/actions:searchNotes": { tool: "search_notes", via: "The Notes page's search; search_notes calls listNotes with the same words" },
  "app/(app)/notes/actions:addNote": { tool: "create_note", via: "The page's New note; create_note adds a note through createNote" },
  "app/(app)/notes/actions:saveNote": { tool: "update_note", via: "The page's autosave; update_note saves through updateNote with the same compare-and-set" },
  "app/(app)/notes/actions:pinNote": { tool: "update_note", via: "update_note pins through updateNote" },
  "app/(app)/notes/actions:removeNote": { tool: "delete_note", via: "The page's delete (it asks first); delete_note deletes through deleteNote" },

  "lib/bank/actions:createLinkToken": PLAID_LINK,
  "lib/bank/actions:startUpdateMode": PLAID_LINK,
  "lib/bank/actions:exchangePublicToken": PLAID_LINK,
  "lib/bank/actions:syncBankItem": "sync_bank",
  "lib/bank/actions:importFile": "import_file",
  "lib/bank/actions:addManualAccount": "add_manual_account",
  "lib/bank/actions:editAccount": "edit_account",
  "lib/bank/actions:closeAccount": "close_account",
  "lib/bank/actions:addManualTransaction": "add_transaction",
  "lib/bank/actions:editTransaction": "edit_transaction",
  "lib/bank/actions:deleteManualTransaction": "delete_transaction",
  "lib/bank/queries:listAccounts": "list_accounts",
  "lib/bank/queries:listTransactions": "list_transactions",
  "lib/bank/queries:balanceHistory": "get_balance_history",

  "lib/keys/actions:createApiKey": KEYS,
  "lib/keys/actions:listApiKeys": KEYS,
  "lib/keys/actions:revokeApiKey": KEYS,

  "lib/layout/actions:loadLayouts": "get_layouts",
  "lib/layout/actions:saveLayout": "save_layout",
  "lib/layout/actions:resetLayout": "reset_layout",

  "lib/planning/actions:loadPlanning": { tool: "get_planning", via: "snapshot(), the shared read every planning tool calls" },
  "lib/planning/actions:createTask": "create_task",
  "lib/planning/actions:updateTask": "update_task",
  "lib/planning/actions:setTaskPositions": "move_task",
  "lib/planning/actions:completeTask": "complete_task",
  "lib/planning/actions:deleteTask": "delete_task",
  "lib/planning/actions:setTaskRepeat": { tool: "update_task", via: "update_task sets repeatRule through updateTask, the same task patch" },
  "lib/planning/actions:setTaskAlert": "set_reminder",
  "lib/planning/actions:clearTaskAlert": "clear_reminder",
  "lib/planning/actions:createGoal": "create_goal",
  "lib/planning/actions:updateGoal": "update_goal",
  "lib/planning/actions:deleteGoal": "delete_goal",
  "lib/planning/actions:setGoalPositions": "reorder_planning",
  "lib/planning/actions:addGoalMetric": "add_goal_metric",
  "lib/planning/actions:updateGoalMetric": "update_goal_metric",
  "lib/planning/actions:removeGoalMetric": "remove_goal_metric",
  "lib/planning/actions:addGoalLink": "add_goal_link",
  "lib/planning/actions:updateGoalLink": "update_goal_link",
  "lib/planning/actions:removeGoalLink": "remove_goal_link",
  "lib/planning/actions:createEvent": "create_event",
  "lib/planning/actions:updateEvent": "update_event",
  "lib/planning/actions:deleteEvent": "delete_event",
  "lib/planning/actions:setEventAlert": "set_reminder",
  "lib/planning/actions:clearEventAlert": "clear_reminder",
  "lib/planning/actions:createStatus": "create_status",
  // updateStatus's label and color are update_status; its isDone field is set_status_done (asks first, activity undo).
  "lib/planning/actions:updateStatus": "update_status",
  "lib/planning/actions:setCategoryColor": "update_category_color",
  "lib/planning/actions:reorderStatuses": "reorder_planning",
  "lib/planning/actions:deleteStatus": "delete_status",
  "lib/planning/actions:createProperty": "create_property",
  "lib/planning/actions:updateProperty": "update_property",
  "lib/planning/actions:reorderProperties": "reorder_planning",
  "lib/planning/actions:deleteProperty": "delete_property",
  "lib/planning/actions:createOption": "add_property_option",
  "lib/planning/actions:updateOption": "update_property_option",
  "lib/planning/actions:reorderOptions": "reorder_planning",
  "lib/planning/actions:deleteOption": "delete_property_option",
  "lib/planning/actions:setTaskValue": "set_task_value",
  "lib/planning/actions:propertyUsage": { tool: "get_planning", via: "The delete dialog count; get_planning carries every task value" },

  "lib/rules/actions:createRule": "create_rule",
  "lib/rules/actions:updateRule": "update_rule",
  "lib/rules/actions:deleteRule": "delete_rule",
  "lib/rules/actions:reorderRules": "reorder_rules",
  "lib/rules/actions:previewRule": "preview_rule",
  "lib/rules/actions:applyRules": "apply_rules",
  "lib/rules/actions:setTransactionCategory": "set_transaction_category",
  "lib/rules/actions:pairTransfers": "pair_transfers",
  "lib/rules/actions:unpairTransfer": "unpair_transfer",
  "lib/rules/actions:rejectTransferSuggestion": "reject_transfer_suggestion",
  "lib/rules/actions:autoPairTransfers": "auto_pair_transfers",
  "lib/rules/actions:confirmRecurring": "confirm_recurring",
  "lib/rules/actions:dismissRecurring": "dismiss_recurring",
  "lib/rules/actions:detectRecurringNow": "detect_recurring",
  "lib/rules/actions:createCategory": "create_category",
  "lib/rules/actions:updateCategory": "update_category",
  "lib/rules/actions:deleteCategory": "delete_category",
  "lib/rules/actions:mergeCategories": "merge_categories",
  "lib/rules/actions:mapCategoryTaxLine": "map_category_tax_line",
  "lib/rules/queries:reviewQueue": "review_queue",
  "lib/rules/queries:listRules": "list_rules",
  "lib/rules/queries:listRecurring": "list_recurring",
  "lib/rules/queries:listCategories": "list_categories",
  "lib/rules/queries:listTaxLines": "list_categories",
  "lib/rules/queries:listCategoryTaxLines": "list_categories",

  "lib/ugc/actions:createDeal": "create_deal",
  "lib/ugc/actions:createDealFromTemplate": "create_deal_from_template",
  "lib/ugc/actions:updateDeal": "update_deal",
  "lib/ugc/actions:pauseDeal": "pause_deal",
  "lib/ugc/actions:resumeDeal": "resume_deal",
  "lib/ugc/actions:endDeal": "end_deal",
  "lib/ugc/actions:deleteDeal": "delete_deal",
  "lib/ugc/actions:addPost": "add_post",
  "lib/ugc/actions:editPost": "edit_post",
  "lib/ugc/actions:excludePost": "exclude_post",
  "lib/ugc/actions:unexcludePost": "include_post",
  "lib/ugc/actions:linkPosts": "link_posts",
  "lib/ugc/actions:unlinkPost": "unlink_post",
  "lib/ugc/actions:deletePost": "delete_post",
  "lib/ugc/actions:setViews": "set_views",
  "lib/ugc/actions:setDayTarget": "set_day_target",
  "lib/ugc/actions:matchPayment": "match_payment",
  "lib/ugc/actions:unmatchPayment": "unmatch_payment",
  "lib/ugc/queries:listDeals": "list_deals",
  "lib/ugc/queries:listDealTemplates": "list_deal_templates",
  "lib/ugc/queries:postingCalendarMonth": "ugc_calendar",
  "lib/ugc/queries:earnedPerDay": "ugc_calendar",
  "lib/ugc/queries:postsNeedingViews": "posts_needing_views",
  "lib/ugc/queries:missedViewDays": "posts_needing_views",

  "lib/ugc/queries:payoutMatches": "suggest_payout_matches",
  "lib/ugc/actions:confirmPayoutMatch": "confirm_payout_match",
  "lib/ugc/actions:rejectPayoutMatch": "reject_payout_match",
  "lib/ugc/actions:undoRejectPayoutMatch": "undo_reject_payout_match",
  "lib/ugc/actions:decidePayoutRule": "decide_payout_rule",
  "lib/ugc/actions:removePayoutRule": "remove_payout_rule",

  "lib/brand/actions:setFollowers": "set_followers",
  "lib/brand/queries:loadBrandRaw": "get_personal_brand",
  "lib/brand/queries:saveFollowerCount": { tool: "set_followers", via: "setFollowers checks the owner, then saves through saveFollowerCount" },
  "lib/instagram/actions:syncInstagramNow": { excluded: "The Personal Brand Sync now button; the daily cron runs the same sync, and get_personal_brand reads what it wrote" },
  "lib/instagram/actions:disconnectInstagram": { excluded: "Deletes the Instagram token: the owner does it on Settings, after a confirm" },

  "lib/reports/queries:MAX_NET_WORTH_DAYS": HELPER,
  "lib/reports/queries:netWorthChartPoints": HELPER,
  "lib/reports/queries:yearToDate": HELPER,
  "lib/reports/queries:thisMonth": HELPER,
  "lib/reports/queries:sankeyData": { excluded: "Reshapes cash_flow for the chart; get_report cash_flow has the same data" },
  "lib/reports/queries:netWorthSeries": "get_report",
  "lib/reports/queries:cashFlow": "get_report",
  "lib/reports/queries:spendingByCategory": "get_report",
  "lib/reports/queries:incomeByPayer": "get_report",
  "lib/reports/queries:incomeByPayerYtd": { tool: "get_report", via: "income_by_payer from Jan 1 to today: incomeByPayerYtd is that call" },
  "lib/reports/queries:monthlyTrend": "get_report",
  "lib/reports/queries:taxLineTotals": "get_report",
  "lib/reports/queries:incomeSummary": "get_report",

  "lib/entities/queries:listEntities": "get_settings",
  "lib/entities/queries:entityUse": "get_settings",
  "app/(app)/settings/actions:addBusiness": "add_business",
  "app/(app)/settings/actions:updateBusiness": "update_business",
  "app/(app)/settings/actions:closeBusiness": "close_business",
  "app/(app)/settings/actions:reopenBusiness": "reopen_business",
  "app/(app)/settings/actions:deleteBusiness": "delete_business",
  "app/(app)/accounts/actions:setIdleLock": "set_idle_lock",
  "app/(app)/accounts/actions:setTimeZone": "set_time_zone",
  "app/(app)/accounts/actions:loadBalanceHistory": { tool: "get_balance_history", via: "The page wrapper of balanceHistory, which the tool calls" },
  "app/(app)/planning/actions:resolveMetric": "goal_metric_value",
  "app/(app)/planning/actions:keepGoogleItem": { tool: "calendar_keep", via: "The page wrapper of keepPendingDelete, which the tool calls" },
  "app/(app)/reports/actions:loadCategoryPanel": "category_month",
  "app/(app)/taxes/actions:saveRate": "set_tax_rate",
  "app/(app)/taxes/actions:savePayment": "save_tax_payment",
  "app/(app)/taxes/actions:removePayment": "delete_tax_payment",
  "app/(app)/taxes/actions:lineTransactions": "tax_line_transactions",
  "app/(app)/taxes/actions:registerDocument": BROWSER_FILE,
  "app/(app)/taxes/actions:documentUrl": BROWSER_FILE,
  "app/(app)/taxes/actions:removeDocument": "delete_tax_document",
  "app/(app)/transactions/reads:listRows": { tool: "list_transactions", via: "The table paged read; the tool reads the same rows through listTransactions" },
  "app/(app)/transactions/reads:getRow": "get_transaction",
  "app/(app)/transactions/reads:reviewCount": { tool: "review_queue", via: "The badge count: the total of reviewQueue, which the tool calls" },
  "app/(app)/transactions/reads:pairCandidates": "get_transaction",
  "app/(app)/transactions/reads:dealPayment": "get_transaction",
  "app/(app)/transactions/reads:transferSuggestions": "transfer_suggestions",
  "app/dev/accounts/import-action:fixtureImport": { excluded: "Dev fixture page only; stores nothing" },
};

/**
 * Every export with no entry, every entry naming a tool that does not exist, every mapped tool
 * whose code never calls the export (unless the entry says `via` how it gets there), and every
 * entry for an export that is gone. Empty means full coverage.
 */
function coverageGaps(
  exportsByModule: Record<string, string[]>,
  coverage: Record<string, Entry>,
  hasTool: (name: string) => boolean,
  toolCode: (name: string) => string | undefined = () => undefined,
): string[] {
  const found = new Set(Object.entries(exportsByModule).flatMap(([mod, names]) => names.map((n) => `${mod}:${n}`)));
  const gaps: string[] = [];
  for (const key of [...found].sort()) {
    const entry = coverage[key];
    const exported = key.split(":")[1];
    if (entry === undefined) gaps.push(`${key}: no tool and no exclusion`);
    else if ("excluded" in Object(entry)) {
      if (!(entry as { excluded: string }).excluded.trim()) gaps.push(`${key}: exclusion without a reason`);
    } else {
      const { tool, via } = typeof entry === "string" ? { tool: entry, via: undefined } : (entry as { tool: string; via: string });
      if (!hasTool(tool)) gaps.push(`${key}: no tool named ${tool}`);
      else if (via !== undefined) {
        if (!via.trim()) gaps.push(`${key}: via without a reason`);
      } else {
        const code = toolCode(tool);
        if (code !== undefined && !new RegExp(`\\b${exported}\\b`).test(code)) gaps.push(`${key}: ${tool} does not call ${exported}`);
      }
    }
  }
  for (const key of Object.keys(coverage)) if (!found.has(key)) gaps.push(`${key}: not exported any more`);
  return gaps;
}

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** "use server" as the file's first statement, after any line or block comments. */
const USE_SERVER = /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*["']use server["']/;

/**
 * The files the agent must cover: actions, queries and reads at any depth under lib, page actions
 * and reads under app, and every "use server" file.
 */
function mustCover(rel: string, text: string): boolean {
  return /^lib\/.+\/(actions|queries|reads)\.ts$/.test(rel) || /^app\/.+\/(actions|reads)\.ts$/.test(rel) || USE_SERVER.test(text);
}

/** Each tool's own source (its defineTool block), from the tool files, by tool name. */
function toolSources(): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(SRC, "lib/agent");
  for (const f of readdirSync(dir).filter((n) => /^tools.*\.ts$/.test(n) && !n.endsWith(".test.ts"))) {
    for (const block of readFileSync(join(dir, f), "utf8").split(/defineTool\(/).slice(1)) {
      const name = /name:\s*"([a-z0-9_]+)"/.exec(block)?.[1];
      if (name) out.set(name, block);
    }
  }
  return out;
}

/** Exports of every file the agent must cover. */
function scannedModules(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of walk(SRC)) {
    if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
    const rel = relative(SRC, file).split("\\").join("/");
    const text = readFileSync(file, "utf8");
    if (!mustCover(rel, text)) continue;
    const names = [...text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && !name.startsWith("type ")) names.push(name);
      }
    }
    out[rel.replace(/\.tsx?$/, "")] = names;
  }
  return out;
}

describe("agent coverage", () => {
  it("maps every exported read and write to a tool, or excludes it with a reason", () => {
    const modules = scannedModules();
    // The scan found the files it must: engines, page actions and "use server" files.
    for (const mod of ["lib/planning/actions", "lib/bank/queries", "app/(app)/taxes/actions", "app/(app)/transactions/reads", "app/dev/accounts/import-action"]) {
      expect(modules, mod).toHaveProperty(mod);
    }
    const code = toolSources();
    expect(coverageGaps(modules, COVERAGE, (n) => toolByName(n) !== undefined, (n) => code.get(n) ?? "")).toEqual([]);
  });

  it("finds every file it must: a block comment before \"use server\", nested lib folders, reads files", () => {
    expect(mustCover("lib/x/thing.ts", '/** Doc. */\n"use server";\nexport async function a() {}')).toBe(true);
    expect(mustCover("lib/x/thing.ts", '// one\n/* two\n three */\n// four\n\'use server\';')).toBe(true);
    expect(mustCover("lib/a/b/actions.ts", "")).toBe(true);
    expect(mustCover("lib/a/b/queries.ts", "")).toBe(true);
    expect(mustCover("lib/a/reads.ts", "")).toBe(true);
    expect(mustCover("app/(app)/x/reads.ts", "")).toBe(true);
    expect(mustCover("app/api/x/actions.ts", "")).toBe(true);
    expect(mustCover("lib/x/thing.ts", 'import "x";\n"use server";')).toBe(false);
    expect(mustCover("lib/x/actions-helpers.ts", "")).toBe(false);
  });

  it("checks that each mapped tool calls its export, unless the entry says how it gets there", () => {
    const modules = { "lib/x/actions": ["doThing", "otherThing"] };
    const has = () => true;
    const code = (n: string) => ({ a_tool: "run: async () => x.doThing(input)", b_tool: "run: async () => y.elseThing()" })[n];
    expect(coverageGaps(modules, { "lib/x/actions:doThing": "a_tool", "lib/x/actions:otherThing": "b_tool" }, has, code)).toEqual([
      "lib/x/actions:otherThing: b_tool does not call otherThing",
    ]);
    expect(coverageGaps(modules, { "lib/x/actions:doThing": "a_tool", "lib/x/actions:otherThing": { tool: "b_tool", via: "b_tool reads the same rows" } }, has, code)).toEqual([]);
    expect(coverageGaps(modules, { "lib/x/actions:doThing": "a_tool", "lib/x/actions:otherThing": { tool: "b_tool", via: " " } }, has, code)).toEqual([
      "lib/x/actions:otherThing: via without a reason",
    ]);
    // The real tool files: every tool has its block, and a real mapping is checked against it.
    const real = toolSources();
    expect(real.get("delete_transaction")).toContain("deleteManualTransaction");
    expect(real.get("list_activity")).toContain("listActivity");
    expect(real.get("undo_activity")).toContain("undoActivity");
    // updateStatus's done field reaches the agent through set_status_done; update_status sets only label and color.
    expect(real.get("set_status_done")).toMatch(/planning\.updateStatus\(statusId, \{ isDone \}\)/);
    expect(real.get("update_status")).not.toMatch(/isDone/);
  });

  it("fails on a new export with no tool, a tool that does not exist, or an entry left behind", () => {
    const modules = { "lib/x/actions": ["realThing", "newThing"] };
    const has = (n: string) => n === "real_tool";
    expect(coverageGaps(modules, { "lib/x/actions:realThing": "real_tool" }, has)).toEqual(["lib/x/actions:newThing: no tool and no exclusion"]);
    expect(coverageGaps(modules, { "lib/x/actions:realThing": "real_tool", "lib/x/actions:newThing": "missing_tool" }, has)).toEqual([
      "lib/x/actions:newThing: no tool named missing_tool",
    ]);
    expect(
      coverageGaps(modules, { "lib/x/actions:realThing": "real_tool", "lib/x/actions:newThing": { excluded: " " }, "lib/x/actions:gone": "real_tool" }, has),
    ).toEqual(["lib/x/actions:newThing: exclusion without a reason", "lib/x/actions:gone: not exported any more"]);
    // The real map with one fake extra export: it fails.
    const real = scannedModules();
    const fake = { ...real, "lib/bank/actions": [...real["lib/bank/actions"], "wipeEverything"] };
    expect(coverageGaps(fake, COVERAGE, (n) => toolByName(n) !== undefined)).toEqual(["lib/bank/actions:wipeEverything: no tool and no exclusion"]);
  });
});
