"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { offerUndo } from "@/components/activity/undo-bar";
import { RoutinesWorkspace } from "@/components/routines/workspace";
import type { Result, RoutineInput, RoutinesActions, RoutinesData } from "@/components/routines/types";
import { routineAction, type RoutineAction } from "@/lib/agent/actions";

/** The server answer for an agent route: ok, or why not. */
async function post(url: string, body: unknown): Promise<{ ok: boolean; json: { summary?: string; message?: string } }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; summary?: string; message?: string };
    return { ok: res.ok && json.ok === true, json };
  } catch {
    return { ok: false, json: { message: "No connection. Try again." } };
  }
}

/** The Routines page on real data: the agent's routine tools (every change lands in the activity list with undo), then a server refresh. */
export function RoutinesLive({ data }: { data: RoutinesData }) {
  const router = useRouter();
  const actions = useMemo<RoutinesActions>(() => {
    const done = (r: Result) => {
      if (r.ok) router.refresh();
      return r;
    };
    const tool = async (name: RoutineAction, input: Record<string, unknown>): Promise<Result> => {
      const r = await routineAction(name, input);
      if (r.status === "ok") return done({ ok: true, id: (r.data as { id?: string } | null)?.id, message: r.summary });
      return { ok: false, message: r.status === "confirm" ? r.gate.summary : r.message };
    };
    const fields = (i: RoutineInput) => ({ name: i.name, instruction: i.instruction, schedule: i.schedule, tools: i.tools, delivery: i.delivery, whenMacOff: i.whenMacOff });
    return {
      create: (input) => tool("create_routine", fields(input)),
      update: (id, input) => tool("update_routine", { id, ...fields(input) }),
      setPaused: (id, paused) => tool(paused ? "pause_routine" : "resume_routine", { id }),
      runNow: (id) => tool("run_routine_now", { id }),
      remove: async (id) => {
        const name = data.routines.find((r) => r.id === id)?.name;
        const r = await routineAction("delete_routine", { id });
        if (r.status !== "ok") return { ok: false, message: r.status === "confirm" ? r.gate.summary : r.message };
        offerUndo(r.activityId, name ? `routine "${name}"` : "routine");
        return done({ ok: true, message: r.summary, activityId: r.activityId });
      },
      decide: async (id, approve) => {
        const r = await post("/api/agent/confirm", { id, approve });
        return done(r.ok ? { ok: true, message: r.json.summary } : { ok: false, message: r.json.message ?? "That step could not run." });
      },
      undo: async (actionId) => {
        const r = await post("/api/agent/undo", { actionId });
        return done(r.ok ? { ok: true, message: r.json.summary } : { ok: false, message: r.json.message ?? "That could not be undone." });
      },
    };
  }, [router, data.routines]);
  return <RoutinesWorkspace data={data} actions={actions} />;
}
