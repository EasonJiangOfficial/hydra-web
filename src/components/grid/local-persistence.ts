import type { Breakpoint } from "@/lib/layout/model";
import type { LayoutRow } from "@/lib/layout/store";
import type { Persistence, SavedLayouts } from "./dashboard-grid";

/**
 * Layout storage in the browser, for the /dev/grid fixture and any page with no session.
 * It keeps the same compare-and-set rule as the database, so two tabs behave the same way.
 */
export const LOCAL_LAYOUT_KEY = "hydra.dev.grid";

type Stored = Partial<Record<Breakpoint, LayoutRow>>;

export function readLocalRaw(): string | null {
  try {
    return window.localStorage.getItem(LOCAL_LAYOUT_KEY);
  } catch {
    return null;
  }
}

export function parseLocal(raw: string | null): SavedLayouts {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Stored) : {};
  } catch {
    return {};
  }
}

function write(stored: Stored) {
  try {
    window.localStorage.setItem(LOCAL_LAYOUT_KEY, JSON.stringify(stored));
  } catch {
    // storage full or blocked: the layout simply does not persist
  }
}

export const localPersistence: Persistence = {
  async save({ breakpoint, items, expectedUpdatedAt }) {
    const stored = parseLocal(readLocalRaw()) as Stored;
    const current = stored[breakpoint] ?? null;
    if ((current?.updatedAt ?? null) !== expectedUpdatedAt) return { ok: false, reason: "conflict", current };
    const updatedAt = crypto.randomUUID();
    write({ ...stored, [breakpoint]: { items, updatedAt } });
    return { ok: true, updatedAt };
  },
  async reset({ breakpoint }) {
    const { [breakpoint]: _gone, ...rest } = parseLocal(readLocalRaw()) as Stored;
    void _gone;
    write(rest);
    return { ok: true };
  },
};
