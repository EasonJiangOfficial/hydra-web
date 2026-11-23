-- pgTAP: activity and undo (0130). Capture with old/new images, cascades restored with the same ids,
-- undo of an update restores only its columns, changed-since and force, undo of an undo redoes,
-- 30-day expiry and prune, service-role opt-in by header, owner-only access, the table list; later
-- children, names taken since, guards and row rules on restore, the row lock, list undo, agent rows.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(68);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

-- ---------------------------------------------------------------------------
-- The table list: every public table is logged or excluded with a reason.
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and c.relname not in (select tbl from private.activity_tables) $$,
  'every public table is in the logged or the excluded list'
);
select is_empty(
  $$ select a.tbl from private.activity_tables a
     where to_regclass('public.' || quote_ident(a.tbl)) is null $$,
  'every listed table exists'
);
select is_empty(
  $$ select a.tbl from private.activity_tables a
     where a.logged and not exists (
       select 1 from pg_trigger t where t.tgrelid = ('public.' || quote_ident(a.tbl))::regclass and t.tgname = '0_activity_capture') $$,
  'every logged table has the capture trigger'
);
select is_empty(
  $$ select a.tbl from private.activity_tables a
     where not a.logged and exists (
       select 1 from pg_trigger t where t.tgrelid = ('public.' || quote_ident(a.tbl))::regclass and t.tgname = '0_activity_capture') $$,
  'no excluded table is logged'
);
select results_eq(
  $$ select tbl::text, logged from private.activity_tables
     where tbl in ('planning_category_colors', 'posts', 'agent_relay_turns', 'agent_relay_events') order by tbl $$,
  $$ values ('agent_relay_events'::text, false), ('agent_relay_turns', false), ('planning_category_colors', true), ('posts', true) $$,
  'category colors and posts (video_group_manual is a plain column) are logged; the relay tables are excluded'
);

-- ---------------------------------------------------------------------------
-- Fixtures, written as the database owner (not logged).
-- ---------------------------------------------------------------------------
insert into public.deals (id, brand_name, start_date, base_pay_cents)
values ('d0000000-0000-4000-8000-000000000001', 'Glow', '2026-11-01', 1000),
       ('d0000000-0000-4000-8000-000000000002', 'Lumen', '2026-11-01', 500);
insert into public.deal_accounts (id, deal_id, platform, handle)
values ('da000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'TIKTOK', 'me');
insert into public.posts (id, deal_id, account_id, platform, url, posted_at)
values ('a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
        'da000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/1', '2026-11-02T12:00:00Z');
-- The deal's rate goes up after the post: the post keeps its 1000 snapshot.
update public.deals set base_pay_cents = 2000 where id = 'd0000000-0000-4000-8000-000000000001';
insert into public.day_targets (deal_id, day, target) values ('d0000000-0000-4000-8000-000000000001', '2026-11-03', 0);
insert into public.accounts (id, kind, name, is_manual)
values ('b0000000-0000-4000-8000-000000000001', 'cash', 'Checking', true);
insert into public.transactions (id, account_id, posted_on, amount_cents, name, source, provider_transaction_id)
values
  ('f0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', '2026-11-20', 5000, 'Glow deposit', 'manual', null),
  ('f0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', '2026-11-21', 700, 'Lumen deposit', 'manual', null),
  ('f0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', '2026-11-21', -900, 'Bank row', 'csv', null);
insert into public.deal_payments (id, deal_id, transaction_id, amount_cents, paid_on)
values ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 5000, '2026-11-20'),
       ('e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000002', 700, '2026-11-21');
insert into public.planning_tasks (id, title, notes, status_id)
values ('c0000000-0000-4000-8000-000000000001', 'Plan', 'n1', (select id from public.planning_statuses order by position limit 1)),
       ('c0000000-0000-4000-8000-000000000003', 'Edit', '', (select id from public.planning_statuses order by position limit 1));
