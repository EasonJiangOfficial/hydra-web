import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { todayDay } from "@/lib/date-input";

import { Checkbox } from "./checkbox";
import { Combobox } from "./combobox";
import { DatePicker, DateTimePicker, TimePicker } from "./date-picker";
import { Select } from "./select";

/** Each test here is one finding of the custom-controls review (id in the name) and fails without its fix. */

const media = (matches: boolean) => (q: string) => ({ matches, media: q, addEventListener() {}, removeEventListener() {} });
let phone = false;

afterEach(() => {
  cleanup();
  phone = false;
  vi.restoreAllMocks();
});

beforeAll(() => {
  window.matchMedia = ((q: string) => media(phone)(q)) as never;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

const activeText = (owner: HTMLElement) => {
  const id = owner.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent : null;
};

describe("Select", () => {
  it("F1: a letter typed on the closed field of a long list highlights the first match, and Enter picks it", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    const options = [...Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, label: `Item ${i}` })), { value: "zebra", label: "Zebra" }];
    render(<Select aria-label="Long" options={options} value="v25" onValueChange={onPick} />);
    screen.getByRole("combobox", { name: "Long" }).focus();
    await user.keyboard("z");
    const search = await screen.findByRole("searchbox");
    expect(search).toHaveValue("z");
    expect(activeText(search)).toBe("Zebra");
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenLastCalledWith("zebra");
  });
});

describe("TimePicker", () => {
  it("F2: opening a 9:07 field and pressing Enter keeps 9:07", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TimePicker aria-label="Start" value="09:07" onValueChange={onChange} />);
    await user.click(screen.getByRole("combobox", { name: "Start" }));
    await screen.findByRole("listbox");
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    // Moving the highlight first still picks.
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("09:10");
  });

  it("F7: typing 01:30pm saves 13:30 once, never 01:30", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    function Host() {
      const [v, setV] = useState("09:00");
      return (
        <TimePicker
          aria-label="Start"
          clearable={false}
          value={v}
          onValueChange={(next) => {
            setV(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Host />);
    const input = screen.getByRole("combobox", { name: "Start" });
    await user.clear(input);
    await user.type(input, "01:30pm");
    await user.tab();
    expect(onChange.mock.calls).toEqual([["13:30"]]);
    expect(input).toHaveValue("1:30 PM");
  });

  it("F7: a pasted 24 h time still lands without a blur", () => {
    const onChange = vi.fn();
    render(<TimePicker aria-label="Start" value="" onValueChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Start" }), { target: { value: "18:45" } });
    expect(onChange).toHaveBeenLastCalledWith("18:45");
  });

  it("D3, D4: on a phone the sheet has hour and minute columns and Clear", async () => {
    phone = true;
    const onChange = vi.fn();
    const user = userEvent.setup();
    function Host() {
      const [v, setV] = useState("09:00");
      return (
        <TimePicker
          aria-label="End"
          value={v}
          onValueChange={(next) => {
            setV(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Host />);
    const field = screen.getByRole("combobox", { name: "End" });
    await user.click(field);
    const hours = await screen.findByRole("listbox", { name: "End hour" });
    expect(screen.getAllByRole("option").length).toBe(24 + 12);
    await user.click(screen.getByRole("option", { name: "9 PM" }));
    expect(onChange).toHaveBeenLastCalledWith("21:00");
    expect(hours).toBeInTheDocument(); // an hour keeps the sheet open
    await user.click(screen.getByRole("option", { name: ":45" }));
    expect(onChange).toHaveBeenLastCalledWith("21:45");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(field);
    await user.click(await screen.findByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(field).toHaveValue("");
  });

  it("D3: no Clear when the time is required", async () => {
    phone = true;
    const user = userEvent.setup();
    render(<TimePicker aria-label="Start" value="09:00" clearable={false} onChange={() => {}} />);
    await user.click(screen.getByRole("combobox", { name: "Start" }));
    await screen.findByRole("listbox", { name: "Start hour" });
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });
});

describe("Enter in a form (F8)", () => {
  function PaymentForm({ onSubmit }: { onSubmit: (v: { day: string; time: string }) => void }) {
    const [day, setDay] = useState("");
    const [time, setTime] = useState("");
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ day, time });
        }}
      >
        <DatePicker aria-label="Paid on" value={day} onChange={(e) => setDay(e.target.value)} />
        <TimePicker aria-label="At" value={time} onChange={(e) => setTime(e.target.value)} />
        <button type="submit">Save</button>
      </form>
    );
  }

  it("Enter in a closed date field commits the typed day and submits", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<PaymentForm onSubmit={onSubmit} />);
    screen.getByRole("combobox", { name: "Paid on" }).focus();
    await user.keyboard("nov 21 2026{Enter}");
    expect(onSubmit).toHaveBeenLastCalledWith({ day: "2026-11-21", time: "" });
  });

  it("Enter in a closed time field commits the typed time and submits", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<PaymentForm onSubmit={onSubmit} />);
    screen.getByRole("combobox", { name: "At" }).focus();
    await user.keyboard("7:15pm{Enter}");
    expect(onSubmit).toHaveBeenLastCalledWith({ day: "", time: "19:15" });
  });

  it("Enter with the list open picks and does not submit", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<PaymentForm onSubmit={onSubmit} />);
    await user.click(screen.getByRole("combobox", { name: "At" }));
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "At" })).toHaveValue("9:05 AM");
  });
});

