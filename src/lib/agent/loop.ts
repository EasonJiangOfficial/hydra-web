import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextBlockParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Emit, Scope, Usage } from "./events";
import { stripEmotes } from "./emotes";
import { clampEffort, DEFAULT_MODEL, isModelId, providerOf } from "./models";
import { asData, avatarStyle, contextBlock, SYSTEM_PROMPT } from "./prompt";
import { ADDED_PREFIX } from "./relay-schema";
import { autoApproves, type ToolCtx } from "./registry";
import type { AgentSettings, AgentStore } from "./store";
import { anthropicTools, executeTool, toolByName, type ExecResult } from "./tools";

/**
 * One agent turn on the Messages API: a manual streaming loop (DESIGN.md 6.9; claude-api skill,
 * "Streaming Manual Loop"). Adaptive thinking, effort from the settings, the frozen system prompt
 * and tool list cached, server-side refusal fallbacks. Every tool input is validated before the
 * tool runs (eager input streaming leaves validation to us). A gated tool pauses a live turn until
 * the owner answers (/api/agent/confirm); in a routine it leaves an approval and carries on.
 * The thread is append-only: each message is stored as sent and as returned.
 *
 * One turn at a time per thread (every surface shares it): a turn takes a lease on the thread and
 * frees it when it ends; a second turn waits briefly, then gives up with an error event. Only the
 * newest messages within a size budget are sent (whole turns, never a tool call without its result).
 */

export interface ModelStream {
  on(event: "text", listener: (delta: string) => void): unknown;
  finalMessage(): Promise<BetaMessage>;
}
/** The slice of the Anthropic client the loop uses (tests pass a fake). */
export interface ModelClient {
  beta: { messages: { stream(params: BetaMessageStreamParams, options?: { signal?: AbortSignal }): ModelStream } };
}

export interface TurnInput {
  client: ModelClient;
  store: AgentStore;
  /** Everything but the thread (made or checked here) and the ui sink (the emitter). */
  ctx: Omit<ToolCtx, "threadId" | "ui" | "store">;
  threadId?: string | null;
  text: string;
  page?: { path: string; search: string; scope: Scope };
  emit: Emit;
  signal?: AbortSignal;
  mode: "live" | "routine";
  settings: AgentSettings;
  /** How long a live turn waits for a yes (ms) and how often it looks. */
  confirmWaitMs?: number;
  pollMs?: number;
  /** How long a second turn waits for the thread (ms). */
  lockWaitMs?: number;
  /** The turn's time budget (ms): its function dies at maxDuration (300 s), so it stops asking before. */
  budgetMs?: number;
  /** When the request started (epoch ms). The budget counts from here, thread-lock wait included. */
  startedAt?: number;
}

export interface TurnResult {
  threadId: string;
  /** Everything Hydra said this turn. */
  text: string;
  usage: Usage;
  /** Approvals a routine left for the owner. */
  approvals: string[];
  /** Mac steps: queued while the Mac was off, or skipped. */
  mac: { queuedOffline: number; skipped: number };
  stop: string;
}

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_STEPS = 16;
const MAX_TOKENS = 32_000;
const ROUTINE_APPROVAL_MS = 7 * 86_400_000;
/** The thread lease: the turn function's maxDuration. A killed turn frees the thread by itself. */
export const TURN_LEASE_S = 300;
const TURN_BUDGET_MS = 280_000;
/** A confirm needs at least this long left in the turn to be worth asking. */
const MIN_CONFIRM_MS = 5_000;
export const BUSY_MESSAGE = "Hydra is still answering on this thread. Try again in a moment.";

/** History sent to the model: at most this many stored messages and about 120k tokens of them. */
export const HISTORY_ROWS = 500;
export const HISTORY_CHARS = 480_000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Every tool call needs its result in the next message (a turn that died mid-tool leaves one bare, anywhere in the
 * thread). Fixes `history` in place: the missing results go first in the next user message, or in a new one. A bare
 * call in the last message is not fixed: its results are returned for the message that comes next.
 */
