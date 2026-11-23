-- pgTAP: add-on while thinking (0191). The owner adds words to a relay turn in flight or to a server-loop
-- turn holding its thread lease; a finished turn or a lapsed lease takes none (null). Inputs number 1, 2, ...
-- per turn. The device holding the claim gets the ones it has not acknowledged; a new claim starts over.
-- Closing the turn writes the owner's words and his additions into the thread as one message.
-- Owner-only RLS, anon and strangers refused, the ack is the service role's.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(75);

delete from public.agent_threads;
delete from public.agent_devices;
delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');
insert into public.agent_devices (id, name, key_hash, scopes)
values ('dddddddd-0000-0000-0000-00000000000a', 'Mac A', repeat('a', 64), '{agent,mcp,relay}'),
       ('dddddddd-0000-0000-0000-00000000000b', 'Mac B', repeat('b', 64), '{agent,mcp,relay}');

select is(
  (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'agent_relay_inputs'),
  true, 'agent_relay_inputs exists with RLS on'
);

-- The owner's turn, queued for the brain.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.agent_threads (id, surface) values ('bbbbbbbb-0000-0000-0000-000000000001', 'web'), ('bbbbbbbb-0000-0000-0000-000000000002', 'phone');
insert into public.agent_relay_turns (id, thread_id, input, surface, context)
values ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', '{"audioTranscript":"What did I spend today?"}', 'web',
        '{"path":"/","search":"","scope":"all"}');
select is(public.agent_turn_append('cccccccc-0000-0000-0000-000000000001', 'and on food'), null,
  'a queued turn takes none: no device has shown it reads additions (the client asks again after the turn)');
select throws_ok($$ select public.agent_turn_append('cccccccc-0000-0000-0000-000000000001', '   ') $$, '22023', null, 'empty words are refused');
select throws_ok($$ select public.agent_turn_append('cccccccc-0000-0000-0000-000000000001', repeat('x', 8001)) $$, '22023', null, 'over 8000 characters is refused');
select is(public.agent_turn_append('eeeeeeee-0000-0000-0000-000000000009', 'hello'), null, 'an unknown turn takes nothing');
select throws_ok(
  $$ update public.agent_relay_inputs set text = 'changed' $$, '42501', null, 'nobody edits an input'
);
select throws_ok(
  $$ insert into public.agent_relay_inputs (turn_id, seq, text) values ('eeeeeeee-0000-0000-0000-000000000009', 1, 'planted') $$,
  '42501', null, 'the owner adds only through agent_turn_append, never a direct insert (no finished or unknown turn takes one)'
);
reset role;

-- Mac A claims it. Until its claim acknowledges (inputsSeen, even 0), it may be an older Mac that never reads them.
set local role service_role;
select is((select claimed_by from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'live')),
  'dddddddd-0000-0000-0000-00000000000a'::uuid, 'Mac A claims the turn');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(public.agent_turn_append('cccccccc-0000-0000-0000-000000000001', 'and on food'), null, 'a claim that never acknowledged takes none');
