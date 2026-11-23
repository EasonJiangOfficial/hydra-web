import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

/*
 * The Settings Agent tab against the real GET/PATCH /api/agent/state handlers (W6 contract, 0190): only the
 * database is the memory store, so a field name the tab and the route disagree on fails here.
 */
const m = vi.hoisted(() => ({ mem: null as null | ReturnType<typeof import("@/lib/agent/testing").memoryStore> }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({ rpc: async (name: string) => ({ data: name === "is_owner", error: null }) }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));
vi.mock("@/lib/agent/store", async (orig) => ({ ...(await orig<object>()), supabaseStore: () => m.mem!.store }));

const route = await import("@/app/api/agent/state/route");
const { memoryStore } = await import("@/lib/agent/testing");
const { getAgentSettings, patchAgentSettings } = await import("@/lib/agent/settings-client");
const { SettingsProvider } = await import("./store");
const { AgentTab } = await import("./agent-tab");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});
afterEach(cleanup);

/** fetch that hands the request to the route handler. */
const viaRoute = (async (url: string, init?: RequestInit) => {
  const req = new Request(`https://hydra.example${url}`, init);
  return req.method === "PATCH" ? route.PATCH(req) : route.GET(req);
}) as typeof fetch;

it("shows all six fields from GET and saves each through PATCH", async () => {
  m.mem = memoryStore();
  const actions = { agentSettings: () => getAgentSettings(viaRoute), saveAgentSettings: (p: object) => patchAgentSettings(p, viaRoute) };
  const user = userEvent.setup();
  render(
    <SettingsProvider data={{} as never} actions={actions as never}>
      <AgentTab />
    </SettingsProvider>,
  );

  const model = await screen.findByRole("combobox", { name: "Model" });
  expect(model).toHaveTextContent("Opus 5.5");
  expect(screen.getByRole("radiogroup", { name: "Effort live" })).toBeInTheDocument();
  expect(screen.getByLabelText("Wake phrase")).toHaveValue("Hey Hydra");
  expect(screen.getByLabelText("Sleep word")).toHaveValue("Hydra, sleep");
  expect(screen.getByRole("radiogroup", { name: "Clap sensitivity" })).toBeInTheDocument();

  model.focus();
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("listbox");
  await user.click(screen.getByRole("option", { name: "Sonnet 5.5" }));
  const pick = async (group: string, name: string) => {
    await user.click(within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name }));
  };
  await pick("Effort live", "Medium");
  await pick("Effort routines", "High");
  await pick("Clap sensitivity", "Low");
  await user.clear(screen.getByLabelText("Wake phrase"));
  await user.type(screen.getByLabelText("Wake phrase"), "Okay Hydra{Enter}");
  await user.clear(screen.getByLabelText("Sleep word"));
  await user.type(screen.getByLabelText("Sleep word"), "Goodnight Hydra{Enter}");

  const want = {
    model: "claude-sonnet-5-5",
    effortLive: "medium",
    effortRoutine: "high",
    clapSensitivity: "low",
    wakePhrase: "Okay Hydra",
    sleepWord: "Goodnight Hydra",
  };
  await waitFor(async () => expect((await (await route.GET(new Request("https://hydra.example/api/agent/state"))).json()).settings).toMatchObject(want));
  expect(await m.mem.store.settings()).toMatchObject(want);
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("Sonnet 5.5");
});

