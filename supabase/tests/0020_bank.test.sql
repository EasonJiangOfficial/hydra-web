-- pgTAP: bank layer. Owner-only RLS, hidden tokens, one link per institution, and the sync write
-- paths (two syncs at once, death between pages, retry after partial success, pending to posted).
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(60);

-- Fixtures: an owner and a stranger (same ids as 0001's test; everything rolls back).
delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test')
on conflict (id) do nothing;
select is(public.bootstrap_owner('11111111-1111-1111-1111-111111111111'), 'created', 'the owner exists');

insert into public.bank_items (id, provider_item_id, institution_id, institution_name, access_token)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'item-sandbox-1', 'ins_109508', 'First Platypus Bank', 'v1.aXY.dGFn.Y3Q');

-- ---------------------------------------------------------------------------
-- Structure and guards
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_tables where schemaname = 'public'
     and tablename in ('bank_items', 'accounts', 'balances', 'transactions') and rowsecurity),
  4, 'RLS is on for every bank table'
);
select throws_ok(
  $$ insert into public.bank_items (provider_item_id, access_token) values ('item-x', 'access-sandbox-plaintext') $$,
  '23514', null, 'a plaintext access token is refused'
);
select throws_ok(
  $$ insert into public.bank_items (provider_item_id, institution_id, access_token) values ('item-2', 'ins_109508', 'v1.a.b.c') $$,
  '23505', null, 'a second link to the same institution is blocked'
);
update public.bank_items set status = 'revoked' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select lives_ok(
  $$ insert into public.bank_items (id, provider_item_id, institution_id, access_token)
     values ('aaaaaaaa-0000-0000-0000-000000000009', 'item-relink', 'ins_109508', 'v1.a.b.c') $$,
  'a revoked link does not block a new one'
);
delete from public.bank_items where id = 'aaaaaaaa-0000-0000-0000-000000000009';
update public.bank_items set status = 'active' where id = 'aaaaaaaa-0000-0000-0000-000000000001';

select throws_ok(
  $$ insert into public.accounts (bank_item_id, kind, name) values ('aaaaaaaa-0000-0000-0000-000000000001', 'cash', 'x') $$,
  '23514', null, 'a linked account needs its provider id'
);
select throws_ok(
  $$ insert into public.accounts (kind, name, is_manual) values ('cash', 'x', false) $$,
  '23514', null, 'an account without a bank item must be manual'
);
select throws_ok(
  $$ insert into public.accounts (kind, name, is_manual) values ('crypto', 'x', true) $$,
  '23514', null, 'account kind is cash, card, loan or asset'
);

-- ---------------------------------------------------------------------------
-- Sync page 1 of 2: accounts, balances, a pending row. Opens a pagination loop (anchor '').
-- ---------------------------------------------------------------------------
select is(
  public.bank_apply_sync_page(
    'aaaaaaaa-0000-0000-0000-000000000001', null, 'cursor-1', true, '2026-11-20', '2026-11-20 12:00+00',
    '[{"provider_account_id":"acc-chk","name":"Plaid Checking","mask":"0000","kind":"cash","current_cents":11000,"available_cents":10000,"limit_cents":null},
      {"provider_account_id":"acc-card","name":"Plaid Credit Card","mask":"3333","kind":"card","current_cents":41000,"available_cents":null,"limit_cents":200000}]',
    '[{"provider_account_id":"acc-chk","provider_transaction_id":"tx-pending","pending":true,"pending_transaction_id":null,
       "posted_on":"2026-11-19","authorized_on":"2026-11-19","amount_cents":-450,"name":"Starbucks","merchant":"Starbucks","raw_description":null},
      {"provider_account_id":"acc-chk","provider_transaction_id":"tx-1","pending":false,"pending_transaction_id":null,
       "posted_on":"2026-11-18","authorized_on":null,"amount_cents":250000,"name":"Payroll","merchant":null,"raw_description":"ACME PAYROLL"}]'
  ),
  'applied', 'page 1 applies'
);
select results_eq(
  $$ select a.provider_account_id, a.kind, a.institution, a.is_manual, e.slug
     from public.accounts a join public.entities e on e.id = a.entity_id order by 1 $$,
  $$ values ('acc-card'::text, 'card'::text, 'First Platypus Bank'::text, false, 'personal'::text),
            ('acc-chk', 'cash', 'First Platypus Bank', false, 'personal') $$,
  'page 1 creates the accounts under Personal with the institution name'
);
select is(
  (select current_cents from public.balances b join public.accounts a on a.id = b.account_id
   where a.provider_account_id = 'acc-card' and b.as_of = '2026-11-20'),
  41000::bigint, 'a card balance is stored as the amount owed'
);
select is((select count(*)::int from public.transactions), 2, 'page 1 writes its two rows');
select is(
  (select entity_id from public.transactions where provider_transaction_id = 'tx-1'),
  (select id from public.entities where slug = 'personal'), 'a synced row takes its account''s entity'
);
select results_eq(
  $$ select cursor, sync_anchor_cursor, last_synced_at is null from public.bank_items
     where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  $$ values ('cursor-1'::text, ''::text, true) $$,
  'mid-loop: the cursor moves, the anchor holds the loop start, the item is not yet synced'
);