export function repairHistory(history: BetaMessageParam[]): BetaToolResultBlockParam[] {
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const next = history[i + 1];
    const nextBlocks: BetaContentBlockParam[] = next?.role !== "user" ? [] : typeof next.content === "string" ? [{ type: "text", text: next.content }] : next.content;
    const answered = new Set(nextBlocks.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])));
    const missing: BetaToolResultBlockParam[] = m.content
      .filter((b): b is BetaToolUseBlock => b.type === "tool_use" && !answered.has(b.id))
      .map((b) => ({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "Interrupted before it ran." }));
    if (!missing.length) continue;
    if (!next) return missing;
    if (next.role === "user") history[i + 1] = { role: "user", content: [...missing, ...nextBlocks] };
    else history.splice(i + 1, 0, { role: "user", content: missing });
  }
  return [];
}

const isTurnStart = (m: BetaMessageParam) =>
  m.role === "user" && (typeof m.content === "string" || !m.content.some((b) => b.type === "tool_result"));

/** Drop thinking from a message kept after older ones were cut (its signature binds the full prefix). */
function withoutThinking(m: BetaMessageParam): BetaMessageParam {
  if (m.role !== "assistant" || typeof m.content === "string") return m;
  const content = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
  return { role: "assistant", content: content.length ? content : [{ type: "text", text: "(no reply)" }] };
}

/**
 * The newest whole turns within the budget. A cut lands only on a user message with no tool
 * result, so a tool call never loses its result. When anything older is left out, the kept
 * messages lose their thinking blocks (they are bound to the full prefix that was cut).
 */
export function boundHistory(loaded: BetaMessageParam[], opts: { chars?: number; capped?: boolean } = {}): { messages: BetaMessageParam[]; trimmed: boolean } {
  const budget = opts.chars ?? HISTORY_CHARS;
  let total = 0;
  let cut = loaded.length;
  for (let i = loaded.length - 1; i >= 0; i--) {
    total += JSON.stringify(loaded[i].content).length;
    if (total > budget) break;
    if (isTurnStart(loaded[i])) cut = i;
  }
  if (cut === 0 && !opts.capped) return { messages: loaded, trimmed: false };
  return { messages: loaded.slice(cut).map(withoutThinking), trimmed: true };
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const { store, emit, signal } = input;
  const surface = input.ctx.surface;
  // The budget starts before the thread-lock wait: the function's 300 s count from the request.
  const deadline = (input.startedAt ?? Date.now()) + (input.budgetMs ?? TURN_BUDGET_MS);
  let threadId = input.threadId && (await store.threadExists(input.threadId)) ? input.threadId : null;
  threadId ??= await store.createThread(surface, input.text.slice(0, 80));
  emit({ type: "thread", threadId });

  const token = randomUUID();
  const lockUntil = Date.now() + (input.lockWaitMs ?? 20_000);
  while (!(await store.claimThread(threadId, token, TURN_LEASE_S))) {
    if (Date.now() >= lockUntil || signal?.aborted) {
      const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      emit({ type: "error", message: BUSY_MESSAGE });
      emit({ type: "done", usage });
      return { threadId, text: "", usage, approvals: [], mac: { queuedOffline: 0, skipped: 0 }, stop: "busy" };
    }
    await sleep(input.pollMs ?? 400, signal);
  }
  // The lease token is the turn's id: words the owner adds while it works (POST /api/agent/turn/append) join it.
  emit({ type: "turn", turnId: token });
  try {
    return await turnOnThread(input, threadId, deadline, token);
  } finally {
    await store.releaseThread(threadId, token).catch((error: Error) => console.error(`[agent] release thread: ${error.message}`));
    // Added after the last take and before the lease ended: taken and written in one step, never lost or doubled.
    // While another turn holds the thread they stay: its first message takes them.
    await store.writeInputs(threadId, token, surface, { own: true }).catch((error: Error) => console.error(`[agent] late additions: ${error.message}`));
  }
}

