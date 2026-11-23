-- pgTAP: Hydra Agent tables (0070). Owner-only RLS, explicit grants, hydra_ro reads all but the key
-- tables, a routine occurrence is claimed once, pairing codes are one-time, revoked keys stop
-- working, desktop jobs go to one device once. Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(53);

-- Start from empty agent tables (rolled back at the end).
delete from public.agent_routines;
delete from public.agent_threads;
delete from public.agent_devices;
delete from public.agent_pairing_codes;
delete from public.agent_notifications;
delete from public.agent_desktop_jobs;
delete from public.agent_memory;
delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

-- Every table exists with RLS on.
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relname in (
     'agent_settings', 'agent_threads', 'agent_messages', 'agent_memory', 'agent_routines',
     'agent_routine_runs', 'agent_devices', 'agent_pairing_codes', 'agent_actions', 'agent_approvals',
     'agent_notifications', 'agent_desktop_jobs')),
  12, 'twelve agent tables, RLS on every one'
);

-- anon holds nothing.
set local role anon;
select throws_ok($$ select * from public.agent_routines $$, '42501', null, 'anon cannot read routines');
select throws_ok($$ select * from public.agent_actions $$, '42501', null, 'anon cannot read the action log');
reset role;

-- Owner writes.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.agent_routines (id, name, instruction, schedule, tools, next_run_at)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Brand mail', 'Check Gmail for brand payments', '{"kind":"weekdays","time":"08:00"}', '{hydra,gmail}', now() - interval '1 minute'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Paused one', 'Nothing', '{"kind":"daily","time":"09:00"}', '{hydra}', now() - interval '1 minute');
update public.agent_routines set paused = true where id = 'aaaaaaaa-0000-0000-0000-000000000002';
insert into public.agent_threads (id, surface) values ('bbbbbbbb-0000-0000-0000-000000000001', 'web');
insert into public.agent_messages (thread_id, role, content, surface)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'user', '[{"type":"text","text":"hi"}]', 'web');
select is((select count(*)::int from public.agent_routines), 2, 'owner sees both routines');
select throws_ok(
  $$ insert into public.agent_routines (name, instruction, schedule, tools) values ('x', 'y', '{}', '{shell}') $$,
  '23514', null, 'a routine may only use hydra, mac, gmail and calendar'
);
select throws_ok(
  $$ insert into public.agent_routines (name, instruction, schedule) values ('x', 'y', '[]') $$,
  '23514', null, 'a schedule is an object'
);
select throws_ok(
  $$ insert into public.agent_messages (thread_id, role, content, surface) values ('bbbbbbbb-0000-0000-0000-000000000001', 'system', '[]', 'web') $$,
  '23514', null, 'a message is user or assistant'
);
select throws_ok(
  $$ insert into public.agent_notifications (kind, title, href) values ('info', 'x', '//evil.example') $$,
  '23514', null, 'a notification link stays on this site'
);
insert into public.agent_notifications (kind, title, dedupe_key) values ('reminder', 'Send the W-9', 'reminder:task:1:2026-11-21');
select throws_ok(
  $$ insert into public.agent_notifications (kind, title, dedupe_key) values ('reminder', 'Send the W-9', 'reminder:task:1:2026-11-21') $$,
  '23505', null, 'one notification per occurrence'
);
select throws_ok(
  $$ insert into public.agent_actions (tool, surface, inverse) values ('create_task', 'web', '{"tool":"delete_task"}') $$,
  '23514', null, 'an inverse names a tool and its input'
);
select throws_ok(
  $$ insert into public.agent_devices (name, key_hash) values ('Mac', repeat('a', 64)) $$,
  '42501', null, 'the owner cannot mint a device row directly (pairing only)'
);
select throws_ok(
  $$ select * from public.agent_claim_due_routines(now(), 10) $$,
  '42501', null, 'only the service role claims routines'
);
select throws_ok(
  $$ select public.agent_pair_exchange(repeat('a', 64), repeat('b', 64), 'Mac') $$,
  '42501', null, 'only the service role exchanges pairing codes'
);
select throws_ok(
  $$ select * from public.agent_device_auth(repeat('a', 64)) $$,
  '42501', null, 'only the service role checks device keys'
);
insert into public.agent_pairing_codes (code_hash, name, expires_at) values
  (repeat('1', 64), 'Hydra Desktop', now() + interval '10 minutes'),
  (repeat('2', 64), 'Old code', now() - interval '1 minute');
