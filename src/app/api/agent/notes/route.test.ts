// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  isOwner: false,
  devices: new Map<string, { id: string; scopes: string[] }>(),
  notes: null as null | ReturnType<typeof import("@/lib/notes/testing").memoryNotesDb>,
  route: null as null | typeof import("./route"),
  forwarded: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({
    rpc: async (name: string) => (name === "is_owner" ? { data: m.isOwner, error: null } : { data: null, error: null }),
    from: (t: string) => m.notes!.db.from(t),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, string>) => {
      if (name === "agent_device_auth") {
        const d = m.devices.get(args.p_key_hash);
        return { data: d ? [d] : [], error: null };
      }
      if (name === "agent_rate_hit") return { data: 0, error: null };
      return { data: null, error: null };
    },
  }),
}));
// The bridge re-sends the device's request to the same route with an owner session: here, the handler itself.
vi.mock("@/lib/agent/bridge", () => ({
  forwardAsOwner: async (req: Request, deviceId: string) => {
    m.forwarded.push(deviceId);
    const headers = new Headers(req.headers);
    headers.delete("authorization");
    headers.set("x-hydra-device", deviceId);
    const again = new Request(req.url, { method: req.method, headers, body: req.method === "GET" ? null : await req.text() });
    m.isOwner = true;
    try {
      return await (req.method === "GET" ? m.route!.GET(again) : m.route!.POST(again));
    } finally {
      m.isOwner = false;
    }
  },
}));

m.route = await import("./route");
const { POST, GET } = m.route;
const { memoryNotesDb } = await import("@/lib/notes/testing");
const { sha256, KEY_PREFIX } = await import("@/lib/agent/devices");

const URL_ = "https://hydra.example/api/agent/notes";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (qs = "", headers: Record<string, string> = {}) => new Request(`${URL_}${qs}`, { headers });
const KEY = `${KEY_PREFIX}mac-key`;
const DEVICE = "00000000-0000-4000-8000-0000000000d1";
const DRAWN = { text: "Call Sam\nabout the Glow deal", source: "desktop", client_id: "toolu_01:0" };

beforeEach(() => {
  m.isOwner = false;
  m.devices.clear();
  m.forwarded.length = 0;
  m.notes = memoryNotesDb();
});

describe("/api/agent/notes", () => {
  it("answers 401 to no session and no key, and writes nothing", async () => {
    expect((await POST(post(DRAWN))).status).toBe(401);
    expect((await GET(get())).status).toBe(401);
    expect((await POST(post(DRAWN, { authorization: "Bearer hyd_unknown" }))).status).toBe(401);
    expect(m.notes!.rows).toHaveLength(0);
  });

  it("the owner's session adds a note (201); a retry with the same client_id is 200 with the same note", async () => {
    m.isOwner = true;
    const first = await POST(post(DRAWN));
    expect(first.status).toBe(201);
    const a = (await first.json()) as { note: { id: string; text: string; source: string }; created: boolean };
    expect(a).toMatchObject({ created: true, note: { text: "Call Sam\nabout the Glow deal", source: "desktop", clientId: "toolu_01:0" } });
    const retry = await POST(post({ ...DRAWN, text: "Call Sam (retry)" }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ created: false, note: { id: a.note.id, text: "Call Sam\nabout the Glow deal" } });
    expect(m.notes!.rows).toHaveLength(1);
    expect(m.notes!.rows[0].doc.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
  });

  it("a paired device with the agent scope is forwarded as the owner and its note carries the device", async () => {
    m.devices.set(sha256(KEY), { id: DEVICE, scopes: ["agent"] });
    const res = await POST(post({ ...DRAWN, title: "Sam" }, { authorization: `Bearer ${KEY}` }));
    expect(res.status).toBe(201);
    expect(m.forwarded).toEqual([DEVICE]);
    expect(m.notes!.rows[0]).toMatchObject({ title: "Sam", device_id: DEVICE, source: "desktop", client_id: "toolu_01:0" });
    // Another sender with the same client_id gets 409, never this device's note.
    m.isOwner = true;
    const other = await POST(post({ ...DRAWN, text: "a different note" }));
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: "client_id_taken" });
    expect(m.notes!.rows).toHaveLength(1);
    m.isOwner = false;
    const list = await GET(get("?q=glow", { authorization: `Bearer ${KEY}` }));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { notes: { title: string }[] }).notes.map((n) => n.title)).toEqual(["Sam"]);
  });

  it("refuses a device key without the agent scope (403) and writes nothing", async () => {
    m.devices.set(sha256(KEY), { id: DEVICE, scopes: ["mcp"] });
    expect((await POST(post(DRAWN, { authorization: `Bearer ${KEY}` }))).status).toBe(403);
    expect((await GET(get("", { authorization: `Bearer ${KEY}` }))).status).toBe(403);
    expect(m.forwarded).toEqual([]);
    expect(m.notes!.rows).toHaveLength(0);
  });

  it("400 on a bad body or query, before any write", async () => {
    m.isOwner = true;
    const bad = [
      { text: "x", source: "desktop" }, // no client_id
      { ...DRAWN, source: "fax" },
      { ...DRAWN, doc: [{ type: "paragraph" }] }, // text and doc
      { source: "desktop", client_id: "c" }, // neither
      { ...DRAWN, doc: undefined, text: undefined, extra: 1 },
      { ...DRAWN, thread_id: "not-a-uuid" },
      // Postgres text refuses these: a 400, not a 500 from the insert.
      { ...DRAWN, client_id: "a\u0000b" },
      { ...DRAWN, client_id: "half \ud83d" },
      // Blocks and styles the editor cannot open: such a note could never be opened on /notes.
      { ...DRAWN, text: undefined, doc: [{ type: "image", props: { url: "https://x.test/a.png" } }] },
      { ...DRAWN, text: undefined, doc: [{ type: "paragraph", content: [{ type: "text", text: "red", styles: { textColor: "red" } }] }] },
      { ...DRAWN, text: undefined, doc: [{ type: "heading", props: { level: 4 }, content: [] }] },
    ];
    for (const body of bad) expect((await POST(post(body))).status, JSON.stringify(body)).toBe(400);
    expect((await POST(new Request(URL_, { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" }))).status).toBe(400);
    expect((await GET(get("?limit=0"))).status).toBe(400);
    expect((await GET(get("?limit=abc"))).status).toBe(400);
    expect(m.notes!.rows).toHaveLength(0);
  });

  it("takes a block document as sent and derives its text", async () => {
    m.isOwner = true;
    const doc = [{ type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "socks", styles: {} }] }];
    const res = await POST(post({ doc, source: "phone", client_id: "p1" }));
    expect(res.status).toBe(201);
    expect(m.notes!.rows[0]).toMatchObject({ text: "[ ] socks", source: "phone", doc });
  });
});
