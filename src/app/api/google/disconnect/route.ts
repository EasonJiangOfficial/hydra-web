import { run } from "@/lib/google/client";
import { disconnect } from "@/lib/google/oauth";
import { fail, ownerOnly } from "../respond";

/**
 * POST {}: forget the Google sign-in (revoke at Google, delete the tokens and sync state).
 * Requiring application/json makes a cross-site form post fail before it reaches the owner check.
 */
export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return fail(415, "invalid_input", "Send JSON");
  const denied = await ownerOnly();
  if (denied) return denied;
  const result = await run(disconnect);
  return Response.json(result, { status: result.ok ? 200 : 500 });
}
