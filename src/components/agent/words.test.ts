import { describe, expect, it } from "vitest";
import { eventStream, type AgentEvent } from "@/lib/agent/events";
import { internalHref, uiActionSchema } from "@/lib/agent/relay-schema";
import { afterWakePhrase, FILLERS, hasSleepWord, isEcho, isSafePath, normalizeSpoken, parseTurnEvent, parseUi, parseYesNo, pickFiller, readTurnStream, stripEmotes, takeSentences, wordCount } from "./words";

describe("afterWakePhrase and the turn event (0191)", () => {
  it("drops a leading wake phrase, keeps everything else", () => {
    expect(afterWakePhrase("Hey Hydra, and gas", "Hey Hydra")).toBe("and gas");
    expect(afterWakePhrase("hey hydra and gas", "Hey Hydra")).toBe("and gas");
    expect(afterWakePhrase("Okay Hydra.", "Okay Hydra")).toBe("");
    expect(afterWakePhrase("and gas, hey hydra", "Hey Hydra")).toBe("and gas, hey hydra");
    expect(afterWakePhrase("Hey there", "Hey Hydra")).toBe("Hey there");
  });
  it("parses the turn event; a bad id is dropped", () => {
    expect(parseTurnEvent({ type: "turn", turnId: "00000000-0000-4000-8000-0000000000f1" })).toEqual({ type: "turn", turnId: "00000000-0000-4000-8000-0000000000f1" });
    expect(parseTurnEvent({ type: "turn", turnId: "x" })).toBeNull();
  });
});

describe("emote tags (owner screenshot: \"[wave] Goodnight, sir.\")", () => {
  it("drops any [word] from text and speech, keeps the words and markdown links", () => {
    expect(stripEmotes("[wave] Goodnight, sir.")).toBe("Goodnight, sir.");
    expect(stripEmotes("Goodnight [wave].")).toBe("Goodnight.");
    expect(stripEmotes("Sure.[nod] Done [big smile] now")).toBe("Sure. Done now");
    expect(stripEmotes("See [the docs](/help) for $4.50")).toBe("See [the docs](/help) for $4.50");
  });
  it("a tag still streaming is dropped only for the final sentence", () => {
    expect(stripEmotes("Okay [wa")).toBe("Okay [wa");
    expect(stripEmotes("Okay [wa", true)).toBe("Okay");
  });
});

describe("fillers", () => {
  it("never the same one twice in a row, whatever the dice say", () => {
    for (const r of [0, 0.3, 0.6, 0.9999]) for (const last of FILLERS) expect(pickFiller(last, () => r)).not.toBe(last);
    let last: string | null = null;
    for (let i = 0; i < 200; i++) {
      const f = pickFiller(last);
      expect(f).not.toBe(last);
      expect(FILLERS).toContain(f);
      last = f;
    }
  });
});

describe("echo", () => {
  it("words Hydra itself said are its echo; any word of the owner's is not", () => {
    expect(isEcho("balance is forty", "Your balance is forty dollars.")).toBe(true);
    expect(isEcho("wait balance", "Your balance is forty dollars.")).toBe(false);
    expect(isEcho("", "anything")).toBe(false);
    expect(wordCount("hold on.")).toBe(2);
  });

  it("F7: a lossy recognition of Hydra's own money sentence is still its echo; the owner's words over it are not", () => {
    const said = "You've earned $3,525 this month.";
    expect(isEcho("you've earned three thousand five hundred", said)).toBe(true);
    expect(isEcho("you've earned 3525 this month", said)).toBe(true);
    expect(isEcho("you earned this mouth", said)).toBe(true); // one mis-heard word in four
    expect(isEcho("what about last month", said)).toBe(false);
    expect(isEcho("three hundred", "Your rent is due Friday.")).toBe(false); // no number said: number words are his
  });
});

