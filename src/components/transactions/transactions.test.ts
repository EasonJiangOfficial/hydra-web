import { describe, expect, it } from "vitest";

import { categoryReason, describeCondition, matchesFilters, parseDollars, visibleWindow } from "./describe";
import { fixtureLookups, fixtureRows, fixtureRules, ids } from "./fixture-data";
import { createMemoryApi } from "./memory-api";
import { blankCondition, buildRule, draftFromAction, draftFromCondition } from "./rule-draft";
import { PAGE_SIZE } from "./types";

describe("table window", () => {
  it("draws the rows in view plus overscan, never past the ends", () => {
    expect(visibleWindow(0, 480, 48, 5000)).toEqual({ first: 0, last: 16 });
    expect(visibleWindow(48 * 1000, 480, 48, 5000)).toEqual({ first: 994, last: 1016 });
    expect(visibleWindow(48 * 4990, 480, 48, 5000)).toEqual({ first: 4984, last: 5000 });
    expect(visibleWindow(0, 480, 48, 0)).toEqual({ first: 0, last: 0 });
  });
});

describe("amounts", () => {
  it("reads dollars as signed cents and refuses the rest", () => {
    expect(parseDollars("-12.5")).toBe(-1250);
    expect(parseDollars("$1,200")).toBe(120000);
    expect(parseDollars("12.345")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars("")).toBeNull();
  });
});

describe("the fixture", () => {
  const rows = fixtureRows();
  it("has a few thousand rows, newest first, with unique ids", () => {
    expect(rows.length).toBeGreaterThan(3000);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.every((r, i) => i === 0 || rows[i - 1].posted_on >= r.posted_on)).toBe(true);
  });
  it("has rows that need review", () => {
    expect(rows.filter((r) => matchesFilters(r, { review: true })).length).toBeGreaterThan(50);
  });
  it("a hidden row leaves All and Needs review, and only the Hidden view lists it (the way back)", () => {
    const row = { ...rows[0], hidden: true, category_id: null, is_transfer: false };
    expect(matchesFilters(row, {})).toBe(false);
    expect(matchesFilters(row, { review: true })).toBe(false);
    expect(matchesFilters(row, { hidden: true })).toBe(true);
    expect(matchesFilters({ ...row, hidden: false }, { hidden: true })).toBe(false);
  });
});

describe("category hover reason", () => {
  const l = fixtureLookups();
  const rules = fixtureRules();
  it("names the rule that set a category", () => {
    const row = { ...fixtureRows().find((r) => r.name === "Adobe Creative Cloud" && r.category_source === "rule")! };
    const reason = categoryReason(row, rules, l);
    expect(reason.rule?.id).toBe(ids.rule(1));
    expect(reason.text).toContain("Set by a rule");
    expect(reason.text).toContain("Adobe");
  });
  it("says so when you set it", () => {
    const row = { ...fixtureRows()[0], category_id: ids.category(31), category_source: "manual" as const };
    expect(categoryReason(row, rules, l)).toEqual({ text: "Set by you", rule: null });
  });
  it("describes a condition in plain words", () => {
    expect(describeCondition({ field: "amount", op: "between", value: [-5000, -1000] }, l)).toBe("Amount is between -$50 and -$10");
  });
});

describe("rule draft", () => {
  it("builds the engine's own shapes", () => {
    const c = { ...blankCondition(), text: "adobe, capcut", op: "contains_any" as const };
    const a = { key: "a", type: "set_category" as const, ref: ids.category(11) };
    const built = buildRule([c], [a]);
    expect(built).toEqual({
      ok: true,
      conditions: [{ field: "name", op: "contains_any", value: ["adobe", "capcut"] }],
      actions: [{ type: "set_category", categoryId: ids.category(11) }],
    });
  });
  it("says what to fix", () => {
    const a = { key: "a", type: "set_category" as const, ref: ids.category(11) };
    expect(buildRule([blankCondition()], [a])).toEqual({ ok: false, message: "Add text for the name condition" });
    expect(buildRule([{ ...blankCondition(), text: "x" }], [])).toEqual({ ok: false, message: "Add an action" });
    expect(buildRule([{ ...blankCondition(), text: "(", op: "regex" }], [a])).toEqual({ ok: false, message: "That pattern is not valid" });
    expect(buildRule([{ ...blankCondition(), field: "amount", op: "between", text: "-10", text2: "-50" }], [a]).ok).toBe(false);
    expect(buildRule([{ ...blankCondition(), text: "x" }], [{ ...a, ref: "" }])).toEqual({ ok: false, message: "Pick a value for each action" });
  });
  it("round trips every fixture rule", () => {
    for (const rule of fixtureRules()) {
      const built = buildRule(rule.conditions.map(draftFromCondition), rule.actions.map(draftFromAction));
      expect(built).toEqual({ ok: true, conditions: rule.conditions, actions: rule.actions });
    }
  });
});

