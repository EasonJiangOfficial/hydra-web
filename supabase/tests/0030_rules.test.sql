-- pgTAP: money rules. Seeds, shape guards, owner-only RLS, and the write paths: a rule run never
-- overwrites a manual edit, pairing is compare-and-set, recurring detection keeps dismissals,
-- reorder refuses a stale list, merge moves everything.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(70);

-- Fixtures: an owner and a stranger (same ids as 0001's test; everything rolls back).
delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test')
on conflict (id) do nothing;
select is(public.bootstrap_owner('11111111-1111-1111-1111-111111111111'), 'created', 'the owner exists');

insert into public.accounts (id, kind, name, is_manual) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cash', 'Checking', true),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'cash', 'Savings', true),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'card', 'Card', true);

create temp table cat on commit drop as
select c.name, c.id from public.categories c
where c.name in ('Groceries', 'Dining out', 'Paycheck', 'Software and apps', 'Transfers');

insert into public.transactions (id, account_id, posted_on, amount_cents, name, merchant, source, category_id, category_source, renamed)
values
  ('10000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-11-10', -4200, 'WHOLEFDS 123', 'Whole Foods', 'manual', null, 'none', false),
  ('10000000-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-11-11', -4200, 'WHOLEFDS 456', 'Whole Foods', 'manual',
     (select id from cat where name = 'Dining out'), 'manual', false),
  ('10000000-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-11-12', -1599, 'My editor', null, 'manual', null, 'none', true),
  ('20000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-11-03', -50000, 'Transfer out', null, 'manual', null, 'none', false),
  ('20000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', '2026-11-04', 50000, 'Transfer in', null, 'manual', null, 'none', false),
  ('20000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000003', '2026-11-04', 50000, 'Card payment', null, 'manual', null, 'none', false),
  ('20000000-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-11-04', 50000, 'Deposit', null, 'manual', null, 'none', false),
  ('20000000-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000002', '2026-11-04', -700, 'Fee', null, 'manual', null, 'none', false),
  ('30000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-10-15', -1549, 'NETFLIX.COM', null, 'manual', null, 'none', false),
  ('30000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-11-15', -1799, 'NETFLIX.COM', null, 'manual', null, 'none', false);

-- ---------------------------------------------------------------------------
-- Structure and seeds
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_tables where schemaname = 'public'
     and tablename in ('categories', 'tax_lines', 'category_tax_lines', 'rules', 'recurring', 'transfer_rejections') and rowsecurity),
  6, 'RLS is on for every rules table'
);
select is((select count(*)::int from public.tax_lines where schedule = 'C' and part = 'II'), 25, 'Schedule C Part II lines are seeded');
select results_eq(
  $$ select code, name from public.tax_lines where code in ('8', '24b', '27b') order by position $$,
  $$ values ('8'::text, 'Advertising'::text), ('24b', 'Deductible meals'), ('27b', 'Other expenses') $$,
  'tax lines carry the form codes'
);
select results_eq(
  $$ select name, kind from public.categories where entity_id is null order by name $$,
  $$ values ('Card payments'::text, 'transfer'::text), ('Transfers', 'transfer') $$,
  'transfer categories are shared by every entity'
);
select results_eq(
  $$ select c.name from public.categories c join public.categories p on p.id = c.parent_id
     where p.name = 'Food' order by c.name $$,
  $$ values ('Coffee'::text), ('Dining out'), ('Groceries') $$,
  'Personal has subcategories'
);
select is(
  (select count(*)::int from public.category_tax_lines m join public.entities e on e.id = m.entity_id where e.slug = 'ugc'),
  16, 'UGC expense categories map to Schedule C lines'
);
select fk_ok('public', 'transactions', 'category_id', 'public', 'categories', 'id');
select fk_ok('public', 'transactions', 'tax_line_id', 'public', 'tax_lines', 'id');
select fk_ok('public', 'transactions', 'recurring_id', 'public', 'recurring', 'id');

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.categories (name, kind, entity_id) values ('TRANSFERS', 'transfer', null) $$,
  '23505', null, 'a shared category name is unique, case ignored'
);
select throws_ok(
  $$ insert into public.categories (name, kind, entity_id, parent_id)
     select 'Organic', 'expense', c.entity_id, c.id from public.categories c where c.name = 'Groceries' $$,
  '23514', 'categories: two levels only', 'a subcategory cannot have subcategories'
);
select throws_ok(
  $$ insert into public.categories (name, kind, entity_id, parent_id)
     select 'Side gig', 'income', c.entity_id, c.id from public.categories c where c.name = 'Food' $$,
  '23514', 'categories: parent differs', 'a subcategory has its parent''s kind'
);
select throws_ok(
  $$ update public.categories set kind = 'income' where name = 'Food' $$,
  '23514', 'categories: parent differs', 'a parent cannot change kind under its subcategories'
);
select throws_ok(
  $$ insert into public.category_tax_lines (category_id, entity_id, tax_line_id)
     select m.category_id, m.entity_id, (select id from public.tax_lines where code = '8')
     from public.category_tax_lines m limit 1 $$,
  '23505', null, 'one tax line per category per entity'
);
select throws_ok(
  $$ insert into public.categories (name, kind, color) values ('Red', 'expense', 'red') $$,
  '23514', null, 'a color is a hex value'
);
select throws_ok(
  $$ insert into public.rules (position, conditions, actions) values (0, '[]', '[{"type":"mark_transfer"}]') $$,
  '23514', null, 'a rule needs a condition'
);
select throws_ok(
  $$ insert into public.recurring (name_key, name, average_amount_cents, gap_days, last_seen_on, next_expected_on, status)
     values ('x', 'x', -100, 30, '2026-11-01', '2026-12-01', 'maybe') $$,
  '23514', null, 'recurring status is suggested, confirmed or dismissed'
);

