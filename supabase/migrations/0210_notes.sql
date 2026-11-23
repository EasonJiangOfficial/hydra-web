-- Hydra 0210: Notes (owner, 2026-11-22: "all notes should be stored on a notes page", "I should be able
-- to create and change notes just like notion"). Safe to re-run.
--
-- notes        one page of the Notes editor. doc is the editor's block document (BlockNote JSON, an array
--              of blocks); text is plain text the server derives from doc, for search and for the agent.
--              client_id makes a device's retry idempotent (the Mac sends drawn notes); it is unique
--              across devices, so a client_id another device used is refused, never answered with
--              that device's note (queries.ts createNote). updated_at moves
--              only when the title or the document changes, so pinning does not break the page's
--              compare-and-set save (the page saves "where updated_at = the one I loaded").

create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default '' check (length(title) <= 200),
  doc         jsonb not null default '[]'::jsonb
              check (jsonb_typeof(doc) = 'array' and octet_length(doc::text) <= 1000000),
  text        text not null default '' check (length(text) <= 200000),
  source      text not null default 'web' check (source in ('web', 'desktop', 'phone', 'routine', 'mcp', 'agent')),
  device_id   uuid references public.agent_devices (id) on delete set null,
  thread_id   uuid references public.agent_threads (id) on delete set null,
  client_id   text unique check (length(client_id) between 1 and 200),
  pinned      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- The words as written, and once more split at every non-letter-or-digit: the parser keeps
  -- sam@glow.co, docs.example.com and v2.5 whole, and the app's search (queries.ts searchQuery)
  -- splits the same way, so "glow" and "example" find them.
  search      tsvector generated always as (
                to_tsvector('simple', title || ' ' || text || ' ' || regexp_replace(title || ' ' || text, '[^[:alnum:]]+', ' ', 'g'))
              ) stored
);
create index if not exists notes_updated_idx on public.notes (updated_at desc);
create index if not exists notes_search_idx on public.notes using gin (search);

-- updated_at follows the content (title, doc), not the pin.
create or replace function private.notes_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.title, new.doc) is distinct from (old.title, old.doc) then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;
revoke execute on function private.notes_touch() from public;

drop trigger if exists notes_touch_updated_at on public.notes;
create trigger notes_touch_updated_at
  before update on public.notes
  for each row execute function private.notes_touch();

-- ---------------------------------------------------------------------------
-- RLS and grants. Owner only; hydra_ro (the assistant) reads. Anon and service_role get nothing:
-- the Mac writes through the owner-session bridge (asOwner), so its writes are logged in Activity.
-- ---------------------------------------------------------------------------
alter table public.notes enable row level security;

revoke all on public.notes from public, anon, authenticated, service_role, hydra_ro;
grant select, insert, update, delete on public.notes to authenticated;
grant select on public.notes to hydra_ro;

drop policy if exists notes_owner_all on public.notes;
create policy notes_owner_all on public.notes
  for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
drop policy if exists notes_ro_select on public.notes;
create policy notes_ro_select on public.notes
  for select to hydra_ro using (true);

-- ---------------------------------------------------------------------------
-- Activity and undo (0130): every change is logged, so a delete has the 30-day undo.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('private.activity_tables') is not null then
    insert into private.activity_tables (tbl, logged, reason)
    values ('notes', true, null)
    on conflict (tbl) do update set logged = excluded.logged, reason = excluded.reason;
    drop trigger if exists "0_activity_capture" on public.notes;
    create trigger "0_activity_capture" after insert or update or delete on public.notes
      for each row execute function private.activity_capture('id');
  end if;
end;
$$;