insert into public.planning_properties (id, name, type) values ('ab000000-0000-4000-8000-000000000001', 'Effort', 'number');
insert into public.planning_task_values (task_id, property_id, number_value)
values ('c0000000-0000-4000-8000-000000000003', 'ab000000-0000-4000-8000-000000000001', 3);
insert into public.tax_documents (id, entity_id, year, kind, name, storage_path)
values ('7d000000-0000-4000-8000-000000000001', (select id from public.entities where slug = 'ugc'), 2026, 'w9', 'W-9', 'ugc/2026/x-w9.pdf');
select is((select count(*)::int from public.activity), 0, 'database owner writes are not logged');

-- ---------------------------------------------------------------------------
-- Owner session: capture.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

set local request.headers = '{"x-hydra-activity":"a1000000-0000-4000-8000-000000000001"}';
insert into public.planning_tasks (id, title, status_id)
values ('c0000000-0000-4000-8000-000000000002', 'Film videos', (select id from public.planning_statuses order by position limit 1));
select results_eq(
  $$ select tbl, op, new ->> 'title', old is null from public.activity_rows where activity_id = 'a1000000-0000-4000-8000-000000000001' $$,
  $$ values ('planning_tasks'::text, 'insert'::text, 'Film videos'::text, true) $$,
  'an insert is logged with its new image'
);
select is((select actor from public.activity where id = 'a1000000-0000-4000-8000-000000000001'), 'you', 'the owner session is "you"');

set local request.headers = '{"x-hydra-activity":"a1000000-0000-4000-8000-000000000002"}';
update public.planning_tasks set title = 'Film 6 videos' where id = 'c0000000-0000-4000-8000-000000000002';
select results_eq(
  $$ select op, old ->> 'title', new ->> 'title', pk from public.activity_rows where activity_id = 'a1000000-0000-4000-8000-000000000002' $$,
  $$ values ('update'::text, 'Film videos'::text, 'Film 6 videos'::text, '{"id":"c0000000-0000-4000-8000-000000000002"}'::jsonb) $$,
  'an update is logged with old and new images and its key'
);

set local request.headers = '{"x-hydra-activity":"a1000000-0000-4000-8000-000000000003"}';
delete from public.planning_tasks where id = 'c0000000-0000-4000-8000-000000000002';
select results_eq(
  $$ select op, old ->> 'title', new is null from public.activity_rows where activity_id = 'a1000000-0000-4000-8000-000000000003' $$,
  $$ values ('delete'::text, 'Film 6 videos'::text, true) $$,
  'a delete is logged with its old image'
);

-- Without the activity header, one activity per transaction.
set local request.headers = '{}';
update public.planning_tasks set category = 'Work' where id = 'c0000000-0000-4000-8000-000000000003';
update public.planning_tasks set category = 'Home' where id = 'c0000000-0000-4000-8000-000000000003';
select is(
  (select count(distinct activity_id)::int from public.activity_rows where tbl = 'planning_tasks' and new ->> 'category' in ('Work', 'Home')),
  1, 'writes with no header group by transaction'
);
set local request.headers = '{"x-hydra-activity":"a1000000-0000-4000-8000-0000000000f0"}';
update public.planning_tasks set category = null where id = 'c0000000-0000-4000-8000-000000000003';

-- ---------------------------------------------------------------------------
-- Undo of an update restores only the columns it changed.
-- ---------------------------------------------------------------------------
set local request.headers = '{"x-hydra-activity":"a1000000-0000-4000-8000-000000000004"}';
update public.planning_tasks set title = 'Plan Y' where id = 'c0000000-0000-4000-8000-000000000001';
set local request.headers = '{"x-hydra-activity":"a1000000-0000-4000-8000-000000000005"}';
update public.planning_tasks set notes = 'n2' where id = 'c0000000-0000-4000-8000-000000000001';
set local request.headers = '{}';
select is((select public.undo_activity('a1000000-0000-4000-8000-000000000004') ->> 'ok'), 'true', 'undo an update');
select results_eq(
  $$ select title, notes from public.planning_tasks where id = 'c0000000-0000-4000-8000-000000000001' $$,
  $$ values ('Plan'::text, 'n2'::text) $$,
  'only the changed column went back; a later edit to another column stays'
);
select ok(
  (select undo_of = 'a1000000-0000-4000-8000-000000000004' and actor = 'you' from public.activity
   where id = (select activity_id from public.activity_rows where new ->> 'title' = 'Plan' and op = 'update' order by seq desc limit 1)),
  'the undo is logged as its own activity with undo_of'
);