describe("DateTimePicker (F10)", () => {
  it("named by a label, the time half is 'Alert time', and other props reach the field", () => {
    render(
      <>
        <label htmlFor="alert">Alert</label>
        <DateTimePicker id="alert" aria-describedby="alert-hint" value="2026-11-22T18:45" onChange={() => {}} />
        <p id="alert-hint">hint</p>
      </>,
    );
    expect(screen.getByRole("combobox", { name: "Alert" })).toHaveAttribute("aria-describedby", "alert-hint");
    expect(screen.getByRole("combobox", { name: "Alert time" })).toHaveValue("6:45 PM");
  });
});

describe("Checkbox (F12)", () => {
  it("Enter does not toggle; Space does", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Checkbox aria-label="All day" onCheckedChange={onChange} />);
    screen.getByRole("checkbox", { name: "All day" }).focus();
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
});

describe("phone picker inside a slide-out (D5)", () => {
  it("adds no second scrim over the slide-out's own", async () => {
    phone = true;
    const user = userEvent.setup();
    render(
      <>
        <Select aria-label="Outside" defaultValue="a">
          <option value="a">A</option>
        </Select>
        <DialogPrimitive.Root open>
          <DialogPrimitive.Content aria-describedby={undefined}>
            <DialogPrimitive.Title>Task</DialogPrimitive.Title>
            <Select aria-label="Inside" defaultValue="a">
              <option value="a">A</option>
            </Select>
          </DialogPrimitive.Content>
        </DialogPrimitive.Root>
      </>,
    );
    await user.click(screen.getByRole("combobox", { name: "Inside" }));
    await screen.findByRole("listbox");
    expect(document.querySelector('[data-slot="picker-overlay"]')).toHaveClass("bg-transparent");
    expect(document.querySelector('[data-slot="picker-overlay"]')).not.toHaveClass("bg-obsidian/20");
  });

  it("keeps the scrim on a page with no slide-out", async () => {
    phone = true;
    const user = userEvent.setup();
    render(
      <Select aria-label="Outside" defaultValue="a">
        <option value="a">A</option>
      </Select>,
    );
    await user.click(screen.getByRole("combobox", { name: "Outside" }));
    await screen.findByRole("listbox");
    expect(document.querySelector('[data-slot="picker-overlay"]')).toHaveClass("bg-obsidian/20");
  });
});

describe("Combobox (D1)", () => {
  it("suggests as you type; ArrowDown and Enter fill the field and the call site's Enter still saves", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <Combobox
        aria-label="Category"
        suggestions={["Work", "Health", "Workshop"]}
        defaultValue=""
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        onBlur={(e) => onSave(e.target.value)}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Category" });
    expect(input.getAttribute("list")).toBeNull();
    expect(document.querySelector("datalist")).toBeNull();
    await user.type(input, "wo");
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Work", "Workshop"]);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onSave).toHaveBeenLastCalledWith("Workshop");
    expect(input).toHaveValue("Workshop");
  });

  it("a click on a suggestion sets a controlled field; free text stays free", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    function Host() {
      const [v, setV] = useState("");
      return (
        <Combobox
          aria-label="Payer"
          suggestions={["Acme Inc", "Bolt LLC"]}
          value={v}
          onChange={(e) => {
            setV(e.target.value);
            onChange(e.target.value);
          }}
        />
      );
    }
    render(<Host />);
    const input = screen.getByRole("combobox", { name: "Payer" });
    await user.click(input);
    await user.click(await screen.findByRole("option", { name: "Bolt LLC" }));
    expect(onChange).toHaveBeenLastCalledWith("Bolt LLC");
    expect(input).toHaveValue("Bolt LLC");
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "Nobody{Enter}");
    expect(input).toHaveValue("Nobody");
  });

  it("Escape closes the suggestions only", async () => {
    const outer = vi.fn();
    const user = userEvent.setup();
    render(
      <div onKeyDown={(e) => e.key === "Escape" && outer()}>
        <Combobox aria-label="Category" suggestions={["Work"]} defaultValue="" />
      </div>,
    );
    await user.type(screen.getByRole("combobox", { name: "Category" }), "w");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("today without a zone (F6)", () => {
  it("is the browser's day, as the native input was, not Toronto's", () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: "Asia/Tokyo" };
    });
    // 20:00 UTC on Nov 21 is Nov 21 in Toronto and Nov 22 in Tokyo.
    expect(todayDay(undefined, new Date("2026-11-21T20:00:00Z"))).toBe("2026-11-22");
  });
});
