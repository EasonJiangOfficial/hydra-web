-- pgTAP: reports queries. A hand-checked fixture (every expected number below was added up by hand)
-- proves net worth, the Sankey links, spending by category, income by payer, the monthly trend, tax
-- line totals and the income summary to the cent, and that the views and functions obey RLS.
-- Run: supabase test db
--
-- Fixture, January 2026 unless a date says otherwise. Each row is a transaction, T<n>:
--   Personal  T1 +3000.00 Acme Corp (Paycheck) | T2 +3000.00 'acme corp ' (Paycheck, same payer)
--             T3 -1200.00 Rent (Housing) | T4 -42.00 Groceries (Food) | T5 -30.00 Dining out (Food)
--             T6 +10.00 refund in Dining out (Food: Food nets 62.00) | T7 -500.00 Taxes
--             T8 -9.99 no category | T9 +5.00 Venmo, no category
--             T10 and T11 transfer pair (is_transfer) | T12 -300.00 'Card payments' (transfer kind)
--             T13 -7.77 Groceries, hidden
--   UGC       T14 +2000.00 BrandCo (Brand deals) | T15 +1500.00 TikTok (Platform payouts)
--             T16 -25.00 Software and apps (line 18) | T17 -100.00 Advertising (line 8)
--             T18 -40.00 Software and apps with the tax line set by hand to 27b
--             T19 -15.00 Advertising on 2025-12-30 | T20 +500.00 BrandCo on 2026-02-03
--             T21 -60.00 Equipment (line 22) on 2026-02-04
--   Personal  T22 -20.00 Groceries on 2026-02-05
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(75);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test')
on conflict (id) do nothing;
select is(public.bootstrap_owner('11111111-1111-1111-1111-111111111111'), 'created', 'the owner exists');