-- ---------------------------------------------------------------------------
-- Changed since, and force.
-- ---------------------------------------------------------------------------
set local request.headers = '{"x-hydra-activity":"a1000000-0000-4000-8000-000000000006"}';
update public.planning_tasks set title = 'Plan Z' where id = 'c0000000-0000-4000-8000-000000000001';
set local request.headers = '{"x-hydra-activity":"a1000000-0000-4000-8000-000000000007"}';
update public.planning_tasks set title = 'Plan W' where id = 'c0000000-0000-4000-8000-000000000001';
set local request.headers = '{}';
select is(
  (select public.undo_activity('a1000000-0000-4000-8000-000000000006') ->> 'error'),
  'changed_since', 'a row edited since the action is reported'
);
select is(
  (select public.undo_activity('a1000000-0000-4000-8000-000000000006') -> 'changed' -> 0 -> 'cols'),
  '["title"]'::jsonb, 'the report names the changed column'
);
select is((select title from public.planning_tasks where id = 'c0000000-0000-4000-8000-000000000001'), 'Plan W', 'nothing changed without force');
select is((select public.undo_activity('a1000000-0000-4000-8000-000000000006', true) ->> 'ok'), 'true', 'force undoes it anyway');
select is((select title from public.planning_tasks where id = 'c0000000-0000-4000-8000-000000000001'), 'Plan', 'forced undo put the old value back');
select is(
  (select public.undo_activity('a1000000-0000-4000-8000-000000000003') ->> 'ok'), 'true',
  'undo a delete'
);
select is(
  (select title from public.planning_tasks where id = 'c0000000-0000-4000-8000-000000000002'), 'Film 6 videos',
  'the deleted task is back with the same id'
);
select is(
  (select public.undo_activity('a1000000-0000-4000-8000-000000000001') ->> 'error'), 'changed_since',
  'undoing the insert after a later edit is changed_since'
);

-- ---------------------------------------------------------------------------
-- Cascade: a deal with an account, a post, a day target and a payment.
-- ---------------------------------------------------------------------------
set local request.headers = '{"x-hydra-activity":"a1000000-0000-4000-8000-000000000008"}';
delete from public.deals where id = 'd0000000-0000-4000-8000-000000000001';
select results_eq(
  $$ select tbl from public.activity_rows where activity_id = 'a1000000-0000-4000-8000-000000000008' order by tbl $$,
  $$ values ('day_targets'::text), ('deal_accounts'), ('deal_payments'), ('deals'), ('posts') $$,
  'the deal and every row its delete cascaded to are logged'
);
select is(
  (select tbl from public.activity_rows where activity_id = 'a1000000-0000-4000-8000-000000000008' order by seq limit 1),
  'deals', 'the deal comes first (before its cascade)'
);
set local request.headers = '{}';
select is((select public.undo_activity('a1000000-0000-4000-8000-000000000008') ->> 'ok'), 'true', 'undo the deal delete');
select results_eq(
  $$ select (select brand_name from public.deals where id = 'd0000000-0000-4000-8000-000000000001'),
            (select count(*)::int from public.deal_accounts where id = 'da000000-0000-4000-8000-000000000001'),
            (select account_id::text from public.posts where id = 'a0000000-0000-4000-8000-000000000001'),
            (select base_pay_cents_snap from public.posts where id = 'a0000000-0000-4000-8000-000000000001'),
            (select count(*)::int from public.day_targets where deal_id = 'd0000000-0000-4000-8000-000000000001'),
            (select count(*)::int from public.deal_payments where id = 'e0000000-0000-4000-8000-000000000001') $$,
  $$ values ('Glow'::text, 1, 'da000000-0000-4000-8000-000000000001'::text, 1000::bigint, 1, 1) $$,
  'everything is back with the same ids, and the post keeps its old rate snapshot'
);
select isnt((select undone_at from public.activity where id = 'a1000000-0000-4000-8000-000000000008'), null, 'the original is marked undone');
select is((select public.undo_activity('a1000000-0000-4000-8000-000000000008') ->> 'error'), 'already_undone', 'it cannot be undone twice');
select is(
  (select count(*)::int from pg_trigger where tgrelid = 'public.posts'::regclass and tgenabled = 'D'),
  0, 'no trigger is left switched off'
);