-- ---------------------------------------------------------------------------
-- rules_apply_patches: a manual edit always wins; a rename never replaces a rename.
-- ---------------------------------------------------------------------------
select is(
  public.rules_apply_patches(jsonb_build_array(
    jsonb_build_object('id', '10000000-0000-0000-0000-00000000000a', 'category_id', (select id from cat where name = 'Groceries'), 'name', 'Whole Foods'),
    jsonb_build_object('id', '10000000-0000-0000-0000-00000000000b', 'category_id', (select id from cat where name = 'Groceries')),
    jsonb_build_object('id', '10000000-0000-0000-0000-00000000000c', 'name', 'EDITOR LLC',
      'entity_id', (select id from public.entities where slug = 'ugc'), 'is_transfer', false)
  )),
  2, 'two rows written; the manual row is skipped'
);
select results_eq(
  $$ select t.name, t.renamed, t.category_source, c.name from public.transactions t join public.categories c on c.id = t.category_id
     where t.id = '10000000-0000-0000-0000-00000000000a' $$,
  $$ values ('Whole Foods'::text, true, 'rule'::text, 'Groceries'::text) $$,
  'a rule sets the category (source rule) and renames'
);
select results_eq(
  $$ select t.category_source, c.name from public.transactions t join public.categories c on c.id = t.category_id
     where t.id = '10000000-0000-0000-0000-00000000000b' $$,
  $$ values ('manual'::text, 'Dining out'::text) $$,
  'the manual category stays'
);
select results_eq(
  $$ select t.name, t.category_source, e.slug, t.is_transfer from public.transactions t join public.entities e on e.id = t.entity_id
     where t.id = '10000000-0000-0000-0000-00000000000c' $$,
  $$ values ('My editor'::text, 'none'::text, 'ugc'::text, false) $$,
  'the earlier rename stays; the business changes; no category means the source stays'
);

-- A business the owner picked by hand (entity_manual, set by editTransaction) beats a set_entity rule;
-- the rest of the rule still applies (MONEY-03).
update public.transactions set entity_id = (select id from public.entities where slug = 'personal'), entity_manual = true
where id = '10000000-0000-0000-0000-00000000000c';
select is(
  public.rules_apply_patches(jsonb_build_array(
    jsonb_build_object('id', '10000000-0000-0000-0000-00000000000c', 'entity_id', (select id from public.entities where slug = 'ugc'))
  )),
  0, 'a patch that only moves a hand-picked business writes nothing'
);
select is(
  public.rules_apply_patches(jsonb_build_array(
    jsonb_build_object('id', '10000000-0000-0000-0000-00000000000c', 'entity_id', (select id from public.entities where slug = 'ugc'),
      'category_id', (select id from cat where name = 'Groceries'))
  )),
  1, 'a patch with more than the business still writes'
);
select results_eq(
  $$ select e.slug, t.category_source from public.transactions t join public.entities e on e.id = t.entity_id
     where t.id = '10000000-0000-0000-0000-00000000000c' $$,
  $$ values ('personal'::text, 'rule'::text) $$,
  'the hand-picked business stays; the rule''s category lands'
);