-- Helpers (session only): a transaction id by number, a category id by name, a tax line id by code.
create function pg_temp.tid(n int) returns uuid language sql immutable as
  $$ select ('e0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.cid(n text) returns uuid language sql stable as
  $$ select c.id from public.categories c where c.name = n and c.entity_id is not distinct from
       (select e.id from public.entities e where e.slug = case
          when n in ('Brand deals', 'Platform payouts', 'Software and apps', 'Advertising', 'Equipment') then 'ugc'
          when n = 'Card payments' then 'shared'
          else 'personal' end) $$;
create function pg_temp.tl(text) returns uuid language sql stable as
  $$ select t.id from public.tax_lines t where t.schedule = 'C' and t.code = $1 $$;
create function pg_temp.ids(a uuid[]) returns text language sql immutable as
  $$ select coalesce(string_agg(x::text, ',' order by x), '') from unnest(a) x $$;

-- Accounts. A6 is outside net worth; A7 is a card closed on 2026-02-01.
insert into public.accounts (id, kind, name, is_manual, entity_id, in_net_worth, closed_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cash', 'Checking', true, (select id from public.entities where slug = 'personal'), true, null),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'cash', 'Savings', true, (select id from public.entities where slug = 'personal'), true, null),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'card', 'Card', true, (select id from public.entities where slug = 'personal'), true, null),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'cash', 'UGC checking', true, (select id from public.entities where slug = 'ugc'), true, null),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'asset', 'Home', true, (select id from public.entities where slug = 'personal'), true, null),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'cash', 'Brokerage', true, (select id from public.entities where slug = 'personal'), false, null),
  ('aaaaaaaa-0000-0000-0000-000000000007', 'card', 'Old card', true, (select id from public.entities where slug = 'personal'), true, '2026-02-01 12:00:00+00');

insert into public.balances (account_id, as_of, current_cents) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '2026-01-01', 100000),
  ('aaaaaaaa-0000-0000-0000-000000000001', '2026-01-15', 150000),
  ('aaaaaaaa-0000-0000-0000-000000000001', '2026-02-10', 120000),
  ('aaaaaaaa-0000-0000-0000-000000000002', '2026-01-01', 500000),
  ('aaaaaaaa-0000-0000-0000-000000000003', '2026-01-01', 20000),
  ('aaaaaaaa-0000-0000-0000-000000000003', '2026-01-20', 35000),
  ('aaaaaaaa-0000-0000-0000-000000000004', '2026-01-10', 80000),
  ('aaaaaaaa-0000-0000-0000-000000000005', '2026-01-05', 2500000),
  ('aaaaaaaa-0000-0000-0000-000000000006', '2026-01-01', 999999),
  ('aaaaaaaa-0000-0000-0000-000000000007', '2026-01-01', 7777);

insert into public.transactions
  (id, account_id, posted_on, amount_cents, name, merchant, source, category_id, category_source, is_transfer, hidden, tax_line_id)
values
  (pg_temp.tid(1), 'aaaaaaaa-0000-0000-0000-000000000001', '2026-01-02', 300000, 'ACME PAYROLL 1', 'Acme Corp', 'manual', pg_temp.cid('Paycheck'), 'manual', false, false, null),
  (pg_temp.tid(2), 'aaaaaaaa-0000-0000-0000-000000000001', '2026-01-16', 300000, 'ACME PAYROLL 2', 'acme corp ', 'manual', pg_temp.cid('Paycheck'), 'manual', false, false, null),
  (pg_temp.tid(3), 'aaaaaaaa-0000-0000-0000-000000000001', '2026-01-03', -120000, 'Landlord', null, 'manual', pg_temp.cid('Rent'), 'manual', false, false, null),
  (pg_temp.tid(4), 'aaaaaaaa-0000-0000-0000-000000000001', '2026-01-05', -4200, 'Whole Foods', null, 'manual', pg_temp.cid('Groceries'), 'manual', false, false, null),
  (pg_temp.tid(5), 'aaaaaaaa-0000-0000-0000-000000000003', '2026-01-06', -3000, 'Cafe', null, 'manual', pg_temp.cid('Dining out'), 'manual', false, false, null),
  (pg_temp.tid(6), 'aaaaaaaa-0000-0000-0000-000000000003', '2026-01-07', 1000, 'Cafe refund', null, 'manual', pg_temp.cid('Dining out'), 'manual', false, false, null),
  (pg_temp.tid(7), 'aaaaaaaa-0000-0000-0000-000000000001', '2026-01-10', -50000, 'IRS', null, 'manual', pg_temp.cid('Taxes'), 'manual', false, false, null),
  (pg_temp.tid(8), 'aaaaaaaa-0000-0000-0000-000000000001', '2026-01-12', -999, 'Mystery', null, 'manual', null, 'none', false, false, null),
  (pg_temp.tid(9), 'aaaaaaaa-0000-0000-0000-000000000001', '2026-01-13', 500, 'Venmo', null, 'manual', null, 'none', false, false, null),
  (pg_temp.tid(10), 'aaaaaaaa-0000-0000-0000-000000000001', '2026-01-14', -20000, 'Transfer out', null, 'manual', null, 'none', true, false, null),
  (pg_temp.tid(11), 'aaaaaaaa-0000-0000-0000-000000000002', '2026-01-14', 20000, 'Transfer in', null, 'manual', null, 'none', true, false, null),
  (pg_temp.tid(12), 'aaaaaaaa-0000-0000-0000-000000000001', '2026-01-15', -30000, 'Card payment', null, 'manual', pg_temp.cid('Card payments'), 'manual', false, false, null),
  (pg_temp.tid(13), 'aaaaaaaa-0000-0000-0000-000000000001', '2026-01-17', -777, 'Hidden groceries', null, 'manual', pg_temp.cid('Groceries'), 'manual', false, true, null),
  (pg_temp.tid(14), 'aaaaaaaa-0000-0000-0000-000000000004', '2026-01-08', 200000, 'BRANDCO PAY', 'BrandCo', 'manual', pg_temp.cid('Brand deals'), 'manual', false, false, null),
  (pg_temp.tid(15), 'aaaaaaaa-0000-0000-0000-000000000004', '2026-01-20', 150000, 'TIKTOK PAYOUT', 'TikTok', 'manual', pg_temp.cid('Platform payouts'), 'manual', false, false, null),
  (pg_temp.tid(16), 'aaaaaaaa-0000-0000-0000-000000000004', '2026-01-22', -2500, 'Editing app', null, 'manual', pg_temp.cid('Software and apps'), 'manual', false, false, null),
  (pg_temp.tid(17), 'aaaaaaaa-0000-0000-0000-000000000004', '2026-01-25', -10000, 'Ad spend', null, 'manual', pg_temp.cid('Advertising'), 'manual', false, false, null),
  (pg_temp.tid(18), 'aaaaaaaa-0000-0000-0000-000000000004', '2026-01-26', -4000, 'Cloud storage', null, 'manual', pg_temp.cid('Software and apps'), 'manual', false, false, pg_temp.tl('27b')),
  (pg_temp.tid(19), 'aaaaaaaa-0000-0000-0000-000000000004', '2025-12-30', -1500, 'Ad spend Dec', null, 'manual', pg_temp.cid('Advertising'), 'manual', false, false, null),
  (pg_temp.tid(20), 'aaaaaaaa-0000-0000-0000-000000000004', '2026-02-03', 50000, 'BRANDCO PAY 2', 'BrandCo', 'manual', pg_temp.cid('Brand deals'), 'manual', false, false, null),
  (pg_temp.tid(21), 'aaaaaaaa-0000-0000-0000-000000000004', '2026-02-04', -6000, 'Tripod', null, 'manual', pg_temp.cid('Equipment'), 'manual', false, false, null),
  (pg_temp.tid(22), 'aaaaaaaa-0000-0000-0000-000000000001', '2026-02-05', -2000, 'Whole Foods', null, 'manual', pg_temp.cid('Groceries'), 'manual', false, false, null);

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select is(
  (select 'security_invoker=true' = any (reloptions) from pg_class where oid = 'public.reports_flow'::regclass),
  true, 'reports_flow is a security_invoker view (RLS of the caller applies)'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'reports\_%' and not p.prosecdef and p.provolatile = 's'),
  7, 'seven report functions, all security invoker and STABLE'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'reports\_%' and p.prosecdef),
  0, 'no report function is security definer'
);
select is(has_function_privilege('anon', 'public.reports_cash_flow(text,date,date)', 'execute'), false, 'anon cannot run reports');
select is(has_function_privilege('hydra_ro', 'public.reports_cash_flow(text,date,date)', 'execute'), true, 'hydra_ro can run reports');
select is(has_table_privilege('anon', 'public.reports_flow', 'select'), false, 'anon cannot read the flow view');

