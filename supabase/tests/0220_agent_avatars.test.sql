-- pgTAP: avatars (0220). Name 1 to 40 characters, a Fish 32-hex voice id, curse and slang off by default, style notes
-- up to 1000 characters; owner-only RLS, hydra_ro reads; agent_settings.active_avatar_id goes back to null (Hydra's own
-- voice) when the avatar is deleted; logged for undo.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(22);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test')
on conflict (id) do nothing;
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select has_table('public', 'agent_avatars', 'agent_avatars exists');
select is((select relrowsecurity from pg_class where oid = 'public.agent_avatars'::regclass), true, 'RLS is on');
select is((select count(*)::int from public.agent_avatars), 0, 'nothing is seeded');
select has_column('public', 'agent_settings', 'active_avatar_id', 'agent_settings has the active avatar');
select is(
  (select logged from private.activity_tables where tbl = 'agent_avatars'), true, 'avatars are logged for undo');
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.agent_avatars'::regclass and tgname = '0_activity_capture'),
  'avatars have the capture trigger');

-- The owner.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
delete from public.agent_settings;
insert into public.agent_settings (user_id) values ('11111111-1111-1111-1111-111111111111');
select is((select active_avatar_id from public.agent_settings), null, 'no avatar by default: Hydra''s own voice');

insert into public.agent_avatars (id, name, fish_voice_id)
values ('a0000000-0000-4000-8000-000000000220', 'Tony', '0123456789abcdef0123456789abcdef');
select is((select curse::text || ' ' || slang::text || ' [' || style_notes || ']' from public.agent_avatars),
  'false false []', 'curse and slang are off, no notes, by default');

select throws_ok($$ insert into public.agent_avatars (name, fish_voice_id) values ('  ', '0123456789abcdef0123456789abcdef') $$,
  '23514', null, 'a blank name is refused');
select throws_ok($$ insert into public.agent_avatars (name, fish_voice_id) values (repeat('x', 41), '0123456789abcdef0123456789abcdef') $$,
  '23514', null, 'a name over 40 characters is refused');
select lives_ok($$ update public.agent_avatars set name = repeat('x', 40) $$, 'a 40 character name is fine');
select throws_ok($$ update public.agent_avatars set fish_voice_id = '0123456789ABCDEF0123456789ABCDEF' $$,
  '23514', null, 'the voice id is lower case hex');
select throws_ok($$ update public.agent_avatars set fish_voice_id = '0123456789abcdef' $$,
  '23514', null, 'the voice id is 32 characters');
select throws_ok($$ update public.agent_avatars set style_notes = repeat('x', 1001) $$,
  '23514', null, 'style notes over 1000 characters are refused');
select lives_ok($$ update public.agent_avatars set curse = true, slang = true, style_notes = repeat('x', 1000) $$,
  'the owner turns curse and slang on and writes 1000 characters of notes');

update public.agent_settings set active_avatar_id = 'a0000000-0000-4000-8000-000000000220';
select is((select active_avatar_id from public.agent_settings), 'a0000000-0000-4000-8000-000000000220'::uuid, 'the owner picks the avatar');
select throws_ok($$ update public.agent_settings set active_avatar_id = 'a0000000-0000-4000-8000-0000000002ff' $$,
  '23503', null, 'only an avatar that exists');
delete from public.agent_avatars;
select is((select active_avatar_id from public.agent_settings), null, 'deleting the avatar goes back to Hydra''s own voice');

-- A stranger and anon.
insert into public.agent_avatars (name, fish_voice_id) values ('Kept', 'fedcba9876543210fedcba9876543210');
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.agent_avatars), 0, 'a stranger sees no avatars');
select throws_ok($$ insert into public.agent_avatars (name, fish_voice_id) values ('Mine', 'fedcba9876543210fedcba9876543210') $$,
  '42501', null, 'a stranger cannot add one');
reset role;

set local role anon;
select throws_ok($$ select id from public.agent_avatars $$, '42501', null, 'anon cannot read avatars');
reset role;

select ok(has_table_privilege('hydra_ro', 'public.agent_avatars', 'select'), 'hydra_ro reads avatars');

select * from finish();
rollback;
