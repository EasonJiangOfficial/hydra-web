-- pgTAP: approve all (0200). agent_settings.approve_all is a boolean, off by default and never null; the owner
-- turns it on and off; a stranger and anon cannot read or change it (0070's owner-only RLS, unchanged). An approval's
-- dedupe_key is unique (one auto-approved MCP run per window); rows without one never collide; a renamed key fits.
-- A device's capabilities are a small JSON object, {} by default. A desktop job approve all let through (needs_tags)
-- goes only to a pull that declares the tags; every other job to any pull, as before.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(23);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select has_column('public', 'agent_settings', 'approve_all', 'agent_settings has approve_all');
select col_type_is('public', 'agent_settings', 'approve_all', 'boolean', 'approve_all is a boolean');
select col_not_null('public', 'agent_settings', 'approve_all', 'approve_all is never null');
select col_default_is('public', 'agent_settings', 'approve_all', 'false', 'approve_all is off by default');

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
delete from public.agent_settings;
insert into public.agent_settings (user_id) values ('11111111-1111-1111-1111-111111111111');
select is((select approve_all from public.agent_settings), false, 'a new settings row has approve all off');
update public.agent_settings set approve_all = true;
select is((select approve_all from public.agent_settings), true, 'the owner turns it on');
select throws_ok($$ update public.agent_settings set approve_all = null $$, '23502', null, 'it cannot be null');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.agent_settings), 0, 'a stranger sees no agent settings');
update public.agent_settings set approve_all = false;
reset role;
select is((select approve_all from public.agent_settings), true, 'a stranger cannot turn it off');

set local role anon;
select throws_ok($$ select approve_all from public.agent_settings $$, '42501', null, 'anon cannot read it');
reset role;

select col_is_unique('public', 'agent_approvals', 'dedupe_key', 'an approval dedupe key is unique');
insert into public.agent_approvals (source, tool, summary, reason, status, expires_at, dedupe_key)
values ('mcp', 'gmail_send', 'Send', 'send', 'approved', now() + interval '15 minutes', 'mcp:d:gmail_send:h:1');
select throws_ok(
  $$ insert into public.agent_approvals (source, tool, summary, reason, status, expires_at, dedupe_key)
     values ('mcp', 'gmail_send', 'Send', 'send', 'approved', now() + interval '15 minutes', 'mcp:d:gmail_send:h:1') $$,
  '23505', null, 'the same auto-approved call twice in one window is refused');
insert into public.agent_approvals (source, tool, summary, reason, expires_at)
values ('mcp', 'gmail_send', 'Send', 'send', now() + interval '15 minutes'), ('mcp', 'gmail_send', 'Send', 'send', now() + interval '15 minutes');
select is((select count(*)::int from public.agent_approvals where dedupe_key is null), 2, 'asks without a key never collide');
-- The store slides the window by renaming an older holder's key to key:id: the longest (a 64-character tool name) fits.
select lives_ok(
  $$ insert into public.agent_approvals (source, tool, summary, reason, status, expires_at, dedupe_key)
     values ('mcp', 'gmail_send', 'Send', 'send', 'done', now() + interval '15 minutes',
       'mcp:' || gen_random_uuid() || ':' || repeat('t', 64) || ':' || repeat('h', 32) || ':' || gen_random_uuid()) $$,
  'a renamed key (key:id) fits the length check');

select has_column('public', 'agent_devices', 'capabilities', 'agent_devices has capabilities');
insert into public.agent_devices (name, key_hash) values ('Hydra Desktop', repeat('a', 64));
select is((select capabilities from public.agent_devices where key_hash = repeat('a', 64)), '{}'::jsonb, 'a device declares nothing by default');
select throws_ok($$ update public.agent_devices set capabilities = '[1]'::jsonb $$, '23514', null, 'capabilities are an object');
select throws_ok(
  $$ update public.agent_devices set capabilities = jsonb_build_object('x', repeat('y', 600)) $$,
  '23514', null, 'capabilities stay small');

select col_default_is('public', 'agent_desktop_jobs', 'needs_tags', 'false', 'a desktop job needs no tags by default');
delete from public.agent_desktop_jobs;
insert into public.agent_desktop_jobs (instruction, risky, needs_tags) values ('Quit Safari', true, false), ('Quit TextEdit', true, true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(
  (select array_agg(instruction) from public.agent_claim_desktop_jobs((select id from public.agent_devices limit 1), 10)),
  array['Quit Safari'], 'a pull without the tags (two arguments, as before) skips the job approve all let through');
select is(
  (select array_agg(instruction) from public.agent_claim_desktop_jobs((select id from public.agent_devices limit 1), 10, null)),
  null::text[], 'a pull with unknown tags gets nothing');
select is(
  (select array_agg(instruction) from public.agent_claim_desktop_jobs((select id from public.agent_devices limit 1), 10, true)),
  array['Quit TextEdit'], 'a pull that declares the tags claims it');
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select throws_ok($$ select * from public.agent_claim_desktop_jobs(null, 10, true) $$, '42501', null, 'a stranger cannot claim');
reset role;

select * from finish();
rollback;
