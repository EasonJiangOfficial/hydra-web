// @vitest-environment node
import { describe, expect, it } from "vitest";
import { landed } from "./wizard-core";

describe("landed (the wizard's logo upload after the deal exists, RM-07)", () => {
  it("is true only when the write landed; a refusal or a throw is a failure the deal panel shows", async () => {
    expect(await landed(async () => ({ ok: true }))).toBe(true);
    expect(await landed(async () => ({ ok: false }))).toBe(false);
    expect(await landed(async () => Promise.reject(new Error("network")))).toBe(false);
  });
});
