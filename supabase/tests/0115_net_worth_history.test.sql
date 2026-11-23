-- pgTAP: balance history walked back from real balances through posted transactions (0115).
-- Every expected number below was added up by hand. "Today" is 2026-03-01.
-- Run: supabase test db
--
-- Accounts (the 0115 signs: cash value(d) = value(A) - S; card owed(d) = owed(A) + S, where A is
-- the next real balance on or after d and S the posted amounts dated after d up to A):
--   C1 cash, personal. Real 300000 on 02-01 (on purpose not what the walk-back from 03-01 gives:
--      348000) and 500000 on 03-01. Rows: -1000 every day 01-01..03-01 (60 days), +250000 on 01-15
--      and 02-15, -30000 hidden on 02-20, -40000 transfer on 02-25, -99999 PENDING on 03-01.
--   K1 card, personal. Owed 20000 on 03-01. Rows: -1500 on 01-05, 01-10, 01-20, 02-05, 02-10, 02-20;
--      +500 hidden refund on 02-12; +40000 payment (transfer) on 02-25.
--   L1 cash, UGC. 100000 on 03-01. First row +60000 on 02-15, then -5000 on 02-20.
--   M1 asset, personal, manual, no rows. 1000000 on 01-10.
--   K2 card, personal, closed 2026-02-10. Owed 7000 on 01-05, no rows.
--   N1 cash, personal, NOT in net worth. 999999 on 03-01, +1 on 02-01.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(35);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test')
on conflict (id) do nothing;
select is(public.bootstrap_owner('11111111-1111-1111-1111-111111111111'), 'created', 'the owner exists');

create function pg_temp.ent(s text) returns uuid language sql stable as $$ select id from public.entities where slug = s $$;
create function pg_temp.a(n text) returns uuid language sql immutable as $$ select ('bbbbbbbb-0000-0000-0000-' || lpad(n, 12, '0'))::uuid $$;
create function pg_temp.bal(acct text, d date) returns bigint language sql stable as
  $$ select current_cents from public.account_balance_history(pg_temp.a(acct)) where as_of = d $$;
create function pg_temp.est(acct text, d date) returns boolean language sql stable as
  $$ select estimated from public.account_balance_history(pg_temp.a(acct)) where as_of = d $$;

insert into public.accounts (id, kind, name, is_manual, entity_id, in_net_worth, closed_at) values
  (pg_temp.a('1'), 'cash', 'C1 checking', true, pg_temp.ent('personal'), true, null),
  (pg_temp.a('2'), 'card', 'K1 card', true, pg_temp.ent('personal'), true, null),
  (pg_temp.a('3'), 'cash', 'L1 UGC checking', true, pg_temp.ent('ugc'), true, null),
  (pg_temp.a('4'), 'asset', 'M1 home', true, pg_temp.ent('personal'), true, null),
  (pg_temp.a('5'), 'card', 'K2 old card', true, pg_temp.ent('personal'), true, '2026-02-10 12:00:00+00'),
  (pg_temp.a('6'), 'cash', 'N1 brokerage', true, pg_temp.ent('personal'), false, null);

insert into public.balances (account_id, as_of, current_cents) values
  (pg_temp.a('1'), '2026-02-01', 300000),
  (pg_temp.a('1'), '2026-03-01', 500000),
  (pg_temp.a('2'), '2026-03-01', 20000),
  (pg_temp.a('3'), '2026-03-01', 100000),
  (pg_temp.a('4'), '2026-01-10', 1000000),
  (pg_temp.a('5'), '2026-01-05', 7000),
  (pg_temp.a('6'), '2026-03-01', 999999);

