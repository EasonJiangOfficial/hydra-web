/** Pure auth-gate rules shared by the proxy and the login page. */

// /dev/** fixtures are public here; src/app/dev/layout.tsx 404s them in production.
const PUBLIC_ROOTS = ["/login", "/auth", "/dev"];

/**
 * Machine-called API routes that enforce their own auth, so the proxy never sends them to /login
 * (the handler answers 401 itself). Each root is a whole path segment: /api/agent-x stays gated.
 */
const SELF_AUTH_ROOTS = [
  "/api/ugc/v1", // Grokbot REST: bearer ugc:write key
  "/api/mcp/ugc", // Grokbot MCP: bearer ugc:write key
  "/api/agent", // owner session or paired device key (scope agent); devices/exchange: one-time pairing code
  "/api/mcp/agent", // paired device key (scope mcp)
  "/api/cron/agent", // Bearer CRON_SECRET
  "/api/cron/bank", // Bearer CRON_SECRET: daily bank sync sweep, rules, pairing, recurring
  "/api/cron/planning", // Bearer CRON_SECRET: daily repeat-series extension
  "/api/google/cron", // Bearer CRON_SECRET
  "/api/google/calendar/webhook", // Google channel token
  "/api/instagram/cron", // Bearer CRON_SECRET: daily Instagram sync
  "/api/plaid/webhook", // Plaid-Verification JWT
  "/api/voice/tts", // owner session or paired device key (scope agent): Hydra Desktop speaks with the server's voice key
];

const under = (roots: string[], pathname: string) => roots.some((p) => pathname === p || pathname.startsWith(`${p}/`));

export function isPublicPath(pathname: string): boolean {
  return under(PUBLIC_ROOTS, pathname);
}

export function isSelfAuthPath(pathname: string): boolean {
  return under(SELF_AUTH_ROOTS, pathname);
}

export function isOwnerEmail(email: unknown, owner: string): boolean {
  return typeof email === "string" && owner.length > 0 && email.trim().toLowerCase() === owner.trim().toLowerCase();
}

const ORIGIN = "http://hydra.invalid";

/**
 * Keep `next` same-origin: a path only, never a scheme, host, `//`, or a trip back to /login.
 * Checks the PARSED result: the URL parser drops tabs and newlines and resolves `.` and `..`,
 * so `/.//evil.com` becomes `//evil.com`, which the browser would read as a host.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(raw, ORIGIN);
  } catch {
    return "/";
  }
  const { pathname } = url;
  if (url.origin !== ORIGIN || pathname.startsWith("//") || pathname.includes("\\") || isPublicPath(pathname)) {
    return "/";
  }
  return `${pathname}${url.search}${url.hash}`;
}

/**
 * Old links to a page that moved, with their other params: Accounts > Connections is Settings > Connections
 * (owner, 2026-11-22). null = not moved.
 */
export function movedPath(pathname: string, search = ""): string | null {
  const q = new URLSearchParams(search);
  return pathname === "/accounts" && q.get("tab") === "connections" ? `/settings?${q}` : null;
}

export function loginPath(pathname: string, search = ""): string {
  return `/login?next=${encodeURIComponent(safeNext(`${pathname}${search}`))}`;
}

/**
 * Where a signed-in owner who opens /login goes instead: `next` (same-origin) or the Dashboard.
 * null = render the login page: not the owner, the add-a-passkey step after an email link, or an error.
 */
export function signedInLoginRedirect(search: URLSearchParams, isOwner: boolean): string | null {
  if (!isOwner || search.get("step") === "passkey" || search.has("error")) return null;
  return safeNext(search.get("next"));
}
