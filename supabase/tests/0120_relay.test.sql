-- pgTAP: the Mac relay (0120). Owner-only RLS, explicit grants, hydra_ro reads, the brain setting,
-- the relay device scope, one device wins a claim under a fresh claim id, a stale claim is refused,
-- seq dedupes a retried post, events go in order and close the turn into the thread, slots, a lapsed
-- lease re-queues once then fails, closing a turn ends its approvals and keeps the owner's words,
-- relay approvals (made only while the claim holds the turn open), a routine's turn follows its run,
-- Macs paired before 0120 gain the relay scope.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(82);

delete from public.agent_routines;
delete from public.agent_threads;
delete from public.agent_devices;
delete from public.agent_pairing_codes;
delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relname in ('agent_relay_turns', 'agent_relay_events')),
  2, 'both relay tables exist with RLS on'
);

-- Devices: the relay scope is valid; a new pairing hands out agent, mcp and relay.
insert into public.agent_devices (id, name, key_hash, scopes)
values
  ('dddddddd-0000-0000-0000-00000000000a', 'Mac A', repeat('a', 64), '{agent,mcp,relay}'),
  ('dddddddd-0000-0000-0000-00000000000b', 'Mac B', repeat('b', 64), '{relay}');
select throws_ok(
  $$ insert into public.agent_devices (name, key_hash, scopes) values ('x', repeat('c', 64), '{root}') $$,
  '23514', null, 'an unknown device scope is refused'
);
insert into public.agent_pairing_codes (code_hash, expires_at) values (repeat('e', 64), now() + interval '5 minutes');
select is((select scopes from public.agent_pairing_codes where code_hash = repeat('e', 64)), '{agent,mcp,relay}'::text[], 'pairing defaults to agent, mcp, relay');
set local role service_role;
select isnt(public.agent_pair_exchange(repeat('e', 64), repeat('f', 64), 'Mac C'), null, 'the code becomes a device');
reset role;
select is((select scopes from public.agent_devices where key_hash = repeat('f', 64)), '{agent,mcp,relay}'::text[], 'the paired Mac holds the relay scope');

-- Macs paired before 0120 hold agent and mcp only: every live one gains relay, once.
insert into public.agent_devices (name, key_hash, scopes, revoked_at)
values ('Old Mac', repeat('1', 64), '{agent,mcp}', null),
       ('Old MCP client', repeat('2', 64), '{mcp}', null),
       ('Revoked Mac', repeat('3', 64), '{agent}', now());
select is(private.agent_relay_backfill_scopes(), 2, 'two live devices without relay gain it');
select is((select scopes from public.agent_devices where key_hash = repeat('1', 64)), '{agent,mcp,relay}'::text[], 'an old Mac now holds relay');
select is((select scopes from public.agent_devices where key_hash = repeat('2', 64)), '{mcp,relay}'::text[], 'an mcp-only device too');
select is((select scopes from public.agent_devices where key_hash = repeat('3', 64)), '{agent}'::text[], 'a revoked device is left alone');
select is(private.agent_relay_backfill_scopes(), 0, 'running it again changes nothing');

-- anon holds nothing.
set local role anon;
select throws_ok($$ select * from public.agent_relay_turns $$, '42501', null, 'anon cannot read relay turns');
select throws_ok($$ select * from public.agent_relay_events $$, '42501', null, 'anon cannot read relay events');
reset role;

-- The owner: the brain setting and a relay turn.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.agent_settings (user_id) values ('11111111-1111-1111-1111-111111111111');
select is((select brain from public.agent_settings), 'mac', 'the brain is the Mac by default');
select throws_ok($$ update public.agent_settings set brain = 'cloud' $$, '23514', null, 'brain is mac or server');
update public.agent_settings set brain = 'server';
select is((select brain from public.agent_settings), 'server', 'the owner can switch the brain');
insert into public.agent_threads (id, surface) values ('bbbbbbbb-0000-0000-0000-000000000001', 'web');
insert into public.agent_relay_turns (id, thread_id, input, surface, context)
values ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"What did I spend today?"}', 'web',
        '{"path":"/","search":"","scope":"all"}');
