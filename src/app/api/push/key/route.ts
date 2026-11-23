import { getPublicKey } from "@/lib/push/subscriptions";
import { respond } from "../../plaid/respond";

/** GET the VAPID public key the browser subscribes with. Owner only. 503 until the server has VAPID keys. */
export async function GET() {
  return respond(await getPublicKey());
}
