"use server";

/**
 * UGC write actions. Pages and the Hydra Agent call exactly these. Each one
 * validates its input with zod, checks the caller is the owner, writes as the
 * owner (RLS applies) and returns a typed ActionResult; nothing throws.
 */
import type { z } from "zod";
import { logoInUse, trashFile } from "@/lib/activity/files";
import { activityIdOf, withActivity, type WithActivity } from "@/lib/activity/request";
import { createServerClient } from "@/lib/supabase/server";
import {
  addPostSchema,
  createDealSchema,
  dealIdSchema,
  decidePayoutRuleSchema,
  editPostSchema,
  endDealSchema,
  invalidInput,
  linkPostsSchema,
  matchPaymentSchema,
  payoutPairSchema,
  payoutRuleKeySchema,
  postIdSchema,
  setDayTargetSchema,
  setViewsSchema,
  unlinkPostSchema,
  unmatchPaymentSchema,
  updateDealSchema,
  type ActionResult,
  type DealDbRow,
} from "@/lib/ugc/schemas";
import {
  createDealFromTemplate as createFromTemplate,
  createDealFromTemplateSchema,
} from "@/lib/ugc/templates";
import * as w from "@/lib/ugc/writes";

async function asOwner<S extends z.ZodType, T>(
  schema: S,
  input: unknown,
  write: (db: w.Db, data: z.output<S>) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    const db = await createServerClient();
    const { data: owner, error } = await db.rpc("is_owner");
    if (error || owner !== true) return w.fail("not_owner", "Only the owner can do this");
    return await write(db, parsed.data);
  } catch (e) {
    return w.fail("db_error", e instanceof Error ? e.message : "Unexpected error");
  }
}

// Deals

/** Create a deal. Send brandName and startDate; every other pay field has a default. */
export async function createDeal(input: z.input<typeof createDealSchema>): Promise<ActionResult<DealDbRow>> {
  return asOwner(createDealSchema, input, w.createDeal);
}

/**
 * Add an already created deal: copies a template's pay structure and logo into a new deal.
 * Send templateId and startDate (endDate and brandName optional). List templates with listDealTemplates.
 */
export async function createDealFromTemplate(
  input: z.input<typeof createDealFromTemplateSchema>,
): Promise<ActionResult<DealDbRow>> {
  return asOwner(createDealFromTemplateSchema, input, createFromTemplate);
}

/** Change any deal fields. The merged pay structure is validated as a whole. */
export async function updateDeal(input: z.input<typeof updateDealSchema>): Promise<ActionResult<DealDbRow>> {
  return asOwner(updateDealSchema, input, w.updateDeal);
}

export async function pauseDeal(input: z.input<typeof dealIdSchema>): Promise<ActionResult<DealDbRow>> {
  return asOwner(dealIdSchema, input, (db, d) => w.pauseDeal(db, d.id));
}

export async function resumeDeal(input: z.input<typeof dealIdSchema>): Promise<ActionResult<DealDbRow>> {
  return asOwner(dealIdSchema, input, (db, d) => w.resumeDeal(db, d.id));
}

/** End a deal on `endDate` (default: today in the owner's zone). */
export async function endDeal(input: z.input<typeof endDealSchema>): Promise<ActionResult<DealDbRow>> {
  return asOwner(endDealSchema, input, (db, d) => w.endDeal(db, d));
}

/**
 * Delete a deal with its accounts, posts, readings, day targets and matched payments. Its logo goes
 * to the trash for 30 days (undo puts it back). `activityId` undoes it.
 */
export async function deleteDeal(input: z.input<typeof dealIdSchema>): Promise<WithActivity<ActionResult<{ id: string }>>> {
  let used: w.Db | undefined;
  const result = await asOwner(dealIdSchema, input, async (db, d) => {
    used = db;
    const { data: deal } = await db.from("deals").select("logo_path").eq("id", d.id).maybeSingle();
    const r = await w.deleteDeal(db, d.id);
    const logo = (deal as { logo_path: string | null } | null)?.logo_path;
    const activityId = activityIdOf(db);
    if (r.ok && logo && activityId && !(await logoInUse(db, logo))) await trashFile(db, "deal-logos", logo, activityId);
    return r;
  });
  return withActivity(result, used);
}

// Posts

/** Add a post by URL (upsert on the normalized URL). Rates are snapshotted from the deal. */
export async function addPost(
  input: z.input<typeof addPostSchema>,
): Promise<ActionResult<{ post: w.PostDbRow; created: boolean }>> {
  return asOwner(addPostSchema, input, w.addPost);
}

/** Edit a post: URL, platform, account, time, group, title, deal, manual price. */
export async function editPost(input: z.input<typeof editPostSchema>): Promise<ActionResult<w.PostDbRow>> {
  return asOwner(editPostSchema, input, w.editPost);
}

