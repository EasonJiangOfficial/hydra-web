-- pgTAP: UGC tables. Owner-only RLS, UGC entity, rate snapshot, exclude and override guard, the
-- Ripple exemption and source guard (database owner role only), the service role's narrow rights,
-- uniqueness, payable views (held and freeze), hydra_ro reads. Sets up and cleans up inside its own
-- transaction. Needs 0020_bank.sql applied first (deal_payments test rows use public.accounts and
-- public.transactions). Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(76);

-- Fixtures: an owner and a stranger (ownerless start; a bootstrapped owner comes back on rollback).
delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select is(
  (select count(*)::int from pg_tables
   where schemaname = 'public' and rowsecurity
     and tablename in ('deals', 'deal_accounts', 'posts', 'post_view_snapshots', 'deal_payments', 'day_targets')),
  6, 'RLS is on for all six UGC tables'
);
select ok(
  (select 'security_invoker=true' = any (reloptions) from pg_class where oid = 'public.ugc_post_views'::regclass),
  'ugc_post_views runs with the caller''s rights'
);

-- Anon: no grants.
set local role anon;
select throws_ok($$ select * from public.deals $$, '42501', null, 'anon cannot read deals');
select throws_ok($$ select * from public.posts $$, '42501', null, 'anon cannot read posts');
select throws_ok($$ select * from public.ugc_post_views $$, '42501', null, 'anon cannot read ugc_post_views');
select throws_ok($$ select private.ripple_import_apply('{}') $$, '42501', null, 'anon cannot call the Ripple import');
reset role;

-- Owner: deals.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.deals (id, brand_name, start_date, base_pay_cents, view_bonuses, cpm_rate, entity_id)
values (
  'd1000000-0000-4000-8000-000000000001', 'Glow', '2026-11-01', 2500,
  '[{"views":10000,"bonusCents":5000}]', 2.5,
  (select id from public.entities where slug = 'personal')
);
insert into public.deals (id, brand_name, start_date, base_pay_cents)
values ('d2000000-0000-4000-8000-000000000002', 'Pulse', '2026-11-01', 100);
select is(
  (select e.slug from public.deals d join public.entities e on e.id = d.entity_id
   where d.id = 'd1000000-0000-4000-8000-000000000001'),
  'ugc', 'a deal always belongs to the UGC entity'
);
select results_eq(
  $$ select status, per_deal_model, daily_target_posts, view_bonus_mode, cpm_mode, cpm_tier_mode, view_aggregation_mode
     from public.deals where id = 'd2000000-0000-4000-8000-000000000002' $$,
  $$ values ('active'::text, false, 1, 'REPLACE'::text, 'ADD'::text, 'PER_VIDEO'::text, 'HIGHEST'::text) $$,
  'deal defaults: active, per-video model, one post a day'
);
select throws_ok(
  $$ insert into public.deals (brand_name, start_date, end_date) values ('Bad', '2026-11-10', '2026-11-01') $$,
  '23514', null, 'an end date before the start date is rejected'
);
select throws_ok(
  $$ insert into public.deals (brand_name, start_date, daily_target_posts) values ('Bad', '2026-11-01', 31) $$,
  '23514', null, 'a daily target above 30 is rejected'
);

