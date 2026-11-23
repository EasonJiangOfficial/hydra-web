import { z } from "zod";
import { asOwner, json, ownerToolCtx, readJson } from "@/lib/agent/caller";
import { liveChannels } from "@/lib/agent/channels";
import { LIVE_GROUPS } from "@/lib/agent/config";
import { settleRun } from "@/lib/agent/cron";
import { supabaseStore } from "@/lib/agent/store";
import { executeTool } from "@/lib/agent/tools";

/**
 * POST /api/agent/confirm {id, approve}: the owner's answer to a confirm (a tap, or a spoken "yes"
 * the client maps to approve). A live turn that waits on it resumes; a routine's approval runs its
 * step now; an MCP approval lets the device call again with the approval id.
 *
 * Who may say yes: the owner's own session, always. A paired device only to a live confirm of a
 * turn it started (the owner's voice on that device). A device never approves an MCP call (it
 * raised that gate itself) or a routine's step: those wait for the owner in the app. Anyone may
 * say no. A confirm whose time ran out answers 409 with status "expired".
 */
const bodySchema = z.object({ id: z.uuid(), approve: z.boolean() });

export async function POST(request: Request) {
  return asOwner(request, "agent", async (caller) => {
    const body = bodySchema.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid_input" }, 400);
    const store = supabaseStore(caller.db);
    const { id, approve } = body.data;
    const row = await store.getApproval(id);
    if (!row) return json({ error: "not_found" }, 404);
    if (approve && caller.deviceId && (row.source !== "live" || row.device_id !== caller.deviceId)) {
      return json({ error: "owner_only", message: "Approve this in Hydra." }, 403);
    }
    const moved = await store.moveApproval(id, ["pending"], approve ? "approved" : "declined");
    if (!moved) {
      const expired = row.status === "expired" || (row.status === "pending" && row.expires_at <= new Date().toISOString());
      return json({ error: "not_pending", status: expired ? "expired" : row.status }, 409);
    }
    if (!approve || moved.source !== "routine") {
      if (moved.run_id) await settleRun(store, moved.run_id, liveChannels());
      return json({ ok: true, status: moved.status });
    }

    // An unattended routine left this step: run it now, as part of its run.
    const ctx = ownerToolCtx(caller, store, { surface: "routine", allowed: LIVE_GROUPS, runId: moved.run_id, threadId: moved.thread_id });
    const res = await executeTool(moved.tool, moved.input, ctx, { approved: true, approvalId: moved.id });
    const ok = res.status === "ok";
    await store.moveApproval(id, ["approved"], ok ? "done" : "failed", {
      result: ok ? (res.data ?? null) : { error: res.status === "confirm" ? res.gate.summary : res.message },
      action_id: ok ? res.actionId : null,
    });
    if (moved.run_id) await settleRun(store, moved.run_id, liveChannels());
    return ok
      ? json({ ok: true, status: "done", summary: res.summary, actionId: res.actionId })
      : json({ ok: false, status: "failed", message: res.status === "confirm" ? res.gate.summary : res.message }, 422);
  });
}
