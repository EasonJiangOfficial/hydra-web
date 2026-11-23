-- pgTAP: agent provider keys (0225). xai only, sealed ciphertext only ('v1.%'), a four-character hint; the owner and
-- hydra_ro read the provider, hint and dates but never `sealed`; only service_role writes; not logged for undo.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test')
on conflict (id) do nothing;
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select has_table('public', 'agent_model_keys', 'agent_model_keys exists');
select is((select relrowsecurity from pg_class where oid = 'public.agent_model_keys'::regclass), true, 'RLS is on');
select is((select logged from private.activity_tables where tbl = 'agent_model_keys'), false, 'keys are not logged for undo');

-- The server (service_role) stores a sealed key.
delete from public.agent_model_keys;
set local role service_role;
select lives_ok($$ insert into public.agent_model_keys (provider, sealed, hint) values ('xai', 'v1.aXY.dGFn.Y2lwaGVy', '4f2a') $$,
  'service_role stores a sealed key');
select throws_ok($$ update public.agent_model_keys set sealed = 'xai-plaintext-key-0000000000' $$,
  '23514', null, 'a plaintext key fails the v1. check');
select throws_ok($$ insert into public.agent_model_keys (provider, sealed, hint) values ('openai', 'v1.a.b.c', 'abcd') $$,
  '23514', null, 'only xai: ChatGPT signs in on the Mac');
select throws_ok($$ update public.agent_model_keys set hint = 'abcdef' $$, '23514', null, 'the hint is four characters');
reset role;

-- The owner.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select provider || ' ' || hint from public.agent_model_keys), 'xai 4f2a', 'the owner sees the provider and the hint');
select throws_ok($$ select sealed from public.agent_model_keys $$, '42501', null, 'the owner cannot select sealed');
select throws_ok($$ select * from public.agent_model_keys $$, '42501', null, 'select * fails: sealed is not granted');
select throws_ok($$ insert into public.agent_model_keys (provider, sealed, hint) values ('xai', 'v1.a.b.c', 'abcd') $$,
  '42501', null, 'the owner cannot write a key (the server does, as service_role)');
select throws_ok($$ delete from public.agent_model_keys $$, '42501', null, 'the owner cannot delete it directly (Remove goes through the server)');

-- A stranger and anon.
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.agent_model_keys), 0, 'a stranger sees no keys');
reset role;
set local role anon;
select throws_ok($$ select provider from public.agent_model_keys $$, '42501', null, 'anon cannot read keys');
reset role;

select ok(not has_column_privilege('hydra_ro', 'public.agent_model_keys', 'sealed', 'select'), 'hydra_ro cannot read sealed');
select ok(has_column_privilege('hydra_ro', 'public.agent_model_keys', 'hint', 'select'), 'hydra_ro reads the hint');

select * from finish();
rollback;