-- Undo of the undo redoes the delete.
select is(
  (select public.undo_activity((select id from public.activity where undo_of = 'a1000000-0000-4000-8000-000000000008')) ->> 'ok'),
  'true', 'undo the undo'
);
select results_eq(
  $$ select (select count(*)::int from public.deals where id = 'd0000000-0000-4000-8000-000000000001'),
            (select count(*)::int from public.deal_payments where id = 'e0000000-0000-4000-8000-000000000001'),
            (select undone_at is null from public.activity where id = 'a1000000-0000-4000-8000-000000000008') $$,
  $$ values (0, 0, true) $$,
  'the deal is gone again and the original can be undone again'
);

-- A task with a property value.
set local request.headers = '{"x-hydra-activity":"a1000000-0000-4000-8000-000000000009"}';
delete from public.planning_tasks where id = 'c0000000-0000-4000-8000-000000000003';
set local request.headers = '{}';
select is((select public.undo_activity('a1000000-0000-4000-8000-000000000009') ->> 'ok'), 'true', 'undo a task delete');
select results_eq(
  $$ select t.title, v.number_value from public.planning_tasks t
     join public.planning_task_values v on v.task_id = t.id where t.id = 'c0000000-0000-4000-8000-000000000003' $$,
  $$ values ('Edit'::text, 3::numeric) $$,
  'the task and its value are back'
);

-- ---------------------------------------------------------------------------
-- A manual transaction: the owner deletes it (its deal payment goes with it) and undo restores both.
-- ---------------------------------------------------------------------------
set local request.headers = '{"x-hydra-activity":"a1000000-0000-4000-8000-000000000010"}';
delete from public.transactions where id = 'f0000000-0000-4000-8000-000000000002';
select is(
  (select count(*)::int from public.deal_payments where id = 'e0000000-0000-4000-8000-000000000002'),
  0, 'the owner deletes a manual transaction and its deal payment goes with it'
);
delete from public.transactions where id = 'f0000000-0000-4000-8000-000000000003';
select is(
  (select count(*)::int from public.transactions where id = 'f0000000-0000-4000-8000-000000000003'),
  1, 'a bank row is not deleted (policy: manual only)'
);
set local request.headers = '{}';
select is((select public.undo_activity('a1000000-0000-4000-8000-000000000010') ->> 'ok'), 'true', 'undo the transaction delete');
select results_eq(
  $$ select (select name from public.transactions where id = 'f0000000-0000-4000-8000-000000000002'),
            (select transaction_id::text from public.deal_payments where id = 'e0000000-0000-4000-8000-000000000002') $$,
  $$ values ('Lumen deposit'::text, 'f0000000-0000-4000-8000-000000000002'::text) $$,
  'the transaction and its deal payment are back with the same ids'
);

-- A deleted tax document (its file goes to trash/<activity>/<path>).
set local request.headers = '{"x-hydra-activity":"a1000000-0000-4000-8000-000000000012"}';
delete from public.tax_documents where id = '7d000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- Review fixes (F1, F4, SEC-1, F6, F7, F2): later children, a name taken since, the guards and row
-- rules a restore meets, the row lock, a multi-call undo in one transaction, one entry per change.
-- ---------------------------------------------------------------------------

