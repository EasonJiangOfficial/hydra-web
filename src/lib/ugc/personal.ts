/**
 * The Personal Brand deal (0140, deals.personal_brand) is the owner's own account, not UGC work: the tracker,
 * its money and the Dashboard leave it and every row hanging off it out. Its page is /brand.
 */
export function ugcDealsOnly<D extends { id: string; personal_brand?: boolean | null }>(deals: readonly D[]) {
  const ugc = deals.filter((d) => !d.personal_brand);
  const ids = new Set(ugc.map((d) => d.id));
  return { deals: ugc, has: (row: { deal_id: string }) => ids.has(row.deal_id) };
}
