/**
 * The UGC actions on in-memory rows, for /dev/ugc and the e2e. Same inputs, same zod checks, same result shapes
 * as `src/lib/ugc/actions.ts`; the rows live in a small store the fixture page subscribes to. A reload starts over.
 */
import type { z } from "zod";
import type { UndoResult } from "@/lib/activity/types";
import { dayKeyInZone } from "@/lib/ugc/days";
import { nextPausedSpans } from "@/lib/ugc/ledger";
import { logoFileProblem, logoObjectPath } from "@/lib/ugc/logo";
import { archivePatch, restorePatch, type DealPaymentRow, type LinkActivity, type PostDbRow } from "@/lib/ugc/writes";
import {
  DEAL_DEFAULTS,
  addPostSchema,
  createDealSchema,
  dealIdSchema,
  dealInputToRow,
  dealRowToInput,
  dealSchema,
  decidePayoutRuleSchema,
  editPostSchema,
  endDealSchema,
  invalidInput,
  linkPostsSchema,
  matchPaymentSchema,
  normalizeHandle,
  payoutPairSchema,
  payoutRuleKeySchema,
  postIdSchema,
  setDayTargetSchema,
  setViewsSchema,
  unlinkPostSchema,
  unmatchPaymentSchema,
  updateDealSchema,
  type ActionErrorCode,
  type ActionResult,
  type DealDbRow,
} from "@/lib/ugc/schemas";
import { deriveViews } from "./fixture-data";
import type { PostRaw, UgcActions, UgcRaw } from "./types";

const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });
/** A result that carries the activity id its undo takes (the server's withActivity). */
const withId = <T>(r: ActionResult<T>, activityId: string): ActionResult<T> => Object.assign(r, { activityId });
const fail = (code: ActionErrorCode, message: string): ActionResult<never> => ({ ok: false, error: { code, message } });

/** Drop keys whose value is undefined (zod .partial() keeps them when sent). */
function defined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const dbPost = (p: PostRaw, nowIso: string): PostDbRow => ({
  id: p.id,
  deal_id: p.deal_id,
  account_id: p.account_id,
  platform: p.platform,
  url: p.url,
  title: p.title,
  posted_at: p.posted_at,
  video_group_id: p.video_group_id,
  exclude_from_pay: p.exclude_from_pay,
  manual_override_cents: p.manual_override_cents,
  source: "hydra",
  created_at: nowIso,
  updated_at: nowIso,
});

function snapshotRates(d: DealDbRow): Partial<PostRaw> {
  return {
    base_pay_cents_snap: d.base_pay_cents === null ? null : Number(d.base_pay_cents),
    base_min_views_snap: d.base_min_views,
    view_bonuses_snap: d.view_bonuses,
    view_bonus_mode_snap: d.view_bonus_mode,
    cpm_rate_snap: d.cpm_rate,
    cpm_view_unit_snap: d.cpm_view_unit,
    cpm_cap_views_snap: d.cpm_cap_views,
    cpm_min_views_snap: d.cpm_min_views,
    cpm_tiers_snap: d.cpm_tiers,
    cpm_mode_snap: d.cpm_mode,
    cpm_tier_mode_snap: d.cpm_tier_mode,
  };
}

export interface Memory {
  get: () => UgcRaw;
  subscribe: (cb: () => void) => () => void;
  actions: UgcActions;
  /** Undo a link or unlink by the activityId it returned (the fixture's undo bar). */
  undo: (id: string) => Promise<UndoResult>;
}

