-- Hydra 0191: add-on while thinking (W5 contract section 2, 2026-11-22). Owner: "sometimes it goes into
-- thinking, I should be able to interupt it", then "dont cancel but add onto the prompt".
-- What the owner says or types while a turn is in flight is added to that turn, never a new one:
-- POST /api/agent/turn/append {turnId, text} stores it here through agent_turn_append(). turnId is a relay
-- turn claimed by a device that reads additions (its claim acknowledged), or the thread lease of a server-loop turn
-- (agent_threads.busy_token while busy_until is ahead): so no foreign key.
-- The device that runs a relay turn gets the inputs it has not acknowledged with every events answer
-- (agent_relay_inputs_ack: inputsSeen = the highest seq it pushed into its session); a new claim starts
-- from none acknowledged. Closing a relay turn writes the owner's words and his additions into the thread.
-- A server-loop turn's additions have one owner each, taken once (agent_take_inputs, agent_write_inputs): the turn
-- itself, its last write, or the next turn on the thread when it died. Whoever marks them written writes them.
-- Owner-only RLS, explicit grants, service_role for the relay routes, hydra_ro reads. Safe to re-run.

create table if not exists public.agent_relay_inputs (
  turn_id     uuid not null,
  seq         int not null check (seq >= 1),
  text        text not null check (char_length(trim(text)) between 1 and 8000),
  created_at  timestamptz not null default clock_timestamp(),
  primary key (turn_id, seq)
);

-- written: some writer took it into the thread (server-loop turns only; a relay turn's close writes its own).
-- thread_id: the thread whose lease took it (null for a relay turn), so the next turn finds a dead turn's additions.
alter table public.agent_relay_inputs add column if not exists written boolean not null default false;
alter table public.agent_relay_inputs add column if not exists thread_id uuid references public.agent_threads (id) on delete cascade;
create index if not exists agent_relay_inputs_unwritten_idx on public.agent_relay_inputs (thread_id) where not written and thread_id is not null;

-- Activity (0130): relay internals are not logged, like agent_relay_events.
insert into private.activity_tables (tbl, logged, reason)
values ('agent_relay_inputs', false, 'relay: words added to a turn in flight')
on conflict (tbl) do update set logged = excluded.logged, reason = excluded.reason;

-- What the current claim's device acknowledged (inputs_claim names the claim; another claim: none yet).
alter table public.agent_relay_turns add column if not exists inputs_claim uuid;
alter table public.agent_relay_turns add column if not exists inputs_seen int not null default 0;
alter table public.agent_relay_turns drop constraint if exists agent_relay_turns_inputs_seen_check;
alter table public.agent_relay_turns add constraint agent_relay_turns_inputs_seen_check check (inputs_seen >= 0);

-- The owner adds words to a turn in flight. The turn row is locked first, so a close either ran before
-- (null: the route answers 409 and the client starts a new turn) or waits and then writes this input into
-- the thread with the rest. Returns the input's seq, or null when the turn is not in flight.
-- Security definer: the only way in. Nobody inserts a row directly, so no input lands on a finished turn or a
-- turn id that never ran (it would surface in the thread when a relay turn with that id closes). The caller's
-- role is the SET ROLE in force (current_user is the function's owner here).
create or replace function public.agent_turn_append(p_turn uuid, p_text text)
returns int language plpgsql security definer set search_path = '' as $$
declare
  s int;
  th uuid;
begin
  if coalesce(nullif(current_setting('role', true), 'none'), session_user::text) not in ('service_role', 'postgres') then
    if not (select public.is_owner()) then
      raise exception 'agent: no access' using errcode = '42501';
    end if;
  end if;
  if p_text is null or char_length(trim(p_text)) not between 1 and 8000 then
    raise exception 'agent: text is 1 to 8000 characters' using errcode = '22023';
  end if;
  -- A relay turn takes additions only once the device holding it has shown it reads them (its claim sent
  -- inputsSeen, even 0, through agent_relay_inputs_ack). A queued turn, or an older Mac or brain that never
  -- reads them, takes none: null, so the client asks them as the next turn instead of the answer ignoring them
  -- and the close storing them as if they were asked.
  perform 1 from public.agent_relay_turns
  where id = p_turn and status = 'claimed' and claim_id is not null and inputs_claim = claim_id for update;
  if not found then
    select t.id into th from public.agent_threads t where t.busy_token = p_turn and t.busy_until > now() for update;
    if not found then
      return null;
    end if;
  end if;
  select coalesce(max(i.seq), 0) + 1 into s from public.agent_relay_inputs i where i.turn_id = p_turn;
  insert into public.agent_relay_inputs (turn_id, seq, text, thread_id) values (p_turn, s, trim(p_text), th);
  return s;
end $$;

-- The device holding a claimed turn acknowledges inputs up to p_seen and gets the rest, in order.
-- Nothing for a claim that is not the turn's current one, or a turn no longer claimed.
create or replace function public.agent_relay_inputs_ack(p_turn uuid, p_device uuid, p_claim uuid, p_seen int)
returns table (input_seq int, input_text text)
language plpgsql security invoker set search_path = '' as $$
declare
  v public.agent_relay_turns;
  seen int;
begin
  select * into v from public.agent_relay_turns t where t.id = p_turn for update;
  if not found or v.status <> 'claimed' or v.claim_id is distinct from p_claim or v.claimed_by is distinct from p_device then
    return;
  end if;
  seen := greatest(case when v.inputs_claim = p_claim then v.inputs_seen else 0 end, coalesce(p_seen, 0), 0);
  if v.inputs_claim is distinct from p_claim or v.inputs_seen <> seen then
    update public.agent_relay_turns set inputs_claim = p_claim, inputs_seen = seen where id = p_turn;
  end if;
  return query select i.seq, i.text from public.agent_relay_inputs i where i.turn_id = p_turn and i.seq > seen order by i.seq;
end $$;

-- The device's events (0160's append, with the 0191 hold): a done is never stored while the owner's additions wait.
-- The route acknowledges the post's inputsSeen first, so the check below sees what the device has read.
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
  held boolean := false;
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
  -- 0191: a done while additions this claim's device has not acknowledged exist is held: it is counted (seq stays
  -- in step) but not stored, the turn stays claimed and the answer carries them. The device answers them, then
  -- sends done again. An error still closes (the device cannot go on); its additions are kept in the thread.
  if p_events->(total - 1)->>'type' = 'done' and total > skip and v.inputs_claim = p_claim
     and exists (select 1 from public.agent_relay_inputs i where i.turn_id = p_turn and i.seq > v.inputs_seen) then
    held := true;
  end if;
  for e in select value from jsonb_array_elements(p_events) with ordinality as t(value, i) where t.i > skip order by t.i loop
    if held and e->>'type' = 'done' then
      added := added + 1;
      continue;
    end if;
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

