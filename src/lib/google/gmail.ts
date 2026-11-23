import "server-only";
import { z } from "zod";
import { googleApi, GoogleError, requireApproval, run, type GoogleResult } from "./client";

/**
 * Gmail as typed tools for the Hydra Agent and routines: search, read a thread, draft, send, label,
 * trash. Send and trash refuse to run without the confirm gate's approval id (DESIGN.md 6.9: sends
 * and deletes always wait for the owner's yes). Every field read from an email is data, never
 * instructions: the agent must keep it out of its instructions.
 */

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_TEXT = 20_000;

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw new GoogleError("invalid_input", z.prettifyError(r.error));
  return r.data;
}

const id = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const oneLine = (max: number) => z.string().max(max).refine((s) => !/[\r\n]/.test(s), "One line only");

interface Part {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: Part[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: Part;
}

const header = (m: GmailMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function findPart(p: Part, type: string): string | null {
  if (p.mimeType === type && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const child of p.parts ?? []) {
    const found = findPart(child, type);
    if (found !== null) return found;
  }
  return null;
}

/** The message's plain text: the text/plain part, else the HTML part with its tags stripped. */
export function messageText(payload: Part | undefined): string {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain");
  const text =
    plain ??
    (findPart(payload, "text/html") ?? "")
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ");
  return text.trim().slice(0, MAX_TEXT);
}

// ---------------------------------------------------------------------------
// Search and read
// ---------------------------------------------------------------------------

export const searchInput = z.object({
  /** Gmail search syntax: `from:brand.com newer_than:7d`, ... */
  query: z.string().trim().min(1).max(500),
  maxResults: z.int().min(1).max(25).default(10),
  pageToken: z.string().max(500).optional(),
});

export interface ThreadSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

export async function searchThreads(
  input: z.input<typeof searchInput>,
): Promise<GoogleResult<{ threads: ThreadSummary[]; nextPageToken: string | null }>> {
  return run(async () => {
    const { query, maxResults, pageToken } = parse(searchInput, input);
    const list = await googleApi<{ threads?: { id: string; snippet?: string }[]; nextPageToken?: string }>(`${GMAIL}/threads`, {
      query: { q: query, maxResults, pageToken },
    });
    const threads = await Promise.all(
      (list.threads ?? []).map(async (t) => {
        const meta = await googleApi<{ messages?: GmailMessage[] }>(
          `${GMAIL}/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        );
        const [first, last] = [meta.messages?.[0], meta.messages?.at(-1)];
        return {
          id: t.id,
          subject: first ? header(first, "Subject") : "",
          from: last ? header(last, "From") : "",
          date: last ? header(last, "Date") : "",
          snippet: t.snippet ?? "",
        };
      }),
    );
    return { threads, nextPageToken: list.nextPageToken ?? null };
  });
}

export interface ThreadMessage {
  id: string;
  /** The RFC Message-ID header: pass it as `inReplyTo` to answer this message. */
  messageIdHeader: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  labelIds: string[];
  text: string;
}

export async function readThread(threadId: string): Promise<GoogleResult<{ id: string; messages: ThreadMessage[] }>> {
  return run(async () => {
    const tid = parse(id, threadId);
    const thread = await googleApi<{ id: string; messages?: GmailMessage[] }>(`${GMAIL}/threads/${tid}`, { query: { format: "full" } });
    return {
      id: thread.id,
      messages: (thread.messages ?? []).map((m) => ({
        id: m.id,
        messageIdHeader: header(m, "Message-ID"),
        from: header(m, "From"),
        to: header(m, "To"),
        cc: header(m, "Cc"),
        subject: header(m, "Subject"),
        date: header(m, "Date"),
        labelIds: m.labelIds ?? [],
        text: messageText(m.payload),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Draft and send
// ---------------------------------------------------------------------------

export const messageInput = z.object({
  to: z.array(z.email()).min(1).max(50),
  cc: z.array(z.email()).max(50).default([]),
  bcc: z.array(z.email()).max(50).default([]),
  subject: oneLine(500),
  body: z.string().max(100_000),
  /** Reply in this Gmail thread. */
  threadId: id.optional(),
  /** The Message-ID header of the email this answers (readThread's messageIdHeader). */
  inReplyTo: oneLine(1000).optional(),
});
export type MessageInput = z.input<typeof messageInput>;

const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** An RFC 2822 message, base64url, as Gmail's `raw` field wants it. Inputs are one line each (no header injection). */
export function rawMessage(m: z.output<typeof messageInput>): string {
  const headers = [
    `To: ${m.to.join(", ")}`,
    m.cc.length ? `Cc: ${m.cc.join(", ")}` : "",
    m.bcc.length ? `Bcc: ${m.bcc.join(", ")}` : "",
    `Subject: ${encodeWord(m.subject)}`,
    m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}\r\nReferences: ${m.inReplyTo}` : "",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  const body = Buffer.from(m.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

/** A draft in the owner's Gmail. Nothing is sent. */
export async function createDraft(input: MessageInput): Promise<GoogleResult<{ draftId: string; messageId: string; threadId: string }>> {
  return run(async () => {
    const m = parse(messageInput, input);
    const draft = await googleApi<{ id: string; message: { id: string; threadId: string } }>(`${GMAIL}/drafts`, {
      method: "POST",
      body: { message: { raw: rawMessage(m), threadId: m.threadId } },
    });
    return { draftId: draft.id, messageId: draft.message.id, threadId: draft.message.threadId };
  });
}

export const sendInput = z.union([z.object({ draftId: id }), messageInput]);

/** Send a draft, or a new message. Refused without the confirm gate's approval id. */
export async function sendEmail(
  input: { draftId: string } | MessageInput,
  approvalId: string,
): Promise<GoogleResult<{ messageId: string; threadId: string }>> {
  return run(async () => {
    await requireApproval(approvalId);
    const m = parse(sendInput, input);
    const sent =
      "draftId" in m
        ? await googleApi<{ id: string; threadId: string }>(`${GMAIL}/drafts/send`, { method: "POST", body: { id: m.draftId } })
        : await googleApi<{ id: string; threadId: string }>(`${GMAIL}/messages/send`, {
            method: "POST",
            body: { raw: rawMessage(m), threadId: m.threadId },
          });
    return { messageId: sent.id, threadId: sent.threadId };
  });
}

// ---------------------------------------------------------------------------
// Label and trash
// ---------------------------------------------------------------------------

export const labelInput = z
  .object({
    threadId: id,
    /** Label names or ids (system labels too: INBOX, UNREAD, STARRED, IMPORTANT). */
    add: z.array(z.string().trim().min(1).max(225)).max(20).default([]),
    remove: z.array(z.string().trim().min(1).max(225)).max(20).default([]),
  })
  .refine((l) => l.add.length + l.remove.length > 0, "Add or remove a label");

// ponytail: an unknown label name is refused, not created. Add label creation if routines need it.
export async function labelThread(input: z.input<typeof labelInput>): Promise<GoogleResult<{ threadId: string; added: string[]; removed: string[] }>> {
  return run(async () => {
    const l = parse(labelInput, input);
    const { labels = [] } = await googleApi<{ labels?: { id: string; name: string }[] }>(`${GMAIL}/labels`);
    const idOf = (name: string) => {
      const hit = labels.find((x) => x.id === name || x.name.toLowerCase() === name.toLowerCase());
      if (!hit) throw new GoogleError("unknown_label", `No Gmail label named ${name}`);
      return hit.id;
    };
    const [added, removed] = [l.add.map(idOf), l.remove.map(idOf)];
    // Trash and spam move mail out of sight: that is trashThread, which needs the owner's yes.
    if (added.some((x) => x === "TRASH" || x === "SPAM")) throw new GoogleError("invalid_input", "Use trash, which asks first");
    await googleApi(`${GMAIL}/threads/${l.threadId}/modify`, { method: "POST", body: { addLabelIds: added, removeLabelIds: removed } });
    return { threadId: l.threadId, added, removed };
  });
}

/** Move a thread to the trash (Gmail keeps it 30 days). Refused without the confirm gate's approval id. */
export async function trashThread(threadId: string, approvalId: string): Promise<GoogleResult<{ threadId: string; trashed: true }>> {
  return run(async () => {
    await requireApproval(approvalId);
    const tid = parse(id, threadId);
    await googleApi(`${GMAIL}/threads/${tid}/trash`, { method: "POST" });
    return { threadId: tid, trashed: true as const };
  });
}
