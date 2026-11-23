// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAnswers } from "./catalog.mts";
import { parseStatusEnv, splitDbUrl, writeSecretFile } from "./env-file.mts";
import { runSetup, type Runner } from "./flow.mts";
import { applyKey } from "./prompt.mts";
import { redactText } from "./redact.mts";

const PUB = "publishable-test-value";
const SECRET = "secret-test-value-not-printed";
const DBPASS = "db-password-not-for-argv";
const DBURL = `postgresql://postgres:${DBPASS}@db.example.com:5432/postgres`;
const EMAIL = "owner@example.test";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hydra-setup-"));
  dirs.push(dir);
  return dir;
}

function capture() {
  const lines: string[] = [];
  const calls: { cmd: string; args: string[]; input?: string; env?: Record<string, string> }[] = [];
  const runner: Runner = {
    async spawn(cmd, args, opts) {
      calls.push({ cmd, args, input: opts?.input, env: opts?.env });
      if (args[0] === "start") {
        return {
          code: 0,
          stdout: `Project URL │ http://127.0.0.1:56421\nPublishable │ ${PUB}\nSecret │ ${SECRET}\n`,
          stderr: "",
        };
      }
      if (args[0] === "status") {
        return {
          code: 0,
          stdout: `API_URL="http://127.0.0.1:56421"\nPUBLISHABLE_KEY="${PUB}"\nSECRET_KEY="${SECRET}"\n`,
          stderr: "",
        };
      }
      return { code: 0, stdout: "ok\n", stderr: "" };
    },
  };
  return { lines, log: (line: string) => lines.push(line), calls, runner };
}

function baseAnswers(option: string, extra = ""): string {
  return [
    `OPTION=${option}`,
    "ORIGIN=https://your-hydra.example.com",
    `HYDRA_OWNER_EMAIL=${EMAIL}`,
    `NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co`,
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${PUB}`,
    `SUPABASE_SECRET_KEY=${SECRET}`,
    extra,
  ]
    .filter(Boolean)
    .join("\n");
}

describe("secret handling", () => {
  it("masks typed secrets and does not echo them", () => {
    let value = "";
    let echo = "";
    for (const ch of "secret\n") {
      const next = applyKey(value, ch, true);
      value = next.value;
      echo += next.echo;
    }
    expect(value).toBe("secret");
    expect(echo).toBe("******\n");
    expect(echo).not.toContain("secret");
  });

  it("redacts values and assignment lines", () => {
    const text = `see ${SECRET} now\nSUPABASE_SECRET_KEY=${SECRET}\nAPI_URL=http://127.0.0.1:56421`;
    const out = redactText(text, [SECRET, "http://127.0.0.1:56421"]);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("56421");
    expect(out).toContain("SUPABASE_SECRET_KEY=***");
  });

  it("writes the env file as mode 0600", () => {
    const file = join(tempDir(), ".env");
    writeSecretFile(file, "HYDRA_TOKEN_KEY=abc\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rejects keys the app does not use", () => {
    expect(() => parseAnswers("OPTION=local\nINSTAGRAM_APP_SECRET=nope\n")).toThrow(/not used/);
    expect(() => parseAnswers("OPTION=local\nNOT_A_KEY=x\n")).toThrow(/Unknown answers key/);
  });

  it("keeps a database password out of the url", () => {
    const split = splitDbUrl(DBURL);
    expect(split.password).toBe(DBPASS);
    expect(split.url).not.toContain(DBPASS);
    expect(parseStatusEnv(`API_URL="http://127.0.0.1:56421"\nANON_KEY="${PUB}"\nSERVICE_ROLE_KEY="${SECRET}"\n`)).toEqual({
      url: "http://127.0.0.1:56421",
      publishable: PUB,
      secret: SECRET,
    });
  });
});

