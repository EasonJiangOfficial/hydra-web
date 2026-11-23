import type { NextConfig } from "next";

const dev = process.env.NODE_ENV === "development";

/** The browser talks to exactly one Supabase origin (REST + realtime websocket). Unset: the hosted wildcard. */
function supabaseOrigins() {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    return `${url.origin} ${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
  } catch {
    return "https://*.supabase.co wss://*.supabase.co";
  }
}

/** Images from Supabase Storage (signed deal-logo URLs): the same origin, no websocket. */
const supabaseHttp = () => supabaseOrigins().split(" ")[0];

// Plaid Link (Accounts, Connect a bank): its script and iframe load from cdn.plaid.com and it calls
// the Plaid API host (https://plaid.com/docs/link/web/#content-security-policy).
const PLAID_CDN = "https://cdn.plaid.com";
const PLAID_API = "https://production.plaid.com https://sandbox.plaid.com";

// Baseline CSP. A nonce-based strict CSP is owed in the Wave 3 security review (DESIGN.md section 11).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${PLAID_CDN}${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Instagram CDN: Personal Brand post thumbnails from the account media list (src/lib/brand/instagram-media.ts).
  `img-src 'self' data: blob: ${supabaseHttp()} https://*.cdninstagram.com https://*.fbcdn.net`,
  "font-src 'self'",
  // Hydra's Fish Audio voice plays each /api/voice/tts reply from a blob: URL (speaker.ts).
  "media-src 'self' blob:",
  `connect-src 'self' ${supabaseOrigins()} ${PLAID_API}${dev ? " ws://localhost:*" : ""}`,
  `frame-src ${PLAID_CDN}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  // Accounts file import (importFile) sends a CSV/OFX as text; the default action body cap is 1 MB.
  // Vercel Functions refuse request bodies over 4.5 MB before Next runs, so the cap stays under it;
  // the import UI allows files up to 3,500,000 bytes, leaving room for the string's JSON escaping.
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
