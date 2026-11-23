import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { answeredBy, clampEffort, DEFAULT_MODEL, EFFORTS, effortsOf, MODEL_IDS, MODELS, modelsOf, providerOf } from "./models";

describe("the model catalog (models.ts)", () => {
  it("ids are unique, Opus 5.5 is the default, and every model has a provider and levels", () => {
    expect(new Set(MODEL_IDS).size).toBe(MODEL_IDS.length);
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(Object.keys(MODELS).sort()).toEqual([...MODEL_IDS].sort());
    expect(modelsOf("anthropic")).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(modelsOf("openai")).toEqual(["gpt-6.2-astra", "gpt-6.2-sol"]);
    expect(modelsOf("xai")).toEqual(["grok-4.7"]);
    expect(providerOf("claude-opus-4-1")).toBeNull();
  });

  it("each effort list is a subset of the database check (0070), in order, with no Off", () => {
    const sql = readFileSync("supabase/migrations/0070_agent.sql", "utf8");
    const check = /effort_live\s+text[^,]*check\s*\(effort_live in \(([^)]+)\)\)/i.exec(sql)?.[1];
    expect(check, "0070 has the effort check").toBeTruthy();
    const allowed = check!.split(",").map((v) => v.trim().replace(/'/g, ""));
    expect(allowed).toEqual([...EFFORTS]);
    for (const id of MODEL_IDS) {
      const levels = effortsOf(id);
      expect(levels.every((l) => allowed.includes(l))).toBe(true);
      expect([...levels]).toEqual(EFFORTS.filter((e) => levels.includes(e)));
    }
    expect(effortsOf("grok-4.7")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortsOf("claude-opus-5-5")).toEqual(EFFORTS);
  });

  it("clamp: an offered level stays; else the nearest level above it; else the model's highest", () => {
    expect(clampEffort("grok-4.7", "max")).toBe("xhigh");
    expect(clampEffort("gpt-6.2-sol", "max")).toBe("xhigh");
    expect(clampEffort("claude-opus-5-5", "xhigh")).toBe("xhigh");
    expect(clampEffort("claude-haiku-5-5", "max")).toBe("max");
    expect(clampEffort("grok-4.7", "low")).toBe("low");
    expect(clampEffort("unknown-model", "max")).toBe("max");
  });

  it("the reply hover names who answered, and why when it fell back", () => {
    expect(answeredBy({ model: "grok-4.7", effort: "high" })).toBe("Grok 4.7 · High");
    expect(answeredBy({ model: "claude-opus-5-5", effort: "xhigh", fallback: "not_connected" }, "grok-4.7")).toBe("Opus 5.5 · X-High. Grok 4.7 was not connected.");
    expect(answeredBy({ model: "claude-opus-5-5", effort: "low", fallback: "server_claude_only" }, "gpt-6.2-sol")).toBe("Opus 5.5 · Low. The server runs Claude only.");
  });
});
