-- pgTAP: owner-only RLS, one owner, read-only hydra_ro. Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(29);

-- Fixtures: an owner and a stranger. Start ownerless (a bootstrapped owner comes back on rollback).
delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select is(public.bootstrap_owner('11111111-1111-1111-1111-111111111111'), 'created', 'bootstrap creates the owner');
select is(public.bootstrap_owner('11111111-1111-1111-1111-111111111111'), 'unchanged', 'bootstrap is idempotent');
select throws_ok(
  $$ select public.bootstrap_owner('22222222-2222-2222-2222-222222222222') $$,
  '23505', null, 'bootstrap refuses a second owner'
);

-- One owner only.
select throws_ok(
  $$ insert into private.app_owner (user_id) values ('22222222-2222-2222-2222-222222222222') $$,
  '23505', null, 'a second app_owner row fails'
);

-- Seeds and defaults.
select results_eq(
  $$ select slug, kind, coalesce(tax_shape, '-'), status from public.entities order by slug $$,
  $$ values ('personal', 'personal', '-', 'active'), ('ugc', 'business', 'sole_prop', 'active'), ('ugm', 'business', 'llc', 'closed') $$,
  'entities are seeded'
);
select results_eq(
  $$ select time_zone, chat_model, idle_lock_minutes from public.settings $$,
  $$ values (null::text, 'claude-sonnet-5-5', null::int) $$,
  'settings row has the defaults (idle lock off)'
);

-- RLS is on everywhere.
select is(
  (select count(*)::int from pg_tables where schemaname in ('public', 'private') and not rowsecurity),
  0, 'RLS is enabled on every table'
);

-- Anon: no grants at all.
set local role anon;
select throws_ok($$ select * from public.entities $$, '42501', null, 'anon cannot read entities');
select throws_ok($$ select * from public.settings $$, '42501', null, 'anon cannot read settings');
select throws_ok($$ select public.is_owner() $$, '42501', null, 'anon cannot call is_owner');
reset role;

-- Authenticated non-owner: zero rows, no writes.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is(public.is_owner(), false, 'stranger is not the owner');
select is((select count(*)::int from public.entities), 0, 'stranger sees zero entities');
select is((select count(*)::int from public.settings), 0, 'stranger sees zero settings');
update public.settings set idle_lock_minutes = 30;
update public.entities set name = 'pwned';
select throws_ok(
  $$ insert into public.settings (user_id) values ('22222222-2222-2222-2222-222222222222') $$,
  '42501', null, 'stranger cannot insert settings'
);
select throws_ok(
  $$ insert into public.entities (slug, name, kind) values ('x', 'x', 'personal') $$,
  '42501', null, 'stranger cannot insert entities'
);
reset role;
select is((select idle_lock_minutes from public.settings), null::int, 'stranger update changed nothing in settings');
select is((select count(*)::int from public.entities where name = 'pwned'), 0, 'stranger update changed nothing in entities');

-- Owner: sees and updates.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select count(*)::int from public.entities), 3, 'owner sees all entities');
update public.settings set time_zone = 'America/New_York', idle_lock_minutes = 10;
select results_eq(
  $$ select time_zone, idle_lock_minutes from public.settings $$,
  $$ values ('America/New_York'::text, 10) $$,
  'owner updates settings'
);
select throws_ok(
  $$ update public.settings set idle_lock_minutes = 0 $$,
  '23514', null, 'idle lock minutes below 1 is rejected'
);
update public.settings set idle_lock_minutes = null;
select is((select idle_lock_minutes from public.settings), null::int, 'owner turns the idle lock off');
reset role;

-- hydra_ro: emulate how PostgREST impersonates a role: switch role, then load that role's own
-- settings. hydra_ro cannot see pgTAP (schema extensions), so it records outcomes in a temp table
-- and the assertions run after reset role.
-- (`grant ... to current_user` segfaults the local Postgres build; name the role.)
grant hydra_ro to postgres with set true;
create temp table ro_out (k text primary key, v text) on commit drop;
grant all on ro_out to hydra_ro;
set local role hydra_ro;
select set_config(split_part(cfg, '=', 1), split_part(cfg, '=', 2), true)
from pg_db_role_setting s, unnest(s.setconfig) cfg
where s.setrole = 'hydra_ro'::regrole and s.setdatabase = 0;
insert into ro_out select 'rows', count(*)::text from public.entities;
insert into ro_out select 'timeout', current_setting('statement_timeout');
-- default_transaction_read_only only bites on a new transaction (real login); inside this one the
-- missing write grants stop the write. supabase/tests/hydra_ro_login.sh proves it on a real login.
do $$
begin
  update public.entities set name = 'x';
  insert into ro_out values ('write', 'allowed');
exception when others then
  insert into ro_out values ('write', sqlstate);
end;
$$;
do $$
begin
  perform pg_sleep(6);
  insert into ro_out values ('sleep', 'finished');
exception when query_canceled then
  insert into ro_out values ('sleep', sqlstate);
end;
$$;
reset role;
reset statement_timeout;
select is((select v from ro_out where k = 'rows'), '3', 'hydra_ro reads entities');
select is((select v from ro_out where k = 'timeout'), '5s', 'hydra_ro carries a 5 s statement timeout');
select is((select v from ro_out where k = 'write'), '42501', 'hydra_ro cannot write');
select is((select v from ro_out where k = 'sleep'), '57014', 'hydra_ro times out pg_sleep(6)');

-- Default privileges: a table, sequence and function created after 0001 carry no grants for
-- anon, authenticated or PUBLIC (every privilege, MAINTAIN included). hydra_ro still reads tables.
create table public.tap_future (id int);
create sequence public.tap_future_seq;
create function public.tap_future_fn() returns int language sql as 'select 1';
select is(
  (select count(*)::int from aclexplode((select relacl from pg_class where oid = 'public.tap_future'::regclass)) a
   where a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)),
  0, 'a future table grants nothing to anon, authenticated or PUBLIC'
);
select is(
  (select count(*)::int from aclexplode((select relacl from pg_class where oid = 'public.tap_future_seq'::regclass)) a
   where a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)),
  0, 'a future sequence grants nothing to anon, authenticated or PUBLIC'
);
select is(
  (select count(*)::int from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where p.oid = 'public.tap_future_fn()'::regprocedure and a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)),
  0, 'a future function is not executable by anon, authenticated or PUBLIC'
);
select ok(has_table_privilege('hydra_ro', 'public.tap_future', 'select'), 'hydra_ro still reads a future table');

select * from finish();
rollback;
