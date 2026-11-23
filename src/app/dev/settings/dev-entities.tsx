"use client";

import { useSyncExternalStore, type ReactNode } from "react";

import { ScopeEntitiesProvider } from "@/components/shell/scope";
import { SEEDED_ENTITIES, type Entity } from "@/lib/entities/model";

/** Businesses added on /dev/settings, kept for this tab so /dev/reports' switch shows them too. */
export const DEV_BUSINESSES_KEY = "hydra-dev-businesses";

/** `?added=on` on a fixture page: a business added in Settings, for captures. */
export const STUDIO: Entity = { id: "e7000000-0000-4000-8000-000000000001", slug: "studio-co", name: "Studio Co", kind: "business", taxShape: "sole_prop", status: "active", closedOn: null };

export function readDevBusinesses(): Entity[] {
  try {
    const raw = window.sessionStorage.getItem(DEV_BUSINESSES_KEY);
    return raw ? (JSON.parse(raw) as Entity[]) : [];
  } catch {
    return [];
  }
}

export function writeDevBusinesses(list: Entity[]) {
  try {
    window.sessionStorage.setItem(DEV_BUSINESSES_KEY, JSON.stringify(list));
  } catch {
    // Private mode: the other fixture pages just do not see the new business.
  }
}

/** The scope switch's list on a fixture page: the seeded entities plus the businesses added on /dev/settings. */
export function DevScopeEntities({ children }: { children: ReactNode }) {
  // Read once on the client after hydration (the server renders the seeded list).
  const entities = useSyncExternalStore(noop, clientEntities, () => SEEDED_ENTITIES);
  return <ScopeEntitiesProvider entities={entities}>{children}</ScopeEntitiesProvider>;
}

const noop = () => () => {};
let cached: readonly Entity[] = SEEDED_ENTITIES;
let cacheKey = "";
function clientEntities(): readonly Entity[] {
  let raw = "";
  try {
    raw = window.sessionStorage.getItem(DEV_BUSINESSES_KEY) ?? "";
  } catch {}
  const key = `${window.location.search}|${raw}`;
  if (key === cacheKey) return cached;
  cacheKey = key;
  const added = new URLSearchParams(window.location.search).get("added") === "on" ? [STUDIO] : [];
  const stored = readDevBusinesses().filter((e) => !SEEDED_ENTITIES.some((s) => s.id === e.id));
  cached = added.length || stored.length ? [...SEEDED_ENTITIES, ...added, ...stored] : SEEDED_ENTITIES;
  return cached;
}
