// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const saveNote = vi.hoisted(() => vi.fn(async () => ({ ok: true, note: { id: "n", updated_at: "v2" } })));
vi.mock("server-only", () => ({}));
vi.mock("@/app/(app)/notes/actions", () => ({ saveNote }));

const { POST } = await import("./route");
const req = (body: string, type = "application/json") => new Request("https://hydra.example/api/notes/save", { method: "POST", headers: { "content-type": type }, body });

describe("POST /api/notes/save (the tab-hiding save)", () => {
  it("passes the save to saveNote (which checks the owner and the input) and answers its outcome", async () => {
    const r = await POST(req(JSON.stringify({ id: "n", patch: { title: "T" }, expected: "v1" })));
    expect(await r.json()).toEqual({ ok: true, note: { id: "n", updated_at: "v2" } });
    expect(saveNote).toHaveBeenCalledWith("n", { title: "T" }, "v1");
  });

  it("refuses anything but JSON (a cross-site form cannot send it)", async () => {
    saveNote.mockClear();
    const r = await POST(req("id=n", "application/x-www-form-urlencoded"));
    expect(r.status).toBe(400);
    expect(saveNote).not.toHaveBeenCalled();
  });
});
