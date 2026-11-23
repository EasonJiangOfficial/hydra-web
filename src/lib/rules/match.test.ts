import { describe, expect, it } from "vitest";
import { firstMatch, matchCondition, patchFor, planRun, suggestRule } from "./match";
import { actionsSchema, conditionSchema, type Condition, type Rule, type RuleTarget } from "./model";

const ACC = "aaaaaaaa-0000-4000-8000-000000000001";
const ACC2 = "aaaaaaaa-0000-4000-8000-000000000002";
const CAT = "cccccccc-0000-4000-8000-000000000001";
const CAT2 = "cccccccc-0000-4000-8000-000000000002";
const UGC = "eeeeeeee-0000-4000-8000-000000000002";
const PERSONAL = "eeeeeeee-0000-4000-8000-000000000001";
const LINE = "dddddddd-0000-4000-8000-000000000001";
const REC = "ffffffff-0000-4000-8000-000000000001";

function tx(over: Partial<RuleTarget> = {}): RuleTarget {
  return {
    id: "11111111-0000-4000-8000-000000000001",
    account_id: ACC,
    amount_cents: -1549,
    name: "NETFLIX.COM",
    merchant: "Netflix",
    note: null,
    renamed: false,
    entity_id: PERSONAL,
    category_id: null,
    category_source: "none",
    tax_line_id: null,
    is_transfer: false,
    recurring_id: null,
    ...over,
  };
}

const rule = (id: string, position: number, conditions: Condition[], over: Partial<Rule> = {}): Rule => ({
  id,
  position,
  conditions,
  actions: [{ type: "set_category", categoryId: CAT }],
  enabled: true,
  ...over,
});

describe("every operator", () => {
  // [what, condition, row overrides, expected]
  const cases: [string, Condition, Partial<RuleTarget>, boolean][] = [
    ["contains: substring", { field: "name", op: "contains", value: "flix" }, {}, true],
    ["contains: case ignored", { field: "name", op: "contains", value: "NetFlix" }, {}, true],
    ["contains: plain substring, a dot is a dot", { field: "name", op: "contains", value: "x.c" }, {}, true],
    ["contains: plain substring, not a pattern", { field: "name", op: "contains", value: "n.tflix" }, {}, false],
    ["contains: a star is literal", { field: "name", op: "contains", value: "net*" }, {}, false],
    ["contains: missing text", { field: "name", op: "contains", value: "hulu" }, {}, false],
    ["contains: null merchant never contains", { field: "merchant", op: "contains", value: "x" }, { merchant: null }, false],
    ["is: exact, case and spaces ignored", { field: "name", op: "is", value: "netflix.com" }, { name: " NETFLIX.COM  " }, true],
    ["is: a substring is not exact", { field: "name", op: "is", value: "netflix" }, {}, false],
    ["is: on the note", { field: "note", op: "is", value: "rent" }, { note: "Rent" }, true],
    ["starts_with: yes", { field: "name", op: "starts_with", value: "NETF" }, {}, true],
    ["starts_with: middle text does not count", { field: "name", op: "starts_with", value: "flix" }, {}, false],
    ["contains_any: one hits", { field: "name", op: "contains_any", value: ["hulu", "FLIX"] }, {}, true],
    ["contains_any: none hit", { field: "name", op: "contains_any", value: ["hulu", "disney"] }, {}, false],
    ["not_contains: absent", { field: "name", op: "not_contains", value: "hulu" }, {}, true],
    ["not_contains: present, case ignored", { field: "name", op: "not_contains", value: "NETFLIX" }, {}, false],
    ["not_contains: null note does not contain", { field: "note", op: "not_contains", value: "x" }, { note: null }, true],
    ["one_of: text equals one", { field: "merchant", op: "one_of", value: ["Hulu", "NETFLIX"] }, {}, true],
    ["one_of: text needs a whole match", { field: "merchant", op: "one_of", value: ["Net"] }, {}, false],
    ["regex: matches, case ignored", { field: "name", op: "regex", value: "^net.*\\.com$" }, {}, true],
    ["regex: no match", { field: "name", op: "regex", value: "^hulu" }, {}, false],
    ["amount is: exact signed cents", { field: "amount", op: "is", value: -1549 }, {}, true],
    ["amount is: sign matters", { field: "amount", op: "is", value: 1549 }, {}, false],
    ["amount one_of: hit", { field: "amount", op: "one_of", value: [100, -1549] }, {}, true],
    ["amount one_of: miss", { field: "amount", op: "one_of", value: [100, 1549] }, {}, false],
    ["amount between: inside", { field: "amount", op: "between", value: [-2000, -1000] }, {}, true],
    ["amount between: low edge counts", { field: "amount", op: "between", value: [-1549, 0] }, {}, true],
    ["amount between: high edge counts", { field: "amount", op: "between", value: [-5000, -1549] }, {}, true],
    ["amount between: outside", { field: "amount", op: "between", value: [0, 5000] }, {}, false],
    ["account is: same", { field: "account", op: "is", value: ACC }, {}, true],
    ["account is: other", { field: "account", op: "is", value: ACC2 }, {}, false],
    ["account one_of: hit", { field: "account", op: "one_of", value: [ACC2, ACC] }, {}, true],
    ["account one_of: miss", { field: "account", op: "one_of", value: [ACC2] }, {}, false],
  ];

  it.each(cases)("%s", (_, condition, over, expected) => {
    expect(conditionSchema.parse(condition)).toEqual(condition);
    expect(matchCondition(condition, tx(over))).toBe(expected);
  });
});

