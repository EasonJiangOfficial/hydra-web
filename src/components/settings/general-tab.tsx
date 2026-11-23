"use client";

import { useId, useMemo, useState } from "react";

import { useSynced } from "@/components/accounts/switch";
import { IdleLock } from "@/components/accounts/connections-tab";
import { Card, InfoDot, Label } from "@/components/kit";
import { SaveLabel, type SaveState } from "@/components/planning/controls";
import { Combobox } from "@/components/ui/combobox";

import { useSettings } from "./store";

function zones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

function TimeZone() {
  const { data, actions } = useSettings();
  const uid = useId();
  const all = useMemo(() => zones(), []);
  const [text, setText] = useSynced(data.timeZone ?? "");
  const [saved, setSaved] = useSynced(data.timeZone ?? "");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");

  async function save() {
    const next = text.trim();
    if (next === saved) return;
    setState("saving");
    setError("");
    const r = await actions.setTimeZone({ timeZone: next || null });
    setState(r.ok ? "saved" : "error");
    if (r.ok) {
      setSaved(r.data.timeZone ?? "");
      setText(r.data.timeZone ?? "");
    } else setError(r.error.message);
  }

  return (
    <Card aria-label="Time zone">
      <div className="flex items-center gap-2">
        <Label as="label" htmlFor={`${uid}-tz`}>
          Time zone
        </Label>
        <InfoDot label="About the time zone">Today, due dates, reminders and routines follow it. A name like America/Toronto, never an offset.</InfoDot>
        <div className="flex-1" />
        <SaveLabel state={state} />
      </div>
      <Combobox
        id={`${uid}-tz`}
        aria-label="Time zone"
        suggestions={all}
        value={text}
        placeholder="America/Toronto"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="w-full"
      />
      {error && (
        <p role="alert" className="text-label text-ink-2">
          {error}
        </p>
      )}
    </Card>
  );
}

export function GeneralTab() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-5">
      <TimeZone />
      <IdleLock />
    </div>
  );
}
