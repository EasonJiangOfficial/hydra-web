import type { SupabaseClient } from "@supabase/supabase-js";

/** One database call a test saw: `from(table).op(args).op(args)...` or `rpc(name, args)`. */
export interface Call {
  readonly table?: string;
  readonly rpc?: string;
  readonly rpcArgs?: unknown;
  readonly ops: readonly [string, readonly unknown[]][];
}

export type Reply = { data?: unknown; error?: { message: string; code?: string } | null; count?: number | null };

/** Did this call use `op` with these args (matched by deep equality on the listed args)? */
export const used = (call: Call, op: string, ...args: unknown[]): boolean =>
  call.ops.some(([name, a]) => name === op && args.every((x, i) => JSON.stringify(a[i]) === JSON.stringify(x)));

/** The first args of `op` in a call. */
export const argsOf = (call: Call, op: string): readonly unknown[] | undefined => call.ops.find(([n]) => n === op)?.[1];

/**
 * A stand-in for the Supabase client: every chained method is recorded, and awaiting the chain
 * calls `reply`. Enough to prove WHICH table, columns and filters an action writes.
 */
export function fakeDb(reply: (call: Call) => Reply = () => ({ data: null, error: null })) {
  const calls: Call[] = [];
  const chain = (start: Omit<Call, "ops">): unknown => {
    const ops: [string, readonly unknown[]][] = [];
    const call: Call = { ...start, ops };
    calls.push(call);
    const proxy: unknown = new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === "then") {
          const r = { data: null, error: null, count: null, ...reply(call) };
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(r).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          ops.push([String(prop), args]);
          return proxy;
        };
      },
    });
    return proxy;
  };
  const db = {
    from: (table: string) => chain({ table }),
    rpc: (name: string, args?: unknown) => chain({ rpc: name, rpcArgs: args }),
  } as unknown as SupabaseClient;
  return { db, calls };
}
