-- pgTAP: Notes (0210). Shape, checks, owner-only RLS, grants, the search vector, updated_at that follows the
-- content (not the pin), the compare-and-set save, client_id idempotency, and delete with the Activity undo.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(28);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select has_table('public', 'notes', 'notes exists');
select is((select relrowsecurity from pg_class where oid = 'public.notes'::regclass), true, 'RLS is on');
select col_is_unique('public', 'notes', 'client_id', 'client_id is unique (idempotent device retries)');
select has_index('public', 'notes', 'notes_updated_idx', 'notes are listed by updated_at');
select has_index('public', 'notes', 'notes_search_idx', 'the search vector has a GIN index');
select is(
  (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'notes' and grantee = 'hydra_ro'),
  'SELECT', 'hydra_ro only reads'
);
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'notes' and grantee in ('anon', 'service_role')),
  0, 'anon and service_role get nothing'
);
set local role anon;
select throws_ok($$ select * from public.notes $$, '42501', null, 'anon cannot read notes');
reset role;

-- Stranger: reads nothing, writes nothing.
insert into public.notes (id, title, doc, text) values ('b0000000-0000-4000-8000-000000000009', 'Hidden', '[]', '');
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.notes), 0, 'a non-owner sees no notes');
select throws_ok(
  $$ insert into public.notes (title, doc, text) values ('Mine', '[]', '') $$,
  '42501', null, 'a non-owner cannot add a note'
);
reset role;
delete from public.notes where id = 'b0000000-0000-4000-8000-000000000009';

-- Owner.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
set local request.headers = '{"x-hydra-activity":"a2100000-0000-4000-8000-000000000001"}';
insert into public.notes (id, title, doc, text, source, client_id, updated_at)
values ('b0000000-0000-4000-8000-000000000001', 'Groceries',
        '[{"type":"paragraph","content":[{"type":"text","text":"oat milk","styles":{}}]}]', 'oat milk', 'desktop', 'call_1:0',
        '2026-01-01T00:00:00Z');
select is((select source from public.notes where id = 'b0000000-0000-4000-8000-000000000001'), 'desktop', 'the source is kept');
select is((select pinned from public.notes where id = 'b0000000-0000-4000-8000-000000000001'), false, 'a note starts unpinned');
select ok(
  (select search @@ to_tsquery('simple', 'oat:* & groc:*') from public.notes where id = 'b0000000-0000-4000-8000-000000000001'),
  'the search vector covers the title and the text, by prefix'
);
update public.notes set text = 'Email sam@glow.co about v2.5 at docs.example.com' where id = 'b0000000-0000-4000-8000-000000000001';
select ok(
  (select search @@ to_tsquery('simple', 'glow:* & example:* & v2:* & 5:*') from public.notes where id = 'b0000000-0000-4000-8000-000000000001'),
  'words inside emails, hosts and versions are found'
);
select ok(
  (select search @@ to_tsquery('simple', 'sam@glow.co:*') from public.notes where id = 'b0000000-0000-4000-8000-000000000001'),
  'the whole email is found too'
);
update public.notes set text = 'oat milk', updated_at = '2026-01-01T00:00:00Z' where id = 'b0000000-0000-4000-8000-000000000001';

-- client_id: a retry with the same id adds nothing.
insert into public.notes (title, doc, text, client_id) values ('Groceries again', '[]', '', 'call_1:0')
  on conflict (client_id) do nothing;
select is((select count(*)::int from public.notes where client_id = 'call_1:0'), 1, 'a retry with the same client_id adds no second note');

-- updated_at follows the content, not the pin.
update public.notes set pinned = true where id = 'b0000000-0000-4000-8000-000000000001';
select is((select updated_at from public.notes where id = 'b0000000-0000-4000-8000-000000000001'), '2026-01-01T00:00:00Z'::timestamptz, 'pinning keeps updated_at');
update public.notes set updated_at = '2020-01-01' where id = 'b0000000-0000-4000-8000-000000000001';
select is((select updated_at from public.notes where id = 'b0000000-0000-4000-8000-000000000001'), '2026-01-01T00:00:00Z'::timestamptz, 'updated_at cannot be set by hand');
-- The compare-and-set save: the right updated_at wins, a stale one changes nothing.
update public.notes set title = 'Groceries (Sat)' where id = 'b0000000-0000-4000-8000-000000000001' and updated_at = '2026-01-01T00:00:00Z';
select isnt((select updated_at from public.notes where id = 'b0000000-0000-4000-8000-000000000001'), '2026-01-01T00:00:00Z'::timestamptz, 'a title change moves updated_at');
update public.notes set title = 'Stale' where id = 'b0000000-0000-4000-8000-000000000001' and updated_at = '2026-01-01T00:00:00Z';
select is((select title from public.notes where id = 'b0000000-0000-4000-8000-000000000001'), 'Groceries (Sat)', 'a save from a stale copy changes nothing');

-- Checks.
select throws_ok($$ insert into public.notes (doc) values ('{"type":"paragraph"}') $$, '23514', null, 'doc is a block array');
select throws_ok($$ insert into public.notes (source) values ('fax') $$, '23514', null, 'an unknown source is refused');
select throws_ok($$ insert into public.notes (title) values (repeat('x', 201)) $$, '23514', null, 'a title over 200 is refused');
select throws_ok($$ insert into public.notes (client_id) values ('') $$, '23514', null, 'an empty client_id is refused');

-- Delete, then undo it from Activity: the note comes back whole.
set local request.headers = '{"x-hydra-activity":"a2100000-0000-4000-8000-000000000002"}';
delete from public.notes where id = 'b0000000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.notes where id = 'b0000000-0000-4000-8000-000000000001'), 0, 'the owner deletes a note');
set local request.headers = '{}';
select is((select public.undo_activity('a2100000-0000-4000-8000-000000000002') ->> 'ok'), 'true', 'the delete is undone from Activity');
select results_eq(
  $$ select title, text, pinned, client_id from public.notes where id = 'b0000000-0000-4000-8000-000000000001' $$,
  $$ values ('Groceries (Sat)'::text, 'oat milk'::text, true, 'call_1:0'::text) $$,
  'the restored note has its title, text, pin and client_id'
);
reset role;

-- Activity (0130): listed as logged, with the capture trigger.
select ok(
  exists (select 1 from private.activity_tables where tbl = 'notes' and logged)
  and exists (select 1 from pg_trigger t where t.tgrelid = 'public.notes'::regclass and t.tgname = '0_activity_capture'),
  'notes are logged for undo'
);

select * from finish();
rollback;
