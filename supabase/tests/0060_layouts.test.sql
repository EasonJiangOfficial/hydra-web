-- pgTAP: dashboard_layouts. Owner-only RLS, explicit grants, shape checks, one row per breakpoint,
-- compare-and-set on updated_at. Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(19);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select has_table('public', 'dashboard_layouts', 'the table exists');
select is(
  (select relrowsecurity from pg_class where oid = 'public.dashboard_layouts'::regclass),
  true, 'RLS is on'
);

-- Grants: anon has nothing; authenticated has exactly the four DML privileges.
set local role anon;
select throws_ok($$ select * from public.dashboard_layouts $$, '42501', null, 'anon cannot read layouts');
reset role;
select is(
  (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'dashboard_layouts' and grantee = 'authenticated'),
  'DELETE,INSERT,SELECT,UPDATE', 'authenticated holds only select, insert, update, delete'
);

-- Stranger (signed in, not the owner): sees nothing and writes nothing.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select throws_ok(
  $$ insert into public.dashboard_layouts (user_id, breakpoint) values ('22222222-2222-2222-2222-222222222222', 'desktop') $$,
  '42501', null, 'a non-owner cannot insert a layout row'
);
select throws_ok(
  $$ insert into public.dashboard_layouts (user_id, breakpoint) values ('11111111-1111-1111-1111-111111111111', 'desktop') $$,
  '42501', null, 'a stranger cannot write the owner row'
);
reset role;

-- Owner: insert, read, shape checks, one row per breakpoint.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.dashboard_layouts (user_id, breakpoint, items)
values ('11111111-1111-1111-1111-111111111111', 'desktop', '[{"id":"recent","x":0,"y":0,"w":4,"h":5}]');
insert into public.dashboard_layouts (user_id, breakpoint)
values ('11111111-1111-1111-1111-111111111111', 'phone');
select is((select count(*)::int from public.dashboard_layouts), 2, 'owner sees both layouts');
select is(
  (select items from public.dashboard_layouts where breakpoint = 'phone'),
  '[]'::jsonb, 'items default to an empty array'
);
select throws_ok(
  $$ insert into public.dashboard_layouts (user_id, breakpoint) values ('11111111-1111-1111-1111-111111111111', 'desktop') $$,
  '23505', null, 'one row per breakpoint'
);
select throws_ok(
  $$ insert into public.dashboard_layouts (user_id, breakpoint) values ('11111111-1111-1111-1111-111111111111', 'tablet') $$,
  '23514', null, 'breakpoint must be desktop or phone'
);
select throws_ok(
  $$ update public.dashboard_layouts set items = '{"a":1}' where breakpoint = 'phone' $$,
  '23514', null, 'items must be a json array'
);
select throws_ok(
  $$ update public.dashboard_layouts set items = (select jsonb_agg(jsonb_build_object('id', n)) from generate_series(1, 65) n) where breakpoint = 'phone' $$,
  '23514', null, 'items are capped at 64'
);
select throws_ok(
  $$ update public.dashboard_layouts set user_id = '22222222-2222-2222-2222-222222222222' where breakpoint = 'phone' $$,
  '42501', null, 'the owner cannot hand a row to another user'
);
reset role;

-- Compare-and-set: the update matches only while updated_at is the value the caller saw.
-- Row counts are recorded in a temp table (a data-changing statement cannot sit inside a select).
create temp table seen (token timestamptz);
insert into seen select updated_at from public.dashboard_layouts where breakpoint = 'desktop';
create temp table cas (k text primary key, n int);
grant all on seen, cas to authenticated;
select pg_sleep(0.01);
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
do $$
declare n int;
begin
  update public.dashboard_layouts set items = '[{"id":"ugc","x":0,"y":0,"w":4,"h":5}]'
    where breakpoint = 'desktop' and updated_at = (select token from seen);
  get diagnostics n = row_count;
  insert into cas values ('first', n);
  update public.dashboard_layouts set items = '[{"id":"goals","x":0,"y":0,"w":6,"h":4}]'
    where breakpoint = 'desktop' and updated_at = (select token - interval '1 second' from seen);
  get diagnostics n = row_count;
  insert into cas values ('second', n);
end;
$$;
select is((select items->0->>'id' from public.dashboard_layouts where breakpoint = 'desktop'), 'ugc', 'the first save stands');
delete from public.dashboard_layouts where breakpoint = 'desktop';
select is((select count(*)::int from public.dashboard_layouts), 1, 'owner resets one breakpoint');
reset role;
select is((select n from cas where k = 'first'), 1, 'a save with the seen token updates');
select is((select n from cas where k = 'second'), 0, 'a save with a stale token matches nothing');

-- The layout goes away with the owner row.
delete from private.app_owner;
select is((select count(*)::int from public.dashboard_layouts), 0, 'layouts cascade with the owner');
select is(
  (select count(*)::int from pg_policies where tablename = 'dashboard_layouts'),
  4, 'four owner policies, none for anon'
);

select * from finish();
rollback;
