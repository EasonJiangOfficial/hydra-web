import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatMoney, Money } from "./money";

describe("formatMoney", () => {
  it("formats the design's examples", () => {
    expect(formatMoney(4821240)).toBe("$48,212.40");
    expect(formatMoney(-231800, { whole: true })).toBe("-$2,318");
    expect(formatMoney(210418, { signed: true })).toBe("+$2,104.18");
    expect(formatMoney(3184000, { compact: true })).toBe("$31.8k");
  });

  it("handles zero without a sign", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(0, { signed: true })).toBe("$0.00");
    expect(formatMoney(-0, { whole: true })).toBe("$0");
    expect(formatMoney(0, { compact: true })).toBe("$0");
  });

  it("formats negatives with a leading minus", () => {
    expect(formatMoney(-5999)).toBe("-$59.99");
    expect(formatMoney(-5, { signed: true })).toBe("-$0.05");
    expect(formatMoney(-231850, { compact: true })).toBe("-$2.3k");
  });

  it("rounds half away from zero", () => {
    expect(formatMoney(231850, { whole: true })).toBe("$2,319");
    expect(formatMoney(-231850, { whole: true })).toBe("-$2,319");
    expect(formatMoney(12.6)).toBe("$0.13");
    expect(formatMoney(-12.5)).toBe("-$0.13");
    expect(formatMoney(-49, { whole: true })).toBe("$0");
  });

  it("switches compact units at the thresholds", () => {
    expect(formatMoney(99_900, { compact: true })).toBe("$999");
    expect(formatMoney(99_960, { compact: true })).toBe("$1k");
    expect(formatMoney(1_000_000, { compact: true })).toBe("$10k");
    expect(formatMoney(99_995_000, { compact: true })).toBe("$1M");
    expect(formatMoney(123_456_789, { compact: true })).toBe("$1.2M");
    expect(formatMoney(104_000, { compact: true, signed: true })).toBe("+$1k");
  });

  it("keeps grouping on large numbers", () => {
    expect(formatMoney(123_456_789_012)).toBe("$1,234,567,890.12");
    expect(formatMoney(-900_719_925_474_099)).toBe("-$9,007,199,254,740.99");
  });
});

describe("Money", () => {
  it("dims cents and stays ink unless tone is loss", () => {
    const { container, rerender } = render(<Money cents={4821240} dimCents />);
    expect(container.textContent).toBe("$48,212.40");
    expect(container.querySelector(".opacity-45")?.textContent).toBe(".40");
    expect(container.firstElementChild!.className).not.toContain("text-neg");
    rerender(<Money cents={-42000} whole tone="loss" />);
    expect(container.firstElementChild!.className).toContain("text-neg");
  });
});
