-- pgTAP: connector keys and the connector's UGC reads. Owner-only RLS, explicit grants, the
-- security-definer key check (valid, unknown, revoked, wrong scope, rate limit, last used), the
-- work list and the missed-day warning. Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(33);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');
update public.settings set time_zone = null;

select has_table('public', 'api_keys', 'api_keys exists');
select has_table('public', 'api_key_rate_limits', 'api_key_rate_limits exists');
select is(
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.api_keys'::regclass, 'public.api_key_rate_limits'::regclass)),
  true, 'RLS is on for both tables'
);

-- Grants: anon nothing; authenticated cannot delete keys or write the hash; hydra_ro never reads keys.
set local role anon;
select throws_ok($$ select * from public.api_keys $$, '42501', null, 'anon cannot read keys');
reset role;
select is(has_table_privilege('authenticated', 'public.api_keys', 'DELETE'), false, 'authenticated cannot delete keys');
select is(has_column_privilege('authenticated', 'public.api_keys', 'key_hash', 'UPDATE'), false, 'authenticated cannot rewrite a key hash');
select is(has_table_privilege('authenticated', 'public.api_key_rate_limits', 'UPDATE'), false, 'authenticated cannot write counters');
select is(has_table_privilege('hydra_ro', 'public.api_keys', 'SELECT'), false, 'hydra_ro cannot read keys');

-- The owner creates keys; a stranger sees and creates nothing.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.api_keys (id, name, prefix, key_hash, rate_limit_per_minute)
values
  ('a8000000-0000-4000-8000-000000000001', 'Grokbot', 'hyd_ugc_AAAA', repeat('a', 64), 3),
  ('a8000000-0000-4000-8000-000000000002', 'Old', 'hyd_ugc_BBBB', repeat('b', 64), 120);
select is((select count(*)::int from public.api_keys), 2, 'the owner lists their keys');
select throws_ok(
  $$ update public.api_keys set key_hash = repeat('c', 64) where id = 'a8000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'the owner cannot rewrite a hash in place'
);
select throws_ok(
  $$ insert into public.api_keys (name, prefix, key_hash, revoked_at) values ('x', 'hyd_ugc_CCCC', repeat('c', 64), now()) $$,
  '42501', null, 'a new key starts unrevoked and unused'
);
update public.api_keys set revoked_at = now() where id = 'a8000000-0000-4000-8000-000000000002';
select isnt((select revoked_at from public.api_keys where id = 'a8000000-0000-4000-8000-000000000002'), null, 'the owner revokes a key');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.api_keys), 0, 'a stranger sees zero keys');
select throws_ok(
  $$ insert into public.api_keys (name, prefix, key_hash) values ('x', 'hyd_ugc_DDDD', repeat('d', 64)) $$,
  '42501', null, 'a stranger cannot create a key'
);

-- The key check is the service role's alone.
select throws_ok(
  $$ select * from public.api_key_authenticate(repeat('a', 64), 'ugc:write') $$,
  '42501', null, 'authenticated cannot call the key check'
);
reset role;
set local role anon;
select throws_ok(
  $$ select * from public.api_key_authenticate(repeat('a', 64), 'ugc:write') $$,
  '42501', null, 'anon cannot call the key check'
);
reset role;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select results_eq(
  $$ select key_id, status from public.api_key_authenticate(repeat('a', 64), 'ugc:write') $$,
  $$ values ('a8000000-0000-4000-8000-000000000001'::uuid, 'ok'::text) $$,
  'a valid key passes'
);
select isnt((select last_used_at from public.api_keys where id = 'a8000000-0000-4000-8000-000000000001'), null, 'a pass stamps last used');
select is((select status from public.api_key_authenticate(repeat('e', 64), 'ugc:write')), 'invalid', 'an unknown key is invalid');
select is((select status from public.api_key_authenticate(repeat('b', 64), 'ugc:write')), 'revoked', 'a revoked key is refused');
select is((select status from public.api_key_authenticate(repeat('a', 64), 'finance:read')), 'forbidden', 'a scope the key lacks is refused');
select is((select status from public.api_key_authenticate(repeat('a', 64), 'ugc:write')), 'ok', 'second call in the minute passes');
select is((select status from public.api_key_authenticate(repeat('a', 64), 'ugc:write')), 'ok', 'third call (the limit) passes');
select results_eq(
  $$ select status, retry_after_seconds between 1 and 60 from public.api_key_authenticate(repeat('a', 64), 'ugc:write') $$,
  $$ values ('rate_limited'::text, true) $$,
  'the fourth call in the minute is rate limited with a retry time'
);
select is(
  (select request_count from public.api_key_rate_limits where key_id = 'a8000000-0000-4000-8000-000000000001'),
  4, 'the counter holds the minute''s calls'
);
reset role;

