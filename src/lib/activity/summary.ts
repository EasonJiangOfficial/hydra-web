/**
 * Short lines for Activity, built from the row images the database logged (0130_activity.sql).
 * One table label map; each row is named by its name/title/brand/label column.
 */

export type LoggedRow = {
  tbl: string;
  op: "insert" | "update" | "delete";
  old: Record<string, unknown> | null;
  new: Record<string, unknown> | null;
};

/** What the owner calls a row of each logged table. */
export const TABLE_LABELS: Record<string, string> = {
  planning_tasks: "task",
  planning_goals: "goal",
  planning_goal_metrics: "goal metric",
  planning_goal_links: "goal link",
  planning_statuses: "status",
  planning_properties: "property",
  planning_property_options: "option",
  planning_task_values: "task value",
  events: "event",
  deals: "deal",
  deal_accounts: "deal account",
  deal_templates: "deal template",
  deal_payments: "deal payment",
  day_targets: "day target",
  posts: "post",
  post_view_snapshots: "view count",
  payout_rules: "payout rule",
  payout_match_rejections: "payout match",
  personal_brand_followers: "follower count",
  transactions: "transaction",
  accounts: "account",
  balances: "balance",
  categories: "category",
  category_tax_lines: "tax line map",
  rules: "rule",
  recurring: "recurring charge",
  transfer_rejections: "transfer match",
  planning_category_colors: "category color",
  tax_settings: "tax rate",
  tax_estimated_payments: "tax payment",
  tax_documents: "tax document",
  tax_lines: "tax line",
  settings: "setting",
  entities: "business",
  dashboard_layouts: "layout",
  agent_memory: "memory",
  agent_routines: "routine",
  notes: "note",
  agent_settings: "agent setting",
  agent_avatars: "avatar",
};

const NAME_COLUMNS = ["name", "title", "brand_name", "label", "handle", "url", "payer", "content", "description"];
/** Columns that change on every write and say nothing to the owner. */
const QUIET = new Set(["updated_at", "created_at", "completed_at", "position", "search"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tableLabel(tbl: string): string {
  return TABLE_LABELS[tbl] ?? tbl.replace(/_/g, " ").replace(/s$/, "");
}

const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The row's own name, or null. */
export function rowName(row: Record<string, unknown> | null | undefined): string | null {
  if (!row) return null;
  for (const c of NAME_COLUMNS) {
    const v = row[c];
    if (typeof v === "string" && v.trim()) return clip(v.trim());
  }
  if (typeof row.amount_cents === "number") return money(row.amount_cents);
  return null;
}

/** `task "Film 6 videos"`, or just `task`. */
export function thing(tbl: string, row: Record<string, unknown> | null | undefined): string {
  const name = rowName(row);
  return name ? `${tableLabel(tbl)} "${name}"` : tableLabel(tbl);
}

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "status_id" -> "Status", "due_date" -> "Due date", "amount_cents" -> "Amount". */
export function columnLabel(col: string): string {
  const base = col.replace(/_(id|cents|at)$/, "").replace(/_/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function show(col: string, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return "none";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") return col.endsWith("_cents") ? money(v) : String(v);
  if (typeof v === "string") return UUID.test(v) ? null : clip(v, 30);
  return null; // arrays and objects: "changed"
}

/** The columns an update changed, minus the noisy ones. */
export function changedColumns(row: LoggedRow): string[] {
  if (row.op !== "update" || !row.old || !row.new) return [];
  return Object.keys(row.new).filter((k) => !QUIET.has(k) && JSON.stringify(row.old![k]) !== JSON.stringify(row.new![k]));
}

/** One line per row: `Task "Plan": Status: Not started → In progress, Notes changed`. */
export function detailLine(row: LoggedRow): string {
  if (row.op === "insert") return `Added ${thing(row.tbl, row.new)}`;
  if (row.op === "delete") return `Deleted ${thing(row.tbl, row.old)}`;
  const label = thing(row.tbl, row.new);
  const parts = changedColumns(row).map((c) => {
    const a = show(c, row.old![c]);
    const b = show(c, row.new![c]);
    return a !== null && b !== null ? `${columnLabel(c)}: ${a} → ${b}` : `${columnLabel(c)} changed`;
  });
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${parts.join(", ") || "changed"}`;
}

/** `Deleted task "Plan" and 3 more`. An undo reads as Restored / Removed / Reverted. */
export function summaryLine(rows: LoggedRow[], rowCount: number, isUndo: boolean): string {
  const first = rows[0];
  if (!first) return isUndo ? "Undo" : "No change";
  const verb = isUndo
    ? { insert: "Restored", update: "Reverted", delete: "Removed" }[first.op]
    : { insert: "Added", update: "Changed", delete: "Deleted" }[first.op];
  const more = rowCount > 1 ? ` and ${rowCount - 1} more` : "";
  return `${verb} ${thing(first.tbl, first.op === "delete" ? first.old : first.new)}${more}`;
}

export type ChangedSince = {
  tbl: string | null;
  what: "back" | "gone" | "changed" | "children" | "blocked";
  cols?: string[];
  row?: Record<string, unknown> | null;
  /** children: the table of the newer rows under the row, and how many. */
  child?: string;
  n?: number;
  /** blocked: taken (a unique name), linked (a foreign key), not_allowed (the owner's row rules), rule (a guard). */
  why?: "taken" | "linked" | "not_allowed" | "rule";
  msg?: string;
};

const plural = (label: string, n: number) => (n === 1 ? label : label.endsWith("y") ? `${label.slice(0, -1)}ies` : `${label}s`);

const BLOCKED: Record<NonNullable<ChangedSince["why"]>, (t: string) => string> = {
  taken: (t) => `A ${t} with the same name exists now`,
  linked: (t) => `The ${t} it belongs to is gone`,
  not_allowed: (t) => `This ${t} cannot be changed from Hydra`,
  rule: (t) => `Putting the ${t} back breaks a rule`,
};

/**
 * The changed-since lines: `Task "Plan": Title changed since`, `Deal "Glow" is gone`, `Task "Plan" is back`,
 * `Deal "Glow" has 2 newer posts`, `A category with the same name exists now`.
 */
export function changedLine(c: ChangedSince): string {
  if (c.what === "blocked") {
    const base = BLOCKED[c.why ?? "rule"](c.tbl ? tableLabel(c.tbl) : "row");
    // A guard says which rule in its own words ("categories: two levels only").
    const rule = c.why === "rule" && c.msg ? c.msg.replace(/^[a-z_ ]+:\s*/i, "").slice(0, 60) : "";
    return rule ? `${base}: ${rule}` : base;
  }
  const t = thing(c.tbl ?? "row", c.row);
  const T = `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
  if (c.what === "back") return `${T} is back`;
  if (c.what === "gone") return `${T} is gone`;
  if (c.what === "children") return `${T} has ${c.n ?? 1} newer ${plural(tableLabel(c.child ?? "row"), c.n ?? 1)}`;
  // updated_at and the like change with every write: never name them.
  const cols = (c.cols ?? []).filter((col) => !QUIET.has(col));
  return cols.length ? `${T}: ${cols.map(columnLabel).join(", ")} changed since` : `${T} changed since`;
}
