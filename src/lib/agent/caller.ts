import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { MissingEnvError } from "@/lib/supabase/env";
import { createServerClient } from "@/lib/supabase/server";
import { forwardAsOwner } from "./bridge";
import { authDevice, bearer, RATE_LIMITS, rateHit, rateLimited, type Device, type DeviceScope } from "./devices";
import type { Surface } from "./events";
import type { ToolCtx, ToolGroup } from "./registry";
import type { AgentStore } from "./store";

/**
 * Who is calling an agent route. The owner's session runs the handler. A paired device (Bearer key
 * with the scope the route needs) is forwarded through the owner-session bridge, so the handler
 * always runs as the owner with RLS. Anyone else: 401.
 */

export interface OwnerCaller {
  db: SupabaseClient;
  /** Set when a paired device made the call (through the bridge): a label, not an authority. */
  deviceId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in owner's client, or null. */
export async function ownerSession(): Promise<SupabaseClient | null> {
  const db = await createServerClient();
  const { data, error } = await db.rpc("is_owner");
  return !error && data === true ? db : null;
}

export const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function asOwner(
  request: Request,
  scope: DeviceScope | null,
  handler: (caller: OwnerCaller) => Promise<Response>,
): Promise<Response> {
  try {
    const db = await ownerSession();
    if (db) {
      const label = request.headers.get("x-hydra-device");
      return await handler({ db, deviceId: label && UUID.test(label) ? label : null });
    }
    const key = bearer(request);
    if (!key || !scope) return json({ error: "unauthorized" }, 401);
    const admin = createAdminClient();
    const device = await authDevice(admin, key);
    if (!device) return json({ error: "unauthorized" }, 401);
    if (!device.scopes.includes(scope)) return json({ error: "forbidden" }, 403);
    const turn = new URL(request.url).pathname.endsWith("/turn");
    const wait = await rateHit(admin, `device:${device.id}:${turn ? "turn" : "any"}`, turn ? RATE_LIMITS.deviceTurn : RATE_LIMITS.deviceOther);
    if (wait) return rateLimited(wait);
    return await forwardAsOwner(request, device.id);
  } catch (error) {
    if (error instanceof MissingEnvError) return json({ error: "not_configured" }, 503);
    throw error;
  }
}

/**
 * A paired device calling as itself (the relay, the voice): its key with `scope`, rate limited per
 * device and scope, then `handler` with the device and the service role client. No owner session:
 * the handler touches only what that device may. Moves the device's last_seen_at (agent_device_auth).
 */
export async function asDevice(
  request: Request,
  scope: DeviceScope,
  limit: number,
  handler: (device: Device, admin: SupabaseClient) => Promise<Response>,
): Promise<Response> {
  try {
    const key = bearer(request);
    if (!key) return json({ error: "unauthorized" }, 401);
    const admin = createAdminClient();
    const device = await authDevice(admin, key);
    if (!device) return json({ error: "unauthorized" }, 401);
    if (!device.scopes.includes(scope)) return json({ error: "forbidden" }, 403);
    const wait = await rateHit(admin, `device:${device.id}:${scope}`, limit);
    if (wait) return rateLimited(wait);
    return await handler(device, admin);
  } catch (error) {
    if (error instanceof MissingEnvError) return json({ error: "not_configured" }, 503);
    throw error;
  }
}

/** The JSON body, or null when it is not JSON (a cross-site form post cannot send application/json). */
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** The tool context for an owner request. */
export function ownerToolCtx(
  caller: OwnerCaller,
  store: AgentStore,
  init: { surface: Surface; allowed: ReadonlySet<ToolGroup>; runId?: string | null; threadId?: string | null },
): ToolCtx {
  return {
    store,
    db: caller.db,
    surface: init.surface,
    threadId: init.threadId ?? null,
    runId: init.runId ?? null,
    deviceId: caller.deviceId,
    unattended: false,
    allowed: init.allowed,
    now: () => new Date(),
    timeZone: () => store.timeZone(),
    ui: () => {},
  };
}
