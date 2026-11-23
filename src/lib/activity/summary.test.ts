import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { changedLine, TABLE_LABELS } from "./summary";

it("every table a migration logs for Activity has an owner label", () => {
  const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
  const logged = new Set<string>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(/\('([a-z_]+)', true, (?:null|'[^']*')\)/g)) logged.add(m[1]!);
  }
  expect(logged.size).toBeGreaterThan(30);
  expect([...logged].filter((t) => !TABLE_LABELS[t])).toEqual([]);
});

it("a changed-since line names the owner's columns, never updated_at", () => {
  const row = { title: "Plan" };
  expect(changedLine({ tbl: "planning_tasks", what: "changed", cols: ["title", "updated_at"], row })).toBe('Task "Plan": Title changed since');
  expect(changedLine({ tbl: "planning_tasks", what: "changed", cols: ["updated_at"], row })).toBe('Task "Plan" changed since');
});

it("names newer rows under an added row, and why a blocked undo cannot run", () => {
  expect(changedLine({ tbl: "deals", what: "children", row: { brand_name: "Nova" }, child: "deal_accounts", n: 1 })).toBe('Deal "Nova" has 1 newer deal account');
  expect(changedLine({ tbl: "deals", what: "children", row: { brand_name: "Nova" }, child: "day_targets", n: 2 })).toBe('Deal "Nova" has 2 newer day targets');
  expect(changedLine({ tbl: "planning_goals", what: "children", row: { title: "Ship" }, child: "planning_goal_metrics", n: 3 })).toBe('Goal "Ship" has 3 newer goal metrics');
  expect(changedLine({ tbl: "categories", what: "blocked", why: "taken" })).toBe("A category with the same name exists now");
  expect(changedLine({ tbl: "categories", what: "blocked", why: "rule", msg: "categories: two levels only" })).toBe("Putting the category back breaks a rule: two levels only");
  expect(changedLine({ tbl: "transactions", what: "blocked", why: "not_allowed" })).toBe("This transaction cannot be changed from Hydra");
  expect(changedLine({ tbl: null, what: "blocked", why: "linked" })).toBe("The row it belongs to is gone");
});
