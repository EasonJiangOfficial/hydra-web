import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ColorDot, ColorPicker, ColorPill } from "./color-picker";

afterEach(cleanup);

const setup = (value: string | null, allowNone = false) => {
  const onChange = vi.fn();
  render(<ColorPicker value={value} onChange={onChange} label="Blocked" allowNone={allowNone} />);
  return { onChange, user: userEvent.setup() };
};

describe("ColorPicker", () => {
  it("opens on the picked swatch, ringed and named", async () => {
    const { user } = setup("#4f7cb8");
    await user.click(screen.getByRole("button", { name: "Color for Blocked: Blue" }));
    const blue = screen.getByRole("radio", { name: "Blue" });
    expect(blue).toHaveFocus();
    expect(blue).toHaveAttribute("aria-checked", "true");
    expect(blue.className).toContain("ring-ink");
    expect(screen.getAllByRole("radio")).toHaveLength(18);
  });

  it("arrows move, Enter picks", async () => {
    const { user, onChange } = setup("#8e8e93");
    await user.click(screen.getByRole("button", { name: /Color for Blocked/ }));
    expect(screen.getByRole("radio", { name: "Gray" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Silver" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Green" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Purple" })).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("radio", { name: "Gray" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("radio", { name: "Purple" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("#8466ae");
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("Escape closes without a change; picking the same color saves nothing", async () => {
    const { user, onChange } = setup("#8e8e93");
    await user.click(screen.getByRole("button", { name: /Color for Blocked/ }));
    await user.keyboard("{ArrowRight}{Escape}");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Color for Blocked/ }));
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the hovered color's name, to sighted users only (the radio already announces it)", async () => {
    const { user } = setup("#8e8e93");
    await user.click(screen.getByRole("button", { name: /Color for Blocked/ }));
    await user.hover(screen.getByRole("radio", { name: "Amber" }));
    const name = screen.getByText("Amber");
    expect(name).toHaveAttribute("aria-hidden", "true");
    expect(name).not.toHaveAttribute("aria-live");
    expect(document.querySelector("[aria-live]")).toBeNull();
  });

  it("names a seeded gray and rings it", async () => {
    const { user } = setup("#c7c7cc");
    await user.click(screen.getByRole("button", { name: "Color for Blocked: Mist" }));
    expect(screen.getByRole("radio", { name: "Mist" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: "Custom color" })).toHaveValue("");
  });

  it("the trigger is a 24 px target, larger on touch, with a small dot inside", () => {
    setup("#4f7cb8");
    const trigger = screen.getByRole("button", { name: /Color for Blocked/ });
    expect(trigger.className).toContain("size-6");
    expect(trigger.className).toContain("pointer-coarse:after:-inset-2");
    expect(trigger.firstElementChild?.className).toContain("size-2.5");
  });

  it("takes a custom hex, refuses a bad one, and clears to None when allowed", async () => {
    const { user, onChange } = setup(null, true);
    await user.click(screen.getByRole("button", { name: "Color for Blocked: None" }));
    const field = screen.getByRole("textbox", { name: "Custom color" });
    await user.type(field, "zz{Enter}");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(onChange).not.toHaveBeenCalled();
    await user.clear(field);
    await user.type(field, "#ABC{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("#aabbcc");
  });

  it("None clears a color", async () => {
    const { user, onChange } = setup("#4f7cb8", true);
    await user.click(screen.getByRole("button", { name: /Color for Blocked/ }));
    await user.click(screen.getByRole("button", { name: "None" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });
});

describe("ColorDot", () => {
  it("renders nothing without a color, or an empty slot of the same size with reserve", () => {
    const { container, rerender } = render(<ColorDot color={null} />);
    expect(container.firstChild).toBeNull();
    rerender(<ColorDot color={null} reserve />);
    const slot = container.firstElementChild as HTMLElement;
    expect(slot.className).toContain("size-2");
    expect(slot.style.background).toBe("");
    rerender(<ColorDot color="#4f7cb8" reserve />);
    expect((container.firstElementChild as HTMLElement).dataset.colorDot).toBe("#4f7cb8");
  });
});

describe("ColorPill", () => {
  it("tints its background and darkens its text", () => {
    render(<ColorPill color="#4f7cb8">Urgent</ColorPill>);
    const pill = screen.getByText("Urgent");
    expect(pill.style.background).not.toBe("");
    expect(pill.style.color).not.toBe("");
  });
});
