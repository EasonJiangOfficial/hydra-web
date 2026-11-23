import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Hydra Desktop and the phone app sign in with the code: a link only works in the browser that asked for it.
describe("sign-in email", () => {
  const html = readFileSync("supabase/templates/magic-link.html", "utf8");
  const config = readFileSync("supabase/config.toml", "utf8");

  it("holds the 6-digit code and no link (a link opened in another browser uses the code up)", () => {
    expect(html).toContain("{{ .Token }}");
    expect(html).not.toContain("ConfirmationURL");
    expect(html).not.toContain("TokenHash");
  });

  it("is the template Supabase sends for sign-in", () => {
    expect(config).toMatch(/\[auth\.email\.template\.magic_link\]\s*\nsubject = "Your Hydra code"\s*\ncontent_path = "\.\/supabase\/templates\/magic-link\.html"/);
  });
});
