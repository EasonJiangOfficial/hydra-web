-- pgTAP: businesses (0170). Owner add/delete policies, tax_shape and slug rules, slug and kind fixed
-- after insert, Personal never closed or deleted, a business in use cannot be deleted, closed_on stamps,
-- entities_in_use, and activity capture plus undo for entity insert, update and delete.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(32);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

-- Row rules (as the database owner).
select is((select count(*)::int from public.entities where slug in ('personal', 'ugc', 'ugm')), 3, 'the seeded rows comply');
select throws_ok($$ insert into public.entities (slug, name, kind, tax_shape) values ('x1', 'X', 'business', 'corp') $$,
  '23514', null, 'tax_shape outside the list fails');
select throws_ok($$ insert into public.entities (slug, name, kind) values ('all', 'All', 'business') $$,
  '23514', null, 'the slug all is refused');
select throws_ok($$ insert into public.entities (slug, name, kind) values ('Big-Co', 'Big', 'business') $$,
  '23514', null, 'an upper-case slug is refused');
select throws_ok($$ insert into public.entities (slug, name, kind) values ('-co', 'Co', 'business') $$,
  '23514', null, 'a slug starting with a dash is refused');
select throws_ok($$ insert into public.entities (slug, name, kind) values (repeat('a', 41), 'Long', 'business') $$,
  '23514', null, 'a slug over 40 characters is refused');
select throws_ok($$ insert into public.entities (slug, name, kind) values ('blank', '  ', 'business') $$,
  '23514', null, 'a blank name is refused');
select throws_ok($$ update public.entities set status = 'closed' where slug = 'personal' $$,
  '23514', null, 'Personal cannot be closed');
select throws_ok($$ delete from public.entities where slug = 'personal' $$,
  '23514', 'entities: Personal cannot be deleted', 'Personal cannot be deleted, even by the database owner');
select throws_ok($$ update public.entities set tax_shape = 's_corp' where slug = 'personal' $$,
  '23514', null, 'Personal takes no tax type');
-- A zone whose day differs from the UTC day right now, so a UTC stamp would fail the closed_on check below.
insert into public.settings (user_id) values ('11111111-1111-1111-1111-111111111111') on conflict (user_id) do nothing;
update public.settings set time_zone = case when extract(hour from now() at time zone 'UTC') < 10 then 'Pacific/Pago_Pago' else 'Pacific/Kiritimati' end;

-- The owner's session.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
set local request.headers = '{"x-hydra-activity":"a7000000-0000-4000-8000-000000000001"}';
insert into public.entities (id, slug, name, kind, tax_shape)
values ('e7000000-0000-4000-8000-000000000001', 'studio', 'Studio', 'business', 'llc');
select is((select name from public.entities where slug = 'studio'), 'Studio', 'the owner adds a business');
select throws_ok($$ insert into public.entities (slug, name, kind) values ('me2', 'Me two', 'personal') $$,
  '42501', null, 'the owner cannot add a second Personal');
select throws_ok($$ update public.entities set slug = 'studio-2' where slug = 'studio' $$,
  '23514', 'entities: the slug cannot change', 'the slug is fixed after insert');
select throws_ok($$ update public.entities set kind = 'personal' where slug = 'studio' $$,
  '23514', 'entities: the kind cannot change', 'the kind is fixed after insert');

set local request.headers = '{"x-hydra-activity":"a7000000-0000-4000-8000-000000000002"}';
update public.entities set status = 'closed' where slug = 'studio';
select is((select closed_on is not null from public.entities where slug = 'studio'), true, 'closing stamps closed_on');
select is((select closed_on from public.entities where slug = 'studio'),
  (now() at time zone (select time_zone from public.settings limit 1))::date, 'closed_on is the owner''s day, not the UTC day');