-- ---------------------------------------------------------------------------
-- Transfers and card payments: compare-and-set pairing, unpair.
-- ---------------------------------------------------------------------------
select is(
  public.ledger_pair_transfers('[{"a":"20000000-0000-0000-0000-000000000001","b":"20000000-0000-0000-0000-000000000002"},
                                 {"a":"20000000-0000-0000-0000-000000000001","b":"20000000-0000-0000-0000-000000000003"}]'),
  1, 'a row pairs once: the second pair for it is skipped'
);
select results_eq(
  $$ select id::text, transfer_pair_id::text, is_transfer from public.transactions
     where id in ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002') order by id $$,
  $$ values ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', true),
            ('20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', true) $$,
  'both rows point at each other and are transfers'
);
select is(
  public.ledger_pair_transfers('[{"a":"20000000-0000-0000-0000-000000000004","b":"10000000-0000-0000-0000-00000000000c"}]'),
  0, 'two rows on one account are not a pair'
);
select is(
  public.ledger_pair_transfers('[{"a":"20000000-0000-0000-0000-000000000005","b":"10000000-0000-0000-0000-00000000000c"}]'),
  0, 'two outflows are not a pair'
);
select is(
  public.ledger_pair_transfers('[{"a":"20000000-0000-0000-0000-000000000003","b":"20000000-0000-0000-0000-000000000003"}]'),
  0, 'a row is not its own pair'
);
-- A deposit matched to a deal payment is UGC income: never paired, even with a same-amount outflow (RM-01).
insert into public.transactions (id, account_id, posted_on, amount_cents, name, source, category_source) values
  ('20000000-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-11-10', -100000, 'LANDLORD RENT', 'manual', 'none'),
  ('20000000-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000002', '2026-11-09', 100000, 'WORDWISE PAYOUT', 'manual', 'none');
