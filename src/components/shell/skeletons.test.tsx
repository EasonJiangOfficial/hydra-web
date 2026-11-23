import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));
import { NotesLoading } from "@/components/notes/loading";
import { RoutinesLoading } from "@/components/routines/loading";
import * as skeletons from "./skeletons";

/** The (app) template fades in everything but a route skeleton, so each skeleton shows on the click; the skeleton also marks the template so its page skips the fade. */
it("every route skeleton root is marked, so it skips the page fade", () => {
  const roots = { ...skeletons, RoutinesLoading, NotesLoading };
  const names = Object.keys(roots).filter((n) => n.endsWith("Loading"));
  expect(names.length).toBeGreaterThanOrEqual(8);
  for (const name of names) {
    const Loading = roots[name as keyof typeof roots] as () => React.ReactNode;
    const { container, unmount } = render(<Loading />);
    expect(container.firstElementChild?.hasAttribute("data-route-loading"), name).toBe(true);
    expect(container.hasAttribute("data-skeleton-shown"), name).toBe(true);
    unmount();
  }
});
