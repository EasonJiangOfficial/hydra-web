/**
 * Test support: a stand-in for a supabase-js client. Records each query (table, action, values,
 * filters) and answers it from `reply`. Only the builder methods the bank code uses exist.
 */

export interface Op {
  table: string;
  action: "select" | "insert" | "update" | "upsert";
  columns?: string;
  values?: unknown;
  options?: unknown;
  filters: string[];
}

export type Reply = { data?: unknown; error?: { code?: string; message: string } | null; count?: number };

export function fakeDb(reply: (op: Op) => Reply = () => ({})) {
  const ops: Op[] = [];
  return {
    ops,
    from(table: string) {
      const op: Op = { table, action: "select", filters: [] };
      const builder: Record<string, unknown> = {};
      const step =
        (fn: (...args: never[]) => void) =>
        (...args: never[]) => {
          fn(...args);
          return builder;
        };
      Object.assign(builder, {
        select: step((columns: string) => {
          if (op.action === "select") op.columns = columns;
        }),
        insert: step((values: unknown) => Object.assign(op, { action: "insert", values })),
        update: step((values: unknown) => Object.assign(op, { action: "update", values })),
        upsert: step((values: unknown, options: unknown) => Object.assign(op, { action: "upsert", values, options })),
        eq: step((column: string, value: unknown) => op.filters.push(`${column}=${String(value)}`)),
        neq: step((column: string, value: unknown) => op.filters.push(`${column}!=${String(value)}`)),
        in: step((column: string, values: unknown[]) => op.filters.push(`${column} in [${values.length}]`)),
        gte: step((column: string, value: unknown) => op.filters.push(`${column}>=${String(value)}`)),
        lte: step((column: string, value: unknown) => op.filters.push(`${column}<=${String(value)}`)),
        is: step((column: string, value: unknown) => op.filters.push(`${column} is ${String(value)}`)),
        or: step((filter: string) => op.filters.push(`or(${filter})`)),
        order: step(() => {}),
        limit: step(() => {}),
        range: step((from: number, to: number) => op.filters.push(`range ${from}-${to}`)),
        maybeSingle: step(() => {}),
        single: step(() => {}),
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          ops.push(op);
          return Promise.resolve({ data: null, error: null, ...reply(op) }).then(resolve, reject);
        },
      });
      return builder;
    },
  };
}
