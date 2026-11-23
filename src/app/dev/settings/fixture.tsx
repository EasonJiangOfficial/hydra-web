"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useState, useSyncExternalStore } from "react";

import type { BusinessRow, SettingsActions, SettingsData } from "@/components/settings/types";
import { SettingsWorkspace } from "@/components/settings/settings-workspace";
import { avatarsClient } from "@/lib/agent/avatars-client";
import { getAgentSettings, modelKeysClient, patchAgentSettings } from "@/lib/agent/settings-client";
import { slugFor, type Entity, type TaxShape } from "@/lib/entities/model";

import { IDS, fixtureData } from "../accounts/fixture-data";
import { useMemoryAccounts } from "../accounts/memory-actions";
import { STUDIO, writeDevBusinesses } from "./dev-entities";

const ok = <T,>(data: T) => ({ ok: true as const, data, activityId: null });
const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message } });
const plain = ({ inUse, accounts, ...e }: BusinessRow): Entity => (void inUse, void accounts, e);

/** The fixture's businesses: Personal and UGC in use, UGM LLC closed with history. `?added=on` adds Studio Co (unused). */
function seed(withStudio: boolean, accounts: SettingsData["accounts"]): BusinessRow[] {
  const count = (id: string) => accounts.accounts.filter((a) => a.entity_id === id).length;
  const rows: BusinessRow[] = [
    { id: IDS.personal, slug: "personal", name: "Personal", kind: "personal", taxShape: null, status: "active", closedOn: null, inUse: true, accounts: count(IDS.personal) },
    { id: IDS.ugc, slug: "ugc", name: "UGC", kind: "business", taxShape: "sole_prop", status: "active", closedOn: null, inUse: true, accounts: count(IDS.ugc) },
    { id: IDS.ugm, slug: "ugm", name: "UGM LLC", kind: "business", taxShape: "llc", status: "closed", closedOn: "2025-12-31", inUse: true, accounts: count(IDS.ugm) },
  ];
  return withStudio ? [...rows, { ...STUDIO, inUse: false, accounts: 0 }] : rows;
}

/** In-memory businesses with the server's rules (0170 and settings/actions.ts). A reload starts over. */
function createBusinessStore(initial: BusinessRow[]) {
  let rows = initial;
  let n = 0;
  const subs = new Set<() => void>();
  const set = (next: BusinessRow[]) => {
    rows = next;
    // Added businesses go to sessionStorage, so /dev/reports' scope switch shows them in this tab.
    writeDevBusinesses(rows.filter((r) => !initial.some((i) => i.id === r.id && i.slug !== STUDIO.slug)).map(plain));
    subs.forEach((f) => f());
  };
  const find = (id: string) => rows.find((r) => r.id === id);
  const taken = (name: string, except?: string) => rows.some((r) => r.id !== except && r.name.trim().toLowerCase() === name.trim().toLowerCase());
  const patch = (id: string, p: Partial<BusinessRow>) => {
    set(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
    return ok(plain(find(id)!));
  };
  const status = (id: string, s: "active" | "closed") => {
    const b = find(id);
    if (!b) return fail("not_found", "No such business");
    if (b.kind === "personal") return fail("invalid_input", "Personal cannot be closed");
    return patch(id, { status: s, closedOn: s === "closed" ? "2026-11-21" : null });
  };
  return {
    subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
    get: () => rows,
    actions: {
      async addBusiness({ name, taxShape }: { name: string; taxShape: TaxShape }) {
        const clean = name.trim();
        if (!clean) return fail("invalid_input", "Type a name");
        if (taken(clean)) return fail("conflict", "That name is taken");
        const row: BusinessRow = {
          id: `e7000000-0000-4000-8000-${String(++n + 100).padStart(12, "0")}`,
          slug: slugFor(clean, rows.map((r) => r.slug)),
          name: clean,
          kind: "business",
          taxShape,
          status: "active",
          closedOn: null,
          inUse: false,
          accounts: 0,
        };
        set([...rows, row]);
        return ok(plain(row));
      },
      async updateBusiness({ id, name, taxShape }: { id: string; name?: string; taxShape?: TaxShape }) {
        const b = find(id);
        if (!b) return fail("not_found", "No such business");
        if (name !== undefined && !name.trim()) return fail("invalid_input", "Type a name");
        if (name !== undefined && taken(name, id)) return fail("conflict", "That name is taken");
        if (b.kind === "personal" && taxShape) return fail("invalid_input", "Personal has no tax type");
        return patch(id, { ...(name !== undefined ? { name: name.trim() } : {}), ...(taxShape ? { taxShape } : {}) });
      },
      closeBusiness: async ({ id }: { id: string }) => status(id, "closed"),
      reopenBusiness: async ({ id }: { id: string }) => status(id, "active"),
      async deleteBusiness({ id }: { id: string }) {
        const b = find(id);
        if (!b) return fail("not_found", "No such business");
        if (b.kind === "personal") return fail("invalid_input", "Personal cannot be deleted");
        if (b.inUse) return fail("in_use", "In use: close it instead");
        set(rows.filter((r) => r.id !== id));
        return ok(null);
      },
    },
  };
}

/**
 * The Settings workspace on in-memory data. `?added=on`: Studio Co is there already (unused). `?ig=off`: no Instagram
 * app keys on the host; `?connected=on&ig=error`: Instagram refused the token (Login needed). The Agent tab
 * calls the real /api/agent/state client: the e2e answers that route itself.
 */
export function SettingsFixture() {
  const search = useSearchParams();
  const accounts = useMemoryAccounts(fixtureData({ plaidConfigured: search.get("plaid") === "on", connected: search.get("connected") === "on", ig: search.get("ig") }));
  const [store] = useState(() => createBusinessStore(seed(search.get("added") === "on", accounts.data)));
  const businesses = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [timeZone, setZone] = useState<string | null>("America/Toronto");

  const data = useMemo<SettingsData>(() => ({ businesses, timeZone, accounts: accounts.data }), [businesses, timeZone, accounts.data]);
  const actions = useMemo<SettingsActions>(
    () => ({
      ...store.actions,
      async setTimeZone({ timeZone: zone }) {
        if (zone === null) return setZone(null), { ok: true, data: { timeZone: null } };
        try {
          const canonical = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
          if (/^[+-]/.test(zone)) throw new Error("offset");
          setZone(canonical);
          return { ok: true, data: { timeZone: canonical } };
        } catch {
          return fail("invalid_input", "Not a time zone (use a name like America/Toronto)");
        }
      },
      agentSettings: () => getAgentSettings(),
      saveAgentSettings: (patch) => patchAgentSettings(patch),
      avatars: avatarsClient(),
      modelKeys: modelKeysClient(),
      accounts: accounts.actions,
    }),
    [store, accounts.actions],
  );
  return <SettingsWorkspace data={data} actions={actions} />;
}
