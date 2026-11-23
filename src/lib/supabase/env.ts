/**
 * Env parsing. Read lazily (at request time), so `next build` never needs real values and a
 * missing value fails closed with an error that names it.
 * NEXT_PUBLIC_* must be read with literal `process.env.X` so Next inlines them into the browser.
 */
export class MissingEnvError extends Error {
  constructor(readonly variable: string) {
    super(`Missing environment variable ${variable}`);
    this.name = "MissingEnvError";
  }
}

function required(name: string, value: string | undefined): string {
  if (!value || !value.trim()) throw new MissingEnvError(name);
  return value.trim();
}

export function publicEnv() {
  return {
    url: required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    publishableKey: required(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
  };
}

/** Server only in practice: non-public vars are undefined in the browser bundle. */
export function ownerEmail(): string {
  return required("HYDRA_OWNER_EMAIL", process.env.HYDRA_OWNER_EMAIL).toLowerCase();
}
