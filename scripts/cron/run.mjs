import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dueJobs } from "./match.mjs";

/**
 * Call the vercel.json cron routes. Prints the path and status only.
 * CRON_SECRET is sent as a bearer token and is never printed.
 */
export async function tick(jobs, now, opts) {
  const fired = [];
  for (const job of dueJobs(jobs, now)) {
    const response = await opts.fetchFn(`${opts.origin}${job.path}`, {
      headers: { authorization: `Bearer ${opts.secret}` },
    });
    fired.push({ path: job.path, status: response.status });
  }
  return fired;
}

export function formatTick(fired) {
  return fired.map((item) => `${item.path} ${item.status}`).join("\n");
}

async function loop() {
  const secret = process.env.CRON_SECRET?.trim() ?? "";
  if (!secret) {
    console.error("Missing environment variable CRON_SECRET");
    process.exit(1);
  }
  const origin = (process.env.HYDRA_CRON_ORIGIN ?? "http://app:3000").replace(/\/$/, "");
  const here = dirname(fileURLToPath(import.meta.url));
  const jobs = JSON.parse(readFileSync(join(here, "vercel.json"), "utf8")).crons;
  let lastMinute = "";
  for (;;) {
    const now = new Date();
    const minute = now.toISOString().slice(0, 16);
    if (minute !== lastMinute) {
      lastMinute = minute;
      try {
        const fired = await tick(jobs, now, { origin, secret, fetchFn: fetch });
        const line = formatTick(fired);
        if (line) console.log(line);
      } catch {
        console.error("cron request failed");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
}

const invoked = process.argv[1]?.endsWith("run.mjs");
if (invoked) loop();