async function turnOnThread(input: TurnInput, threadId: string, deadline: number, turnId: string): Promise<TurnResult> {
  const { store, emit, mode, signal } = input;
  /** The owner's words added since the last take, as text blocks for the next user message (this turn owns them). */
  const takeAdded = async (): Promise<BetaContentBlockParam[]> => {
    // ponytail: take, then append in a second request: death between the two loses these words. Upgrade path:
    // append the message in the same RPC (agent_write_inputs with p_before = the tool results).
    const rows = await store.takeInputs(turnId);
    return rows.map((r) => ({ type: "text", text: ADDED_PREFIX + r.text }));
  };
  const surface = input.ctx.surface;
  const ctx: ToolCtx = { ...input.ctx, store, threadId, ui: (action) => emit({ type: "ui", action }) };
  // This turn holds the thread, so a live approval still pending here belongs to a turn that died:
  // expire it (a late yes then gets 409, never "approved" with nothing to run it).
  await store.expireLiveApprovals(threadId);
  const loaded = await store.loadMessages(threadId, HISTORY_ROWS);
  const { messages: history, trimmed } = boundHistory(loaded, { capped: loaded.length >= HISTORY_ROWS });
  const append = async (message: BetaMessageParam) => {
    history.push(message);
    await store.appendMessage(threadId, message, surface);
  };

  const [memory, timeZone] = await Promise.all([store.listMemory(), ctx.timeZone()]);
  const context = contextBlock({ now: ctx.now(), timeZone, surface, ...input.page, memory });
  const repaired = repairHistory(history);
  const note = trimmed ? [{ type: "text", text: "<context>Older messages of this thread are left out to save space.</context>" }] : [];
  // The first message takes, in the same step, what the owner added to a turn that died on this thread before it
  // wrote them: after the results of its bare tool call, before his new words.
  const first = await store.writeInputs(threadId, turnId, surface, {
    own: false,
    before: repaired,
    after: [...note, { type: "text", text: context }, { type: "text", text: input.text }] as BetaContentBlockParam[],
  });
  if (!first) throw new Error("agent: the thread is gone");
  history.push({ role: "user", content: first });

  const tools = anthropicTools(ctx.allowed);
  // The server loop speaks Anthropic only (its history keeps Claude's signed thinking blocks): a ChatGPT or Grok pick runs
  // on the default Claude model here, at the same effort clamped, and the model event says so. Both callers (the turn
  // route and the cron) come through here.
  const claude = providerOf(input.settings.model) === "anthropic" || (!isModelId(input.settings.model) && input.settings.model.startsWith("claude-"));
  const model = claude ? input.settings.model : DEFAULT_MODEL;
  const effort = clampEffort(model, mode === "live" ? input.settings.effortLive : input.settings.effortRoutine);
  emit({ type: "model", model, effort, ...(claude ? {} : { fallback: "server_claude_only" as const }) });
  // The frozen prompt stays the cached prefix; the avatar's style (0220) follows it in its own block.
  const style = avatarStyle(input.settings.activeAvatar);
  const system: BetaTextBlockParam[] = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }, ...(style ? [{ type: "text" as const, text: style }] : [])];
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const result: TurnResult = { threadId, text: "", usage, approvals: [], mac: { queuedOffline: 0, skipped: 0 }, stop: "end_turn" };
  let retries = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const stepStart = result.text.length;
    if (signal?.aborted) {
      result.stop = "aborted";
      break;
    }
    if (Date.now() >= deadline) {
      result.stop = "out_of_time";
      emit({ type: "error", message: "That took too long. Ask again in smaller steps." });
      break;
    }
    const stream = input.client.beta.messages.stream(
      {
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools,
        messages: history,
        thinking: { type: "adaptive" },
        output_config: { effort },
        cache_control: { type: "ephemeral" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
      },
      { signal },
    );
    stream.on("text", (delta) => {
      result.text += delta;
      emit({ type: "text", delta });
    });
    let message: BetaMessage;
    try {
      message = await stream.finalMessage();
      retries = 0;
    } catch (error) {
      // A tool input that could not be parsed at all, or a dropped connection: re-issue (twice).
      // API errors (auth, rate limit, bad request) are not retried here.
      if (error instanceof Anthropic.APIError || signal?.aborted || retries++ >= 2) throw error;
      continue;
    }
    usage.input_tokens += message.usage.input_tokens ?? 0;
    usage.output_tokens += message.usage.output_tokens ?? 0;
    usage.cache_read_input_tokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cache_creation_input_tokens += message.usage.cache_creation_input_tokens ?? 0;
    await append({ role: "assistant", content: message.content as BetaContentBlockParam[] });
    result.stop = message.stop_reason ?? "end_turn";

    if (message.stop_reason === "refusal") {
      // A refusal can cut a tool call off mid-input: never run that turn's tools.
      const results = repairHistory(history);
      if (results.length) await append({ role: "user", content: results });
      if (!result.text) {
        const sorry = "I can't help with that one.";
        result.text = sorry;
        emit({ type: "text", delta: sorry });
      }
      break;
    }
    if (message.stop_reason === "pause_turn") continue;

    const calls = message.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (!calls.length) {
      // The owner added words while it answered: they join the prompt and it goes on, never a new turn.
      let more = await takeAdded();
      if (!more.length) {
        // Close the turn to additions first (agent_turn_append locks the lease row, so after the release it answers
        // 409 and the client starts a new turn), then a last look: words accepted just before it are answered too.
        await store.releaseThread(threadId, turnId);
        if (!(await store.inputsAfter(turnId, 0)).length) break;
        // Another turn took the thread meanwhile: its first message takes them (or the finally), never lost.
        if (!(await store.claimThread(threadId, turnId, TURN_LEASE_S))) break;
        more = await takeAdded();
        if (!more.length) break;
      }
      result.text += "\n\n";
      emit({ type: "text", delta: "\n\n" });
      await append({ role: "user", content: more });
      continue;
    }
    // Text before a tool call is narration, not the answer: routine results and other readers get only the answer.
    result.text = result.text.slice(0, stepStart);
    if (message.stop_reason === "max_tokens") {
      // A tool input cut off at max_tokens parses as a valid partial object: never run it.
      await append({ role: "user", content: repairHistory(history) });
      emit({ type: "error", message: "That answer ran too long. Ask again in smaller steps." });
      break;
    }

    const results: BetaToolResultBlockParam[] = [];
    for (const call of calls) results.push(await runCall(call, ctx, input, result, deadline));
    await append({ role: "user", content: [...results, ...(await takeAdded())] });
  }

  emit({ type: "done", usage });
  result.text = stripEmotes(result.text, true).trim();
  return result;
}

