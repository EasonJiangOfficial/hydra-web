import { z } from "zod";
import { json, readJson } from "@/lib/agent/caller";
import { clientIp, DEVICE_ROLES, exchangePairingCode, pairingCodeRole, RATE_LIMITS, rateHit, rateLimited } from "@/lib/agent/devices";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/agent/devices/exchange {code, name, role?}: the device trades a one-time pairing code for
 * its key. No session (the device has none); the code is the proof. The key is in this reply only.
 * Rate limited per IP and in total, so a code cannot be guessed by brute force.
 *
 * role (optional) is what the device is: Hydra Desktop sends "mac", hydra-brain sends "brain". A code
 * made for the other role is refused unused (409 wrong_role, with the code's role), so a Server code
 * pasted into the Mac app never turns that Mac into the brain. The device never picks its role: only
 * the code's role counts. The reply carries it: {deviceId, key, role}.
 */
const bodySchema = z.object({
  code: z.string().trim().min(6).max(20),
  name: z.string().trim().min(1).max(80).default("Hydra Desktop"),
  role: z.enum(DEVICE_ROLES).optional(),
});

export async function POST(request: Request) {
  // Shape first: a malformed body can never be a guess, so it costs no DB call. Only well-formed
  // attempts count against the limit; if the limiter cannot run, rateHit throws (fails closed, 5xx).
  const body = bodySchema.safeParse(await readJson(request));
  if (!body.success) return json({ error: "invalid_input" }, 400);
  const admin = createAdminClient();
  const wait = Math.max(
    await rateHit(admin, `pair:ip:${clientIp(request)}`, RATE_LIMITS.pairPerIp),
    await rateHit(admin, "pair:all", RATE_LIMITS.pairAll),
  );
  if (wait) return rateLimited(wait);
  const role = await pairingCodeRole(admin, body.data.code);
  if (!role) return json({ error: "invalid_code" }, 400);
  if (body.data.role && body.data.role !== role) return json({ error: "wrong_role", role }, 409);
  const paired = await exchangePairingCode(admin, body.data.code, body.data.name);
  if (!paired) return json({ error: "invalid_code" }, 400);
  return json({ ...paired, role }, 201);
}
