import { describe, expect, it } from "vitest";
import { LOGO_MAX_BYTES, logoFileProblem, logoObjectPath } from "@/lib/ugc/logo";

describe("deal logo checks (the deal-logos bucket limits)", () => {
  it.each([
    { type: "image/png", size: 1_000, ok: true },
    { type: "image/jpeg", size: LOGO_MAX_BYTES, ok: true },
    { type: "image/webp", size: 5, ok: true },
    { type: "image/gif", size: 5, ok: true },
    { type: "image/svg+xml", size: 5, ok: false },
    { type: "application/pdf", size: 5, ok: false },
    { type: "image/png", size: 0, ok: false },
    { type: "image/png", size: LOGO_MAX_BYTES + 1, ok: false },
  ])("$type, $size bytes: ok=$ok", ({ type, size, ok }) => {
    expect(logoFileProblem({ type, size }) === null).toBe(ok);
  });

  it("stores each upload at a new path under the deal", () => {
    expect(logoObjectPath("d1", "image/jpeg", "r1")).toBe("deals/d1/r1.jpg");
    expect(logoObjectPath("d1", "image/png")).toMatch(/^deals\/d1\/[0-9a-f-]{36}\.png$/);
  });
});
