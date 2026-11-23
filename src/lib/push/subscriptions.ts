import { z } from "zod";
import type { ActionResult } from "@/lib/bank/actions";
import { NotOwnerError, requireOwner } from "@/lib/bank/server";
import { MissingEnvError } from "@/lib/supabase/env";
import { pushEnv } from "./env";

/** The owner's own push subscriptions, as typed actions the routes call. RLS limits every query to the owner. */

const subscription = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
});
const endpointOnly = z.object({ endpoint: z.string().min(1).max(2048) });

async function act<T>(run: (owner: Awaited<ReturnType<typeof requireOwner>>) => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run(await requireOwner()) };
  } catch (error) {
    if (error instanceof NotOwnerError) return { ok: false, error: { code: "not_owner", message: "Sign in as the owner" } };
    if (error instanceof MissingEnvError) return { ok: false, error: { code: "not_configured", message: error.message } };
    console.error(`[push] ${(error as Error).message}`);
    return { ok: false, error: { code: "internal", message: "Something went wrong" } };
  }
}

const invalid = (message: string): ActionResult<never> => ({ ok: false, error: { code: "invalid_input", message } });

/** The public half of the VAPID key: the browser needs it to subscribe. */
export const getPublicKey = () => act(async () => ({ publicKey: pushEnv().publicKey }));

export async function saveSubscription(input: unknown, userAgent: string | null): Promise<ActionResult<{ saved: true }>> {
  const parsed = subscription.safeParse(input);
  if (!parsed.success) return invalid(z.prettifyError(parsed.error));
  const { endpoint, keys } = parsed.data;
  return act(async ({ db, userId }) => {
    const { error } = await db
      .from("push_subscriptions")
      .upsert(
        { user_id: userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, user_agent: userAgent?.slice(0, 512) ?? null },
        { onConflict: "endpoint" },
      );
    if (error) throw new Error(`save subscription: ${error.message}`);
    return { saved: true as const };
  });
}

export async function removeSubscription(input: unknown): Promise<ActionResult<{ removed: true }>> {
  const parsed = endpointOnly.safeParse(input);
  if (!parsed.success) return invalid(z.prettifyError(parsed.error));
  return act(async ({ db }) => {
    const { error } = await db.from("push_subscriptions").delete().eq("endpoint", parsed.data.endpoint);
    if (error) throw new Error(`remove subscription: ${error.message}`);
    return { removed: true as const };
  });
}