-- F1: undoing "Added deal" after later work under it names that work instead of deleting it unseen.
set local request.headers = '{"x-hydra-activity":"a2000000-0000-4000-8000-000000000001"}';
insert into public.deals (id, brand_name, start_date, base_pay_cents) values ('d0000000-0000-4000-8000-000000000009', 'Nova', '2026-11-01', 100);
set local request.headers = '{"x-hydra-activity":"a2000000-0000-4000-8000-000000000002"}';
insert into public.deal_accounts (id, deal_id, platform, handle) values ('da000000-0000-4000-8000-000000000009', 'd0000000-0000-4000-8000-000000000009', 'TIKTOK', 'nova');
insert into public.day_targets (deal_id, day, target) values ('d0000000-0000-4000-8000-000000000009', '2026-11-04', 2);
set local request.headers = '{}';
select ok(
  (select public.undo_activity('a2000000-0000-4000-8000-000000000001') -> 'changed')
    @> '[{"what":"children","child":"deal_accounts","n":1},{"what":"children","child":"day_targets","n":1}]'::jsonb,
  'undoing an add with newer rows under it is changed_since, naming them'
);
select is(
  (select count(*)::int from public.deal_accounts where deal_id = 'd0000000-0000-4000-8000-000000000009')
  + (select count(*)::int from public.day_targets where deal_id = 'd0000000-0000-4000-8000-000000000009'),
  2, 'the later rows are still there'
);
select is((select public.undo_activity('a2000000-0000-4000-8000-000000000001', true) ->> 'ok'), 'true', 'force undoes the add anyway');
select is(
  (select count(*)::int from public.deal_accounts where deal_id = 'd0000000-0000-4000-8000-000000000009')
  + (select count(*)::int from public.day_targets where deal_id = 'd0000000-0000-4000-8000-000000000009'),
  0, 'the forced undo took the later rows with the deal'
);
select is(
  (select public.undo_activity((select id from public.activity where undo_of = 'a2000000-0000-4000-8000-000000000001')) ->> 'ok'),
  'true', 'undoing that undo is allowed'
);
select results_eq(
  $$ select (select count(*)::int from public.deals where id = 'd0000000-0000-4000-8000-000000000009'),
            (select count(*)::int from public.deal_accounts where id = 'da000000-0000-4000-8000-000000000009'),
            (select count(*)::int from public.day_targets where deal_id = 'd0000000-0000-4000-8000-000000000009') $$,
  $$ values (1, 1, 1) $$,
  'and brings the deal back with the later rows'
);

-- F4: a deleted category whose name was taken since is blocked with a reason, not a bare failure.
set local request.headers = '{"x-hydra-activity":"a2000000-0000-4000-8000-000000000003"}';
insert into public.categories (id, name, kind) values ('ca000000-0000-4000-8000-000000000001', 'Gear', 'expense');
set local request.headers = '{"x-hydra-activity":"a2000000-0000-4000-8000-000000000004"}';
delete from public.categories where id = 'ca000000-0000-4000-8000-000000000001';
set local request.headers = '{"x-hydra-activity":"a2000000-0000-4000-8000-000000000005"}';
insert into public.categories (id, name, kind) values ('ca000000-0000-4000-8000-000000000002', 'Gear', 'expense');
set local request.headers = '{}';
select results_eq(
  $$ select r ->> 'error', r ->> 'blocked', r -> 'changed' -> 0 ->> 'why', r -> 'changed' -> 0 ->> 'tbl'
     from (select public.undo_activity('a2000000-0000-4000-8000-000000000004') r) x $$,
  $$ values ('changed_since'::text, 'true'::text, 'taken'::text, 'categories'::text) $$,
  'a name taken since blocks the undo with a reason'
);
select is(
  (select public.undo_activity('a2000000-0000-4000-8000-000000000004', true) ->> 'blocked'), 'true',
  'force cannot get past it either'
);
select is((select count(*)::int from public.categories where lower(name) = 'gear'), 1, 'nothing changed');

-- SEC-1 (A): the two-level category guard stays on during a restore.
reset role;
insert into public.categories (id, name, kind) values
  ('ca000000-0000-4000-8000-0000000000a1', 'P', 'expense'),
  ('ca000000-0000-4000-8000-0000000000a3', 'Q', 'expense');
