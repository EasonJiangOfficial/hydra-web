import type { ReactNode } from "react";
import { UndoHost } from "@/components/activity/undo-bar";
import { AppShell } from "@/components/shell/app-shell";
import { NavProgress } from "@/components/shell/nav-progress";
import { ScopeEntitiesProvider } from "@/components/shell/scope";
import { SEEDED_ENTITIES, type Entity } from "@/lib/entities/model";
import { listEntities } from "@/lib/entities/queries";
import { createServerClient } from "@/lib/supabase/server";
import { IdleGate, type IdleLimit } from "./idle-gate";

/**
 * The shell mounts once here, so the sidebar stays still while pages change.
 * No idle lock by default: the session stays until sign-out (owner, 2026-11-21). When the owner sets
 * settings.idle_lock_minutes (Settings > General), IdleLock wraps the app; it applies from the next load.
 * The scope switch's entity list goes down the same way, as an un-awaited promise.
 * The settings read uses the session cookie, so it goes to IdleGate as an un-awaited promise: the shell and
 * each page's loading.tsx stay in the static shell (cacheComponents), and only the lock waits.
 *
 * Page changes: NavProgress runs a thin bar from the click until the new page shows. The route skeleton
 * (loading.tsx, marked data-route-loading) shows at full strength on the click, and the page that replaces it
 * simply takes its place, as UGM's do: SkeletonShown marks the template, so its title never dips. Only a page that
 * shows with no skeleton (one the router already holds) fades its top blocks in over 200 ms.
 * `:where` keeps this at zero specificity: a block with its own animation keeps it.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <IdleGate minutes={idleLockMinutes()}>
      <ScopeEntitiesProvider entities={scopeEntities()}>
        <AppShell>
          <NavProgress />
          <div className="contents motion-safe:[:where(&>div:not([data-skeleton-shown])>*:not([data-route-loading]))]:animate-hy-fade">{children}</div>
        </AppShell>
      </ScopeEntitiesProvider>
      <UndoHost />
    </IdleGate>
  );
}

/** Personal and every business for the scope switch. A failed read falls back to Personal and UGC. */
async function scopeEntities(): Promise<Entity[]> {
  try {
    return await listEntities(await createServerClient());
  } catch {
    return [...SEEDED_ENTITIES];
  }
}

/**
 * settings.idle_lock_minutes: a number (on), null (off: the read worked and no limit is set), or
 * "unknown" when the read failed. Unknown never turns the lock off: IdleGate keeps the limit it stored.
 */
async function idleLockMinutes(): Promise<IdleLimit> {
  try {
    const db = await createServerClient();
    const { data, error } = await db.from("settings").select("idle_lock_minutes").maybeSingle();
    if (error) return "unknown";
    const minutes = data?.idle_lock_minutes;
    return typeof minutes === "number" && minutes > 0 ? minutes : null;
  } catch {
    return "unknown";
  }
}