it("an older save's answer never paints over a newer save of another field", async () => {
  m.mem = memoryStore();
  let releaseModel = () => {};
  const actions = {
    agentSettings: () => getAgentSettings(viaRoute),
    // The model save is written and answered at once (effort live still low then), but its answer arrives last.
    saveAgentSettings: async (p: object) => {
      const r = await patchAgentSettings(p, viaRoute);
      if ("model" in p) await new Promise<void>((done) => (releaseModel = done));
      return r;
    },
  };
  const user = userEvent.setup();
  render(
    <SettingsProvider data={{} as never} actions={actions as never}>
      <AgentTab />
    </SettingsProvider>,
  );
  const model = await screen.findByRole("combobox", { name: "Model" });
  model.focus();
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("listbox");
  await user.click(screen.getByRole("option", { name: "Sonnet 5.5" }));
  const medium = within(screen.getByRole("radiogroup", { name: "Effort live" })).getByRole("radio", { name: "Medium" });
  await user.click(medium);
  await waitFor(async () => expect((await m.mem!.store.settings()).effortLive).toBe("medium"));
  await act(async () => {
    releaseModel();
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("Sonnet 5.5");
  expect(within(screen.getByRole("radiogroup", { name: "Effort live" })).getByRole("radio", { name: "Medium" })).toBeChecked();
});

it("0200: the approve all switch is off, turns on through PATCH, and explains itself on hover", async () => {
  m.mem = memoryStore();
  const actions = { agentSettings: () => getAgentSettings(viaRoute), saveAgentSettings: (p: object) => patchAgentSettings(p, viaRoute) };
  const user = userEvent.setup();
  render(
    <SettingsProvider data={{} as never} actions={actions as never}>
      <AgentTab />
    </SettingsProvider>,
  );
  const sw = await screen.findByRole("switch", { name: "Approve all" });
  expect(sw).toHaveAttribute("aria-checked", "false");
  await user.click(sw);
  expect(sw).toHaveAttribute("aria-checked", "true");
  await waitFor(async () => expect((await m.mem!.store.settings()).approveAll).toBe(true));
  expect(screen.getByRole("button", { name: "About approve all" })).toHaveAccessibleDescription("Hydra acts without asking. Deletions still ask.");
  await user.click(sw);
  await waitFor(async () => expect((await m.mem!.store.settings()).approveAll).toBe(false));
});

it("models: only connected models are offered; Connect checks a Grok key, then Grok is pickable with its own levels; Remove asks first", async () => {
  m.mem = memoryStore();
  vi.stubEnv("HYDRA_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
  // xAI's model list, mocked: the first key is refused, the second works. No provider is called.
  const xai = vi.fn(async (_url: string, init: RequestInit) =>
    new Headers(init.headers).get("authorization") === "Bearer xai-refused-0000000000000000"
      ? Response.json({ error: "Incorrect API key provided" }, { status: 401 })
      : Response.json({ data: [{ id: "grok-4.7" }] }),
  );
  vi.stubGlobal("fetch", xai);
  const keysRoute = await import("@/app/api/agent/models/keys/route");
  const { modelKeysClient } = await import("@/lib/agent/settings-client");
  const viaKeys = (async (url: string, init?: RequestInit) => {
    const req = new Request(`https://hydra.example${url}`, init);
    return req.method === "PUT" ? keysRoute.PUT(req) : req.method === "DELETE" ? keysRoute.DELETE(req) : keysRoute.GET(req);
  }) as typeof fetch;
  const actions = { agentSettings: () => getAgentSettings(viaRoute), saveAgentSettings: (p: object) => patchAgentSettings(p, viaRoute), modelKeys: modelKeysClient(viaKeys) };
  const user = userEvent.setup();
  render(
    <SettingsProvider data={{} as never} actions={actions as never}>
      <AgentTab />
    </SettingsProvider>,
  );
  const options = async () => {
    const model = screen.getByRole("combobox", { name: "Model" });
    model.focus();
    await user.keyboard("{ArrowDown}");
    const names = within(await screen.findByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    return names;
  };
  const card = await screen.findByRole("region", { name: "Models" });
  await screen.findByRole("combobox", { name: "Model" });
  expect(await options()).toEqual(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
  await user.keyboard("{Escape}");
  expect(within(card).getByText("Sign in on the Mac")).toBeInTheDocument();

  const connect = within(card).getByRole("button", { name: "Connect" });
  await user.click(connect);
  const field = within(card).getByLabelText("xAI API key");
  expect(field).toHaveAttribute("type", "password");
  expect(field).toHaveAttribute("autocomplete", "off");
  await user.type(field, "xai-refused-0000000000000000");
  await user.click(within(card).getByRole("button", { name: "Save" }));
  expect(await within(card).findByRole("alert")).toHaveTextContent("xAI refused this key");
  expect(m.mem.modelKeys.size).toBe(0);
  await user.clear(field);
  await user.type(field, "xai-good-00000000000000004f2a");
  await user.click(within(card).getByRole("button", { name: "Save" }));
  await within(card).findByRole("button", { name: "Remove" });
  expect(m.mem.modelKeys.get("xai")?.hint).toBe("4f2a");

  // Grok is offered now; its levels stop at X-High, and picking it clamps a Max effort.
  await user.click(within(screen.getByRole("radiogroup", { name: "Effort live" })).getByRole("radio", { name: "Max" }));
  await waitFor(async () => expect((await m.mem!.store.settings()).effortLive).toBe("max"));
  expect(await options()).toEqual(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5", "Grok 4.7"]);
  await user.click(screen.getByRole("option", { name: "Grok 4.7" }));
  await waitFor(async () => expect(await m.mem!.store.settings()).toMatchObject({ model: "grok-4.7", effortLive: "xhigh" }));
  const live = within(screen.getByRole("radiogroup", { name: "Effort live" }));
  expect(live.getAllByRole("radio")).toHaveLength(4);
  for (const name of ["Low", "Medium", "High", "X-High"]) expect(live.getByRole("radio", { name })).toBeInTheDocument();
  expect(live.queryByRole("radio", { name: "Max" })).toBeNull();
  expect(live.getByRole("radio", { name: "X-High" })).toBeChecked();

  // Remove asks first; Cancel keeps the key.
  await user.click(within(card).getByRole("button", { name: "Remove" }));
  const ask = within(card).getByRole("alertdialog", { name: "Remove the Grok key" });
  expect(ask).toHaveTextContent("Remove the Grok key? Hydra goes back to Opus 5.5 if Grok is picked.");
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(m.mem.modelKeys.size).toBe(1);
  await user.click(within(card).getByRole("button", { name: "Remove" }));
  await user.click(within(within(card).getByRole("alertdialog")).getByRole("button", { name: "Remove" }));
  await within(card).findByRole("button", { name: "Connect" });
  expect(m.mem.modelKeys.size).toBe(0);
  expect(await m.mem.store.settings()).toMatchObject({ model: "claude-opus-5-5", effortLive: "xhigh" });
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("Opus 5.5");
  expect(xai).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
