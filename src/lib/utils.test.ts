import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("keeps Hydra type sizes next to colors", () => {
    expect(cn("text-label text-ink-3")).toBe("text-label text-ink-3");
  });
  it("lets a later type size win", () => {
    expect(cn("text-label", "text-tag")).toBe("text-tag");
  });
  it("lets a later color win", () => {
    expect(cn("text-ink-3", "text-neg")).toBe("text-neg");
  });
});
