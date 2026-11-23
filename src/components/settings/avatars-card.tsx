"use client";

import { Check, CircleAlert, Play, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { offerUndo } from "@/components/activity/undo-bar";
import { Switch } from "@/components/agent/orb-menu";
import { Button, Card, DetailDrawer, InfoDot, Input, Label, cn, drawerHref } from "@/components/kit";
import { FieldRow, SaveLabel, type SaveState } from "@/components/planning/controls";
import { voiceIdSchema, type AvatarInput, type AvatarView, type AvatarsClient, type FishVoice } from "@/lib/agent/avatars-client";

/** What a pasted Fish voice id is: not checked yet, being checked, known to Fish (its title), or refused. */
type VoiceCheck = { state: "idle" } | { state: "checking" } | { state: "ok"; voice: FishVoice } | { state: "bad"; message: string };

const PREVIEW = (name: string) => `Hey, it's ${name.trim() || "Hydra"}. This is how I sound.`;

function closePanel() {
  const url = new URL(window.location.href);
  url.searchParams.delete("avatar");
  window.history.replaceState(null, "", url);
}

/**
 * Settings > Agent > Avatars (0220; owner: "I should be able to create new avatars, how they talk if they curse, use slang
 * ect, and enter the id from fish audio and it should work"). Hydra's own voice first, then each avatar with its Fish voice's
 * title; the check picks the one every device speaks and talks as (PATCH /api/agent/state through the Agent tab's save).
 * A row opens the slide-out: name, Fish voice ID (checked with Fish on blur), Preview, Curse, Slang, Style notes, Delete.
 */
export function AvatarsCard({ client, active, onActivate }: { client: AvatarsClient; active: string | null; onActivate: (id: string | null) => void }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const [avatars, setAvatars] = useState<AvatarView[] | null>(null);
  // A voice's title from Fish, or why Fish could not answer (shown short, the full message on hover).
  const [titles, setTitles] = useState<Record<string, { title: string } | { problem: string }>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void client.list().then((r) => {
      if (!live) return;
      if (!r.ok) return setError(r.message);
      setAvatars(r.data);
    });
    return () => {
      live = false;
    };
  }, [client]);

  // Each voice's title from Fish, once per id; a failed id is asked again on the next change to the list.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const a of avatars ?? []) {
      if (asked.current.has(a.voiceId)) continue;
      asked.current.add(a.voiceId);
      void client.voice(a.voiceId).then((r) => {
        if (!r.ok) asked.current.delete(a.voiceId);
        setTitles((t) => ({ ...t, [a.voiceId]: r.ok ? { title: r.data.title } : { problem: r.message } }));
      });
    }
  }, [avatars, client]);
  const known = (voice: FishVoice) => setTitles((t) => ({ ...t, [voice.id]: { title: voice.title } }));

  const put = (a: AvatarView) => setAvatars((list) => (list?.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...(list ?? []), a]));
  const gone = (id: string) => setAvatars((list) => list?.filter((x) => x.id !== id) ?? null);
  const open = search.get("avatar");

  return (
    <>
      <Card aria-label="Avatars" className="md:col-span-2">
        <div className="flex items-center gap-2">
          <Label>Avatars</Label>
          <InfoDot label="About avatars">Who Hydra speaks and talks as on every device: a Fish Audio voice, and how it talks.</InfoDot>
          <div className="flex-1" />
          <Button asChild>
            <Link href={drawerHref(pathname, search, "avatar", "new")} scroll={false} prefetch={false}>
              <Plus aria-hidden strokeWidth={1.5} />
              New avatar
            </Link>
          </Button>
        </div>
        <div role="radiogroup" aria-label="Active avatar" data-testid="avatar-list">
          <Row name="Hydra" voice={{ title: "Hydra's own voice" }} on={active === null} onPick={() => onActivate(null)} />
          {avatars?.map((a) => (
            <Row
              key={a.id}
              name={a.name}
              voice={titles[a.voiceId] ?? { title: "" }}
              on={active === a.id}
              onPick={() => onActivate(a.id)}
              href={drawerHref(pathname, search, "avatar", a.id)}
            />
          ))}
        </div>
        {error && (
          <p role="alert" className="text-label text-ink-2">
            {error}
          </p>
        )}
      </Card>
      <DetailDrawer param="avatar" label={open === "new" ? "New avatar" : "Avatar"}>
        {(id) => {
          if (id === "new") return <Editor key="new" client={client} onSaved={put} onVoice={known} />;
          const a = avatars?.find((x) => x.id === id);
          if (!avatars) return null;
          if (!a) return <p className="text-ink-3">This avatar is gone.</p>;
          return (
            <Editor
              key={a.id}
              client={client}
              avatar={a}
              onVoice={known}
              onSaved={(next) => {
                put(next);
                if (next.voiceId !== a.voiceId) asked.current.delete(next.voiceId);
              }}
              onDeleted={() => {
                gone(a.id);
                if (active === a.id) onActivate(null);
              }}
            />
          );
        }}
      </DetailDrawer>
    </>
  );
}