-- Rate snapshot.
insert into public.posts (id, deal_id, platform, url, posted_at, base_pay_cents_snap, cpm_rate_snap)
values (
  'a1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'TIKTOK',
  'https://tiktok.com/@me/video/1', '2026-11-02T15:00:00Z', 999999, 99
);
select results_eq(
  $$ select base_pay_cents_snap, cpm_rate_snap::text, view_bonuses_snap, view_bonus_mode_snap, cpm_view_unit_snap
     from public.posts where id = 'a1000000-0000-4000-8000-000000000001' $$,
  $$ values (2500::bigint, '2.5000'::text, '[{"views":10000,"bonusCents":5000}]'::jsonb, 'REPLACE'::text, 1000) $$,
  'a new post copies the deal''s rates and ignores rates it sends'
);
update public.deals set base_pay_cents = 4000 where id = 'd1000000-0000-4000-8000-000000000001';
select is(
  (select base_pay_cents_snap from public.posts where id = 'a1000000-0000-4000-8000-000000000001'),
  2500::bigint, 'a later rate edit does not reprice an old post'
);
update public.posts set base_pay_cents_snap = 1, title = 'renamed' where id = 'a1000000-0000-4000-8000-000000000001';
select results_eq(
  $$ select base_pay_cents_snap, title from public.posts where id = 'a1000000-0000-4000-8000-000000000001' $$,
  $$ values (2500::bigint, 'renamed'::text) $$,
  'an update cannot rewrite the snapshot but edits the rest'
);
insert into public.posts (id, deal_id, platform, url, posted_at)
values ('a2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'INSTAGRAM',
        'https://instagram.com/reel/Abc', '2026-11-03T15:00:00Z');
select is(
  (select base_pay_cents_snap from public.posts where id = 'a2000000-0000-4000-8000-000000000002'),
  4000::bigint, 'a post added after the edit takes the new rate'
);
update public.posts set deal_id = 'd2000000-0000-4000-8000-000000000002'
where id = 'a2000000-0000-4000-8000-000000000002';
select is(
  (select base_pay_cents_snap from public.posts where id = 'a2000000-0000-4000-8000-000000000002'),
  100::bigint, 'moving a post to another deal re-snapshots that deal''s rates'
);
-- Only the import writes source='ripple' rows: not even the owner's own session (an API role).
select throws_ok(
  $$ insert into public.posts (deal_id, platform, url, posted_at, source, source_id, base_pay_cents_snap)
     values ('d1000000-0000-4000-8000-000000000001', 'YOUTUBE', 'https://youtube.com/shorts/r0',
             '2026-10-01T00:00:00Z', 'ripple', 'rp-0', 1234) $$,
  '42501', null, 'the owner''s session cannot insert a source=ripple post'
);
select throws_ok(
  $$ insert into public.deals (brand_name, start_date, source, source_id) values ('Planted', '2026-11-01', 'ripple', 'rp-d0') $$,
  '42501', null, 'the owner''s session cannot insert a source=ripple deal'
);
select throws_ok(
  $$ update public.posts set source = 'ripple', source_id = 'rp-0' where id = 'a1000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'the owner''s session cannot relabel a post ripple'
);
select throws_ok(
  $$ select private.ripple_import_apply('{}') $$,
  '42501', null, 'the owner''s session cannot call the Ripple import'
);

-- Exclude and manual override: the owner may.
update public.posts set exclude_from_pay = true where id = 'a2000000-0000-4000-8000-000000000002';
select ok(
  (select exclude_from_pay from public.posts where id = 'a2000000-0000-4000-8000-000000000002'),
  'the owner excludes a video'
);
update public.posts set manual_override_cents = 777 where id = 'a1000000-0000-4000-8000-000000000001';
select is(
  (select manual_override_cents from public.posts where id = 'a1000000-0000-4000-8000-000000000001'),
  777::bigint, 'the owner sets a manual override'
);

