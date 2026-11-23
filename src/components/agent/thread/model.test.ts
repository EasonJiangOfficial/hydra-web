import { describe, expect, it } from "vitest";
import type { AgentState } from "../controller";
import type { Message } from "../types";
import { partsOf, phaseOf, statusWord, stripEmotes, toThreadMessage } from "./model";

const base = { status: "thinking", thread: [] } as unknown as AgentState;
const hydra = (m: Partial<Message> & Record<string, unknown>) => ({ id: "h", role: "hydra", text: "", ...m }) as Message;

describe("the panel's read of the VOICE contract", () => {
  it("strips emote tags and keeps text", () => {
    expect(stripEmotes("[wave] Goodnight, sir.")).toBe("Goodnight, sir.");
    expect(partsOf(hydra({ text: "[wave] Hi [smile]there" }))).toEqual([{ kind: "text", text: "Hi there" }]);
  });

  it("reads parts defensively: bad parts drop, steps keep tool and status", () => {
    const m = hydra({ text: "x", parts: [{ kind: "step", text: "Looking", tool: "ugc", status: "running" }, { kind: "nope" }, null, { kind: "step", text: "s", status: "odd" }, { kind: "text", text: "" }] as unknown as Message["parts"] });
    expect(partsOf(m)).toEqual([{ kind: "step", text: "Looking", tool: "ugc", status: "running" }, { kind: "step", text: "s" }]);
  });

  it("derives phase without VOICE: thinking only while the reply is empty", () => {
    expect(phaseOf({ ...base, thread: [hydra({})] })).toBe("thinking");
    expect(phaseOf({ ...base, thread: [hydra({ text: "Hi" })] })).toBe("idle");
    expect(phaseOf({ ...base, phase: "checking" } as AgentState)).toBe("checking");
  });

  it("drops the working line once the controller's answer text streams, keeps links", () => {
    const step = { kind: "step" as const, text: "Looking", tool: "ugc", status: "running" as const };
    expect(phaseOf({ ...base, phase: "checking", thread: [hydra({ parts: [step] })] } as AgentState)).toBe("checking");
    expect(phaseOf({ ...base, phase: "thinking", thread: [hydra({ text: "You made", parts: [step, { kind: "text", text: "You made" }] })] } as AgentState)).toBe("idle");
    expect(stripEmotes("See [the doc](https://x.y) [nod]now")).toBe("See [the doc](https://x.y) now");
  });

  it("says Hey Hydra only while listening for the wake phrase", () => {
    expect(statusWord({ ...base, status: "listening", wakePhrase: true } as AgentState, "Listening")).toBe("Say “Hey Hydra”");
    expect(statusWord({ ...base, status: "speaking", wakePhrase: true } as AgentState, "Speaking")).toBe("Speaking");
  });

  it("maps steps to data-step parts for assistant-ui", () => {
    const like = toThreadMessage(hydra({ parts: [{ kind: "step", text: "a" }, { kind: "text", text: "b" }] }));
    expect(like.content).toEqual([{ type: "data-step", id: "h-s0", data: { text: "a", tool: null, status: "done" } }, { type: "text", text: "b" }]);
  });
});
