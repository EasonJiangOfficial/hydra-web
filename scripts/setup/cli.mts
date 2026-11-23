import { statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSetup } from "./flow.mts";
import { promptLine } from "./prompt.mts";
import { spawnCommand } from "./runner.mts";

type Flags = { answers?: string; dryRun: boolean; envFile?: string; supabaseWorkdir?: string };

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--answers") flags.answers = needValue(argv, ++i, arg);
    else if (arg === "--env-file") flags.envFile = needValue(argv, ++i, arg);
    else if (arg === "--supabase-workdir") flags.supabaseWorkdir = needValue(argv, ++i, arg);
    else if (arg === "--help" || arg === "-h") {
      console.log("pnpm hydra:setup -- [--answers <file>] [--dry-run] [--env-file <path>] [--supabase-workdir <path>]");
      process.exit(0);
    } else throw new Error(`Unknown argument ${arg}`);
  }
  return flags;
}

function needValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const cwd = process.cwd();
  let answersText: string | undefined;
  if (flags.answers) {
    const file = resolve(flags.answers);
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) console.error("Warning: answers file is readable by other users. chmod 600 the file.");
    answersText = readFileSync(file, "utf8");
  }
  await runSetup({
    cwd,
    answersText,
    dryRun: flags.dryRun,
    envFile: resolve(flags.envFile ?? ".env"),
    supabaseWorkdir: resolve(flags.supabaseWorkdir ?? cwd),
    log: (line) => console.log(line),
    runner: { spawn: spawnCommand },
    prompt: flags.answers
      ? undefined
      : async (q) => promptLine(q.label, q.mask),
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "setup failed";
  console.error(message);
  process.exit(1);
});
