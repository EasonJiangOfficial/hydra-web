import { restTool } from "../tools";

/** GET: ugc_context (deals, accounts, server time, missed view days). Bearer `ugc:write` key. */
export const GET = restTool("ugc_context");
