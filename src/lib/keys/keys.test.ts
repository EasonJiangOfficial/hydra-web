// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { argsOf, fakeDb, type Call, type Reply } from "@/lib/planning/test-db";

const mocks = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createServerClient: mocks.createServerClient }));

const { bearerKey, checkApiKey, generateApiKey, hashApiKey } = await import("./keys");
const { createApiKey, listApiKeys, revokeApiKey } = await import("./actions");

const KEY_ID = "a8000000-0000-4000-8000-000000000001";
const ROW = {
  id: KEY_ID,
  name: "Grokbot",
  prefix: "hyd_ugc_AbCd",
  scope: "ugc:write",
  rate_limit_per_minute: 120,
  created_at: "2026-11-21T15:00:00Z",
  last_used_at: null,
  revoked_at: null,
};

describe("keys", () => {
  it("are hyd_ugc_ plus 40 random base64url characters; only the SHA-256 and a short prefix leave", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.secret).toMatch(/^hyd_ugc_[A-Za-z0-9_-]{40}$/);
    expect(a.secret).not.toBe(b.secret);
    expect(a.hash).toBe(createHash("sha256").update(a.secret).digest("hex"));
    expect(a.hash).toBe(hashApiKey(a.secret));
    expect(a.prefix).toBe(a.secret.slice(0, 12));
    expect(a.secret.startsWith(a.prefix)).toBe(true);
  });

  it("are read from a Bearer header only when shaped like a key", () => {
    const { secret } = generateApiKey();
    expect(bearerKey(`Bearer ${secret}`)).toBe(secret);
    expect(bearerKey(`bearer  ${secret} `)).toBe(secret);
    for (const bad of [null, "", secret, `Basic ${secret}`, `Bearer ${secret} extra`, `Bearer ${secret}x`, "Bearer hyd_ugc_short", `Bearer hyd_fin_${secret.slice(8)}`]) {
      expect(bearerKey(bad)).toBeNull();
    }
  });

  it("are checked by hash in the database, and every status maps", async () => {
    const { secret, hash } = generateApiKey();
    const cases: [Reply, unknown][] = [
      [{ data: { key_id: KEY_ID, status: "ok", retry_after_seconds: null } }, { status: "ok", keyId: KEY_ID }],
      [{ data: { key_id: null, status: "invalid", retry_after_seconds: null } }, { status: "invalid" }],
      [{ data: { key_id: KEY_ID, status: "revoked", retry_after_seconds: null } }, { status: "revoked" }],
      [{ data: { key_id: KEY_ID, status: "forbidden", retry_after_seconds: null } }, { status: "forbidden" }],
      [{ data: { key_id: KEY_ID, status: "rate_limited", retry_after_seconds: 17 } }, { status: "rate_limited", retryAfterSeconds: 17 }],
      [{ data: null, error: { message: "boom" } }, { status: "error" }],
      [{ data: { key_id: null, status: "weird", retry_after_seconds: null } }, { status: "error" }],
    ];
    for (const [reply, expected] of cases) {
      const { db, calls } = fakeDb(() => reply);
      expect(await checkApiKey(db, secret, "ugc:write")).toEqual(expected);
      expect(calls[0]).toMatchObject({ rpc: "api_key_authenticate", rpcArgs: { p_key_hash: hash, p_scope: "ugc:write" } });
      expect(JSON.stringify(calls)).not.toContain(secret);
    }
  });
});

describe("key actions", () => {
  let owner = true;
  let calls: Call[];
  function serve(reply: (call: Call) => Reply) {
    const fake = fakeDb((call) => (call.rpc === "is_owner" ? { data: owner } : reply(call)));
    calls = fake.calls;
    mocks.createServerClient.mockResolvedValue(fake.db);
  }
  const writes = () => calls.filter((c) => c.table === "api_keys");

  beforeEach(() => {
    vi.clearAllMocks();
    owner = true;
  });

  it("refuse anyone but the owner and touch no key row", async () => {
    owner = false;
    serve(() => ({ data: ROW }));
    expect(await createApiKey({ name: "Grokbot" })).toMatchObject({ ok: false, error: { code: "not_owner" } });
    expect(await listApiKeys()).toMatchObject({ ok: false, error: { code: "not_owner" } });
    expect(await revokeApiKey({ id: KEY_ID })).toMatchObject({ ok: false, error: { code: "not_owner" } });
    expect(writes()).toEqual([]);
  });

  it("create: stores the hash, never the secret, and returns the secret once", async () => {
    serve(() => ({ data: ROW }));
    const res = await createApiKey({ name: "  Grokbot " });
    if (!res.ok) throw new Error(res.error.message);
    const [inserted] = argsOf(writes()[0], "insert") as [Record<string, string>];
    expect(inserted).toEqual({ name: "Grokbot", prefix: res.data.secret.slice(0, 12), key_hash: hashApiKey(res.data.secret), scope: "ugc:write" });
    expect(JSON.stringify(inserted)).not.toContain(res.data.secret);
    expect(res.data.key).toEqual(ROW);
    expect(await createApiKey({ name: " " })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("list: newest first, never the hash", async () => {
    serve(() => ({ data: [ROW] }));
    expect(await listApiKeys()).toEqual({ ok: true, data: [ROW] });
    const columns = argsOf(writes()[0], "select")![0] as string;
    expect(columns).not.toContain("key_hash");
    expect(argsOf(writes()[0], "order")).toEqual(["created_at", { ascending: false }]);
  });

  it("revoke: stamps an unrevoked key, keeps the first stamp, and reports an unknown id", async () => {
    serve(() => ({ data: { ...ROW, revoked_at: "2026-11-21T16:00:00Z" } }));
    expect(await revokeApiKey({ id: KEY_ID })).toMatchObject({ ok: true, data: { revoked_at: "2026-11-21T16:00:00Z" } });
    expect(argsOf(writes()[0], "update")![0]).toEqual({ revoked_at: expect.any(String) });
    expect(argsOf(writes()[0], "is")).toEqual(["revoked_at", null]);

    let n = 0;
    serve(() => (n++ === 0 ? { data: null } : { data: { ...ROW, revoked_at: "2026-11-20T00:00:00Z" } }));
    expect(await revokeApiKey({ id: KEY_ID })).toMatchObject({ ok: true, data: { revoked_at: "2026-11-20T00:00:00Z" } });

    serve(() => ({ data: null }));
    expect(await revokeApiKey({ id: KEY_ID })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await revokeApiKey({ id: "nope" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
