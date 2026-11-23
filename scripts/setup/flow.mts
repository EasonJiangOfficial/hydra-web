import { cronSecret, tokenKey, vapidPair } from "./generate.mts";
import { APP_KEYS, GENERATED, REDIRECT_PATHS, parseAnswers, parseOption, type OptionName } from "./catalog.mts";
import { parseStatusEnv, readEnvFile, renderEnv, splitDbUrl, writeSecretFile } from "./env-file.mts";
import { redactText } from "./redact.mts";
import type { SpawnOpts, SpawnResult } from "./runner.mts";

export type Runner = {
  spawn: (cmd: string, args: string[], opts?: SpawnOpts) => Promise<SpawnResult>;
};

export type Prompt = (q: { name: string; label: string; mask: boolean }) => Promise<string>;

export type RunInput = {
  cwd: string;
  /** Answers file body. When set, nothing is prompted. */
  answersText?: string;
  prompt?: Prompt;
  dryRun: boolean;
  envFile: string;
  supabaseWorkdir: string;
  log: (line: string) => void;
  runner: Runner;
};

const SUPABASE_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"] as const;

export async function runSetup(input: RunInput): Promise<void> {
  const answers = input.answersText !== undefined ? parseAnswers(input.answersText) : await askAll(input.prompt);
  const option = parseOption(answers.OPTION ?? "");
  const origin = resolveOrigin(option, answers);
  const email = (answers.HYDRA_OWNER_EMAIL ?? "").trim();
  if (!email.includes("@")) throw new Error("Enter an email address");

  const env: Record<string, string> = { HYDRA_OWNER_EMAIL: email };
  for (const spec of APP_KEYS) {
    if (spec.name === "HYDRA_OWNER_EMAIL") continue;
    const value = (answers[spec.name] ?? "").trim();
    if (value) env[spec.name] = value;
  }

  const previous = input.dryRun ? {} : readEnvFile(input.envFile);
  const replace = answers.REPLACE_GENERATED === "1";
  const created = fillGenerated(env, previous, replace);
  if (option === "vps") {
    if (answers.HYDRA_DOMAIN) env.HYDRA_DOMAIN = answers.HYDRA_DOMAIN.trim();
    if (answers.ACME_EMAIL) env.ACME_EMAIL = answers.ACME_EMAIL.trim();
    else env.ACME_EMAIL = email;
  }

  const secrets = secretValues(env, answers);
  input.log(`option ${option}`);
  input.log(`site ${origin}`);

  let didMigrate = false;
  if (option === "local" && !SUPABASE_NAMES.every((name) => env[name])) {
    if (input.dryRun) {
      input.log("would read the local Supabase URL and keys");
    } else if (answers.SKIP_MIGRATE === "1") {
      throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
    } else {
      await localMigrate(input, secrets);
      didMigrate = true;
      await readLocalStatus(input, env, secrets);
    }
  } else if (option !== "local") {
    hostedKeys(env);
  }

  if (!input.dryRun) {
    writeSecretFile(input.envFile, renderEnv(env, [...APP_KEYS.map((key) => key.name), "HYDRA_DOMAIN", "ACME_EMAIL"]));
    input.log(`wrote ${input.envFile} mode 0600`);
  } else {
    input.log(`would write ${input.envFile} mode 0600`);
  }
  input.log(`env keys: ${Object.entries(env).filter(([, value]) => value).map(([key]) => key).join(", ")}`);
  if (created.length) input.log(`generated (not shown): ${created.join(", ")}`);
  else input.log("kept existing generated secrets");

  if (answers.SKIP_MIGRATE === "1") input.log("migrations skipped");
  else if (option === "local" && !didMigrate) await localMigrate(input, secrets);
  else if (option !== "local") await hostedMigrate(input, answers, secrets);

  if (input.dryRun) input.log("would run: node --experimental-strip-types scripts/bootstrap-owner.mts");
  else await runChecked(input, process.execPath, ["--experimental-strip-types", "scripts/bootstrap-owner.mts"], { cwd: input.cwd, env, capture: true, secrets }, secrets);

  if (option === "vercel") await pushVercel(input, env, answers, secrets);

  for (const path of REDIRECT_PATHS) input.log(`redirect ${origin}${path}`);
  input.log("In Supabase Auth, set the Site URL to the site above, add <site>/** to redirect URLs, and turn sign-ups off.");
  input.log("Set the passkey RP ID to the site host. It stays fixed after the first passkey.");
  if (option === "vps") {
    input.log("On the server, from this directory: docker compose up -d --build");
    input.log("The cron service calls the five routes in vercel.json with Authorization: Bearer CRON_SECRET.");
  }
  if (option === "vercel") input.log("Crons in vercel.json run on Vercel. Deploy with: vercel --prod");
  if (option === "local") input.log("Start the app with: pnpm dev");
}

