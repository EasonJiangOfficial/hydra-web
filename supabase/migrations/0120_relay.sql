-- Hydra 0120: the Mac is the brain (W3 contract, owner decision "A", 2026-11-22; contract fixes of the
-- same day).
-- agent_settings.brain picks where the Hydra Agent's model runs: 'mac' (Hydra Desktop on the owner's
-- Claude login, the default) or 'server' (the server loop, needs ANTHROPIC_API_KEY).
-- The web and the phone hand their turns to the Mac through a relay: agent_relay_turns (one row per
-- turn, claimed by one device under a lease and a claim id) and agent_relay_events (the Mac's SSE
-- events, in order). The Mac serves two slots at once: one live turn (web, phone, desktop) and one
-- routine turn. Asks the Mac would show locally become relay approvals (agent_approvals source
-- 'relay'). Closing a turn (done, error, expired) writes the owner's words and the reply into the
-- thread and ends the approvals nobody can act on any more.
-- Device scope 'relay' (the Mac serves relay turns); pairing hands out agent, mcp and relay, and a Mac
-- paired before 0120 (agent or mcp) gains relay.
-- Owner-only RLS, explicit grants, service_role for the relay routes, hydra_ro reads.
-- Plain SQL, safe to re-run.

alter table public.agent_settings add column if not exists brain text not null default 'mac';
alter table public.agent_settings drop constraint if exists agent_settings_brain_check;
alter table public.agent_settings add constraint agent_settings_brain_check check (brain in ('mac', 'server'));

-- Device scopes: relay joins agent and mcp; a new pairing gets all three.
alter table public.agent_devices drop constraint if exists agent_devices_scopes_check;
alter table public.agent_devices add constraint agent_devices_scopes_check
  check (cardinality(scopes) >= 1 and scopes <@ array['agent', 'mcp', 'relay']);
alter table public.agent_devices alter column scopes set default '{agent,mcp,relay}';
alter table public.agent_pairing_codes drop constraint if exists agent_pairing_codes_scopes_check;
alter table public.agent_pairing_codes add constraint agent_pairing_codes_scopes_check
  check (cardinality(scopes) >= 1 and scopes <@ array['agent', 'mcp', 'relay']);
alter table public.agent_pairing_codes alter column scopes set default '{agent,mcp,relay}';
-- "The Mac is online" = its relay loop called claim or append lately (not any device call).
alter table public.agent_devices add column if not exists relay_seen_at timestamptz;

-- A Mac paired before 0120 holds agent and mcp but not relay, so every relay call would answer 403.
-- Every live device that already had agent or mcp gains relay (re-run safe: one that has it is left).
create or replace function private.agent_relay_backfill_scopes()
returns int language sql security definer set search_path = '' as $$
  with hit as (
    update public.agent_devices set scopes = array_append(scopes, 'relay')
    where revoked_at is null and not ('relay' = any (scopes)) and scopes && array['agent', 'mcp']
    returning 1
  )
  select count(*)::int from hit
$$;
revoke execute on function private.agent_relay_backfill_scopes() from public, anon, authenticated;
select private.agent_relay_backfill_scopes();

-- The single owner (private.app_owner holds one row): the default owner of a relay turn, so the
-- service role can queue one too.
create or replace function private.relay_owner()
returns uuid language sql stable security definer set search_path = '' as $$
  select o.user_id from private.app_owner o limit 1
$$;
revoke execute on function private.relay_owner() from public, anon;
grant execute on function private.relay_owner() to authenticated, service_role;

