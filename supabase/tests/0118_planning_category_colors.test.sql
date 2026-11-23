-- pgTAP: planning_category_colors (0118). Owner-only RLS, hex check, hydra_ro reads only.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(11);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select has_pk('public', 'planning_category_colors', 'the category text is the key');

-- The owner sets, recolors and clears a category's color.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok(
  $$ insert into public.planning_category_colors (category, color) values ('UGC', '#4f7cb8') $$,
  'the owner colors a category'
);
select lives_ok(
  $$ insert into public.planning_category_colors (category, color) values ('UGC', '#5f8a5b')
     on conflict (category) do update set color = excluded.color, updated_at = now() $$,
  'the owner recolors it (upsert)'
);
select is((select color from public.planning_category_colors where category = 'UGC'), '#5f8a5b', 'one row, the new color');
select throws_ok(
  $$ insert into public.planning_category_colors (category, color) values ('Taxes', 'red') $$,
  '23514', null, 'a color must be #rrggbb'
);
select throws_ok(
  $$ insert into public.planning_category_colors (category, color) values ('   ', '#4f7cb8') $$,
  '23514', null, 'a category must not be blank'
);
insert into public.planning_category_colors (category, color) values ('Money', '#c29a2e');
reset role;

-- A stranger sees and changes nothing.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.planning_category_colors), 0, 'stranger sees zero colors');
select throws_ok(
  $$ insert into public.planning_category_colors (category, color) values ('Hydra', '#4f7cb8') $$,
  '42501', null, 'stranger cannot color a category'
);
update public.planning_category_colors set color = '#000000';
delete from public.planning_category_colors;
reset role;
select is((select count(*)::int from public.planning_category_colors where color <> '#000000'), 2, 'stranger update and delete changed nothing');

set local role anon;
select throws_ok($$ select * from public.planning_category_colors $$, '42501', null, 'anon cannot read colors');
reset role;

-- hydra_ro: reads, cannot write.
grant hydra_ro to postgres with set true;
create temp table ro_out (k text primary key, v text) on commit drop;
grant all on ro_out to hydra_ro;
set local role hydra_ro;
insert into ro_out select 'read', count(*)::text from public.planning_category_colors;
do $$
begin
  delete from public.planning_category_colors;
  insert into ro_out values ('write', 'allowed');
exception when others then
  insert into ro_out values ('write', sqlstate);
end;
$$;
reset role;
select is((select v from ro_out where k = 'read') || '/' || (select v from ro_out where k = 'write'), '2/42501', 'hydra_ro reads both colors and cannot delete');

select * from finish();
rollback;