set local request.headers = '{"x-hydra-activity":"a7000000-0000-4000-8000-000000000003"}';
update public.entities set status = 'active', name = 'Studio Co' where slug = 'studio';
select is((select closed_on from public.entities where slug = 'studio'), null, 'reopening clears closed_on');
select is((select count(*)::int from public.entities where slug = 'personal'), 1, 'the owner session sees Personal');
delete from public.entities where slug = 'personal';
select is((select count(*)::int from public.entities where slug = 'personal'), 1, 'the owner session cannot delete Personal');

-- In use: an account, then a rule (fixtures as the database owner).
reset role;
insert into public.accounts (id, kind, name, is_manual, entity_id)
values ('b7000000-0000-4000-8000-000000000001', 'cash', 'Studio checking', true, 'e7000000-0000-4000-8000-000000000001');
set local role authenticated;
select results_eq(
  $$ select in_use, accounts from public.entities_in_use() where id = 'e7000000-0000-4000-8000-000000000001' $$,
  $$ values (true, 1) $$, 'entities_in_use counts the account');
select throws_ok($$ delete from public.entities where slug = 'studio' $$,
  '23503', 'In use: close it instead', 'a business with an account cannot be deleted');
reset role;
delete from public.accounts where id = 'b7000000-0000-4000-8000-000000000001';
insert into public.rules (id, position, conditions, actions)
values ('c7000000-0000-4000-8000-000000000001', 1, '[{"field":"name","op":"contains","value":"studio"}]',
        '[{"type":"set_entity","entityId":"e7000000-0000-4000-8000-000000000001"}]');
set local role authenticated;
select throws_ok($$ delete from public.entities where slug = 'studio' $$,
  '23503', 'In use: close it instead', 'a business a rule points at cannot be deleted');
reset role;
delete from public.rules where id = 'c7000000-0000-4000-8000-000000000001';
set local role authenticated;

-- Unused (a Schedule C map is setup, not use): delete works, takes the map with it, and is logged.
insert into public.category_tax_lines (category_id, entity_id, tax_line_id)
select m.category_id, 'e7000000-0000-4000-8000-000000000001', m.tax_line_id
from public.category_tax_lines m join public.entities e on e.id = m.entity_id where e.slug = 'ugc';
select ok((select count(*) from public.category_tax_lines where entity_id = 'e7000000-0000-4000-8000-000000000001') > 0, 'the owner copies the UGC Schedule C map');
set local request.headers = '{"x-hydra-activity":"a7000000-0000-4000-8000-000000000004"}';
delete from public.entities where slug = 'studio';
select is((select count(*)::int from public.entities where slug = 'studio'), 0, 'an unused business is deleted');
select is((select count(*)::int from public.category_tax_lines where entity_id = 'e7000000-0000-4000-8000-000000000001'), 0, 'its Schedule C map goes with it');

-- The stranger sees and changes nothing.
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
set local request.headers = '{}';
select throws_ok($$ insert into public.entities (slug, name, kind) values ('evil', 'Evil', 'business') $$,
  '42501', null, 'a stranger cannot add a business');
select is((select count(*)::int from public.entities_in_use()), 0, 'a stranger reads nothing from entities_in_use');

set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select results_eq(
  $$ select r.op from public.activity_rows r
     where r.tbl = 'entities' and r.activity_id in ('a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002',
       'a7000000-0000-4000-8000-000000000003', 'a7000000-0000-4000-8000-000000000004')
       and r.tbl = 'entities' order by r.seq $$,
  $$ values ('insert'::text), ('update'), ('update'), ('delete') $$,
  'activity logs the entity insert, the close, the reopen and the delete');
select is((public.undo_activity('a7000000-0000-4000-8000-000000000004') ->> 'ok')::boolean, true, 'undo of the delete succeeds');
select is((select name from public.entities where slug = 'studio'), 'Studio Co', 'undo puts the business back');
select ok((select count(*) from public.category_tax_lines where entity_id = 'e7000000-0000-4000-8000-000000000001') > 0, 'undo puts its Schedule C map back');
select is((public.undo_activity('a7000000-0000-4000-8000-000000000003') ->> 'ok')::boolean, true, 'undo of the rename succeeds');
reset role;

select * from finish();
rollback;