function secretValues(env: Record<string, string>, answers: Record<string, string>): string[] {
  const values = Object.entries(env)
    .filter(([key]) => key !== "HYDRA_DOMAIN")
    .map(([, value]) => value);
  for (const key of ["SUPABASE_DB_URL", "SUPABASE_DB_PASSWORD", "ACME_EMAIL"]) {
    if (answers[key]) values.push(answers[key]);
  }
  return values.filter((value) => value.length > 0);
}

function fillGenerated(env: Record<string, string>, previous: Record<string, string>, replace: boolean): string[] {
  const created: string[] = [];
  const keep = (name: string, make: () => string) => {
    if (env[name]) return;
    if (!replace && previous[name]) {
      env[name] = previous[name];
      return;
    }
    env[name] = make();
    created.push(name);
  };
  keep("HYDRA_TOKEN_KEY", tokenKey);
  keep("CRON_SECRET", cronSecret);
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    if (!replace && previous.VAPID_PUBLIC_KEY && previous.VAPID_PRIVATE_KEY && !env.VAPID_PUBLIC_KEY && !env.VAPID_PRIVATE_KEY) {
      env.VAPID_PUBLIC_KEY = previous.VAPID_PUBLIC_KEY;
      env.VAPID_PRIVATE_KEY = previous.VAPID_PRIVATE_KEY;
    } else if (!env.VAPID_PUBLIC_KEY && !env.VAPID_PRIVATE_KEY) {
      const pair = vapidPair();
      env.VAPID_PUBLIC_KEY = pair.publicKey;
      env.VAPID_PRIVATE_KEY = pair.privateKey;
      created.push("VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY");
    }
  }
  if (!env.VAPID_SUBJECT && env.HYDRA_OWNER_EMAIL) env.VAPID_SUBJECT = `mailto:${env.HYDRA_OWNER_EMAIL}`;
  return created;
}

function resolveOrigin(option: OptionName, answers: Record<string, string>): string {
  const given = (answers.ORIGIN ?? "").trim();
  const origin = given || (option === "local" ? "http://localhost:3000" : answers.HYDRA_DOMAIN ? `https://${answers.HYDRA_DOMAIN.trim()}` : "");
  if (!origin) throw new Error("Enter a site URL");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("Site URL must be an http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Site URL must be an http(s) URL");
  return origin.replace(/\/$/, "");
}

function hostedKeys(env: Record<string, string>): void {
  for (const name of SUPABASE_NAMES) {
    if (!env[name]) throw new Error(`Missing ${name}`);
  }
}

async function readLocalStatus(input: RunInput, env: Record<string, string>, secrets: string[]): Promise<void> {
  const status = await runChecked(
    input,
    "supabase",
    ["status", "-o", "env", "--workdir", input.supabaseWorkdir],
    { cwd: input.cwd, capture: true, secrets },
    secrets,
  );
  let parsed: { url: string; publishable: string; secret: string };
  try {
    parsed = parseStatusEnv(status.stdout);
  } catch {
    throw new Error("Could not read the local Supabase URL and keys");
  }
  env.NEXT_PUBLIC_SUPABASE_URL = parsed.url;
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = parsed.publishable;
  env.SUPABASE_SECRET_KEY = parsed.secret;
  secrets.push(parsed.url, parsed.publishable, parsed.secret);
}

async function localMigrate(input: RunInput, secrets: string[]): Promise<void> {
  const workdir = input.supabaseWorkdir;
  if (input.dryRun) {
    input.log(`would run: supabase start --workdir ${workdir} --yes`);
    input.log(`would run: supabase migration up --local --workdir ${workdir} --yes --include-all`);
    return;
  }
  await runChecked(input, "supabase", ["start", "--workdir", workdir, "--yes"], { cwd: input.cwd, capture: true, secrets }, secrets);
  const migrated = await runChecked(
    input,
    "supabase",
    ["migration", "up", "--local", "--workdir", workdir, "--yes", "--include-all"],
    { cwd: input.cwd, capture: true, secrets },
    secrets,
  );
  input.log("supabase start finished");
  const notes = safeCliLines(`${migrated.stdout}\n${migrated.stderr}`);
  if (notes) input.log(notes);
}

async function hostedMigrate(input: RunInput, answers: Record<string, string>, secrets: string[]): Promise<void> {
  const raw = (answers.SUPABASE_DB_URL ?? "").trim();
  if (!raw) {
    input.log(input.dryRun ? "would skip migrations (no database URL)" : "migrations skipped (no database URL)");
    return;
  }
  const { url, password } = splitDbUrl(raw);
  if (password) secrets.push(password);
  secrets.push(raw);
  const env: Record<string, string> = {};
  if (password) {
    env.PGPASSWORD = password;
    env.SUPABASE_DB_PASSWORD = password;
  } else if (answers.SUPABASE_DB_PASSWORD) {
    env.PGPASSWORD = answers.SUPABASE_DB_PASSWORD;
    env.SUPABASE_DB_PASSWORD = answers.SUPABASE_DB_PASSWORD;
  }
  if (input.dryRun) {
    input.log("would run: supabase db push --db-url <hidden> --yes");
    return;
  }
  await runChecked(
    input,
    "supabase",
    ["db", "push", "--db-url", url, "--yes", "--workdir", input.supabaseWorkdir],
    { cwd: input.cwd, env, secrets },
    secrets,
  );
}