/** Exclude a video from pay: it pays $0 and does not count toward the posting target. */
export async function excludePost(input: z.input<typeof postIdSchema>): Promise<ActionResult<w.PostDbRow>> {
  return asOwner(postIdSchema, input, (db, d) => w.setExcluded(db, d.id, true));
}

export async function unexcludePost(input: z.input<typeof postIdSchema>): Promise<ActionResult<w.PostDbRow>> {
  return asOwner(postIdSchema, input, (db, d) => w.setExcluded(db, d.id, false));
}

export async function deletePost(input: z.input<typeof postIdSchema>): Promise<WithActivity<ActionResult<{ id: string }>>> {
  let used: w.Db | undefined;
  const result = await asOwner(postIdSchema, input, (db, d) => ((used = db), w.deletePost(db, d.id)));
  return withActivity(result, used);
}

/** Link posts of one deal as one video, paid once on its best platform. Returns what moved. */
export async function linkPosts(input: z.input<typeof linkPostsSchema>): Promise<WithActivity<ActionResult<w.LinkActivity>>> {
  let used: w.Db | undefined;
  const result = await asOwner(linkPostsSchema, input, (db, d) => ((used = db), w.linkPosts(db, d)));
  return withActivity(result, used);
}

/** Take a post out of its video; it pays on its own and is never linked again automatically. */
export async function unlinkPost(input: z.input<typeof unlinkPostSchema>): Promise<WithActivity<ActionResult<w.LinkActivity>>> {
  let used: w.Db | undefined;
  const result = await asOwner(unlinkPostSchema, input, (db, d) => ((used = db), w.unlinkPost(db, d)));
  return withActivity(result, used);
}

// Views

/**
 * Record view readings, one per post per day. A lower count is rejected unless
 * `force`; a jump over 10x is held for review (send it again with `force` to accept).
 */
export async function setViews(
  input: z.input<typeof setViewsSchema>,
): Promise<ActionResult<{ day: string; items: w.SetViewsItemResult[] }>> {
  return asOwner(setViewsSchema, input, (db, d) => w.setViews(db, d, "hydra"));
}

// Day targets and payments

/** Override one day's posting target (0 = a day off); null removes the override. */
export async function setDayTarget(
  input: z.input<typeof setDayTargetSchema>,
): Promise<ActionResult<{ dealId: string; day: string; target: number | null }>> {
  return asOwner(setDayTargetSchema, input, w.setDayTarget);
}

/** Match a bank deposit to a deal. One deposit links to one deal. */
export async function matchPayment(
  input: z.input<typeof matchPaymentSchema>,
): Promise<ActionResult<w.DealPaymentRow>> {
  return asOwner(matchPaymentSchema, input, w.matchPayment);
}

/** Confirm a suggested payout: matches the deposit at its own amount and day (Paid and Owed update). */
export async function confirmPayoutMatch(
  input: z.input<typeof payoutPairSchema>,
): Promise<ActionResult<w.DealPaymentRow>> {
  return asOwner(payoutPairSchema, input, w.confirmPayoutMatch);
}

/** "Not this": never suggest this deposit for this deal again. */
export async function rejectPayoutMatch(
  input: z.input<typeof payoutPairSchema>,
): Promise<ActionResult<{ dealId: string; transactionId: string }>> {
  return asOwner(payoutPairSchema, input, w.rejectPayoutMatch);
}

/** Undo "Not this". */
export async function undoRejectPayoutMatch(
  input: z.input<typeof payoutPairSchema>,
): Promise<ActionResult<{ dealId: string; transactionId: string }>> {
  return asOwner(payoutPairSchema, input, w.undoRejectPayoutMatch);
}

/** Forget a rule answer: a kept rule stops applying; a turned-down one can be offered again. `activityId` undoes it. */
export async function removePayoutRule(
  input: z.input<typeof payoutRuleKeySchema>,
): Promise<WithActivity<ActionResult<{ dealId: string; payerKey: string }>>> {
  let used: w.Db | undefined;
  const result = await asOwner(payoutRuleKeySchema, input, (db, d) => ((used = db), w.removePayoutRule(db, d)));
  return withActivity(result, used);
}

/** Keep ("accepted") or turn down ("declined") a learned payout rule. */
export async function decidePayoutRule(
  input: z.input<typeof decidePayoutRuleSchema>,
): Promise<ActionResult<w.PayoutRuleRow>> {
  return asOwner(decidePayoutRuleSchema, input, w.decidePayoutRule);
}

/** Unlink a deposit from its deal (deletes the deal payment). `activityId` undoes it. */
export async function unmatchPayment(
  input: z.input<typeof unmatchPaymentSchema>,
): Promise<WithActivity<ActionResult<{ transactionId: string }>>> {
  let used: w.Db | undefined;
  const result = await asOwner(unmatchPaymentSchema, input, (db, d) => ((used = db), w.unmatchPayment(db, d.transactionId)));
  return withActivity(result, used);
}