-- Two syncs at once: the second worker read the same old cursor. It loses and writes nothing.
select is(
  public.bank_apply_sync_page(
    'aaaaaaaa-0000-0000-0000-000000000001', null, 'cursor-1-other', true, '2026-11-20', '2026-11-20 12:00+00',
    '[]',
    '[{"provider_account_id":"acc-chk","provider_transaction_id":"tx-ghost","pending":false,"pending_transaction_id":null,
       "posted_on":"2026-11-18","authorized_on":null,"amount_cents":-1,"name":"Ghost","merchant":null,"raw_description":null}]'
  ),
  'conflict', 'a sync holding a stale cursor gets conflict'
);
select is((select count(*)::int from public.transactions where provider_transaction_id = 'tx-ghost'), 0,
  'the losing sync wrote no rows');
select is((select cursor from public.bank_items where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'cursor-1',
  'the losing sync did not move the cursor');

-- The owner edits the pending row before it posts.
update public.transactions set note = 'team coffee', hidden = true where provider_transaction_id = 'tx-pending';

-- Death between pages: the process died after page 1. A fresh sync resumes from cursor-1.
-- Page 2 posts the pending row (pending_transaction_id link), removes the pending id, modifies tx-1.
update public.bank_items set sync_requested_at = '2026-11-20 11:59+00' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is(
  public.bank_apply_sync_page(
    'aaaaaaaa-0000-0000-0000-000000000001', 'cursor-1', 'cursor-2', false, '2026-11-20', '2026-11-20 12:00+00',
    '[]',
    '[{"provider_account_id":"acc-chk","provider_transaction_id":"tx-posted","pending":false,"pending_transaction_id":"tx-pending",
       "posted_on":"2026-11-20","authorized_on":"2026-11-19","amount_cents":-475,"name":"Starbucks Coffee","merchant":"Starbucks","raw_description":"STARBUCKS #123"}]',
    '[{"provider_account_id":"acc-chk","provider_transaction_id":"tx-1","pending":false,"pending_transaction_id":null,
       "posted_on":"2026-11-18","authorized_on":null,"amount_cents":250100,"name":"Payroll ACME","merchant":null,"raw_description":"ACME PAYROLL"}]',
    '[{"provider_transaction_id":"tx-pending"}]'
  ),
  'applied', 'page 2 applies from the cursor page 1 left'
);
select results_eq(
  $$ select provider_transaction_id, pending, pending_transaction_id, posted_on, amount_cents, name, note, hidden
     from public.transactions where account_id = (select id from public.accounts where provider_account_id = 'acc-chk')
     order by posted_on $$,
  $$ values ('tx-1'::text, false, null::text, '2026-11-18'::date, 250100::bigint, 'Payroll ACME'::text, null::text, false),
            ('tx-posted', false, 'tx-pending', '2026-11-20', -475, 'Starbucks Coffee', 'team coffee', true) $$,
  'pending and posted are one row, the owner''s note and hide survive, the modified row updated'
);
select results_eq(
  $$ select cursor, sync_anchor_cursor, last_synced_at is not null, sync_requested_at from public.bank_items
     where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  $$ values ('cursor-2'::text, null::text, true, null::timestamptz) $$,
  'the last page closes the loop, stamps the sync and clears a request it covered'
);

