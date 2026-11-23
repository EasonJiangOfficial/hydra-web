-- pgTAP: Personal Brand (0140). The deal flag, the follower table's shape, owner-only RLS, grants,
-- and the Activity listing when 0130 is present.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select has_column('public', 'deals', 'personal_brand', 'deals has personal_brand');
select col_default_is('public', 'deals', 'personal_brand', 'false', 'a deal is UGC work unless flagged');
select col_not_null('public', 'deals', 'personal_brand', 'personal_brand is never null');
select has_table('public', 'personal_brand_followers', 'personal_brand_followers exists');
select is((select relrowsecurity from pg_class where oid = 'public.personal_brand_followers'::regclass), true, 'RLS is on');

-- Grants.
select is(
  (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'personal_brand_followers' and grantee = 'hydra_ro'),
  'SELECT', 'hydra_ro only reads'
);
select is(
  (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'personal_brand_followers' and grantee = 'service_role'),
  'INSERT,SELECT,UPDATE', 'service_role reads and upserts, never deletes'
);
set local role anon;
select throws_ok($$ select * from public.personal_brand_followers $$, '42501', null, 'anon cannot read followers');
reset role;

-- Stranger: reads nothing, writes nothing.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select throws_ok(
  $$ insert into public.personal_brand_followers (day, followers) values ('2026-11-22', 1200) $$,
  '42501', null, 'a non-owner cannot save a follower count'
);
reset role;

-- Owner: one row per day, an upsert replaces it, the checks hold.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.personal_brand_followers (day, followers) values ('2026-11-22', 1200);
insert into public.personal_brand_followers (day, followers) values ('2026-11-22', 1250)
  on conflict (day) do update set followers = excluded.followers;
select is((select followers from public.personal_brand_followers where day = '2026-11-22'), 1250::bigint, 'the owner upserts the day''s count');
select is((select source from public.personal_brand_followers where day = '2026-11-22'), 'manual', 'a typed count is manual');
select throws_ok(
  $$ insert into public.personal_brand_followers (day, followers) values ('2026-11-23', -1) $$,
  '23514', null, 'a negative count is refused'
);
select throws_ok(
  $$ insert into public.personal_brand_followers (day, followers, source) values ('2026-11-23', 10, 'scraped') $$,
  '23514', null, 'an unknown source is refused'
);

-- The flag: a deal the owner flags keeps its posts, and the flag reads back.
insert into public.deals (brand_name, start_date, personal_brand) values ('Personal Brand', '2026-01-01', true);
select is((select personal_brand from public.deals where brand_name = 'Personal Brand'), true, 'a deal can be flagged personal');
reset role;

-- hydra_ro cannot see pgTAP, so it writes to a temp table.
grant hydra_ro to postgres with set true;
create temp table ro_out (n int) on commit drop;
grant all on ro_out to hydra_ro;
set local role hydra_ro;
insert into ro_out select count(*)::int from public.personal_brand_followers;
reset role;
select is((select n from ro_out), 1, 'hydra_ro reads the counts');

-- Activity (0130): the table is listed as logged and carries the capture trigger, where 0130 ran.
select ok(
  to_regclass('private.activity_tables') is null
  or exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.personal_brand_followers'::regclass and t.tgname = '0_activity_capture'
  ),
  'followers are logged for undo when Activity exists'
);

select * from finish();
rollback;