-- A server-loop turn takes its own unwritten additions (to merge them into its next user message): one statement marks
-- them written and returns them in order, so two takers get disjoint sets and a second take gets none.
-- The thread row is locked first, the order agent_write_inputs and agent_turn_append take, so two writers never
-- deadlock on the input rows.
create or replace function public.agent_take_inputs(p_turn uuid)
returns table (input_seq int, input_text text) language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.agent_threads t
  where t.id = (select i.thread_id from public.agent_relay_inputs i where i.turn_id = p_turn and i.thread_id is not null limit 1)
  for update;
  return query
    with taken as (
      update public.agent_relay_inputs i set written = true
      where i.turn_id = p_turn and not i.written
      returning i.seq, i.text
    )
    select taken.seq, taken.text from taken order by taken.seq;
end $$;

-- An earlier copy of this file made the claim write a dead turn's additions into the thread (it broke a bare
-- tool_use). The claim only takes the lease again (0070's body), so a re-run restores it.
create or replace function public.agent_claim_thread(p_thread uuid, p_token uuid, p_seconds int)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.agent_threads t
  set busy_token = p_token, busy_until = now() + make_interval(secs => greatest(p_seconds, 1))
  where t.id = p_thread and (t.busy_until is null or t.busy_until < now() or t.busy_token = p_token);
  return found;
end $$;

-- Take additions and write them into the thread as one user message (p_before, the additions with p_prefix, p_after)
-- in one transaction: death between the two cannot lose or double them. Returns the content written, or null.
-- p_own: p_turn's own additions (its last write, after its release). Nothing while another turn holds the thread:
--   that turn's first message takes them (the additions of an ended lease are fixed; agent_turn_append needs it live).
-- not p_own: the additions of the thread's other turns, the ones that died before they wrote them (a new turn's
--   first message). The thread row is locked first, the order agent_claim_thread and agent_turn_append take.
create or replace function public.agent_write_inputs(
  p_thread uuid, p_turn uuid, p_own boolean, p_surface text, p_prefix text default '',
  p_before jsonb default '[]', p_after jsonb default '[]')
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  tok uuid;
  til timestamptz;
  added jsonb;
  body jsonb;