-- Retry after partial success: the provider sends rows we already hold (a restarted loop).
select is(
  public.bank_apply_sync_page(
    'aaaaaaaa-0000-0000-0000-000000000001', 'cursor-2', 'cursor-3', false, '2026-11-21', '2026-11-21 12:00+00',
    '[]',
    '[{"provider_account_id":"acc-chk","provider_transaction_id":"tx-posted","pending":false,"pending_transaction_id":"tx-pending",
       "posted_on":"2026-11-20","authorized_on":"2026-11-19","amount_cents":-475,"name":"Starbucks Coffee","merchant":"Starbucks","raw_description":"STARBUCKS #123"},
      {"provider_account_id":"acc-chk","provider_transaction_id":"tx-1","pending":false,"pending_transaction_id":null,
       "posted_on":"2026-11-18","authorized_on":null,"amount_cents":250100,"name":"Payroll ACME","merchant":null,"raw_description":"ACME PAYROLL"}]'
  ),
  'applied', 'a page of rows we already hold applies'
);
select is((select count(*)::int from public.transactions), 2, 'replayed rows upsert: no duplicates');

-- A newer request than the run's start survives the run.
update public.bank_items set sync_requested_at = '2026-11-21 12:05+00' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is(
  public.bank_apply_sync_page('aaaaaaaa-0000-0000-0000-000000000001', 'cursor-3', 'cursor-4', false, '2026-11-21', '2026-11-21 12:00+00'),
  'applied', 'an empty page applies'
);
select isnt((select sync_requested_at from public.bank_items where id = 'aaaaaaaa-0000-0000-0000-000000000001'), null,
  'a webhook that arrived after the run started stays queued');

-- Rewind (Plaid TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION): back to the loop's anchor.
select is(
  public.bank_apply_sync_page('aaaaaaaa-0000-0000-0000-000000000001', 'cursor-4', 'cursor-5', true, '2026-11-21', '2026-11-21 12:00+00'),
  'applied', 'a new loop opens at cursor-4'
);
select is(
  public.bank_apply_sync_page('aaaaaaaa-0000-0000-0000-000000000001', 'cursor-5', 'cursor-4', true, '2026-11-21', '2026-11-21 12:00+00'),
  'applied', 'a rewind applies'
);
select results_eq(
  $$ select cursor, sync_anchor_cursor from public.bank_items where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  $$ values ('cursor-4'::text, 'cursor-4'::text) $$,
  'a rewind puts the cursor back on the anchor and keeps the loop open'
);

-- A rename by the owner beats a later name from the feed.
update public.transactions set name = 'Coffee with team', renamed = true where provider_transaction_id = 'tx-posted';
select is(public.bank_apply_sync_page(
  'aaaaaaaa-0000-0000-0000-000000000001', 'cursor-4', 'cursor-6', false, '2026-11-21', '2026-11-21 12:00+00', '[]', '[]',
  '[{"provider_account_id":"acc-chk","provider_transaction_id":"tx-posted","pending":false,"pending_transaction_id":"tx-pending",
     "posted_on":"2026-11-20","authorized_on":"2026-11-19","amount_cents":-480,"name":"STARBUCKS","merchant":"Starbucks","raw_description":"STARBUCKS #123"}]'
), 'applied', 'a modified row applies');
select results_eq(
  $$ select name, amount_cents from public.transactions where provider_transaction_id = 'tx-posted' $$,
  $$ values ('Coffee with team'::text, -480::bigint) $$,
  'the owner''s rename stays; the amount follows the feed'
);

