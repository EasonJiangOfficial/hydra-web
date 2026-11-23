-- pgTAP: the server brain (0121). A device's role is 'mac' by default and 'brain' only through a
-- Server pairing code; nobody changes it after. While a brain is online, live and routine turns go
-- only to brains; a Mac gets them only when no brain is online (stale, revoked or none).
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(34);

delete from public.agent_routines;
delete from public.agent_threads;
delete from public.agent_devices;
delete from public.agent_pairing_codes;
delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

-- The owner makes a Mac code and a Server code (his session, as /api/agent/devices/pair does).
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.agent_pairing_codes (code_hash, expires_at) values (repeat('a', 64), now() + interval '5 minutes');
insert into public.agent_pairing_codes (code_hash, expires_at, name, role) values (repeat('b', 64), now() + interval '5 minutes', 'Hydra server', 'brain');
select is((select role from public.agent_pairing_codes where code_hash = repeat('a', 64)), 'mac', 'a code is for a Mac by default');
select throws_ok(
  $$ insert into public.agent_pairing_codes (code_hash, expires_at, role) values (repeat('c', 64), now() + interval '5 minutes', 'root') $$,
  '23514', null, 'a role is mac or brain'
);
select throws_ok(
  $$ insert into public.agent_pairing_codes (code_hash, expires_at, role, scopes) values (repeat('c', 64), now() + interval '5 minutes', 'brain', '{mcp}') $$,
  '23514', null, 'a brain code must carry the relay scope'
);
reset role;

-- The server trades its code: the device is a brain with agent, mcp and relay.
set local role service_role;
-- F10: the exchange reads a code's role first, so Hydra Desktop can refuse a Server code unused.
select is(public.agent_pairing_code_role(repeat('b', 64)), 'brain', 'a live Server code reads as brain');
select isnt(public.agent_pair_exchange(repeat('a', 64), repeat('1', 64), 'Studio Mac'), null, 'the Mac code becomes a device');
select isnt(public.agent_pair_exchange(repeat('b', 64), repeat('2', 64), 'Hydra server'), null, 'the Server code becomes a device');
select is(public.agent_pairing_code_role(repeat('b', 64)), null, 'a used code has no role');
reset role;
select ok(not has_function_privilege('authenticated', 'public.agent_pairing_code_role(text)', 'execute'), 'reading a code role is service role only');
select is((select role from public.agent_devices where key_hash = repeat('1', 64)), 'mac', 'the Mac code makes a Mac');
select is((select role || ':' || array_to_string(scopes, ',') from public.agent_devices where key_hash = repeat('2', 64)),
  'brain:agent,mcp,relay', 'the Server code makes a brain with agent, mcp and relay');

-- The role never changes after pairing: not by the owner, not by the service role.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select throws_ok($$ update public.agent_devices set role = 'brain' where key_hash = repeat('1', 64) $$,
  '42501', null, 'the owner cannot turn a Mac into the brain');
select throws_ok($$ insert into public.agent_devices (name, key_hash, role) values ('x', repeat('9', 64), 'brain') $$,
  '42501', null, 'the owner cannot insert a device');
update public.agent_devices set name = 'Studio Mac 2' where key_hash = repeat('1', 64);
select is((select name from public.agent_devices where key_hash = repeat('1', 64)), 'Studio Mac 2', 'renaming still works');
reset role;
set local role service_role;
select throws_ok($$ update public.agent_devices set role = 'mac' where key_hash = repeat('2', 64) $$,
  '42501', null, 'not even the service role changes a role');
reset role;

-- Routing. Fixed ids for the two devices, a thread and two turns (one live, one routine-slot-free).
update public.agent_devices set relay_seen_at = null;
create temp table dev on commit drop as
  select (select id from public.agent_devices where key_hash = repeat('1', 64)) as mac,
         (select id from public.agent_devices where key_hash = repeat('2', 64)) as brain;
grant select on dev to service_role;
insert into public.agent_threads (id, surface) values ('bbbbbbbb-0000-0000-0000-000000000001', 'web');
insert into public.agent_relay_turns (id, thread_id, input, surface, context)
values ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"one"}', 'web', '{}'),
       ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"two"}', 'phone', '{}');
update public.agent_relay_turns set created_at = now() - interval '1 minute' where id = 'cccccccc-0000-0000-0000-000000000001';

set local role service_role;
-- The brain checks in with nothing for its routine slot: it is now online.
select is((select count(*)::int from public.agent_relay_claim((select brain from dev), 60, 'routine')), 0, 'the brain checks in (nothing on its routine slot)');
select is((select count(*)::int from public.agent_relay_claim((select mac from dev), 60, 'live')), 0, 'a brain is online: the Mac gets no turn');
select is((select status from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), 'queued', 'the turn waits for the brain');
select ok((select relay_seen_at is not null from public.agent_devices where id = (select mac from dev)), 'the refused Mac still counts as seen (the fallback)');
select is((select claimed_by from public.agent_relay_claim((select brain from dev), 60, 'live')), (select brain from dev), 'the brain takes the turn');
reset role;

