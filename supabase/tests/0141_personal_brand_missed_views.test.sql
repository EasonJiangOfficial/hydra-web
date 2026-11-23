-- pgTAP: 0141. The missed-view warning leaves Personal Brand posts out; the view sync's work list keeps them.
-- Now = 2026-11-21 12:00 UTC; zone UTC.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(4);

-- A UGC post with every needed reading, and a Personal Brand post with none.
insert into public.deals (id, brand_name, start_date) values ('d1410000-0000-4000-8000-000000000001', 'Acme', '2026-09-01');
insert into public.deals (id, brand_name, start_date, personal_brand) values ('d1410000-0000-4000-8000-000000000002', 'Personal Brand', '2026-09-01', true);
insert into public.posts (id, deal_id, platform, url, posted_at, exclude_from_pay)
values
  ('e1410000-0000-4000-8000-000000000001', 'd1410000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/141', '2026-11-18T10:00:00Z', false),
  ('e1410000-0000-4000-8000-000000000002', 'd1410000-0000-4000-8000-000000000002', 'INSTAGRAM', 'https://www.instagram.com/reel/PB141/', '2026-11-18T10:00:00Z', false);
insert into public.post_view_snapshots (post_id, captured_day, captured_at, views)
values
  ('e1410000-0000-4000-8000-000000000001', '2026-11-19', '2026-11-19T08:00:00Z', 500),
  ('e1410000-0000-4000-8000-000000000001', '2026-11-20', '2026-11-20T08:00:00Z', 700);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is(
  (select count(*)::int from public.ugc_missed_view_days(7, '2026-11-21T12:00:00Z')),
  0, 'an unread Personal Brand post is no UGC missed-view day'
);
select ok(
  exists (select 1 from public.ugc_posts_needing_views('2026-11-21T12:00:00Z') where post_id = 'e1410000-0000-4000-8000-000000000002'),
  'the view sync still reads the Personal Brand post'
);
reset role;

-- The same post on a UGC deal is a gap again.
update public.deals set personal_brand = false where id = 'd1410000-0000-4000-8000-000000000002';
set local role service_role;
select results_eq(
  $$ select day, posts_needing, posts_read from public.ugc_missed_view_days(7, '2026-11-21T12:00:00Z') $$,
  $$ values ('2026-11-19'::date, 2, 1), ('2026-11-20'::date, 2, 1) $$,
  'an unread UGC post still warns'
);
reset role;

select is(
  (select string_agg(r, ',' order by r) from unnest(array['authenticated', 'service_role', 'hydra_ro', 'anon']) r
   where has_function_privilege(r, 'public.ugc_missed_view_days(integer, timestamptz)', 'execute')),
  'authenticated,hydra_ro,service_role', 'grants kept: anon cannot call it'
);

select * from finish();
rollback;
