import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

// The render's search params stay as they were at render time ("?range=custom"), as before React re-renders.
vi.mock("next/navigation", () => ({
  usePathname: () => "/ugc",
  useSearchParams: () => new URLSearchParams("range=custom"),
}));

import { useQueryParam } from "./url";

it("two sets before a re-render keep both (the custom range's From, then To)", () => {
  window.history.replaceState(null, "", "/ugc?range=custom");
  const from = renderHook(() => useQueryParam("from")).result.current[1];
  const to = renderHook(() => useQueryParam("to")).result.current[1];
  from("2026-11-01");
  to("2026-11-07");
  expect(window.location.search).toBe("?range=custom&from=2026-11-01&to=2026-11-07");
});
