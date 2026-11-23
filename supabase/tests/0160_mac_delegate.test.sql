-- pgTAP: the phone controls the Mac (0160). The brain makes a sub-turn of the turn it holds; only a
-- Mac claims it; no Mac online closes it at once with "Your Mac is offline."; its confirm reaches the
-- parent's stream; nothing of it goes into the thread; the parent closing ends it.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(38);

delete from public.agent_routines;
delete from public.agent_threads;
delete from public.agent_devices;
delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

insert into public.agent_devices (id, name, key_hash, role)
values ('dddddddd-0000-0000-0000-00000000000a', 'Studio Mac', repeat('1', 64), 'mac'),
       ('dddddddd-0000-0000-0000-00000000000b', 'Hydra server', repeat('2', 64), 'brain');
insert into public.agent_threads (id, surface) values ('bbbbbbbb-0000-0000-0000-000000000001', 'phone');
insert into public.agent_relay_turns (id, thread_id, input, surface, context)
values ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"close Safari on my Mac"}', 'phone', '{"path":"/"}');

select has_column('public', 'agent_relay_turns', 'parent_turn_id', 'turns have a parent');
select has_column('public', 'agent_relay_turns', 'needs_mac', 'turns say whether they need the Mac');
select ok(not has_function_privilege('authenticated', 'public.agent_relay_subturn(uuid, uuid, uuid, text)', 'execute'), 'making a sub-turn is service role only');
select ok(not has_function_privilege('anon', 'public.agent_relay_subturn(uuid, uuid, uuid, text)', 'execute'), 'not for anon either');

-- The brain checks in and takes the phone turn.
set local role service_role;
select is((select claimed_by from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000b', 60, 'live')),
  'dddddddd-0000-0000-0000-00000000000b'::uuid, 'the brain takes the phone turn');
reset role;
create temp table c on commit drop as select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001';
grant select on c to service_role;

-- No Mac online: born closed, at once.
set local role service_role;
create temp table off on commit drop as
  select * from public.agent_relay_subturn('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b', (select claim_id from c), 'Quit Safari');
reset role;
select is((select outcome from off), 'mac_offline', 'no Mac online: mac_offline');
select is((select status from public.agent_relay_turns where id = (select id from off)), 'error', 'the sub-turn is closed at once');
select is((select event from public.agent_relay_events where turn_id = (select id from off)),
  '{"type":"error","code":"mac_offline","message":"Your Mac is offline."}'::jsonb, 'its one event: Your Mac is offline.');

-- The Mac checks in (nothing for it yet): now a sub-turn waits for it.
set local role service_role;
select is((select count(*)::int from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'live')), 0, 'the Mac checks in');
create temp table sub on commit drop as
  select * from public.agent_relay_subturn('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b', (select claim_id from c), '  Quit Safari  ');
reset role;
grant select on sub to service_role;
select is((select outcome from sub), 'queued', 'a Mac is online: queued');
select is((select row(t.parent_turn_id, t.needs_mac, t.allowed_tools, t.surface, t.thread_id, t.input->>'text', t.context->>'path')::text
           from public.agent_relay_turns t where t.id = (select id from sub)),
  row('cccccccc-0000-0000-0000-000000000001'::uuid, true, '{mac}'::text[], 'phone', 'bbbbbbbb-0000-0000-0000-000000000001'::uuid, 'Quit Safari', '/')::text,
  'the sub-turn: parent, needs_mac, Mac tools only, the parent''s surface, thread and context');

