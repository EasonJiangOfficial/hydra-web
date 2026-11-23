/**
 * Label colors (owner, 2026-11-21: "for the different statuses or categories or tags there should
 * be a color selector"). One palette for statuses, select options and categories. Each tone is
 * muted so it reads as a small dot and as a light pill tint, on white and on the dark hero card.
 * Red here is a muted rose, kept apart from `--neg` (#b3261e), which stays for money lost or overdue.
 */
export const LABEL_PALETTE = [
  // Row 1: the gray ramp the seeds use ("darker means more urgent"), so seeded labels are ringed and named.
  { name: "Ink", hex: "#1d1d1f" },
  { name: "Charcoal", hex: "#424245" },
  { name: "Graphite", hex: "#6e6e73" },
  { name: "Gray", hex: "#8e8e93" },
  { name: "Silver", hex: "#a1a1a6" },
  { name: "Mist", hex: "#c7c7cc" },
  // Rows 2 and 3: muted tones.
  { name: "Rose", hex: "#c0687a" },
  { name: "Orange", hex: "#c7773f" },
  { name: "Amber", hex: "#c29a2e" },
  { name: "Olive", hex: "#8a8a3f" },
  { name: "Green", hex: "#5f8a5b" },
  { name: "Teal", hex: "#4b8a8c" },
  { name: "Slate", hex: "#5f7186" },
  { name: "Blue", hex: "#4f7cb8" },
  { name: "Indigo", hex: "#5f64b0" },
  { name: "Purple", hex: "#8466ae" },
  { name: "Pink", hex: "#c46a9e" },
  { name: "Brown", hex: "#9a6f55" },
] as const;

export const HEX_RE = /^#[0-9a-f]{6}$/i;

/** "#ABC" or "abcdef" or "#abcdef" to "#abcdef"; anything else to null. */
export function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#?/, "#").toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return HEX_RE.test(s) ? s : null;
}

export function colorName(hex: string | null | undefined): string {
  if (!hex) return "None";
  return LABEL_PALETTE.find((c) => c.hex === hex.toLowerCase())?.name ?? hex.toLowerCase();
}

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const toHex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two hex colors, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** How much of the color the pill tint keeps over white. */
const TINT = 0.14;
const INK: Rgb = [0x1d, 0x1d, 0x1f];
const WHITE: Rgb = [255, 255, 255];

/**
 * A tag pill's colors: a light tint of the color, and text in the same hue, darkened toward ink
 * until it reads at 4.5:1 or better on that tint.
 */
export function pillColors(hex: string): { background: string; color: string } {
  const base = rgb(hex.toLowerCase());
  const background = toHex(mix(WHITE, base, TINT));
  for (let t = 0; t <= 1; t += 0.05) {
    const color = toHex(mix(base, INK, t));
    if (contrast(color, background) >= 4.5) return { background, color };
  }
  return { background, color: toHex(INK) };
}

/**
 * A category's color: its own, else its parent's. Reports rolls subcategories into their top-level
 * category, so a subcategory with no color of its own shows its parent's.
 */
export function categoryColor(
  categories: readonly { id: string; color?: string | null; parent_id?: string | null }[],
  id: string | null | undefined,
): string | null {
  const c = id ? categories.find((x) => x.id === id) : undefined;
  if (!c) return null;
  return c.color ?? (c.parent_id ? (categories.find((x) => x.id === c.parent_id)?.color ?? null) : null);
}