create table if not exists public.agent_relay_turns (
  id              uuid primary key default gen_random_uuid(),
  owner           uuid not null default private.relay_owner() references private.app_owner (user_id) on delete cascade,
  thread_id       uuid not null references public.agent_threads (id) on delete cascade,
  input           jsonb not null check (jsonb_typeof(input) = 'object'),
  surface         text not null check (surface in ('web', 'phone', 'desktop', 'routine')),
  context         jsonb not null default '{}' check (jsonb_typeof(context) = 'object'),
  routine_run_id  uuid references public.agent_routine_runs (id) on delete cascade,
  allowed_tools   text[] check (allowed_tools is null or allowed_tools <@ array['hydra', 'mac', 'gmail', 'calendar']),
  status          text not null default 'queued' check (status in ('queued', 'claimed', 'done', 'error', 'expired')),
  claimed_by      uuid references public.agent_devices (id) on delete set null,
  -- A new random id per claim: every event post names it, so a re-queued turn never runs twice.
  claim_id        uuid,
  -- How many events the current claim posted (the Mac's seq dedupes a retried post).
  claim_seq       int not null default 0 check (claim_seq >= 0),
  lease_until     timestamptz,
  attempts        int not null default 0,
  created_at      timestamptz not null default clock_timestamp(),
  updated_at      timestamptz not null default now()
);
alter table public.agent_relay_turns add column if not exists claim_id uuid;
alter table public.agent_relay_turns add column if not exists claim_seq int not null default 0 check (claim_seq >= 0);
create index if not exists agent_relay_turns_queued_idx on public.agent_relay_turns (created_at) where status = 'queued';
create index if not exists agent_relay_turns_claimed_idx on public.agent_relay_turns (lease_until) where status = 'claimed';
create index if not exists agent_relay_turns_run_idx on public.agent_relay_turns (routine_run_id) where routine_run_id is not null;

create table if not exists public.agent_relay_events (
  turn_id     uuid not null references public.agent_relay_turns (id) on delete cascade,
  seq         int not null check (seq >= 1),
  event       jsonb not null check (jsonb_typeof(event) = 'object' and event ? 'type'),
  created_at  timestamptz not null default clock_timestamp(),
  primary key (turn_id, seq)
);

drop trigger if exists agent_relay_turns_touch_updated_at on public.agent_relay_turns;
create trigger agent_relay_turns_touch_updated_at before update on public.agent_relay_turns
  for each row execute function private.touch_updated_at();

-- Approvals: 'relay' = an ask the Mac would show locally in a relay turn (a connector send or trash,
-- a Mac tool, a risky click). The owner answers on any surface; the Mac polls it and acts.
-- relay_turn_id ties an approval (relay, or an mcp one the turn's confirm named) to its turn.
alter table public.agent_approvals drop constraint if exists agent_approvals_source_check;
alter table public.agent_approvals add constraint agent_approvals_source_check check (source in ('live', 'routine', 'mcp', 'relay'));
alter table public.agent_approvals add column if not exists relay_turn_id uuid references public.agent_relay_turns (id) on delete set null;
create index if not exists agent_approvals_relay_turn_idx on public.agent_approvals (relay_turn_id) where relay_turn_id is not null;

-- ---------------------------------------------------------------------------
-- Closing a turn (done, error, expired; from any path: the Mac's post, the sweep, the web's
-- timeout, the browser leaving): the owner's words and the reply so far go into the thread (nothing
-- he said is lost), and its open approvals end. A relay approval the owner already approved was
-- handed to the Mac (done); anything still pending, or an mcp approval nobody used, expires: no one
-- is left to run it.
-- ---------------------------------------------------------------------------
create or replace function private.agent_relay_closed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  said text;
  reply text;
begin
  said := coalesce(new.input->>'text', new.input->>'audioTranscript', '');
  select coalesce(string_agg(x.event->>'delta', '' order by x.seq), '') into reply
  from public.agent_relay_events x where x.turn_id = new.id and x.event->>'type' = 'text';
  if length(trim(said)) > 0 then
    insert into public.agent_messages (thread_id, role, content, surface)
    values (new.thread_id, 'user', jsonb_build_array(jsonb_build_object('type', 'text', 'text', said)), new.surface);
  end if;
  if length(trim(reply)) > 0 then
    insert into public.agent_messages (thread_id, role, content, surface)
    values (new.thread_id, 'assistant', jsonb_build_array(jsonb_build_object('type', 'text', 'text', reply)), new.surface);
  end if;
  update public.agent_threads set updated_at = now() where id = new.thread_id;
  update public.agent_approvals
  set status = case when source = 'relay' and status = 'approved' then 'done' else 'expired' end,
      decided_at = coalesce(decided_at, now())
  where relay_turn_id = new.id and status in ('pending', 'approved');
  return null;
end $$;
revoke execute on function private.agent_relay_closed() from public, anon, authenticated;

drop trigger if exists agent_relay_turns_closed on public.agent_relay_turns;
create trigger agent_relay_turns_closed after update of status on public.agent_relay_turns
  for each row
  when (new.status in ('done', 'error', 'expired') and old.status in ('queued', 'claimed'))
  execute function private.agent_relay_closed();

-- ---------------------------------------------------------------------------
-- Functions.
-- ---------------------------------------------------------------------------

-- A lease that ran out: the turn goes back to the queue once (its claim id dies with the lease);
-- the second time it fails, with an error event so every reader sees the end. Owner session (the
-- waiting turn route) or service role.
create or replace function public.agent_relay_sweep()
returns int language plpgsql security invoker set search_path = '' as $$
declare
  v public.agent_relay_turns;
  n int := 0;
begin
  -- Nested on purpose: the service role never calls is_owner() (no execute right needed).
  if current_user <> 'service_role' then
    if not (select public.is_owner()) then
      raise exception 'agent: no access' using errcode = '42501';
    end if;
  end if;
  for v in
    select * from public.agent_relay_turns t
    where t.status = 'claimed' and t.lease_until < now()
    for update skip locked
  loop
    if v.attempts < 2 then
      update public.agent_relay_turns set status = 'queued', claimed_by = null, claim_id = null, lease_until = null where id = v.id;
    else
      insert into public.agent_relay_events (turn_id, seq, event)
      select v.id, coalesce(max(e.seq), 0) + 1,
             jsonb_build_object('type', 'error', 'code', 'mac_failed', 'message', 'Your Mac stopped answering.')
      from public.agent_relay_events e where e.turn_id = v.id;
      update public.agent_relay_turns set status = 'error', lease_until = null where id = v.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- The Mac takes the oldest queued turn of one slot ('live': web, phone, desktop; 'routine'; null:
-- either): one device wins (FOR UPDATE SKIP LOCKED), under a lease and a fresh claim id. A routine's
-- turn whose run is no longer live (skipped, failed, replaced) is expired instead of run. Claiming a
-- waiting_mac run moves it to running. The claim counts as the Mac's relay loop being seen.
drop function if exists public.agent_relay_claim(uuid, int);
create or replace function public.agent_relay_claim(p_device uuid, p_lease_seconds int default 60, p_slot text default null)
returns setof public.agent_relay_turns
language plpgsql security invoker set search_path = '' as $$
declare
  v public.agent_relay_turns;
begin
  if p_slot is not null and p_slot not in ('live', 'routine') then
    raise exception 'agent: slot must be live or routine' using errcode = '22023';
  end if;
  update public.agent_devices set relay_seen_at = now() where id = p_device;
  perform public.agent_relay_sweep();
  update public.agent_relay_turns q set status = 'expired', lease_until = null
  where q.status = 'queued' and q.routine_run_id is not null
    and not exists (select 1 from public.agent_routine_runs r where r.id = q.routine_run_id and r.status in ('running', 'waiting_mac'));
  update public.agent_relay_turns t
  set status = 'claimed', claimed_by = p_device, claim_id = gen_random_uuid(), claim_seq = 0, attempts = t.attempts + 1,
      lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 1))
  where t.id = (
    select q.id from public.agent_relay_turns q
    where q.status = 'queued'
      and (p_slot is null or (p_slot = 'routine') = (q.surface = 'routine'))
    order by q.created_at
    limit 1
    for update skip locked
  )
  returning t.* into v;
  if v.id is null then
    return;
  end if;
  if v.routine_run_id is not null then
    update public.agent_routine_runs set status = 'running', started_at = now()
    where id = v.routine_run_id and status = 'waiting_mac';
  end if;
  return next v;