begin
  if jsonb_typeof(p_before) is distinct from 'array' or jsonb_typeof(p_after) is distinct from 'array' then
    raise exception 'agent: before and after must be arrays' using errcode = '22023';
  end if;
  select t.busy_token, t.busy_until into tok, til from public.agent_threads t where t.id = p_thread for update;
  if not found then
    return null;
  end if;
  if p_own and til > now() and tok is distinct from p_turn then
    return null;
  end if;
  with taken as (
    update public.agent_relay_inputs i set written = true
    where i.thread_id = p_thread and not i.written and (case when p_own then i.turn_id = p_turn else i.turn_id <> p_turn end)
    returning i.created_at, i.seq, i.text
  )
  select jsonb_agg(jsonb_build_object('type', 'text', 'text', coalesce(p_prefix, '') || taken.text) order by taken.created_at, taken.seq)
  into added from taken;
  body := p_before || coalesce(added, '[]'::jsonb) || p_after;
  if jsonb_array_length(body) = 0 then
    return null;
  end if;
  insert into public.agent_messages (thread_id, role, content, surface) values (p_thread, 'user', body, p_surface);
  update public.agent_threads set surface = p_surface where id = p_thread;
  return body;
end $$;

-- Closing a relay turn (0160's trigger, now with the additions): the owner's words, then what he added
-- while it worked, as his one message; then the reply so far. A sub-turn (0160) still writes nothing into the
-- thread, and a closing parent still ends its open sub-turns. Its open approvals end as before.
create or replace function private.agent_relay_closed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  said text;
  added text;
  reply text;
begin
  if new.parent_turn_id is null then
    said := trim(coalesce(new.input->>'text', new.input->>'audioTranscript', ''));
    select string_agg(i.text, E'\n' order by i.seq) into added from public.agent_relay_inputs i where i.turn_id = new.id;
    if added is not null then
      said := trim(concat_ws(E'\n', nullif(said, ''), added));
    end if;
    select coalesce(string_agg(x.event->>'delta', '' order by x.seq), '') into reply
    from public.agent_relay_events x where x.turn_id = new.id and x.event->>'type' = 'text';
    if length(said) > 0 then
      insert into public.agent_messages (thread_id, role, content, surface)
      values (new.thread_id, 'user', jsonb_build_array(jsonb_build_object('type', 'text', 'text', said)), new.surface);
    end if;
    if length(trim(reply)) > 0 then
      insert into public.agent_messages (thread_id, role, content, surface)
      values (new.thread_id, 'assistant', jsonb_build_array(jsonb_build_object('type', 'text', 'text', reply)), new.surface);
    end if;
    update public.agent_threads set updated_at = now() where id = new.thread_id;
    -- Parent then child, the same lock order as agent_relay_append (0160): no deadlock.
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

do $$
begin
  revoke execute on function public.agent_turn_append(uuid, text) from public, anon;
  grant execute on function public.agent_turn_append(uuid, text) to authenticated, service_role;
  revoke execute on function public.agent_relay_inputs_ack(uuid, uuid, uuid, int) from public, anon, authenticated;
  grant execute on function public.agent_relay_inputs_ack(uuid, uuid, uuid, int) to service_role;
  revoke execute on function public.agent_take_inputs(uuid) from public, anon;
  grant execute on function public.agent_take_inputs(uuid) to authenticated, service_role;
  revoke execute on function public.agent_write_inputs(uuid, uuid, boolean, text, text, jsonb, jsonb) from public, anon;
  grant execute on function public.agent_write_inputs(uuid, uuid, boolean, text, text, jsonb, jsonb) to authenticated, service_role;
end $$;

-- RLS: the owner reads; he adds only through agent_turn_append (no insert grant); nobody edits an input.
-- hydra_ro reads.
alter table public.agent_relay_inputs enable row level security;
drop policy if exists agent_relay_inputs_owner_select on public.agent_relay_inputs;
create policy agent_relay_inputs_owner_select on public.agent_relay_inputs for select to authenticated using ((select public.is_owner()));
drop policy if exists agent_relay_inputs_owner_insert on public.agent_relay_inputs;
revoke all on public.agent_relay_inputs from public, anon, authenticated;
grant select on public.agent_relay_inputs to authenticated;
-- Only the written mark, for the server loop running as the owner (agent_take_inputs, agent_write_inputs).
grant update (written) on public.agent_relay_inputs to authenticated;
drop policy if exists agent_relay_inputs_owner_written on public.agent_relay_inputs;
create policy agent_relay_inputs_owner_written on public.agent_relay_inputs for update to authenticated using ((select public.is_owner())) with check ((select public.is_owner()));
grant all on public.agent_relay_inputs to service_role;
drop policy if exists agent_relay_inputs_ro_select on public.agent_relay_inputs;
create policy agent_relay_inputs_ro_select on public.agent_relay_inputs for select to hydra_ro using (true);
grant select on public.agent_relay_inputs to hydra_ro;
