"use client";

/*
 * A scripted stand-in for /api/agent/* and /api/voice/tts (fixture and e2e only). It patches window.fetch for those
 * paths and answers in the server's own contract (src/lib/agent/events.ts): text/event-stream `data:` frames, a turn
 * that pauses at a confirm until POST /api/agent/confirm answers it, /state rows with undo ids. The keywords in the
 * typed text pick the script. src/components/agent/contract.test.ts covers the real route handlers.
 */

import type { AgentEvent } from "@/lib/agent/events";
import { clampEffort, effortsOf, isEffort, isModelId, providerOf, type Provider } from "@/lib/agent/models";

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Ev = AgentEvent | { wait: string };

/** Pause before each event, in ms. e2e raises it (window.__agentMockGap) to hold Thinking on screen for a screenshot. */
const gapMs = () => (window as unknown as { __agentMockGap?: number }).__agentMockGap ?? 90;

const THREAD = "00000000-0000-4000-8000-00000000a001";
const CONFIRM = "00000000-0000-4000-8000-00000000c001";
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** Answers to paused confirms, by id. */
const answers = new Map<string, (approve: boolean) => void>();
const waiting = new Map<string, Promise<boolean>>();
const answerTo = (id: string) => waiting.get(id) ?? Promise.resolve(false);
type Row = { id: string; tool: string; summary: string; undoId: string | null; undoneAt: string | null; createdAt: string; threadId: string | null; surface: string };
const activity: Row[] = [];
/** Rows whose undo the mock server refuses (the panel's "Not undone" state). */
const refuseUndo = new Set<string>();

/**
 * `?activity=one|many`: rows already in the list when the page opens. many: six "Added a rule" in this chat (one undone),
 * a coffee, then earlier changes from the phone, a routine and the Mac (one whose undo the server refuses).
 */
function seedActivity(kind: string | null) {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const row = (n: number, summary: string, minutes: number, more: Partial<Row> = {}): Row => {
    const id = `00000000-0000-4000-8000-0000000a${String(n).padStart(4, "0")}`;
    return { id, tool: "create_rule", summary, undoId: id, undoneAt: null, createdAt: at(minutes), threadId: THREAD, surface: "web", ...more };
  };
  if (kind === "one") activity.push(row(1, "Added Coffee, $4.50", 2));
  if (kind !== "many") return;
  activity.push(row(1, "Added Coffee, $4.50", 1));
  for (let i = 0; i < 6; i++) activity.push(row(2 + i, "Added a rule", 3 + i, i === 2 ? { undoId: null, undoneAt: at(1) } : {}));
  const earlier = { threadId: "00000000-0000-4000-8000-00000000a0ff", surface: "phone" };
  activity.push(row(10, "Edited a transaction", 60 * 5, earlier));
  activity.push(row(11, "Mac step sent to the Mac", 60 * 26, { ...earlier, surface: "routine", undoId: null }));
  activity.push(row(12, "Hid a transaction", 60 * 30, { ...earlier, surface: "desktop" }));
  refuseUndo.add(activity.at(-1)!.id);
}
let approvals = [{ id: "00000000-0000-4000-8000-00000000ab01", source: "routine", summary: "Send the Monday summary to your email?" }];
/** The shared agent settings (W6 contract defaults); PATCH /api/agent/state changes them. */
const settings: Record<string, string | boolean | null> = {
  sleepWord: "Hydra, sleep",
  wakePhrase: "Hey Hydra",
  clapSensitivity: "medium",
  model: "claude-opus-5-5",
  effortLive: "low",
  effortRoutine: "medium",
  brain: "mac",
  approveAll: false,
  activeAvatarId: null,
};
/** 0220: `?avatars=on` gives the owner two avatars, so the orb menu shows its quick switch. */
const AVATARS = [
  { id: "00000000-0000-4000-8000-00000000a7a1", name: "Tony", voiceId: "0123456789abcdef0123456789abcdef", curse: true, slang: true, styleNotes: "Brooklyn, fast, warm." },
  { id: "00000000-0000-4000-8000-00000000a7a2", name: "Butler", voiceId: "fedcba9876543210fedcba9876543210", curse: false, slang: false, styleNotes: "Formal. Calls him sir." },
];
const avatarsOn = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("avatars") === "on";
/** Models: `?models=all` connects ChatGPT (a signed-in Mac) and Grok (a key), so the orb menu shows the providers. */
const providers = (): Provider[] =>
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get("models") === "all" ? ["anthropic", "openai", "xai"] : ["anthropic"];

/** 0191: the turn in flight (its `turn` event) and the words the owner added to it while it worked. */
let turnSeq = 0;
let inFlight: string | null = null;
const added = new Map<string, string[]>();

