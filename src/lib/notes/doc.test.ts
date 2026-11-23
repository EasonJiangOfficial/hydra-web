// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DOC_BYTES_MAX, docSchema, docToText, jsonbBytes, noteName, preview, storable, TEXT_MAX, textToDoc, type NoteDoc } from "./doc";

const t = (text: string) => [{ type: "text", text, styles: {} }];

/** One of every block the Notes editor makes, as BlockNote saves them. */
const EVERY: NoteDoc = [
  { id: "1", type: "heading", props: { level: 1 }, content: t("Trip"), children: [] },
  { id: "2", type: "heading", props: { level: 3 }, content: t("Packing"), children: [] },
  { id: "3", type: "paragraph", content: [...t("Book the "), { type: "link", href: "https://example.com", content: t("hotel") }], children: [] },
  { id: "4", type: "paragraph", content: [], children: [] },
  { id: "5", type: "bulletListItem", content: t("Passport"), children: [{ id: "5a", type: "bulletListItem", content: t("Visa"), children: [] }] },
  { id: "6", type: "numberedListItem", content: t("Pack"), children: [] },
  { id: "7", type: "numberedListItem", content: t("Leave"), children: [] },
  { id: "8", type: "checkListItem", props: { checked: true }, content: t("Charger"), children: [] },
  { id: "9", type: "checkListItem", props: { checked: false }, content: t("Socks"), children: [] },
  { id: "10", type: "toggleListItem", content: t("Details"), children: [{ id: "10a", type: "paragraph", content: t("Gate 4"), children: [] }] },
  { id: "11", type: "quote", content: t("Travel light"), children: [] },
  { id: "12", type: "codeBlock", props: { language: "bash" }, content: t("ls\npwd"), children: [] },
  { id: "13", type: "divider", children: [] },
  { id: "14", type: "table", content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: t("a") }, t("b")] }] }, children: [] },
];

describe("docToText", () => {
  it("reads every block type as one line with its mark, nested blocks indented", () => {
    expect(docToText(EVERY)).toBe(
      [
        "# Trip",
        "### Packing",
        "Book the hotel (https://example.com)",
        "- Passport",
        "  - Visa",
        "1. Pack",
        "2. Leave",
        "[x] Charger",
        "[ ] Socks",
        "▸ Details",
        "  Gate 4",
        "> Travel light",
        "```bash",
        "ls",
        "pwd",
        "```",
        "---",
        "a | b",
      ].join("\n"),
    );
  });

  it("never throws on a shape it does not know", () => {
    expect(docToText(null)).toBe("");
    expect(docToText("nope")).toBe("");
    expect(docToText([1, null, { type: "paragraph", content: "x" }, { type: "mystery", content: t("kept") }])).toBe("kept");
    // A link whose words are its URL is said once.
    expect(docToText([{ type: "paragraph", content: [{ type: "link", href: "https://a.b", content: t("https://a.b") }] }])).toBe("https://a.b");
  });

  it("stops at a deep nest instead of overflowing the stack", () => {
    let deep: NoteDoc = [{ type: "paragraph", content: t("bottom") }];
    for (let i = 0; i < 5000; i++) deep = [{ type: "paragraph", content: t(i === 4999 ? "top" : ""), children: deep }];
    expect(docToText(deep)).toBe("top");
  });
});

describe("textToDoc", () => {
  it("turns marked lines into blocks, and docToText reads them back", () => {
    const text = "# Groceries\n- oat milk\n1. eggs\n[x] bread\n> fresh\n---\n```js\nlet a\n```\nplain";
    const doc = textToDoc(text);
    expect(doc.map((b) => b.type)).toEqual(["heading", "bulletListItem", "numberedListItem", "checkListItem", "quote", "divider", "codeBlock", "paragraph"]);
    expect(doc[3].props).toEqual({ checked: true });
    expect(doc[6].props).toEqual({ language: "js" });
    expect(docToText(doc)).toBe("# Groceries\n- oat milk\n1. eggs\n[x] bread\n> fresh\n---\n```js\nlet a\n```\nplain");
  });

  it("keeps a code block whole through text and back: blank lines and the language", () => {
    const doc: NoteDoc = [{ type: "codeBlock", props: { language: "ts" }, content: t("a\n\nb") }];
    expect(docToText(doc)).toBe("```ts\na\n\nb\n```");
    expect(textToDoc(docToText(doc))).toEqual([{ type: "codeBlock", props: { language: "ts" }, content: t("a\n\nb") }]);
  });

  it("skips blank lines and reads a drawn note's plain words as paragraphs", () => {
    expect(textToDoc("Call Sam\r\n\r\nabout the deal")).toEqual([
      { type: "paragraph", content: t("Call Sam") },
      { type: "paragraph", content: t("about the deal") },
    ]);
    expect(textToDoc("")).toEqual([]);
  });
});

