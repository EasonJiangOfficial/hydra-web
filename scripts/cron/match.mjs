/** Five-field cron match in UTC. Enough for the schedules in vercel.json. */

export function fieldMatches(field, value) {
  return field.split(",").some((part) => partMatches(part, value));
}

function partMatches(part, value) {
  const [base, stepText] = part.split("/");
  const step = stepText ? Number(stepText) : 1;
  if (!Number.isInteger(step) || step < 1) return false;
  if (base === "*") return value % step === 0;
  if (base.includes("-")) {
    const [start, end] = base.split("-").map(Number);
    return value >= start && value <= end && (value - start) % step === 0;
  }
  return Number(base) === value && (stepText ? value % step === 0 : true);
}

/** @param {string} expr @param {Date} date */
export function cronMatches(expr, date) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron needs 5 fields");
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  return fields.every((field, index) => fieldMatches(field, values[index]));
}

/** @param {{ path: string, schedule: string }[]} jobs @param {Date} date */
export function dueJobs(jobs, date) {
  return jobs.filter((job) => cronMatches(job.schedule, date));
}