insert into public.transactions (account_id, posted_on, amount_cents, name, source, entity_id, hidden, is_transfer, pending)
select pg_temp.a('1'), d::date, -1000, 'Coffee', 'manual', pg_temp.ent('personal'), false, false, false
from generate_series('2026-01-01'::date, '2026-03-01'::date, interval '1 day') d;
insert into public.transactions (account_id, posted_on, amount_cents, name, source, entity_id, hidden, is_transfer, pending) values
  (pg_temp.a('1'), '2026-01-15', 250000, 'Paycheck', 'manual', pg_temp.ent('personal'), false, false, false),
  (pg_temp.a('1'), '2026-02-15', 250000, 'Paycheck', 'manual', pg_temp.ent('personal'), false, false, false),
  (pg_temp.a('1'), '2026-02-20', -30000, 'Hidden', 'manual', pg_temp.ent('personal'), true, false, false),
  (pg_temp.a('1'), '2026-02-25', -40000, 'Card payment', 'manual', pg_temp.ent('personal'), false, true, false),
  (pg_temp.a('1'), '2026-03-01', -99999, 'Pending', 'manual', pg_temp.ent('personal'), false, false, true),
  (pg_temp.a('2'), '2026-01-05', -1500, 'Buy', 'manual', pg_temp.ent('personal'), false, false, false),
  (pg_temp.a('2'), '2026-01-10', -1500, 'Buy', 'manual', pg_temp.ent('personal'), false, false, false),
  (pg_temp.a('2'), '2026-01-20', -1500, 'Buy', 'manual', pg_temp.ent('personal'), false, false, false),
  (pg_temp.a('2'), '2026-02-05', -1500, 'Buy', 'manual', pg_temp.ent('personal'), false, false, false),
  (pg_temp.a('2'), '2026-02-10', -1500, 'Buy', 'manual', pg_temp.ent('personal'), false, false, false),
  (pg_temp.a('2'), '2026-02-20', -1500, 'Buy', 'manual', pg_temp.ent('personal'), false, false, false),
  (pg_temp.a('2'), '2026-02-12', 500, 'Refund', 'manual', pg_temp.ent('personal'), true, false, false),
  (pg_temp.a('2'), '2026-02-25', 40000, 'Payment', 'manual', pg_temp.ent('personal'), false, true, false),
  (pg_temp.a('3'), '2026-02-15', 60000, 'Brand deal', 'manual', pg_temp.ent('ugc'), false, false, false),
  (pg_temp.a('3'), '2026-02-20', -5000, 'Software', 'manual', pg_temp.ent('ugc'), false, false, false),
  (pg_temp.a('6'), '2026-02-01', 1, 'Dividend', 'manual', pg_temp.ent('personal'), false, false, false);

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('account_balance_days', 'net_worth_history', 'account_balance_history')
     and not p.prosecdef and p.provolatile = 's'),
  3, 'three history functions, all security invoker and STABLE'
);
select is(has_function_privilege('anon', 'public.net_worth_history(text,date,date)', 'execute'), false, 'anon cannot read net worth history');
select is(has_function_privilege('hydra_ro', 'public.account_balance_history(uuid,date,date)', 'execute'), true, 'hydra_ro can read balance history');

-- ---------------------------------------------------------------------------
-- One account: cash (C1). Hidden and transfer rows count, pending does not.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.account_balance_history(pg_temp.a('1'))), 60, 'C1 history: first row 01-01 to last real balance 03-01');
select is(pg_temp.bal('1', '2026-03-01'), 500000::bigint, 'C1 03-01: the real balance');
select is(pg_temp.est('1', '2026-03-01'), false, 'C1 03-01: not estimated');
select is(pg_temp.bal('1', '2026-02-28'), 501000::bigint, 'C1 02-28: 500000 - (-1000); the pending -99999 is ignored');
select is(pg_temp.bal('1', '2026-02-21'), 548000::bigint, 'C1 02-21: 500000 - (8 x -1000 - 40000 transfer)');
select is(pg_temp.bal('1', '2026-02-19'), 580000::bigint, 'C1 02-19: 500000 - (10 x -1000 - 30000 hidden - 40000 transfer)');
select is(pg_temp.bal('1', '2026-02-14'), 335000::bigint, 'C1 02-14: 500000 - (15 x -1000 + 250000 - 30000 - 40000)');
select is(pg_temp.bal('1', '2026-02-01'), 300000::bigint, 'C1 02-01: the mid-history real balance is used on its day');
select is(pg_temp.est('1', '2026-02-01'), false, 'C1 02-01: a real day is not estimated');
select is(pg_temp.bal('1', '2026-01-31'), 301000::bigint, 'C1 01-31: anchored on the 02-01 real balance');
select is(pg_temp.bal('1', '2026-01-14'), 68000::bigint, 'C1 01-14: 300000 - (18 x -1000 + 250000)');
select is(pg_temp.est('1', '2026-01-14'), true, 'C1 01-14: estimated');

