-- pgTAP: Google connectors. Owner-only, read-only RLS; tokens, the sync token and channel secrets
-- hidden from everyone but service_role; one Google sign-in; links and channels go with the account.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(27);

-- Fixtures: an owner and a stranger (same ids as 0001's test; everything rolls back).
delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test')
on conflict (id) do nothing;
select is(public.bootstrap_owner('11111111-1111-1111-1111-111111111111'), 'created', 'the owner exists');

insert into public.google_accounts (id, email, access_token, access_expires_at, refresh_token)
values ('99999999-0000-0000-0000-000000000001', 'owner@example.test', 'v1.aXY.dGFn.YWNj', now() + interval '1 hour', 'v1.aXY.dGFn.cmVm');
insert into public.google_calendar_sync (account_id, calendar_id, sync_token)
values ('99999999-0000-0000-0000-000000000001', 'hydra-cal@group.calendar.google.com', 'sync-token-1');
insert into public.google_calendar_links (account_id, item_kind, item_id, google_event_id, pending)
values ('99999999-0000-0000-0000-000000000001', 'event', gen_random_uuid(), 'g1', 'delete_in_hydra');
insert into public.google_watch_channels (id, account_id, resource_id, token_hash, address, expires_at)
values ('chan-1', '99999999-0000-0000-0000-000000000001', 'res-1', repeat('a', 64),
        'https://hydra.example/api/google/calendar/webhook', now() + interval '7 days');

-- ---------------------------------------------------------------------------
-- Structure and guards
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_tables where schemaname = 'public'
     and tablename in ('google_accounts', 'google_calendar_sync', 'google_calendar_links', 'google_watch_channels') and rowsecurity),
  4, 'RLS is on for every Google table'
);
select throws_ok(
  $$ insert into public.google_accounts (email, access_token, access_expires_at, refresh_token)
     values ('x@example.test', 'ya29.plaintext', now(), 'v1.a.b.c') $$,
  '23514', null, 'a plaintext access token is refused'
);
select throws_ok(
  $$ insert into public.google_accounts (email, access_token, access_expires_at, refresh_token)
     values ('x@example.test', 'v1.a.b.c', now(), '1//plaintext-refresh') $$,
  '23514', null, 'a plaintext refresh token is refused'
);
select throws_ok(
  $$ insert into public.google_accounts (email, access_token, access_expires_at, refresh_token)
     values ('second@example.test', 'v1.a.b.c', now(), 'v1.a.b.c') $$,
  '23505', null, 'only one Google sign-in'
);
select throws_ok(
  $$ insert into public.google_calendar_links (account_id, item_kind, item_id, google_event_id)
     values ('99999999-0000-0000-0000-000000000001', 'goal', gen_random_uuid(), 'g2') $$,
  '23514', null, 'a link is to a task or an event'
);
select throws_ok(
  $$ insert into public.google_calendar_links (account_id, item_kind, item_id, google_event_id)
     values ('99999999-0000-0000-0000-000000000001', 'task', gen_random_uuid(), 'g1') $$,
  '23505', null, 'one Hydra item per Google event'
);
select throws_ok(
  $$ insert into public.google_watch_channels (id, account_id, resource_id, token_hash, address, expires_at)
     values ('chan-2', '99999999-0000-0000-0000-000000000001', 'r', 'the-plain-token', 'https://h.example/x', now()) $$,
  '23514', null, 'a channel keeps a SHA-256 hash, never the token'
);
select throws_ok(
  $$ insert into public.google_watch_channels (id, account_id, resource_id, token_hash, address, expires_at)
     values ('chan-3', '99999999-0000-0000-0000-000000000001', 'r', repeat('b', 64), 'http://h.example/x', now()) $$,
  '23514', null, 'Google only calls https webhook addresses'
);

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($$ select id from public.google_accounts $$, '42501', null, 'anon cannot read Google accounts');
select throws_ok($$ select id from public.google_calendar_links $$, '42501', null, 'anon cannot read calendar links');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.google_accounts), 0, 'a stranger sees no Google account');
select is((select count(*)::int from public.google_calendar_links), 0, 'a stranger sees no calendar links');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select email from public.google_accounts), 'owner@example.test', 'the owner sees which Google account is connected');
select is((select calendar_id from public.google_calendar_sync), 'hydra-cal@group.calendar.google.com', 'the owner sees the Hydra calendar id');
select is((select pending from public.google_calendar_links), 'delete_in_hydra', 'the owner sees deletes waiting on him');
select throws_ok($$ select access_token from public.google_accounts $$, '42501', null, 'the owner cannot read the access token');
select throws_ok($$ select refresh_token from public.google_accounts $$, '42501', null, 'the owner cannot read the refresh token');
select throws_ok($$ select sync_token from public.google_calendar_sync $$, '42501', null, 'the owner cannot read the sync token');
select throws_ok($$ select id from public.google_watch_channels $$, '42501', null, 'the owner cannot read watch channels');
select throws_ok(
  $$ update public.google_calendar_links set pending = null $$,
  '42501', null, 'the owner cannot write links (the server does, as service_role)'
);
select throws_ok(
  $$ insert into public.google_accounts (email, access_token, access_expires_at, refresh_token)
     values ('x@example.test', 'v1.a.b.c', now(), 'v1.a.b.c') $$,
  '42501', null, 'the owner cannot write tokens directly'
);
reset role;

select ok(not has_column_privilege('hydra_ro', 'public.google_accounts', 'refresh_token', 'select'), 'hydra_ro cannot read the refresh token');
select ok(not has_table_privilege('hydra_ro', 'public.google_watch_channels', 'select'), 'hydra_ro cannot read watch channels');
select ok(has_table_privilege('hydra_ro', 'public.google_calendar_links', 'select'), 'hydra_ro reads calendar links');

-- Disconnect: the account row goes, and its sync state, links and channels with it.
delete from public.google_accounts where id = '99999999-0000-0000-0000-000000000001';
select is(
  (select count(*)::int from public.google_calendar_sync) + (select count(*)::int from public.google_calendar_links)
    + (select count(*)::int from public.google_watch_channels),
  0, 'deleting the account removes its sync state, links and channels'
);
select lives_ok(
  $$ insert into public.google_accounts (email, access_token, access_expires_at, refresh_token)
     values ('new@example.test', 'v1.a.b.c', now(), 'v1.a.b.c') $$,
  'a new sign-in fits once the old one is gone'
);

select * from finish();
rollback;