-- The work list and the missed-day warning. Now = 2026-11-21 12:00 UTC; zone UTC (setting null).
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.deals (id, brand_name, start_date) values ('d8000000-0000-4000-8000-000000000001', 'Acme', '2026-09-01');
insert into public.posts (id, deal_id, platform, url, posted_at, exclude_from_pay)
values
  ('e8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/1', '2026-11-18T10:00:00Z', false),
  ('e8000000-0000-4000-8000-000000000002', 'd8000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/2', '2026-11-19T09:00:00Z', false),
  ('e8000000-0000-4000-8000-000000000003', 'd8000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/3', '2026-11-10T09:00:00Z', true),
  ('e8000000-0000-4000-8000-000000000004', 'd8000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/4', '2026-10-01T09:00:00Z', false),
  ('e8000000-0000-4000-8000-000000000005', 'd8000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/5', '2026-11-22T09:00:00Z', false);
insert into public.post_view_snapshots (post_id, captured_day, captured_at, views)
values
  ('e8000000-0000-4000-8000-000000000001', '2026-11-19', '2026-11-19T08:00:00Z', 500),
  ('e8000000-0000-4000-8000-000000000002', '2026-11-20', '2026-11-20T08:00:00Z', 300),
  ('e8000000-0000-4000-8000-000000000002', '2026-11-21', '2026-11-21T08:00:00Z', 900);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select results_eq(
  $$ select post_id, last_views from public.ugc_posts_needing_views('2026-11-21T12:00:00Z') $$,
  $$ values ('e8000000-0000-4000-8000-000000000001'::uuid, 500::bigint) $$,
  'the work list: open, not excluded, not frozen, not future, no reading today'
);
select results_eq(
  $$ select day, posts_needing, posts_read from public.ugc_missed_view_days(7, '2026-11-21T12:00:00Z') $$,
  $$ values ('2026-11-20'::date, 2, 1) $$,
  'the warning names the day a needed reading is missing, and only that day'
);
select is(
  (select count(*)::int from public.ugc_missed_view_days(1, '2026-11-20T12:00:00Z')),
  0, 'a day where every needed reading came in is no warning'
);
reset role;

-- A different zone moves the day boundary: 2026-11-21 03:00 UTC is still 2026-11-20 in New York,
-- where post 2 already has its reading, so only post 1 is on the list.
update public.settings set time_zone = 'America/New_York';
set local role service_role;
select results_eq(
  $$ select post_id from public.ugc_posts_needing_views('2026-11-21T03:00:00Z') $$,
  $$ values ('e8000000-0000-4000-8000-000000000001'::uuid) $$,
  'the work list uses the owner''s day'
);
reset role;
update public.settings set time_zone = null;

-- RLS applies to the reads: a stranger gets nothing; the owner gets the same list.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.ugc_posts_needing_views('2026-11-21T12:00:00Z')), 0, 'a stranger gets no work list');
select is((select count(*)::int from public.ugc_missed_view_days(7, '2026-11-21T12:00:00Z')), 0, 'a stranger gets no warning');
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select count(*)::int from public.ugc_missed_view_days(7, '2026-11-21T12:00:00Z')), 1, 'the owner sees the warning');
reset role;

-- The connector's database role cannot exclude a video (the 0010 guard holds for keys too).
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select throws_ok(
  $$ update public.posts set exclude_from_pay = true where id = 'e8000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'the connector role cannot exclude a video'
);
reset role;

select * from finish();
rollback;
