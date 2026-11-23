export type OptionName = "local" | "vps" | "vercel";

export type KeySpec = {
  name: string;
  required: boolean;
  /** Hidden while typing. Every value is still omitted from logs. */
  mask: boolean;
  generated?: boolean;
  prompt: string;
};

/** Keys the running app reads. Order is the order in the written env file. */
export const APP_KEYS: KeySpec[] = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", required: true, mask: false, prompt: "Supabase project URL" },
  { name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", required: true, mask: true, prompt: "Supabase publishable key" },
  { name: "SUPABASE_SECRET_KEY", required: true, mask: true, prompt: "Supabase secret key" },
  { name: "HYDRA_OWNER_EMAIL", required: true, mask: false, prompt: "Your email. Only this account can sign in" },
  { name: "HYDRA_TOKEN_KEY", required: true, mask: true, generated: true, prompt: "Token key (generated)" },
  { name: "CRON_SECRET", required: true, mask: true, generated: true, prompt: "Cron secret (generated)" },
  { name: "FISH_AUDIO_API_KEY", required: false, mask: true, prompt: "Fish Audio API key. Empty skips voice" },
  { name: "FISH_DEFAULT_VOICE_ID", required: false, mask: false, prompt: "Fish voice id, 32 hex characters. Empty skips Hydra's own voice" },
  { name: "ANTHROPIC_API_KEY", required: false, mask: true, prompt: "Anthropic API key. Empty skips the web agent" },
  { name: "GOOGLE_CLIENT_ID", required: false, mask: false, prompt: "Google OAuth client id. Empty skips Gmail and Calendar" },
  { name: "GOOGLE_CLIENT_SECRET", required: false, mask: true, prompt: "Google OAuth client secret. Empty skips Gmail and Calendar" },
  { name: "META_APP_ID", required: false, mask: false, prompt: "Meta app id. Empty skips Instagram" },
  { name: "META_APP_SECRET", required: false, mask: true, prompt: "Meta app secret. Empty skips Instagram" },
  { name: "INSTAGRAM_CONFIG_ID", required: false, mask: false, prompt: "Instagram login config id. Empty skips Instagram" },
  { name: "PLAID_CLIENT_ID", required: false, mask: false, prompt: "Plaid client id. Empty skips the bank feed" },
  { name: "PLAID_SECRET", required: false, mask: true, prompt: "Plaid secret. Empty skips the bank feed" },
  { name: "PLAID_ENV", required: false, mask: false, prompt: "Plaid environment: sandbox or production. Empty means sandbox" },
  { name: "VAPID_PUBLIC_KEY", required: false, mask: true, generated: true, prompt: "Web push public key (generated)" },
  { name: "VAPID_PRIVATE_KEY", required: false, mask: true, generated: true, prompt: "Web push private key (generated)" },
  { name: "VAPID_SUBJECT", required: false, mask: false, generated: true, prompt: "Web push subject (mailto: or https:)" },
];

export const APP_KEY_NAMES = APP_KEYS.map((key) => key.name);

/** Asked for, then not stored: the app does not read them. */
export const SKIP_KEYS = ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "RIPPLE_MEDIA_ORIGIN"] as const;

export const CONTROL_KEYS = [
  "OPTION",
  "ORIGIN",
  "ENV_FILE",
  "SUPABASE_WORKDIR",
  "SUPABASE_DB_URL",
  "SUPABASE_DB_PASSWORD",
  "HYDRA_DOMAIN",
  "ACME_EMAIL",
  "VERCEL_PROJECT",
  "SKIP_MIGRATE",
  "REPLACE_GENERATED",
] as const;

export const GENERATED = ["HYDRA_TOKEN_KEY", "CRON_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const;

export const REDIRECT_PATHS = ["/api/google/callback", "/api/instagram/callback"] as const;

const KNOWN = new Set<string>([...APP_KEY_NAMES, ...CONTROL_KEYS]);

export function parseOption(value: string): OptionName {
  const text = value.trim().toLowerCase();
  if (text === "1" || text === "local") return "local";
  if (text === "2" || text === "vps") return "vps";
  if (text === "3" || text === "vercel") return "vercel";
  throw new Error("Option must be local, vps, or vercel");
}

/** Answers file: KEY=value lines. Unknown keys fail. Values are not included in errors. */
export function parseAnswers(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) throw new Error("An answers line is missing a key");
    const key = trimmed.slice(0, eq).trim();
    if ((SKIP_KEYS as readonly string[]).includes(key)) throw new Error(`${key} is not used. Remove it from the answers file`);
    if (!KNOWN.has(key)) throw new Error(`Unknown answers key ${key}`);
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  if (!out.OPTION) throw new Error("Answers file is missing OPTION");
  parseOption(out.OPTION);
  return out;
}