reset role;
set local role service_role;
select is(
  (select count(*)::int from public.agent_relay_inputs_ack('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a',
    (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), 0)),
  0, 'Mac A says it reads additions (inputsSeen 0): none yet'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(public.agent_turn_append('cccccccc-0000-0000-0000-000000000001', '  and on food  '), 1, 'now the turn takes an addition: seq 1');
select is((select text from public.agent_relay_inputs where seq = 1), 'and on food', 'stored trimmed');
reset role;
set local role service_role;
select is(
  (select array_agg(input_seq || ':' || input_text) from public.agent_relay_inputs_ack('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a',
    (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), null)),
  array['1:and on food'], 'the next events answer carries the addition'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(public.agent_turn_append('cccccccc-0000-0000-0000-000000000001', 'and gas'), 2, 'a claimed turn takes another: seq 2');
reset role;
set local role service_role;
select is(
  (select array_agg(input_seq || ':' || input_text) from public.agent_relay_inputs_ack('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a',
    (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), 1)),
  array['2:and gas'], 'inputsSeen 1: only the newer one'
);
select is(
  (select count(*)::int from public.agent_relay_inputs_ack('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a',
    (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), 2)),
  0, 'inputsSeen 2: nothing left'
);
select is(
  (select count(*)::int from public.agent_relay_inputs_ack('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a',
    (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), 0)),
  0, 'an older inputsSeen never goes back'
);
select is(
  (select count(*)::int from public.agent_relay_inputs_ack('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b',
    (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), 0)),
  0, 'another device gets nothing'
);
select is(
  (select count(*)::int from public.agent_relay_inputs_ack('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000a', gen_random_uuid(), 0)),
  0, 'a stale claim gets nothing'
);
-- The lease lapses and Mac B takes it again: a new claim starts with none acknowledged.
update public.agent_relay_turns set lease_until = now() - interval '1 second' where id = 'cccccccc-0000-0000-0000-000000000001';
select is((select claimed_by from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000b', 60, 'live')),
  'dddddddd-0000-0000-0000-00000000000b'::uuid, 'Mac B claims the re-queued turn');
select is(
  (select array_agg(input_seq order by input_seq) from public.agent_relay_inputs_ack('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b',
    (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), null)),
  array[1, 2], 'the new claim gets every addition'
);
-- Mac B answers and closes the turn; its done post says it read both (inputsSeen 2, acknowledged first by the route).
select is(
  (select count(*)::int from public.agent_relay_inputs_ack('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b',
    (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), 2)),
  0, 'Mac B has read both'
);
select is(
  public.agent_relay_append('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-00000000000b',
    (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000001'), 1,
    '[{"type":"text","delta":"$42 today, $18 on food and $20 on gas."},{"type":"done"}]'::jsonb),
  'done', 'Mac B closes the turn'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(
  (select content->0->>'text' from public.agent_messages where thread_id = 'bbbbbbbb-0000-0000-0000-000000000001' and role = 'user'),
  E'What did I spend today?\nand on food\nand gas', 'the thread keeps his words and his additions as one message'
);
select is(public.agent_turn_append('cccccccc-0000-0000-0000-000000000001', 'too late'), null, 'a closed turn takes nothing');

-- A done that arrives while an addition waits unread is held (never stored as asked with nothing answering it).
insert into public.agent_relay_turns (id, thread_id, input, surface, context)
values ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', '{"text":"And this week?"}', 'web',
        '{"path":"/","search":"","scope":"all"}');
reset role;
set local role service_role;
select is((select claimed_by from public.agent_relay_claim('dddddddd-0000-0000-0000-00000000000a', 60, 'live')),
  'dddddddd-0000-0000-0000-00000000000a'::uuid, 'Mac A claims the second turn');
select is((select count(*)::int from public.agent_relay_inputs_ack('cccccccc-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000002'), 0)),
  0, 'Mac A reads additions (inputsSeen 0)');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(public.agent_turn_append('cccccccc-0000-0000-0000-000000000002', 'and gas'), 1, 'added just before the Mac says done');
reset role;
set local role service_role;
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000002'), 1,
    '[{"type":"text","delta":"$90."},{"type":"done"}]'::jsonb),
  'claimed', 'the done is held: an addition waits that the Mac never read');
select is((select status || ':' || (select count(*) from public.agent_relay_events e where e.turn_id = t.id and e.event->>'type' = 'done') || ':' || t.claim_seq
  from public.agent_relay_turns t where t.id = 'cccccccc-0000-0000-0000-000000000002'),
  'claimed:0:2', 'still claimed, no done stored, both events counted (seq stays in step)');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000002'), 1,
    '[{"type":"text","delta":"$90."},{"type":"done"}]'::jsonb),
  'claimed', 'a replay of the held post changes nothing');
select is((select count(*)::int from public.agent_relay_inputs_ack('cccccccc-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000002'), 1)),
  0, 'the Mac acknowledges the addition (inputsSeen 1)');
select is(public.agent_relay_append('cccccccc-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-00000000000a', (select claim_id from public.agent_relay_turns where id = 'cccccccc-0000-0000-0000-000000000002'), 3,
    '[{"type":"text","delta":" $20 on gas."},{"type":"done"}]'::jsonb),
  'done', 'once the Mac has read it (inputsSeen 1), its done closes the turn');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(
  (select array_agg(content->0->>'text' order by created_at, id) from public.agent_messages where thread_id = 'bbbbbbbb-0000-0000-0000-000000000001' and role = 'assistant'),
  array['$42 today, $18 on food and $20 on gas.', '$90. $20 on gas.'], 'the held turn answers the addition, then closes'
);

