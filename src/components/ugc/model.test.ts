import { describe, expect, it } from "vitest";
import { fixtureRaw, DEAL_WORDWISE, DEAL_CANVASLY, DEAL_STUDYFETCH, DEAL_BRIGHTLEAF } from "./fixture-data";
import { createMemory } from "./memory-actions";
import {
  apart,
  buildModel,
  calendarFor,
  csvCell,
  dayDetail,
  dealRunsOn,
  calendarRange,
  earnedSeries,
  firstWeekday,
  paySummary,
  payoutMatchesFor,
  periodTotals,
  shiftMonth,
  summarizeCalendar,
  videosToCsv,
} from "./model";

describe("UGC model on the fixture", () => {
  const model = buildModel(fixtureRaw());

  it("adds up: earned = base + cpm + bonus + adjustments + flat, owed = earned - paid", () => {
    const t = model.totals;
    expect(t.baseCents + t.cpmCents + t.bonusCents + t.adjustCents + t.flatCents).toBe(t.earnedCents);
    expect(t.owedCents).toBe(t.earnedCents - t.paidCents);
    expect(t.paidCents).toBe(128_000 + 40_000 + 90_000);
    expect(t.earnedCents).toBeGreaterThan(t.paidCents);
    expect(t.projectedCents).toBe((2 * 2500 + 1 * 4000) * 30); // active deals only, paused and ended excluded
  });

  it("counts a video on two accounts once and pays an excluded video $0", () => {
    const grouped = model.videos.filter((v) => v.postIds.length > 1);
    expect(grouped).toHaveLength(1);
    const excluded = model.videos.filter((v) => v.excluded);
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.every((v) => v.payCents === 0 && v.dealId === DEAL_CANVASLY)).toBe(true);
  });

  it("a day off has target 0 and no missed money", () => {
    const day = dayDetail(model, "2026-11-11");
    const wordwise = day.deals.find((d) => d.deal.deal.id === DEAL_WORDWISE)!;
    expect(wordwise.override).toBe(0);
    expect(wordwise.target).toBe(0);
    expect(wordwise.missedCents).toBe(0);
  });

  it("the calendar covers the month and today is not yet elapsed", () => {
    const cal = calendarFor(model, "2026-11", null);
    expect(cal).toHaveLength(30);
    expect(cal.find((d) => d.date === "2026-11-22")!.status).toBe("future");
    const s = summarizeCalendar(cal);
    expect(s.hitDays).toBeLessThanOrEqual(s.targetDays);
    const series = earnedSeries(model, "2026-11-01", "2026-11-30", null);
    expect(series).toHaveLength(30);
    expect(series.reduce((sum, d) => sum + d.cents, 0)).toBeGreaterThan(0);
    // A range across a month end joins both months' days in order.
    const across = earnedSeries(model, "2026-10-26", "2026-11-01", null);
    expect(across.map((d) => d.day)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  });

  it("the calendar pills count the period: a week's hit days are a subset of the month's", () => {
    const week = summarizeCalendar(calendarRange(model, "2026-11-01", "2026-11-07", null));
    const month = summarizeCalendar(calendarFor(model, "2026-11", null));
    expect(week.targetDays).toBeLessThanOrEqual(7);
    expect(week.targetDays).toBeLessThan(month.targetDays);
    expect(calendarRange(model, "2026-11-01", "2026-11-30", null)).toEqual(calendarFor(model, "2026-11", null));
    // Weeks start Monday: Nov 1, 2026 is a Sunday, the 7th cell.
    expect(firstWeekday("2026-11")).toBe(6);
    expect(firstWeekday("2026-06")).toBe(0);
  });

  it("period totals: the days add up to all time, owed is the balance at the period's end", () => {
    const all = periodTotals(model, null, "2000-01-01", "2099-12-31");
    expect(all.earnedCents).toBe(model.totals.earnedCents);
    expect(all.paidCents).toBe(model.totals.paidCents);
    expect(all.owedCents).toBe(model.totals.owedCents);
    expect(all.missedCents).toBe(model.totals.missedCents);
    expect(all.videoCount).toBe(model.totals.videoCount);
    // Splitting the time line in two splits earned, paid, missed and videos exactly.
    const oct = periodTotals(model, null, "2000-01-01", "2026-10-31");
    const nov = periodTotals(model, null, "2026-11-01", "2099-12-31");
    expect(oct.earnedCents + nov.earnedCents).toBe(all.earnedCents);
    expect(oct.paidCents + nov.paidCents).toBe(all.paidCents);
    expect(oct.missedCents + nov.missedCents).toBe(all.missedCents);
    expect(oct.videoCount + nov.videoCount).toBe(all.videoCount);
    // Every deposit is in November, so October owes everything it earned.
    expect(oct.paidCents).toBe(0);
    expect(oct.owedCents).toBe(oct.earnedCents);
    const month = periodTotals(model, null, "2026-11-01", "2026-11-30");
    expect(month.paidCents).toBe(258_000);
    expect(month.paymentCount).toBe(3);
    expect(month.owedCents).toBe(model.totals.owedCents);
    expect(month.baseCents + month.cpmCents + month.bonusCents + month.adjustCents + month.flatCents).toBe(month.earnedCents);
    // One deal: only its money.
    const one = periodTotals(model, DEAL_WORDWISE, "2026-11-01", "2026-11-30");
    expect(one.paidCents).toBe(128_000);
    expect(one.earnedCents).toBeLessThan(month.earnedCents);
    // The future earns nothing and misses nothing.
    const later = periodTotals(model, null, "2026-11-23", "2026-11-29");
    expect(later.earnedCents).toBe(0);
    expect(later.missedCents).toBe(0);
  });

  it("shifts months across a year end", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("summarizes pay and defuses CSV formulas", () => {
    const wordwise = model.deals.find((d) => d.deal.id === DEAL_WORDWISE)!.deal;
    expect(paySummary(wordwise)).toBe("$25 base + 3 bonus tiers");
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(videosToCsv(model.videos).split("\n")).toHaveLength(model.videos.length + 1);
  });
});

describe("memory actions", () => {
  it("exclude, then unexclude, moves the totals; a delete removes the post", async () => {
    const mem = createMemory(fixtureRaw());
    const before = buildModel(mem.get());
    const video = before.videos.find((v) => !v.excluded && v.payCents > 0)!;
    expect((await mem.actions.excludePost({ id: video.postIds[0] })).ok).toBe(true);
    const after = buildModel(mem.get());
    expect(after.totals.earnedCents).toBeLessThan(before.totals.earnedCents);
    await mem.actions.unexcludePost({ id: video.postIds[0] });
    expect(buildModel(mem.get()).totals.earnedCents).toBe(before.totals.earnedCents);
    expect((await mem.actions.deletePost({ id: video.postIds[0] })).ok).toBe(true);
    expect(buildModel(mem.get()).videos.length).toBe(before.videos.length - 1);
  });

  it("a day target override of 0 removes the missed money for that day", async () => {
    const mem = createMemory(fixtureRaw());
    const before = dayDetail(buildModel(mem.get()), "2026-11-18");
    const d = before.deals.find((x) => x.missedCents > 0);
    if (!d) return;
    await mem.actions.setDayTarget({ dealId: d.deal.deal.id, day: "2026-11-18", target: 0 });
    const after = dayDetail(buildModel(mem.get()), "2026-11-18");
    expect(after.deals.find((x) => x.deal.deal.id === d.deal.deal.id)!.missedCents).toBe(0);
  });

  it("an archived deal leaves the day cards after its end date, and Restore brings it back", async () => {
    const mem = createMemory(fixtureRaw());
    const onDay = (day: string) => dayDetail(buildModel(mem.get()), day).deals.map((d) => d.deal.deal.id);
    // A day off override keeps a 0-target card on Wordwise's Nov 11.
    expect(onDay("2026-11-11")).toContain(DEAL_WORDWISE);
    // Archived today (Nov 21): the earlier day keeps it, a day after the end does not.
    expect((await mem.actions.endDeal({ id: DEAL_WORDWISE })).ok).toBe(true);
    await mem.actions.setDayTarget({ dealId: DEAL_WORDWISE, day: "2026-11-25", target: 0 });
    expect(onDay("2026-11-11")).toContain(DEAL_WORDWISE);
    expect(onDay("2026-11-25")).not.toContain(DEAL_WORDWISE);
    const restored = await mem.actions.resumeDeal({ id: DEAL_WORDWISE });
    expect(restored.ok && restored.data.status === "active" && restored.data.end_date === null).toBe(true);
    expect(onDay("2026-11-25")).toContain(DEAL_WORDWISE);
  });

  it("Restore of a deal that ended weeks ago adds no missed money, and Archive then Restore keeps a planned end", async () => {
    const mem = createMemory(fixtureRaw());
    const missed = () => buildModel(mem.get()).totals.missedCents;
    const before = missed();
    // Studyfetch ended 2026-10-31; today is 2026-11-21.
    const back = await mem.actions.resumeDeal({ id: DEAL_STUDYFETCH });
    expect(back.ok && back.data.status === "active" && back.data.end_date === null).toBe(true);
    expect(missed()).toBe(before);

    expect((await mem.actions.updateDeal({ id: DEAL_WORDWISE, endDate: "2026-12-31" })).ok).toBe(true);
    expect((await mem.actions.endDeal({ id: DEAL_WORDWISE })).ok).toBe(true);
    const wordwise = await mem.actions.resumeDeal({ id: DEAL_WORDWISE });
    expect(wordwise.ok && wordwise.data.end_date).toBe("2026-12-31");
  });

  it("a day panel keeps a deal's videos posted outside its dates, matching the calendar", async () => {
    const mem = createMemory(fixtureRaw());
    // Wordwise has counted videos on 2026-11-21; end it the day before.
    expect((await mem.actions.endDeal({ id: DEAL_WORDWISE, endDate: "2026-11-20" })).ok).toBe(true);
    const m = buildModel(mem.get());
    const cell = calendarFor(m, "2026-11", null).find((d) => d.date === "2026-11-21")!;
    const day = dayDetail(m, "2026-11-21");
    expect(day.deals.map((d) => d.deal.deal.id)).toContain(DEAL_WORDWISE);
    expect(day.earnedCents).toBe(cell.earnedCents);
  });

  it("a deal runs only between its start and end dates", () => {
    const d = { status: "active", start_date: "2026-11-01", end_date: "2026-11-30" } as const;
    expect(dealRunsOn(d, "2026-10-31")).toBe(false);
    expect(dealRunsOn(d, "2026-11-01")).toBe(true);
    expect(dealRunsOn(d, "2026-11-30")).toBe(true);
    expect(dealRunsOn(d, "2026-12-01")).toBe(false);
    expect(dealRunsOn({ ...d, end_date: null }, "2027-06-01")).toBe(true);
    expect(dealRunsOn({ ...d, status: "ended", end_date: null }, "2026-11-15")).toBe(false);
  });

  it("creates a deal through the same schema and refuses a bad one", async () => {
    const mem = createMemory(fixtureRaw());
    const bad = await mem.actions.createDeal({ brandName: "  ", startDate: "2026-11-21" });
    expect(bad.ok).toBe(false);
    const good = await mem.actions.createDeal({ brandName: "Acme", startDate: "2026-11-21", basePayCents: 3000 });
    expect(good.ok).toBe(true);
    expect(buildModel(mem.get()).deals.some((d) => d.deal.brand_name === "Acme")).toBe(true);
  });
});

describe("Match payouts on the fixture", () => {
  it("suggests the two unnamed PayPal transfers for Brightleaf; confirming both offers a rule; Not this hides one", async () => {
    const mem = createMemory(fixtureRaw());
    const first = payoutMatchesFor(buildModel(mem.get()), mem.get());
    const paypal = first.suggestions.filter((s) => s.depositName.startsWith("PAYPAL TRANSFER"));
    expect(paypal.map((s) => s.brandName)).toEqual(["Brightleaf", "Brightleaf"]);
    expect(first.ruleOffers).toEqual([]);

    for (const s of paypal) {
      const r = await mem.actions.matchPayment({ dealId: s.dealId, transactionId: s.transactionId, amountCents: s.amountCents, paidOn: s.postedOn });
      expect(r.ok).toBe(true);
    }
    const after = payoutMatchesFor(buildModel(mem.get()), mem.get());
    expect(after.suggestions.some((s) => s.depositName.startsWith("PAYPAL"))).toBe(false);
    expect(after.ruleOffers).toEqual([expect.objectContaining({ dealId: DEAL_BRIGHTLEAF, payerKey: "paypal transfer", confirmations: 2 })]);

    const offer = after.ruleOffers[0]!;
    await mem.actions.decidePayoutRule({ dealId: offer.dealId, payerKey: offer.payerKey, dayOfMonth: offer.dayOfMonth, decision: "accepted" });
    expect(payoutMatchesFor(buildModel(mem.get()), mem.get()).ruleOffers).toEqual([]);

    // Removing the kept rule brings the offer back.
    await mem.actions.removePayoutRule({ dealId: offer.dealId, payerKey: offer.payerKey });
    expect(mem.get().payoutRules).toEqual([]);
    expect(payoutMatchesFor(buildModel(mem.get()), mem.get()).ruleOffers).toHaveLength(1);

    const other = after.suggestions[0]!;
    expect(other.depositName).toBe("STRIPE TRANSFER CANVASLY");
    const pair = { dealId: other.dealId, transactionId: other.transactionId };
    const has = () =>
      payoutMatchesFor(buildModel(mem.get()), mem.get()).suggestions.some((s) => s.dealId === pair.dealId && s.transactionId === pair.transactionId);
    await mem.actions.rejectPayoutMatch(pair);
    expect(has()).toBe(false);
    // Undo Not this: suggested again.
    await mem.actions.undoRejectPayoutMatch(pair);
    expect(has()).toBe(true);
  });
});

describe("video matching on the fixture", () => {
  it("lists the unlinked twin and the held one, and a linked video's paid post is its max", () => {
    const model = buildModel(fixtureRaw());
    const needs = model.needsMatching.map((n) => [n.brandName, n.twins[0].reason, n.twins[0].zeroes, n.post.platform !== n.twins[0].post.platform]);
    expect(needs).toEqual([
      ["Wordwise", "title", false, true],
      ["Canvasly", "title", true, true],
    ]);
    const merged = model.videos.find((v) => v.postIds.length > 1)!;
    expect(merged.posts.filter((p) => p.paid)).toHaveLength(1);
    expect(merged.posts[0].paid).toBe(true);
    expect(merged.posts[0].views).toBe(Math.max(...merged.posts.map((p) => p.views ?? 0)));
    expect(merged.views).toBe(merged.posts[0].views);
  });

  it("under Combine platforms every post counts and the row is their sum; an excluded video marks none", () => {
    const raw = fixtureRaw();
    const merged = buildModel(raw).videos.find((v) => v.postIds.length > 1)!;
    const deal = raw.deals.find((d) => d.id === merged.dealId)!;
    deal.view_aggregation_mode = "COMBINED";
    const combined = buildModel(raw).videos.find((v) => v.key === merged.key)!;
    expect(combined.combined).toBe(true);
    expect(combined.posts.every((p) => p.paid)).toBe(true);
    expect(combined.views).toBe(combined.posts.reduce((s, p) => s + (p.views ?? 0), 0));

    deal.view_aggregation_mode = "HIGHEST";
    for (const p of raw.posts) if (p.id === merged.postIds[0]) p.exclude_from_pay = true;
    const excluded = buildModel(raw).videos.find((v) => v.key === merged.key)!;
    expect(excluded.excluded).toBe(true);
    expect(excluded.posts.some((p) => p.paid)).toBe(false);
  });

  it("says how far apart two posts went up, rounding before it picks the unit", () => {
    expect(apart(12 * 60_000)).toBe("12 min apart");
    expect(apart(59.6 * 60_000)).toBe("1 h apart");
    expect(apart(23.6 * 3_600_000)).toBe("1 day apart");
    expect(apart(3 * 86_400_000)).toBe("3 days apart");
  });

  it("link, unlink and undo in memory: the twin pays once, then on its own again", async () => {
    const mem = createMemory(fixtureRaw());
    const before = buildModel(mem.get());
    const item = before.needsMatching.find((n) => !n.twins[0].zeroes)!;
    const linked = await mem.actions.linkPosts({ postIds: [item.post.id, item.twins[0].post.id] });
    expect(linked.ok).toBe(true);
    const after = buildModel(mem.get());
    expect(after.videos).toHaveLength(before.videos.length - 1);
    expect(after.needsMatching).toHaveLength(before.needsMatching.length - 1);
    expect((await mem.undo((linked as { activityId: string }).activityId)).ok).toBe(true);
    expect(buildModel(mem.get()).videos).toHaveLength(before.videos.length);
    expect(buildModel(mem.get()).needsMatching).toHaveLength(before.needsMatching.length);

    const unlinked = await mem.actions.unlinkPost({ postId: before.videos.find((v) => v.postIds.length > 1)!.postIds[0] });
    expect(unlinked.ok).toBe(true);
    expect(buildModel(mem.get()).videos).toHaveLength(before.videos.length + 1);
    // A post unlinked by hand is not suggested again.
    expect(buildModel(mem.get()).needsMatching).toHaveLength(before.needsMatching.length);
  });
});