select is((select owner from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'),
  '11111111-1111-1111-1111-111111111111'::uuid, 'the owner column fills itself');
select is((select status || ':' || coalesce(claim_id::text, '-') from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'),
  'queued:-', 'a new turn is queued with no claim');
select throws_ok(
  $$ insert into public.agent_relay_turns (thread_id, input, surface) values ('bbbbbbbb-0000-0000-0000-000000000001', '{"text":"x"}', 'mcp') $$,
  '23514', null, 'an MCP surface never queues a relay turn'
);
select throws_ok(
  $$ insert into public.agent_relay_turns (thread_id, input, surface, allowed_tools) values ('bbbbbbbb-0000-0000-0000-000000000001', '{"text":"x"}', 'routine', '{shell}') $$,
  '23514', null, 'allowed tools are hydra, mac, gmail, calendar'
);
select throws_ok(
  $$ select * from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'live') $$,
  '42501', null, 'the owner session cannot claim (service role only)'
);
select throws_ok(
  $$ select public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', gen_random_uuid(), null, '[]', 60) $$,
  '42501', null, 'the owner session cannot post events (service role only)'
);
select is(public.agent_relay_sweep(), 0, 'the owner session may sweep lapsed leases');
select throws_ok(
  $$ select * from public.agent_relay_approval('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', gen_random_uuid(), 'x', true, now()) $$,
  '42501', null, 'the owner session cannot make relay approvals (service role only)'
);
reset role;

-- A stranger sees nothing and writes nothing.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.agent_relay_turns), 0, 'a stranger sees no relay turns');
select throws_ok(
  $$ insert into public.agent_relay_turns (thread_id, input, surface) values ('bbbbbbbb-0000-0000-0000-000000000001', '{"text":"x"}', 'web') $$,
  '42501', null, 'a stranger cannot queue a turn'
);
select throws_ok($$ select public.agent_relay_sweep() $$, '42501', null, 'a stranger cannot sweep');
reset role;

-- Two Macs ask at once: one wins under a fresh claim id, the other gets nothing.
set local role service_role;
select throws_ok($$ select * from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'both') $$, '22023', null, 'a slot is live or routine');
select is((select count(*)::int from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'routine')), 0, 'the routine slot never takes a live turn');
select is((select claimed_by from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'live')),
  'dddddddd-0000-0000-0000-00000000000a'::uuid, 'Mac A claims the turn on its live slot');
select isnt((select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), null, 'the claim has an id');
select ok((select relay_seen_at > now() - interval '5 seconds' from public.agent_devices where id = 'dddddddd-0000-0000-0000-00000000000a'),
  'claiming counts as the relay loop being seen');
select is((select relay_seen_at from public.agent_devices where id = 'dddddddd-0000-0000-0000-00000000000b'), null, 'Mac B has not run its relay loop');
select is((select count(*)::int from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000b', 60)), 0, 'Mac B gets nothing');
select is((select attempts from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), 1, 'one attempt');

-- Events: only the holder's claim posts; seq dedupes; they go in order; done closes the turn into the thread.
create temp table c1 on commit drop as select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001';
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', gen_random_uuid(), null, '[{"type":"text","delta":"x"}]', 60),
  'stale_claim', 'a post under another claim id is refused');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b', (select claim_id from c1), null, '[{"type":"text","delta":"x"}]', 60),
  'not_yours', 'another device cannot post to the turn');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c1), 1,
  '[{"type":"text","delta":"You spent "},{"type":"tool","name":"list_transactions","status":"done","summary":"3 rows"}]', 60),
  'claimed', 'a batch is stored, the turn stays open');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c1), 1,
  '[{"type":"text","delta":"You spent "},{"type":"tool","name":"list_transactions","status":"done","summary":"3 rows"}]', 60),
  'claimed', 'the same post retried is accepted');
select is((select count(*)::int from public.agent_relay_events where turn_id = 'cccccccc-0000-0000-0000-000000000001'), 2, 'and stored once');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c1), 5, '[{"type":"text","delta":"?"}]', 60),
  'seq_gap', 'a jump in seq is refused');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c1), 3,
  '[{"type":"text","delta":"$42."},{"type":"done","usage":{}}]', 60),
  'done', 'done closes the turn');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c1), 3,
  '[{"type":"text","delta":"$42."},{"type":"done","usage":{}}]', 60),
  'done', 'a replayed closing post answers the status');
select is((select array_agg(event->>'type' order by seq) from public.agent_relay_events where turn_id = 'cccccccc-0000-0000-0000-000000000001'),
  '{text,tool,text,done}'::text[], 'events keep their order across batches, no duplicates');
select is((select array_agg(seq order by seq) from public.agent_relay_events where turn_id = 'cccccccc-0000-0000-0000-000000000001'),
  '{1,2,3,4}'::int[], 'seq counts from 1 without gaps');
select is((select status from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), 'done', 'the turn is done');
select is(
  (select array_agg(role || ':' || (content->0->>'text') order by created_at) from public.agent_messages where thread_id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  '{"user:What did I spend today?","assistant:You spent $42."}'::text[], 'the thread holds the words and the reply'
);
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c1), null, '[{"type":"text","delta":"late"}]', 60),
  'stale_claim', 'nothing posts after the end');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c1), 5, '[]', 60),
  'stale_claim', 'not even a heartbeat');
