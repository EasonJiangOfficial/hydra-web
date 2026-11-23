/** Hide known secret values and any KEY= / SECRET= / PASSWORD= / TOKEN= line. */

const SECRET_ASSIGN =
  /(?:^|.*?)([A-Z0-9_]*(?:KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL)[A-Z0-9_]*)=(.*)$/;

export function redactText(text: string, secrets: readonly string[]): string {
  const long = secrets.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  const short = secrets.filter((s) => s.length > 0 && s.length < 4);
  return text
    .split("\n")
    .map((line) => {
      let out = line;
      for (const value of long) out = out.split(value).join("***");
      if (SECRET_ASSIGN.test(out)) out = out.replace(SECRET_ASSIGN, (_all, name: string) => `${name}=***`);
      for (const value of short) {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(new RegExp(`(^|[\\s=:"'])${escaped}(?=$|[\\s"'])`, "g"), "$1***");
      }
      return out;
    })
    .join("\n");
}
