import type { ReactNode } from "react";
import { clearOfflineCache } from "@/components/pwa/register-sw";

/** Navigation data and the small vector marks the shell draws. Paths are copied from Sidebar.dc.html and Mobile.dc.html. */

export type NavItem = { label: string; href: string; icon: string };

/** Sidebar order is an owner decision (DESIGN.md section 2). Do not reorder. */
export const NAV: readonly NavItem[] = [
  { label: "Dashboard", href: "/", icon: "M3 8l6-5 6 5v7H3z" },
  { label: "Planning", href: "/planning", icon: "M3 4h12v11H3zM3 7h12M6 2v3m6-3v3" },
  { label: "Notes", href: "/notes", icon: "M4.5 2.5h6.5l3 3v10h-9.5zM11 2.5v3h3M7 9h5M7 12h3.5" },
  { label: "Routines", href: "/routines", icon: "M9 3a6 6 0 100 12A6 6 0 009 3zM9 6v3.2l2.2 1.3" },
  { label: "UGC Tracker", href: "/ugc", icon: "M3 4h12v10H3zM7.5 7v4l3.5-2z" },
  { label: "Personal Brand", href: "/brand", icon: "M3.5 3.5h11v11h-11zM9 6.6a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8zM12.2 5.8h.01" },
  { label: "Reports", href: "/reports", icon: "M3 15V3m0 12h12M6 12V9m3 3V6m3 6v-4" },
  { label: "Transactions", href: "/transactions", icon: "M3 6h11l-3-3M15 12H4l3 3" },
  { label: "Taxes", href: "/taxes", icon: "M5 2h8v14l-2-1.5L9 16l-2-1.5L5 16zM7.5 6h3m-3 3h3" },
  { label: "Accounts", href: "/accounts", icon: "M2 7l7-4 7 4M4 8v6m3.5-6v6m3.5-6v6m3-6v6M2 15h14" },
  { label: "Activity", href: "/activity", icon: "M3.6 6.5A6 6 0 113 9M3.2 3.5v3h3M9 6v3l2 1.5" },
  { label: "Settings", href: "/settings", icon: "M9 6.6a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8zM9 2v2.2m0 9.6V16M2 9h2.2m9.6 0H16M4 4l1.6 1.6m6.8 6.8L14 14M4 14l1.6-1.6m6.8-6.8L14 4" },
];

/** Phone bottom tabs: Dashboard, Planning, UGC and Reports under short names, then More (the rest, Notes first). */
const byHref = (href: string) => NAV.find((n) => n.href === href)!;
export const TABS: readonly NavItem[] = [
  { ...byHref("/"), label: "Home" },
  { ...byHref("/planning"), label: "Plan" },
  { ...byHref("/ugc"), label: "UGC" },
  { ...byHref("/reports"), label: "Reports" },
];
export const MORE: readonly NavItem[] = NAV.filter((n) => !TABS.some((t) => t.href === n.href));
export const MORE_ICON = "M4 9h.01M9 9h.01M14 9h.01";

export function isActive(href: string, pathname: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}

export function Icon({ d, size = 18, stroke = 1.4 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" className="flex-none">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Three linked rings, from design/logo/hydra-mark.svg. Stroke 5 on a 69.47 x 66 box. */
export function HydraMark() {
  return (
    <svg width="23.4" height="22.2" viewBox="0 0 69.47 66" aria-hidden="true" className="flex-none">
      <g fill="none" stroke="currentColor" strokeWidth="5">
        <circle cx="34.74" cy="21.71" r="19.21" />
        <circle cx="21.71" cy="44.29" r="19.21" />
        <circle cx="47.76" cy="44.29" r="19.21" />
      </g>
    </svg>
  );
}

/** The wordmark: system sans Regular 400, 21 px, -0.02em (board value; theme.css has no token for it). */
export function Wordmark({ className = "" }: { className?: string }) {
  return <span className={`text-wordmark ${className}`}>Hydra</span>;
}

/** Next.js "preventing flash" pattern: runs while the HTML parses, inert text on a client render. */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export const SIGN_OUT_ICON = "M7 3H3v12h4M11 5l4 4-4 4M15 9H7";

/**
 * Sign out: drops the offline page cache, then posts to /auth/signout (POST only, so a prefetch never signs out).
 * Used by the sidebar footer and the phone More sheet.
 */
export function SignOutForm({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <form
      method="post"
      action="/auth/signout"
      className={className}
      onSubmit={(e) => {
        const form = e.currentTarget;
        e.preventDefault();
        void clearOfflineCache()
          .catch(() => {})
          .finally(() => form.submit());
      }}
    >
      {children}
    </form>
  );
}
