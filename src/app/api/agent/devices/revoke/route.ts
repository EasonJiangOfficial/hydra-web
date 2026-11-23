import { z } from "zod";
import { json, ownerSession, readJson } from "@/lib/agent/caller";

/** POST /api/agent/devices/revoke {id}: the device key stops working at once. Owner session only. */
const bodySchema = z.object({ id: z.uuid() });

export async function POST(request: Request) {
  const db = await ownerSession();
  if (!db) return json({ error: "unauthorized" }, 401);
  const body = bodySchema.safeParse(await readJson(request));
  if (!body.success) return json({ error: "invalid_input" }, 400);
  const { data, error } = await db
    .from("agent_devices")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", body.data.id)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (error) return json({ error: "internal" }, 500);
  return data ? json({ ok: true }) : json({ error: "not_found" }, 404);
}
