import { MissingEnvError } from "@/lib/supabase/env";

/**
 * VAPID identity for web push. Server env only, read lazily so `next build` needs no values and a
 * missing one fails closed with an error that names it. VAPID_SUBJECT is a `mailto:` or `https:` URL.
 * Make a key pair once with `npx web-push generate-vapid-keys`.
 */
export function pushEnv() {
  const get = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new MissingEnvError(name);
    return value;
  };
  return { publicKey: get("VAPID_PUBLIC_KEY"), privateKey: get("VAPID_PRIVATE_KEY"), subject: get("VAPID_SUBJECT") };
}
