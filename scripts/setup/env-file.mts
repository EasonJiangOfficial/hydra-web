import { chmodSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";

/** Parse KEY=value lines. Does not log. Values may be quoted. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function renderEnv(vars: Record<string, string>, order: readonly string[]): string {
  const lines = ["# Written by pnpm hydra:setup. Do not commit this file.", ""];
  const seen = new Set<string>();
  for (const key of order) {
    const value = vars[key];
    if (!value) continue;
    lines.push(`${key}=${quoteEnv(value)}`);
    seen.add(key);
  }
  for (const [key, value] of Object.entries(vars)) {
    if (seen.has(key) || !value) continue;
    lines.push(`${key}=${quoteEnv(value)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function quoteEnv(value: string): string {
  if (/[\s#"']/.test(value)) return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return value;
}

/** Create or replace a file and force mode 0600 (umask cannot loosen it). */
export function writeSecretFile(file: string, body: string): void {
  const fd = openSync(file, "w", 0o600);
  try {
    writeFileSync(fd, body);
  } finally {
    closeSync(fd);
  }
  chmodSync(file, 0o600);
}

export function readEnvFile(file: string): Record<string, string> {
  try {
    return parseEnv(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** Pull the password out of a database URL so it is not a command argument. */
export function splitDbUrl(raw: string): { url: string; password: string } {
  const parsed = new URL(raw);
  const password = decodeURIComponent(parsed.password);
  parsed.password = "";
  return { url: parsed.toString(), password };
}

export function parseStatusEnv(text: string): { url: string; publishable: string; secret: string } {
  const map = parseEnv(text);
  const url = map.API_URL || map.SUPABASE_URL || "";
  const publishable = map.PUBLISHABLE_KEY || map.ANON_KEY || map.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
  const secret = map.SECRET_KEY || map.SERVICE_ROLE_KEY || map.SUPABASE_SECRET_KEY || "";
  if (!url || !publishable || !secret) throw new Error("Could not read the local Supabase URL and keys");
  return { url, publishable, secret };
}