describe("sleep word", () => {
  it("matches the word however the recognizer punctuates it", () => {
    for (const t of ["Hydra, sleep", "hydra sleep", "Hydra sleep.", "ok Hydra, sleep now"]) expect(hasSleepWord(t, "Hydra, sleep")).toBe(true);
  });
  it("does not match inside other words or half the phrase", () => {
    for (const t of ["hydra", "sleep", "the hydras sleeping", "put the hydra to sleep"]) expect(hasSleepWord(t, "Hydra, sleep")).toBe(false);
  });
  it("is a setting: another word works, an empty one never matches", () => {
    expect(hasSleepWord("Hydra go dark", "hydra go dark")).toBe(true);
    expect(hasSleepWord("anything", "")).toBe(false);
  });
  it("normalizes", () => expect(normalizeSpoken("  Hydra,  SLEEP! ")).toBe("hydra sleep"));
});

describe("yes and no", () => {
  it("hears whole-utterance answers", () => {
    for (const t of ["yes", "Yes.", "yeah", "Yes, please", "go ahead", "Do it!"]) expect(parseYesNo(t)).toBe("yes");
    for (const t of ["no", "No.", "nope", "decline", "don't", "no thanks"]) expect(parseYesNo(t)).toBe("no");
  });
  it("leaves a longer request alone, so a delete never rides on a stray word", () => {
    for (const t of ["yes and also delete the rest", "no wait add a coffee", "ok", "maybe", ""]) expect(parseYesNo(t)).toBeNull();
  });
});

describe("takeSentences", () => {
  it("returns whole sentences and keeps the tail", () => {
    expect(takeSentences("Opening Planning. Here is your we")).toEqual({ sentences: ["Opening Planning."], rest: " Here is your we" });
  });
  it("does not split inside a number", () => {
    expect(takeSentences("It was $4.50 today. Next")).toEqual({ sentences: ["It was $4.50 today."], rest: " Next" });
  });
  it("flushes the tail at the end of the turn", () => {
    expect(takeSentences("One. Two", true)).toEqual({ sentences: ["One.", "Two"], rest: "" });
  });
});

describe("isSafePath", () => {
  it("allows app paths", () => {
    for (const p of ["/", "/planning", "/planning?scope=ugc", "/reports#top", "/transactions?tx=abc-1"]) expect(isSafePath(p)).toBe(true);
  });
  it("refuses hosts, schemes, API and auth routes", () => {
    for (const p of ["//evil.com", "https://evil.com", "javascript:alert(1)", "/\\evil.com", "/api/plaid/webhook", "/auth/callback", "/login", "/API/x", "planning", 5]) expect(isSafePath(p)).toBe(false);
  });
  it("refuses tabs, newlines and other control characters the URL parser would drop", () => {
    for (const p of ["/\t/evil.example/x", "/\n/evil.example", "/\r/evil.example", "/\u0000/evil", "/ /evil.example", "/plan ning", "/\u0085x"]) expect(isSafePath(p)).toBe(false);
  });
  it("nit 9: is the server's navigate rule, so the Mac's posts and this window refuse the same paths", () => {
    const cases = ["/planning", "/api/agent/turn", "/auth/callback", "/login", "/x/../api/agent", "/%2e%2e/login", "//evil.com", `/${"a".repeat(600)}`];
    for (const p of cases) expect(internalHref.safeParse(p).success).toBe(isSafePath(p));
    for (const p of cases.slice(1)) expect(uiActionSchema.safeParse({ kind: "navigate", href: p }).success).toBe(false);
  });
});