-- Only a Mac claims it; the brain never does.
set local role service_role;
select is((select count(*)::int from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000b', 60, 'live')), 0, 'the brain never claims a sub-turn');
select is((select id from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'live')), (select id from sub), 'the Mac claims it');
reset role;

-- Refusals.
set local role service_role;
select is((select outcome from public.agent_relay_subturn('cccccccc-0000-0000-0000-0000000000ff', 'dddddddd-0000-0000-0000-00000000000b', (select claim_id from c), 'x')),
  'not_found', 'an unknown parent');
select is((select outcome from public.agent_relay_subturn('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b', gen_random_uuid(), 'x')),
  'stale_claim', 'a claim that is not the parent''s');
select is((select outcome from public.agent_relay_subturn('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c), 'x')),
  'not_yours', 'a device that does not hold the parent');
select is((select outcome from public.agent_relay_subturn((select id from sub), 'dddddddd-0000-0000-0000-00000000000a',
  (select claim_id from public.agent_relay_turns where id = (select id from sub)), 'x')), 'not_brain', 'a Mac holding a turn does not make sub-turns');
select throws_ok($$ select * from public.agent_relay_subturn('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b', (select claim_id from c), '   ') $$,
  '22023', null, 'an empty instruction');
reset role;
select throws_ok($$ insert into public.agent_relay_turns (thread_id, input, surface, allowed_tools, parent_turn_id)
  values ('bbbbbbbb-0000-0000-0000-000000000001', '{"text":"x"}', 'phone', '{hydra}', 'cccccccc-0000-0000-0000-000000000001') $$,
  '23514', null, 'a sub-turn has Mac tools only');

-- The Mac asks; its confirm reaches the parent's stream with the real target, and the approval is in the parent's thread.
set local role service_role;
create temp table ask on commit drop as
  select * from public.agent_relay_approval((select id from sub), 'dddddddd-0000-0000-0000-00000000000a',
    (select claim_id from public.agent_relay_turns where id = (select id from sub)),
    'Quit Safari (2 windows, 9 tabs) on Studio Mac', true, now() + interval '15 minutes');
reset role;
grant select on ask to service_role;
select is((select thread_id from ask), 'bbbbbbbb-0000-0000-0000-000000000001'::uuid, 'the approval is in the parent''s thread');
set local role service_role;
select is(public.agent_relay_append((select id from sub), 'dddddddd-0000-0000-0000-00000000000a',
  (select claim_id from public.agent_relay_turns where id = (select id from sub)), 1,
  jsonb_build_array(jsonb_build_object('type', 'text', 'delta', 'Quitting Safari. '),
    jsonb_build_object('type', 'confirm', 'id', (select id from ask), 'summary', 'Quit Safari (2 windows, 9 tabs) on Studio Mac', 'danger', true)), 60),
  'claimed', 'the Mac posts text and its confirm');
reset role;
select is((select array_agg(event->>'type' order by seq) from public.agent_relay_events where turn_id = 'cccccccc-0000-0000-0000-000000000001'),
  array['confirm'], 'the parent''s stream gets the confirm and none of the sub-turn''s text');
select is((select event->>'summary' from public.agent_relay_events where turn_id = 'cccccccc-0000-0000-0000-000000000001'),
  'Quit Safari (2 windows, 9 tabs) on Studio Mac', 'with the real target');

-- The brain posts after that: its events follow in order.
set local role service_role;
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b', (select claim_id from c), 1,
  '[{"type":"text","delta":"Asking your Mac."}]'::jsonb, 60), 'claimed', 'the brain still posts to its turn');
-- The Mac finishes: nothing of the sub-turn goes into the thread.
select is(public.agent_relay_append((select id from sub), 'dddddddd-0000-0000-0000-00000000000a',
  (select claim_id from public.agent_relay_turns where id = (select id from sub)), 3,
  '[{"type":"text","delta":"Safari is closed."},{"type":"done"}]'::jsonb, 60), 'done', 'the Mac closes the sub-turn');
reset role;
select is((select array_agg(seq order by seq) from public.agent_relay_events where turn_id = 'cccccccc-0000-0000-0000-000000000001'),
  array[1, 2], 'the parent''s events stay in one order');
select is((select count(*)::int from public.agent_messages where thread_id = 'bbbbbbbb-0000-0000-0000-000000000001'), 0,
  'a closed sub-turn writes nothing into the thread');

-- A second sub-turn, still open with a pending ask, when the parent closes: both end.
set local role service_role;
create temp table sub2 on commit drop as
  select * from public.agent_relay_subturn('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b', (select claim_id from c), 'Empty the Trash');
select is((select id from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'live')), (select id from sub2), 'the Mac claims the second');
create temp table ask2 on commit drop as
  select * from public.agent_relay_approval((select id from sub2), 'dddddddd-0000-0000-0000-00000000000a',
    (select claim_id from public.agent_relay_turns where id = (select id from sub2)), 'Empty the Trash (41 items)', true, now() + interval '15 minutes');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b', (select claim_id from c), 2,
  '[{"type":"text","delta":"Done."},{"type":"done"}]'::jsonb, 60), 'done', 'the brain closes its turn');
reset role;
select is((select status from public.agent_relay_turns where id = (select id from sub2)), 'expired', 'the open sub-turn ends with its parent');
select is((select status from public.agent_approvals where id = (select id from ask2)), 'expired', 'and its pending ask ends');
select is((select array_agg(x order by x) from (select role || ':' || (content->0->>'text') as x from public.agent_messages where thread_id = 'bbbbbbbb-0000-0000-0000-000000000001') m),
  array['assistant:Asking your Mac.Done.', 'user:close Safari on my Mac'], 'the thread has the owner''s words and the brain''s reply only');

-- A lapsed lease makes no sub-turn; the sweep putting the parent back in the queue ends its open sub-turns
-- (the next claim replays the turn and asks again: the old one must not also run on the Mac).
insert into public.agent_relay_turns (id, thread_id, input, surface, context)
values ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"open Notes"}', 'phone', '{}');
set local role service_role;
select is((select id from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000b', 60, 'live')),
  'cccccccc-0000-0000-0000-000000000002'::uuid, 'the brain takes a second phone turn');
reset role;
create temp table c2 on commit drop as select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000002';
grant select on c2 to service_role;
set local role service_role;
create temp table sub3 on commit drop as
  select * from public.agent_relay_subturn('cccccccc-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-00000000000b', (select claim_id from c2), 'Open Notes');
reset role;
grant select on sub3 to service_role;
select is((select status from public.agent_relay_turns where id = (select id from sub3)), 'queued', 'its sub-turn waits for the Mac');
update public.agent_relay_turns set lease_until = now() - interval '1 second' where id = 'cccccccc-0000-0000-0000-000000000002';
set local role service_role;
select is((select outcome from public.agent_relay_subturn('cccccccc-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-00000000000b', (select claim_id from c2), 'Open Notes')),
  'stale_claim', 'a lapsed lease makes no sub-turn');
select is(public.agent_relay_sweep() >= 1, true, 'the sweep takes the lapsed turn');
reset role;
select is((select status from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000002'), 'queued', 'the parent is back in the queue');
select is((select status from public.agent_relay_turns where id = (select id from sub3)), 'expired', 'and its open sub-turn ends: the Mac never runs it');

select * from finish();
rollback;