describe("rule shapes", () => {
  const refused: [string, unknown][] = [
    ["a text operator on the amount", { field: "amount", op: "contains", value: "15" }],
    ["between on text", { field: "name", op: "between", value: [1, 2] }],
    ["between with the high amount first", { field: "amount", op: "between", value: [10, 1] }],
    ["a pattern that does not compile", { field: "name", op: "regex", value: "(" }],
    ["an empty list", { field: "name", op: "one_of", value: [] }],
    ["an unknown field", { field: "category", op: "is", value: "x" }],
    ["an account that is not an id", { field: "account", op: "is", value: "checking" }],
    ["an empty text", { field: "name", op: "contains", value: "  " }],
  ];
  it.each(refused)("refuses %s", (_, condition) => {
    expect(conditionSchema.safeParse(condition).success).toBe(false);
  });

  it("refuses the same action twice and no action at all", () => {
    expect(actionsSchema.safeParse([]).success).toBe(false);
    expect(
      actionsSchema.safeParse([
        { type: "set_category", categoryId: CAT },
        { type: "set_category", categoryId: CAT2 },
      ]).success,
    ).toBe(false);
  });

  it("takes every action type once", () => {
    const all = [
      { type: "set_category", categoryId: CAT },
      { type: "set_entity", entityId: UGC },
      { type: "rename", name: "Netflix" },
      { type: "set_tax_line", taxLineId: LINE },
      { type: "mark_transfer" },
      { type: "mark_recurring", recurringId: REC },
    ];
    expect(actionsSchema.parse(all)).toEqual(all);
  });
});

describe("first match wins", () => {
  const generic = rule("r-generic", 2, [{ field: "amount", op: "between", value: [-5000, 0] }], {
    actions: [{ type: "set_category", categoryId: CAT2 }],
  });
  const specific = rule("r-netflix", 1, [{ field: "name", op: "contains", value: "netflix" }]);

  it("the lowest position wins, whatever order the rules arrive in", () => {
    expect(firstMatch([generic, specific], tx())?.id).toBe("r-netflix");
    expect(planRun([generic, specific], [tx()])).toEqual([{ ruleId: "r-netflix", patch: { id: tx().id, category_id: CAT } }]);
  });

  it("a later rule never adds to the winner", () => {
    const renameLater = rule("r-rename", 3, [{ field: "name", op: "contains", value: "netflix" }], {
      actions: [{ type: "rename", name: "Netflix" }],
    });
    expect(planRun([renameLater, specific], [tx()])[0].patch).toEqual({ id: tx().id, category_id: CAT });
  });

  it("every condition must match", () => {
    const both = rule("r-both", 0, [
      { field: "name", op: "contains", value: "netflix" },
      { field: "account", op: "is", value: ACC2 },
    ]);
    expect(firstMatch([both, generic], tx())?.id).toBe("r-generic");
  });

  it("a disabled rule is skipped", () => {
    expect(firstMatch([{ ...specific, enabled: false }, generic], tx())?.id).toBe("r-generic");
  });

  it("no rule matches: nothing is written", () => {
    expect(planRun([specific], [tx({ name: "Hulu" })])).toEqual([]);
  });
});

describe("a manual edit wins", () => {
  const all = rule("r-all", 0, [{ field: "name", op: "contains", value: "netflix" }], {
    actions: [
      { type: "set_category", categoryId: CAT },
      { type: "set_entity", entityId: UGC },
      { type: "rename", name: "Netflix" },
      { type: "set_tax_line", taxLineId: LINE },
      { type: "mark_transfer" },
      { type: "mark_recurring", recurringId: REC },
    ],
  });

  it("a row categorized by hand is never touched", () => {
    expect(planRun([all], [tx({ category_source: "manual", category_id: CAT2 })])).toEqual([]);
  });

  it("rows from the feed, an import or an earlier rule are", () => {
    for (const source of ["none", "import", "rule"] as const) {
      expect(planRun([all], [tx({ category_source: source })])).toHaveLength(1);
    }
  });

  it("writes every action", () => {
    expect(patchFor(all.actions, tx())).toEqual({
      id: tx().id,
      category_id: CAT,
      entity_id: UGC,
      name: "Netflix",
      tax_line_id: LINE,
      is_transfer: true,
      recurring_id: REC,
    });
  });

  it("a business picked by hand is never moved; the rest of the rule still lands", () => {
    expect(patchFor([{ type: "set_entity", entityId: UGC }], tx({ entity_id: PERSONAL, entity_manual: true }))).toBeNull();
    expect(patchFor(all.actions, tx({ entity_id: PERSONAL, entity_manual: true }))).not.toHaveProperty("entity_id");
  });

  it("a rename never replaces an earlier rename", () => {
    expect(patchFor([{ type: "rename", name: "Netflix" }], tx({ renamed: true, name: "My TV" }))).toBeNull();
  });

  it("drops what is already so", () => {
    const done = tx({ category_id: CAT, entity_id: UGC, name: "Netflix", tax_line_id: LINE, is_transfer: true, recurring_id: REC });
    expect(patchFor(all.actions, done)).toBeNull();
  });
});

describe("offer a rule after a manual category", () => {
  const specific = rule("r-netflix", 1, [{ field: "name", op: "contains", value: "netflix" }]);

  it("offers merchant is X", () => {
    expect(suggestRule([], tx(), CAT2)).toEqual({
      conditions: [{ field: "merchant", op: "is", value: "Netflix" }],
      actions: [{ type: "set_category", categoryId: CAT2 }],
    });
  });

  it("offers name is X when there is no merchant", () => {
    expect(suggestRule([], tx({ merchant: null }), CAT2)?.conditions).toEqual([{ field: "name", op: "is", value: "NETFLIX.COM" }]);
  });

  it("offers nothing when the rules already give that category", () => {
    expect(suggestRule([specific], tx(), CAT)).toBeNull();
    expect(suggestRule([specific], tx(), CAT2)).not.toBeNull();
  });
});
