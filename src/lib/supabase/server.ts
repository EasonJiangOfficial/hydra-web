import { createServerClient as createSsrServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { activityHeaders, tagClient } from "@/lib/activity/request";
import { publicEnv } from "./env";

/**
 * Server Components, Server Functions and Route Handlers. Acts as the signed-in user (RLS applies).
 * Every client carries its own activity id: its writes are one entry in Activity (read it back with
 * `activityIdOf` from `@/lib/activity/request`).
 */
export async function createServerClient() {
  // Cookies first: during a build's prerender this marks the caller as per-request (nothing is
  // prerendered with a session), before the env read can throw where no env is set (Preview).
  const store = await cookies();
  // The auth client reads the clock (Date.now in __loadSession) as soon as it exists. Without a request-time
  // access first, a prerender that can read cookies (runtime prefetch, dev's staged render) stops with
  // "encountered the unstable value Date.now()". connection() moves everything below to request time.
  await connection();
  const { url, publishableKey } = publicEnv();
  const { id, headers } = activityHeaders("you");
  const client = createSsrServerClient(url, publishableKey, {
    global: { headers },
    cookies: {
      getAll: () => store.getAll(),
      setAll(toSet) {
        try {
          toSet.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Called from a Server Component: cookies are read-only there. The proxy refreshes them.
        }
      },
    },
  });
  return tagClient(client, id);
}