function Row({ name, voice, on, onPick, href }: { name: string; voice: { title: string } | { problem: string }; on: boolean; onPick: () => void; href?: string }) {
  const label = (
    <>
      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      {"problem" in voice ? (
        <span data-testid="avatar-voice-problem" title={voice.problem} className="flex shrink-0 items-center gap-1 text-label text-ink-2">
          <CircleAlert aria-hidden strokeWidth={1.5} className="size-3.5" />
          Voice issue
          <span className="sr-only">: {voice.problem}</span>
        </span>
      ) : (
        <span className="min-w-0 max-w-[45%] truncate text-right text-label text-ink-3">{voice.title}</span>
      )}
    </>
  );
  return (
    <div data-avatar={name} className="flex min-h-[46px] items-center gap-3 border-t border-rule first:border-t-0">
      <button
        type="button"
        role="radio"
        aria-checked={on}
        aria-label={`Use ${name}`}
        onClick={onPick}
        className="relative -m-1.5 grid place-items-center rounded-md p-1.5 outline-none focus-visible:outline-2 focus-visible:outline-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']"
      >
        <span aria-hidden className={cn("grid size-4 place-items-center rounded-full border transition-colors duration-200 ease-hydra", on ? "border-ink bg-ink text-white" : "border-rule-2")}>
          <Check strokeWidth={2.5} className={cn("size-2.5 transition-opacity duration-200", on ? "opacity-100" : "opacity-0")} />
        </span>
      </button>
      {href ? (
        <Link href={href} scroll={false} prefetch={false} className="-my-1 flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 text-body text-ink outline-none transition-colors duration-200 hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-ink">
          {label}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 text-body text-ink">{label}</div>
      )}
    </div>
  );
}