-- The flow view: what counts. T10 and T11 (is_transfer), T12 (transfer kind) and T13 (hidden) do not.
select is((select count(*)::int from public.reports_flow), 18, 'the flow view holds the 18 rows that count');
select is(
  (select count(*)::int from public.reports_flow where id in (pg_temp.tid(10), pg_temp.tid(11), pg_temp.tid(12), pg_temp.tid(13))),
  0, 'transfers, card payments and hidden rows are left out'
);
select results_eq(
  $$ select kind, cents from public.reports_flow where id in (pg_temp.tid(6), pg_temp.tid(8), pg_temp.tid(9)) order by id $$,
  $$ values ('expense'::text, -1000::bigint), ('expense', 999), ('income', 500) $$,
  'a refund in an expense category is negative spending; uncategorized rows count by sign'
);
select is(
  (select tax_line_id from public.reports_flow where id = pg_temp.tid(18)), pg_temp.tl('27b'),
  'a tax line set on the row beats its category''s line'
);
select is(
  (select tax_line_id from public.reports_flow where id = pg_temp.tid(16)), pg_temp.tl('18'),
  'a row without its own tax line takes its category''s line'
);

-- ---------------------------------------------------------------------------
-- Net worth
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.reports_net_worth('all', '2026-01-01', '2026-02-10')), 41, 'net worth: one row per day');
select results_eq(
  $$ select day, assets_cents, debts_cents, net_cents, cardinality(account_ids)
     from public.reports_net_worth('all', '2026-01-01', '2026-02-10')
     where day in ('2026-01-01', '2026-01-05', '2026-01-10', '2026-01-20', '2026-02-01', '2026-02-10') order by day $$,
  $$ values
    ('2026-01-01'::date, 600000::bigint, 27777::bigint, 572223::bigint, 4),
    ('2026-01-05', 3100000, 27777, 3072223, 5),
    ('2026-01-10', 3180000, 27777, 3152223, 6),
    ('2026-01-20', 3230000, 42777, 3187223, 6),
    ('2026-02-01', 3230000, 35000, 3195000, 5),
    ('2026-02-10', 3200000, 35000, 3165000, 5) $$,
  'net worth: latest balance on or before each day; cards are debts; a closed card drops out on its closing day'
);
select is(
  (select pg_temp.ids(account_ids) from public.reports_net_worth('all', '2026-02-10', '2026-02-10')),
  'aaaaaaaa-0000-0000-0000-000000000001,aaaaaaaa-0000-0000-0000-000000000002,aaaaaaaa-0000-0000-0000-000000000003,'
  || 'aaaaaaaa-0000-0000-0000-000000000004,aaaaaaaa-0000-0000-0000-000000000005',
  'net worth returns the account ids it used (no brokerage outside net worth, no closed card)'
);
select results_eq(
  $$ select net_cents from public.reports_net_worth('ugc', '2026-01-10', '2026-01-10') $$,
  $$ values (80000::bigint) $$, 'net worth: scope ugc is the UGC account only'
);
select results_eq(
  $$ select net_cents from public.reports_net_worth('personal', '2026-01-10', '2026-01-10') $$,
  $$ values (3072223::bigint) $$, 'net worth: scope personal is everything else'
);
select results_eq(
  $$ select assets_cents, debts_cents, net_cents, cardinality(account_ids) from public.reports_net_worth('all', '2025-12-31', '2025-12-31') $$,
  $$ values (0::bigint, 0::bigint, 0::bigint, 0) $$, 'net worth: a day before any balance is zero with no accounts'
);

