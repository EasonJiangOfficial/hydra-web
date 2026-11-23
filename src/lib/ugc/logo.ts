/**
 * Deal logos: the checks a file passes before it goes to the private `deal-logos` bucket
 * (0011_ripple_import.sql: 10 MB, png, jpeg, webp, gif; owner-only policies). Pure and client-safe.
 */
export const LOGO_BUCKET = "deal-logos";
export const LOGO_MAX_BYTES = 10 * 1024 * 1024;
export const LOGO_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Why this file cannot be a logo, or null when it can. */
export function logoFileProblem(file: { type: string; size: number }): string | null {
  if (!LOGO_TYPES[file.type]) return "Use a PNG, JPEG, WebP or GIF image.";
  if (file.size <= 0) return "This file is empty.";
  if (file.size > LOGO_MAX_BYTES) return "Use an image under 10 MB.";
  return null;
}

/** deals/<dealId>/<random>.<ext>: a new object per upload, so an old signed URL never shows the new logo. */
export function logoObjectPath(dealId: string, type: string, random: string = crypto.randomUUID()): string {
  return `deals/${dealId}/${random}.${LOGO_TYPES[type] ?? "img"}`;
}