-- The brain goes quiet (46 s): the Mac takes the next turn.
update public.agent_devices set relay_seen_at = now() - interval '46 seconds' where id = (select brain from dev);
set local role service_role;
select is((select id from public.agent_relay_claim((select mac from dev), 60, 'live')), 'cccccccc-0000-0000-0000-000000000002'::uuid,
  'the brain is offline: the Mac takes the turn');
reset role;

-- A revoked brain never holds turns back, however fresh its last contact.
insert into public.agent_relay_turns (id, thread_id, input, surface, context)
values ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"three"}', 'web', '{}');
update public.agent_devices set relay_seen_at = now(), revoked_at = now() where id = (select brain from dev);
set local role service_role;
select is((select id from public.agent_relay_claim((select mac from dev), 60, 'live')), 'cccccccc-0000-0000-0000-000000000003'::uuid,
  'a revoked brain does not count');
reset role;

-- Routine turns follow the same rule.
update public.agent_devices set revoked_at = null, relay_seen_at = now() where id = (select brain from dev);
insert into public.agent_relay_turns (id, thread_id, input, surface, context)
values ('cccccccc-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"four"}', 'routine', '{}');
set local role service_role;
select is((select count(*)::int from public.agent_relay_claim((select mac from dev), 60, 'routine')), 0, 'a brain is online: the Mac gets no routine turn');
select is((select id from public.agent_relay_claim((select brain from dev), 60, 'routine')), 'cccccccc-0000-0000-0000-000000000004'::uuid,
  'the brain takes the routine turn');
reset role;

-- A turn that needs the Mac goes only to a Mac, even while the brain is online (F3, F4): one typed in
-- Hydra Desktop (surface desktop) and a routine with Mac tools. The brain skips them for the next one.
insert into public.agent_relay_turns (id, thread_id, input, surface, context, allowed_tools, created_at)
values ('cccccccc-0000-0000-0000-000000000005', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"open Safari"}', 'desktop', '{}', null, now() - interval '3 minutes'),
       ('cccccccc-0000-0000-0000-000000000006', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"screenshot my dock"}', 'routine', '{}', '{mac}', now() - interval '2 minutes'),
       ('cccccccc-0000-0000-0000-000000000007', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"mail"}', 'routine', '{}', '{gmail}', now() - interval '1 minute'),
       ('cccccccc-0000-0000-0000-000000000008', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"spend"}', 'web', '{}', null, now());
set local role service_role;
select is((select id from public.agent_relay_claim((select brain from dev), 60, 'live')), 'cccccccc-0000-0000-0000-000000000008'::uuid,
  'the brain skips a turn typed in Hydra Desktop');
select is((select id from public.agent_relay_claim((select brain from dev), 60, 'routine')), 'cccccccc-0000-0000-0000-000000000007'::uuid,
  'the brain skips a routine with Mac tools');
select is((select id from public.agent_relay_claim((select mac from dev), 60, 'live')), 'cccccccc-0000-0000-0000-000000000005'::uuid,
  'the brain is online: the Mac still takes the turn typed in Hydra Desktop');
select is((select id from public.agent_relay_claim((select mac from dev), 60, 'routine')), 'cccccccc-0000-0000-0000-000000000006'::uuid,
  'the brain is online: the Mac still takes the routine with Mac tools');
reset role;

-- No Mac online: a turn that needs the Mac waits; the brain never takes it.
insert into public.agent_relay_turns (id, thread_id, input, surface, context)
values ('cccccccc-0000-0000-0000-000000000009', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"open Mail"}', 'desktop', '{}');
update public.agent_devices set relay_seen_at = now() - interval '1 hour' where id = (select mac from dev);
set local role service_role;
select is((select count(*)::int from public.agent_relay_claim((select brain from dev), 60, null)), 0, 'the brain never takes a turn that needs the Mac');
reset role;
select is((select status from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000009'), 'queued', 'it waits for a Mac');

-- A lapsed turn ends worded for who held it (F9): the brain's in Hydra's words, the Mac's as before.
update public.agent_relay_turns set attempts = 2, lease_until = now() - interval '1 second'
where id in ('cccccccc-0000-0000-0000-000000000008', 'cccccccc-0000-0000-0000-000000000005');
set local role service_role;
select is(public.agent_relay_sweep(), 2, 'the sweep ends both lapsed turns');
reset role;
select is((select event from public.agent_relay_events where turn_id = 'cccccccc-0000-0000-0000-000000000008' order by seq desc limit 1),
  '{"type":"error","code":"brain_failed","message":"Hydra stopped answering."}'::jsonb, 'the brain went quiet: Hydra stopped answering');
select is((select event from public.agent_relay_events where turn_id = 'cccccccc-0000-0000-0000-000000000005' order by seq desc limit 1),
  '{"type":"error","code":"mac_failed","message":"Your Mac stopped answering."}'::jsonb, 'the Mac went quiet: your Mac stopped answering');

select ok(not has_function_privilege('authenticated', 'private.agent_device_role_fixed()', 'execute'), 'the role trigger function is not callable');
select ok(not has_function_privilege('authenticated', 'public.agent_relay_claim(uuid, int, text)', 'execute'), 'claiming stays service role only');

select * from finish();
rollback;