end $$;

-- The Mac posts events for a turn it holds, naming its claim. Stored in order after the last one;
-- the lease renews (an empty batch is the heartbeat). p_seq (optional) is the Mac's number of the
-- batch's first event within this claim (1, 2, ...): events this claim already posted are skipped, so
-- a retried post never duplicates; a jump past the next one is 'seq_gap'. A confirm names its
-- approval: it joins the turn (and a routine's run, waiting up to 24 h). done or error closes the
-- turn (the close trigger writes the thread). A retried closing post answers the turn's status.
-- Returns the turn's status after the post, or 'not_found' / 'stale_claim' / 'not_yours' / 'seq_gap'.
drop function if exists public.agent_relay_append(uuid, uuid, jsonb, int);
create or replace function public.agent_relay_append(
  p_turn uuid, p_device uuid, p_claim uuid, p_seq int, p_events jsonb, p_lease_seconds int default 60)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  v public.agent_relay_turns;
  e jsonb;
  s int;
  skip int := 0;
  total int;
  added int := 0;
  last_type text;
begin
  if jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'agent: events must be an array' using errcode = '22023';
  end if;
  if p_seq is not null and p_seq < 1 then
    raise exception 'agent: seq starts at 1' using errcode = '22023';
  end if;
  select * into v from public.agent_relay_turns where id = p_turn for update;
  if not found then
    return 'not_found';
  end if;
  if v.claim_id is distinct from p_claim then
    return 'stale_claim';
  end if;
  if v.claimed_by is distinct from p_device then
    return 'not_yours';
  end if;
  update public.agent_devices set relay_seen_at = now() where id = p_device;
  total := jsonb_array_length(p_events);
  if p_seq is not null then
    if p_seq > v.claim_seq + 1 then
      return 'seq_gap';
    end if;
    skip := v.claim_seq - (p_seq - 1);
  end if;
  if v.status <> 'claimed' then
    -- Only a replay of the post that closed it (nothing new in it) gets an answer.
    if v.status in ('done', 'error') and p_seq is not null and total > 0 and skip >= total then
      return v.status;
    end if;
    return 'stale_claim';
  end if;
  select coalesce(max(x.seq), 0) into s from public.agent_relay_events x where x.turn_id = p_turn;
  for e in select value from jsonb_array_elements(p_events) with ordinality as t(value, i) where t.i > skip order by t.i loop
    s := s + 1;
    added := added + 1;
    insert into public.agent_relay_events (turn_id, seq, event) values (p_turn, s, e);
    last_type := e->>'type';
    if last_type = 'confirm' then
      update public.agent_approvals
      set relay_turn_id = coalesce(relay_turn_id, p_turn),
          run_id = coalesce(run_id, v.routine_run_id),
          expires_at = case when v.routine_run_id is not null then greatest(expires_at, created_at + interval '24 hours') else expires_at end
      where id = (e->>'id')::uuid and device_id = p_device;
    end if;
  end loop;
  if last_type in ('done', 'error') then
    update public.agent_relay_turns set status = last_type, lease_until = null, claim_seq = claim_seq + added where id = p_turn;
    return last_type;
  end if;
  update public.agent_relay_turns
  set lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)), claim_seq = claim_seq + added
  where id = p_turn;
  return 'claimed';
