-- pgTAP: taxes (0110). Owner-only RLS on settings, estimated payments and document metadata,
-- explicit grants, shape checks, and the private tax-docs bucket with owner-only storage policies.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(26);

delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select has_table('public', 'tax_settings', 'tax_settings exists');
select has_table('public', 'tax_estimated_payments', 'tax_estimated_payments exists');
select has_table('public', 'tax_documents', 'tax_documents exists');
select is(
  (select count(*)::int from pg_class
   where oid in ('public.tax_settings'::regclass, 'public.tax_estimated_payments'::regclass, 'public.tax_documents'::regclass)
     and relrowsecurity),
  3, 'RLS is on for all three'
);

-- Grants: anon has nothing; authenticated has the four DML privileges; hydra_ro only reads.
set local role anon;
select throws_ok($$ select * from public.tax_settings $$, '42501', null, 'anon cannot read settings');
reset role;
select is(
  (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'tax_estimated_payments' and grantee = 'authenticated'),
  'DELETE,INSERT,SELECT,UPDATE', 'authenticated holds only select, insert, update, delete'
);
select is(
  (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'tax_documents' and grantee = 'hydra_ro'),
  'SELECT', 'hydra_ro only reads'
);

-- Stranger (signed in, not the owner): reads nothing and writes nothing.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select throws_ok(
  $$ insert into public.tax_settings (entity_id, year, set_aside_bps) values ((select id from public.entities where slug = 'ugc'), 2026, 2500) $$,
  '42501', null, 'a non-owner cannot save a rate'
);
select throws_ok(
  $$ insert into public.tax_estimated_payments (entity_id, year, quarter, amount_cents, paid_on)
     values ((select id from public.entities where slug = 'ugc'), 2026, 1, 100, '2026-04-15') $$,
  '42501', null, 'a non-owner cannot record a payment'
);
reset role;

-- Owner.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.tax_settings (entity_id, year, set_aside_bps)
values ((select id from public.entities where slug = 'ugc'), 2026, 2500);
select is((select set_aside_bps from public.tax_settings), 2500, 'owner saves and reads a rate');
select throws_ok(
  $$ insert into public.tax_settings (entity_id, year, set_aside_bps) values ((select id from public.entities where slug = 'personal'), 2026, 10001) $$,
  '23514', null, 'a rate above 100% is refused'
);
select throws_ok(
  $$ insert into public.tax_settings (entity_id, year, set_aside_bps) values ((select id from public.entities where slug = 'ugc'), 2026, 3000) $$,
  '23505', null, 'one rate per entity and year'
);

insert into public.tax_estimated_payments (entity_id, year, quarter, amount_cents, paid_on)
values ((select id from public.entities where slug = 'ugc'), 2026, 1, 210000, '2026-04-14');
select is((select count(*)::int from public.tax_estimated_payments), 1, 'owner records a payment');
select throws_ok(
  $$ insert into public.tax_estimated_payments (entity_id, year, quarter, amount_cents, paid_on)
     values ((select id from public.entities where slug = 'ugc'), 2026, 1, 5, '2026-04-15') $$,
  '23505', null, 'one payment per quarter'
);
select throws_ok(
  $$ insert into public.tax_estimated_payments (entity_id, year, quarter, amount_cents, paid_on)
     values ((select id from public.entities where slug = 'ugc'), 2026, 5, 5, '2026-04-15') $$,
  '23514', null, 'quarter is 1 to 4'
);
select throws_ok(
  $$ insert into public.tax_estimated_payments (entity_id, year, quarter, amount_cents, paid_on)
     values ((select id from public.entities where slug = 'ugc'), 2026, 2, 0, '2026-06-15') $$,
  '23514', null, 'an amount must be above zero'
);

insert into public.tax_documents (entity_id, year, kind, name, payer, storage_path, mime_type, size_bytes)
values ((select id from public.entities where slug = 'ugc'), 2026, 'w9', 'w9-wordwise.pdf', 'Wordwise', 'ugc/2026/a-w9-wordwise.pdf', 'application/pdf', 84300);
select is((select count(*)::int from public.tax_documents), 1, 'owner records a document');
select throws_ok(
  $$ insert into public.tax_documents (entity_id, year, kind, name, storage_path)
     values ((select id from public.entities where slug = 'ugc'), 2026, 'invoice', 'x.pdf', 'ugc/2026/b.pdf') $$,
  '23514', null, 'kind is w9, 1099 or other'
);
select throws_ok(
  $$ insert into public.tax_documents (entity_id, year, kind, name, storage_path)
     values ((select id from public.entities where slug = 'ugc'), 2026, 'other', 'y.pdf', 'ugc/2026/a-w9-wordwise.pdf') $$,
  '23505', null, 'a file path is recorded once'
);

-- The private bucket: owner reads and writes its objects; anon and a stranger do not.
insert into storage.objects (bucket_id, name) values ('tax-docs', 'ugc/2026/a-w9-wordwise.pdf');
select is((select count(*)::int from storage.objects where bucket_id = 'tax-docs'), 1, 'owner stores and reads a file');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from storage.objects where bucket_id = 'tax-docs'), 0, 'a stranger sees no files');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('tax-docs', 'ugc/2026/evil.pdf') $$,
  '42501', null, 'a stranger cannot upload'
);
reset role;
set local role anon;
select is((select count(*)::int from storage.objects where bucket_id = 'tax-docs'), 0, 'anon sees no files');
reset role;

select is(
  (select public from storage.buckets where id = 'tax-docs'),
  false, 'the bucket is private'
);
select is(
  (select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'tax_docs_owner_%'),
  4, 'four owner policies on the bucket'
);
select is(
  (select count(*)::int from pg_policies where tablename in ('tax_settings', 'tax_estimated_payments', 'tax_documents') and roles && array['anon']::name[]),
  0, 'no policy for anon'
);

select * from finish();
rollback;
