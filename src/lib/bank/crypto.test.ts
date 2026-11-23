// @vitest-environment node
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissingEnvError } from "@/lib/supabase/env";
import { decryptToken, encryptToken, TokenDecryptError } from "./crypto";
import { InvalidEnvError } from "./env";

const TOKEN = "access-sandbox-de3ce8ef-33f8-452c-a685-8671031fc0f6";
const ITEM = "Ed6bjNrDLJfGvZWwnkQlfxwoNz54B5C97ejBr";

afterEach(() => vi.unstubAllEnvs());

/** Flip one byte inside one base64url segment of a sealed token. */
function tamper(sealed: string, segment: 1 | 2 | 3): string {
  const parts = sealed.split(".");
  const bytes = Buffer.from(parts[segment], "base64url");
  bytes[0] ^= 0x01;
  parts[segment] = bytes.toString("base64url");
  return parts.join(".");
}

describe("token encryption", () => {
  const key = randomBytes(32);

  it("round-trips, with a fresh IV every time and no plaintext in the output", () => {
    const a = encryptToken(TOKEN, ITEM, key);
    const b = encryptToken(TOKEN, ITEM, key);
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
    expect(a).not.toContain("access-sandbox");
    expect(decryptToken(a, ITEM, key)).toBe(TOKEN);
    expect(decryptToken(b, ITEM, key)).toBe(TOKEN);
  });

  it("detects tampering with the IV, the tag or the ciphertext", () => {
    const sealed = encryptToken(TOKEN, ITEM, key);
    for (const segment of [1, 2, 3] as const) {
      expect(() => decryptToken(tamper(sealed, segment), ITEM, key)).toThrow(TokenDecryptError);
    }
  });

  it("refuses a truncated tag, another item, another key and junk", () => {
    const sealed = encryptToken(TOKEN, ITEM, key);
    const [v, iv, tag, ct] = sealed.split(".");
    const shortTag = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url");
    expect(() => decryptToken([v, iv, shortTag, ct].join("."), ITEM, key)).toThrow(TokenDecryptError);
    expect(() => decryptToken(sealed, "another-item", key)).toThrow(TokenDecryptError);
    expect(() => decryptToken(sealed, ITEM, randomBytes(32))).toThrow(TokenDecryptError);
    expect(() => decryptToken("v2.a.b.c", ITEM, key)).toThrow(TokenDecryptError);
    expect(() => decryptToken(TOKEN, ITEM, key)).toThrow(TokenDecryptError);
  });

  it("never puts the token in an error message", () => {
    const sealed = encryptToken(TOKEN, ITEM, key);
    const error = (() => {
      try {
        decryptToken(tamper(sealed, 3), ITEM, key);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toBe("Bank token could not be decrypted");
  });

  it("reads HYDRA_TOKEN_KEY from the env and fails closed by name", () => {
    vi.stubEnv("HYDRA_TOKEN_KEY", key.toString("base64"));
    expect(decryptToken(encryptToken(TOKEN, ITEM), ITEM)).toBe(TOKEN);
    vi.stubEnv("HYDRA_TOKEN_KEY", "");
    expect(() => encryptToken(TOKEN, ITEM)).toThrow(MissingEnvError);
    expect(() => encryptToken(TOKEN, ITEM)).toThrow("HYDRA_TOKEN_KEY");
    vi.stubEnv("HYDRA_TOKEN_KEY", randomBytes(16).toString("base64"));
    expect(() => encryptToken(TOKEN, ITEM)).toThrow(InvalidEnvError);
  });
});
