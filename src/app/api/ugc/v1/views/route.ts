import { restTool } from "../tools";

/** POST: ugc_set_views. Bearer `ugc:write` key. Per-item outcome: written, held, rejected_lower, rejected_frozen, not_found. */
export const POST = restTool("ugc_set_views");
