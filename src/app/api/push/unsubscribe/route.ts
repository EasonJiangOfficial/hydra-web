import { removeSubscription } from "@/lib/push/subscriptions";
import { readJson, respond } from "../../plaid/respond";

/** POST {endpoint}: forget this browser. Owner only. */
export async function POST(request: Request) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  return respond(await removeSubscription(body));
}
