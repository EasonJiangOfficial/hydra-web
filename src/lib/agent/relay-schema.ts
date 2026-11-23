import { z } from "zod";

/**
 * The relay wire contract (W3 contract and its fixes, 2026-11-22): the ONE source of every shape and
 * limit the Mac posts. The server validates with these; Hydra Desktop copies this file verbatim into
 * its tests (and its event validation), so a shape mismatch fails a test on both sides.
 * Keep it plain JavaScript inside a .ts file (only `zod`, no type syntax) so it runs as .mjs too.
 */

export const LIMITS = Object.freeze({
  textDelta: 8000,
  toolName: 64,
  toolSummary: 500,
  confirmSummary: 500,
  errorMessage: 1000,
  errorCode: 64,
  panelValue: 100,
  selector: 200,
  href: 500,
  batch: 500,
  instruction: 4000,
  inputText: 8000,
});

/** The URL params the shared kit DetailDrawer reads (DESIGN.md section 7). */
export const panelParamSchema = z.enum(["tx", "day", "account", "task", "goal", "deal", "category", "routine", "taxline"]);
export const PANEL_PARAMS = panelParamSchema.options;
/** The scope: "all" or any entity slug (businesses the owner adds, 0170_businesses.sql). */
export const scopeSchema = z.string().regex(/^(all|[a-z0-9][a-z0-9-]{0,39})$/, "all, or an entity slug");
/** The seeded scopes. Any entity slug also passes scopeSchema. */
export const SCOPES = Object.freeze(["all", "personal", "ugc"]);

const PATH_BASE = "https://hydra.invalid";

/**
 * A path inside Hydra the agent may send the window to: one leading slash, no scheme or host, no `//`,
 * backslash, whitespace or control character (the URL parser drops tabs and newlines, so "/\t/evil.example"
 * would become "//evil.example"), and never an API, auth or login route, even after dot segments. The one
 * navigate rule: the web's isSafePath (src/components/agent/words.ts) runs this same schema.
 */
export const internalHref = z
  .string()
  .max(LIMITS.href)
  .refine((href) => {
    if (!href.startsWith("/") || href.startsWith("//") || /[\u0000-\u001F\u007F-\u009F\s\\]/.test(href)) return false;
    try {
      const url = new URL(href, PATH_BASE);
      return url.origin === PATH_BASE && !/^\/(api|auth|login)(\/|$)/i.test(url.pathname);
    } catch {
      return false;
    }
  }, "A path inside Hydra, like /transactions?tx=...");

export const uiActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), href: internalHref }).strict(),
  z
    .object({ kind: z.literal("openPanel"), param: panelParamSchema, value: z.string().min(1).max(LIMITS.panelValue).regex(/^[\w-]+$/) })
    .strict(),
  z.object({ kind: z.literal("setScope"), scope: scopeSchema }).strict(),
  z.object({ kind: z.literal("highlight"), selector: z.string().min(1).max(LIMITS.selector) }).strict(),
]);

/** Usage is optional and lenient: snake_case counts are kept, anything else (other keys, bad values) is dropped. */
const count = z.number().int().min(0).optional().catch(undefined);
export const usageSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined),
  z.object({ input_tokens: count, output_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count }).optional(),
);

/** The events a Mac may post: the SSE contract minus `thread` (the server owns threads). */
export const relayEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), delta: z.string().max(LIMITS.textDelta) }).strict(),
  z
    .object({
      type: z.literal("tool"),
      name: z.string().min(1).max(LIMITS.toolName),
      status: z.enum(["start", "done", "error"]),
      summary: z.string().max(LIMITS.toolSummary),
    })
    .strict(),
  z.object({ type: z.literal("ui"), action: uiActionSchema }).strict(),
  z.object({ type: z.literal("confirm"), id: z.uuid(), summary: z.string().min(1).max(LIMITS.confirmSummary), danger: z.boolean() }).strict(),
  z.object({ type: z.literal("done"), usage: usageSchema }).strict(),
  // Who answered this turn (models.ts): once per turn, from whichever runtime ran it. fallback: why it is not the model
  // the owner picked (not connected, the provider failed before any tool or text, or the server runs Claude only).
  z
    .object({
      type: z.literal("model"),
      model: z.string().min(1).max(100),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
      fallback: z.enum(["not_connected", "provider_error", "server_claude_only"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("error"), message: z.string().min(1).max(LIMITS.errorMessage), code: z.string().max(LIMITS.errorCode).optional() }).strict(),
]);

/**
 * POST /api/agent/relay/events body. claimId: the claim /relay/next handed out (409 stale_claim once
 * it is not the turn's current claim). seq (optional): this claim's number of the batch's first event
 * (1, 2, ...), so a retried post is stored once. events: at most 500; done or error only last;
 * an empty list is the heartbeat that renews the 60 s lease.
 */
export const relayBatchSchema = z
  .object({
    turnId: z.uuid(),
    claimId: z.uuid(),
    seq: z.number().int().min(1).optional(),
    events: z.array(relayEventSchema).max(LIMITS.batch),
    // 0191: the highest input seq the device pushed into its session (optional; older devices leave it out).
    inputsSeen: z.number().int().min(0).optional(),
  })
  .refine((b) => b.events.every((e, i) => (e.type !== "done" && e.type !== "error") || i === b.events.length - 1), { message: "done or error must be the last event" });

