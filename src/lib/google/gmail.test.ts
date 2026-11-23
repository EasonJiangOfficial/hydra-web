// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "@/lib/bank/crypto";
import { fakeGoogle, memoryDb, type Call } from "./fixtures";

const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));

const gmail = await import("./gmail");

const ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";
// agent_approvals rows: the confirm gate's yes (approved, or done: claimed for this run).
const YES_1 = "dddddddd-0000-4000-8000-000000000001";
const YES_2 = "dddddddd-0000-4000-8000-000000000002";
const YES_3 = "dddddddd-0000-4000-8000-000000000003";
const PENDING = "dddddddd-0000-4000-8000-000000000004";
const DECLINED = "dddddddd-0000-4000-8000-000000000005";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
let google: ReturnType<typeof fakeGoogle>;

function gmailApi(call: Call): Response | undefined {
  const p = call.url.pathname.replace("/gmail/v1/users/me", "");
  const ok = (body: unknown) => Response.json(body);
  if (p === "/threads" && call.method === "GET") return ok({ threads: [{ id: "t1", snippet: "Your payout is on the way" }] });
  if (p === "/threads/t1" && call.url.searchParams.get("format") === "metadata") {
    return ok({ id: "t1", messages: [{ id: "m1", threadId: "t1", payload: { headers: [{ name: "Subject", value: "Payout" }, { name: "From", value: "pay@brand.example" }, { name: "Date", value: "Fri, 20 Nov 2026" }] } }] });
  }
  if (p === "/threads/t1" && call.url.searchParams.get("format") === "full") {
    return ok({
      id: "t1",
      messages: [
        {
          id: "m1",
          threadId: "t1",
          labelIds: ["INBOX"],
          payload: {
            mimeType: "multipart/alternative",
            headers: [{ name: "Message-ID", value: "<abc@brand.example>" }, { name: "Subject", value: "Payout" }],
            parts: [
              { mimeType: "text/plain", body: { data: b64("Paid $500 for 2 videos.") } },
              { mimeType: "text/html", body: { data: b64("<p>Paid</p>") } },
            ],
          },
        },
        { id: "m2", threadId: "t1", payload: { mimeType: "text/html", body: { data: b64("<style>x{}</style><p>Thanks&nbsp;<b>so</b> much</p>") } } },
      ],
    });
  }
  if (p === "/labels") return ok({ labels: [{ id: "INBOX", name: "INBOX" }, { id: "UNREAD", name: "UNREAD" }, { id: "Label_7", name: "Brand deals" }, { id: "TRASH", name: "TRASH" }, { id: "SPAM", name: "SPAM" }] });
  if (p === "/drafts" && call.method === "POST") return ok({ id: "d1", message: { id: "m9", threadId: "t9" } });
  if (/^\/(drafts\/send|messages\/send)$/.test(p)) return ok({ id: "m10", threadId: "t10" });
  if (/^\/threads\/t1\/(modify|trash)$/.test(p)) return ok({ id: "t1" });
  return undefined;
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  vi.stubEnv("HYDRA_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
  google = fakeGoogle(gmailApi);
  vi.stubGlobal("fetch", vi.fn(google.fetch));
  mocks.db = memoryDb({
    google_accounts: [
      {
        id: ACCOUNT,
        email: "owner@example.test",
        scopes: "",
        status: "active",
        access_token: encryptToken("access-1", ACCOUNT),
        access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        refresh_token: encryptToken("refresh-1", ACCOUNT),
      },
    ],
    agent_approvals: [
      { id: YES_1, status: "approved" },
      { id: YES_2, status: "done" },
      { id: YES_3, status: "approved" },
      { id: PENDING, status: "pending" },
      { id: DECLINED, status: "declined" },
    ],
  }).db;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const decodeRaw = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
const MESSAGE = { to: ["pay@brand.example"], subject: "Invoice", body: "Hi, the invoice is attached." };

describe("send and trash need the owner's yes", () => {
  it("send is refused without an approval id, before anything reaches Google", async () => {
    for (const approval of [undefined, "", "   "]) {
      const r = await gmail.sendEmail(MESSAGE, approval as unknown as string);
      expect(r).toMatchObject({ ok: false, error: { code: "approval_required" } });
    }
    expect(await gmail.sendEmail({ draftId: "d1" }, undefined as unknown as string)).toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(google.calls).toEqual([]);
  });

  it("a made-up id, or an approval the owner has not said yes to, is refused too", async () => {
    for (const approval of ["approval-1", "dddddddd-0000-4000-8000-0000000000ff", PENDING, DECLINED]) {
      expect(await gmail.sendEmail(MESSAGE, approval)).toMatchObject({ ok: false, error: { code: "approval_required" } });
      expect(await gmail.trashThread("t1", approval)).toMatchObject({ ok: false, error: { code: "approval_required" } });
    }
    expect(google.calls).toEqual([]);
  });

  it("send goes out with the approval id", async () => {
    expect(await gmail.sendEmail(MESSAGE, YES_1)).toEqual({ ok: true, data: { messageId: "m10", threadId: "t10" } });
    const call = google.calls.find((c) => c.url.pathname.endsWith("/messages/send"))!;
    const raw = decodeRaw((call.body as { raw: string }).raw);
    expect(raw).toContain("To: pay@brand.example\r\n");
    expect(raw).toContain("Subject: Invoice\r\n");
    expect(raw.split("\r\n\r\n")[1].replace(/\r\n/g, "")).toBe(Buffer.from(MESSAGE.body).toString("base64"));

    expect(await gmail.sendEmail({ draftId: "d1" }, YES_2)).toMatchObject({ ok: true });
    expect(google.calls.find((c) => c.url.pathname.endsWith("/drafts/send"))!.body).toEqual({ id: "d1" });
  });

  it("trash is refused without an approval id and works with one", async () => {
    expect(await gmail.trashThread("t1", "")).toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(google.calls).toEqual([]);
    expect(await gmail.trashThread("t1", YES_3)).toEqual({ ok: true, data: { threadId: "t1", trashed: true } });
    expect(google.calls.at(-1)!.url.pathname).toBe("/gmail/v1/users/me/threads/t1/trash");
  });
});

describe("drafts", () => {
  it("builds a reply draft with a UTF-8 subject and threading headers", async () => {
    const r = await gmail.createDraft({ ...MESSAGE, subject: "Facture réglée", threadId: "t1", inReplyTo: "<abc@brand.example>" });
    expect(r).toEqual({ ok: true, data: { draftId: "d1", messageId: "m9", threadId: "t9" } });
    const body = google.calls.at(-1)!.body as { message: { raw: string; threadId: string } };
    expect(body.message.threadId).toBe("t1");
    const raw = decodeRaw(body.message.raw);
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Facture réglée").toString("base64")}?=`);
    expect(raw).toContain("In-Reply-To: <abc@brand.example>\r\nReferences: <abc@brand.example>");
  });

  it("refuses header injection and bad addresses", async () => {
    expect(await gmail.createDraft({ ...MESSAGE, subject: "Hi\r\nBcc: evil@example.com" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await gmail.createDraft({ ...MESSAGE, to: ["a@b.example\r\nBcc: x@y.example"] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(google.calls).toEqual([]);
  });
});

describe("search, read, label", () => {
  it("search returns each thread's subject and sender", async () => {
    const r = await gmail.searchThreads({ query: "from:brand.example newer_than:7d" });
    expect(r).toEqual({
      ok: true,
      data: { threads: [{ id: "t1", subject: "Payout", from: "pay@brand.example", date: "Fri, 20 Nov 2026", snippet: "Your payout is on the way" }], nextPageToken: null },
    });
    expect(google.calls[0].url.searchParams.get("q")).toBe("from:brand.example newer_than:7d");
  });

  it("read returns plain text, or the HTML with its tags stripped", async () => {
    const r = await gmail.readThread("t1");
    expect(r.ok && r.data.messages.map((m) => m.text)).toEqual(["Paid $500 for 2 videos.", "Thanks so much"]);
    expect(r.ok && r.data.messages[0].messageIdHeader).toBe("<abc@brand.example>");
    expect(await gmail.readThread("../labels")).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("label takes names or ids and refuses an unknown name", async () => {
    expect(await gmail.labelThread({ threadId: "t1", add: ["brand deals"], remove: ["UNREAD"] })).toEqual({
      ok: true,
      data: { threadId: "t1", added: ["Label_7"], removed: ["UNREAD"] },
    });
    expect(google.calls.at(-1)!.body).toEqual({ addLabelIds: ["Label_7"], removeLabelIds: ["UNREAD"] });
    expect(await gmail.labelThread({ threadId: "t1", add: ["Nope"] })).toMatchObject({ ok: false, error: { code: "unknown_label" } });
  });

  it("label never trashes or spams a thread (that is trash, which asks first)", async () => {
    const before = google.calls.length;
    for (const label of ["TRASH", "SPAM", "trash"]) {
      expect(await gmail.labelThread({ threadId: "t1", add: [label] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    expect(google.calls.slice(before).some((c) => c.url.pathname.endsWith("/modify"))).toBe(false);
  });
});