function sse(events: Ev[], then: (approve: boolean) => AgentEvent[]) {
  const gap = gapMs();
  const turnId = `00000000-0000-4000-8000-${String(++turnSeq).padStart(12, "0")}`;
  return new Response(
    new ReadableStream({
      async start(c) {
        const send = (ev: AgentEvent) => c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        inFlight = turnId;
        for (const ev of events) {
          if (!("wait" in ev) && ev.type === "done") {
            // Words added while it worked join this turn's answer (the real brain reads them into its prompt).
            const more = added.get(turnId);
            if (more?.length) {
              await sleep(gap);
              send({ type: "text", delta: ` Also ${more.join(", ")}: noted.` });
            }
            if (inFlight === turnId) inFlight = null;
          }
          if ("wait" in ev) {
            const approve = await answerTo(ev.wait);
            for (const next of then(approve)) {
              await sleep(gap);
              send(next);
            }
          } else {
            // Register the answer before the confirm goes out, so a fast tap or "yes" always finds it.
            if (ev.type === "confirm") waiting.set(ev.id, new Promise<boolean>((r) => answers.set(ev.id, r)));
            await sleep(gap);
            send(ev);
            if (ev.type === "thread") send({ type: "turn", turnId });
          }
        }
        if (inFlight === turnId) inFlight = null;
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const say = (...parts: string[]): AgentEvent[] => parts.map((delta) => ({ type: "text", delta }));
const done: AgentEvent = { type: "done", usage };

function logAction(summary: string) {
  const id = `00000000-0000-4000-8000-${String(activity.length + 1).padStart(12, "0")}`;
  activity.unshift({ id, tool: "add", summary, undoId: id, undoneAt: null, createdAt: new Date().toISOString(), threadId: THREAD, surface: "web" });
}

function script(text: string): { events: Ev[]; then?: (approve: boolean) => AgentEvent[] } {
  const t = text.toLowerCase();
  const head: AgentEvent = { type: "thread", threadId: THREAD };
  if (t.includes("planning")) {
    return { events: [head, ...say("Opening Planning. ", "Here is your week."), { type: "ui", action: { kind: "navigate", href: "/dev/agent/planning" } }, done] };
  }
  if (t.includes("delete")) {
    return {
      events: [
        head,
        ...say("That deletes one transaction."),
        { type: "confirm", id: CONFIRM, summary: "Delete the Costco transaction of $84.12 from Nov 3?", danger: true },
        { wait: CONFIRM },
        done,
      ],
      then: (approve) => {
        if (!approve) return [{ type: "tool", name: "delete_transaction", status: "done", summary: "Not done: you said no" }, ...say(" Okay. ", "I left it alone.")];
        logAction("Deleted Costco, $84.12");
        return [{ type: "tool", name: "delete_transaction", status: "done", summary: "Deleted Costco, $84.12" }, ...say(" Deleted. ", "You can undo it from the activity list.")];
      },
    };
  }
  if (t.includes("safari")) {
    // The phone controls the Mac (0160): the brain's sub-turn ask reaches this stream as a confirm in the Mac's words.
    return {
      events: [head, { type: "confirm", id: CONFIRM, summary: "Quit Safari on Studio Mac: 2 windows, 9 tabs, 1 unsent form on mail.google.com", danger: true }, { wait: CONFIRM }, done],
      then: (approve) => say(approve ? "Done. Safari is closed on your Mac." : "Okay. Safari stays open."),
    };
  }
  if (t.includes("earn")) {
    // Narration before a tool, the tool, then the answer: the voice controller splits these into step and text parts.
    return {
      events: [
        head,
        ...say("I need dates; today is 2026-11-22."),
        { type: "tool", name: "ugc_earnings", status: "start", summary: "Adding up pay per video" },
        { type: "tool", name: "ugc_earnings", status: "done", summary: "Looked at 14 posts" },
        ...say("You've earned $3,525 ", "this week across 14 videos."),
        done,
      ],
    };
  }
  if (t.includes("coffee")) {
    logAction("Added Coffee, $4.50");
    return {
      events: [
        head,
        ...say("Added a coffee. ", "Four dollars and fifty cents."),
        { type: "tool", name: "add_transaction", status: "done", summary: "Added Coffee, $4.50" },
        { type: "ui", action: { kind: "openPanel", param: "tx", value: "demo-1" } },
        done,
      ],
    };
  }
  return { events: [head, ...say("I heard you. ", "What next?"), done] };
}

const MAC_ERRORS: Record<string, { message: string; code: string }> = {
  brain_offline: { message: "Hydra is offline.", code: "brain_offline" },
  brain_timeout: { message: "Hydra took too long.", code: "brain_timeout" },
  brain_failed: { message: "Hydra stopped answering.", code: "brain_failed" },
  offline: { message: "Your Mac is offline.", code: "mac_offline" },
  timeout: { message: "Your Mac did not answer in time.", code: "mac_timeout" },
  bad_event: { message: "Hydra hit a problem on your Mac.", code: "mac_bad_event" },
  failed: { message: "Your Mac stopped answering.", code: "mac_failed" },
  claude: { message: "Sign in with Claude on your Mac.", code: "mac_claude" },
  signed_out: { message: "Sign in with Claude on your Mac.", code: "mac_signed_out" },
};

let installed = false;

export function installAgentMock() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  seedActivity(new URLSearchParams(window.location.search).get("activity"));
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, window.location.href).pathname;
    const body = path.startsWith("/api/agent/") && typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (path === "/api/agent/turn") {
      const w = window as unknown as { __turns?: unknown[] };
      (w.__turns ??= []).push(body);
      // `?mac=brain_offline|brain_timeout|brain_failed|offline|timeout|bad_event|failed|claude|signed_out`: the server's answers when the Mac brain is off, never
      // answered (280 s), sent an event the server refused, went quiet mid-turn, or is signed out of Claude (W3 relay
      // contract and contract fixes 3 and 5).
      const mac = MAC_ERRORS[new URLSearchParams(window.location.search).get("mac") ?? ""];
      if (mac) return sse([{ type: "thread", threadId: THREAD }, { type: "error", ...mac } as AgentEvent], () => []);
      const input = body.input ?? {};
      const s = script(String(input.text ?? input.audioTranscript ?? ""));
      return sse(s.events, s.then ?? (() => []));
    }
    if (path === "/api/agent/confirm") {
      const answer = answers.get(body.id);
      if (answer) {
        answers.delete(body.id);
        answer(body.approve === true);
        return Response.json({ ok: true, status: body.approve ? "approved" : "declined" });
      }
      if (approvals.some((a) => a.id === body.id)) {
        approvals = approvals.filter((a) => a.id !== body.id);
        return Response.json({ ok: true, status: "done" });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (path === "/api/agent/devices/pair") {
      const w = window as unknown as { __pairBodies?: unknown[] };
      (w.__pairBodies ??= []).push(body);
      return Response.json({ code: "FIXTURE-PAIR-CODE", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }
    if (path === "/api/agent/turn/append") {
      const w = window as unknown as { __added?: unknown[] };
      (w.__added ??= []).push(body);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || typeof body.turnId !== "string") return Response.json({ error: "invalid_input" }, { status: 400 });
      if (body.turnId !== inFlight) return Response.json({ error: "turn_over" }, { status: 409 });
      const list = added.get(body.turnId) ?? [];
      list.push(text);
      added.set(body.turnId, list);
      return Response.json({ ok: true, seq: list.length }, { status: 202 });
    }
    if (path === "/api/agent/state" && init?.method === "PATCH") {
      // The W6 contract's checks, enough for the fixture: a bad value is 400 and changes nothing.
      const ok =
        (body.wakePhrase === undefined || (typeof body.wakePhrase === "string" && body.wakePhrase.trim().length >= 2 && body.wakePhrase.trim().length <= 40)) &&
        (body.sleepWord === undefined || (typeof body.sleepWord === "string" && body.sleepWord.trim().length >= 2)) &&
        (body.model === undefined || (isModelId(body.model) && providers().includes(providerOf(body.model)!))) &&
        (body.clapSensitivity === undefined || ["low", "medium", "high"].includes(body.clapSensitivity)) &&
        ["effortLive", "effortRoutine"].every((k) => body[k] === undefined || effortsOf(String(body.model ?? settings.model)).includes(body[k])) &&
        (body.approveAll === undefined || typeof body.approveAll === "boolean") &&
        (body.activeAvatarId === undefined || body.activeAvatarId === null || (avatarsOn() && AVATARS.some((a) => a.id === body.activeAvatarId)));
      if (!ok) return Response.json({ error: "invalid_input" }, { status: 400 });
      Object.assign(settings, body);
      // A model change clamps both efforts to its levels, as the server does.
      if (body.model) for (const k of ["effortLive", "effortRoutine"]) if (isEffort(settings[k])) settings[k] = clampEffort(body.model, settings[k]);
      return Response.json({ ok: true, settings, activeAvatar: AVATARS.find((a) => a.id === settings.activeAvatarId) ?? null });
    }
    if (path === "/api/agent/state") {
      // `?panel=<preset>` shows one panel state alone, without the routine approval.
      const quiet = new URLSearchParams(window.location.search).has("panel");
      const avatars = avatarsOn() ? AVATARS : [];
      return Response.json({
        threads: [{ id: THREAD, title: "Hydra", surface: "web" }],
        pendingApprovals: quiet ? [] : approvals,
        activity,
        notifications: [],
        settings,
        activeAvatar: avatars.find((a) => a.id === settings.activeAvatarId) ?? null,
        avatars: avatars.map(({ id, name }) => ({ id, name })),
        providers: providers(),
      });
    }
    if (path === "/api/agent/undo") {
      const row = activity.find((a) => a.undoId === body.actionId);
      if (!row) return Response.json({ ok: false, message: "Already undone" }, { status: 409 });
      if (refuseUndo.has(row.id)) return Response.json({ ok: false, message: "That transaction changed since. Undo it in Activity." }, { status: 409 });
      row.undoId = null;
      row.undoneAt = new Date().toISOString();
      return Response.json({ ok: true, summary: `Undid ${row.summary}` });
    }
    // No Fish key in the fixture: the client falls back to the browser voice.
    if (path === "/api/voice/tts") {
      const w = window as unknown as { __ttsCalls?: number };
      w.__ttsCalls = (w.__ttsCalls ?? 0) + 1;
      return Response.json({ error: "voice_not_configured" }, { status: 503 });
    }
    return real(input, init);
  };
}