/**
 * 0191, add-on while thinking: what the owner said or typed while the turn ran. Every events answer (batches and
 * heartbeats) carries `inputs` the device has not acknowledged; it pushes each into the running session as an
 * extra user message prefixed ADDED_PREFIX, and sends `inputsSeen` (the highest seq) in its next post. A done sent
 * while some wait past its inputsSeen is held: the answer says "claimed" with them; it answers them, then sends done again.
 */
export const ADDED_PREFIX = "(added while you were working) ";
export const relayInputSchema = z.object({ seq: z.number().int().min(1), text: z.string().min(1).max(LIMITS.inputText) });
/** POST /api/agent/relay/events answer. `inputs` is new and optional: an older server leaves it out. */
export const relayEventsAnswerSchema = z.object({ ok: z.literal(true), status: z.string(), inputs: z.array(relayInputSchema).optional() });
/** POST /api/agent/turn/append body (owner session): words added to the turn in flight. */
export const appendInputSchema = z.object({ turnId: z.uuid(), text: z.string().trim().min(1).max(LIMITS.inputText) });

/**
 * POST /api/agent/relay/approval body: an ask the Mac would show locally becomes the owner's approval.
 * deletion (0200, optional; Hydra Desktop build 4 always sends it): the Mac's own per-action tag, true when the
 * action can delete or lose anything. Approve all runs an ask without the owner only when the Mac declared
 * approveAllDeletionTags and sent deletion false (and danger false); a missing deletion asks.
 */
export const relayApprovalSchema = z.object({
  turnId: z.uuid(),
  claimId: z.uuid(),
  summary: z.string().trim().min(1).max(LIMITS.confirmSummary),
  danger: z.boolean(),
  deletion: z.boolean().optional(),
});

/**
 * 0200: what a Mac can do, declared on every relay request (GET /relay/next records it for the device; an older Mac
 * sends none, which clears it) and on GET /api/agent/jobs (a risky step approve all let through goes only to a pull
 * that declares it) as JSON in the CAPABILITIES_HEADER header, like {"approveAllDeletionTags":1}.
 * approveAllDeletionTags 1: every approval POST carries `deletion` from its own per-action tag, and for a queued Mac
 * step it asks locally before any deletion-class action. signedIn (models): the services this Mac is signed in to and
 * runs turns on, like ["chatgpt"]; ChatGPT models are pickable only while a live Mac reports "chatgpt".
 * Unknown keys and unknown sign-in names are dropped; anything unreadable is {}.
 */
export const CAPABILITIES_HEADER = "x-hydra-capabilities";
export const capabilitiesSchema = z.preprocess(
  (v) => {
    try {
      return JSON.parse(String(v));
    } catch {
      return {};
    }
  },
  z
    .object({
      approveAllDeletionTags: z.literal(1).optional().catch(undefined),
      // Filtered entry by entry: an unknown name, a non-string or a long list beside "chatgpt" never drops it.
      signedIn: z
        .array(z.unknown())
        .transform((names) => names.filter((n) => n === "chatgpt"))
        .pipe(z.array(z.enum(["chatgpt"])).max(8))
        .transform((known) => (known.length ? known : undefined))
        .optional()
        .catch(undefined),
    })
    .catch({}),
);

/** GET /api/agent/relay/next?slot=: the Mac serves one live turn and one routine turn at a time. */
export const slotSchema = z.enum(["live", "routine"]);

/**
 * POST /api/agent/relay/local body: a turn the owner had with Hydra on the Mac itself (local voice).
 * The server appends his words and the reply to threadId (when it is his), else to his newest thread
 * updated in the last 30 minutes (counted back from `at`, never from the future), else to a new one,
 * and answers {threadId}: the Mac keeps it as its current thread for 30 minutes of quiet.
 */
export const localTurnSchema = z.object({
  user: z.string().min(1).max(8000),
  assistant: z.string().max(32000),
  threadId: z.uuid().optional(),
  at: z.iso.datetime({ offset: true }).optional(),
});

/**
 * POST /api/agent/relay/subturn body (the server brain only; W5 contract section 7): the brain asks
 * the Mac to act inside the turn it holds under claimId. Answers 201 {subTurnId}. Only a Mac claims a
 * sub-turn: its /relay/next turn carries parentTurnId and allowedTools ["mac"]. No Mac online: it is
 * closed at once and its result says "Your Mac is offline.".
 */
export const relaySubturnSchema = z.object({ turnId: z.uuid(), claimId: z.uuid(), instruction: z.string().trim().min(1).max(LIMITS.instruction) });

/**
 * GET /api/agent/relay/subturn?id= answer: the brain polls until status is done, error or expired and
 * uses text as the tool result (the Mac's words; on error or expiry, its words so far and the reason).
 */
export const subturnStatusSchema = z.enum(["queued", "claimed", "done", "error", "expired"]);
export const subturnResultSchema = z.object({ status: subturnStatusSchema, text: z.string() });
