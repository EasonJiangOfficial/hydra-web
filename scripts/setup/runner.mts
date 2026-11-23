import { spawn } from "node:child_process";
import { redactText } from "./redact.mts";

export type SpawnOpts = {
  env?: Record<string, string>;
  input?: string;
  /** Return stdout to the caller and do not print it. */
  capture?: boolean;
  cwd?: string;
  secrets?: string[];
};

export type SpawnResult = { code: number; stdout: string; stderr: string };

const BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT"] as const;

/** Run a command with no shell. Secret values stay out of the printed output. */
export async function spawnCommand(cmd: string, args: string[], opts: SpawnOpts = {}): Promise<SpawnResult> {
  const env = { NODE_ENV: process.env.NODE_ENV } as NodeJS.ProcessEnv;
  for (const key of BASE_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) env[key] = value;
  }
  const child = spawn(cmd, args, { cwd: opts.cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(opts.input ?? "");
  const [stdout, stderr, code] = await new Promise<[string, string, number]>((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve([Buffer.concat(out).toString("utf8"), Buffer.concat(err).toString("utf8"), status ?? 1]));
  });
  if (!opts.capture) {
    const secrets = opts.secrets ?? [];
    const printedOut = redactText(stdout, secrets);
    const printedErr = redactText(stderr, secrets);
    if (printedOut) process.stdout.write(printedOut.endsWith("\n") ? printedOut : `${printedOut}\n`);
    if (printedErr) process.stderr.write(printedErr.endsWith("\n") ? printedErr : `${printedErr}\n`);
  }
  return { code, stdout, stderr };
}
