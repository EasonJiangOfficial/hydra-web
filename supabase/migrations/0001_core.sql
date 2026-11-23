-- Hydra 0001: core. One owner, entities, settings, owner-only RLS, read-only role for the assistant.
-- DESIGN.md sections 3 and 11. Plain SQL, safe to re-run.

-- ---------------------------------------------------------------------------
-- Default privileges: future objects get no grants. Every later migration grants explicitly.
-- Supabase leaves anon/authenticated TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on new public tables,
-- and Postgres gives PUBLIC execute on every new function. The function revoke must be global:
-- a per-schema revoke cannot remove a global default.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Private schema: not in the API's exposed schemas (config.toml [api] schemas).
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- At most one owner row: the singleton column is unique and can only be true.
create table if not exists private.app_owner (
  user_id uuid primary key references auth.users (id) on delete cascade,
  singleton boolean not null default true unique check (singleton),
  created_at timestamptz not null default now()
);
revoke all on private.app_owner from public, anon, authenticated;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- is_owner(): true when the caller is the app owner.
-- ---------------------------------------------------------------------------
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.app_owner o where o.user_id = (select auth.uid()));
$$;
revoke execute on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;

-- ---------------------------------------------------------------------------
-- Entities: Personal, UGC (sole proprietor), UGM LLC (dissolved, kept for history).
-- ---------------------------------------------------------------------------
create table if not exists public.entities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  kind text not null check (kind in ('personal', 'business')),
  tax_shape text,
  status text not null default 'active' check (status in ('active', 'closed')),
  closed_on date,
  created_at timestamptz not null default now()
);

insert into public.entities (slug, name, kind, tax_shape, status)
values
  ('personal', 'Personal', 'personal', null, 'active'),
  ('ugc', 'UGC', 'business', 'sole_prop', 'active'),
  ('ugm', 'UGM LLC', 'business', 'llc', 'closed')
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Settings: one row, keyed by the owner. The FK to app_owner keeps it to the owner only.
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  user_id uuid primary key references private.app_owner (user_id) on delete cascade,
  time_zone text, -- null until the first login writes the browser's zone
  chat_model text not null default 'claude-sonnet-5-5',
  idle_lock_minutes int, -- null = idle lock off (the default); constraint below
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idle lock is off by default (owner, 2026-11-21: stay signed in until sign-out).
-- Written as alters so a re-run also updates a table made by an earlier copy of this file.
alter table public.settings alter column idle_lock_minutes drop not null;
alter table public.settings alter column idle_lock_minutes set default null;
alter table public.settings drop constraint if exists settings_idle_lock_minutes_check;
alter table public.settings add constraint settings_idle_lock_minutes_check
  check (idle_lock_minutes is null or idle_lock_minutes between 1 and 60);

drop trigger if exists settings_touch_updated_at on public.settings;
create trigger settings_touch_updated_at
  before update on public.settings
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Owner bootstrap: only the service role may call it (scripts/bootstrap-owner.ts).
-- Idempotent for the same user; refuses a second, different owner.
-- ---------------------------------------------------------------------------
create or replace function public.bootstrap_owner(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing uuid;
begin
  select user_id into existing from private.app_owner;
  if existing is not null and existing <> p_user_id then
    raise exception 'another owner already exists' using errcode = '23505';
  end if;
  insert into private.app_owner (user_id) values (p_user_id) on conflict (user_id) do nothing;
  insert into public.settings (user_id) values (p_user_id) on conflict (user_id) do nothing;
  return case when existing is null then 'created' else 'unchanged' end;
end;
$$;
revoke execute on function public.bootstrap_owner(uuid) from public, anon, authenticated;
grant execute on function public.bootstrap_owner(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS: on for every table. Owner only. Anon has no grants at all.
-- ---------------------------------------------------------------------------
alter table private.app_owner enable row level security;
alter table public.entities enable row level security;
alter table public.settings enable row level security;

-- Grants are explicit: the project does not hand Data API grants to new tables by default, and a
-- project that does must not leak them. RLS then narrows authenticated to the owner.
revoke all on public.entities, public.settings from public, anon, authenticated;
-- Entities are created by migrations and the service role only.
grant select, update on public.entities to authenticated;
grant select, insert, update, delete on public.settings to authenticated;
grant all on public.entities, public.settings to service_role;

drop policy if exists entities_owner_select on public.entities;
create policy entities_owner_select on public.entities
  for select to authenticated using ((select public.is_owner()));
drop policy if exists entities_owner_update on public.entities;
create policy entities_owner_update on public.entities
  for update to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

drop policy if exists settings_owner_select on public.settings;
create policy settings_owner_select on public.settings
  for select to authenticated using ((select public.is_owner()));
drop policy if exists settings_owner_insert on public.settings;
create policy settings_owner_insert on public.settings
  for insert to authenticated
  with check ((select public.is_owner()) and user_id = (select auth.uid()));
drop policy if exists settings_owner_update on public.settings;
create policy settings_owner_update on public.settings
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()) and user_id = (select auth.uid()));
drop policy if exists settings_owner_delete on public.settings;
create policy settings_owner_delete on public.settings
  for delete to authenticated using ((select public.is_owner()));

-- ---------------------------------------------------------------------------
-- hydra_ro: the assistant's read-only role. 5 s statement timeout, read-only transactions.
-- Role settings apply at login and when PostgREST impersonates the role. A plain SET ROLE
-- does not load them, so a caller that uses SET ROLE must also SET LOCAL these two values.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hydra_ro') then
    create role hydra_ro nologin;
  end if;
end;
$$;
alter role hydra_ro set statement_timeout = '5s';
alter role hydra_ro set default_transaction_read_only = on;

grant usage on schema public to hydra_ro;
grant select on all tables in schema public to hydra_ro;
alter default privileges in schema public grant select on tables to hydra_ro;

drop policy if exists entities_ro_select on public.entities;
create policy entities_ro_select on public.entities for select to hydra_ro using (true);
drop policy if exists settings_ro_select on public.settings;
create policy settings_ro_select on public.settings for select to hydra_ro using (true);