insert into public.categories (id, name, kind, parent_id) values ('ca000000-0000-4000-8000-0000000000a2', 'C', 'expense', 'ca000000-0000-4000-8000-0000000000a1');
set local role authenticated;
set local request.headers = '{"x-hydra-activity":"a2000000-0000-4000-8000-000000000006"}';
delete from public.categories where id = 'ca000000-0000-4000-8000-0000000000a2';
set local request.headers = '{"x-hydra-activity":"a2000000-0000-4000-8000-000000000007"}';
update public.categories set parent_id = 'ca000000-0000-4000-8000-0000000000a3' where id = 'ca000000-0000-4000-8000-0000000000a1';
set local request.headers = '{}';
select results_eq(
  $$ select r ->> 'blocked', r -> 'changed' -> 0 ->> 'why' from (select public.undo_activity('a2000000-0000-4000-8000-000000000006', true) r) x $$,
  $$ values ('true'::text, 'rule'::text) $$,
  'a restore that would make a three-level category tree is blocked'
);
select is((select count(*)::int from public.categories where id = 'ca000000-0000-4000-8000-0000000000a2'), 0, 'the child is not put back under a child');
select is(
  (select count(*)::int from pg_trigger where tgrelid in ('public.categories'::regclass, 'public.posts'::regclass) and tgenabled = 'D'),
  0, 'a blocked undo leaves no trigger switched off'
);

-- SEC-1 (B): a forced undo cannot delete what the owner's own session may not (a paired transfer).
set local request.headers = '{"x-hydra-activity":"a2000000-0000-4000-8000-000000000008"}';
insert into public.transactions (id, account_id, posted_on, amount_cents, name, source)
values ('f0000000-0000-4000-8000-000000000009', 'b0000000-0000-4000-8000-000000000001', '2026-11-22', -300, 'Cash move', 'manual');
reset role;
update public.transactions set transfer_pair_id = 'f0000000-0000-4000-8000-000000000003' where id = 'f0000000-0000-4000-8000-000000000009';
set local role authenticated;
set local request.headers = '{}';
select results_eq(
  $$ select r ->> 'blocked', r -> 'changed' -> 0 ->> 'why' from (select public.undo_activity('a2000000-0000-4000-8000-000000000008', true) r) x $$,
  $$ values ('true'::text, 'not_allowed'::text) $$,
  'a forced undo meets the owner''s row rules (no delete of a paired transfer)'
);
select is((select count(*)::int from public.transactions where id = 'f0000000-0000-4000-8000-000000000009'), 1, 'the paired row stays');

-- F7: the activities of one multi-call delete are undone together, or not at all.
reset role;
insert into public.rules (id, position, conditions, actions) values
  ('ae000000-0000-4000-8000-000000000001', 90, '[{"field":"name","op":"contains","value":"a"}]', '[{"type":"set_note","value":"a"}]'),
  ('ae000000-0000-4000-8000-000000000002', 91, '[{"field":"name","op":"contains","value":"b"}]', '[{"type":"set_note","value":"b"}]');
set local role authenticated;
set local request.headers = '{"x-hydra-activity":"a2000000-0000-4000-8000-000000000009"}';
delete from public.rules where id = 'ae000000-0000-4000-8000-000000000001';
set local request.headers = '{"x-hydra-activity":"a2000000-0000-4000-8000-000000000010"}';
delete from public.rules where id = 'ae000000-0000-4000-8000-000000000002';
set local request.headers = '{}';
select is((select public.undo_activity('a2000000-0000-4000-8000-000000000009') ->> 'ok'), 'true', 'one of the two is undone alone first');
select is(
  (select public.undo_activities(array['a2000000-0000-4000-8000-000000000009', 'a2000000-0000-4000-8000-000000000010']::uuid[]) ->> 'error'),
  'already_undone', 'a list with one that fails is refused'
);
select is((select count(*)::int from public.rules where id = 'ae000000-0000-4000-8000-000000000002'), 0, 'and the others in it are rolled back');
reset role;
delete from public.rules where id = 'ae000000-0000-4000-8000-000000000001';
update public.activity set undone_at = null where id = 'a2000000-0000-4000-8000-000000000009';
set local role authenticated;
select is(
  (select jsonb_array_length(public.undo_activities(array['a2000000-0000-4000-8000-000000000009', 'a2000000-0000-4000-8000-000000000010']::uuid[]) -> 'undoIds')),
  2, 'a list undoes every activity in it'
);

-- F2: an agent step outside a routine wrote through the owner's session (a 'db' entry already), so
-- only its outside steps and routine steps show as 'agent' entries.
reset role;
insert into public.agent_actions (tool, summary, inverse, surface) values
  ('delete_rule', 'Deleted a rule', '{"tool":"create_rule","input":{}}', 'web'),
  ('gmail_label', 'Labeled an email', '{"tool":"gmail_label","input":{}}', 'web'),
  ('create_task', 'Routine task', '{"tool":"delete_task","input":{}}', 'routine');
