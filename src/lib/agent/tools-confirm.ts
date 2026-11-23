import type { Gate, ToolCtx } from "./registry";

/**
 * Delete confirms that name the item (owner rule: every deletion asks first, and the card says
 * what goes). The name is read when the gate runs; when it cannot be read, the card falls back to
 * the generic line and still asks.
 */

/** The confirm gate of a delete: `when` limits it to inputs that delete (a null value, hidden=true). */
export function namedDelete<I>(fallback: string, name: (ctx: ToolCtx, input: I) => Promise<string | null>, when?: (input: I) => boolean) {
  return async (ctx: ToolCtx, input: I): Promise<Gate | null> => {
    if (when && !when(input)) return null;
    const summary = await name(ctx, input).catch(() => null);
    return { reason: "delete", summary: summary ?? fallback, danger: true };
  };
}

/** One row's columns through the owner's client (RLS applies), or null. */
export async function rowOf<T = Record<string, unknown>>(ctx: ToolCtx, table: string, id: string, columns: string): Promise<T | null> {
  const { data, error } = await ctx.db.from(table).select(columns).eq("id", id).maybeSingle();
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data as T | null) ?? null;
}

/** Cents as -$12.50. */
export const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** A quoted name, cut to one line. */
export const q = (s: string | null | undefined) => `"${(s ?? "").replace(/\s+/g, " ").trim().slice(0, 80)}"`;