describe("the memory api (the fixture's engine)", () => {
  it("pages 200 rows at a time and counts the total", async () => {
    const { api, rows } = createMemoryApi();
    const first = await api.listRows({}, 0);
    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(first.total).toBe(rows().filter((r) => !r.hidden).length);
    const second = await api.listRows({}, PAGE_SIZE);
    expect(second.rows[0].id).not.toBe(first.rows[0].id);
  });

  it("filters by search, category family and review", async () => {
    const { api, lookups } = createMemoryApi();
    const search = await api.listRows({ q: "adobe" }, 0);
    expect(search.total).toBeGreaterThan(0);
    expect(search.rows.every((r) => r.name.toLowerCase().includes("adobe"))).toBe(true);
    const food = [ids.category(30), ids.category(31), ids.category(32), ids.category(33)];
    const family = await api.listRows({ categoryIds: food }, 0);
    expect(family.rows.every((r) => food.includes(r.category_id!))).toBe(true);
    const review = await api.listRows({ review: true }, 0);
    expect(review.rows.every((r) => !r.category_id && !r.is_transfer)).toBe(true);
    expect(await api.reviewCount()).toBe(review.total);
    expect(lookups.categories.length).toBeGreaterThan(10);
  });

  it("a manual category change offers a rule, and the review count drops", async () => {
    const { api } = createMemoryApi();
    const [target] = (await api.listRows({ review: true }, 0)).rows;
    const before = await api.reviewCount();
    const res = await api.setCategory({ transactionId: target.id, categoryId: ids.category(32) });
    expect(res.ok && res.data.suggestion?.actions).toEqual([{ type: "set_category", categoryId: ids.category(32) }]);
    expect(await api.reviewCount()).toBe(before - 1);
    expect((await api.getRow(target.id))?.category_source).toBe("manual");
  });

  it("previews against recent rows and keeps what you set by hand", async () => {
    const { api, rows } = createMemoryApi();
    const mine = rows().find((r) => r.name === "Chipotle")!;
    await api.setCategory({ transactionId: mine.id, categoryId: ids.category(31) });
    const res = await api.previewRule({
      conditions: [{ field: "name", op: "contains", value: "chipotle" }],
      actions: [{ type: "set_category", categoryId: ids.category(32) }],
      days: 3660,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.matched).toBeGreaterThan(0);
    const hand = res.data.rows.find((r) => r.id === mine.id);
    expect(hand).toMatchObject({ manual: true, patch: null });
  });

  it("saves a rule, applies it to past rows, reorders, and deletes", async () => {
    const m = createMemoryApi();
    const { api } = m;
    const made = await api.createRule({
      conditions: [{ field: "name", op: "contains", value: "zara" }],
      actions: [{ type: "set_category", categoryId: ids.category(51) }],
      applyFrom: "2025-01-01",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.data.applied?.changed).toBeGreaterThanOrEqual(0);
    expect(m.rules.at(-1)?.id).toBe(made.data.rule.id);
    const order = m.rules.map((r) => r.id).reverse();
    expect((await api.reorderRules({ ids: order })).ok).toBe(true);
    expect(m.rules.map((r) => r.id)).toEqual(order);
    expect((await api.reorderRules({ ids: order.slice(1) })).ok).toBe(false);
    expect((await api.deleteRule({ id: made.data.rule.id })).ok).toBe(true);
    expect(m.rules.some((r) => r.id === made.data.rule.id)).toBe(false);
  });

  it("pairs two rows as a transfer and unpairs them", async () => {
    const { api, rows } = createMemoryApi();
    const out = rows().find((r) => r.name === "Transfer to Business Checking")!;
    const [cand] = await api.pairCandidates(out.id);
    expect(cand.name).toBe("Transfer from Everyday Checking");
    expect((await api.pairTransfers({ aId: out.id, bId: cand.id })).ok).toBe(true);
    expect((await api.getRow(out.id))?.transfer_pair_id).toBe(cand.id);
    await api.unpairTransfer({ transactionId: out.id });
    expect((await api.getRow(cand.id))?.is_transfer).toBe(false);
  });

  it("suggests a cash-to-cash transfer without pairing it; Not a transfer is remembered, Mark as transfer pairs", async () => {
    const { api, rows } = createMemoryApi();
    const out = rows().find((r) => r.name === "Transfer to Business Checking")!;
    const [first] = await api.transferSuggestions();
    expect([first.out.name, first.into.name]).toEqual(["Transfer to Business Checking", "Transfer from Everyday Checking"]);
    expect(out.is_transfer).toBe(false); // both rows still count
    expect((await api.rejectTransfer({ aId: first.into.id, bId: first.out.id })).ok).toBe(true);
    expect((await api.transferSuggestions()).some((p) => p.out.id === out.id)).toBe(false);

    const again = createMemoryApi();
    const [p] = await again.api.transferSuggestions();
    expect((await again.api.pairTransfers({ aId: p.out.id, bId: p.into.id })).ok).toBe(true);
    expect((await again.api.transferSuggestions()).some((x) => x.out.id === p.out.id)).toBe(false);
  });
});