insert into public.agent_desktop_jobs (instruction) values ('Open Notes'), ('Quit Safari');
reset role;

-- Stranger (signed in, not the owner): sees nothing, writes nothing.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.agent_routines), 0, 'a stranger sees no routines');
select is((select count(*)::int from public.agent_messages), 0, 'a stranger sees no messages');
select throws_ok(
  $$ insert into public.agent_memory (key, value) values ('k', 'v') $$,
  '42501', null, 'a stranger cannot write memory'
);
select throws_ok(
  $$ select * from public.agent_claim_desktop_jobs('00000000-0000-0000-0000-000000000000'::uuid, 10) $$,
  '42501', null, 'a stranger cannot claim desktop jobs'
);
reset role;

-- hydra_ro reads the agent tables but never the key tables (it cannot see pgTAP: temp table).
grant hydra_ro to postgres with set true;
create temp table ro_out (k text primary key, v text) on commit drop;
grant all on ro_out to hydra_ro;
set local role hydra_ro;
insert into ro_out select 'routines', count(*)::text from public.agent_routines;
reset role;
select is((select v from ro_out where k = 'routines'), '2', 'hydra_ro reads routines');
select ok(not has_table_privilege('hydra_ro', 'public.agent_devices', 'select'), 'hydra_ro cannot read device key hashes');
select ok(not has_table_privilege('hydra_ro', 'public.agent_pairing_codes', 'select'), 'hydra_ro cannot read pairing code hashes');