insert into public.deals (id, brand_name, start_date) values ('dddddddd-0000-0000-0000-000000000001', 'Wordwise', '2026-10-01');
insert into public.deal_payments (deal_id, transaction_id, amount_cents, paid_on)
values ('dddddddd-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000007', 100000, '2026-11-09');
select is(
  public.ledger_pair_transfers('[{"a":"20000000-0000-0000-0000-000000000006","b":"20000000-0000-0000-0000-000000000007"}]'),
  0, 'a deal-matched deposit is never paired as a transfer'
);
-- The other way round: a deposit already paired as a transfer is refused as a deal payment. The
-- trigger locks the transaction row first, as ledger_pair_transfers does, so the two serialize.
select throws_ok(
  $$ insert into public.deal_payments (deal_id, transaction_id, amount_cents, paid_on)
     values ('dddddddd-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 50000, '2026-11-04') $$,
  '23514', 'This deposit is a transfer between your accounts', 'a deposit paired as a transfer is never a deal payment'
);
select is(
  (select count(*)::int from public.deal_payments where transaction_id = '20000000-0000-0000-0000-000000000002'),
  0, 'no deal payment was written for the transfer'
);
-- A list of pairs is locked in id order up front, whatever order the pairs come in.
select ok(
  (select prosrc ~ 'order by t\.id for update;\s+for x in' from pg_proc where proname = 'ledger_pair_transfers'),
  'ledger_pair_transfers locks every row in id order before the first pair'
);
-- "Not a transfer" on a suggestion: stored once, smaller id first, gone with either row.
insert into public.transactions (id, account_id, posted_on, amount_cents, name, source, category_source) values
  ('20000000-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-11-10', -20000, 'ATM WITHDRAWAL', 'manual', 'none'),
  ('20000000-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000002', '2026-11-12', 20000, 'ZELLE FROM SAM', 'manual', 'none');
select lives_ok(
  $$ insert into public.transfer_rejections (a_id, b_id) values ('20000000-0000-0000-0000-000000000008', '20000000-0000-0000-0000-000000000009') $$,
  'a rejected suggestion is stored'
);
select throws_ok(
  $$ insert into public.transfer_rejections (a_id, b_id) values ('20000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-000000000008') $$,
  '23514', null, 'a pair is stored one way only'
);
delete from public.transactions where id = '20000000-0000-0000-0000-000000000009';
select is((select count(*)::int from public.transfer_rejections), 0, 'a rejection goes with its row');
select is(public.ledger_unpair_transfer('20000000-0000-0000-0000-000000000002'), 2, 'unpair clears both rows');
select results_eq(
  $$ select bool_or(is_transfer), count(transfer_pair_id)::int, min(category_source) from public.transactions
     where id in ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002') $$,
  $$ values (false, 0, 'manual'::text) $$,
  'unpaired rows count again and are marked as a manual decision'
);

-- ---------------------------------------------------------------------------
-- recurring_apply_detection: suggest, link, keep dismissals, keep the last price change.
-- ---------------------------------------------------------------------------
select is(
  public.recurring_apply_detection('[{"name_key":"netflix com","name":"NETFLIX.COM","average_amount_cents":-1799,"gap_days":31,
     "last_seen_on":"2026-11-15","next_expected_on":"2026-12-16",
     "last_price_change":{"from_cents":-1549,"to_cents":-1799,"on":"2026-11-15"},
     "transaction_ids":["30000000-0000-0000-0000-000000000001","30000000-0000-0000-0000-000000000002"]}]'),
  1, 'a new series is saved'
);
select results_eq(
  $$ select status, average_amount_cents, (last_price_change->>'to_cents')::int from public.recurring where name_key = 'netflix com' $$,
  $$ values ('suggested'::text, -1799::bigint, -1799) $$,
  'it is a suggestion with its price change'
);
select is(
  (select count(*)::int from public.transactions t join public.recurring r on r.id = t.recurring_id where r.name_key = 'netflix com'),
  2, 'its rows are linked'
);
select is(
  public.recurring_apply_detection('[{"name_key":"netflix com","name":"NETFLIX.COM","average_amount_cents":-1799,"gap_days":31,
     "last_seen_on":"2026-12-15","next_expected_on":"2027-01-15","last_price_change":null,"transaction_ids":[]}]'),
  1, 'a rerun updates the series'
);
select results_eq(
  $$ select last_seen_on, last_price_change->>'on' from public.recurring where name_key = 'netflix com' $$,
  $$ values ('2026-12-15'::date, '2026-11-15'::text) $$,
  'the last price change is kept when a rerun finds none'
);
update public.recurring set status = 'dismissed' where name_key = 'netflix com';
select is(
  public.recurring_apply_detection('[{"name_key":"netflix com","name":"NETFLIX","average_amount_cents":-2000,"gap_days":31,
     "last_seen_on":"2027-01-15","next_expected_on":"2027-02-15","last_price_change":null,"transaction_ids":[]}]'),
  0, 'a dismissed series is not saved again'
);
select results_eq(
  $$ select status, average_amount_cents from public.recurring where name_key = 'netflix com' $$,
  $$ values ('dismissed'::text, -1799::bigint) $$,
  'and it stays dismissed and unchanged'
);

-- ---------------------------------------------------------------------------
-- rules_reorder and categories_merge
-- ---------------------------------------------------------------------------
insert into public.rules (id, position, conditions, actions) values
  ('40000000-0000-0000-0000-000000000001', 0, '[{"field":"name","op":"contains","value":"a"}]', '[{"type":"mark_transfer"}]'),
  ('40000000-0000-0000-0000-000000000002', 1, '[{"field":"name","op":"contains","value":"b"}]', '[{"type":"mark_transfer"}]');
select throws_ok(
  $$ select public.rules_reorder(array['40000000-0000-0000-0000-000000000002']::uuid[]) $$,
  'P0001', 'rules: changed', 'a reorder that misses a rule is refused'
);
select throws_ok(
  $$ select public.rules_reorder(array['40000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002']::uuid[]) $$,
  'P0001', 'rules: changed', 'a reorder with a repeat is refused'
);
select lives_ok(
  $$ select public.rules_reorder(array['40000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001']::uuid[]) $$,
  'a full list reorders'
);
select results_eq(
  $$ select id::text from public.rules order by position $$,
  $$ values ('40000000-0000-0000-0000-000000000002'), ('40000000-0000-0000-0000-000000000001') $$,
  'the rules run in the new order'
);

insert into public.categories (id, name, kind, entity_id)
select '50000000-0000-0000-0000-000000000001', 'Editing apps', 'expense', e.id from public.entities e where e.slug = 'ugc';
insert into public.category_tax_lines (category_id, entity_id, tax_line_id)
select '50000000-0000-0000-0000-000000000001', e.id, t.id from public.entities e, public.tax_lines t where e.slug = 'personal' and t.code = '18';
update public.transactions set category_id = '50000000-0000-0000-0000-000000000001' where id = '10000000-0000-0000-0000-00000000000c';
update public.rules set actions = '[{"type":"set_category","categoryId":"50000000-0000-0000-0000-000000000001"},{"type":"mark_transfer"}]'
where id = '40000000-0000-0000-0000-000000000001';

