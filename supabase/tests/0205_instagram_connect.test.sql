-- pgTAP: Connect Instagram (0205). One connection; the token is ciphertext only and hidden from everyone but
-- service_role; owner-only, read-only RLS; the follower source 'instagram'; the token table is not logged.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(28);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test')
on conflict (id) do nothing;
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

insert into public.instagram_connections (id, ig_user_id, username, access_token, expires_at)
values ('99999999-0000-0000-0000-000000000205', '17841400000000001', 'studio.notes', 'v1.aXY.dGFn.dG9r', now() + interval '60 days');

-- Structure and guards.
select has_table('public', 'instagram_connections', 'instagram_connections exists');
select is((select relrowsecurity from pg_class where oid = 'public.instagram_connections'::regclass), true, 'RLS is on');
select throws_ok(
  $$ insert into public.instagram_connections (ig_user_id, username, access_token, expires_at)
     values ('1', 'x', 'IGAAplaintext', now()) $$,
  '23514', null, 'a plaintext token is refused'
);
select throws_ok(
  $$ update public.instagram_connections set one_connection = false $$,
  '23514', null, 'one_connection is always true'
);
select throws_ok(
  $$ insert into public.instagram_connections (ig_user_id, username, access_token, expires_at)
     values ('2', 'second', 'v1.a.b.c', now()) $$,
  '23505', null, 'only one Instagram connection'
);

-- Roles.
set local role anon;
select throws_ok($$ select id from public.instagram_connections $$, '42501', null, 'anon cannot read the connection');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.instagram_connections), 0, 'a stranger sees no connection');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select username from public.instagram_connections), 'studio.notes', 'the owner sees which account is connected');
select is((select last_error from public.instagram_connections), null, 'the owner reads the error state');
select throws_ok($$ select access_token from public.instagram_connections $$, '42501', null, 'the owner cannot read the token');
select throws_ok($$ select * from public.instagram_connections $$, '42501', null, 'select * fails: the token column is not granted');
select throws_ok(
  $$ update public.instagram_connections set last_error = null $$,
  '42501', null, 'the owner cannot write the connection (the server does, as service_role)'
);
select throws_ok(
  $$ delete from public.instagram_connections $$,
  '42501', null, 'the owner cannot delete it directly (Disconnect goes through the server)'
);
reset role;

select ok(not has_column_privilege('hydra_ro', 'public.instagram_connections', 'access_token', 'select'), 'hydra_ro cannot read the token');
select ok(has_column_privilege('hydra_ro', 'public.instagram_connections', 'username', 'select'), 'hydra_ro reads the username');
select ok(has_column_privilege('service_role', 'public.instagram_connections', 'access_token', 'update'), 'service_role writes the token');
select lives_ok(
  $$ update public.instagram_connections set last_error = 'insights_partial,insights_not_granted,media_cut' $$,
  'last_error holds every sync note at once'
);
select col_not_null('public', 'instagram_connections', 'token_id', 'every stored token has a token_id (the sync compare-and-set key)');
select isnt((select token_id from public.instagram_connections), null, 'a row stored without one gets a token_id');

-- The sync lease: a compare-and-set claims it once; a second claim gets no row.
select results_eq(
  $$ with c as (update public.instagram_connections set sync_started_at = now() where sync_started_at is null returning 1)
     select count(*)::int from c $$,
  $$ values (1) $$, 'the first sync claims the lease'
);
select results_eq(
  $$ with c as (update public.instagram_connections set sync_started_at = now() where sync_started_at is null returning 1)
     select count(*)::int from c $$,
  $$ values (0) $$, 'a second sync at once does not'
);

-- Followers: the sync's source is allowed, an unknown one is not.
select lives_ok(
  $$ insert into public.personal_brand_followers (day, followers, source) values ('2026-11-22', 1300, 'instagram') $$,
  'a synced count has source instagram'
);
select throws_ok(
  $$ insert into public.personal_brand_followers (day, followers, source) values ('2026-11-23', 10, 'scraped') $$,
  '23514', null, 'an unknown source is still refused'
);

-- Deals: the sync (service_role) makes the Personal Brand deal; it sets no pay field and edits no deal.
set local role service_role;
select lives_ok(
  $$ insert into public.deals (brand_name, start_date, personal_brand) values ('Personal Brand', '2026-11-21', true) $$,
  'the sync makes the Personal Brand deal'
);
select throws_ok(
  $$ insert into public.deals (brand_name, start_date, personal_brand, base_pay_cents) values ('X', '2026-11-21', true, 100) $$,
  '42501', null, 'the sync cannot set a pay field'
);
select throws_ok(
  $$ update public.deals set brand_name = 'Renamed' where personal_brand $$,
  '42501', null, 'the sync cannot edit a deal'
);
select throws_ok(
  $$ delete from public.deals where personal_brand $$,
  '42501', null, 'the sync cannot delete a deal'
);
reset role;

-- Activity (0130): the token table is listed and never logged, where 0130 ran.
select ok(
  to_regclass('private.activity_tables') is null
  or exists (select 1 from private.activity_tables where tbl = 'instagram_connections' and not logged),
  'the token table is excluded from Activity'
);

select * from finish();
rollback;