async function runCall(
  call: BetaToolUseBlock,
  ctx: ToolCtx,
  input: TurnInput,
  result: TurnResult,
  deadline: number,
): Promise<BetaToolResultBlockParam> {
  const { emit, store } = input;
  const label = toolByName(call.name)?.description.split(".")[0] ?? call.name;
  emit({ type: "tool", name: call.name, status: "start", summary: label });
  let res: ExecResult = await executeTool(call.name, call.input, ctx);

  if (res.status === "confirm" && (await autoApproves(input.settings.approveAll, res.gate, store))) {
    // Approve all (0200; the settings are read once per turn, the desktops' tags once per Mac step): the row is written
    // already approved, in one insert (the audit trail; Gmail send checks it), and the step runs at once. No confirm,
    // no wait. A deletion never gets here; a Mac step only when every desktop tags its deletions (autoApproves).
    const gate = res.gate;
    const approval = await store.createApproval({
      source: input.mode,
      thread_id: ctx.threadId,
      run_id: input.mode === "routine" ? ctx.runId : null,
      device_id: ctx.deviceId,
      tool: call.name,
      input: call.input as Record<string, unknown>,
      summary: gate.summary,
      reason: gate.reason,
      danger: gate.danger,
      status: "approved",
      expires_at: new Date(ctx.now().getTime() + (input.mode === "routine" ? ROUTINE_APPROVAL_MS : (input.confirmWaitMs ?? 240_000))).toISOString(),
    });
    res = await executeTool(call.name, call.input, { ...ctx, autoApproved: true }, { approved: true, approvalId: approval.id });
    await settleApproval(store, approval.id, res);
  } else if (res.status === "confirm") {
    const gate = res.gate;
    if (input.mode === "routine") {
      const approval = await store.createApproval({
        source: "routine",
        thread_id: ctx.threadId,
        run_id: ctx.runId,
        device_id: ctx.deviceId,
        tool: call.name,
        input: call.input as Record<string, unknown>,
        summary: gate.summary,
        reason: gate.reason,
        danger: gate.danger,
        expires_at: new Date(ctx.now().getTime() + ROUTINE_APPROVAL_MS).toISOString(),
      });
      result.approvals.push(approval.id);
      await store.notify({ kind: "approval", title: "Hydra needs your yes", body: gate.summary, href: "/routines", dedupe_key: `approval:${approval.id}` });
      emit({ type: "tool", name: call.name, status: "done", summary: `Waiting for your yes: ${gate.summary}` });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: `Not done yet: it waits for the owner's approval (${approval.id}). It runs when he approves. Do not try again.`,
      };
    }
    // A yes must arrive while this turn still runs: the wait ends before the function's deadline.
    const left = deadline - Date.now();
    const waitMs = Math.min(input.confirmWaitMs ?? 240_000, left);
    if (left < MIN_CONFIRM_MS) {
      emit({ type: "tool", name: call.name, status: "done", summary: "Not done: no time left to ask you" });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: "There was no time left in this turn to ask the owner. It was not done. Tell him to ask again.",
      };
    }
    const approval = await store.createApproval({
      source: "live",
      thread_id: ctx.threadId,
      run_id: null,
      device_id: ctx.deviceId,
      tool: call.name,
      input: call.input as Record<string, unknown>,
      summary: gate.summary,
      reason: gate.reason,
      danger: gate.danger,
      expires_at: new Date(ctx.now().getTime() + waitMs).toISOString(),
    });
    emit({ type: "confirm", id: approval.id, summary: gate.summary, danger: gate.danger });
    const decision = await waitForDecision(store, approval.id, waitMs, input.pollMs ?? 400, input.signal);
    if (decision !== "approved") {
      emit({ type: "tool", name: call.name, status: "done", summary: decision === "declined" ? "Not done: you said no" : "Not done: no answer" });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: decision === "declined" ? "The owner said no. It was not done. Do not try again." : "The owner did not answer. It was not done.",
      };
    }
    res = await executeTool(call.name, call.input, ctx, { approved: true, approvalId: approval.id });
    await settleApproval(store, approval.id, res);
  }

  if (res.status === "ok") {
    if (call.name === "mac_do") {
      const status = (res.data as { status?: string } | null)?.status ?? "";
      if (status.startsWith("skipped")) result.mac.skipped++;
      else if (status.startsWith("queued")) result.mac.queuedOffline++;
    }
    emit({ type: "tool", name: call.name, status: "done", summary: res.summary });
    return { type: "tool_result", tool_use_id: call.id, content: asData(res.data) };
  }
  emit({ type: "tool", name: call.name, status: "error", summary: res.status === "confirm" ? res.gate.summary : res.message });
  if (res.status === "invalid") {
    // Eager input streaming: the API did not validate this input. Hand it back so Claude retries.
    return {
      type: "tool_result",
      tool_use_id: call.id,
      is_error: true,
      content: JSON.stringify({ INVALID_JSON: JSON.stringify(call.input), problem: res.message }),
    };
  }
  return { type: "tool_result", tool_use_id: call.id, is_error: true, content: res.status === "confirm" ? res.gate.summary : res.message };
}

/** An approved step ran: its row ends done (with the result and the action) or failed. */
async function settleApproval(store: AgentStore, id: string, res: ExecResult) {
  await store.moveApproval(id, ["approved"], res.status === "ok" ? "done" : "failed", {
    result: res.status === "ok" ? (res.data ?? null) : { error: "message" in res ? res.message : "failed" },
    action_id: res.status === "ok" ? res.actionId : null,
  });
}

/** Poll the approval until the owner answers, it expires, or the client leaves. */
async function waitForDecision(
  store: AgentStore,
  id: string,
  waitMs: number,
  pollMs: number,
  signal?: AbortSignal,
): Promise<"approved" | "declined" | "expired"> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !signal?.aborted) {
    const row = await store.getApproval(id);
    if (row && row.status !== "pending") return row.status === "approved" ? "approved" : row.status === "declined" ? "declined" : "expired";
    await sleep(pollMs, signal);
  }
  // Expire it; if the owner answered at the last moment, that answer wins.
  if (await store.moveApproval(id, ["pending"], "expired")) return "expired";
  const row = await store.getApproval(id);
  return row?.status === "approved" ? "approved" : row?.status === "declined" ? "declined" : "expired";
}
