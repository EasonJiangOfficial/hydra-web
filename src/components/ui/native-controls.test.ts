import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The owner (2026-11-21): "all dropdowns and calendar components need to be custom, not the defualt google
 * or apple components". This fails when a native date, time or datetime input, a native select (or the old
 * NativeSelect), a native checkbox, a datalist or a colour, radio or range input shows up in the app. Use
 * Select, DatePicker, TimePicker, DateTimePicker, Checkbox and Combobox from src/components/ui. A native checkbox with role="switch" is a switch and
 * stays.
 */

const ROOT = join(__dirname, "..", "..", "..");
const SRC = join(ROOT, "src");

const NATIVE: { name: string; re: RegExp }[] = [
  { name: "date input", re: /type=\{?["'`](date|time|datetime-local|month|week)["'`]\}?/ },
  { name: "native select", re: /<select\b/ },
  { name: "NativeSelect", re: /<NativeSelect\b/ },
  { name: "checkbox", re: /type=\{?["'`]checkbox["'`]\}?/ },
  // <input list> + <datalist> opens the browser's own suggestion dropdown: use Combobox.
  { name: "datalist", re: /<datalist\b|\slist=[{"'`]/ },
  // The OS colour panel, radio dots and slider: none are Hydra controls.
  { name: "other native input", re: /type=\{?["'`](color|radio|range)["'`]\}?/ },
];

/** Lines still allowed, as a count per file and pattern. Remove an entry when its line goes. */
const ALLOWED: Record<string, Partial<Record<string, number>>> = {};

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx") ? [p] : [];
  });
}

/** The lines of the JSX element that line `i` is in: back to its `<Tag`, on to its `>` or `/>`. */
function elementAt(lines: string[], i: number): string {
  let start = i;
  while (start > 0 && !/<[A-Za-z]/.test(lines[start])) start--;
  let end = i;
  while (end < lines.length - 1 && !/(^|[^=])>\s*$/.test(lines[end]) && !lines[end].includes("/>")) end++;
  return lines.slice(start, end + 1).join("\n");
}

/** Lines of code only: comment lines are skipped, so a doc comment may name the native control it replaces. */
function hits(text: string) {
  const lines = text.split("\n");
  const out: { name: string; line: number; text: string }[] = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
    for (const { name, re } of NATIVE) {
      if (!re.test(raw)) continue;
      // A switch is a checkbox underneath with role="switch" on the same element; it stays a switch.
      if (name === "checkbox" && elementAt(lines, i).includes('role="switch"')) continue;
      out.push({ name, line: i + 1, text: t });
    }
  });
  return out;
}

describe("no native dropdowns, date pickers or checkboxes", () => {
  it("every control in src is a Hydra control", () => {
    const problems: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const rel = relative(ROOT, file).split("\\").join("/");
      const found = hits(readFileSync(file, "utf8"));
      const byName = new Map<string, typeof found>();
      for (const h of found) byName.set(h.name, [...(byName.get(h.name) ?? []), h]);
      for (const [name, list] of byName) {
        const allowed = ALLOWED[rel]?.[name] ?? 0;
        if (list.length > allowed) problems.push(...list.map((h) => `${rel}:${h.line} ${name}: ${h.text}`));
      }
    }
    expect(problems, "Use Select, DatePicker, TimePicker, DateTimePicker or Checkbox from src/components/ui").toEqual([]);
  });

  it("catches each pattern", () => {
    expect(hits('<Input type="date" value={x} />').map((h) => h.name)).toEqual(["date input"]);
    expect(hits('<input type="time" />').map((h) => h.name)).toEqual(["date input"]);
    expect(hits('<input type="datetime-local" />').map((h) => h.name)).toEqual(["date input"]);
    expect(hits("<select value={v}>").map((h) => h.name)).toEqual(["native select"]);
    expect(hits("<NativeSelect value={v}>").map((h) => h.name)).toEqual(["NativeSelect"]);
    expect(hits('<input type="checkbox" checked />').map((h) => h.name)).toEqual(["checkbox"]);
    expect(hits('<input\n  type="checkbox"\n  role="switch"\n/>')).toEqual([]);
    expect(hits(' * Drop-in for `<input type="date">`')).toEqual([]);
    expect(hits('<Input list={`${uid}-cats`} />').map((h) => h.name)).toEqual(["datalist"]);
    expect(hits('<Input\n  list="tax-payers"\n/>').map((h) => h.name)).toEqual(["datalist"]);
    expect(hits("<datalist id={x}>").map((h) => h.name)).toEqual(["datalist"]);
    expect(hits("<Combobox suggestions={list} />")).toEqual([]);
    expect(hits('<input type="color" />').map((h) => h.name)).toEqual(["other native input"]);
    expect(hits('<input type="radio" />').map((h) => h.name)).toEqual(["other native input"]);
  });

  it("a switch nearby does not excuse a real checkbox", () => {
    const text = ['<input type="checkbox" role="switch" />', "<span />", '<input type="checkbox" checked />'].join("\n");
    expect(hits(text).map((h) => h.line)).toEqual([3]);
    expect(hits('<input\n  type="checkbox"\n  onChange={(e) => set(e.target.checked)}\n  role="switch"\n/>')).toEqual([]);
  });
});