-- ---------------------------------------------------------------------------
-- Cash flow (Sankey), all entities, January
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select source_label, target_label, cents from public.reports_cash_flow('all', '2026-01-01', '2026-01-31') $$,
  $$ values
    ('Income'::text, 'Savings'::text, 756801::bigint),
    ('Paycheck', 'Income', 600000),
    ('Brand deals', 'Income', 200000),
    ('Platform payouts', 'Income', 150000),
    ('Income', 'Housing', 120000),
    ('Income', 'Taxes set aside', 50000),
    ('Income', 'Advertising', 10000),
    ('Income', 'Software and apps', 6500),
    ('Income', 'Food', 6200),
    ('Income', 'Uncategorized', 999),
    ('Uncategorized income', 'Income', 500) $$,
  'cash flow: income sources, Income, each expense category, taxes set aside and savings, to the cent'
);
select results_eq(
  $$ select (select sum(cents) from public.reports_cash_flow('all', '2026-01-01', '2026-01-31') where target_id = 'income'),
            (select sum(cents) from public.reports_cash_flow('all', '2026-01-01', '2026-01-31') where source_id = 'income') $$,
  $$ values (950500::numeric, 950500::numeric) $$, 'cash flow: flow into Income equals flow out of Income'
);
select results_eq(
  $$ select source_id, target_id from public.reports_cash_flow('all', '2026-01-01', '2026-01-31')
     where target_id in ('taxes', 'savings') or source_id = 'income:' || pg_temp.cid('Paycheck')::text order by 1, 2 $$,
  $$ values ('income'::text, 'savings'::text), ('income', 'taxes'), ('income:' || pg_temp.cid('Paycheck')::text, 'income') $$,
  'cash flow: stable node ids'
);
select results_eq(
  $$ select pg_temp.ids(row_ids) from public.reports_cash_flow('all', '2026-01-01', '2026-01-31') where target_label = 'Food' $$,
  $$ values (pg_temp.tid(4)::text || ',' || pg_temp.tid(5)::text || ',' || pg_temp.tid(6)::text) $$,
  'cash flow: a link returns the transaction ids it used (subcategories roll up, the refund included)'
);
select is(
  (select cardinality(row_ids) from public.reports_cash_flow('all', '2026-01-01', '2026-01-31') where target_id = 'savings'),
  0, 'cash flow: the savings link is derived, so it holds no row ids'
);
select results_eq(
  $$ select source_label, target_label, cents from public.reports_cash_flow('personal', '2026-01-01', '2026-01-31') order by cents desc $$,
  $$ values
    ('Paycheck'::text, 'Income'::text, 600000::bigint),
    ('Income', 'Savings', 423301),
    ('Income', 'Housing', 120000),
    ('Income', 'Taxes set aside', 50000),
    ('Income', 'Food', 6200),
    ('Income', 'Uncategorized', 999),
    ('Uncategorized income', 'Income', 500) $$,
  'cash flow: scope personal leaves the UGC rows out'
);
select results_eq(
  $$ select source_label, target_label, cents from public.reports_cash_flow('ugc', '2025-12-01', '2025-12-31') $$,
  $$ values ('Drawn from savings'::text, 'Income'::text, 1500::bigint), ('Income', 'Advertising', 1500) $$,
  'cash flow: spending above income is covered by a Drawn from savings source'
);
select is((select count(*)::int from public.reports_cash_flow('all', '2026-03-01', '2026-03-31')), 0, 'cash flow: an empty period has no links');