-- Uniqueness and the account-to-deal link.
select throws_ok(
  $$ insert into public.posts (deal_id, platform, url, posted_at)
     values ('d1000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/1', now()) $$,
  '23505', null, 'one row per post URL'
);
select throws_ok(
  $$ insert into public.posts (deal_id, platform, url, posted_at)
     values ('d1000000-0000-4000-8000-000000000001', 'TIKTOK', 'http://tiktok.com/x', now()) $$,
  '23514', null, 'a post URL must be normalized https'
);
insert into public.deal_accounts (id, deal_id, platform, handle)
values ('ac000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000002', 'TIKTOK', 'me');
select throws_ok(
  $$ update public.posts set account_id = 'ac000000-0000-4000-8000-000000000001'
     where id = 'a1000000-0000-4000-8000-000000000001' $$,
  '23503', null, 'a post cannot use another deal''s account'
);
select throws_ok(
  $$ insert into public.deal_accounts (deal_id, platform, handle)
     values ('d2000000-0000-4000-8000-000000000002', 'TIKTOK', 'Me') $$,
  '23514', null, 'handles are stored lower case'
);
insert into public.post_view_snapshots (post_id, captured_day, captured_at, views)
values ('a1000000-0000-4000-8000-000000000001', '2026-11-03', '2026-11-03T12:00:00Z', 100);
select throws_ok(
  $$ insert into public.post_view_snapshots (post_id, captured_day, views)
     values ('a1000000-0000-4000-8000-000000000001', '2026-11-03', 200) $$,
  '23505', null, 'one snapshot per post per day'
);
insert into public.accounts (id, kind, name, is_manual)
values ('b0000000-0000-4000-8000-000000000001', 'cash', 'Test checking', true);
insert into public.transactions (id, account_id, posted_on, amount_cents, name, source)
values
  ('f1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', '2026-11-20', 5000, 'Glow deposit', 'manual'),
  ('f1000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', '2026-11-21', 700, 'Spare deposit', 'manual');
