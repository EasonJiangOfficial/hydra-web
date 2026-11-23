-- pgTAP: posts.video_group_manual (0116). The owner sets it and moves hand-linked posts; Grokbot
-- (service_role) can still link unlinked posts but cannot set the flag or move a hand-linked post.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(12);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select col_default_is('public', 'posts', 'video_group_manual', 'false', 'video_group_manual defaults to false');

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.deals (id, brand_name, start_date, base_pay_cents)
values ('d1000000-0000-4000-8000-000000000001', 'Wordwise', '2026-11-01', 3500);
insert into public.posts (id, deal_id, platform, url, title, posted_at)
values
  ('a0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'TIKTOK', 'https://tiktok.com/@me/video/1', 'twin', '2026-11-10T15:00:00Z'),
  ('a0000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'INSTAGRAM', 'https://instagram.com/reel/2', 'twin', '2026-11-10T18:00:00Z'),
  ('a0000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001', 'YOUTUBE', 'https://youtube.com/shorts/3', 'other', '2026-11-10T18:00:00Z');
select lives_ok(
  $$ update public.posts set video_group_id = 'hand', video_group_manual = true
     where id = 'a0000000-0000-4000-8000-000000000003' $$,
  'the owner links a post by hand'
);
reset role;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok(
  $$ update public.posts set video_group_id = 'auto-a0000000-0000-4000-8000-000000000001'
     where id in ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002')
       and video_group_id is null and not video_group_manual $$,
  'Grokbot''s add path links unlinked cross-posts'
);
select is(
  (select count(*)::int from public.posts where video_group_id = 'auto-a0000000-0000-4000-8000-000000000001'),
  2, 'both twins are one video'
);
select throws_ok(
  $$ update public.posts set video_group_id = 'bot' where id = 'a0000000-0000-4000-8000-000000000003' $$,
  '42501', null, 'Grokbot cannot move a hand-linked post'
);
select throws_ok(
  $$ update public.posts set video_group_manual = false where id = 'a0000000-0000-4000-8000-000000000003' $$,
  '42501', null, 'Grokbot cannot clear the hand flag'
);
select throws_ok(
  $$ insert into public.posts (deal_id, platform, url, posted_at, video_group_manual, source)
     values ('d1000000-0000-4000-8000-000000000001', 'FACEBOOK', 'https://facebook.com/4', '2026-11-10T18:00:00Z', true, 'grokbot') $$,
  '42501', null, 'Grokbot cannot insert a hand-linked post'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok(
  $$ update public.posts set video_group_id = null where id = 'a0000000-0000-4000-8000-000000000003' $$,
  'the owner unlinks a hand-linked post'
);

-- Video matching on the page: a link and an unlink each come back with Undo (0130 activity).
set local request.headers = '{"x-hydra-activity":"a9000000-0000-4000-8000-000000000001"}';
update public.posts set video_group_id = 'manual-x', video_group_manual = true
where id in ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003');
set local request.headers = '{}';
select is((select public.undo_activity('a9000000-0000-4000-8000-000000000001') ->> 'ok'), 'true', 'a link by hand is undone');
select results_eq(
  $$ select video_group_id, video_group_manual from public.posts
     where id in ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003') order by id $$,
  $$ values ('auto-a0000000-0000-4000-8000-000000000001'::text, false), (null, true) $$,
  'the linked posts are back in their old videos with their old flags'
);
set local request.headers = '{"x-hydra-activity":"a9000000-0000-4000-8000-000000000002"}';
update public.posts set video_group_id = null, video_group_manual = true where id = 'a0000000-0000-4000-8000-000000000002';
set local request.headers = '{}';
select is((select public.undo_activity('a9000000-0000-4000-8000-000000000002') ->> 'ok'), 'true', 'an unlink by hand is undone');
select results_eq(
  $$ select video_group_id, video_group_manual from public.posts where id = 'a0000000-0000-4000-8000-000000000002' $$,
  $$ values ('auto-a0000000-0000-4000-8000-000000000001'::text, false) $$,
  'the unlinked post is back in its video, not hand-set'
);
reset role;

select * from finish();
rollback;