-- ---------------------------------------------------------------------------
-- Spending by category
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select name, cents, tx_count from public.reports_spending_by_category('all', '2026-01-01', '2026-01-31') $$,
  $$ values
    ('Housing'::text, 120000::bigint, 1),
    ('Taxes', 50000, 1),
    ('Advertising', 10000, 1),
    ('Software and apps', 6500, 2),
    ('Food', 6200, 3),
    ('Uncategorized', 999, 1) $$,
  'spending by category: top-level rollup, refund netted, transfers and hidden left out'
);
select is(
  (select sum(cents) from public.reports_spending_by_category('all', '2026-01-01', '2026-01-31')), 193699::numeric,
  'spending by category: the total is 1,936.99'
);
select is(
  (select category_id from public.reports_spending_by_category('all', '2026-01-01', '2026-01-31') where name = 'Food'),
  pg_temp.cid('Food'), 'spending by category: the row carries the top-level category id'
);
select is(
  (select pg_temp.ids(row_ids) from public.reports_spending_by_category('all', '2026-01-01', '2026-01-31') where name = 'Housing'),
  pg_temp.tid(3)::text, 'spending by category: row ids'
);
select results_eq(
  $$ select name, cents from public.reports_spending_by_category('ugc', '2026-01-01', '2026-01-31') $$,
  $$ values ('Advertising'::text, 10000::bigint), ('Software and apps', 6500) $$,
  'spending by category: scope ugc'
);
select results_eq(
  $$ select name, cents, tx_count from public.reports_spending_by_category('all', '2026-02-01', '2026-02-28') $$,
  $$ values ('Equipment'::text, 6000::bigint, 1), ('Food', 2000, 1) $$,
  'spending by category: the date range is inclusive and exact'
);

-- ---------------------------------------------------------------------------
-- Income by payer, year to date through February
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select payer, cents, tx_count from public.reports_income_by_payer('all', '2026-01-01', '2026-02-28') $$,
  $$ values ('Acme Corp'::text, 600000::bigint, 2), ('BrandCo', 250000, 2), ('TikTok', 150000, 1), ('Venmo', 500, 1) $$,
  'income by payer: payers merge ignoring case and outer spaces; the refund is not income'
);
select is(
  (select pg_temp.ids(row_ids) from public.reports_income_by_payer('all', '2026-01-01', '2026-02-28') where payer = 'BrandCo'),
  pg_temp.tid(14)::text || ',' || pg_temp.tid(20)::text, 'income by payer: row ids'
);
select results_eq(
  $$ select payer, cents from public.reports_income_by_payer('ugc', '2026-01-01', '2026-02-28') $$,
  $$ values ('BrandCo'::text, 250000::bigint), ('TikTok', 150000) $$,
  'income by payer: scope ugc'
);

-- ---------------------------------------------------------------------------
-- Monthly trend
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select month, income_cents, spending_cents, net_cents, tx_count
     from public.reports_monthly_trend('all', '2025-12-15', '2026-02-28') $$,
  $$ values
    ('2025-12-01'::date, 0::bigint, 1500::bigint, -1500::bigint, 1),
    ('2026-01-01', 950500, 193699, 756801, 14),
    ('2026-02-01', 50000, 8000, 42000, 3) $$,
  'monthly trend: income, spending and net per month, to the cent'
);
select is(
  (select cardinality(row_ids) from public.reports_monthly_trend('all', '2025-12-15', '2026-02-28') where month = '2026-01-01'),
  14, 'monthly trend: returns the 14 row ids behind January'
);
select results_eq(
  $$ select month, income_cents, spending_cents, net_cents, cardinality(row_ids)
     from public.reports_monthly_trend('all', '2026-03-01', '2026-04-30') $$,
  $$ values ('2026-03-01'::date, 0::bigint, 0::bigint, 0::bigint, 0), ('2026-04-01', 0, 0, 0, 0) $$,
  'monthly trend: months with no rows are zeros'
);
select results_eq(
  $$ select income_cents, spending_cents from public.reports_monthly_trend('all', '2026-01-10', '2026-01-20') $$,
  $$ values (450500::bigint, 50999::bigint) $$,
  'monthly trend: a partial month counts only the days in range (T2, T9, T15 in; T7, T8 out)'
);