select throws_ok(
  $$ insert into public.agent_relay_events (turn_id, seq, event) values ('cccccccc-0000-0000-0000-000000000001', 4, '{"type":"text"}') $$,
  '23505', null, 'a seq is used once per turn'
);
reset role;

-- A lease that lapses: back to the queue once (the old claim dies), then the turn fails with an error event.
insert into public.agent_relay_turns (id, thread_id, input, surface)
values ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', '{"audioTranscript":"remind me"}', 'phone');
set local role service_role;
select is((select id from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'live')), 'cccccccc-0000-0000-0000-000000000002'::uuid, 'claimed');
create temp table c2 on commit drop as select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000002';
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c2), null, '[{"type":"text","delta":"FIRST "}]', 60),
  'claimed', 'the first run posts');
update public.agent_relay_turns set lease_until = now() - interval '1 second' where id = 'cccccccc-0000-0000-0000-000000000002';
select is(public.agent_relay_sweep(), 1, 'the lapsed lease is swept');
select is((select status || ':' || coalesce(claimed_by::text, '-') || ':' || coalesce(claim_id::text, '-') from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000002'),
  'queued:-:-', 'the first lapse re-queues the turn and drops its claim');
select is((select claimed_by from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'live')), 'dddddddd-0000-0000-0000-00000000000a'::uuid, 'the same Mac takes it again');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c2), null, '[{"type":"text","delta":"OLD "}]', 60),
  'stale_claim', 'the old run of the same Mac cannot post on top of the new one');
update public.agent_relay_turns set lease_until = now() - interval '1 second' where id = 'cccccccc-0000-0000-0000-000000000002';
select is((select count(*)::int from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60)), 0, 'the second lapse is not re-queued');
select is((select status from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000002'), 'error', 'it fails');
select is((select event->>'code' from public.agent_relay_events where turn_id = 'cccccccc-0000-0000-0000-000000000002' order by seq desc limit 1),
  'mac_failed', 'with an error event every reader sees');
select ok(exists (select 1 from public.agent_messages where thread_id = 'bbbbbbbb-0000-0000-0000-000000000001' and role = 'user' and content->0->>'text' = 'remind me'),
  'a failed turn still keeps the owner''s words');
reset role;

-- A live turn with a relay approval, expired by the web's 280 s timeout: its asks end, the words stay.
insert into public.agent_threads (id, surface) values ('bbbbbbbb-0000-0000-0000-000000000003', 'phone');
insert into public.agent_relay_turns (id, thread_id, input, surface)
values ('cccccccc-0000-0000-0000-000000000005', 'bbbbbbbb-0000-0000-0000-000000000003', '{"text":"Email Nike"}', 'phone');
set local role service_role;
select is((select id from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'live')), 'cccccccc-0000-0000-0000-000000000005'::uuid, 'the phone turn is claimed');
create temp table c5 on commit drop as select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000005';
select is((select count(*)::int from public.agent_relay_approval('cccccccc-0000-0000-0000-000000000005', 'dddddddd-0000-0000-0000-00000000000a',
  gen_random_uuid(), 'Pay', true, now() + interval '15 minutes')), 0, 'a stale claim makes no approval');
select is((select count(*)::int from public.agent_relay_approval('cccccccc-0000-0000-0000-000000000005', 'dddddddd-0000-0000-0000-00000000000b',
  (select claim_id from c5), 'Pay', true, now() + interval '15 minutes')), 0, 'another device makes none');
create temp table ap on commit drop as select * from public.agent_relay_approval('cccccccc-0000-0000-0000-000000000005',
  'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c5), 'Reply to Nike', true, now() + interval '15 minutes');
select is((select source || ':' || relay_turn_id::text || ':' || thread_id::text || ':' || status from ap),
  'relay:cccccccc-0000-0000-0000-000000000005:bbbbbbbb-0000-0000-0000-000000000003:pending', 'the claim holder''s ask becomes a pending relay approval of its turn');
select lives_ok(
  $$ insert into public.agent_approvals (id, source, thread_id, device_id, relay_turn_id, tool, summary, reason, expires_at)
     values ('ffffffff-0000-0000-0000-000000000002', 'relay', 'bbbbbbbb-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-00000000000a',
             'cccccccc-0000-0000-0000-000000000005', 'relay', 'Send the invoice to Nike', 'mac', now() + interval '15 minutes'),
            ('ffffffff-0000-0000-0000-000000000003', 'relay', 'bbbbbbbb-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-00000000000a',
             'cccccccc-0000-0000-0000-000000000005', 'relay', 'Trash the old thread', 'mac', now() + interval '15 minutes') $$,
  'a relay approval is a valid approval'
);
update public.agent_approvals set status = 'approved' where id = 'ffffffff-0000-0000-0000-000000000003';
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
update public.agent_relay_turns set status = 'expired', lease_until = null where id = 'cccccccc-0000-0000-0000-000000000005' and status in ('queued', 'claimed');
select is((select status from public.agent_approvals where id = 'ffffffff-0000-0000-0000-000000000002'), 'expired', 'an unanswered ask ends with its turn');
select is((select status from public.agent_approvals where id = 'ffffffff-0000-0000-0000-000000000003'), 'done', 'an approved relay ask was handed to the Mac');
reset role;
set local role service_role;
select is((select a.status from public.agent_approvals a join ap on ap.id = a.id), 'expired', 'the ask the function made ends with its turn too');
select is((select count(*)::int from public.agent_relay_approval('cccccccc-0000-0000-0000-000000000005', 'dddddddd-0000-0000-0000-00000000000a',
  (select claim_id from c5), 'One more', true, now() + interval '15 minutes')), 0, 'a closed turn makes no new approval');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select array_agg(role || ':' || (content->0->>'text')) from public.agent_messages where thread_id = 'bbbbbbbb-0000-0000-0000-000000000003'),
  '{"user:Email Nike"}'::text[], 'a timed-out turn keeps the owner''s words');
