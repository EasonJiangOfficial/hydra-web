// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const planning = vi.hoisted(() => {
  const status = { id: "00000000-0000-4000-8000-0000000000a1", label: "Blocked", color: "#6e6e73", position: 1024, isDone: false };
  const option = { id: "00000000-0000-4000-8000-0000000000c1", label: "Urgent", color: "#1d1d1f", position: 0 };
  const property = { id: "00000000-0000-4000-8000-0000000000d1", name: "Priority", type: "select", options: [option] };
  return {
    status,
    option,
    property,
    loadPlanning: vi.fn(async () => ({
      ok: true,
      value: { statuses: [status], tasks: [], goals: [], events: [], properties: [property], categoryColors: { UGC: "#5f8a5b" }, timeZone: "America/Toronto" },
    })),
    setCategoryColor: vi.fn(async (category: string, color: string | null) => ({ ok: true, value: { category, color } })),
    updateStatus: vi.fn(async (id: string, patch: object) => ({ ok: true, value: { ...status, id, ...patch } })),
    updateOption: vi.fn(async (id: string, patch: object) => ({ ok: true, value: { ...option, id, ...patch } })),
    createOption: vi.fn(async (input: object) => ({ ok: true, value: { position: 1, ...input } })),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/planning/actions", () => ({
  loadPlanning: planning.loadPlanning,
  updateStatus: planning.updateStatus,
  updateOption: planning.updateOption,
  createOption: planning.createOption,
  setCategoryColor: planning.setCategoryColor,
}));
vi.mock("@/lib/bank/actions", () => ({}));
vi.mock("@/lib/rules/actions", () => ({}));
vi.mock("@/lib/ugc/actions", () => ({}));
vi.mock("@/lib/layout/actions", () => ({}));

const { executeTool } = await import("./tools");
const { memoryStore } = await import("./testing");
const { toolCtx } = await import("./fixtures");

describe("agent label color tools", () => {
  let mem: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    mem = memoryStore();
    vi.clearAllMocks();
  });

  it("update_status recolors a status and can be undone to the old color", async () => {
    const res = await executeTool("update_status", { id: planning.status.id, patch: { color: "#c0687a" } }, toolCtx(mem.store));
    expect(res.status).toBe("ok");
    expect(planning.updateStatus).toHaveBeenCalledWith(planning.status.id, { color: "#c0687a" });
    const inverse = mem.actions.at(-1)?.inverse as { input: { patch: Record<string, unknown> } } | undefined;
    // Only the field this call changed: undoing it must not revert a later rename.
    expect(inverse?.input.patch).toEqual({ color: "#6e6e73" });
  });

  it("update_status cannot flip done (that resets completion dates no undo restores)", async () => {
    const res = await executeTool("update_status", { id: planning.status.id, patch: { isDone: true } }, toolCtx(mem.store));
    expect(res.status).toBe("invalid");
    expect(planning.updateStatus).not.toHaveBeenCalled();
  });

  it("update_property_option recolors a tag", async () => {
    const res = await executeTool("update_property_option", { id: planning.option.id, patch: { color: "#4f7cb8" } }, toolCtx(mem.store));
    expect(res.status).toBe("ok");
    expect(planning.updateOption).toHaveBeenCalledWith(planning.option.id, { color: "#4f7cb8" });
    const inverse = mem.actions.at(-1)?.inverse as { input: { patch: Record<string, unknown> } } | undefined;
    expect(inverse?.input.patch).toEqual({ color: "#1d1d1f" });
  });

  it("add_property_option takes a color", async () => {
    const res = await executeTool("add_property_option", { propertyId: planning.property.id, label: "Later", color: "#5f8a5b" }, toolCtx(mem.store));
    expect(res.status).toBe("ok");
    expect(planning.createOption).toHaveBeenCalledWith(expect.objectContaining({ propertyId: planning.property.id, label: "Later", color: "#5f8a5b" }));
  });

  it("update_category_color colors a Planning category; its undo puts back the old color", async () => {
    const res = await executeTool("update_category_color", { category: "UGC", color: "#4f7cb8" }, toolCtx(mem.store));
    expect(res.status).toBe("ok");
    expect(planning.setCategoryColor).toHaveBeenCalledWith("UGC", "#4f7cb8");
    expect(mem.actions.at(-1)?.inverse).toEqual({ tool: "update_category_color", input: { category: "UGC", color: "#5f8a5b" } });
  });

  it("update_category_color on a category with no color undoes to none (null)", async () => {
    const res = await executeTool("update_category_color", { category: "Taxes", color: "#c29a2e" }, toolCtx(mem.store));
    expect(res.status).toBe("ok");
    expect(mem.actions.at(-1)?.inverse).toEqual({ tool: "update_category_color", input: { category: "Taxes", color: null } });
    // The undo itself is a valid call.
    expect((await executeTool("update_category_color", { category: "Taxes", color: null }, toolCtx(mem.store))).status).toBe("ok");
    expect(planning.setCategoryColor).toHaveBeenLastCalledWith("Taxes", null);
  });

  it("update_category_color refuses a bad color before any write", async () => {
    for (const color of ["red", "#fff", "javascript:x"]) {
      expect((await executeTool("update_category_color", { category: "UGC", color }, toolCtx(mem.store))).status, color).toBe("invalid");
    }
    expect(planning.setCategoryColor).not.toHaveBeenCalled();
  });

  it("refuses a color that is not #rrggbb before any write", async () => {
    for (const color of ["red", "#fff", "javascript:x"]) {
      expect((await executeTool("update_status", { id: planning.status.id, patch: { color } }, toolCtx(mem.store))).status, color).toBe("invalid");
      expect((await executeTool("update_property_option", { id: planning.option.id, patch: { color } }, toolCtx(mem.store))).status, color).toBe("invalid");
    }
    expect(planning.updateStatus).not.toHaveBeenCalled();
    expect(planning.updateOption).not.toHaveBeenCalled();
  });
});