-- ---------------------------------------------------------------------------
-- Tax lines per entity and year
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select entity_slug, year, code, cents, tx_count from public.reports_tax_lines('ugc', '2025-12-01', '2026-02-28') $$,
  $$ values
    ('ugc'::text, 2025, '8'::text, 1500::bigint, 1),
    ('ugc', 2026, '8', 10000, 1),
    ('ugc', 2026, '18', 2500, 1),
    ('ugc', 2026, '22', 6000, 1),
    ('ugc', 2026, '27b', 4000, 1) $$,
  'tax lines: totals per entity, year and Schedule C line; a row''s own line beats its category''s'
);
select is(
  (select count(*)::int from public.reports_tax_lines('all', '2025-12-01', '2026-02-28')), 5,
  'tax lines: scope all adds nothing (Personal has no mapped lines)'
);
select is((select count(*)::int from public.reports_tax_lines('personal', '2025-12-01', '2026-02-28')), 0, 'tax lines: Personal has none');
select is(
  (select pg_temp.ids(row_ids) from public.reports_tax_lines('ugc', '2026-01-01', '2026-01-31') where code = '27b'),
  pg_temp.tid(18)::text, 'tax lines: row ids'
);
select is(
  (select sum(cents) from public.reports_tax_lines('ugc', '2026-01-01', '2026-01-31')), 16500::numeric,
  'tax lines: January UGC deductions are 165.00'
);

-- ---------------------------------------------------------------------------
-- Income summary: before card bills, and net after card bills
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select income_cents, card_balance_cents, net_after_cards_cents, cardinality(income_row_ids), cardinality(card_account_ids)
     from public.reports_income_summary('all', '2026-01-01', '2026-01-31') $$,
  $$ values (950500::bigint, 42777::bigint, 907723::bigint, 5, 2) $$,
  'income summary: income 9,505.00, cards owe 427.77 (latest balance each), net 9,077.23'
);
select results_eq(
  $$ select income_cents, card_balance_cents, net_after_cards_cents, cardinality(card_account_ids)
     from public.reports_income_summary('all', '2026-01-01', '2026-02-28') $$,
  $$ values (1000500::bigint, 35000::bigint, 965500::bigint, 1) $$,
  'income summary: a card closed before the period ends is not counted'
);
select results_eq(
  $$ select income_cents, card_balance_cents, net_after_cards_cents, cardinality(card_account_ids)
     from public.reports_income_summary('ugc', '2026-01-01', '2026-01-31') $$,
  $$ values (350000::bigint, 0::bigint, 350000::bigint, 0) $$,
  'income summary: scope ugc'
);
select results_eq(
  $$ select income_cents, net_after_cards_cents from public.reports_income_summary('personal', '2026-01-01', '2026-01-31') $$,
  $$ values (600500::bigint, 557723::bigint) $$,
  'income summary: scope personal'
);
select results_eq(
  $$ select income_cents, card_balance_cents, net_after_cards_cents from public.reports_income_summary('all', '2026-03-01', '2026-03-31') $$,
  $$ values (0::bigint, 35000::bigint, -35000::bigint) $$,
  'income summary: an empty month still returns one row, owing the cards'
);

