-- pgTAP: payout matching tables (0145). Owner-only RLS, explicit grants, one "Not this" per deal and
-- deposit, one rule per deal and payer, shape checks, cascades. Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(18);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

insert into public.accounts (id, kind, name, is_manual) values ('b4500000-0000-4000-8000-000000000001', 'cash', 'Checking', true);
insert into public.transactions (id, account_id, posted_on, amount_cents, name, source) values
  ('f4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001', '2026-11-01', 120000, 'PAYPAL TRANSFER 1001', 'manual'),
  ('f4500000-0000-4000-8000-000000000002', 'b4500000-0000-4000-8000-000000000001', '2026-11-02', 50000, 'WIRE FROM CHOICE FINANCIAL', 'manual');
insert into public.deals (id, brand_name, start_date) values
  ('d4500000-0000-4000-8000-000000000001', 'Wordwise', '2026-09-01'),
  ('d4500000-0000-4000-8000-000000000002', 'Brightleaf', '2026-09-01');

select is(
  (select count(*)::int from pg_tables where schemaname = 'public' and rowsecurity
     and tablename in ('payout_match_rejections', 'payout_rules')),
  2, 'RLS is on for both tables'
);
select is(
  (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'payout_match_rejections' and grantee = 'authenticated'),
  'DELETE,INSERT,SELECT', 'authenticated may add, read and remove a Not this'
);
select is(
  (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'payout_rules' and grantee = 'authenticated'),
  'DELETE,INSERT,SELECT,UPDATE', 'authenticated holds only the four DML privileges on rules'
);
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('payout_match_rejections', 'payout_rules') and grantee in ('anon', 'service_role')),
  0, 'anon and service_role hold nothing'
);

set local role anon;
select throws_ok($$ select * from public.payout_rules $$, '42501', null, 'anon cannot read rules');
reset role;

-- Stranger: writes nothing, reads nothing.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select throws_ok(
  $$ insert into public.payout_match_rejections (deal_id, transaction_id)
     values ('d4500000-0000-4000-8000-000000000001', 'f4500000-0000-4000-8000-000000000001') $$,
  '42501', null, 'a non-owner cannot say Not this'
);
select throws_ok(
  $$ insert into public.payout_rules (deal_id, payer_key, decision)
     values ('d4500000-0000-4000-8000-000000000001', 'paypal transfer', 'accepted') $$,
  '42501', null, 'a non-owner cannot add a rule'
);
reset role;

-- Owner.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.payout_match_rejections (deal_id, transaction_id)
values ('d4500000-0000-4000-8000-000000000001', 'f4500000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.payout_match_rejections), 1, 'the owner records a Not this');
select throws_ok(
  $$ insert into public.payout_match_rejections (deal_id, transaction_id)
     values ('d4500000-0000-4000-8000-000000000001', 'f4500000-0000-4000-8000-000000000002') $$,
  '23505', null, 'one Not this per deal and deposit'
);
insert into public.payout_match_rejections (deal_id, transaction_id)
values ('d4500000-0000-4000-8000-000000000002', 'f4500000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.payout_match_rejections), 2, 'the same deposit can be refused for another deal');

insert into public.payout_rules (deal_id, payer_key, day_of_month, decision)
values ('d4500000-0000-4000-8000-000000000001', 'paypal transfer', 1, 'accepted');
select is((select day_window from public.payout_rules), 3, 'the day window defaults to 3');
select throws_ok(
  $$ insert into public.payout_rules (deal_id, payer_key, decision)
     values ('d4500000-0000-4000-8000-000000000001', 'paypal transfer', 'declined') $$,
  '23505', null, 'one rule per deal and payer'
);
select throws_ok(
  $$ insert into public.payout_rules (deal_id, payer_key, decision)
     values ('d4500000-0000-4000-8000-000000000002', 'paypal transfer', 'maybe') $$,
  '23514', null, 'the decision is accepted or declined'
);
select throws_ok(
  $$ insert into public.payout_rules (deal_id, payer_key, day_of_month, decision)
     values ('d4500000-0000-4000-8000-000000000002', 'zelle', 32, 'accepted') $$,
  '23514', null, 'the day of the month is 1 to 31'
);
select throws_ok(
  $$ insert into public.payout_rules (deal_id, payer_key, decision)
     values ('d4500000-0000-4000-8000-000000000002', '', 'accepted') $$,
  '23514', null, 'the payer key is not empty'
);
reset role;

-- Cascades: a deleted deposit drops its Not this; a deleted deal drops its rules.
delete from public.transactions where id = 'f4500000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.payout_match_rejections), 0, 'deleting the deposit drops its Not this rows');
delete from public.deals where id = 'd4500000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.payout_rules), 0, 'deleting the deal drops its rules');

-- Activity (0130): both tables carry the capture trigger, where 0130 ran.
select ok(
  to_regclass('private.activity_tables') is null
  or (select count(*) from pg_trigger t
      where t.tgname = '0_activity_capture'
        and t.tgrelid in ('public.payout_match_rejections'::regclass, 'public.payout_rules'::regclass)) = 2,
  'Not this answers and payout rules are logged for undo when Activity exists'
);

select * from finish();
rollback;
