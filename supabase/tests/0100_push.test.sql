-- pgTAP: push_subscriptions. Owner-only RLS, explicit grants, shape checks, one row per endpoint.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(13);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select has_table('public', 'push_subscriptions', 'the table exists');
select is(
  (select relrowsecurity from pg_class where oid = 'public.push_subscriptions'::regclass),
  true, 'RLS is on'
);

-- Grants: anon has nothing; authenticated has exactly the four DML privileges.
set local role anon;
select throws_ok($$ select * from public.push_subscriptions $$, '42501', null, 'anon cannot read subscriptions');
reset role;
select is(
  (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'push_subscriptions' and grantee = 'authenticated'),
  'DELETE,INSERT,SELECT,UPDATE', 'authenticated holds only select, insert, update, delete'
);

-- Stranger (signed in, not the owner): writes nothing.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select throws_ok(
  $$ insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
     values ('22222222-2222-2222-2222-222222222222', 'https://push.example.test/a', 'k', 'a') $$,
  '42501', null, 'a non-owner cannot insert a subscription'
);
reset role;

-- Owner: insert and read.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
values ('11111111-1111-1111-1111-111111111111', 'https://push.example.test/phone', 'key', 'secret', 'iPhone');
select is((select count(*)::int from public.push_subscriptions), 1, 'owner sees the subscription');
select throws_ok(
  $$ insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
     values ('11111111-1111-1111-1111-111111111111', 'http://push.example.test/plain', 'k', 'a') $$,
  '23514', null, 'the endpoint must be https'
);
select throws_ok(
  $$ insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
     values ('11111111-1111-1111-1111-111111111111', 'https://push.example.test/phone', 'k', 'a') $$,
  '23505', null, 'one row per endpoint'
);
select throws_ok(
  $$ update public.push_subscriptions set user_id = '22222222-2222-2222-2222-222222222222' $$,
  '42501', null, 'the owner cannot hand a row to another user'
);
reset role;

-- The stranger sees nothing of the owner's row.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.push_subscriptions), 0, 'a non-owner reads nothing');
reset role;

-- The owner removes a subscription.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
delete from public.push_subscriptions where endpoint = 'https://push.example.test/phone';
select is((select count(*)::int from public.push_subscriptions), 0, 'owner unsubscribes');
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
values ('11111111-1111-1111-1111-111111111111', 'https://push.example.test/mac', 'k', 'a');
reset role;

-- The subscription goes away with the owner row.
delete from private.app_owner;
select is((select count(*)::int from public.push_subscriptions), 0, 'subscriptions cascade with the owner');
select is(
  (select count(*)::int from pg_policies where tablename = 'push_subscriptions'),
  4, 'four owner policies, none for anon'
);

select * from finish();
rollback;
