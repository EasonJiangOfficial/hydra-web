import { exchangePublicToken } from "@/lib/bank/actions";
import { readJson, respond } from "../respond";

/** POST {"publicToken": "..."} from Plaid Link's onSuccess. Owner only. 409 = bank already linked. */
export async function POST(request: Request) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  return respond(await exchangePublicToken(body as { publicToken: string }));
}
