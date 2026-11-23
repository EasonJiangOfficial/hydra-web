-- Hydra 0220: avatars, the personas Hydra speaks as (owner, 2026-11-22: "also allow me to change the voices of the
-- agnt"; "I just want voices from fish"; "like I should be able to create new avatars, how they talk if they curse,
-- use slang ect, and enter the id from fish audio and it should work"). Plain SQL, safe to re-run.
--
-- agent_avatars                 one row per avatar: a name, a Fish Audio voice id (Fish's 32-hex model id, the TTS
--                               reference_id), whether it curses, whether it uses slang, free style notes.
-- agent_settings.active_avatar_id  the avatar every surface speaks and talks as. Null (the default, and after the
--                               avatar is deleted): Hydra's own voice FISH_DEFAULT_VOICE_ID and no style.
-- Nothing is seeded. Owner-only RLS; hydra_ro reads. Logged for undo (0130).

create table if not exists public.agent_avatars (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  fish_voice_id text not null check (fish_voice_id ~ '^[0-9a-f]{32}$'),
  curse boolean not null default false,
  slang boolean not null default false,
  style_notes text not null default '' check (char_length(style_notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists agent_avatars_touch_updated_at on public.agent_avatars;
create trigger agent_avatars_touch_updated_at before update on public.agent_avatars
  for each row execute function private.touch_updated_at();

alter table public.agent_settings add column if not exists active_avatar_id uuid
  references public.agent_avatars (id) on delete set null;

-- ---------------------------------------------------------------------------
-- RLS and grants: the owner reads and writes; hydra_ro reads; service_role (the relay, the Mac's voice) reads.
-- ---------------------------------------------------------------------------
alter table public.agent_avatars enable row level security;

revoke all on public.agent_avatars from public, anon, authenticated, hydra_ro;
grant select, insert, update, delete on public.agent_avatars to authenticated;
grant select on public.agent_avatars to hydra_ro;
grant all on public.agent_avatars to service_role;

drop policy if exists agent_avatars_owner_all on public.agent_avatars;
create policy agent_avatars_owner_all on public.agent_avatars for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
drop policy if exists agent_avatars_ro_select on public.agent_avatars;
create policy agent_avatars_ro_select on public.agent_avatars for select to hydra_ro using (true);

-- ---------------------------------------------------------------------------
-- Activity and undo (0130): avatars are logged, like agent_settings. Skipped where 0130 has not run.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('private.activity_tables') is not null then
    insert into private.activity_tables (tbl, logged, reason)
    values ('agent_avatars', true, null)
    on conflict (tbl) do update set logged = excluded.logged, reason = excluded.reason;
    drop trigger if exists "0_activity_capture" on public.agent_avatars;
    create trigger "0_activity_capture" after insert or update or delete on public.agent_avatars
      for each row execute function private.activity_capture('id');
  end if;
end;
$$;
