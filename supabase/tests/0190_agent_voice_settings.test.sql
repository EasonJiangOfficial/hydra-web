-- pgTAP: the shared voice settings (0190). The wake phrase (2 to 40 characters, trimmed) and the clap
-- sensitivity (low, medium, high) live on agent_settings with their defaults; the owner changes them,
-- a stranger and anon cannot read them.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(12);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select has_column('public', 'agent_settings', 'wake_phrase', 'agent_settings has the wake phrase');
select has_column('public', 'agent_settings', 'clap_sensitivity', 'agent_settings has the clap sensitivity');

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
delete from public.agent_settings;
insert into public.agent_settings (user_id) values ('11111111-1111-1111-1111-111111111111');
select is((select wake_phrase from public.agent_settings), 'Hey Hydra', 'the wake phrase is Hey Hydra by default');
select is((select clap_sensitivity from public.agent_settings), 'medium', 'the clap sensitivity is medium by default');
select is((select model || ' ' || effort_live || ' ' || effort_routine from public.agent_settings), 'claude-opus-5-5 low medium', 'Opus 5.5, live low, routine medium');

update public.agent_settings set wake_phrase = 'Okay Hydra', clap_sensitivity = 'high';
select is((select wake_phrase || ' / ' || clap_sensitivity from public.agent_settings), 'Okay Hydra / high', 'the owner changes both');
select throws_ok($$ update public.agent_settings set wake_phrase = ' a ' $$, '23514', null, 'a wake phrase under 2 characters is refused');
select throws_ok($$ update public.agent_settings set wake_phrase = repeat('x', 41) $$, '23514', null, 'a wake phrase over 40 characters is refused');
select lives_ok($$ update public.agent_settings set wake_phrase = repeat('x', 40) $$, 'a 40 character wake phrase is fine');
select throws_ok($$ update public.agent_settings set clap_sensitivity = 'max' $$, '23514', null, 'clap sensitivity is low, medium or high');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.agent_settings), 0, 'a stranger sees no agent settings');
reset role;

set local role anon;
select throws_ok($$ select wake_phrase from public.agent_settings $$, '42501', null, 'anon cannot read agent settings');
reset role;

select * from finish();
rollback;
