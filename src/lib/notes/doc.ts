import { z } from "zod";

/**
 * A note's document is the Notes editor's block JSON (BlockNote): an array of blocks, each
 * { type, props, content, children }. The server never runs the editor; it reads the JSON here to
 * derive the plain text (search, the agent, list previews) and builds blocks from plain text (a
 * device's drawn note, the agent's create and append). Shared by the page, the API and the tools.
 */

export type InlineText = { type: "text"; text: string; styles?: Record<string, unknown> };
export type InlineLink = { type: "link"; href: string; content: InlineText[] };
export type Block = {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: Block[];
};
export type NoteDoc = Block[];

export const SOURCES = ["web", "desktop", "phone", "routine", "mcp", "agent"] as const;
export type NoteSource = (typeof SOURCES)[number];

export const TITLE_MAX = 200;
export const TEXT_MAX = 200_000;
/**
 * The database refuses a doc whose jsonb text is over 1 MB (0210_notes.sql: octet_length(doc::text)).
 * Measured the same way here (jsonbBytes), with room to spare.
 */
export const DOC_BYTES_MAX = 950_000;
/** Deeper nesting is kept but not read: the walk stops here. */
const DEPTH_MAX = 32;

/** What the Notes editor's schema holds (block-editor.tsx): no files, no colors, headings 1 to 3. */
export const BLOCK_TYPES = ["paragraph", "heading", "quote", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "codeBlock", "table", "divider"] as const;
export const STYLES = ["bold", "italic", "underline", "strike", "code"] as const;
const blockTypes = new Set<string>(BLOCK_TYPES);
const styleKeys = new Set<string>(STYLES);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The bytes Postgres prints past JSON's for a number JSON writes with an exponent: jsonb prints it in full
 * (1e+21 is 1000000000000000000000, 1.5e-7 is 0.00000015; measured on the local stack).
 */
function longer(x: number): number {
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(String(x));
  if (!m) return 0;
  const digits = 1 + (m[3]?.length ?? 0);
  const k = Number(m[4]);
  return m[1].length + (k >= 0 ? Math.max(digits, k + 1) : 2 + (-k - 1) + digits) - m[0].length;
}

/**
 * Postgres text and jsonb refuse U+0000 and a lone UTF-16 surrogate: before a note is saved, U+0000 is
 * dropped from every string and key, and a lone surrogate becomes U+FFFD.
 */
export function storable<T>(v: T): T {
  const clean = (x: unknown): unknown => {
    if (typeof x === "string") return x.replaceAll("\0", "").toWellFormed();
    if (Array.isArray(x)) return x.map(clean);
    if (isObj(x)) return Object.fromEntries(Object.entries(x).map(([k, y]) => [clean(k), clean(y)]));
    return x;
  };
  return clean(v) as T;
}

/** Bytes of a JSON value as Postgres prints jsonb: JSON plus a space after every ':' and ',', and numbers in full. */
export function jsonbBytes(v: unknown): number {
  const seps = (x: unknown): number => {
    if (typeof x === "number") return longer(x);
    if (Array.isArray(x)) return Math.max(x.length - 1, 0) + x.reduce((n: number, y) => n + seps(y), 0);
    if (!isObj(x)) return 0;
    const vals = Object.values(x).filter((y) => y !== undefined);
    return Math.max(2 * vals.length - 1, 0) + vals.reduce((n: number, y) => n + seps(y), 0);
  };
  return new TextEncoder().encode(JSON.stringify(v)).length + seps(v);
}

/** Why the Notes editor could not open these blocks (it throws on a block type or style outside its schema), or null. */
function blockProblem(blocks: unknown, depth = 0): string | null {
  if (!Array.isArray(blocks)) return "children must be a block array";
  if (depth > DEPTH_MAX) return null;
  for (const b of blocks) {
    if (!isObj(b) || typeof b.type !== "string" || !blockTypes.has(b.type)) return `unknown block type ${isObj(b) ? JSON.stringify(b.type) : ""}`.trim();
    if (b.type === "heading" && isObj(b.props) && b.props.level !== undefined && ![1, 2, 3].includes(b.props.level as number)) return "headings are level 1 to 3";
    const content = b.type === "table" && isObj(b.content) && Array.isArray(b.content.rows) ? b.content.rows.flatMap((r) => (isObj(r) && Array.isArray(r.cells) ? r.cells : [])) : [b.content];
    for (const c of content) {
      const bad = inlineProblem(isObj(c) && c.type === "tableCell" ? c.content : c);
      if (bad) return bad;
    }
    if (b.children !== undefined) {
      const bad = blockProblem(b.children, depth + 1);
      if (bad) return bad;
    }
  }
  return null;
}

function inlineProblem(content: unknown): string | null {
  if (!Array.isArray(content)) return null; // a string, or no content
  for (const c of content) {
    if (typeof c === "string") continue;
    if (!isObj(c) || (c.type !== "text" && c.type !== "link")) return "inline content is text or links";
    if (c.type === "link") {
      const bad = inlineProblem(c.content);
      if (bad) return bad;
    } else if (isObj(c.styles) && Object.keys(c.styles).some((k) => !styleKeys.has(k))) return "styles are bold, italic, underline, strike and code";
  }
  return null;
}

/** A block array the Notes editor can open, within the database's size limit. */
export const docSchema = z
  .array(z.looseObject({ type: z.string().min(1).max(40) }))
  .max(10_000)
  .superRefine((d, ctx) => {
    const bad = blockProblem(d);
    if (bad) ctx.addIssue({ code: "custom", message: bad });
    else if (jsonbBytes(d) > DOC_BYTES_MAX) ctx.addIssue({ code: "custom", message: "The note is too long." });
  }) as unknown as z.ZodType<NoteDoc>;