select throws_ok(
  $$ delete from public.categories where id = '50000000-0000-0000-0000-000000000001' $$,
  '23503', null, 'a category in use cannot be deleted'
);
select throws_ok(
  $$ select public.categories_merge('50000000-0000-0000-0000-000000000001', (select id from cat where name = 'Paycheck')) $$,
  'P0001', 'categories: kinds differ', 'only categories of one kind merge'
);
select is(
  public.categories_merge('50000000-0000-0000-0000-000000000001', (select id from cat where name = 'Software and apps')),
  1, 'merge moves the transactions'
);
select results_eq(
  $$ select c.name from public.transactions t join public.categories c on c.id = t.category_id
     where t.id = '10000000-0000-0000-0000-00000000000c' $$,
  $$ values ('Software and apps'::text) $$,
  'the row now sits in the target'
);
select is(
  (select r.actions->0->>'categoryId' from public.rules r where r.id = '40000000-0000-0000-0000-000000000001'),
  (select id::text from cat where name = 'Software and apps'),
  'rules that set the old category now set the target'
);
select is(
  (select count(*)::int from public.category_tax_lines m
   where m.category_id = (select id from cat where name = 'Software and apps')),
  2, 'tax line maps follow (the target keeps its own for UGC, gains Personal)'
);
select is(
  (select count(*)::int from public.categories where id = '50000000-0000-0000-0000-000000000001'),
  0, 'the merged category is gone'
);

-- ---------------------------------------------------------------------------
-- RLS: anon nothing, a stranger nothing, the owner everything, hydra_ro reads only.
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($$ select count(*) from public.categories $$, '42501', null, 'anon cannot read categories');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.rules), 0, 'a stranger sees no rules');
select throws_ok(
  $$ insert into public.categories (name, kind) values ('Mine', 'expense') $$,
  '42501', null, 'a stranger cannot add a category'
);
select is(
  public.rules_apply_patches('[{"id":"20000000-0000-0000-0000-000000000004","is_transfer":true}]'),
  0, 'a stranger''s rule run writes nothing'
);
select throws_ok(
  $$ insert into public.transfer_rejections (a_id, b_id) values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000008') $$,
  '42501', null, 'a stranger cannot reject a suggestion'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select count(*)::int from public.rules), 2, 'the owner sees the rules');
select is(
  public.ledger_pair_transfers('[{"a":"20000000-0000-0000-0000-000000000005","b":"20000000-0000-0000-0000-000000000004"}]'),
  1, 'the owner pairs by hand through the function'
);
select lives_ok(
  $$ insert into public.categories (name, kind, entity_id) select 'Owner made', 'expense', e.id from public.entities e where e.slug = 'personal' $$,
  'the owner adds a category'
);
select lives_ok(
  $$ insert into public.transfer_rejections (a_id, b_id) values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000008') $$,
  'the owner says "Not a transfer"'
);
select throws_ok(
  $$ insert into public.tax_lines (code, name, position) values ('99', 'Made up', 99) $$,
  '42501', null, 'tax lines are read-only to the app'
);
reset role;

-- hydra_ro (as 0001 and 0040): switch role, record outcomes in a temp table, assert after reset.
grant hydra_ro to postgres with set true;
create temp table ro_out (k text primary key, v text) on commit drop;
grant all on ro_out to hydra_ro;
set local role hydra_ro;
insert into ro_out select 'tax_lines', count(*)::text from public.tax_lines;
insert into ro_out select 'rules', count(*)::text from public.rules;
do $$
begin
  insert into public.rules (position, conditions, actions)
  values (9, '[{"field":"name","op":"is","value":"x"}]', '[{"type":"mark_transfer"}]');
  insert into ro_out values ('write', 'allowed');
exception when others then
  insert into ro_out values ('write', sqlstate);
end;
$$;
reset role;
select is((select v from ro_out where k = 'tax_lines'), '25', 'hydra_ro reads tax lines');
select is((select v from ro_out where k = 'rules'), '2', 'hydra_ro reads rules');
select is((select v from ro_out where k = 'write'), '42501', 'hydra_ro cannot write rules');

select * from finish();
rollback;