-- A server-loop turn: the thread lease is the turn id while it runs.
select ok(public.agent_claim_thread('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f1', 300), 'the server loop takes the thread');
select is(public.agent_turn_append('cccccccc-0000-0000-0000-0000000000f1', 'also this week'), 1, 'the lease takes an addition');
reset role;
set local role service_role;
select is(public.agent_turn_append('cccccccc-0000-0000-0000-0000000000f1', 'and next week'), 2, 'the service role (a paired device) adds too');
delete from public.agent_relay_inputs where turn_id = 'cccccccc-0000-0000-0000-0000000000f1' and seq = 2;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select array_agg(seq || ':' || text) from public.agent_relay_inputs where turn_id = 'cccccccc-0000-0000-0000-0000000000f1'),
  array['1:also this week'], 'the loop reads it back');
update public.agent_threads set busy_until = now() - interval '1 second' where id = 'bbbbbbbb-0000-0000-0000-000000000002';
select is(public.agent_turn_append('cccccccc-0000-0000-0000-0000000000f1', 'late'), null, 'a lapsed lease takes nothing');

-- The turn died with its lease (killed function). A claim writes nothing: never between a tool call and its result.
select ok(public.agent_claim_thread('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f2', 300), 'the next turn takes the lapsed thread');
select is((select count(*)::int from public.agent_messages where thread_id = 'bbbbbbbb-0000-0000-0000-000000000002'), 0, 'a claim writes nothing into the thread');
select is((select thread_id from public.agent_relay_inputs where turn_id = 'cccccccc-0000-0000-0000-0000000000f1'), 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'a lease addition knows its thread');
-- The new turn's first message takes the dead turn's additions in the same step: after the dead call's results, before
-- the new words.
select is(public.agent_write_inputs('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f2', false, 'phone', '(added) ',
    '[{"type":"tool_result","tool_use_id":"tu_1","is_error":true,"content":"Interrupted"}]', '[{"type":"text","text":"Did it work?"}]'),
  '[{"type":"tool_result","tool_use_id":"tu_1","is_error":true,"content":"Interrupted"},{"type":"text","text":"(added) also this week"},{"type":"text","text":"Did it work?"}]'::jsonb,
  'the first message: the dead call''s results, the addition, the new words');
select is((select array_agg(role || ':' || jsonb_array_length(content)) from public.agent_messages where thread_id = 'bbbbbbbb-0000-0000-0000-000000000002'), array['user:3'], 'as one user message');
select is((select written from public.agent_relay_inputs where turn_id = 'cccccccc-0000-0000-0000-0000000000f1'), true, 'and marked written');
select is(public.agent_write_inputs('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f2', false, 'phone', '', '[]', '[]'), null, 'taken once: a second write takes and writes nothing');
select throws_ok($$ select public.agent_write_inputs('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f2', false, 'phone', '', '{}', '[]') $$, '22023', null, 'before and after are arrays');

-- The turn takes its own additions: marked and returned in one statement, in order; a second take gets none.
select is(public.agent_turn_append('cccccccc-0000-0000-0000-0000000000f2', 'one'), 1, 'the new lease takes an addition');
select is(public.agent_turn_append('cccccccc-0000-0000-0000-0000000000f2', 'two'), 2, 'and another');
select is((select array_agg(input_seq || ':' || input_text) from public.agent_take_inputs('cccccccc-0000-0000-0000-0000000000f2')), array['1:one', '2:two'], 'the turn takes its additions in order');
select is((select count(*)::int from public.agent_take_inputs('cccccccc-0000-0000-0000-0000000000f2')), 0, 'a second take gets none');
select is((select bool_and(written) from public.agent_relay_inputs where turn_id = 'cccccccc-0000-0000-0000-0000000000f2'), true, 'they are its: marked written');