export function createMemory(initial: UgcRaw): Memory {
  let raw = initial;
  let seq = 0;
  const listeners = new Set<() => void>();
  const newId = () => `00000000-0000-4000-8000-${String(900_000 + ++seq).padStart(12, "0")}`;
  const commit = (next: UgcRaw) => {
    raw = { ...next, views: deriveViews(next.posts, next.deals, next.snapshots) };
    listeners.forEach((l) => l());
  };

  function guard<S extends z.ZodType, T>(
    schema: S,
    input: unknown,
    write: (data: z.output<S>) => ActionResult<T>,
  ): Promise<ActionResult<T>> {
    const parsed = schema.safeParse(input);
    return Promise.resolve(parsed.success ? write(parsed.data) : invalidInput(parsed.error));
  }

  const setStatus = (id: string, status: DealDbRow["status"], from: readonly string[], extra: Partial<DealDbRow> = {}) => {
    const current = raw.deals.find((d) => d.id === id);
    if (!current) return fail("not_found", "No such deal");
    if (!from.includes(current.status)) return fail("rejected", `The deal is ${current.status}`);
    const today = dayKeyInZone(new Date(raw.nowIso), raw.zone);
    const paused_spans = nextPausedSpans(current.paused_spans, current.status, status, today);
    const next = { ...current, status, paused_spans, ...extra };
    commit({ ...raw, deals: raw.deals.map((d) => (d.id === id ? next : d)) });
    return ok(next);
  };

  const ensureAccount = (dealId: string, platform: PostRaw["platform"], handle: string) => {
    const h = normalizeHandle(handle);
    const found = raw.accounts.find((a) => a.deal_id === dealId && a.platform === platform && a.handle === h);
    if (found) return found.id;
    const id = newId();
    raw = { ...raw, accounts: [...raw.accounts, { id, deal_id: dealId, platform, handle: h }] };
    return id;
  };

  const setPost = (id: string, patch: Partial<PostRaw>): ActionResult<PostDbRow> => {
    const post = raw.posts.find((p) => p.id === id);
    if (!post) return fail("not_found", "No such post");
    const next = { ...post, ...patch };
    commit({ ...raw, posts: raw.posts.map((p) => (p.id === id ? next : p)) });
    return ok(dbPost(next, raw.nowIso));
  };

  const actions: UgcActions = {
    createDeal: (input) =>
      guard(createDealSchema, input, (data) => {
        const { source, sourceId, ...fields } = data;
        const full = dealSchema.safeParse({ ...DEAL_DEFAULTS, ...defined(fields) });
        if (!full.success) return invalidInput(full.error);
        const row = {
          ...dealInputToRow(full.data),
          id: newId(),
          entity_id: "00000000-0000-4000-8000-000000000001",
          status: "active",
          source,
          source_id: sourceId,
          created_at: raw.nowIso,
          updated_at: raw.nowIso,
        } as DealDbRow;
        commit({ ...raw, deals: [...raw.deals, row] });
        return ok(row);
      }),

    updateDeal: (input) =>
      guard(updateDealSchema, input, ({ id, ...patch }) => {
        const current = raw.deals.find((d) => d.id === id);
        if (!current) return fail("not_found", "No such deal");
        const full = dealSchema.safeParse({ ...dealRowToInput(current), ...defined(patch) });
        if (!full.success) return invalidInput(full.error);
        const next = { ...current, ...dealInputToRow(full.data), updated_at: raw.nowIso } as DealDbRow;
        commit({ ...raw, deals: raw.deals.map((d) => (d.id === id ? next : d)) });
        return ok(next);
      }),

    pauseDeal: (input) => guard(dealIdSchema, input, (d) => setStatus(d.id, "paused", ["active"])),
    // Resume a pause, or restore an archived (ended) deal: the same rules as the server (restorePatch, archivePatch).
    resumeDeal: (input) =>
      guard(dealIdSchema, input, (d) => {
        const current = raw.deals.find((x) => x.id === d.id);
        if (current?.status !== "ended") return setStatus(d.id, "active", ["paused"]);
        return setStatus(d.id, "active", ["ended"], restorePatch(current, dayKeyInZone(new Date(raw.nowIso), raw.zone)));
      }),
    endDeal: (input) =>
      guard(endDealSchema, input, (d) => {
        const current = raw.deals.find((x) => x.id === d.id);
        if (d.endDate || !current) return setStatus(d.id, "ended", ["active", "paused", "ended"], { end_date: d.endDate ?? null });
        return setStatus(d.id, "ended", ["active", "paused", "ended"], archivePatch(current, dayKeyInZone(new Date(raw.nowIso), raw.zone)));
      }),

    deleteDeal: (input) =>
      guard(dealIdSchema, input, ({ id }) => {
        if (!raw.deals.some((d) => d.id === id)) return fail("not_found", "No such deal");
        const gone = new Set(raw.posts.filter((p) => p.deal_id === id).map((p) => p.id));
        commit({
          ...raw,
          deals: raw.deals.filter((d) => d.id !== id),
          accounts: raw.accounts.filter((a) => a.deal_id !== id),
          posts: raw.posts.filter((p) => p.deal_id !== id),
          snapshots: raw.snapshots.filter((s) => !gone.has(s.post_id)),
          payments: raw.payments.filter((p) => p.deal_id !== id),
          dayTargets: raw.dayTargets.filter((t) => t.deal_id !== id),
        });
        return ok({ id });
      }),

    addPost: (input) =>
      guard(addPostSchema, input, (data) => {
        const deal = raw.deals.find((d) => d.id === data.dealId);
        if (!deal) return fail("not_found", "No such deal");
        const prior = raw.posts.find((p) => p.url === data.url);
        if (prior && prior.deal_id !== data.dealId) return fail("conflict", "This URL is on another deal");
        const accountId = data.account ? ensureAccount(data.dealId, data.platform, data.account) : (prior?.account_id ?? null);
        if (prior) {
          const res = setPost(prior.id, {
            account_id: accountId,
            video_group_id: data.videoGroupId ?? prior.video_group_id,
            title: data.title ?? prior.title,
          });
          return res.ok ? ok({ post: res.data, created: false as boolean }) : res;
        }
        const post: PostRaw = {
          id: newId(),
          deal_id: data.dealId,
          account_id: accountId,
          url: data.url,
          platform: data.platform,
          title: data.title ?? null,
          posted_at: data.postedAt,
          video_group_id: data.videoGroupId ?? null,
          exclude_from_pay: false,
          manual_override_cents: null,
          ...snapshotRates(deal),
        } as PostRaw;
        commit({ ...raw, posts: [...raw.posts, post] });
        return ok({ post: dbPost(post, raw.nowIso), created: true as boolean });
      }),

    editPost: (input) =>
      guard(editPostSchema, input, (data) => {
        const post = raw.posts.find((p) => p.id === data.id);
        if (!post) return fail("not_found", "No such post");
        const dealId = data.dealId ?? post.deal_id;
        const deal = raw.deals.find((d) => d.id === dealId);
        if (!deal) return fail("not_found", "No such deal");
        const platform = data.platform ?? post.platform;
        const patch: Partial<PostRaw> = defined({
          deal_id: data.dealId,
          url: data.url,
          platform: data.platform,
          posted_at: data.postedAt,
          video_group_id: data.videoGroupId,
          title: data.title,
          manual_override_cents: data.manualOverrideCents,
        });
        if (data.account === null) patch.account_id = null;
        else if (data.account !== undefined) patch.account_id = ensureAccount(dealId, platform, data.account);
        else if (dealId !== post.deal_id) patch.account_id = null;
        if (dealId !== post.deal_id) Object.assign(patch, snapshotRates(deal));
        return setPost(data.id, patch);
      }),

    excludePost: (input) => guard(postIdSchema, input, (d) => setPost(d.id, { exclude_from_pay: true })),
    unexcludePost: (input) => guard(postIdSchema, input, (d) => setPost(d.id, { exclude_from_pay: false })),

    deletePost: (input) =>
      guard(postIdSchema, input, ({ id }) => {
        if (!raw.posts.some((p) => p.id === id)) return fail("not_found", "No such post");
        commit({
          ...raw,
          posts: raw.posts.filter((p) => p.id !== id),
          snapshots: raw.snapshots.filter((s) => s.post_id !== id),
        });
        return ok({ id });
      }),

    setDayTarget: (input) =>
      guard(setDayTargetSchema, input, ({ dealId, day, target }) => {
        const rest = raw.dayTargets.filter((t) => !(t.deal_id === dealId && t.day === day));
        commit({ ...raw, dayTargets: target === null ? rest : [...rest, { deal_id: dealId, day, target }] });
        return ok({ dealId, day, target });
      }),

    matchPayment: (input) =>
      guard(matchPaymentSchema, input, (data) => {
        if (raw.payments.some((p) => p.transaction_id === data.transactionId)) {
          return fail("conflict", "This deposit is already matched to a deal");
        }
        const deposit = raw.deposits.find((d) => d.id === data.transactionId);
        const row: DealPaymentRow = {
          id: newId(),
          deal_id: data.dealId,
          transaction_id: data.transactionId,
          amount_cents: data.amountCents,
          paid_on: data.paidOn,
          created_at: raw.nowIso,
        };
        commit({
          ...raw,
          payments: [...raw.payments, { ...row, name: deposit?.name ?? null }],
          deposits: raw.deposits.filter((d) => d.id !== data.transactionId),
        });
        return ok(row);
      }),

    // The owner's own readings: stored as given (the guards are for Grokbot; `force` is the owner's accept).
    setViews: (input) =>
      guard(setViewsSchema, input, (data) => {
        const day = dayKeyInZone(new Date(data.capturedAt), raw.zone);
        const items = data.items.map((i) => {
          const post = raw.posts.find((p) => p.id === i.postId || p.url === i.url);
          return { post, views: i.views };
        });
        const found = items.filter((i) => i.post);
        const keep = raw.snapshots.filter((s) => !found.some((i) => i.post!.id === s.post_id && s.captured_day === day));
        commit({
          ...raw,
          snapshots: [
            ...keep,
            ...found.map((i) => ({ post_id: i.post!.id, captured_day: day, captured_at: data.capturedAt, views: i.views, held: false })),
          ],
        });
        return ok({
          day,
          items: items.map((i) =>
            i.post
              ? { postId: i.post.id, url: i.post.url, status: "written" as const }
              : { postId: null, url: null, status: "not_found" as const },
          ),
        });
      }),

    uploadDealLogo: ({ dealId, file }) => {
      const problem = logoFileProblem(file);
      if (problem) return Promise.resolve(fail("invalid_input", problem));
      const current = raw.deals.find((d) => d.id === dealId);
      if (!current) return Promise.resolve(fail("not_found", "No such deal"));
      const path = logoObjectPath(dealId, file.type);
      const next = { ...current, logo_path: path, updated_at: raw.nowIso };
      commit({ ...raw, deals: raw.deals.map((d) => (d.id === dealId ? next : d)), logos: { ...raw.logos, [path]: URL.createObjectURL(file) } });
      return Promise.resolve(ok(next));
    },

    unmatchPayment: (input) =>
      guard(unmatchPaymentSchema, input, ({ transactionId }) => {
        const payment = raw.payments.find((p) => p.transaction_id === transactionId);
        if (!payment) return fail("not_found", "This deposit is not matched");
        commit({
          ...raw,
          payments: raw.payments.filter((p) => p.transaction_id !== transactionId),
          deposits: [
            { id: transactionId, name: payment.name ?? "Deposit", amount_cents: payment.amount_cents, posted_on: payment.paid_on },
            ...raw.deposits,
          ],
        });
        return ok({ transactionId });
      }),

    rejectPayoutMatch: (input) =>
      guard(payoutPairSchema, input, ({ dealId, transactionId }) => {
        if (!raw.payoutRejections.some((r) => r.deal_id === dealId && r.transaction_id === transactionId)) {
          commit({ ...raw, payoutRejections: [...raw.payoutRejections, { deal_id: dealId, transaction_id: transactionId }] });
        }
        return ok({ dealId, transactionId });
      }),

    undoRejectPayoutMatch: (input) =>
      guard(payoutPairSchema, input, ({ dealId, transactionId }) => {
        commit({ ...raw, payoutRejections: raw.payoutRejections.filter((r) => !(r.deal_id === dealId && r.transaction_id === transactionId)) });
        return ok({ dealId, transactionId });
      }),

    removePayoutRule: (input) =>
      guard(payoutRuleKeySchema, input, ({ dealId, payerKey }) => {
        commit({ ...raw, payoutRules: raw.payoutRules.filter((r) => !(r.deal_id === dealId && r.payer_key === payerKey)) });
        return ok({ dealId, payerKey });
      }),

    decidePayoutRule: (input) =>
      guard(decidePayoutRuleSchema, input, ({ dealId, payerKey, dayOfMonth, decision }) => {
        const row = { id: newId(), deal_id: dealId, payer_key: payerKey, day_of_month: dayOfMonth, day_window: 3, decision };
        const rest = raw.payoutRules.filter((r) => !(r.deal_id === dealId && r.payer_key === payerKey));
        commit({ ...raw, payoutRules: [...rest, row] });
        return ok(row);
      }),

    // As writes.ts linkPosts: the posts' videos merge into the first existing group (else a new manual- one), all hand-set.
    linkPosts: (input) =>
      guard(linkPostsSchema, input, ({ postIds }) => {
        const picked = [...new Set(postIds)].map((id) => raw.posts.find((p) => p.id === id));
        if (picked.some((p) => !p)) return fail("not_found", "A post is gone");
        const rows = picked as PostRaw[];
        const dealId = rows[0].deal_id;
        if (rows.some((r) => r.deal_id !== dealId)) return fail("invalid_input", "Posts of one video must be on one deal");
        const groups = [...new Set(rows.flatMap((r) => (r.video_group_id ? [r.video_group_id] : [])))].sort();
        const groupId = groups[0] ?? `manual-${newId()}`;
        const moved = raw.posts.filter(
          (p) => rows.includes(p) || (p.deal_id === dealId && p.video_group_id && groups.includes(p.video_group_id)),
        );
        const activityId = remember(moved);
        commit({
          ...raw,
          posts: raw.posts.map((p) => (moved.includes(p) ? { ...p, video_group_id: groupId, video_group_manual: true } : p)),
        });
        const changes = moved
          .filter((p) => p.video_group_id !== groupId)
          .map((p) => ({ postId: p.id, from: p.video_group_id, to: groupId }));
        return withId(ok<LinkActivity>({ dealId, changes }), activityId);
      }),

    unlinkPost: (input) =>
      guard(unlinkPostSchema, input, ({ postId }) => {
        const post = raw.posts.find((p) => p.id === postId);
        if (!post) return fail("not_found", "No such post");
        const activityId = remember([post]);
        commit({ ...raw, posts: raw.posts.map((p) => (p === post ? { ...p, video_group_id: null, video_group_manual: true } : p)) });
        const changes = post.video_group_id ? [{ postId, from: post.video_group_id, to: null }] : [];
        return withId(ok<LinkActivity>({ dealId: post.deal_id, changes }), activityId);
      }),
  };

  // Link and unlink are undoable here as on the server: the posts' group columns before the write, by activity id.
  const undos = new Map<string, Pick<PostRaw, "id" | "video_group_id" | "video_group_manual">[]>();
  function remember(posts: readonly PostRaw[]): string {
    const id = newId();
    undos.set(id, posts.map((p) => ({ id: p.id, video_group_id: p.video_group_id, video_group_manual: p.video_group_manual ?? false })));
    return id;
  }
  const undo = (id: string): Promise<UndoResult> => {
    const before = undos.get(id);
    if (!before) return Promise.resolve({ ok: false, error: "not_found" });
    undos.delete(id);
    const back = new Map(before.map((b) => [b.id, b]));
    commit({ ...raw, posts: raw.posts.map((p) => (back.has(p.id) ? { ...p, ...back.get(p.id) } : p)) });
    return Promise.resolve({ ok: true, undoId: newId() });
  };

  return {
    get: () => raw,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    actions,
    undo,
  };
}
