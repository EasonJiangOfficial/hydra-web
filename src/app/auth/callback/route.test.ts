import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = { exchangeCodeForSession: vi.fn(), signOut: vi.fn() };
const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createServerClient: async () => ({ auth, rpc }) }));

const { GET } = await import("./route");

const call = async (query: string) => {
  const res = await GET(new NextRequest(`http://localhost:3100/auth/callback${query}`));
  const loc = new URL(res.headers.get("location") ?? "");
  return { status: res.status, origin: loc.origin, path: `${loc.pathname}${loc.search}` };
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.exchangeCodeForSession.mockResolvedValue({ error: null });
  rpc.mockResolvedValue({ data: true, error: null });
});

describe("auth callback", () => {
  it("sends the owner to the passkey step with a safe next", async () => {
    expect(await call("?code=c&next=%2Fplanning")).toEqual({
      status: 303,
      origin: "http://localhost:3100",
      path: "/login?step=passkey&next=%2Fplanning",
    });
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("c");
  });

  it.each(["https%3A%2F%2Fevil.example", "%2F.%2F%2Fevil.example", "%2Fa%2F..%2F%2Fevil.example", "%2F%09%2Fevil.example"])(
    "drops an off-site next (%s)",
    async (next) => {
      const { origin, path } = await call(`?code=c&next=${next}`);
      expect(origin).toBe("http://localhost:3100");
      expect(path).toBe("/login?step=passkey&next=%2F");
    },
  );

  it("a missing or bad code goes back to login with an error", async () => {
    expect((await call("?next=%2F")).path).toBe("/login?error=link");
    auth.exchangeCodeForSession.mockResolvedValue({ error: new Error("expired") });
    expect((await call("?code=c")).path).toBe("/login?error=link");
  });

  it("signs a non-owner straight back out", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect((await call("?code=c&next=%2Fplanning")).path).toBe("/login");
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