set local role authenticated;
select results_eq(
  $$ select summary from public.activity_list(null, null, 200) where kind = 'agent' order by summary $$,
  $$ values ('Labeled an email'::text), ('Routine task') $$,
  'activity_list leaves out agent steps whose rows are logged'
);

-- F6: the changed-since read locks the row until the undo commits.
reset role;
insert into public.planning_tasks (id, title, status_id)
values ('c0000000-0000-4000-8000-000000000099', 'Lock me', (select id from public.planning_statuses order by position limit 1));
do $$ begin perform private.activity_current('planning_tasks', '{"id":"c0000000-0000-4000-8000-000000000099"}'); end $$;
select is(
  (select xmax::text from public.planning_tasks where id = 'c0000000-0000-4000-8000-000000000099'),
  (txid_current() % 4294967296)::text, 'activity_current locks the row it reads'
);
set local role authenticated;

-- ---------------------------------------------------------------------------
-- A stranger: reads nothing, undoes nothing, writes no log.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.activity), 0, 'a non-owner reads no activity');
select is((select count(*)::int from public.activity_rows), 0, 'a non-owner reads no row images');
select is(
  (select public.undo_activity('a1000000-0000-4000-8000-000000000009') ->> 'error'), 'not_found',
  'a non-owner undoes nothing'
);
select throws_ok(
  $$ insert into public.activity (actor) values ('you') $$, '42501', null, 'a non-owner cannot write the log'
);
reset role;
set local role anon;
select throws_ok($$ select public.undo_activity('a1000000-0000-4000-8000-000000000009') $$, '42501', null, 'anon cannot call undo');
reset role;

-- ---------------------------------------------------------------------------
-- Service role: logged only with the actor header.
-- ---------------------------------------------------------------------------
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
set local request.headers = '{}';
update public.planning_tasks set notes = 'by sync' where id = 'c0000000-0000-4000-8000-000000000003';
reset role;
select is(
  (select count(*)::int from public.activity_rows where new ->> 'notes' = 'by sync'),
  0, 'a service-role write without the header is not logged'
);
set local role service_role;
set local request.headers = '{"x-hydra-actor":"hydra","x-hydra-activity":"a1000000-0000-4000-8000-000000000011"}';
update public.planning_tasks set notes = 'by agent' where id = 'c0000000-0000-4000-8000-000000000003';
reset role;
select results_eq(
  $$ select a.actor, r.new ->> 'notes' from public.activity a join public.activity_rows r on r.activity_id = a.id
     where a.id = 'a1000000-0000-4000-8000-000000000011' $$,
  $$ values ('hydra'::text, 'by agent'::text) $$,
  'with x-hydra-actor it is logged as that actor'
);
set local request.headers = '{}';

-- ---------------------------------------------------------------------------
-- 30 days: expired, then pruned with its rows; the prune names the trash files to remove.
-- ---------------------------------------------------------------------------
update public.activity set at = now() - interval '31 days'
where id in ('a1000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000012');
select is((select public.undo_activity('a1000000-0000-4000-8000-000000000005') ->> 'error'), 'expired', 'past 30 days it is expired');
select results_eq(
  $$ select * from public.activity_trash() $$,
  $$ values ('tax-docs'::text, 'trash/a1000000-0000-4000-8000-000000000012/ugc/2026/x-w9.pdf'::text) $$,
  'activity_trash names the files first, removing nothing'
);
select results_eq(
  $$ select * from public.prune_activity() $$,
  $$ values ('tax-docs'::text, 'trash/a1000000-0000-4000-8000-000000000012/ugc/2026/x-w9.pdf'::text) $$,
  'the prune returns the trashed file of a pruned delete'
);
select is(
  (select count(*)::int from public.activity_rows where activity_id in ('a1000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000012'))
  + (select count(*)::int from public.activity where id in ('a1000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000012')),
  0, 'pruned activity is gone with its rows'
);

select * from finish();
rollback;