describe("setup options", () => {
  it("dry-runs local without writing or printing secrets", async () => {
    const dir = tempDir();
    const envFile = join(dir, ".env");
    const cap = capture();
    await runSetup({
      cwd: dir,
      answersText: "OPTION=local\nHYDRA_OWNER_EMAIL=owner@example.test\n",
      dryRun: true,
      envFile,
      supabaseWorkdir: dir,
      log: cap.log,
      runner: cap.runner,
    });
    const log = cap.lines.join("\n");
    expect(log).toContain("option local");
    expect(log).toContain("supabase start");
    expect(log).toContain("migration up");
    expect(log).toContain("bootstrap-owner.mts");
    expect(log).toContain("mode 0600");
    expect(log).toContain("/api/google/callback");
    expect(log).toContain("/api/instagram/callback");
    expect(log).not.toContain(EMAIL);
    expect(cap.calls).toHaveLength(0);
    expect(() => statSync(envFile)).toThrow();
  });

  it("dry-runs a VPS without putting the database password in the plan", async () => {
    const dir = tempDir();
    const cap = capture();
    await runSetup({
      cwd: dir,
      answersText: baseAnswers("vps", `HYDRA_DOMAIN=your-hydra.example.com\nSUPABASE_DB_URL=${DBURL}\n`),
      dryRun: true,
      envFile: join(dir, ".env"),
      supabaseWorkdir: dir,
      log: cap.log,
      runner: cap.runner,
    });
    const log = cap.lines.join("\n");
    expect(log).toContain("option vps");
    expect(log).toContain("db push");
    expect(log).toContain("docker compose up -d --build");
    expect(log).not.toContain(DBPASS);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(PUB);
    expect(cap.calls).toHaveLength(0);
  });

  it("dry-runs Vercel env names and does not print values", async () => {
    const dir = tempDir();
    const cap = capture();
    await runSetup({
      cwd: dir,
      answersText: baseAnswers("vercel", "VERCEL_PROJECT=hydra-test\nSKIP_MIGRATE=1\n"),
      dryRun: true,
      envFile: join(dir, ".env"),
      supabaseWorkdir: dir,
      log: cap.log,
      runner: cap.runner,
    });
    const log = cap.lines.join("\n");
    expect(log).toContain("would run: vercel env add SUPABASE_SECRET_KEY production");
    expect(log).toContain("would run: vercel env add SUPABASE_SECRET_KEY preview");
    expect(log).toContain("would run: vercel env add CRON_SECRET production");
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(EMAIL);
    expect(cap.calls).toHaveLength(0);
  });

  it("writes a local env file and does not print the keys", async () => {
    const dir = tempDir();
    const envFile = join(dir, ".env");
    const cap = capture();
    await runSetup({
      cwd: dir,
      answersText: baseAnswers("local", "SKIP_MIGRATE=1\nORIGIN=http://localhost:3000\n"),
      dryRun: false,
      envFile,
      supabaseWorkdir: dir,
      log: cap.log,
      runner: cap.runner,
    });
    const body = readFileSync(envFile, "utf8");
    const log = cap.lines.join("\n");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(body).toContain(SECRET);
    expect(body).toMatch(/^HYDRA_TOKEN_KEY=\S+$/m);
    expect(body).toMatch(/^CRON_SECRET=[0-9a-f]{64}$/m);
    expect(body).toMatch(/^VAPID_PUBLIC_KEY=\S+$/m);
    expect(body).toMatch(/^VAPID_PRIVATE_KEY=\S+$/m);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(PUB);
    expect(log).toContain("generated (not shown)");
    expect(cap.calls.some((call) => call.args.includes("scripts/bootstrap-owner.mts"))).toBe(true);
    const bootstrap = cap.calls.find((call) => call.args.includes("scripts/bootstrap-owner.mts"))!;
    expect(bootstrap.args.join(" ")).not.toContain(SECRET);
    expect(bootstrap.env?.SUPABASE_SECRET_KEY).toBe(SECRET);
    expect(cap.calls.some((call) => call.args[0] === "start")).toBe(false);
  });

  it("reads local Supabase status after migrations and does not print it", async () => {
    const dir = tempDir();
    const envFile = join(dir, ".env");
    const cap = capture();
    await runSetup({
      cwd: dir,
      answersText: "OPTION=local\nHYDRA_OWNER_EMAIL=owner@example.test\nORIGIN=http://localhost:3000\n",
      dryRun: false,
      envFile,
      supabaseWorkdir: dir,
      log: cap.log,
      runner: cap.runner,
    });
    const commands = cap.calls.map((call) => call.args[0]);
    expect(commands.indexOf("start")).toBeLessThan(commands.indexOf("status"));
    expect(commands.indexOf("migration")).toBeLessThan(commands.indexOf("status"));
    const body = readFileSync(envFile, "utf8");
    expect(body).toContain("http://127.0.0.1:56421");
    expect(body).toContain(SECRET);
    expect(cap.lines.join("\n")).not.toContain(SECRET);
    expect(cap.lines.join("\n")).not.toContain(PUB);
  });

  it("passes the database password only in the environment", async () => {
    const dir = tempDir();
    const cap = capture();
    await runSetup({
      cwd: dir,
      answersText: baseAnswers("vps", `HYDRA_DOMAIN=your-hydra.example.com\nSUPABASE_DB_URL=${DBURL}\n`),
      dryRun: false,
      envFile: join(dir, ".env"),
      supabaseWorkdir: dir,
      log: cap.log,
      runner: cap.runner,
    });
    const push = cap.calls.find((call) => call.args[0] === "db");
    expect(push).toBeTruthy();
    expect(push!.args.join(" ")).not.toContain(DBPASS);
    expect(push!.args).toContain("--db-url");
    expect(push!.env?.PGPASSWORD).toBe(DBPASS);
    expect(push!.env?.SUPABASE_DB_PASSWORD).toBe(DBPASS);
    expect(cap.lines.join("\n")).not.toContain(DBPASS);
    expect(readFileSync(join(dir, ".env"), "utf8")).not.toContain(DBPASS);
  });

  it("sends Vercel values on stdin, not in arguments", async () => {
    const dir = tempDir();
    const cap = capture();
    await runSetup({
      cwd: dir,
      answersText: baseAnswers("vercel", "VERCEL_PROJECT=hydra-test\nSKIP_MIGRATE=1\n"),
      dryRun: false,
      envFile: join(dir, ".env"),
      supabaseWorkdir: dir,
      log: cap.log,
      runner: cap.runner,
    });
    const adds = cap.calls.filter((call) => call.cmd === "vercel");
    expect(adds.length).toBeGreaterThan(0);
    const secretAdd = adds.find((call) => call.args.includes("SUPABASE_SECRET_KEY") && call.args.includes("production"));
    expect(secretAdd?.input).toBe(SECRET);
    expect(secretAdd?.args.join(" ")).not.toContain(SECRET);
    expect(cap.lines.join("\n")).not.toContain(SECRET);
    expect(cap.lines.join("\n")).toContain("set SUPABASE_SECRET_KEY on production");
    expect(cap.lines.join("\n")).toContain("set SUPABASE_SECRET_KEY on preview");
  });

  it("keeps an existing token key", async () => {
    const dir = tempDir();
    const envFile = join(dir, ".env");
    const cap = capture();
    const common = {
      cwd: dir,
      answersText: baseAnswers("local", "SKIP_MIGRATE=1\nORIGIN=http://localhost:3000\n"),
      dryRun: false,
      envFile,
      supabaseWorkdir: dir,
      runner: cap.runner,
    };
    await runSetup({ ...common, log: () => {} });
    const first = readFileSync(envFile, "utf8").match(/^HYDRA_TOKEN_KEY=(.*)$/m)![1];
    const lines: string[] = [];
    await runSetup({ ...common, log: (line) => lines.push(line) });
    const second = readFileSync(envFile, "utf8").match(/^HYDRA_TOKEN_KEY=(.*)$/m)![1];
    expect(second).toBe(first);
    expect(lines.join("\n")).toContain("kept existing generated secrets");
    expect(lines.join("\n")).not.toContain(first);
  });
});
