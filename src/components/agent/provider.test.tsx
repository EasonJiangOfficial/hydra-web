import { act, cleanup, render } from "@testing-library/react";
import { Tooltip } from "radix-ui";
import { Profiler, useContext, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBridge } from "@/app/dev/agent/fake-bridge";
import { AgentCard } from "./agent-card";
import { AgentContext } from "./context";
import { AgentProvider } from "./provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));

afterEach(() => {
  cleanup();
  delete window.hydraDesktop;
  vi.unstubAllGlobals();
});

/**
 * Hydra Desktop pushes the mic and voice levels about 15 times a second (host.js pushOrb, every 66 ms while they
 * move). Those pushes must never become React renders: the orb reads the level itself on each animation frame
 * (ctl.level), so the card, the panel and everything the provider wraps (the whole app shell) stay still.
 */
describe("a Hydra Desktop level push", () => {
  function mount() {
    const fake = fakeBridge(2, { snap: { state: "Listening", micLevel: 0.1 } });
    window.hydraDesktop = fake.bridge;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 404 })));
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const renders = { page: 0, card: 0 };
    let level = () => 0;
    function Level({ children }: { children: ReactNode }) {
      const ctl = useContext(AgentContext);
      if (ctl) level = ctl.level;
      return children;
    }
    function Page() {
      renders.page++;
      return <p>The page</p>;
    }
    render(
      <Tooltip.Provider>
      <AgentProvider>
        <Level>
          <Profiler id="card" onRender={() => renders.card++}>
            <AgentCard />
          </Profiler>
          <Page />
        </Level>
      </AgentProvider>
      </Tooltip.Provider>,
    );
    return { fake, renders, level: () => level() };
  }

  it("re-renders nothing: not the page, not the agent card; the orb reads the level on its own", async () => {
    const { fake, renders, level } = mount();
    await act(async () => {});
    renders.page = 0;
    renders.card = 0;
    for (let i = 1; i <= 60; i++) await act(async () => fake.push({ micLevel: (i % 10) / 10, outputLevel: 0 }));
    expect(renders).toEqual({ page: 0, card: 0 });
    expect(level()).toBeCloseTo(0, 5); // the last push was 60 % 10 = 0
    await act(async () => fake.push({ micLevel: 0.7 }));
    expect(level()).toBeCloseTo(0.7, 5);
    expect(renders).toEqual({ page: 0, card: 0 });
  });

  it("a state change re-renders the card, still not the page", async () => {
    const { fake, renders } = mount();
    await act(async () => {});
    renders.page = 0;
    renders.card = 0;
    await act(async () => fake.push({ state: "Speaking", outputLevel: 0.5 }));
    expect(renders.card).toBeGreaterThan(0);
    expect(renders.page).toBe(0);
  });
});
