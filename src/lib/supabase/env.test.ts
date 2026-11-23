import { afterEach, describe, expect, it, vi } from "vitest";
import { MissingEnvError, ownerEmail, publicEnv } from "./env";

afterEach(() => vi.unstubAllEnvs());

describe("env", () => {
  it("fails closed and names the missing variable", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "pk");
    expect(() => publicEnv()).toThrow(MissingEnvError);
    expect(() => publicEnv()).toThrow("NEXT_PUBLIC_SUPABASE_URL");
    vi.stubEnv("HYDRA_OWNER_EMAIL", " ");
    expect(() => ownerEmail()).toThrow("HYDRA_OWNER_EMAIL");
  });

  it("reads and trims values", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", " http://127.0.0.1:55421 ");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "pk");
    vi.stubEnv("HYDRA_OWNER_EMAIL", "Owner@Example.com");
    expect(publicEnv()).toEqual({ url: "http://127.0.0.1:55421", publishableKey: "pk" });
    expect(ownerEmail()).toBe("owner@example.com");
  });
});
