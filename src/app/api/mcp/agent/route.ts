import { asOwner, ownerToolCtx } from "@/lib/agent/caller";
import { MCP_GROUPS } from "@/lib/agent/config";
import { handleMcp } from "@/lib/agent/mcp";
import { supabaseStore } from "@/lib/agent/store";

/**
 * /api/mcp/agent: the Hydra Agent's tools over MCP (streamable HTTP) for a paired device key
 * (scope "mcp"), forwarded through the owner-session bridge. Destructive tools need an approval id.
 */
export const maxDuration = 120;

async function serve(request: Request) {
  return asOwner(request, "mcp", async (caller) => {
    const store = supabaseStore(caller.db);
    return handleMcp(request, ownerToolCtx(caller, store, { surface: "mcp", allowed: MCP_GROUPS }));
  });
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
