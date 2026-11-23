import type { ComponentType } from "react";
import type { BlockSpec } from "@/lib/layout/model";

/**
 * One block type: id, title, default size per breakpoint and min/max (the `BlockSpec`), plus the
 * component that draws it. U6 fills this with the real Dashboard cards. A block with no component
 * (and no `content` entry on the grid) draws an empty tint card, so cards can land one at a time.
 */
export type BlockDef = BlockSpec & { component?: ComponentType };

/** Attach components to a list of specs, e.g. `defineRegistry(DASHBOARD_BLOCKS, { "net-worth": NetWorthCard })`. */
export function defineRegistry(specs: readonly BlockSpec[], components: Partial<Record<string, ComponentType>>): BlockDef[] {
  return specs.map((s) => ({ ...s, component: components[s.id] }));
}