-- ---------------------------------------------------------------------------
-- RLS: anon nothing, a stranger nothing, the owner everything, hydra_ro reads.
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($$ select count(*) from public.reports_flow $$, '42501', null, 'anon cannot read the flow view');
select throws_ok($$ select * from public.reports_cash_flow('all', '2026-01-01', '2026-01-31') $$, '42501', null, 'anon cannot run a report');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.reports_flow), 0, 'a stranger sees no flow rows through the view');
select is((select count(*)::int from public.reports_cash_flow('all', '2026-01-01', '2026-01-31')), 0, 'a stranger gets no cash flow');
select is((select count(*)::int from public.reports_income_by_payer('all', '2026-01-01', '2026-02-28')), 0, 'a stranger gets no payers');
select results_eq(
  $$ select income_cents, card_balance_cents from public.reports_income_summary('all', '2026-01-01', '2026-01-31') $$,
  $$ values (0::bigint, 0::bigint) $$, 'a stranger gets a zero income summary'
);
select is((select coalesce(sum(net_cents), 0)::int from public.reports_net_worth('all', '2026-01-10', '2026-01-10')), 0, 'a stranger sees no net worth');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select count(*)::int from public.reports_cash_flow('all', '2026-01-01', '2026-01-31')), 11, 'the owner gets the cash flow');
select is((select net_cents from public.reports_net_worth('all', '2026-01-10', '2026-01-10')), 3152223::bigint, 'the owner gets net worth');
select is(has_table_privilege('authenticated', 'public.reports_flow', 'insert'), false, 'the view is read-only to the owner');
reset role;

-- hydra_ro (as 0001 and 0030): switch role, record outcomes in a temp table, assert after reset.
grant hydra_ro to postgres with set true;
create temp table ro_out (k text primary key, v text) on commit drop;
grant all on ro_out to hydra_ro;
set local role hydra_ro;
insert into ro_out select 'cash_flow', count(*)::text from public.reports_cash_flow('all', '2026-01-01', '2026-01-31');
insert into ro_out select 'net_worth', net_cents::text from public.reports_net_worth('all', '2026-01-10', '2026-01-10');
insert into ro_out select 'spending', sum(cents)::text from public.reports_spending_by_category('all', '2026-01-01', '2026-01-31');
insert into ro_out select 'payers', count(*)::text from public.reports_income_by_payer('all', '2026-01-01', '2026-02-28');
insert into ro_out select 'trend', count(*)::text from public.reports_monthly_trend('all', '2025-12-15', '2026-02-28');
insert into ro_out select 'tax', count(*)::text from public.reports_tax_lines('all', '2025-12-01', '2026-02-28');
insert into ro_out select 'summary', net_after_cards_cents::text from public.reports_income_summary('all', '2026-01-01', '2026-01-31');
reset role;
select is((select v from ro_out where k = 'cash_flow'), '11', 'hydra_ro reads the cash flow');
select is((select v from ro_out where k = 'net_worth'), '3152223', 'hydra_ro reads net worth');
select is((select v from ro_out where k = 'spending'), '193699', 'hydra_ro reads spending by category');
select is((select v from ro_out where k = 'payers'), '4', 'hydra_ro reads income by payer');
select is((select v from ro_out where k = 'trend'), '3', 'hydra_ro reads the monthly trend');
select is((select v from ro_out where k = 'tax'), '5', 'hydra_ro reads tax line totals');
select is((select v from ro_out where k = 'summary'), '907723', 'hydra_ro reads the income summary');

-- ---------------------------------------------------------------------------
-- MONEY-04: a refund larger than a category's spend. April 2027 (no other test reads 2027):
-- Dining out -30.00 and a +40.00 refund (Food nets -10.00), Rent -12.00, Paycheck +1000.00.
-- The list drops Food, but savings is the true net: 1000.00 - 2.00 = 998.00, as the trend says.
-- ---------------------------------------------------------------------------
insert into public.transactions (id, account_id, posted_on, amount_cents, name, source, category_id, category_source) values
  (pg_temp.tid(101), 'aaaaaaaa-0000-0000-0000-000000000001', '2027-04-02', -3000, 'Cafe', 'manual', pg_temp.cid('Dining out'), 'manual'),
  (pg_temp.tid(102), 'aaaaaaaa-0000-0000-0000-000000000001', '2027-04-03', 4000, 'Cafe refund', 'manual', pg_temp.cid('Dining out'), 'manual'),
  (pg_temp.tid(103), 'aaaaaaaa-0000-0000-0000-000000000001', '2027-04-04', -1200, 'Landlord', 'manual', pg_temp.cid('Rent'), 'manual'),
  (pg_temp.tid(104), 'aaaaaaaa-0000-0000-0000-000000000001', '2027-04-05', 100000, 'ACME PAYROLL', 'manual', pg_temp.cid('Paycheck'), 'manual');
