import type { BlockSpec } from "./model";

/**
 * The Dashboard's blocks and their default layouts. Desktop follows Main.dc.html (12 columns),
 * phone follows Mobile.dc.html (2 columns): net worth, income and expenses, the Cash / Cards / UGC tiles,
 * the posting week, recent, then goals and coming up; the full cash, month and UGC cards start hidden there
 * (Add block brings them back). One row unit is 42 px on desktop (a block of h rows is
 * 62h - 20 px tall) and 56 px on the phone (68h - 12 px). U6 renders a card for each id.
 */
const d = (x: number, y: number, w: number, h: number, minW: number, minH: number, maxW = 12, maxH = 10) => ({
  x,
  y,
  w,
  h,
  minW,
  minH,
  maxW,
  maxH,
});
const p = (y: number, w: number, h: number, minW: number, minH: number, maxH = 8) => ({
  x: 0,
  y,
  w,
  h,
  minW,
  minH,
  maxW: 2,
  maxH,
});
const off = <T extends object>(s: T) => ({ ...s, hidden: true });

export const DASHBOARD_BLOCKS: readonly BlockSpec[] = [
  { id: "net-worth", title: "Net worth", sizes: { desktop: d(0, 0, 8, 6, 5, 4), phone: p(0, 2, 4, 2, 3) } },
  // Owner, 2026-11-22: the scope switch must change income and expenses "with graphs and charts". Right after net worth.
  { id: "income-expenses", title: "Income and expenses", sizes: { desktop: d(0, 6, 12, 6, 6, 3), phone: p(4, 2, 9, 2, 3, 12) } },
  { id: "summary", title: "Cash, cards and UGC", sizes: { desktop: off(d(0, 23, 6, 2, 4, 2, 12, 3)), phone: p(13, 2, 2, 2, 2, 3) } },
  { id: "accounts", title: "Cash and cards", sizes: { desktop: d(8, 0, 4, 6, 3, 5), phone: off(p(29, 2, 5, 1, 4)) } },
  { id: "month", title: "This month", sizes: { desktop: d(0, 12, 12, 2, 4, 2, 12, 3), phone: off(p(34, 2, 3, 2, 2, 5)) } },
  { id: "ugc", title: "UGC revenue", sizes: { desktop: d(0, 14, 4, 5, 3, 4), phone: off(p(37, 2, 4, 1, 4)) } },
  { id: "posting", title: "Posting", sizes: { desktop: d(4, 14, 4, 5, 3, 4), phone: p(15, 2, 3, 2, 3) } },
  { id: "recent", title: "Recent", sizes: { desktop: d(8, 14, 4, 5, 3, 3), phone: p(18, 2, 5, 2, 3) } },
  { id: "goals", title: "Goals", sizes: { desktop: d(0, 19, 6, 4, 4, 3), phone: p(23, 2, 3, 2, 2) } },
  { id: "coming-up", title: "Coming up", sizes: { desktop: d(6, 19, 6, 4, 4, 3), phone: p(26, 2, 3, 2, 2) } },
];