function Editor({
  client,
  avatar,
  onSaved,
  onDeleted,
  onVoice,
}: {
  client: AvatarsClient;
  avatar?: AvatarView;
  onSaved: (a: AvatarView) => void;
  onDeleted?: () => void;
  /** A voice Fish knows: the list shows its title (also a retry for a row whose check failed). */
  onVoice?: (voice: FishVoice) => void;
}) {
  const uid = useId();
  const [name, setName] = useState(avatar?.name ?? "");
  const [voiceId, setVoiceId] = useState(avatar?.voiceId ?? "");
  const [check, setCheck] = useState<VoiceCheck>({ state: "idle" });
  const [curse, setCurse] = useState(avatar?.curse ?? false);
  const [slang, setSlang] = useState(avatar?.slang ?? false);
  const [notes, setNotes] = useState(avatar?.styleNotes ?? "");
  const [save, setSave] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const checked = useRef("");

  // An avatar's saved voice is checked once on open, so its title shows.
  useEffect(() => {
    if (avatar) void verify(avatar.voiceId);
    return () => audio.current?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(raw: string): Promise<string | null> {
    const id = voiceIdSchema.safeParse(raw);
    if (!id.success) {
      setCheck({ state: "bad", message: raw.trim() ? id.error.issues[0]!.message : "Paste a Fish voice ID" });
      return null;
    }
    if (checked.current === id.data && check.state === "ok") return id.data;
    checked.current = id.data;
    setCheck({ state: "checking" });
    const r = await client.voice(id.data);
    if (checked.current !== id.data) return null;
    setCheck(r.ok ? { state: "ok", voice: r.data } : { state: "bad", message: r.message });
    if (r.ok) onVoice?.(r.data);
    return r.ok ? id.data : null;
  }

  /** Edit mode: one field saved at once. */
  async function patch(p: Partial<AvatarInput>) {
    if (!avatar) return;
    setSave("saving");
    setError("");
    const r = await client.update(avatar.id, p);
    setSave(r.ok ? "saved" : "error");
    if (r.ok) onSaved(r.data);
    else setError(r.message);
  }

  async function blurVoice() {
    const id = await verify(voiceId);
    if (id) setVoiceId(id);
    if (avatar && id && id !== avatar.voiceId) await patch({ voiceId: id });
  }

  async function add() {
    setBusy(true);
    setError("");
    const id = await verify(voiceId);
    if (!id) return setBusy(false);
    const r = await client.create({ name, voiceId: id, curse, slang, styleNotes: notes });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    onSaved(r.data);
    closePanel();
  }

  async function remove() {
    if (!avatar) return;
    setBusy(true);
    const r = await client.remove(avatar.id);
    setBusy(false);
    setSure(false);
    if (!r.ok) return setError(r.message);
    offerUndo(r.data, avatar.name);
    onDeleted?.();
    closePanel();
  }

  async function preview() {
    const id = check.state === "ok" ? check.voice.id : await verify(voiceId);
    if (!id) return;
    audio.current?.pause();
    setPlaying(true);
    setError("");
    const r = await client.preview(id, PREVIEW(name));
    if (!r.ok) {
      setPlaying(false);
      return setError(r.message);
    }
    const url = URL.createObjectURL(r.data);
    const a = new Audio(url);
    audio.current = a;
    const done = () => {
      setPlaying(false);
      URL.revokeObjectURL(url);
    };
    a.onended = done;
    a.onerror = done;
    await a.play().catch(done);
  }

  const toggle = (which: "curse" | "slang", on: boolean) => {
    (which === "curse" ? setCurse : setSlang)(on);
    void patch({ [which]: on });
  };

  return (
    <form
      className="flex flex-1 flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!avatar) void add();
      }}
    >
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-title text-ink">{avatar ? avatar.name : "New avatar"}</h2>
        {avatar && <SaveLabel state={save} />}
      </div>
      <div>
        <FieldRow label="Name" htmlFor={`${uid}-name`}>
          <Input
            id={`${uid}-name`}
            value={name}
            maxLength={40}
            autoFocus={!avatar}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (!avatar) return;
              // A blank name is not saved: the saved one comes back.
              if (!name.trim()) setName(avatar.name);
              else if (name.trim() !== avatar.name) void patch({ name });
            }}
            onKeyDown={(e) => avatar && e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
          />
        </FieldRow>
        {/* Its own full-width line: all 32 characters show, to compare with Fish. */}
        <div className="border-t border-rule pt-2">
          <Label as="label" htmlFor={`${uid}-voice`}>
            Voice ID
          </Label>
          <div className="mt-1.5 flex items-center gap-2">
              <Input
                id={`${uid}-voice`}
                value={voiceId}
                maxLength={64}
                spellCheck={false}
                autoComplete="off"
                data-testid="avatar-voice-id"
                aria-invalid={check.state === "bad" || undefined}
                aria-describedby={`${uid}-voice-check`}
                onChange={(e) => {
                  setVoiceId(e.target.value);
                  if (check.state !== "idle") setCheck({ state: "idle" });
                }}
                onBlur={() => void blurVoice()}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
                className="font-mono text-label"
              />
              <Button type="button" variant="ghost" size="icon" aria-label="Preview the voice" disabled={playing || check.state === "checking"} onClick={() => void preview()}>
                <Play aria-hidden strokeWidth={1.5} className={cn(playing && "animate-pulse")} />
              </Button>
          </div>
        </div>
        <p id={`${uid}-voice-check`} data-testid="avatar-voice-check" data-state={check.state} role={check.state === "bad" ? "alert" : undefined} className="min-h-5 pt-1 pb-2 text-label text-ink-3">
          {check.state === "checking" && "Checking with Fish"}
          {check.state === "ok" && (
            <span className="inline-flex items-center gap-1.5 text-ink-2">
              <Check aria-hidden strokeWidth={2} className="size-3.5" />
              {check.voice.title}
            </span>
          )}
          {check.state === "bad" && <span className="text-ink">{check.message}</span>}
        </p>
        <FieldRow label="Curse">
          <SwitchButton label="Curse" on={curse} onChange={(on) => (avatar ? toggle("curse", on) : setCurse(on))} />
        </FieldRow>
        <FieldRow label="Slang">
          <SwitchButton label="Slang" on={slang} onChange={(on) => (avatar ? toggle("slang", on) : setSlang(on))} />
        </FieldRow>
        <div className="flex flex-col gap-2 border-t border-rule py-2">
          <Label as="label" htmlFor={`${uid}-notes`}>
            Style notes
          </Label>
          <textarea
            id={`${uid}-notes`}
            rows={4}
            value={notes}
            maxLength={1000}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => avatar && notes.trim() !== avatar.styleNotes && void patch({ styleNotes: notes })}
            className="w-full resize-none rounded-lg border border-rule-2 bg-surface p-3 text-body text-ink outline-none transition-colors duration-200 focus:border-ink"
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-label text-ink-2">
          {error}
        </p>
      )}
      {!avatar ? (
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || !voiceId.trim()}>
            Add avatar
          </Button>
          <Button type="button" variant="ghost" onClick={closePanel}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="mt-auto border-t border-rule pt-4">
          {sure ? (
            <div role="alertdialog" aria-label="Delete avatar" className="flex flex-col gap-3 rounded-lg bg-tint px-3.5 py-3">
              <p>Delete {avatar.name}?</p>
              <div className="flex gap-2">
                <Button type="button" variant="primary" disabled={busy} onClick={() => void remove()}>
                  Delete
                </Button>
                <Button type="button" variant="ghost" onClick={() => setSure(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setSure(true)}>
              Delete
            </Button>
          )}
        </div>
      )}
    </form>
  );
}

function SwitchButton({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="relative -m-1.5 inline-grid place-items-center rounded-md p-1.5 outline-none focus-visible:outline-2 focus-visible:outline-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:content-['']"
    >
      <Switch on={on} />
    </button>
  );
}