async function pushVercel(input: RunInput, env: Record<string, string>, answers: Record<string, string>, secrets: string[]): Promise<void> {
  const project = (answers.VERCEL_PROJECT ?? "").trim();
  if (!project) throw new Error("Missing VERCEL_PROJECT");
  const names = APP_KEYS.map((key) => key.name).filter((name) => env[name]);
  for (const target of ["production", "preview"] as const) {
    for (const name of names) {
      if (input.dryRun) {
        input.log(`would run: vercel env add ${name} ${target}`);
        continue;
      }
      const value = env[name];
      const sensitive = name.startsWith("NEXT_PUBLIC_") ? [] : ["--sensitive"];
      const args = ["env", "add", name, target, "--yes", "--force", "--project", project, "--non-interactive", ...sensitive];
      const result = await input.runner.spawn("vercel", args, { cwd: input.cwd, input: value, capture: true, secrets });
      if (result.code !== 0 && sensitive.length) {
        const retry = await input.runner.spawn("vercel", args.filter((arg) => arg !== "--sensitive"), {
          cwd: input.cwd,
          input: value,
          capture: true,
          secrets,
        });
        if (retry.code !== 0) throw new Error(`Could not set ${name} on ${target}\n${redactText(retry.stderr, secrets)}`);
        input.log(`set ${name} on ${target}`);
        continue;
      }
      if (result.code !== 0) throw new Error(`Could not set ${name} on ${target}\n${redactText(result.stderr, secrets)}`);
      input.log(`set ${name} on ${target}`);
    }
  }
}

async function askAll(prompt: Prompt | undefined): Promise<Record<string, string>> {
  if (!prompt) throw new Error("No terminal. Run with --answers <file>");
  const option = parseOption(await prompt({ name: "OPTION", label: "Where will this copy run? local, vps, or vercel: ", mask: false }));
  const answers: Record<string, string> = { OPTION: option };
  const origin = await prompt({
    name: "ORIGIN",
    label: option === "local" ? "Site URL [http://localhost:3000]: " : "Site URL (https://your-hydra.example.com): ",
    mask: false,
  });
  if (origin) answers.ORIGIN = origin;
  answers.HYDRA_OWNER_EMAIL = await prompt({ name: "HYDRA_OWNER_EMAIL", label: "Your email. Only this account can sign in: ", mask: false });
  if (option === "vps") {
    answers.HYDRA_DOMAIN = await prompt({ name: "HYDRA_DOMAIN", label: "Domain name for HTTPS (your-hydra.example.com): ", mask: false });
  }
  if (option === "vercel") {
    answers.VERCEL_PROJECT = await prompt({ name: "VERCEL_PROJECT", label: "Vercel project name: ", mask: false });
  }
  if (option !== "local") {
    for (const name of SUPABASE_NAMES) {
      const spec = APP_KEYS.find((key) => key.name === name)!;
      answers[name] = await prompt({ name, label: `${spec.prompt}: `, mask: spec.mask });
    }
    answers.SUPABASE_DB_URL = await prompt({
      name: "SUPABASE_DB_URL",
      label: "Database URL for migrations. Empty skips migrations. Hidden as you type: ",
      mask: true,
    });
  }
  for (const spec of APP_KEYS) {
    if (spec.required || spec.generated) continue;
    if (spec.name === "VAPID_SUBJECT") continue;
    const value = await prompt({ name: spec.name, label: `${spec.prompt}: `, mask: spec.mask });
    if (value) answers[spec.name] = value;
  }
  return answers;
}

function safeCliLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Applying migration ") || line === "Local database is up to date")
    .join("\n");
}

function redactCli(text: string, secrets: string[]): string {
  const hidden = redactText(text, secrets)
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "***")
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "***");
  return hidden
    .split("\n")
    .filter((line) => !/publishable|secret key|service_role|anon key|jwt secret|access key|postgresql:\/\//i.test(line))
    .join("\n");
}

async function runChecked(input: RunInput, cmd: string, args: string[], opts: SpawnOpts, secrets: string[]): Promise<SpawnResult> {
  const result = await input.runner.spawn(cmd, args, opts);
  if (result.code !== 0) {
    const detail = redactCli(`${result.stderr}\n${result.stdout}`, secrets).trim();
    throw new Error(detail ? `command failed: ${cmd} ${args[0] ?? ""}\n${detail}` : `command failed: ${cmd}`);
  }
  return result;
}

export const generatedNames = GENERATED;