select results_eq(
  $$ select target_id, cents from public.reports_cash_flow('all', '2027-04-01', '2027-04-30') where target_id = 'savings' $$,
  $$ values ('savings'::text, 99800::bigint) $$,
  'refund-heavy month: savings is income minus net spending (998.00), not minus the listed groups'
);
-- RM-02: Food's net refund (10.00) feeds Income as Refunds, so in = out to the cent.
select results_eq(
  $$ select source_id, target_id, cents, pg_temp.ids(row_ids) from public.reports_cash_flow('all', '2027-04-01', '2027-04-30') order by cents desc, source_id $$,
  $$ values ('income:' || pg_temp.cid('Paycheck')::text, 'income'::text, 100000::bigint, pg_temp.tid(104)::text),
            ('income', 'savings', 99800, ''),
            ('income', 'expense:' || (select parent_id from public.categories where id = pg_temp.cid('Rent'))::text, 1200, pg_temp.tid(103)::text),
            ('refunds', 'income', 1000, pg_temp.ids(array[pg_temp.tid(101), pg_temp.tid(102)])) $$,
  'refund-heavy month: Refunds 10.00 -> Income, with the refund rows cited'
);
select is(
  (select sum(cents) filter (where target_id = 'income') - sum(cents) filter (where source_id = 'income') from public.reports_cash_flow('all', '2027-04-01', '2027-04-30')),
  0::numeric, 'refund-heavy month: money into Income equals money out of it'
);
-- A reversed payout (income net below zero) leaves Income as Reversals and the flow still balances.
insert into public.transactions (id, account_id, posted_on, amount_cents, name, source, category_id, category_source) values
  (pg_temp.tid(107), 'aaaaaaaa-0000-0000-0000-000000000001', '2027-06-02', -5000, 'Bonus clawback', 'manual', pg_temp.cid('Paycheck'), 'manual'),
  (pg_temp.tid(108), 'aaaaaaaa-0000-0000-0000-000000000001', '2027-06-03', 20000, 'Side gig', 'manual', null, 'none'),
  (pg_temp.tid(109), 'aaaaaaaa-0000-0000-0000-000000000001', '2027-06-04', -3000, 'Landlord', 'manual', pg_temp.cid('Rent'), 'manual');
select results_eq(
  $$ select source_id, target_id, cents from public.reports_cash_flow('all', '2027-06-01', '2027-06-30')
     where source_id in ('refunds', 'drawn') or target_id in ('reversals', 'savings') order by 2 $$,
  $$ values ('income'::text, 'reversals'::text, 5000::bigint), ('income', 'savings', 12000) $$,
  'reversal month: Paycheck nets -50.00, shown as Reversals; savings 200.00 - 50.00 - 30.00 = 120.00, and in = out'
);
select results_eq(
  $$ select income_cents, spending_cents, net_cents, tx_count from public.reports_monthly_trend('all', '2027-04-01', '2027-04-30') $$,
  $$ values (100000::bigint, 200::bigint, 99800::bigint, 4) $$,
  'refund-heavy month: the trend agrees to the cent (income 1000.00, spending 2.00)'
);

-- MONEY-01: a synced card payment (checking out, card in) before pairing counts as income and
-- spending; once paired it counts as nothing.
insert into public.transactions (id, account_id, posted_on, amount_cents, name, source) values
  (pg_temp.tid(105), 'aaaaaaaa-0000-0000-0000-000000000001', '2027-05-10', -200000, 'CARD AUTOPAY', 'manual'),
  (pg_temp.tid(106), 'aaaaaaaa-0000-0000-0000-000000000003', '2027-05-11', 200000, 'PAYMENT THANK YOU', 'manual');
select is(
  (select income_cents + spending_cents from public.reports_monthly_trend('all', '2027-05-01', '2027-05-31')),
  400000::bigint, 'an unpaired card payment shows as income and spending'
);
select is(public.ledger_pair_transfers(jsonb_build_array(jsonb_build_object('a', pg_temp.tid(105), 'b', pg_temp.tid(106)))), 1, 'the pair is made');
select results_eq(
  $$ select income_cents, spending_cents, tx_count from public.reports_monthly_trend('all', '2027-05-01', '2027-05-31') $$,
  $$ values (0::bigint, 0::bigint, 0) $$,
  'a paired card payment is neither income nor spending'
);
select is((select count(*)::int from public.reports_cash_flow('all', '2027-05-01', '2027-05-31')), 0, 'and not in the cash flow');

select * from finish();
rollback;
