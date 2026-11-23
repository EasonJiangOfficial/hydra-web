-- Hydra 0160: the phone controls the Mac (owner, 2026-11-22: "also using it from my phone it should be
-- able to control stuff from my computer"; W5 voice contract section 7).
-- The server brain, running a web or phone turn, asks the Mac to act: it makes a relay SUB-TURN of the
-- turn it holds (parent_turn_id; the parent's thread, surface and context; allowed_tools {mac}), which
-- only a Mac claims (needs_mac: 0121's claim already gives such turns only to role 'mac'). The brain
-- polls it and gets the Mac's text. No Mac online: the sub-turn is born closed with "Your Mac is
-- offline." (no hang). A sub-turn writes nothing into the thread (the brain says the outcome); its
-- confirms are copied into the parent's stream, so the owner sees the real ask on the surface he is
-- on; the parent closing ends its open sub-turns (and with them their approvals).
-- Plain SQL, safe to re-run.

alter table public.agent_relay_turns add column if not exists parent_turn_id uuid references public.agent_relay_turns (id) on delete cascade;
-- The same rule as 0121's agent_relay_needs_mac, stored so a reader (and an index) sees it.
alter table public.agent_relay_turns add column if not exists needs_mac boolean
  generated always as (surface = 'desktop' or coalesce('mac' = any (allowed_tools), false)) stored;
alter table public.agent_relay_turns drop constraint if exists agent_relay_turns_subturn_check;
alter table public.agent_relay_turns add constraint agent_relay_turns_subturn_check
  check (parent_turn_id is null or (surface in ('web', 'phone') and allowed_tools = array['mac'] and routine_run_id is null and parent_turn_id <> id));
create index if not exists agent_relay_turns_parent_idx on public.agent_relay_turns (parent_turn_id) where parent_turn_id is not null;

-- ---------------------------------------------------------------------------
-- Closing (0120's body): a sub-turn's words are the brain's, not the owner's, so it writes nothing
-- into the thread; its open approvals end as before. A closing parent ends its open sub-turns.
-- ---------------------------------------------------------------------------
create or replace function private.agent_relay_closed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  said text;
  reply text;
begin
  if new.parent_turn_id is null then
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
    -- Parent then child, the same lock order as agent_relay_append below: no deadlock.
    update public.agent_relay_turns set status = 'expired', lease_until = null
    where parent_turn_id = new.id and status in ('queued', 'claimed');
  end if;
  update public.agent_approvals
  set status = case when source = 'relay' and status = 'approved' then 'done' else 'expired' end,
      decided_at = coalesce(decided_at, now())
  where relay_turn_id = new.id and status in ('pending', 'approved');
  return null;
end $$;
revoke execute on function private.agent_relay_closed() from public, anon, authenticated;

-- A parent whose claim ends without closing (the sweep puts a lapsed one back in the queue) ends its
-- open sub-turns too: the next claim replays the turn and asks the Mac again, so an old one must not
-- also run (and its asks end with it).
create or replace function private.agent_relay_reclaimed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.agent_relay_turns set status = 'expired', lease_until = null
  where parent_turn_id = new.id and status in ('queued', 'claimed');
  return null;
end $$;
revoke execute on function private.agent_relay_reclaimed() from public, anon, authenticated;

drop trigger if exists agent_relay_turns_reclaimed on public.agent_relay_turns;
create trigger agent_relay_turns_reclaimed after update of claim_id on public.agent_relay_turns
  for each row
  when (old.parent_turn_id is null and old.claim_id is not null and new.claim_id is distinct from old.claim_id)
  execute function private.agent_relay_reclaimed();

-- ---------------------------------------------------------------------------
-- A sub-turn's confirm also goes into its open parent's stream (the browser streams only the parent):
-- the owner sees the Mac's real ask, with its full target, on the phone or the web. Nothing else of
-- a sub-turn streams.
-- ---------------------------------------------------------------------------
create or replace function private.agent_relay_subturn_confirm()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_parent uuid;
begin
  select p.id into v_parent
  from public.agent_relay_turns c join public.agent_relay_turns p on p.id = c.parent_turn_id
  where c.id = new.turn_id and p.status = 'claimed';
  if v_parent is null then
    return null;
  end if;
  perform 1 from public.agent_relay_turns where id = v_parent for update;
  insert into public.agent_relay_events (turn_id, seq, event)
  select v_parent, coalesce(max(e.seq), 0) + 1, new.event from public.agent_relay_events e where e.turn_id = v_parent;
  return null;
end $$;
revoke execute on function private.agent_relay_subturn_confirm() from public, anon, authenticated;

-- 0120's append, with one change: a sub-turn's post takes its parent's lock before its own.
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
  -- A sub-turn's post locks the parent first (its confirm is copied there), the order a closing or
  -- re-queued parent takes before it ends its sub-turns: the two never deadlock.
  perform 1 from public.agent_relay_turns p
  where p.id = (select t.parent_turn_id from public.agent_relay_turns t where t.id = p_turn) for update;
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

drop trigger if exists agent_relay_events_subturn_confirm on public.agent_relay_events;
create trigger agent_relay_events_subturn_confirm after insert on public.agent_relay_events
  for each row when (new.event->>'type' = 'confirm')
  execute function private.agent_relay_subturn_confirm();

-- ---------------------------------------------------------------------------
-- The brain makes a sub-turn of the turn it holds under p_claim. Returns one row (id, outcome):
-- 'queued' (a Mac will claim it), 'mac_offline' (no Mac's relay loop ran in the last 45 s: the
-- sub-turn is closed at once with the error event "Your Mac is offline."), or no id with
-- 'not_found' / 'stale_claim' / 'not_yours' / 'not_brain' / 'not_live' (the parent is itself a
-- sub-turn, or not a web or phone turn).
-- ---------------------------------------------------------------------------
create or replace function public.agent_relay_subturn(p_parent uuid, p_device uuid, p_claim uuid, p_instruction text)
returns table (id uuid, outcome text)
language plpgsql security invoker set search_path = '' as $$
declare
  v public.agent_relay_turns;
  v_id uuid;
  v_online boolean;
begin
  if length(trim(coalesce(p_instruction, ''))) = 0 then
    raise exception 'agent: an instruction is needed' using errcode = '22023';
  end if;
  select * into v from public.agent_relay_turns t where t.id = p_parent for update;
  if not found then
    return query select null::uuid, 'not_found'::text;
    return;
  end if;
  if v.claim_id is distinct from p_claim or v.status <> 'claimed' or not (v.lease_until > now()) then
    return query select null::uuid, 'stale_claim'::text;
    return;
  end if;
  if v.claimed_by is distinct from p_device then
    return query select null::uuid, 'not_yours'::text;
    return;
  end if;
  if not exists (select 1 from public.agent_devices d where d.id = p_device and d.role = 'brain') then
    return query select null::uuid, 'not_brain'::text;
    return;
  end if;
  if v.parent_turn_id is not null or v.surface not in ('web', 'phone') then
    return query select null::uuid, 'not_live'::text;
    return;
  end if;
  v_online := exists (
    select 1 from public.agent_devices d
    where d.role = 'mac' and d.revoked_at is null and 'relay' = any (d.scopes) and d.relay_seen_at >= now() - interval '45 seconds'
  );
  insert into public.agent_relay_turns (owner, thread_id, input, surface, context, allowed_tools, parent_turn_id, status)
  values (v.owner, v.thread_id, jsonb_build_object('text', trim(p_instruction)), v.surface, v.context, array['mac'], v.id,
          case when v_online then 'queued' else 'error' end)
  returning agent_relay_turns.id into v_id;
  if not v_online then
    insert into public.agent_relay_events (turn_id, seq, event)
    values (v_id, 1, jsonb_build_object('type', 'error', 'code', 'mac_offline', 'message', 'Your Mac is offline.'));
  end if;
  return query select v_id, case when v_online then 'queued' else 'mac_offline' end;
end $$;

do $$
begin
  revoke execute on function public.agent_relay_subturn(uuid, uuid, uuid, text) from public, anon, authenticated;
  grant execute on function public.agent_relay_subturn(uuid, uuid, uuid, text) to service_role;
end $$;
