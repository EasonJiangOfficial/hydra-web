-- Hydra 0121: the server brain (owner, 2026-11-22: "instead of it relying on my mac why not host it on
-- a vps"). A server runs the same relay client as the Mac, headless, on the owner's Claude login.
-- agent_devices.role: 'mac' (Hydra Desktop; every device paired before 0121) or 'brain' (the server).
-- The role comes only from the pairing code the owner made ("Server" on the Accounts page) and never
-- changes after: no one, owner included, can turn a Mac into the brain or back by an update.
-- Routing: a turn that needs the Mac (asked from Hydra Desktop, or a routine with Mac tools) goes only
-- to a Mac. Every other live and routine turn goes only to brains while one is online (its relay loop
-- ran in the last 45 s); a Mac gets those only when no brain is online (the fallback). Mac local turns are
-- unchanged (/relay/local).
-- Plain SQL, safe to re-run.

alter table public.agent_devices add column if not exists role text not null default 'mac';
alter table public.agent_devices drop constraint if exists agent_devices_role_check;
alter table public.agent_devices add constraint agent_devices_role_check
  check (role in ('mac', 'brain') and (role = 'mac' or 'relay' = any (scopes)));

alter table public.agent_pairing_codes add column if not exists role text not null default 'mac';
alter table public.agent_pairing_codes drop constraint if exists agent_pairing_codes_role_check;
alter table public.agent_pairing_codes add constraint agent_pairing_codes_role_check
  check (role in ('mac', 'brain') and (role = 'mac' or 'relay' = any (scopes)));

-- The role is set once, at pairing.
create or replace function private.agent_device_role_fixed()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.role is distinct from old.role then
    raise exception 'agent: a device role is set only by its pairing code' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function private.agent_device_role_fixed() from public, anon, authenticated;
drop trigger if exists agent_devices_role_fixed on public.agent_devices;
create trigger agent_devices_role_fixed before update of role on public.agent_devices
  for each row execute function private.agent_device_role_fixed();

-- Pairing: a one-time code becomes a device with the code's scopes and role. Null when the code is
-- unknown, used or expired. (0070's body plus the role.)
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
  insert into public.agent_devices (name, key_hash, scopes, role)
  values (coalesce(nullif(left(trim(coalesce(p_name, '')), 80), ''), v_code.name), p_key_hash, v_code.scopes, v_code.role)
  returning id into v_id;
  update public.agent_pairing_codes set device_id = v_id where code_hash = p_code_hash;
  return v_id;
end $$;

-- The role a live (unused, unexpired) code would give, or null. The exchange reads it first, so Hydra
-- Desktop can refuse a Server code (and hydra-brain a Mac code) without using it up.
create or replace function public.agent_pairing_code_role(p_code_hash text)
returns text language sql stable security invoker set search_path = '' as $$
  select c.role from public.agent_pairing_codes c
  where c.code_hash = p_code_hash and c.used_at is null and c.expires_at > now()
$$;

-- A turn that needs the Mac's hands: asked from Hydra Desktop, or a routine with Mac tools.
create or replace function public.agent_relay_needs_mac(p_surface text, p_tools text[])
returns boolean language sql immutable set search_path = '' as $$
  select p_surface = 'desktop' or coalesce('mac' = any (p_tools), false)
$$;

-- The claim (0120's body plus routing). A turn that needs the Mac (asked from Hydra Desktop, surface
-- 'desktop', or a routine with Mac tools) goes only to a Mac: the brain has no Mac tools. Every other
-- turn goes to a brain while one is online (live, relay scope, relay loop seen in the last 45 s); a
-- Mac gets those only when no brain is online. A refused Mac still counts as seen: the fallback.
create or replace function public.agent_relay_claim(p_device uuid, p_lease_seconds int default 60, p_slot text default null)
returns setof public.agent_relay_turns
language plpgsql security invoker set search_path = '' as $$
declare
  v public.agent_relay_turns;
  v_brain boolean;
  v_brain_online boolean;
begin
  if p_slot is not null and p_slot not in ('live', 'routine') then
    raise exception 'agent: slot must be live or routine' using errcode = '22023';
  end if;
  update public.agent_devices set relay_seen_at = now() where id = p_device;
  perform public.agent_relay_sweep();
  update public.agent_relay_turns q set status = 'expired', lease_until = null
  where q.status = 'queued' and q.routine_run_id is not null
    and not exists (select 1 from public.agent_routine_runs r where r.id = q.routine_run_id and r.status in ('running', 'waiting_mac'));
  v_brain := exists (select 1 from public.agent_devices d where d.id = p_device and d.role = 'brain');
  v_brain_online := exists (
    select 1 from public.agent_devices b
    where b.role = 'brain' and b.id <> p_device and b.revoked_at is null and 'relay' = any (b.scopes)
      and b.relay_seen_at >= now() - interval '45 seconds'
  );
  update public.agent_relay_turns t
  set status = 'claimed', claimed_by = p_device, claim_id = gen_random_uuid(), claim_seq = 0, attempts = t.attempts + 1,
      lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 1))
  where t.id = (
    select q.id from public.agent_relay_turns q
    where q.status = 'queued'
      and (p_slot is null or (p_slot = 'routine') = (q.surface = 'routine'))
      and case
        when v_brain then not public.agent_relay_needs_mac(q.surface, q.allowed_tools)
        when v_brain_online then public.agent_relay_needs_mac(q.surface, q.allowed_tools)
        else true
      end
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

-- The sweep (0120's body), worded for who held the turn: a brain's lapsed turn ends with brain_failed
-- "Hydra stopped answering.", a Mac's with mac_failed as before.
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
             case when exists (select 1 from public.agent_devices d where d.id = v.claimed_by and d.role = 'brain')
               then jsonb_build_object('type', 'error', 'code', 'brain_failed', 'message', 'Hydra stopped answering.')
               else jsonb_build_object('type', 'error', 'code', 'mac_failed', 'message', 'Your Mac stopped answering.')
             end
      from public.agent_relay_events e where e.turn_id = v.id;
      update public.agent_relay_turns set status = 'error', lease_until = null where id = v.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

do $$
begin
  revoke execute on function public.agent_pairing_code_role(text) from public, anon, authenticated;
  grant execute on function public.agent_pairing_code_role(text) to service_role;
  revoke execute on function public.agent_relay_needs_mac(text, text[]) from public, anon, authenticated;
  grant execute on function public.agent_relay_needs_mac(text, text[]) to service_role;
  revoke execute on function public.agent_relay_claim(uuid, int, text) from public, anon, authenticated;
  grant execute on function public.agent_relay_claim(uuid, int, text) to service_role;
end $$;
