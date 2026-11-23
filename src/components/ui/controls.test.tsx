import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { calendarKey } from "./calendar";
import { Checkbox } from "./checkbox";
import { DatePicker, DateTimePicker, TimePicker } from "./date-picker";
import { typeAheadMatch } from "./picker";
import { Select, readOptions } from "./select";

afterEach(cleanup);

beforeAll(() => {
  // jsdom lacks these; Radix popper and the phone query need them.
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

function Controlled({ onPick, searchable }: { onPick: (v: string) => void; searchable?: boolean }) {
  const [v, setV] = useState("b");
  return (
    <Select
      aria-label="Fruit"
      searchable={searchable}
      value={v}
      onChange={(e) => {
        setV(e.target.value);
        onPick(e.target.value);
      }}
    >
      <option value="a">Apple</option>
      <option value="b">Banana</option>
      <option value="c" disabled>
        Cherry
      </option>
      <>
        <option value="d">Date</option>
      </>
      <optgroup label="Late">
        <option value="e">Elder</option>
      </optgroup>
    </Select>
  );
}

describe("Select", () => {
  it("reads option children like a native select", () => {
    const opts = readOptions(
      <>
        <option value="">None</option>
        {[1, 2].map((n) => (
          <option key={n} value={n}>
            Day {n}
          </option>
        ))}
        <optgroup label="G">
          <option value="x" disabled>
            X
          </option>
        </optgroup>
      </>,
    );
    expect(opts).toEqual([
      { value: "", label: "None", disabled: false, group: undefined },
      { value: "1", label: "Day 1", disabled: false, group: undefined },
      { value: "2", label: "Day 2", disabled: false, group: undefined },
      { value: "x", label: "X", disabled: true, group: "G" },
    ]);
  });

  it("opens on ArrowDown, skips disabled rows, Enter picks, focus returns to the field", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<Controlled onPick={onPick} />);
    const field = screen.getByRole("combobox", { name: "Fruit" });
    expect(field).toHaveTextContent("Banana");
    field.focus();
    await user.keyboard("{ArrowDown}");
    const list = await screen.findByRole("listbox");
    expect(list).toHaveFocus();
    expect(screen.getByRole("option", { name: "Banana" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}"); // Cherry is disabled: lands on Date
    expect(list.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Date" }).id);
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenLastCalledWith("d");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field).toHaveFocus();
    expect(field).toHaveTextContent("Date");
  });

  it("Home, End, type-ahead and Escape", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<Controlled onPick={onPick} />);
    const field = screen.getByRole("combobox", { name: "Fruit" });
    await user.click(field);
    const list = await screen.findByRole("listbox");
    const activeName = () => document.getElementById(list.getAttribute("aria-activedescendant")!)?.textContent;
    await user.keyboard("{End}");
    expect(activeName()).toBe("Elder");
    await user.keyboard("{Home}");
    expect(activeName()).toBe("Apple");
    await user.keyboard("d");
    expect(activeName()).toBe("Date");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
    // Closed type-ahead picks at once, like a native select (after the 500 ms letter buffer clears).
    await new Promise((r) => setTimeout(r, 600));
    field.focus();
    await user.keyboard("a");
    expect(onPick).toHaveBeenLastCalledWith("a");
  });

  it("picks with the mouse and posts its value with a form", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <form>
        <Select aria-label="Kind" name="kind" defaultValue="cash">
          <option value="cash">Cash</option>
          <option value="card">Card</option>
        </Select>
      </form>,
    );
    await user.click(screen.getByRole("combobox", { name: "Kind" }));
    await user.click(await screen.findByRole("option", { name: "Card" }));
    const data = new FormData(container.querySelector("form")!);
    expect(data.get("kind")).toBe("card");
  });

  it("a pick does not click the row the field sits in", async () => {
    const rowClick = vi.fn();
    const user = userEvent.setup();
    render(
      <div onClick={rowClick}>
        <Select aria-label="Row category" defaultValue="a" onClick={(e) => e.stopPropagation()}>
          <option value="a">A</option>
          <option value="b">B</option>
        </Select>
      </div>,
    );
    await user.click(screen.getByRole("combobox", { name: "Row category" }));
    await user.click(await screen.findByRole("option", { name: "B" }));
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("the searchable list filters as you type", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<Controlled onPick={onPick} searchable />);
    await user.click(screen.getByRole("combobox", { name: "Fruit" }));
    const search = await screen.findByRole("searchbox");
    expect(search).toHaveFocus();
    await user.keyboard("eld");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Elder"]);
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenLastCalledWith("e");
  });

  it("multiple keeps the list open and hands selectedOptions", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Select multiple aria-label="Accounts" value={["1"]} onChange={(e) => onChange(Array.from(e.target.selectedOptions, (o) => o.value))}>
        <option value="1">One</option>
        <option value="2">Two</option>
      </Select>,
    );
    await user.click(screen.getByRole("combobox", { name: "Accounts" }));
    await user.click(await screen.findByRole("option", { name: "Two" }));
    expect(onChange).toHaveBeenLastCalledWith(["1", "2"]);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("type-ahead cycles a repeated letter", () => {
    const o = [
      { value: "1", label: "Bank" },
      { value: "2", label: "Bills" },
      { value: "3", label: "Cash" },
    ];
    expect(typeAheadMatch(o, "b", -1)).toBe(0);
    expect(typeAheadMatch(o, "bb", 0)).toBe(1);
    expect(typeAheadMatch(o, "bi", 0)).toBe(1);
    expect(typeAheadMatch(o, "z", 0)).toBe(-1);
  });
});