describe("parseTurnEvent", () => {
  it("accepts the server's contract", () => {
    expect(parseTurnEvent({ type: "thread", threadId: "t1" })).toEqual({ type: "thread", threadId: "t1" });
    // Models: who answered; a bad effort drops the event, an unknown fallback drops only the fallback.
    expect(parseTurnEvent({ type: "model", model: "grok-4.7", effort: "high" })).toEqual({ type: "model", model: "grok-4.7", effort: "high" });
    expect(parseTurnEvent({ type: "model", model: "claude-opus-5-5", effort: "low", fallback: "server_claude_only" })).toEqual({ type: "model", model: "claude-opus-5-5", effort: "low", fallback: "server_claude_only" });
    expect(parseTurnEvent({ type: "model", model: "grok-4.7", effort: "high", fallback: "x" })).toEqual({ type: "model", model: "grok-4.7", effort: "high" });
    expect(parseTurnEvent({ type: "model", model: "grok-4.7", effort: "turbo" })).toBeNull();
    expect(parseTurnEvent({ type: "text", delta: "Hi" })).toEqual({ type: "text", delta: "Hi" });
    expect(parseTurnEvent({ type: "tool", name: "add", status: "done", summary: "Added" })).toEqual({ type: "tool", name: "add", status: "done", summary: "Added" });
    expect(parseTurnEvent({ type: "ui", action: { kind: "navigate", href: "/planning" } })).toEqual({ type: "ui", action: { kind: "navigate", href: "/planning" } });
    expect(parseTurnEvent({ type: "ui", action: { kind: "openPanel", param: "tx", value: "abc" } })).toEqual({ type: "ui", action: { kind: "openPanel", param: "tx", value: "abc" } });
    expect(parseTurnEvent({ type: "ui", action: { kind: "setScope", scope: "ugc" } })).toEqual({ type: "ui", action: { kind: "setScope", scope: "ugc" } });
    expect(parseTurnEvent({ type: "ui", action: { kind: "setScope", scope: "studio-co" } })).toEqual({ type: "ui", action: { kind: "setScope", scope: "studio-co" } });
    expect(parseTurnEvent({ type: "ui", action: { kind: "highlight", selector: "#a" } })).toEqual({ type: "ui", action: { kind: "highlight", selector: "#a" } });
    expect(parseTurnEvent({ type: "confirm", id: "c1", summary: "Delete?", danger: true })).toEqual({ type: "confirm", id: "c1", summary: "Delete?", danger: true });
    expect(parseTurnEvent({ type: "done", usage: {} })).toEqual({ type: "done" });
    expect(parseTurnEvent({ type: "error", message: "No" })).toEqual({ type: "error", message: "No" });
  });
  it("drops what is not the contract", () => {
    const bad: unknown[] = [
      null,
      "x",
      [],
      { type: "x" },
      { type: "text" },
      { type: "thread" },
      { type: "confirm", id: "c1", prompt: "old shape" },
      { type: "ui", action: "navigate", href: "/planning" },
      { type: "ui", action: { kind: "navigate", href: "//evil.com" } },
      { type: "ui", action: { kind: "openPanel", param: "evil", value: "1" } },
      { type: "ui", action: { kind: "openPanel", param: "tx", value: "a b" } },
      // Any entity slug is a scope (businesses, 0170); a scope that is not slug-shaped is not.
      { type: "ui", action: { kind: "setScope", scope: "All of it" } },
      { type: "ui", action: { kind: "setScope", scope: "-x" } },
    ];
    for (const v of bad) expect(parseTurnEvent(v)).toBeNull();
    expect(parseUi(undefined)).toBeNull();
  });
});

const body = (parts: string[]) => {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      parts.forEach((p) => c.enqueue(enc.encode(p)));
      c.close();
    },
  });
};
const all = async (b: ReadableStream<Uint8Array>) => {
  const out = [];
  for await (const ev of readTurnStream(b)) out.push(ev);
  return out;
};

describe("readTurnStream", () => {
  it("reassembles SSE frames split across chunks, skips junk, and reads a last frame without a blank line", async () => {
    const parts = ['data: {"type":"text","del', 'ta":"Hel"}\n\ndata: {"type":"text","delta":"lo"}\r\n\r\n', ": comment\n\ndata: not json\n\n", 'data: {"type":"do', 'ne"}'];
    expect(await all(body(parts))).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "done" },
    ]);
  });

  it("reads exactly what the server's eventStream writes", async () => {
    const sent: AgentEvent[] = [
      { type: "thread", threadId: "00000000-0000-4000-8000-000000000001" },
      { type: "text", delta: "Opening " },
      { type: "ui", action: { kind: "navigate", href: "/planning" } },
      { type: "tool", name: "navigate", status: "done", summary: "Opened /planning" },
      { type: "confirm", id: "00000000-0000-4000-8000-000000000002", summary: "Delete Costco?", danger: true },
      { type: "error", message: "Something went wrong" },
      { type: "done", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ];
    const res = eventStream(async (emit) => sent.forEach(emit));
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(await all(res.body!)).toEqual([...sent.slice(0, -1), { type: "done" }]);
  });
});