-- A row for an account the item does not have fails the whole page.
select throws_ok(
  $$ select public.bank_apply_sync_page('aaaaaaaa-0000-0000-0000-000000000001', 'cursor-6', 'cursor-7', false, '2026-11-21', now(), '[]',
     '[{"provider_account_id":"acc-unknown","provider_transaction_id":"tx-z","pending":false,"posted_on":"2026-11-21","amount_cents":1,"name":"z"}]') $$,
  'P0002', null, 'an unknown account fails the page'
);
select is((select cursor from public.bank_items where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'cursor-6',
  'a failed page leaves the cursor where it was');
select throws_ok(
  $$ select public.bank_apply_sync_page('aaaaaaaa-0000-0000-0000-00000000dead', null, 'c', false, '2026-11-21', now()) $$,
  'P0002', null, 'an unknown bank item fails'
);

-- A deal payment follows its transaction through a sync: a changed amount updates it, a removed
-- transaction deletes it (no orphan), and an invented transaction id is refused.
insert into public.deals (id, brand_name, start_date) values ('d0000000-0000-4000-8000-000000000001', 'Glow', '2026-11-01');
insert into public.deal_payments (deal_id, transaction_id, amount_cents, paid_on)
select 'd0000000-0000-4000-8000-000000000001', id, amount_cents, posted_on
from public.transactions where provider_transaction_id = 'tx-1';
select throws_ok(
  $$ insert into public.deal_payments (deal_id, transaction_id, amount_cents, paid_on)
     values ('d0000000-0000-4000-8000-000000000001', gen_random_uuid(), 100, '2026-11-18') $$,
  '23503', null, 'a deal payment cannot name a transaction that does not exist'
);
select is(public.bank_apply_sync_page(
  'aaaaaaaa-0000-0000-0000-000000000001', 'cursor-6', 'cursor-7', false, '2026-11-21', '2026-11-21 12:00+00', '[]', '[]',
  '[{"provider_account_id":"acc-chk","provider_transaction_id":"tx-1","pending":false,"pending_transaction_id":null,
     "posted_on":"2026-11-17","authorized_on":null,"amount_cents":250200,"name":"Payroll ACME","merchant":null,"raw_description":"ACME PAYROLL"}]'
), 'applied', 'a page that changes a matched transaction applies');
select results_eq(
  $$ select amount_cents, paid_on from public.deal_payments $$,
  $$ values (250200::bigint, '2026-11-17'::date) $$,
  'the matched payment follows the transaction amount and date'
);
-- A reversal turns the matched deposit negative. A payment is always positive, so the payment is
-- unmatched; the page still applies and the cursor moves on (no stuck sync).
select is(public.bank_apply_sync_page(
  'aaaaaaaa-0000-0000-0000-000000000001', 'cursor-7', 'cursor-8', false, '2026-11-21', '2026-11-21 12:00+00', '[]', '[]',
  '[{"provider_account_id":"acc-chk","provider_transaction_id":"tx-1","pending":false,"pending_transaction_id":null,
     "posted_on":"2026-11-17","authorized_on":null,"amount_cents":-250200,"name":"Payroll ACME","merchant":null,"raw_description":"ACME PAYROLL"}]'
), 'applied', 'a page that reverses a matched deposit applies');
select results_eq(
  $$ select (select count(*)::int from public.deal_payments),
            (select amount_cents from public.transactions where provider_transaction_id = 'tx-1'),
            (select cursor from public.bank_items where id = 'aaaaaaaa-0000-0000-0000-000000000001') $$,
  $$ values (0, -250200::bigint, 'cursor-8'::text) $$,
  'the reversal unmatches the payment, the row follows the feed and the cursor moves on'
);
-- The bank corrects it back to a deposit; the owner matches it again.
select is(public.bank_apply_sync_page(
  'aaaaaaaa-0000-0000-0000-000000000001', 'cursor-8', 'cursor-9', false, '2026-11-21', '2026-11-21 12:00+00', '[]', '[]',
  '[{"provider_account_id":"acc-chk","provider_transaction_id":"tx-1","pending":false,"pending_transaction_id":null,
     "posted_on":"2026-11-17","authorized_on":null,"amount_cents":250200,"name":"Payroll ACME","merchant":null,"raw_description":"ACME PAYROLL"}]'
), 'applied', 'a page that restores the deposit applies');
insert into public.deal_payments (deal_id, transaction_id, amount_cents, paid_on)
select 'd0000000-0000-4000-8000-000000000001', id, amount_cents, posted_on
from public.transactions where provider_transaction_id = 'tx-1';
select is(public.bank_apply_sync_page(
  'aaaaaaaa-0000-0000-0000-000000000001', 'cursor-9', 'cursor-10', false, '2026-11-21', '2026-11-21 12:00+00', '[]', '[]', '[]',
  '[{"provider_transaction_id":"tx-1"}]'
), 'applied', 'a page that removes a matched transaction applies');
select is((select count(*)::int from public.deal_payments), 0, 'the removed transaction took its payment with it');

