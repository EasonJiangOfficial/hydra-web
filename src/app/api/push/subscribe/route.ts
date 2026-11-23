import { saveSubscription } from "@/lib/push/subscriptions";
import { readJson, respond } from "../../plaid/respond";

/** POST a browser PushSubscription ({endpoint, keys: {p256dh, auth}}). Owner only. */
export async function POST(request: Request) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  return respond(await saveSubscription(body, request.headers.get("user-agent")));
}