-- An ended turn's last write: nothing while another turn holds the thread (that turn's first message takes them).
select is(public.agent_turn_append('cccccccc-0000-0000-0000-0000000000f2', 'three'), 3, 'added just before the lease ends');
update public.agent_threads set busy_until = null where id = 'bbbbbbbb-0000-0000-0000-000000000002';
select ok(public.agent_claim_thread('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f3', 300), 'another turn takes the thread');
select is(public.agent_write_inputs('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f2', true, 'phone', '', '[]', '[]'), null, 'the ended turn writes nothing while another holds the thread');
select is(public.agent_write_inputs('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f3', false, 'web', '(added) ', '[]', '[{"type":"text","text":"q"}]'),
  '[{"type":"text","text":"(added) three"},{"type":"text","text":"q"}]'::jsonb, 'the holder''s first message takes them');
select is(public.agent_write_inputs('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f2', true, 'phone', '', '[]', '[]'), null, 'and the ended turn never writes them again');
-- On a free thread an ended turn writes its own; the thread takes the surface.
select is(public.agent_turn_append('cccccccc-0000-0000-0000-0000000000f3', 'four'), 1, 'the holder takes an addition');
update public.agent_threads set busy_until = null where id = 'bbbbbbbb-0000-0000-0000-000000000002';
select is(public.agent_write_inputs('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f3', true, 'desktop', '(added) ', '[]', '[]'), '[{"type":"text","text":"(added) four"}]'::jsonb,
  'an ended turn writes its own late additions on a free thread');
select is((select surface from public.agent_threads where id = 'bbbbbbbb-0000-0000-0000-000000000002'), 'desktop', 'the thread takes the surface');
-- One transaction: a write whose insert fails takes nothing.
select ok(public.agent_claim_thread('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f4', 300), 'a fourth turn takes the thread');
select is(public.agent_turn_append('cccccccc-0000-0000-0000-0000000000f4', 'five'), 1, 'it takes an addition');
update public.agent_threads set busy_until = null where id = 'bbbbbbbb-0000-0000-0000-000000000002';
select throws_ok($$ select public.agent_write_inputs('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f4', true, 'nope', '', '[]', '[]') $$, '23514', null, 'a write whose insert fails raises');
select is((select written from public.agent_relay_inputs where turn_id = 'cccccccc-0000-0000-0000-0000000000f4'), false, 'and took nothing: the take rolled back with it');
select is((select count(*)::int from public.agent_messages where thread_id = 'bbbbbbbb-0000-0000-0000-000000000002'), 3, 'nothing is written twice or lost');
select lives_ok($$ update public.agent_relay_inputs set written = true where turn_id = 'cccccccc-0000-0000-0000-0000000000f4' $$,
  'the server loop, as the owner, marks what it wrote');
update public.agent_relay_inputs set written = false where turn_id = 'cccccccc-0000-0000-0000-0000000000f4';

-- A stranger and anon.
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select throws_ok($$ select public.agent_turn_append('cccccccc-0000-0000-0000-0000000000f1', 'hi') $$, '42501', null, 'a stranger cannot add');
select is((select count(*)::int from public.agent_take_inputs('cccccccc-0000-0000-0000-0000000000f4')), 0, 'a stranger takes nothing');
select is(public.agent_write_inputs('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f4', true, 'web', '', '[]', '[]'), null, 'a stranger writes nothing (no thread for him)');
reset role;
select is((select written from public.agent_relay_inputs where turn_id = 'cccccccc-0000-0000-0000-0000000000f4'), false, 'the owner''s addition is still his to take');
set local role anon;
select throws_ok($$ select * from public.agent_relay_inputs $$, '42501', null, 'anon cannot read inputs');
select throws_ok($$ select * from public.agent_take_inputs('cccccccc-0000-0000-0000-0000000000f4') $$, '42501', null, 'anon cannot take');
select throws_ok($$ select public.agent_write_inputs('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000f4', true, 'web', '', '[]', '[]') $$, '42501', null, 'anon cannot write');
reset role;

select ok(position('agent_messages' in pg_get_functiondef('public.agent_claim_thread(uuid,uuid,int)'::regprocedure)) = 0,
  'the claim only takes the lease: it writes nothing into the thread');
select ok(position('agent_threads' in pg_get_functiondef('public.agent_take_inputs(uuid)'::regprocedure)) > 0,
  'take locks the thread row first, the order the other input writers take');

select * from finish();
rollback;
