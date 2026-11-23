/** One typed character. Masked input echoes a star, never the character. */
export function applyKey(value: string, ch: string, mask: boolean): { value: string; echo: string; done: boolean; cancel: boolean } {
  if (ch === "\u0003") return { value, echo: "", done: true, cancel: true };
  if (ch === "\r" || ch === "\n") return { value, echo: "\n", done: true, cancel: false };
  if (ch === "\u007f" || ch === "\b") {
    if (!value) return { value, echo: "", done: false, cancel: false };
    return { value: value.slice(0, -1), echo: mask ? "\b \b" : "\b \b", done: false, cancel: false };
  }
  if (ch < " " || ch === "\u001b") return { value, echo: "", done: false, cancel: false };
  return { value: value + ch, echo: mask ? "*" : ch, done: false, cancel: false };
}

export async function promptLine(label: string, mask: boolean): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) throw new Error("No terminal. Run with --answers <file>");
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    value = await new Promise((resolve, reject) => {
      const onData = (buf: Buffer) => {
        for (const ch of buf.toString("utf8")) {
          const next = applyKey(value, ch, mask);
          value = next.value;
          if (next.echo) stdout.write(next.echo);
          if (!next.done) continue;
          stdin.off("data", onData);
          if (next.cancel) reject(new Error("Cancelled"));
          else resolve(value);
          return;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    if (stdin.isTTY) stdin.setRawMode(false);
  }
  return value.trim();
}