describe("Checkbox", () => {
  it("toggles by click, by its label and by Space; shows mixed", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <label>
        <Checkbox checked={false} onChange={(e) => onChange(e.target.checked)} />
        Hide done
      </label>,
    );
    const box = screen.getByRole("checkbox", { name: "Hide done" });
    await user.click(screen.getByText("Hide done"));
    expect(onChange).toHaveBeenLastCalledWith(true);
    box.focus();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenCalledTimes(2);
    rerender(
      <label>
        <Checkbox checked={false} indeterminate onChange={(e) => onChange(e.target.checked)} />
        Hide done
      </label>,
    );
    expect(box).toHaveAttribute("aria-checked", "mixed");
    await user.click(box);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
});

describe("calendar keys", () => {
  it.each([
    ["ArrowLeft", false, "2026-11-01", "2026-10-31"],
    ["ArrowRight", false, "2026-11-30", "2026-12-01"],
    ["ArrowUp", false, "2026-11-05", "2026-10-29"],
    ["ArrowDown", false, "2026-11-28", "2026-12-05"],
    ["Home", false, "2026-11-19", "2026-11-15"],
    ["End", false, "2026-11-19", "2026-11-21"],
    ["PageUp", false, "2026-03-31", "2026-02-28"],
    ["PageDown", false, "2026-01-31", "2026-02-28"],
    ["PageDown", true, "2024-02-29", "2025-02-28"],
    ["a", false, "2026-11-19", null],
  ])("%s (shift %s) from %s -> %s", (key, shift, from, to) => {
    expect(calendarKey(key, shift, from)).toBe(to);
  });
  it("Home and End go to Monday and Sunday when weeks start Monday", () => {
    expect(calendarKey("Home", false, "2026-11-22", 1)).toBe("2026-11-16");
    expect(calendarKey("End", false, "2026-11-16", 1)).toBe("2026-11-22");
    expect(calendarKey("Home", false, "2026-11-19", 1)).toBe("2026-11-16");
  });
});