end $$;

-- An ask the Mac would show locally becomes the owner's approval, only while this claim holds the
-- turn open. The turn row is locked first, so a close (done, error, expired, sweep) either runs before
-- (no row: the route answers stale_claim) or waits and then ends this approval with its turn: no
-- relay approval outlives its turn. Returns the new row, or none.
create or replace function public.agent_relay_approval(
  p_turn uuid, p_device uuid, p_claim uuid, p_summary text, p_danger boolean, p_expires_at timestamptz)
returns setof public.agent_approvals language plpgsql security invoker set search_path = '' as $$
declare
  v public.agent_relay_turns;
begin
  select * into v from public.agent_relay_turns
  where id = p_turn and status = 'claimed' and claim_id = p_claim and claimed_by = p_device
  for update;
  if not found then
    return;
  end if;
  return query
  insert into public.agent_approvals (source, thread_id, run_id, device_id, relay_turn_id, tool, input, summary, reason, danger, expires_at)
  values ('relay', v.thread_id, v.routine_run_id, p_device, v.id, 'relay', '{}', p_summary, 'mac', p_danger, p_expires_at)
  returning *;
end $$;

do $$
begin
  revoke execute on function public.agent_relay_sweep() from public, anon;
  grant execute on function public.agent_relay_sweep() to authenticated, service_role;
  revoke execute on function public.agent_relay_claim(uuid, int, text) from public, anon, authenticated;
  grant execute on function public.agent_relay_claim(uuid, int, text) to service_role;
  revoke execute on function public.agent_relay_append(uuid, uuid, uuid, int, jsonb, int) from public, anon, authenticated;
  grant execute on function public.agent_relay_append(uuid, uuid, uuid, int, jsonb, int) to service_role;
  revoke execute on function public.agent_relay_approval(uuid, uuid, uuid, text, boolean, timestamptz) from public, anon, authenticated;
  grant execute on function public.agent_relay_approval(uuid, uuid, uuid, text, boolean, timestamptz) to service_role;
end $$;

-- ---------------------------------------------------------------------------
-- RLS: owner only; explicit grants; hydra_ro reads.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['agent_relay_turns', 'agent_relay_events'] loop
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
    execute format('create policy %I on public.%I for select to hydra_ro using (true)', t || '_ro_select', t);
    execute format('grant select on public.%I to hydra_ro', t);
  end loop;
end $$;

-- A relay turn's owner is the signed-in owner.
drop policy if exists agent_relay_turns_owner_insert on public.agent_relay_turns;
create policy agent_relay_turns_owner_insert on public.agent_relay_turns for insert to authenticated
  with check ((select public.is_owner()) and owner = (select auth.uid()));
