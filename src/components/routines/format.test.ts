import { expect, test } from "vitest";

import { nameFrom, toggle, whenText } from "./format";

const TZ = "America/Toronto";
const NOW = "2026-11-21T15:00:00Z"; // Saturday 10:00 in Toronto

test("times read in the owner's zone, counted in days from now", () => {
  expect(whenText("2026-11-21T23:00:00Z", TZ, NOW)).toBe("Today 18:00");
  expect(whenText("2026-11-22T03:00:00Z", TZ, NOW)).toBe("Today 22:00"); // 22:00 Saturday local, already Sunday in UTC
  expect(whenText("2026-11-22T13:00:00Z", TZ, NOW)).toBe("Tomorrow 08:00");
  expect(whenText("2026-11-20T13:00:00Z", TZ, NOW)).toBe("Yesterday 08:00");
  expect(whenText("2026-11-23T13:00:00Z", TZ, NOW)).toBe("Mon, Nov 23 08:00");
});

test("a blank name comes from the instruction", () => {
  expect(nameFrom("  Payments  ", "x")).toBe("Payments");
  expect(nameFrom("", "Check Gmail for brand payments")).toBe("Check Gmail for brand payments");
  expect(nameFrom("", "word ".repeat(30)).length).toBeLessThanOrEqual(48);
});

test("toggle adds and removes", () => {
  expect(toggle(["a"], "b")).toEqual(["a", "b"]);
  expect(toggle(["a", "b"], "a")).toEqual(["b"]);
});