describe("DatePicker", () => {
  it("shows the owner's style and commits a typed date on Enter", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DatePicker aria-label="Due" value="2026-11-21" onChange={(e) => onChange(e.target.value)} />);
    const input = screen.getByRole("combobox", { name: "Due" });
    expect(input).toHaveValue("Nov 21, 2026");
    await user.clear(input);
    await user.type(input, "dec 3 2026{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("2026-12-03");
  });

  it("a pasted ISO day commits at once; nonsense reverts on blur", async () => {
    const onChange = vi.fn();
    render(<DatePicker aria-label="Due" value="" onChange={(e) => onChange(e.target.value)} />);
    const input = screen.getByRole("combobox", { name: "Due" });
    fireEvent.change(input, { target: { value: "2026-11-01" } });
    expect(onChange).toHaveBeenLastCalledWith("2026-11-01");
    onChange.mockClear();
    fireEvent.change(input, { target: { value: "someday" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keyboard: ArrowDown opens on the day, arrows and PageDown move, Enter picks; min and max hold", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DatePicker aria-label="Due" value="2026-11-21" min="2026-11-03" max="2026-12-24" onChange={(e) => onChange(e.target.value)} />);
    screen.getByRole("combobox", { name: "Due" }).focus();
    await user.keyboard("{ArrowDown}");
    const day = await screen.findByRole("button", { name: /Nov 21, 2026/ });
    expect(day).toHaveFocus();
    await user.keyboard("{ArrowRight}{ArrowDown}");
    expect(screen.getByRole("button", { name: "Nov 29, 2026" })).toHaveFocus();
    await user.keyboard("{PageDown}");
    expect(screen.getByRole("button", { name: "Dec 24, 2026" })).toHaveFocus(); // Dec 29 clamps to max
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("2026-12-24");
    expect(screen.getByRole("combobox", { name: "Due" })).toHaveFocus();
  });

  it("a typed day outside min and max is refused", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DatePicker aria-label="Due" value="2026-11-21" min="2026-11-03" onChange={(e) => onChange(e.target.value)} />);
    const input = screen.getByRole("combobox", { name: "Due" });
    await user.clear(input);
    await user.type(input, "11/01/2026{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("Nov 21, 2026");
  });

  it("the end of a range opens on the start month and shades the days between", async () => {
    const user = userEvent.setup();
    render(<DatePicker aria-label="To" value="" rangeStart="2026-10-28" min="2026-10-28" onChange={() => {}} />);
    await user.click(document.querySelector<HTMLElement>('[data-slot="date-picker-icon"]')!);
    expect(await screen.findByRole("grid", { name: "October 2026" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Oct 28, 2026" })).toHaveClass("border-ink");
    expect(screen.getByRole("button", { name: "Oct 27, 2026" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("TimePicker and DateTimePicker", () => {
  it("typing a 12-hour time commits HH:mm", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TimePicker aria-label="Time" value="09:00" onChange={(e) => onChange(e.target.value)} />);
    const input = screen.getByRole("combobox", { name: "Time" });
    expect(input).toHaveValue("9:00 AM");
    await user.clear(input);
    await user.type(input, "9:30pm{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("21:30");
  });

  it("the list moves by arrow keys in 5-minute steps and Enter picks", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TimePicker aria-label="Time" value="09:00" onChange={(e) => onChange(e.target.value)} />);
    await user.click(screen.getByRole("combobox", { name: "Time" }));
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("09:10");
  });

  it("datetime: a typed yyyy-mm-ddTHH:mm sets both; a day alone takes 09:00", async () => {
    const onChange = vi.fn();
    function Host() {
      const [v, setV] = useState("");
      return (
        <DateTimePicker
          aria-label="Alert"
          value={v}
          onChange={(e) => {
            setV(e.target.value);
            onChange(e.target.value);
          }}
        />
      );
    }
    render(<Host />);
    const day = screen.getByRole("combobox", { name: "Alert" });
    act(() => {
      fireEvent.change(day, { target: { value: "2026-11-22T18:45" } });
    });
    expect(onChange).toHaveBeenLastCalledWith("2026-11-22T18:45");
    expect(screen.getByRole("combobox", { name: "Alert time" })).toHaveValue("6:45 PM");
    act(() => {
      fireEvent.change(day, { target: { value: "2026-11-23" } });
    });
    expect(onChange).toHaveBeenLastCalledWith("2026-11-23T18:45");
  });
});
