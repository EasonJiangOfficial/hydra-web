import { METRIC_KEYS, createMetricRegistry, type MetricKey, type MetricRegistry, type MetricWindow } from "@/lib/planning/metrics";

/**
 * The registry the browser uses. The resolvers read the database, so they run on the server; this
 * registry sends each reading there, remembers the answer for a minute (a task moving re-reads
 * every goal, and that must not hit the server each time), and shares one request between callers
 * that ask for the same thing. The page seeds it with the readings it already made for first paint.
 * A failed reading answers null (shown as "-") and is not remembered.
 */
export interface MetricRequest {
  readonly key: MetricKey;
  readonly param: string | null;
  readonly window: MetricWindow;
  readonly today: string;
  readonly timeZone: string;
}

export type RemoteResolve = (request: MetricRequest) => Promise<number | null>;

export const metricCacheKey = (r: MetricRequest): string => [r.key, r.param ?? "", r.window.from, r.window.to, r.today].join("|");

export const REMOTE_KEYS = METRIC_KEYS.filter((k): k is Exclude<MetricKey, "task_progress"> => k !== "task_progress");

export function createRemoteRegistry(
  resolve: RemoteResolve,
  seed: Readonly<Record<string, number | null>> = {},
  { ttlMs = 60_000, clock = Date.now }: { ttlMs?: number; clock?: () => number } = {},
): MetricRegistry {
  const cache = new Map<string, { at: number; value: Promise<number | null> }>();
  for (const [k, v] of Object.entries(seed)) cache.set(k, { at: clock(), value: Promise.resolve(v) });

  const read = (request: MetricRequest): Promise<number | null> => {
    const k = metricCacheKey(request);
    const hit = cache.get(k);
    if (hit && clock() - hit.at < ttlMs) return hit.value;
    const value = resolve(request).catch(() => {
      cache.delete(k);
      return null;
    });
    cache.set(k, { at: clock(), value });
    return value;
  };

  let registry = createMetricRegistry();
  for (const key of REMOTE_KEYS) {
    registry = registry.register(key, (param, ctx) => read({ key, param, window: ctx.window, today: ctx.today, timeZone: ctx.timeZone }));
  }
  return registry;
}