insert into public.deal_payments (deal_id, transaction_id, amount_cents, paid_on)
values ('d1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 5000, '2026-11-20');
select throws_ok(
  $$ insert into public.deal_payments (deal_id, transaction_id, amount_cents, paid_on)
     values ('d1000000-0000-4000-8000-000000000001', gen_random_uuid(), 5000, '2026-11-20') $$,
  '23503', null, 'a payment needs a real transaction'
);
select throws_ok(
  $$ insert into public.deal_payments (deal_id, transaction_id, amount_cents, paid_on)
     values ('d1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 701, '2026-11-21') $$,
  '23503', null, 'a payment amount must equal the transaction amount'
);
select throws_ok(
  $$ insert into public.deal_payments (deal_id, transaction_id, amount_cents, paid_on)
     values ('d1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 700, '2026-11-22') $$,
  '23503', null, 'a payment date must equal the transaction date'
);
update public.transactions set amount_cents = 5500, posted_on = '2026-11-19'
where id = 'f1000000-0000-4000-8000-000000000001';
select results_eq(
  $$ select amount_cents, paid_on from public.deal_payments where transaction_id = 'f1000000-0000-4000-8000-000000000001' $$,
  $$ values (5500::bigint, '2026-11-19'::date) $$,
  'a sync that changes the transaction updates its payment'
);
insert into public.deal_payments (deal_id, transaction_id, amount_cents, paid_on)
values ('d1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 700, '2026-11-21');
reset role;
delete from public.transactions where id = 'f1000000-0000-4000-8000-000000000003'; -- Plaid "removed"
set local role authenticated;
select is(
  (select count(*)::int from public.deal_payments where transaction_id = 'f1000000-0000-4000-8000-000000000003'),
  0, 'a removed transaction takes its payment with it'
);
select throws_ok(
  $$ insert into public.deal_payments (deal_id, transaction_id, amount_cents, paid_on)
     values ('d2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000001', 5500, '2026-11-19') $$,
  '23505', null, 'one deposit links to one deal'
);
select throws_ok(
  $$ insert into public.day_targets (deal_id, day, target) values ('d1000000-0000-4000-8000-000000000001', '2026-11-05', 31) $$,
  '23514', null, 'a day target above 30 is rejected'
);
select lives_ok(
  $$ insert into public.day_targets (deal_id, day, target) values ('d1000000-0000-4000-8000-000000000001', '2026-11-05', 0) $$,
  'a day target of 0 (a day off) is allowed'
);

-- Payable views: latest trusted reading inside posted_at + 14 days (cutoff 2026-11-16T15:00Z).
insert into public.post_view_snapshots (post_id, captured_day, captured_at, views, held)
values
  ('a1000000-0000-4000-8000-000000000001', '2026-11-10', '2026-11-10T12:00:00Z', 90000, true),
  ('a1000000-0000-4000-8000-000000000001', '2026-11-16', '2026-11-16T16:00:00Z', 800, false);
select results_eq(
  $$ select payable_views, latest_views, last_captured_day, latest_held
     from public.ugc_post_views where post_id = 'a1000000-0000-4000-8000-000000000001' $$,
  $$ values (100::bigint, 800::bigint, '2026-11-16'::date, false) $$,
  'payable views skip a held reading and one captured after the freeze'
);
update public.deals set view_freeze_days = 30 where id = 'd1000000-0000-4000-8000-000000000001';
select is(
  (select payable_views from public.ugc_post_views where post_id = 'a1000000-0000-4000-8000-000000000001'),
  800::bigint, 'a longer freeze window counts the later reading'
);
update public.post_view_snapshots set held = false where captured_day = '2026-11-10';
update public.post_view_snapshots set captured_at = '2026-11-16T14:00:00Z' where captured_day = '2026-11-16';
update public.deals set view_freeze_days = null where id = 'd1000000-0000-4000-8000-000000000001';
select is(
  (select payable_views from public.ugc_post_views where post_id = 'a1000000-0000-4000-8000-000000000001'),
  800::bigint, 'a reading inside the window counts once released'
);
select is(
  (select payable_views from public.ugc_post_views where post_id = 'a2000000-0000-4000-8000-000000000002'),
  null::bigint, 'a post without readings has no payable views'
);
update public.post_view_snapshots set held = true where captured_day = '2026-11-16';
select results_eq(
  $$ select post_id, views from public.ugc_last_trusted_views(
       array['a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002']::uuid[],
       '2026-11-20T00:00:00Z') $$,
  $$ values ('a1000000-0000-4000-8000-000000000001'::uuid, 90000::bigint) $$,
  'the set-views baseline is the last reading that is not held'
);
select results_eq(
  $$ select post_id, views from public.ugc_last_trusted_views(
       array['a1000000-0000-4000-8000-000000000001']::uuid[], '2026-11-03T12:00:01Z') $$,
  $$ values ('a1000000-0000-4000-8000-000000000001'::uuid, 100::bigint) $$,
  'the baseline ignores trusted readings captured after p_at'
);

-- Pause history (owner zone today; UTC when settings has no zone).
update public.deals set status = 'paused' where id = 'd2000000-0000-4000-8000-000000000002';
select is(
  (select paused_spans from public.deals where id = 'd2000000-0000-4000-8000-000000000002'),
  jsonb_build_array(jsonb_build_object('from',
    (now() at time zone coalesce((select time_zone from public.settings limit 1), 'UTC'))::date, 'to', null)),
  'pausing opens a span on today'
);
update public.deals set status = 'active' where id = 'd2000000-0000-4000-8000-000000000002';
select is(
  (select paused_spans from public.deals where id = 'd2000000-0000-4000-8000-000000000002'),
  '[]'::jsonb, 'a pause resumed the same day leaves nothing'
);
update public.deals set status = 'paused', paused_spans = '[{"from":"2026-10-01","to":"2026-10-03"}]'
where id = 'd2000000-0000-4000-8000-000000000002';
update public.deals set paused_spans = '[{"from":"2026-10-01","to":"2026-10-03"},{"from":"2026-11-02","to":null}]'
where id = 'd2000000-0000-4000-8000-000000000002';
update public.deals set status = 'ended', end_date = '2026-11-30' where id = 'd2000000-0000-4000-8000-000000000002';
select is(
  (select paused_spans from public.deals where id = 'd2000000-0000-4000-8000-000000000002'),
  jsonb_build_array(
    jsonb_build_object('from', '2026-10-01', 'to', '2026-10-03'),
    jsonb_build_object('from', '2026-11-02', 'to',
      (now() at time zone coalesce((select time_zone from public.settings limit 1), 'UTC'))::date - 1)),
  'leaving a pause closes the open span on yesterday and keeps older spans'
);
select throws_ok(
  $$ update public.deals set paused_spans = '{}' where id = 'd2000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'paused_spans must be an array'
);
reset role;

-- Service role (the Grokbot key): adds posts, never excludes. PostgREST sends no user id for it.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok(
  $$ insert into public.posts (deal_id, platform, url, posted_at, source)
     values ('d1000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/2', '2026-11-04T00:00:00Z', 'grokbot') $$,
  'the service role adds a post'
);
select throws_ok(
  $$ update public.posts set exclude_from_pay = false where id = 'a2000000-0000-4000-8000-000000000002' $$,
  '42501', null, 'the service role cannot change exclude'
);
select throws_ok(
  $$ insert into public.posts (deal_id, platform, url, posted_at, exclude_from_pay, source)
     values ('d1000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/3', now(), true, 'grokbot') $$,
  '42501', null, 'the service role cannot add an excluded post'
);
select throws_ok(
  $$ insert into public.posts (deal_id, platform, url, posted_at, exclude_from_pay, source)
     values ('d1000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/4', now(), true, 'ripple') $$,
  '42501', null, 'the service role cannot add an excluded post by labelling it ripple'
);
select throws_ok(
  $$ update public.posts set exclude_from_pay = true, source = 'ripple' where url = 'https://tiktok.com/@me/video/2' $$,
  '42501', null, 'the service role cannot exclude by relabelling a post ripple'
);
select throws_ok(
  $$ insert into public.posts (deal_id, platform, url, posted_at, source, source_id)
     values ('d1000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/5', now(), 'ripple', 'rp-planted') $$,
  '42501', null, 'the service role cannot plant a source=ripple post for the import to adopt'
);
select throws_ok(
  $$ insert into public.deals (brand_name, start_date, source, source_id) values ('Planted', '2026-11-01', 'ripple', 'rp-d1') $$,
  '42501', null, 'the service role cannot add a deal (ripple or not)'
);
insert into public.posts (deal_id, platform, url, posted_at, source, base_pay_cents_snap, cpm_rate_snap)
values ('d1000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/5', now(), 'grokbot', 100000000, 99999);
select is(
  (select base_pay_cents_snap from public.posts where url = 'https://tiktok.com/@me/video/5'),
  4000::bigint, 'the service role cannot forge rate snapshots'
);
-- What Grokbot does (lib/ugc/writes.ts addPost, setViews) still works; nothing else does.
select lives_ok(
  $$ update public.posts set title = 'from grok', video_group_id = 'g1', account_id = null
     where url = 'https://tiktok.com/@me/video/2' $$,
  'the service role updates a post''s title, group and account'
);
select lives_ok(
  $$ insert into public.post_view_snapshots (post_id, captured_day, captured_at, views, source)
     select id, '2026-11-05', '2026-11-05T12:00:00Z', 10, 'grokbot' from public.posts where url = 'https://tiktok.com/@me/video/2'
     on conflict (post_id, captured_day) do update set views = excluded.views, source = excluded.source $$,
  'the service role upserts a view reading'
);
select throws_ok(
  $$ insert into public.post_view_snapshots (post_id, captured_day, views, source)
     select id, '2026-11-06', 10, 'ripple' from public.posts where url = 'https://tiktok.com/@me/video/2' $$,
  '42501', null, 'the service role cannot add a ripple reading'
);
select throws_ok(
  $$ delete from public.posts where id = 'a1000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'the service role cannot delete a post'
);
select throws_ok(
  $$ update public.posts set deal_id = 'd2000000-0000-4000-8000-000000000002' where id = 'a1000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'the service role cannot move a post to another deal (a re-snapshot)'
);
select throws_ok(
  $$ update public.posts set posted_at = now() where id = 'a1000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'the service role cannot change a post''s date'
);
select throws_ok(
  $$ update public.deals set base_pay_cents = 1 where id = 'd1000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'the service role cannot edit a deal''s pay'
);
select throws_ok(
  $$ delete from public.deals where id = 'd1000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'the service role cannot delete a deal'
);
select throws_ok(
  $$ delete from public.post_view_snapshots $$,
  '42501', null, 'the service role cannot delete view readings'
);
select throws_ok(
  $$ insert into public.posts (deal_id, platform, url, posted_at, manual_override_cents, source)
     values ('d1000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/6', now(), 500, 'ripple') $$,
  '42501', null, 'the service role cannot add a ripple post with a manual override'
);
select throws_ok(
  $$ update public.posts set manual_override_cents = 1 where id = 'a1000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'the service role cannot change a manual override'
);
select throws_ok(
  $$ select private.ripple_import_apply('{}') $$,
  '42501', null, 'the service role cannot call the Ripple import'
);
reset role;

-- A security definer function owned by postgres does not lend its role to an API caller: the
-- exemption reads the session's role, not current_user.
create function public.tmp_definer_ripple_post(p_url text) returns void
language sql security definer set search_path = '' as $$
  insert into public.posts (deal_id, platform, url, posted_at, exclude_from_pay, manual_override_cents, source, source_id)
  values ('d1000000-0000-4000-8000-000000000001', 'TIKTOK', p_url, now(), true, 5, 'ripple', p_url);
$$;
grant execute on function public.tmp_definer_ripple_post(text) to service_role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select throws_ok(
  $$ select public.tmp_definer_ripple_post('https://tiktok.com/@me/video/7') $$,
  '42501', null, 'a postgres-owned definer function called by the service role cannot exclude a ripple post'
);
reset role;
drop function public.tmp_definer_ripple_post(text);

-- The database owner role (what private.ripple_import_apply runs as) inserts a ripple post with
-- Ripple's flag, override and every rate snapshot kept.
insert into public.posts (
  deal_id, platform, url, posted_at, exclude_from_pay, manual_override_cents, base_pay_cents_snap,
  base_min_views_snap, view_bonuses_snap, view_bonus_mode_snap, cpm_rate_snap, cpm_view_unit_snap,
  cpm_cap_views_snap, cpm_min_views_snap, cpm_tiers_snap, cpm_mode_snap, cpm_tier_mode_snap, source, source_id
) values (
  'd1000000-0000-4000-8000-000000000001', 'YOUTUBE', 'https://youtube.com/shorts/r1', '2026-10-01T00:00:00Z',
  true, 1250, 1234, 1000, '[{"views":10000,"bonusCents":5000}]', 'ADD', 7.5, 500, 50000, 100,
  '[{"views":100000,"ratePerUnit":9.5}]', 'REPLACE', 'COMBINED_FLAT', 'ripple', 'rp-1'
);
select results_eq(
  $$ select exclude_from_pay, manual_override_cents, base_pay_cents_snap, base_min_views_snap,
            view_bonuses_snap, view_bonus_mode_snap, cpm_rate_snap::text, cpm_view_unit_snap,
            cpm_cap_views_snap, cpm_min_views_snap, cpm_tiers_snap, cpm_mode_snap, cpm_tier_mode_snap
     from public.posts where source = 'ripple' and source_id = 'rp-1' $$,
  $$ values (true, 1250::bigint, 1234::bigint, 1000, '[{"views":10000,"bonusCents":5000}]'::jsonb, 'ADD'::text,
             '7.5000'::text, 500, 50000, 100, '[{"views":100000,"ratePerUnit":9.5}]'::jsonb, 'REPLACE'::text,
             'COMBINED_FLAT'::text) $$,
  'the database owner role inserts a ripple post with its own flag, override and rate snapshot'
);
update public.posts set base_pay_cents_snap = 1, title = 'edited' where source_id = 'rp-1';
select is(
  (select base_pay_cents_snap from public.posts where source_id = 'rp-1'),
  1234::bigint, 'the snapshot of an imported post is frozen after insert, for the database owner too'
);
insert into public.posts (deal_id, platform, url, posted_at, base_pay_cents_snap, source)
values ('d1000000-0000-4000-8000-000000000001', 'YOUTUBE', 'https://youtube.com/shorts/r2', '2026-10-02T00:00:00Z', 1234, 'hydra');
select is(
  (select base_pay_cents_snap from public.posts where url = 'https://youtube.com/shorts/r2'),
  4000::bigint, 'the exemption is for ripple posts only'
);
select throws_ok(
  $$ insert into public.posts (deal_id, platform, url, posted_at, exclude_from_pay, source)
     values ('d1000000-0000-4000-8000-000000000001', 'YOUTUBE', 'https://youtube.com/shorts/r3', now(), true, 'hydra') $$,
  '42501', null, 'outside a ripple insert even the database owner role cannot exclude without an owner session'
);
-- Grokbot may replace a Ripple reading of the same day with its own; it cannot label one ripple.
insert into public.post_view_snapshots (post_id, captured_day, captured_at, views, source)
select id, '2026-10-02', '2026-10-02T12:00:00Z', 5, 'ripple' from public.posts where source_id = 'rp-1';
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok(
  $$ insert into public.post_view_snapshots (post_id, captured_day, captured_at, views, source)
     select id, '2026-10-02', '2026-10-02T20:00:00Z', 9, 'grokbot' from public.posts where source_id = 'rp-1'
     on conflict (post_id, captured_day) do update set views = excluded.views, source = excluded.source $$,
  'the service role replaces a Ripple reading of the same day with its own'
);
select throws_ok(
  $$ update public.post_view_snapshots set source = 'ripple'
     where post_id = (select id from public.posts where source_id = 'rp-1') $$,
  '42501', null, 'the service role cannot relabel a reading ripple'
);
reset role;

-- Stranger: sees nothing, writes nothing.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.deals), 0, 'stranger sees zero deals');
select is((select count(*)::int from public.ugc_post_views), 0, 'stranger sees zero post views');
select throws_ok(
  $$ insert into public.deals (brand_name, start_date) values ('x', '2026-11-01') $$,
  '42501', null, 'stranger cannot add a deal'
);
update public.posts set title = 'pwned';
reset role;
select is((select count(*)::int from public.posts where title = 'pwned'), 0, 'stranger update changed nothing');

-- hydra_ro reads every UGC table and the view (it cannot see pgTAP, so it writes to a temp table).
grant hydra_ro to postgres with set true;
create temp table ro_out (k text primary key, v text) on commit drop;
grant all on ro_out to hydra_ro;
-- Only this test's deals, so rows already in the database do not change the counts.
create temp table test_deals (deal_id uuid) on commit drop;
insert into test_deals values ('d1000000-0000-4000-8000-000000000001'), ('d2000000-0000-4000-8000-000000000002');
grant select on test_deals to hydra_ro;
set local role hydra_ro;
insert into ro_out select 'deals', count(*)::text from public.deals where id in (select deal_id from test_deals);
insert into ro_out select 'views', count(*)::text from public.ugc_post_views where deal_id in (select deal_id from test_deals);
insert into ro_out select 'payments', count(*)::text from public.deal_payments where deal_id in (select deal_id from test_deals);
reset role;
select results_eq(
  $$ select k, v from ro_out order by k $$,
  $$ values ('deals'::text, '2'::text), ('payments', '1'), ('views', '6') $$,
  'hydra_ro reads deals, payments and post views'
);

select * from finish();
rollback;
