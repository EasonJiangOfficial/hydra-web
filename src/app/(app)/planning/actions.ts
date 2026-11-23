"use server";

import { z } from "zod";

import { keepPendingDelete } from "@/lib/google/calendar";
import { isTimeZone } from "@/lib/planning/dates";
import { METRIC_KEYS } from "@/lib/planning/metrics";
import { ownerCtx } from "@/lib/planning/server";
import { createLiveSource } from "@/lib/planning-metrics/live-source";
import type { MetricRequest } from "@/lib/planning-metrics/remote";
import { createResolvers } from "@/lib/planning-metrics/resolvers";

const day = z.iso.date();
const requestSchema = z.object({
  key: z.enum(METRIC_KEYS),
  param: z.string().max(200).nullable(),
  window: z.object({ from: day, to: day }),
  today: day,
  timeZone: z.string().refine(isTimeZone),
});

/**
 * One metric reading for the goals strip, as the signed-in owner. The browser asks through the remote
 * registry (src/lib/planning-metrics/remote.ts), which caches. Anything wrong answers null: a goal bar
 * shows "-" rather than breaking the page.
 */
export async function resolveMetric(request: MetricRequest): Promise<number | null> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success || parsed.data.key === "task_progress") return null;
  const { key, param, window, today, timeZone } = parsed.data;
  const { db, now } = await ownerCtx();
  const resolver = createResolvers(createLiveSource(db, now()))[key];
  return resolver ? resolver(param, { goalId: "", window, today, timeZone, tasks: [], statuses: [] }) : null;
}

/**
 * The owner's Keep on an item deleted in Google Calendar: the item stays and goes back on the Hydra
 * calendar. Delete needs no action here: it is the page's normal task or event delete (asked
 * first), which also clears the Google link.
 */
export async function keepGoogleItem(linkId: string): Promise<boolean> {
  if (!z.uuid().safeParse(linkId).success) return false;
  await ownerCtx();
  const r = await keepPendingDelete(linkId);
  // Without Google nothing went back on the calendar: a refusal the strip shows, never a success.
  return r.ok && r.data !== "not_connected";
}