-- Cron: a due occurrence is claimed once.
set local role service_role;
select is(
  (select count(*)::int from public.agent_claim_due_routines(now(), 10)),
  1, 'the due routine is claimed (the paused one is not)'
);
select is(
  (select count(*)::int from public.agent_claim_due_routines(now(), 10)),
  0, 'a second claim of the same tick gets nothing'
);
select is(
  (select next_run_at from public.agent_routines where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  null, 'next_run_at goes to null until the app schedules the next one'
);
select is(
  (select count(*)::int from public.agent_routine_runs where routine_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  1, 'one run row for the occurrence'
);
-- A stale writer puts the same occurrence back: last_fired_at compare-and-set refuses it.
update public.agent_routines set next_run_at = last_fired_at where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is(
  (select count(*)::int from public.agent_claim_due_routines(now(), 10)),
  0, 'the same occurrence never fires twice'
);
select is(
  (select count(*)::int from public.agent_routine_runs),
  1, 'still one run row'
);
-- The next occurrence fires.
update public.agent_routines set next_run_at = now() - interval '10 seconds' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is(
  (select count(*)::int from public.agent_claim_due_routines(now(), 10)),
  1, 'the next occurrence is claimed'
);

-- Pairing: one-time, short-lived.
select isnt(
  public.agent_pair_exchange(repeat('1', 64), repeat('c', 64), 'Studio Mac'),
  null, 'a fresh code becomes a device'
);
select is(
  public.agent_pair_exchange(repeat('1', 64), repeat('d', 64), 'Second try'),
  null, 'a used code is refused'
);
select is(
  public.agent_pair_exchange(repeat('2', 64), repeat('e', 64), 'Late'),
  null, 'an expired code is refused'
);
select is(
  (select name from public.agent_devices where key_hash = repeat('c', 64)),
  'Studio Mac', 'the device keeps the name it sent'
);
select is(
  (select count(*)::int from public.agent_device_auth(repeat('c', 64))),
  1, 'a live key authenticates'
);
select isnt(
  (select last_seen_at from public.agent_devices where key_hash = repeat('c', 64)),
  null, 'the key check moves last_seen_at'
);
update public.agent_devices set revoked_at = now() where key_hash = repeat('c', 64);
select is(
  (select count(*)::int from public.agent_device_auth(repeat('c', 64))),
  0, 'a revoked key stops working'
);
reset role;

-- Desktop jobs go to one device once.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(
  (select count(*)::int from public.agent_claim_desktop_jobs((select id from public.agent_devices limit 1), 10)),
  2, 'the owner session claims both queued jobs'
);
select is(
  (select count(*)::int from public.agent_claim_desktop_jobs((select id from public.agent_devices limit 1), 10)),
  0, 'a second pull gets nothing'
);
reset role;

-- One turn at a time per thread: a lease the owner's turn takes; a second token waits.
insert into public.agent_threads (id, surface, title) values ('33333333-3333-3333-3333-333333333333', 'web', 'shared');
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is(public.agent_claim_thread('33333333-3333-3333-3333-333333333333', gen_random_uuid(), 300), false, 'a stranger cannot take the thread');
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(public.agent_claim_thread('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-4000-8000-000000000001', 300), true, 'a turn takes a free thread');
select is(public.agent_claim_thread('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-4000-8000-000000000002', 300), false, 'a second turn cannot take a busy thread');
select is(public.agent_claim_thread('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-4000-8000-000000000001', 300), true, 'the holder renews its own lease');
select throws_ok($$ select * from public.agent_dispatch_runs(now(), 120, 10) $$, '42501', null, 'the owner session cannot dispatch runs (service role only)');
select throws_ok($$ select public.agent_rate_hit('x', 1) $$, '42501', null, 'the owner session cannot touch rate limits');
reset role;
update public.agent_threads set busy_until = now() - interval '1 second' where id = '33333333-3333-3333-3333-333333333333';
set local role authenticated;
select is(public.agent_claim_thread('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-4000-8000-000000000002', 300), true, 'a lease that ran out frees the thread');
reset role;

-- A queued run is dispatched once, again only after it went stale.
insert into public.agent_routines (id, name, instruction, schedule) values ('44444444-4444-4444-4444-444444444444', 'Retry', 'Do it', '{"kind":"daily","time":"08:00"}');
insert into public.agent_routine_runs (routine_id, occurrence_at, status) values ('44444444-4444-4444-4444-444444444444', '2026-11-23T13:00:00Z', 'queued');
set local role service_role;
select is((select attempts from public.agent_dispatch_runs('2026-11-23T13:00:00Z', 120, 10) d where d.routine_id = '44444444-4444-4444-4444-444444444444'), 1, 'a new queued run is dispatched (attempt 1)');
select is((select count(*)::int from public.agent_dispatch_runs('2026-11-23T13:01:00Z', 120, 10) d where d.routine_id = '44444444-4444-4444-4444-444444444444'), 0, 'not again while the start may still be running');
select is((select attempts from public.agent_dispatch_runs('2026-11-23T13:03:00Z', 120, 10) d where d.routine_id = '44444444-4444-4444-4444-444444444444'), 2, 'again once stale (attempt 2)');

-- Rate limits: a fixed window per bucket.
select is(public.agent_rate_hit('test:bucket', 1), 0, 'the first hit passes');
select ok(public.agent_rate_hit('test:bucket', 1) > 0, 'over the limit: seconds to wait');
reset role;

-- The service role (the cron) pulls desktop jobs too.
insert into public.agent_desktop_jobs (instruction) values ('Open Finder');
set local role service_role;
select is((select count(*)::int from public.agent_claim_desktop_jobs(null, 10)), 1, 'the service role claims a queued desktop job');
reset role;

-- The sleep word: a default, owner-editable, never blank.
insert into public.agent_settings (user_id) values ('11111111-1111-1111-1111-111111111111');
select is((select sleep_word from public.agent_settings), 'Hydra, sleep', 'the sleep word defaults to "Hydra, sleep"');
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
update public.agent_settings set sleep_word = 'Goodnight Hydra';
select is((select sleep_word from public.agent_settings), 'Goodnight Hydra', 'the owner changes the sleep word');
select throws_ok($$ update public.agent_settings set sleep_word = '   ' $$, '23514', null, 'a blank sleep word is refused');
reset role;

select * from finish();
rollback;
