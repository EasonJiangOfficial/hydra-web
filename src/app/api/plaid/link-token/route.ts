import { createLinkToken, startUpdateMode } from "@/lib/bank/actions";
import { readJson, respond } from "../respond";

/** POST {} for a new bank login, or {"itemId": "..."} for update mode (repair a login). Owner only. */
export async function POST(request: Request) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const itemId = body && typeof body === "object" && "itemId" in body ? (body as { itemId: unknown }).itemId : undefined;
  return respond(itemId === undefined ? await createLinkToken() : await startUpdateMode({ itemId: itemId as string }));
}
