import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let param: string | null = null;
const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/notes",
  useRouter: () => ({ push }),
  useSearchParams: () => ({ get: () => param, toString: () => (param ? `note=${param}` : "") }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./block-editor", () => ({ default: () => null }));

import type { NoteFull, NotesActions } from "./types";
import { mayLeave } from "@/lib/leave-guard";
import { NotesWorkspace } from "./workspace";

const A: NoteFull = { id: "a0000000-0000-4000-8000-000000000001", title: "Server A", preview: "", source: "web", pinned: false, created_at: "t0", updated_at: "v1", doc: [] };
const B: NoteFull = { ...A, id: "a0000000-0000-4000-8000-000000000002", title: "Server B" };
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const titleBox = () => screen.getByLabelText("Title") as HTMLInputElement;
const backOnline = () => act(() => void window.dispatchEvent(new Event("online")));
const unload = () => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

/** A server that can go offline: reads, saves and New note then fail, as the live page's actions answer them. */
function server(notes = new Map([A, B].map((n) => [n.id, structuredClone(n)]))) {
  let n = 1;
  const s: { online: boolean; saves: number; notes: typeof notes; actions: NotesActions } = {
    online: true,
    saves: 0,
    notes,
    actions: {
      open: async (id) => (s.online ? structuredClone(notes.get(id) ?? null) : "failed"),
      search: async () => [],
      create: async () => {
        if (!s.online) return null;
        const made = { ...A, id: `c0000000-0000-4000-8000-00000000000${n}`, title: "", updated_at: `v${++n}` };
        notes.set(made.id, structuredClone(made));
        return made;
      },
      save: async (id, patch, expected) => {
        s.saves++;
        const note = notes.get(id);
        if (!s.online) return { ok: false, reason: "failed" };
        if (!note) return { ok: false, reason: "gone" };
        if (note.updated_at !== expected) return { ok: false, reason: "conflict", note: structuredClone(note) };
        Object.assign(note, patch, { updated_at: `v${++n}` });
        return { ok: true, note };
      },
      pin: async () => true,
      remove: async () => ({ ok: true }),
    },
  };
  return s;
}

function mount(srv: ReturnType<typeof server>, first: NoteFull | null = A) {
  param = first?.id ?? null;
  const notes = [A, B]; // one list for the page: a new one is a server refresh
  const ui = () => (
    <>
      <a href="/dashboard">Dashboard</a>
      <NotesWorkspace notes={notes} initialOpen={first} actions={srv.actions} />
    </>
  );
  const r = render(ui());
  return (id: string) => {
    param = id;
    r.rerender(ui());
  };
}

describe("NotesWorkspace: an edit is kept until the server has it", () => {
  afterEach(cleanup);

  it("reopening a note while offline keeps its unsent edit and its retries; back online, the edit lands", async () => {
    const srv = server();
    const go = mount(srv);
    srv.online = false;
    fireEvent.change(titleBox(), { target: { value: "Typed offline" } });
    await wait(800); // the save fails
    expect(srv.saves).toBe(1);
    go(B.id);
    await wait(50);
    go(A.id);
    await wait(100);
    expect(screen.getByText("Could not open this note.")).toBeTruthy();
    expect(srv.saves).toBeGreaterThan(2); // leaving and opening the note each try again
    srv.online = true;
    await backOnline();
    await wait(50);
    expect(srv.notes.get(A.id)?.title).toBe("Typed offline");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await wait(50);
    expect(titleBox().value).toBe("Typed offline");
  });

  it("leaving Notes and coming back finds the save still on its way: one saver, the edit shown", async () => {
    const srv = server();
    mount(srv);
    srv.online = false;
    fireEvent.change(titleBox(), { target: { value: "Typed, then left" } });
    await wait(700);
    cleanup(); // another page of the app; this page load's saver keeps retrying
    mount(srv);
    await wait(50);
    expect(titleBox().value).toBe("Typed, then left");
    srv.online = true;
    await backOnline();
    await wait(50);
    expect(srv.notes.get(A.id)?.title).toBe("Typed, then left");
  });

  it("closing the tab warns while an edit is unsent, and not once it lands", async () => {
    const srv = server();
    mount(srv);
    expect(unload()).toBe(false);
    srv.online = false;
    fireEvent.change(titleBox(), { target: { value: "Unsent" } });
    expect(unload()).toBe(true);
    await wait(700);
    expect(unload()).toBe(true);
    srv.online = true;
    await backOnline();
    await wait(50);
    expect(unload()).toBe(false);
  });

  it("after leaving Notes (another page, the idle lock), closing the tab still warns and back online still saves", async () => {
    const srv = server();
    mount(srv);
    srv.online = false;
    fireEvent.change(titleBox(), { target: { value: "Typed, then gone" } });
    await wait(700);
    cleanup(); // the Notes page is gone; its saver is not
    await wait(50); // the save the editor sent as it closed fails too
    expect(unload()).toBe(true);
    srv.online = true;
    await backOnline();
    await wait(50);
    expect(srv.notes.get(A.id)?.title).toBe("Typed, then gone");
    expect(unload()).toBe(false);
  });

  it("a link out of Notes with an unsent edit asks first; Stay stays, Leave goes", async () => {
    const srv = server();
    mount(srv);
    push.mockClear();
    srv.online = false;
    fireEvent.change(titleBox(), { target: { value: "Unsent" } });
    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    expect(screen.getByRole("dialog", { name: "Changes not saved yet. Leave anyway?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    await wait(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(push).toHaveBeenCalledWith("/dashboard");
  });

  it("Back out of Notes with an unsent edit asks first: the step is stopped before it is taken", async () => {
    const navigation = new EventTarget(); // the Navigation API, which jsdom lacks
    Object.defineProperty(window, "navigation", { value: navigation, configurable: true });
    window.history.replaceState(null, "", `/notes?note=${A.id}`);
    const back = (to: string, navigationType = "traverse") => {
      const e = Object.assign(new Event("navigate", { cancelable: true }), { navigationType, destination: { url: new URL(to, window.location.href).href } });
      act(() => void navigation.dispatchEvent(e));
      return e.defaultPrevented;
    };
    const srv = server();
    mount(srv);
    push.mockClear();
    expect(back("/dashboard")).toBe(false); // nothing unsent: Back goes
    srv.online = false;
    fireEvent.change(titleBox(), { target: { value: "Unsent" } });
    expect(back(`/notes?note=${B.id}`)).toBe(false); // within Notes
    expect(back("/dashboard", "push")).toBe(false); // not Back or Forward: the link guard's
    expect(back("/dashboard")).toBe(true);
    expect(screen.getByRole("dialog", { name: "Changes not saved yet. Leave anyway?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(push).toHaveBeenCalledWith("/dashboard");
    cleanup();
    expect(back("/dashboard")).toBe(false);
    delete (window as { navigation?: unknown }).navigation;
    window.history.replaceState(null, "", "/");
  });

  it("navigation in code (the agent) out of Notes asks first; within Notes, or with nothing unsent, it goes", async () => {
    window.history.replaceState(null, "", `/notes?note=${A.id}`);
    const srv = server();
    mount(srv);
    push.mockClear();
    expect(mayLeave("/dashboard")).toBe(true);
    srv.online = false;
    fireEvent.change(titleBox(), { target: { value: "Unsent" } });
    expect(mayLeave(`/notes?note=${B.id}`)).toBe(true);
    let went = true;
    act(() => void (went = mayLeave("/dashboard?x=1")));
    expect(went).toBe(false);
    expect(screen.getByRole("dialog", { name: "Changes not saved yet. Leave anyway?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(push).toHaveBeenCalledWith("/dashboard?x=1");
    cleanup();
    expect(mayLeave("/dashboard")).toBe(true); // no Notes page, no ask
    window.history.replaceState(null, "", "/");
  });

  it("changed elsewhere: Keep mine saves the local copy over the server's", async () => {
    const srv = server();
    srv.notes.get(A.id)!.updated_at = "v0-elsewhere";
    mount(srv);
    fireEvent.change(titleBox(), { target: { value: "Mine" } });
    await wait(700);
    expect(screen.getByRole("alert").textContent).toContain("Changed elsewhere");
    expect(srv.notes.get(A.id)?.title).toBe("Server A");
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await wait(50);
    expect(srv.notes.get(A.id)?.title).toBe("Mine");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("changed elsewhere: Reload takes the server's copy", async () => {
    const srv = server();
    srv.notes.get(A.id)!.updated_at = "v0-elsewhere";
    mount(srv);
    fireEvent.change(titleBox(), { target: { value: "Mine" } });
    await wait(700);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await wait(50);
    expect(titleBox().value).toBe("Server A");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("NotesWorkspace: New note", () => {
  afterEach(cleanup);

  it("one that fails says so and drops the keys typed for it: the next New note starts empty", async () => {
    const srv = server();
    const go = mount(srv);
    srv.online = false;
    fireEvent.click(screen.getAllByRole("button", { name: "New note" })[0], { detail: 1 });
    for (const key of ["G", "r", "o", "c", "Enter", "m", "i", "l", "k"]) fireEvent.keyDown(window, { key });
    await wait(50);
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t make the note");
    expect(screen.getByRole("alert").textContent).not.toContain("Groc");
    srv.online = true;
    fireEvent.click(screen.getAllByRole("button", { name: "New note" })[0], { detail: 1 });
    for (const key of ["M", "e", "e", "t"]) fireEvent.keyDown(window, { key });
    await wait(50);
    // The page moved ?note= to the new note (the mocked router does not follow pushState by itself).
    go(new URLSearchParams(window.location.search).get("note") ?? "");
    await wait(50);
    expect(titleBox().value).toBe("Meet");
    expect(screen.queryByText(/make the note/)).toBeNull();
  });

  it("the failure can be dismissed", async () => {
    const srv = server();
    mount(srv);
    srv.online = false;
    fireEvent.click(screen.getAllByRole("button", { name: "New note" })[0], { detail: 1 });
    await wait(50);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/make the note/)).toBeNull();
  });
});

describe("NotesWorkspace: search", () => {
  afterEach(cleanup);

  it("shows only the matches (the open note is marked when it is one), or just says nothing matches", async () => {
    const srv = server();
    srv.actions.search = async (q: string) => (q === "zzz" ? [] : q === "b" ? [B.id] : [A.id, B.id]);
    mount(srv);
    const search = screen.getByRole("searchbox", { name: "Search notes" });
    fireEvent.change(search, { target: { value: "server" } });
    await wait(300);
    const rows = screen.getAllByTestId("note-row");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.getAttribute("aria-current"))).toEqual(["true", null]);
    fireEvent.change(search, { target: { value: "b" } });
    await wait(300);
    expect(screen.getAllByTestId("note-row").map((r) => r.textContent)).toEqual([expect.stringContaining("Server B")]);
    fireEvent.change(search, { target: { value: "zzz" } });
    await wait(300);
    expect(screen.getByText("No notes match “zzz”")).toBeTruthy();
    expect(screen.queryAllByTestId("note-row")).toHaveLength(0);
  });
});
