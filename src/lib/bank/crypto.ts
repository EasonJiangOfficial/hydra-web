import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { tokenKey } from "./env";

/**
 * Provider access tokens at rest: AES-256-GCM, a random 12-byte IV per token, the 16-byte auth tag
 * checked on every read. `aad` binds the ciphertext to its bank item (the provider's item id), so a
 * token copied onto another row does not decrypt. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url).
 * Never log the plaintext or pass it to an error message.
 */
export class TokenDecryptError extends Error {
  constructor() {
    super("Bank token could not be decrypted");
    this.name = "TokenDecryptError";
  }
}

export function encryptToken(plain: string, aad: string, key: Buffer = tokenKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ciphertext].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decryptToken(sealed: string, aad: string, key: Buffer = tokenKey()): string {
  const [version, iv, tag, ciphertext] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || ciphertext === undefined) throw new TokenDecryptError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new TokenDecryptError();
  }
}