-- ---------------------------------------------------------------------------
-- Imports, balances, categories
-- ---------------------------------------------------------------------------
insert into public.accounts (id, kind, name, is_manual) values ('bbbbbbbb-0000-0000-0000-000000000001', 'cash', 'Credit union', true);
insert into public.transactions (account_id, posted_on, amount_cents, name, source, import_hash)
values ('bbbbbbbb-0000-0000-0000-000000000001', '2026-11-01', -1299, 'Netflix', 'csv', 'hash-1');
select throws_ok(
  $$ insert into public.transactions (account_id, posted_on, amount_cents, name, source, import_hash)
     values ('bbbbbbbb-0000-0000-0000-000000000001', '2026-11-01', -1299, 'Netflix', 'csv', 'hash-1') $$,
  '23505', null, 'the same import hash twice is refused'
);
insert into public.transactions (account_id, posted_on, amount_cents, name, source, import_hash)
values ('bbbbbbbb-0000-0000-0000-000000000001', '2026-11-01', -1299, 'Netflix', 'csv', 'hash-1')
on conflict (import_hash) do nothing;
select is((select count(*)::int from public.transactions where import_hash = 'hash-1'), 1, 'a duplicate import row is skipped');
select is((select category_source from public.transactions where import_hash = 'hash-1'), 'none', 'category_source defaults to none');
select throws_ok(
  $$ update public.transactions set category_source = 'robot' where import_hash = 'hash-1' $$,
  '23514', null, 'category_source is rule, manual, import or none'
);
select throws_ok(
  $$ insert into public.transactions (account_id, posted_on, amount_cents, name, source)
     values ('bbbbbbbb-0000-0000-0000-000000000001', '2026-11-01', 1, 'x', 'plaid') $$,
  '23514', null, 'a plaid row needs its provider id'
);
insert into public.balances (account_id, as_of, current_cents) values ('bbbbbbbb-0000-0000-0000-000000000001', '2026-11-21', 100);
select throws_ok(
  $$ insert into public.balances (account_id, as_of, current_cents) values ('bbbbbbbb-0000-0000-0000-000000000001', '2026-11-21', 200) $$,
  '23505', null, 'one balance per account per day'
);

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($$ select id from public.accounts $$, '42501', null, 'anon cannot read accounts');
select throws_ok($$ select id from public.transactions $$, '42501', null, 'anon cannot read transactions');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.transactions), 0, 'a stranger sees no transactions');
select is((select count(*)::int from public.bank_items), 0, 'a stranger sees no bank items');
select throws_ok(
  $$ insert into public.accounts (kind, name, is_manual) values ('cash', 'pwn', true) $$,
  '42501', null, 'a stranger cannot add an account'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select count(*)::int from public.transactions), 2, 'the owner sees every transaction');
select is((select institution_name from public.bank_items), 'First Platypus Bank', 'the owner reads a bank item''s public columns');
select throws_ok($$ select access_token from public.bank_items $$, '42501', null, 'the owner cannot read the encrypted token');
select throws_ok($$ select cursor from public.bank_items $$, '42501', null, 'the owner cannot read the sync cursor');
select throws_ok(
  $$ select public.bank_apply_sync_page('aaaaaaaa-0000-0000-0000-000000000001', 'cursor-6', 'x', false, '2026-11-21', now()) $$,
  '42501', null, 'the owner cannot call the sync writer (service role only)'
);
update public.transactions set note = 'checked' where import_hash = 'hash-1';
select is((select note from public.transactions where import_hash = 'hash-1'), 'checked', 'the owner edits a transaction');
reset role;

-- hydra_ro reads rows but never the token (privileges checked directly; 0001's test covers the login).
select ok(has_table_privilege('hydra_ro', 'public.transactions', 'select'), 'hydra_ro reads transactions');
select ok(not has_column_privilege('hydra_ro', 'public.bank_items', 'access_token', 'select'), 'hydra_ro cannot read the token');
select ok(not has_table_privilege('hydra_ro', 'public.transactions', 'update'), 'hydra_ro cannot write transactions');

select * from finish();
rollback;
