export const POSITION_STEP = 1024;
export const MIN_POSITION_GAP = 1e-6;

export interface PositionUpdate {
  readonly id: string;
  readonly position: number;
}

export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return POSITION_STEP;
  if (before === null) return (after as number) - POSITION_STEP;
  if (after === null) return before + POSITION_STEP;
  return (before + after) / 2;
}

export function needsRenormalize(before: number | null, after: number | null): boolean {
  return before !== null && after !== null && after - before < MIN_POSITION_GAP;
}

export function renormalize(ids: readonly string[]): PositionUpdate[] {
  return ids.map((id, i) => ({ id, position: (i + 1) * POSITION_STEP }));
}

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
