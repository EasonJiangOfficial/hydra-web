/**
 * The activity id a Supabase client writes under. createServerClient sends a fresh
 * `x-hydra-activity` uuid (and `x-hydra-actor: you`) on every client it makes; the database groups
 * every write that client makes into that one activity (0130_activity.sql). A server action reads
 * the id back with `activityIdOf(db)` and returns it, so the page can offer Undo.
 *
 * Keyed by the client object, not a request store: React's `cache()` is not scoped inside a
 * Server Function, and an action may make more than one client.
 */

export const ACTIVITY_HEADER = "x-hydra-activity";
export const ACTOR_HEADER = "x-hydra-actor";

const ids = new WeakMap<object, string>();

/** Headers for a new client, with its activity id. */
export function activityHeaders(actor: "you" | "hydra" | "routine" = "you"): { id: string; headers: Record<string, string> } {
  const id = crypto.randomUUID();
  return { id, headers: { [ACTIVITY_HEADER]: id, [ACTOR_HEADER]: actor } };
}

/** Remember which activity this client writes under. Returns the client. */
export function tagClient<T extends object>(client: T, id: string): T {
  ids.set(client, id);
  return client;
}

/** The activity id this client's writes are logged under, or null for a client not made by createServerClient. */
export function activityIdOf(client: object): string | null {
  return ids.get(client) ?? null;
}

/** A delete action's result: on success, `activityId` undoes it (undoActivity). */
export type WithActivity<R> = R & { activityId?: string | null };

/** Add the client's activity id to a successful result. */
export function withActivity<R extends { ok: boolean }>(result: R, client: object | null | undefined): WithActivity<R> {
  return result.ok && client ? { ...result, activityId: activityIdOf(client) } : result;
}