reset role;

-- A routine's turn: a turn whose run is no longer live is expired; claiming one starts its run; a confirm joins the run for a day.
insert into public.agent_routines (id, name, instruction, schedule) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Brand mail', 'Check mail', '{"kind":"daily","time":"08:00"}');
insert into public.agent_routine_runs (id, routine_id, occurrence_at, status)
values ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', now(), 'skipped'),
       ('eeeeeeee-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', now() + interval '1 day', 'waiting_mac');
insert into public.agent_threads (id, surface) values ('bbbbbbbb-0000-0000-0000-000000000002', 'routine');
insert into public.agent_relay_turns (id, thread_id, input, surface, routine_run_id, allowed_tools)
values ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002', '{"text":"run"}', 'routine', 'eeeeeeee-0000-0000-0000-000000000001', '{hydra}'),
       ('cccccccc-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000002', '{"text":"run"}', 'routine', 'eeeeeeee-0000-0000-0000-000000000002', '{hydra,gmail}');
insert into public.agent_approvals (id, source, device_id, tool, summary, reason, expires_at)
values ('ffffffff-0000-0000-0000-000000000001', 'mcp', 'dddddddd-0000-0000-0000-00000000000a', 'gmail_send', 'Send a reply', 'send', now() + interval '15 minutes');
set local role service_role;
select is((select count(*)::int from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'live')), 0, 'the live slot never takes a routine turn');
select is((select id from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'routine')), 'cccccccc-0000-0000-0000-000000000004'::uuid,
  'the routine slot takes the live run''s turn');
select is((select status from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000003'), 'expired', 'a turn whose run was skipped is expired, never run');
select is((select status from public.agent_routine_runs where id = 'eeeeeeee-0000-0000-0000-000000000002'), 'running', 'claiming a waiting run starts it');
create temp table c4 on commit drop as select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000004';
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000004', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c4), null,
  '[{"type":"confirm","id":"ffffffff-0000-0000-0000-000000000001","summary":"Send a reply","danger":true}]', 60), 'claimed', 'a confirm is posted');
select is((select run_id::text || ':' || relay_turn_id::text from public.agent_approvals where id = 'ffffffff-0000-0000-0000-000000000001'),
  'eeeeeeee-0000-0000-0000-000000000002:cccccccc-0000-0000-0000-000000000004', 'the approval joins the routine run and its turn');
select ok((select expires_at > now() + interval '23 hours' from public.agent_approvals where id = 'ffffffff-0000-0000-0000-000000000001'),
  'a routine''s ask waits a day');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000004', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c4), null, '[]', 60),
  'claimed', 'the heartbeat keeps the routine turn while it waits');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000004', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from c4), null, '[{"type":"done"}]', 60),
  'done', 'the routine turn ends');
select is((select status from public.agent_approvals where id = 'ffffffff-0000-0000-0000-000000000001'), 'expired', 'its unused ask ends with it');
reset role;

-- hydra_ro reads the relay; grants are explicit.
grant hydra_ro to postgres with set true;
create temp table ro_out (k text primary key, v text) on commit drop;
grant all on ro_out to hydra_ro;
set local role hydra_ro;
insert into ro_out select 'turns', count(*)::text from public.agent_relay_turns;
reset role;
select is((select v from ro_out where k = 'turns'), '5', 'hydra_ro reads relay turns');
select ok(not has_table_privilege('hydra_ro', 'public.agent_relay_events', 'insert'), 'hydra_ro cannot write events');
select ok(not has_function_privilege('authenticated', 'private.agent_relay_closed()', 'execute'), 'the close trigger function is not callable');

select * from finish();
rollback;