-- ---------------------------------------------------------------------------
-- A card (K1): owed grows by purchases backwards, drops by payments.
-- ---------------------------------------------------------------------------
select is(pg_temp.bal('2', '2026-02-24'), 60000::bigint, 'K1 02-24: owed 20000 + 40000 payment after it');
select is(pg_temp.bal('2', '2026-02-11'), 59000::bigint, 'K1 02-11: 20000 + (500 hidden - 1500 + 40000)');
select is(pg_temp.bal('2', '2026-01-05'), 53000::bigint, 'K1 01-05 (its first row): 20000 + (5 x -1500 + 500 + 40000)');

-- ---------------------------------------------------------------------------
-- An account whose first row comes later (L1) is flat before it; a manual one (M1) is flat.
-- ---------------------------------------------------------------------------
select is(
  (select count(distinct current_cents)::int from public.account_balance_days(array[pg_temp.a('3')], '2026-01-01', '2026-02-14')),
  1, 'L1 is one flat value before its first row'
);
select is(
  (select current_cents from public.account_balance_days(array[pg_temp.a('3')], '2026-01-01', '2026-03-01') where day = '2026-01-01'),
  45000::bigint, 'L1 before its first row: 100000 - (60000 - 5000)'
);
select is(
  (select count(*)::int from public.account_balance_history(pg_temp.a('4'))), 1,
  'M1 (manual, no rows) has its one real day'
);

-- ---------------------------------------------------------------------------
-- Net worth: starts at the first row of any account in scope, sums right, flags estimates.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int || ' ' || min(day)::text from public.net_worth_history('all', '2025-12-01', '2026-03-01')),
  '60 2026-01-01', 'net worth starts at the first transaction (01-01), one row per day'
);
select results_eq(
  $$ select day, assets_cents, debts_cents, net_cents, cardinality(account_ids), estimated
     from public.net_worth_history('all', '2025-12-01', '2026-03-03')
     where day in ('2026-01-01', '2026-02-01', '2026-02-10', '2026-03-01', '2026-03-03') order by day $$,
  $$ values
    ('2026-01-01'::date, 1126000::bigint, 58500::bigint, 1067500::bigint, 5, true),
    ('2026-02-01', 1345000, 63000, 1282000, 5, true),
    ('2026-02-10', 1384000, 59000, 1325000, 4, true),
    ('2026-03-01', 1600000, 20000, 1580000, 4, false),
    ('2026-03-03', 1600000, 20000, 1580000, 4, false) $$,
  'net worth per day: C1 + L1 + M1 - K1 - K2; K2 drops out on its closing day; N1 never counts'
);
select results_eq(
  $$ select day, net_cents from public.net_worth_history('ugc', '2026-01-01', '2026-03-01') where day in ('2026-02-15', '2026-02-20') order by day $$,
  $$ values ('2026-02-15'::date, 105000::bigint), ('2026-02-20', 100000) $$,
  'scope ugc: L1 only (100000 - (-5000), then real-anchored)'
);
select is(
  (select min(day)::text from public.net_worth_history('ugc', '2025-12-01', '2026-03-01')),
  '2026-02-15', 'scope ugc starts at its own first row'
);
select is(
  (select net_cents from public.net_worth_history('personal', '2026-01-01', '2026-01-01')),
  1022500::bigint, 'scope personal on 01-01: 81000 + 1000000 - 51500 - 7000'
);

