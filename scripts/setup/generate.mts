import { randomBytes } from "node:crypto";
import { generateVAPIDKeys } from "web-push";

/** 32 random bytes, base64. This is HYDRA_TOKEN_KEY. Losing it means linking every bank again. */
export function tokenKey(): string {
  return randomBytes(32).toString("base64");
}

/** 32 random bytes, hex. This is CRON_SECRET. */
export function cronSecret(): string {
  return randomBytes(32).toString("hex");
}

export function vapidPair(): { publicKey: string; privateKey: string } {
  return generateVAPIDKeys();
}