describe("names and previews", () => {
  it("previews the first line without its mark, cut to length", () => {
    expect(preview("\n# Trip\n- Passport")).toBe("Trip");
    expect(preview("[ ] Socks")).toBe("Socks");
    expect(preview("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
    // A first line that repeats the title is not shown twice.
    expect(preview("# Trip\n- Passport", 140, "trip")).toBe("Passport");
  });

  it("names a note by its title, its first line, or Untitled", () => {
    expect(noteName({ title: " Trip ", text: "a" })).toBe("Trip");
    expect(noteName({ title: "", text: "- Passport" })).toBe("Passport");
    expect(noteName({ title: "", text: "" })).toBe("Untitled");
  });
});

describe("docSchema", () => {
  it("takes a block array, refuses anything else or a doc over the size limit", () => {
    expect(docSchema.safeParse(EVERY).success).toBe(true);
    expect(docSchema.safeParse({ type: "paragraph" }).success).toBe(false);
    expect(docSchema.safeParse([{ content: [] }]).success).toBe(false);
    expect(docSchema.safeParse([{ type: "paragraph", content: t("x".repeat(1_000_000)) }]).success).toBe(false);
  });

  it("refuses blocks, inline content and styles the editor cannot open", () => {
    const bad: unknown[] = [
      [{ type: "image", props: { url: "https://x.test/a.png" } }],
      [{ type: "paragraph", content: [{ type: "text", text: "red", styles: { textColor: "red" } }] }],
      [{ type: "paragraph", content: [{ type: "link", href: "x", content: [{ type: "text", text: "l", styles: { backgroundColor: "red" } }] }] }],
      [{ type: "paragraph", content: [{ type: "mention", props: {} }] }],
      [{ type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "a", styles: { textColor: "red" } }]] }] } }],
      [{ type: "heading", props: { level: 4 }, content: [] }],
      [{ type: "paragraph", children: [{ type: "video" }] }],
    ];
    for (const d of bad) expect(docSchema.safeParse(d).success, JSON.stringify(d)).toBe(false);
    expect(docSchema.safeParse([{ type: "paragraph", content: "plain words" }]).success).toBe(true);
  });

  it("measures the size as Postgres prints jsonb (a space after each : and ,), the database check's measure", () => {
    expect(jsonbBytes([])).toBe(2);
    expect(jsonbBytes({ a: 1, b: [1, 2] })).toBe('{"a": 1, "b": [1, 2]}'.length);
    expect(jsonbBytes([{ t: "é" }])).toBe('[{"t": "é"}]'.length + 1);
    // 4,900 editor paragraphs: under the cap as compact JSON, over it as jsonb text (refused here, not by the database).
    const para = (i: number) => ({ id: `b${i}`, type: "paragraph", props: { textAlignment: "left" }, content: [...t("ab"), { type: "text", text: "c", styles: { bold: true } }], children: [] });
    const big = Array.from({ length: 4900 }, (_, i) => para(i));
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeLessThan(DOC_BYTES_MAX);
    expect(docSchema.safeParse(big).success).toBe(false);
  });

  it("counts a number JSON writes with an exponent as Postgres prints it, in full, and keeps the doc", () => {
    // Postgres on the local stack: [1e21] prints as [1000000000000000000000] (24 bytes), [1.5e-7] as [0.00000015] (12).
    expect(jsonbBytes([1e21])).toBe(24);
    expect(jsonbBytes([1.5e-7])).toBe(12);
    expect(jsonbBytes([-2.5e30])).toBe(34);
    expect(jsonbBytes({ a: 1, start: 1e21 })).toBe('{"a": 1, "start": 1000000000000000000000}'.length);
    // A numbered list typed as "1000000000000000000000. " (BlockNote stores start = 1e21): the note still saves.
    expect(docSchema.safeParse([{ type: "numberedListItem", props: { start: 1e21 }, content: [] }]).success).toBe(true);
    // 3,600 props of 1e300: 223 KB by JSON's measure, 1.29 MB as jsonb text (over the 1 MB check): refused here.
    const props = (w: number) => Array.from({ length: 3600 }, () => ({ type: "paragraph", props: { w } }));
    expect(jsonbBytes(props(1e300))).toBeGreaterThan(DOC_BYTES_MAX);
    expect(docSchema.safeParse(props(1e300)).success).toBe(false);
    expect(docSchema.safeParse([{ type: "paragraph", props: { w: 0.000001, n: 123456789012345680000, l: 2 } }]).success).toBe(true);
  });
});

describe("storable", () => {
  it("drops U+0000 and mends lone surrogates (Postgres refuses both) in every string and key", () => {
    const doc = [{ type: "paragraph", props: { "a\0b": "x\0y" }, content: [{ type: "text", text: "half \ud83d emoji, whole 😀, nul\0", styles: {} }] }];
    expect(storable(doc)).toEqual([{ type: "paragraph", props: { ab: "xy" }, content: [{ type: "text", text: "half \ufffd emoji, whole 😀, nul", styles: {} }] }]);
    expect(storable("T\0itle")).toBe("Title");
    expect(storable(3)).toBe(3);
  });
});

describe("the text cut", () => {
  it("never splits an emoji at TEXT_MAX or in the preview (Postgres refuses a lone surrogate)", () => {
    const text = docToText([{ type: "paragraph", content: [{ type: "text", text: `a${"😀".repeat(TEXT_MAX)}`, styles: {} }] }]);
    expect(text.isWellFormed()).toBe(true);
    expect(text.length).toBe(TEXT_MAX - 1);
    expect(preview(`a${"😀".repeat(10)}`, 3)).toBe("a…");
  });
});