-- ---------------------------------------------------------------------------
-- RLS: a stranger sees nothing; hydra_ro reads.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.net_worth_history('all', '2026-01-01', '2026-03-01')), 0, 'a stranger gets no net worth history');
reset role;
grant hydra_ro to postgres with set true;
create temp table ro_out (k text primary key, v text) on commit drop;
grant all on ro_out to hydra_ro;
set local role hydra_ro;
insert into ro_out select 'nw', net_cents::text from public.net_worth_history('all', '2026-01-01', '2026-01-01');
reset role;
select is((select v from ro_out where k = 'nw'), '1067500', 'hydra_ro reads net worth history');

-- ---------------------------------------------------------------------------
-- A real balance dated after the owner's today (M2, manual asset, no rows: 500 thirty days ago,
-- 777 typed in for sixty days ahead) is not in effect yet: today stays 500 and real, as in 0050.
-- ---------------------------------------------------------------------------
create function pg_temp.today() returns date language sql stable as
  $$ select (now() at time zone coalesce((select s.time_zone from public.settings s limit 1), 'UTC'))::date $$;
insert into public.accounts (id, kind, name, is_manual, entity_id, in_net_worth) values
  (pg_temp.a('7'), 'asset', 'M2 car', true, pg_temp.ent('personal'), true);
insert into public.balances (account_id, as_of, current_cents) values
  (pg_temp.a('7'), pg_temp.today() - 30, 500),
  (pg_temp.a('7'), pg_temp.today() + 60, 777);
select is(
  (select array_agg(distinct current_cents)::text || ' ' || bool_or(estimated)::text
   from public.account_balance_days(array[pg_temp.a('7')], pg_temp.today() - 3, pg_temp.today())),
  '{500} false', 'M2 up to today: flat at the real 500, not estimated; the future 777 does not flow back'
);
select is(
  (select array_agg(current_cents order by day)::text
   from public.account_balance_days(array[pg_temp.a('7')], pg_temp.today() + 59, pg_temp.today() + 61)),
  '{500,777,777}', 'M2: the future balance counts from its own day on'
);
select is(
  (select net_cents::text || ' ' || estimated::text from public.net_worth_history('all', pg_temp.today(), pg_temp.today())),
  '1580500 false', 'net worth today: 1580000 + M2 500, and today is not marked estimated'
);
select is(
  (select max(as_of)::text || ' ' || count(*) filter (where estimated)::text from public.account_balance_history(pg_temp.a('7'))),
  (pg_temp.today() + 60)::text || ' 0', 'M2 history: no estimated day, ends on the future balance'
);
delete from public.balances where account_id = pg_temp.a('7');
delete from public.accounts where id = pg_temp.a('7');

-- ---------------------------------------------------------------------------
-- Timing: 730 days x 20 accounts with 5,000 transactions.
-- ---------------------------------------------------------------------------
insert into public.accounts (id, kind, name, is_manual, entity_id)
select pg_temp.a((100 + i)::text), case when i % 4 = 0 then 'card' else 'cash' end, 'Perf ' || i, true, pg_temp.ent('personal')
from generate_series(1, 20) i;
insert into public.balances (account_id, as_of, current_cents)
select pg_temp.a((100 + i)::text), '2026-03-01', 100000 * i from generate_series(1, 20) i;
insert into public.transactions (account_id, posted_on, amount_cents, name, source, entity_id)
select pg_temp.a((101 + (n % 20))::text), '2026-03-01'::date - (n % 730), (n % 9 - 5) * 1000, 'Perf', 'manual', pg_temp.ent('personal')
from generate_series(1, 5000) n;
analyze public.transactions;
analyze public.balances;
create temp table t0 on commit drop as select clock_timestamp() as t;
create temp table perf on commit drop as select * from public.net_worth_history('all', '2024-03-02', '2026-03-01');
select is((select count(*)::int from perf), 730, 'timing run: 730 days');
select cmp_ok(
  (select extract(epoch from clock_timestamp() - t) from t0)::numeric, '<', 1::numeric,
  'net worth over 730 days x 26 accounts and 5,000+ rows runs under 1 s'
);

select * from finish();
rollback;
