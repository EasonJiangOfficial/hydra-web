import { restTool } from "../tools";

/** POST: ugc_add_post. Bearer `ugc:write` key. */
export const POST = restTool("ugc_add_post");

/** GET (?needsViews=1): ugc_posts_needing_views, today's work list. The only post listing. */
export const GET = restTool("ugc_posts_needing_views");
