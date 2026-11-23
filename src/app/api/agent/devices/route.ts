import { json, ownerSession } from "@/lib/agent/caller";

/** GET /api/agent/devices: paired devices (owner session only; a device cannot list devices). */
export async function GET() {
  const db = await ownerSession();
  if (!db) return json({ error: "unauthorized" }, 401);
  const { data, error } = await db
    .from("agent_devices")
    .select("id, name, scopes, role, last_seen_at, relay_seen_at, revoked_at, created_at")
    .order("created_at", { ascending: false });
  if (error) return json({ error: "internal" }, 500);
  return json({ devices: data });
}
