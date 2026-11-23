import { MissingEnvError } from "@/lib/supabase/env";

/**
 * Bank env. Server only: none of these are NEXT_PUBLIC, so the browser bundle sees undefined and
 * every reader fails closed with a named error.
 */
export { MissingEnvError };

export class InvalidEnvError extends Error {
  constructor(
    readonly variable: string,
    reason: string,
  ) {
    super(`Invalid environment variable ${variable}: ${reason}`);
    this.name = "InvalidEnvError";
  }
}

function required(name: string, env: Env): string {
  const value = env[name]?.trim();
  if (!value) throw new MissingEnvError(name);
  return value;
}

type Env = Record<string, string | undefined>;

export type PlaidEnvName = "sandbox" | "production";

/** PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox when unset). */
export function plaidEnv(env: Env = process.env) {
  const name = (env.PLAID_ENV?.trim() || "sandbox").toLowerCase();
  if (name !== "sandbox" && name !== "production") {
    throw new InvalidEnvError("PLAID_ENV", "use sandbox or production");
  }
  return {
    clientId: required("PLAID_CLIENT_ID", env),
    secret: required("PLAID_SECRET", env),
    env: name as PlaidEnvName,
  };
}

/** HYDRA_TOKEN_KEY: 32 random bytes, base64. `openssl rand -base64 32`. */
export function tokenKey(env: Env = process.env): Buffer {
  const key = Buffer.from(required("HYDRA_TOKEN_KEY", env), "base64");
  if (key.length !== 32) throw new InvalidEnvError("HYDRA_TOKEN_KEY", "must be 32 bytes, base64");
  return key;
}
