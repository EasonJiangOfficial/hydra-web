-- Hydra 0070: the Hydra Agent service (DESIGN.md 6.9, 6.10 and 11; PLAN.md U13).
-- Threads, messages and memory shared by every surface; the action log with an inverse per action
-- (undo); approvals (the confirm gate, live and unattended); routines with their run log; in-app
-- notifications; paired devices (Hydra Desktop) and their one-time pairing codes; Mac steps queued
-- for Hydra Desktop to pull.
-- Owner-only RLS on every table, explicit grants (0001 revokes the defaults), service_role for the
-- cron. hydra_ro reads every table except the two that hold key hashes (agent_devices,
-- agent_pairing_codes): the read-only role has no use for them.
-- Idempotency: a routine fires once per occurrence. agent_claim_due_routines() locks due rows with
-- FOR UPDATE SKIP LOCKED, compare-and-sets last_fired_at, and inserts the run under
-- unique (routine_id, occurrence_at). Reminders use planning_claim_alert() from 0040.
-- Plain SQL, safe to re-run.

-- ---------------------------------------------------------------------------
-- Settings: the model and effort (a row is optional; the app uses these defaults without one).
-- ---------------------------------------------------------------------------
create table if not exists public.agent_settings (
  user_id         uuid primary key references private.app_owner (user_id) on delete cascade,
  model           text not null default 'claude-opus-5-5' check (length(model) between 1 and 100),
  effort_live     text not null default 'low' check (effort_live in ('low', 'medium', 'high', 'xhigh', 'max')),
  effort_routine  text not null default 'medium' check (effort_routine in ('low', 'medium', 'high', 'xhigh', 'max')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Threads and messages: one conversation shared by the browser, the phone and the Mac.
-- content is the Messages API content block array, stored as sent and as returned (append-only).
-- ---------------------------------------------------------------------------
create table if not exists public.agent_threads (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default '' check (length(title) <= 200),
  surface     text not null check (surface in ('web', 'phone', 'desktop', 'routine', 'mcp')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists agent_threads_updated_idx on public.agent_threads (updated_at desc);

create table if not exists public.agent_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.agent_threads (id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  content     jsonb not null check (jsonb_typeof(content) = 'array'),
  surface     text not null check (surface in ('web', 'phone', 'desktop', 'routine', 'mcp')),
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists agent_messages_thread_idx on public.agent_messages (thread_id, created_at, id);

-- Memory: short facts the owner asked Hydra to keep ("my accountant is Sam").
create table if not exists public.agent_memory (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique check (length(key) between 1 and 100),
  value       text not null check (length(value) between 1 and 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Routines and their runs (DESIGN.md 6.9 Routines, 6.10).
-- schedule: {"kind": "daily"|"weekdays"|"weekly"|"monthly", "time": "HH:MM", "days"?: [0-6],
-- "day"?: 1-31}, read in the owner's time zone (settings.time_zone). The app computes next_run_at.
-- next_run_at null and not paused = "schedule me": the cron fills it in.
-- ---------------------------------------------------------------------------
create table if not exists public.agent_routines (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(name) between 1 and 120),
  instruction    text not null check (length(instruction) between 1 and 4000),
  schedule       jsonb not null check (jsonb_typeof(schedule) = 'object'),
  tools          text[] not null default '{hydra}'
                 check (cardinality(tools) >= 1 and tools <@ array['hydra', 'mac', 'gmail', 'calendar']),
  delivery       text[] not null default '{notification}'
                 check (delivery <@ array['spoken', 'notification', 'push', 'email']),
  when_mac_off   text not null default 'wait' check (when_mac_off in ('wait', 'skip')),
  paused         boolean not null default false,
  next_run_at    timestamptz,
  last_fired_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists agent_routines_due_idx on public.agent_routines (next_run_at) where not paused;

create table if not exists public.agent_routine_runs (
  id             uuid primary key default gen_random_uuid(),
  routine_id     uuid not null references public.agent_routines (id) on delete cascade,
  occurrence_at  timestamptz not null,
  status         text not null default 'queued'
                 check (status in ('queued', 'running', 'ok', 'waiting_approval', 'waiting_mac', 'failed', 'skipped')),
  output         text not null default '' check (length(output) <= 20000),
  action_ids     uuid[] not null default '{}',
  error          text,
  thread_id      uuid references public.agent_threads (id) on delete set null,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (routine_id, occurrence_at)
);
create index if not exists agent_routine_runs_routine_idx on public.agent_routine_runs (routine_id, occurrence_at desc);

-- ---------------------------------------------------------------------------
-- Devices (Hydra Desktop, Claude Code): random key shown once, SHA-256 stored, scoped, revocable.
-- Pairing codes: one-time, short-lived, made by the owner in a signed-in session.
-- ---------------------------------------------------------------------------
create table if not exists public.agent_devices (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(name) between 1 and 80),
  key_hash      text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes        text[] not null default '{agent,mcp}'
                check (cardinality(scopes) >= 1 and scopes <@ array['agent', 'mcp']),
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists public.agent_pairing_codes (
  code_hash   text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  name        text not null default 'Hydra Desktop' check (length(name) between 1 and 80),
  scopes      text[] not null default '{agent,mcp}'
              check (cardinality(scopes) >= 1 and scopes <@ array['agent', 'mcp']),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  device_id   uuid references public.agent_devices (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- The action log: every write the agent made, with the inverse that undoes it (null = cannot).
-- ---------------------------------------------------------------------------
create table if not exists public.agent_actions (
  id              uuid primary key default gen_random_uuid(),
  thread_id       uuid references public.agent_threads (id) on delete set null,
  run_id          uuid references public.agent_routine_runs (id) on delete set null,
  device_id       uuid references public.agent_devices (id) on delete set null,
  tool            text not null check (length(tool) between 1 and 64),
  input           jsonb not null default '{}',
  result          jsonb,
  summary         text not null default '' check (length(summary) <= 500),
  inverse         jsonb check (inverse is null or (inverse ? 'tool' and inverse ? 'input')),
  surface         text not null check (surface in ('web', 'phone', 'desktop', 'routine', 'mcp')),
  undone_at       timestamptz,
  undo_action_id  uuid references public.agent_actions (id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists agent_actions_created_idx on public.agent_actions (created_at desc);

-- ---------------------------------------------------------------------------
-- Approvals: the confirm gate. live = a paused turn waits for it; routine = an unattended run
-- left it for the owner; mcp = a device must call again with its id.
-- ---------------------------------------------------------------------------
create table if not exists public.agent_approvals (
  id          uuid primary key default gen_random_uuid(),
  source      text not null check (source in ('live', 'routine', 'mcp')),
  thread_id   uuid references public.agent_threads (id) on delete cascade,
  run_id      uuid references public.agent_routine_runs (id) on delete cascade,
  device_id   uuid references public.agent_devices (id) on delete set null,
  tool        text not null check (length(tool) between 1 and 64),
  input       jsonb not null default '{}',
  summary     text not null check (length(summary) between 1 and 500),
  reason      text not null check (reason in ('delete', 'bulk', 'send', 'pay', 'mac')),
  danger      boolean not null default true,
  status      text not null default 'pending'
              check (status in ('pending', 'approved', 'declined', 'expired', 'done', 'failed')),
  result      jsonb,
  action_id   uuid references public.agent_actions (id) on delete set null,
  expires_at  timestamptz not null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists agent_approvals_pending_idx on public.agent_approvals (created_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Notifications: in-app list, pulled by Hydra Desktop; one per occurrence (dedupe_key).
-- ---------------------------------------------------------------------------
create table if not exists public.agent_notifications (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('reminder', 'routine', 'approval', 'info')),
  title       text not null check (length(title) between 1 and 200),
  body        text not null default '' check (length(body) <= 4000),
  href        text check (href is null or href ~ '^/[^/\\]'),
  dedupe_key  text unique check (dedupe_key is null or length(dedupe_key) <= 200),
  channels    text[] not null default '{notification}'
              check (channels <@ array['spoken', 'notification', 'push', 'email']),
  delivered   jsonb not null default '{}',
  desktop_at  timestamptz,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists agent_notifications_created_idx on public.agent_notifications (created_at desc);
create index if not exists agent_notifications_desktop_idx on public.agent_notifications (created_at) where desktop_at is null;

-- ---------------------------------------------------------------------------
-- Mac steps for Hydra Desktop to pull while it runs.
-- ---------------------------------------------------------------------------
create table if not exists public.agent_desktop_jobs (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid references public.agent_routine_runs (id) on delete cascade,
  thread_id    uuid references public.agent_threads (id) on delete set null,
  instruction  text not null check (length(instruction) between 1 and 4000),
  risky        boolean not null default false,
  status       text not null default 'queued' check (status in ('queued', 'claimed', 'done', 'failed', 'skipped')),
  device_id    uuid references public.agent_devices (id) on delete set null,
  result       jsonb,
  claimed_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists agent_desktop_jobs_queued_idx on public.agent_desktop_jobs (created_at) where status = 'queued';

-- The word that puts Hydra Desktop to sleep (DESIGN.md 6.9), shared by every device.
alter table public.agent_settings add column if not exists sleep_word text not null default 'Hydra, sleep';
alter table public.agent_settings drop constraint if exists agent_settings_sleep_word_check;
alter table public.agent_settings add constraint agent_settings_sleep_word_check check (length(trim(sleep_word)) between 1 and 60);

-- One turn at a time per thread (two surfaces share one thread): a lease the turn takes and frees.
-- busy_until ends the lease when a turn's function dies without freeing it.
alter table public.agent_threads add column if not exists busy_token uuid;
alter table public.agent_threads add column if not exists busy_until timestamptz;

-- A claimed run is started by the cron; a start that failed is tried again a few times.
alter table public.agent_routine_runs add column if not exists attempts int not null default 0;
alter table public.agent_routine_runs add column if not exists dispatched_at timestamptz;

-- Rate limits (DESIGN.md 11): one fixed one-minute window per bucket (a device and route, or the
-- pairing exchange per IP). Written only by agent_rate_hit() (service role).
create table if not exists public.agent_rate_limits (
  bucket         text primary key check (length(bucket) between 1 and 200),
  window_start   timestamptz not null,
  request_count  int not null
);

-- updated_at on the tables that are edited in place.
do $$
declare
  t text;
begin
  foreach t in array array['agent_settings', 'agent_threads', 'agent_memory', 'agent_routines'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.touch_updated_at()',
      t || '_touch_updated_at', t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Functions.
-- ---------------------------------------------------------------------------

-- Cron: claim every due routine occurrence once. Rows another run holds are skipped (SKIP LOCKED);
-- last_fired_at is compare-and-set; the run insert is unique per (routine, occurrence). next_run_at
-- goes to null ("schedule me"): the app computes the next one in the owner's time zone.
create or replace function public.agent_claim_due_routines(p_now timestamptz, p_limit int default 20)
returns table (run_id uuid, routine_id uuid, occurrence_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
begin
  return query
  with due as (
    select r.id, r.next_run_at
    from public.agent_routines r
    where not r.paused and r.next_run_at is not null and r.next_run_at <= p_now
    order by r.next_run_at
    limit greatest(p_limit, 0)
    for update skip locked
  ), fired as (
    update public.agent_routines r
    set last_fired_at = due.next_run_at, next_run_at = null
    from due
    where r.id = due.id and r.last_fired_at is distinct from due.next_run_at
    returning r.id, due.next_run_at as occ
  ), runs as (
    insert into public.agent_routine_runs (routine_id, occurrence_at, status)
    select fired.id, fired.occ, 'queued' from fired
    on conflict on constraint agent_routine_runs_routine_id_occurrence_at_key do nothing
    returning agent_routine_runs.id, agent_routine_runs.routine_id, agent_routine_runs.occurrence_at
  )
  select runs.id, runs.routine_id, runs.occurrence_at from runs;
end $$;

-- Pairing: a one-time code becomes a device. Null when the code is unknown, used or expired.
create or replace function public.agent_pair_exchange(p_code_hash text, p_key_hash text, p_name text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_code public.agent_pairing_codes;
  v_id uuid;
begin
  update public.agent_pairing_codes
  set used_at = now()
  where code_hash = p_code_hash and used_at is null and expires_at > now()
  returning * into v_code;
  if not found then
    return null;
  end if;
  insert into public.agent_devices (name, key_hash, scopes)
  values (coalesce(nullif(left(trim(coalesce(p_name, '')), 80), ''), v_code.name), p_key_hash, v_code.scopes)
  returning id into v_id;
  update public.agent_pairing_codes set device_id = v_id where code_hash = p_code_hash;
  return v_id;
end $$;

-- Device key check: the device (id, scopes) for a live key, and its last_seen_at moves.
create or replace function public.agent_device_auth(p_key_hash text)
returns table (id uuid, scopes text[])
language sql security invoker set search_path = '' as $$
  update public.agent_devices d
  set last_seen_at = now()
  where d.key_hash = p_key_hash and d.revoked_at is null
  returning d.id, d.scopes
$$;

-- Hydra Desktop pulls its queued Mac steps: each job goes to one device once.
create or replace function public.agent_claim_desktop_jobs(p_device uuid, p_limit int default 10)
returns setof public.agent_desktop_jobs
language plpgsql security invoker set search_path = '' as $$
begin
  -- Nested on purpose: the service role never calls is_owner() (no execute right needed).
  if current_user <> 'service_role' then
    if not (select public.is_owner()) then
      raise exception 'agent: no access' using errcode = '42501';
    end if;
  end if;
  return query
  with next_jobs as (
    select j.id from public.agent_desktop_jobs j
    where j.status = 'queued'
    order by j.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update public.agent_desktop_jobs j
  set status = 'claimed', device_id = p_device, claimed_at = now()
  from next_jobs
  where j.id = next_jobs.id
  returning j.*;
end $$;

-- A turn takes the thread: true when it was free (or its lease ran out). Caller's rights (RLS).
create or replace function public.agent_claim_thread(p_thread uuid, p_token uuid, p_seconds int)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.agent_threads t
  set busy_token = p_token, busy_until = now() + make_interval(secs => greatest(p_seconds, 1))
  where t.id = p_thread and (t.busy_until is null or t.busy_until < now() or t.busy_token = p_token);
  return found;
end $$;

-- Cron: every queued run that was never started, or whose last start is older than p_stale_seconds,
-- is (re)dispatched once per call: attempts goes up and dispatched_at moves. The app fails a run
-- whose attempts pass its cap. Rows another cron holds are skipped.
create or replace function public.agent_dispatch_runs(p_now timestamptz, p_stale_seconds int, p_limit int default 20)
returns table (run_id uuid, routine_id uuid, attempts int)
language plpgsql security invoker set search_path = '' as $$
begin
  return query
  with stale as (
    select r.id from public.agent_routine_runs r
    where r.status = 'queued'
      and (r.dispatched_at is null or r.dispatched_at < p_now - make_interval(secs => p_stale_seconds))
    order by r.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update public.agent_routine_runs r
  set attempts = r.attempts + 1, dispatched_at = p_now
  from stale
  where r.id = stale.id
  returning r.id, r.routine_id, r.attempts;
end $$;

-- One hit on a rate-limit bucket: 0 when allowed, else the seconds until the window resets.
create or replace function public.agent_rate_hit(p_bucket text, p_limit int)
returns int language plpgsql security invoker set search_path = '' as $$
declare
  win timestamptz := date_trunc('minute', now());
  n int;
begin
  insert into public.agent_rate_limits as r (bucket, window_start, request_count)
  values (left(p_bucket, 200), win, 1)
  on conflict (bucket) do update
    set request_count = case when r.window_start = excluded.window_start then r.request_count + 1 else 1 end,
        window_start = excluded.window_start
  returning r.request_count into n;
  if n > p_limit then
    return greatest(1, ceil(extract(epoch from (win + interval '1 minute' - now()))))::int;
  end if;
  return 0;
end $$;

do $$
declare
  f text;
begin
  revoke execute on function public.agent_claim_thread(uuid, uuid, int) from public, anon;
  grant execute on function public.agent_claim_thread(uuid, uuid, int) to authenticated, service_role;
  foreach f in array array[
    'agent_claim_due_routines(timestamptz, int)',
    'agent_pair_exchange(text, text, text)',
    'agent_device_auth(text)',
    'agent_dispatch_runs(timestamptz, int, int)',
    'agent_rate_hit(text, int)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  revoke execute on function public.agent_claim_desktop_jobs(uuid, int) from public, anon;
  grant execute on function public.agent_claim_desktop_jobs(uuid, int) to authenticated, service_role;
end $$;

-- ---------------------------------------------------------------------------
-- RLS: owner only on every table; explicit grants; hydra_ro reads all but the key tables.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'agent_settings', 'agent_threads', 'agent_messages', 'agent_memory', 'agent_routines',
    'agent_routine_runs', 'agent_devices', 'agent_pairing_codes', 'agent_actions', 'agent_approvals',
    'agent_notifications', 'agent_desktop_jobs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_select', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.is_owner()))', t || '_owner_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select public.is_owner()))', t || '_owner_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_update', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select public.is_owner())) with check ((select public.is_owner()))', t || '_owner_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_delete', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select public.is_owner()))', t || '_owner_delete', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_ro_select', t);
    if t not in ('agent_devices', 'agent_pairing_codes') then
      execute format('create policy %I on public.%I for select to hydra_ro using (true)', t || '_ro_select', t);
      execute format('grant select on public.%I to hydra_ro', t);
    else
      execute format('revoke all on public.%I from hydra_ro', t);
    end if;
  end loop;
end $$;

-- Devices are made only by agent_pair_exchange (service role): the owner reads, renames, revokes.
revoke insert on public.agent_devices from authenticated;

-- Rate-limit counters: service role only (they hold client IPs).
alter table public.agent_rate_limits enable row level security;
revoke all on public.agent_rate_limits from public, anon, authenticated;
grant all on public.agent_rate_limits to service_role;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hydra_ro') then
    revoke all on public.agent_rate_limits from hydra_ro;
  end if;
end $$;
