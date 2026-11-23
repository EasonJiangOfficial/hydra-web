import type { ActionResult } from "@/lib/bank/actions";

/** Shared by the Plaid routes (not a route: Next only serves route.ts). */

const STATUS: Record<string, number> = {
  invalid_input: 400,
  not_owner: 403,
  not_found: 404,
  duplicate_institution: 409,
  not_configured: 503,
  internal: 500,
};

export function respond<T>(result: ActionResult<T>): Response {
  // Codes not listed are the bank provider's own (ITEM_LOGIN_REQUIRED and so on).
  return Response.json(result, { status: result.ok ? 200 : (STATUS[result.error.code] ?? 502) });
}

/**
 * The JSON body, or a 4xx Response. Requiring application/json makes a cross-site form post
 * (which cannot set that type without a CORS preflight) fail before it reaches an action.
 */
export async function readJson(request: Request): Promise<unknown> {
  const bad = (status: number, message: string) => Response.json({ ok: false, error: { code: "invalid_input", message } }, { status });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return bad(415, "Send JSON");
  try {
    const text = await request.text();
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return bad(400, "Body is not JSON");
  }
}