/** The words of inline content: text, links as "words (url)". */
function inline(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (!isObj(c)) return "";
      if (c.type === "text") return typeof c.text === "string" ? c.text : "";
      if (c.type === "link") {
        const words = inline(c.content);
        const href = typeof c.href === "string" ? c.href : "";
        return href && words && words !== href ? `${words} (${href})` : words || href;
      }
      return inline(c.content);
    })
    .join("");
}

/** A table's rows as "a | b". Cells are inline arrays or { type: "tableCell", content }. */
function tableRows(content: unknown): string[] {
  if (!isObj(content) || !Array.isArray(content.rows)) return [];
  return content.rows.map((row) => {
    const cells = isObj(row) && Array.isArray(row.cells) ? row.cells : [];
    return cells.map((cell) => inline(isObj(cell) ? cell.content : cell)).join(" | ");
  });
}

/** Plain text of a document, one line per block, with markdown-like marks (#, -, 1., [x], >). */
export function docToText(doc: unknown): string {
  const lines: string[] = [];
  /** Lines inside code blocks: kept even when blank. */
  const code = new Set<number>();
  const walk = (blocks: unknown, depth: number) => {
    if (!Array.isArray(blocks) || depth > DEPTH_MAX) return;
    let n = 0;
    for (const b of blocks) {
      if (!isObj(b)) continue;
      const pad = "  ".repeat(depth);
      const props = isObj(b.props) ? b.props : {};
      const words = inline(b.content);
      n = b.type === "numberedListItem" ? n + 1 : 0;
      switch (b.type) {
        case "heading":
          lines.push(`${pad}${"#".repeat(Math.min(Math.max(Number(props.level) || 1, 1), 6))} ${words}`);
          break;
        case "bulletListItem":
          lines.push(`${pad}- ${words}`);
          break;
        case "numberedListItem":
          lines.push(`${pad}${n}. ${words}`);
          break;
        case "checkListItem":
          lines.push(`${pad}[${props.checked ? "x" : " "}] ${words}`);
          break;
        case "toggleListItem":
          lines.push(`${pad}▸ ${words}`);
          break;
        case "quote":
          lines.push(`${pad}> ${words}`);
          break;
        case "codeBlock":
          lines.push(`${pad}\`\`\`${typeof props.language === "string" && props.language !== "text" ? props.language : ""}`);
          for (const l of words.split("\n")) code.add(lines.push(pad + l) - 1);
          lines.push(`${pad}\`\`\``);
          break;
        case "divider":
          lines.push(`${pad}---`);
          break;
        case "table":
          lines.push(...tableRows(b.content).map((r) => pad + r));
          break;
        default:
          lines.push(pad + words);
      }
      walk(b.children, depth + 1);
    }
  };
  walk(doc, 0);
  // Empty paragraphs are spacing in the editor, not text; a blank line in code is code.
  return cut(lines.filter((l, i) => code.has(i) || l.trim()).join("\n"), TEXT_MAX);
}

/** The first `max` UTF-16 units, never half an emoji: Postgres refuses a lone surrogate. */
export function cut(s: string, max: number): string {
  const head = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

const words = (text: string): InlineText[] => (text ? [{ type: "text", text, styles: {} }] : []);

/** Blocks from plain text: one per line, with the same marks docToText writes (#, -, 1., [x], >, ---, ```). */
export function textToDoc(text: string): NoteDoc {
  const out: NoteDoc = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("```")) {
      const code: string[] = [];
      while (++i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i]);
      out.push({ type: "codeBlock", props: { language: line.slice(3).trim() || "text" }, content: words(code.join("\n")) });
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) out.push({ type: "heading", props: { level: m[1].length }, content: words(m[2]) });
    else if ((m = /^(?:[-*]\s+)?\[( |x|X)\]\s*(.*)$/.exec(line))) out.push({ type: "checkListItem", props: { checked: m[1] !== " " }, content: words(m[2]) });
    else if ((m = /^[-*•]\s+(.*)$/.exec(line))) out.push({ type: "bulletListItem", content: words(m[1]) });
    else if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) out.push({ type: "numberedListItem", content: words(m[1]) });
    else if ((m = /^▸\s+(.*)$/.exec(line))) out.push({ type: "toggleListItem", content: words(m[1]) });
    else if ((m = /^>\s?(.*)$/.exec(line))) out.push({ type: "quote", content: words(m[1]) });
    else if (/^(-{3,}|\*{3,})$/.test(line)) out.push({ type: "divider" });
    else out.push({ type: "paragraph", content: words(line) });
  }
  return out;
}

const bare = (line: string) =>
  line
    .trim()
    .replace(/^(#{1,6}|[-*•▸>]|\d+[.)]|\[[ xX]\])\s+/, "")
    .trim();

/** The first line of a note's text, without its mark: the list preview. A first line that repeats the title is skipped. */
export function preview(text: string, max = 140, title = ""): string {
  const skip = title.trim().toLowerCase();
  const line = text
    .split("\n")
    .map(bare)
    .find((l) => l && l.toLowerCase() !== skip) ?? "";
  return line.length > max ? `${cut(line, max - 1)}…` : line;
}

/** What a note is called: its title, else its first line, else "Untitled". */
export const noteName = (note: { title: string; text: string }) => note.title.trim() || preview(note.text, 60) || "Untitled";
