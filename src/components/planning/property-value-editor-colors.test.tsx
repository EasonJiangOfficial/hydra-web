import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The undo bar's server action reaches server-only code; a client render never calls it here.
vi.mock("@/lib/activity/actions", () => ({ undoActivity: vi.fn() }));

import { fixtureSnapshot } from "@/lib/planning/fixtures";
import { createMemoryActions } from "@/lib/planning/memory-actions";
import type { PlanningProperty } from "@/lib/planning/properties";

import { PlanningProvider } from "./planning-store";
import { PropertyValueEditor } from "./property-value-editor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/planning",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

beforeAll(() => {
  // jsdom lacks matchMedia; the Hydra Select asks it whether to open as a phone sheet.
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
});

const snap = fixtureSnapshot(new Date("2026-11-21T15:00:00Z"));
const priority = snap.properties.find((p) => p.type === "select")!;
const task = { ...snap.tasks[0], values: {} };

function mount(property: PlanningProperty, compact = false) {
  return render(
    <PlanningProvider initial={{ ...snap, properties: [property] }} actions={createMemoryActions(snap).actions} now="2026-11-21T15:00:00Z">
      <PropertyValueEditor task={task} property={property} compact={compact} />
    </PlanningProvider>,
  );
}

describe("property value editor colors", () => {
  it("the drawer's select fills the row, and its dot slot is kept when there is no value", () => {
    mount(priority);
    // The Hydra Select's trigger is the combobox itself.
    const root = screen.getByRole("combobox", { name: `Priority of ${task.title}` });
    expect(root.className).toContain("flex-1");
    // No value, so no color: the slot is still there, and the select starts where a dotted one does.
    expect(root.previousElementSibling?.className).toContain("size-2");
  });

  it("a table cell keeps the dot slot too, so '—' rows line up with colored ones", () => {
    mount(priority, true);
    const root = screen.getByRole("combobox");
    expect(root.previousElementSibling?.className).toContain("size-2");
  });

  it("a multi-select checkbox is named by its option alone, not by the color button inside its label", () => {
    const tags: PlanningProperty = { ...priority, id: priority.id, name: "Tags", type: "multi_select" };
    mount(tags);
    for (const o of tags.options) {
      // jsdom drops the button from the name either way; browsers do not (Chromium: "Color for High: Charcoal High").
      expect(screen.getByRole("checkbox", { name: o.label })).toHaveAttribute("aria-label", o.label);
    }
  });
});
