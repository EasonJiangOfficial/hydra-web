import { z } from "zod";
import { json, ownerSession, readJson } from "@/lib/agent/caller";
import { createPairingCode, DEVICE_ROLES, DEVICE_SCOPES } from "@/lib/agent/devices";

/**
 * POST /api/agent/devices/pair {name?, scopes?, role?}: a one-time pairing code (10 minutes) for Hydra
 * Desktop, Hydra's server (role "brain": the only way a device becomes the brain) or Claude Code.
 * Owner session only. The device trades it at /api/agent/devices/exchange.
 */
const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    scopes: z.array(z.enum(DEVICE_SCOPES)).min(1).max(DEVICE_SCOPES.length).optional(),
    role: z.enum(DEVICE_ROLES).optional(),
  })
  // The brain serves relay turns: it always holds the relay scope.
  .refine((b) => b.role !== "brain" || !b.scopes || b.scopes.includes("relay"));

export async function POST(request: Request) {
  const db = await ownerSession();
  if (!db) return json({ error: "unauthorized" }, 401);
  const body = bodySchema.safeParse((await readJson(request)) ?? {});
  if (!body.success) return json({ error: "invalid_input" }, 400);
  return json(await createPairingCode(db, body.data));
}
