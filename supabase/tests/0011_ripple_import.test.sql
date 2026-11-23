-- pgTAP: Ripple import. Owner-only RLS on deal_templates and import_ripple_map, a template takes a
-- deal's checks, the map is unique per entity and Ripple id, the deal-logos bucket is private and
-- owner only, hydra_ro reads. private.ripple_import_apply: database owner role only, insert-only,
-- a rerun inserts nothing, owner edits and deletions survive a rerun. Sets up and cleans up inside
-- its own transaction (Ripple ids and URLs are test-only), so prior database state does not
-- matter. Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(53);

-- Fixtures: an owner and a stranger (ownerless start; a bootstrapped owner comes back on rollback).
delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select public.bootstrap_owner('11111111-1111-1111-1111-111111111111');

select is(
  (select count(*)::int from pg_tables
   where schemaname = 'public' and rowsecurity and tablename in ('deal_templates', 'import_ripple_map')),
  2, 'RLS is on for deal_templates and import_ripple_map'
);
select hasnt_column('public', 'deal_templates', 'start_date', 'a template has no dates of its own');
select hasnt_column('public', 'deal_templates', 'entity_id', 'a template belongs to no entity');
select results_eq(
  $$ select public, file_size_limit from storage.buckets where id = 'deal-logos' $$,
  $$ values (false, 10485760::bigint) $$,
  'deal-logos is a private bucket with a 10 MB limit'
);

-- Anon: no grants.
set local role anon;
select throws_ok($$ select * from public.deal_templates $$, '42501', null, 'anon cannot read deal_templates');
select throws_ok($$ select * from public.import_ripple_map $$, '42501', null, 'anon cannot read import_ripple_map');
select throws_ok($$ select private.ripple_import_apply('{}') $$, '42501', null, 'anon cannot run the Ripple import');
reset role;

-- The import function: no API role can execute it, and the service role (the Grokbot key) has no
-- rights on the import tables.
select ok(
  not has_function_privilege('anon', 'private.ripple_import_apply(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'private.ripple_import_apply(jsonb)', 'execute')
  and not has_function_privilege('service_role', 'private.ripple_import_apply(jsonb)', 'execute'),
  'anon, authenticated and service_role have no EXECUTE on the Ripple import'
);
select ok(
  not has_table_privilege('service_role', 'public.import_ripple_map', 'insert,update,delete')
  and not has_table_privilege('service_role', 'public.deal_templates', 'insert,update,delete'),
  'the service role cannot write the import map or templates'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select throws_ok($$ select private.ripple_import_apply('{}') $$, '42501', null, 'the service role cannot run the Ripple import');
reset role;
-- Even a granted EXECUTE does not help: the function itself checks the session's role.
grant usage on schema private to service_role;
grant execute on function private.ripple_import_apply(jsonb) to service_role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select throws_ok(
  $$ select private.ripple_import_apply('{}') $$,
  '42501', 'the Ripple import runs only as the database owner role',
  'the import refuses a service-role session even with EXECUTE granted'
);
reset role;
revoke execute on function private.ripple_import_apply(jsonb) from service_role;
revoke usage on schema private from service_role;

-- A Ripple template is written by the database owner role (as the import does).
insert into public.deal_templates (id, brand_name, base_pay_cents, view_bonuses, source, source_id)
values ('e1000000-0000-4000-8000-000000000001', 'Glow', 3500, '[{"views":10000,"bonusCents":5000}]', 'ripple', 'cm-master-1');
select throws_ok(
  $$ insert into public.deal_templates (brand_name, source, source_id) values ('Again', 'ripple', 'cm-master-1') $$,
  '23505', null, 'one template per Ripple campaign'
);

-- Owner.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select throws_ok(
  $$ insert into public.deal_templates (brand_name, source, source_id) values ('Planted', 'ripple', 'cm-planted') $$,
  '42501', null, 'the owner''s session cannot add a source=ripple template'
);
select throws_ok(
  $$ update public.deal_templates set source = 'hydra' where id = 'e1000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'the owner''s session cannot relabel a Ripple template'
);
select results_eq(
  $$ select archived, daily_target_posts, view_bonus_mode, cpm_tier_mode from public.deal_templates
     where id = 'e1000000-0000-4000-8000-000000000001' $$,
  $$ values (false, 1, 'REPLACE'::text, 'PER_VIDEO'::text) $$,
  'template defaults match a deal''s'
);
select throws_ok(
  $$ insert into public.deal_templates (brand_name, daily_target_posts) values ('Bad', 31) $$,
  '23514', null, 'a template takes the deal checks (daily target above 30 rejected)'
);
select throws_ok(
  $$ insert into public.deal_templates (brand_name, base_pay_cents) values ('Bad', -1) $$,
  '23514', null, 'a template rejects negative base pay'
);

insert into public.import_ripple_map (entity, ripple_id, hydra_id)
values ('deal_template', 'cm-master-1', 'e1000000-0000-4000-8000-000000000001');
select throws_ok(
  $$ insert into public.import_ripple_map (entity, ripple_id, hydra_id)
     values ('deal_template', 'cm-master-1', 'e2000000-0000-4000-8000-000000000002') $$,
  '23505', null, 'a Ripple id maps once per entity'
);
select lives_ok(
  $$ insert into public.import_ripple_map (entity, ripple_id, hydra_id)
     values ('deal', 'cm-master-1', 'e2000000-0000-4000-8000-000000000002') $$,
  'the same Ripple id may map under another entity'
);
select throws_ok(
  $$ insert into public.import_ripple_map (entity, ripple_id, hydra_id)
     values ('payment', 'x', 'e2000000-0000-4000-8000-000000000002') $$,
  '23514', null, 'an unknown entity is rejected'
);
update public.deal_templates set brand_name = 'Glow Co' where id = 'e1000000-0000-4000-8000-000000000001';
select is(
  (select brand_name from public.deal_templates where id = 'e1000000-0000-4000-8000-000000000001'),
  'Glow Co', 'the owner can edit a template'
);
select throws_ok(
  $$ select private.ripple_import_apply('{}') $$,
  '42501', null, 'the owner''s session cannot run the Ripple import'
);
reset role;

-- Storage: a logo object in deal-logos (written as postgres, as the service role would).
insert into storage.objects (bucket_id, name) values ('deal-logos', 'ripple/campaign-logos/test/logo.jpg');

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(
  (select count(*)::int from storage.objects where bucket_id = 'deal-logos' and name = 'ripple/campaign-logos/test/logo.jpg'),
  1, 'the owner can read a deal logo'
);
select lives_ok(
  $$ insert into storage.objects (bucket_id, name) values ('deal-logos', 'own/upload.png') $$,
  'the owner can upload a deal logo'
);

-- Stranger: sees nothing, writes nothing.
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.deal_templates where source_id = 'cm-master-1'), 0, 'a stranger sees no templates');
select is((select count(*)::int from public.import_ripple_map where ripple_id = 'cm-master-1'), 0, 'a stranger sees no map rows');
select is(
  (select count(*)::int from storage.objects where bucket_id = 'deal-logos'),
  0, 'a stranger sees no deal logos'
);
select throws_ok(
  $$ insert into public.deal_templates (brand_name) values ('Mine') $$,
  '42501', null, 'a stranger cannot add a template'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('deal-logos', 'evil.png') $$,
  '42501', null, 'a stranger cannot upload a deal logo'
);
reset role;

-- ---------------------------------------------------------------------------
-- The import itself, as the database owner role (postgres), with rows in the importer's shape.
-- ---------------------------------------------------------------------------
create temp table imp (k text primary key, j jsonb) on commit drop;
insert into imp values ('payload', $json${
  "templates": [
    {"ripple_ids": ["pgtap-0011-m1"], "row": {"brand_name": "Glow master", "logo_path": "ripple/x/m1.png",
     "base_pay_cents": 4000, "view_bonuses": [{"views": 10000, "bonusCents": 5000}], "archived": false,
     "source": "ripple", "source_id": "pgtap-0011-m1"}}
  ],
  "deals": [
    {"ripple_ids": ["pgtap-0011-dA"],
     "row": {"brand_name": "Deal A", "logo_path": "ripple/x/a.png", "status": "active", "start_date": "2026-10-01",
             "end_date": null, "base_pay_cents": 3500, "base_min_views": 1000, "cpm_rate": "2.2500",
             "view_freeze_days": 14, "retainer_cents": 10000, "daily_target_posts": 3,
             "source": "ripple", "source_id": "pgtap-0011-dA"},
     "accounts": [{"key": "pgtap-0011-dA|TIKTOK|me", "ripple_ids": ["pgtap-0011-a1", "pgtap-0011-a2"],
                   "row": {"platform": "TIKTOK", "handle": "me"}}],
     "posts": [
       {"ripple_ids": ["pgtap-0011-p1"], "account": "pgtap-0011-dA|TIKTOK|me",
        "row": {"platform": "TIKTOK", "url": "https://tiktok.com/@me/video/pgtap-0011-1", "title": "One",
                "posted_at": "2026-10-02T10:00:00.000Z", "video_group_id": "uv1", "exclude_from_pay": true,
                "manual_override_cents": 1250, "base_pay_cents_snap": 3500, "base_min_views_snap": 1000,
                "view_bonuses_snap": [{"views": 10000, "bonusCents": 5000}], "view_bonus_mode_snap": "ADD",
                "cpm_rate_snap": "2.2500", "cpm_view_unit_snap": 1000, "cpm_cap_views_snap": 500000,
                "cpm_min_views_snap": 100, "cpm_tiers_snap": [{"views": 100000, "ratePerUnit": 3.5}],
                "cpm_mode_snap": "REPLACE", "cpm_tier_mode_snap": "COMBINED_BRACKETED",
                "source": "ripple", "source_id": "pgtap-0011-p1"},
        "snapshots": [
          {"ripple_ids": ["pgtap-0011-s1", "pgtap-0011-s2"], "row": {"captured_day": "2026-10-02",
           "captured_at": "2026-10-02T20:00:00.000Z", "views": 400, "likes": 2, "comments": 0, "held": false}},
          {"ripple_ids": ["pgtap-0011-s3"], "row": {"captured_day": "2026-10-03",
           "captured_at": "2026-10-03T08:00:00.000Z", "views": 900, "likes": 3, "comments": 1, "held": false}}
        ]},
       {"ripple_ids": ["pgtap-0011-p2"], "account": "pgtap-0011-dA|TIKTOK|me",
        "row": {"platform": "TIKTOK", "url": "https://tiktok.com/@me/video/pgtap-0011-2", "title": null,
                "posted_at": "2026-10-04T10:00:00.000Z", "exclude_from_pay": false,
                "source": "ripple", "source_id": "pgtap-0011-p2"},
        "snapshots": [{"ripple_ids": ["pgtap-0011-s4"], "row": {"captured_day": "2026-10-04",
           "captured_at": "2026-10-04T12:00:00.000Z", "views": 50, "held": false}}]}
     ]},
    {"ripple_ids": ["pgtap-0011-dB"],
     "row": {"brand_name": "Deal B", "status": "ended", "start_date": "2026-09-01", "end_date": "2026-10-20",
             "base_pay_cents": 2000, "source": "ripple", "source_id": "pgtap-0011-dB"},
     "accounts": [],
     "posts": [
       {"ripple_ids": ["pgtap-0011-p3"], "account": null,
        "row": {"platform": "YOUTUBE", "url": "https://youtube.com/shorts/pgtap-0011-3",
                "posted_at": "2026-09-05T10:00:00.000Z", "source": "ripple", "source_id": "pgtap-0011-p3"},
        "snapshots": [{"ripple_ids": ["pgtap-0011-s5"], "row": {"captured_day": "2026-09-05",
           "captured_at": "2026-09-05T12:00:00.000Z", "views": 7, "held": false}}]}
     ]}
  ]
}$json$);

insert into imp select 'run1', private.ripple_import_apply((select j from imp where k = 'payload'));
select is(
  (select j from imp where k = 'run1'),
  '{"counts": {"deal_template": {"inserted": 1, "skipped_existing": 0, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0},
    "deal": {"inserted": 2, "skipped_existing": 0, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0},
    "deal_account": {"inserted": 1, "skipped_existing": 0, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0},
    "post": {"inserted": 3, "skipped_existing": 0, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0},
    "post_view_snapshot": {"inserted": 4, "skipped_existing": 0, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0}}, "url_collision_flagged": []}'::jsonb,
  'the first run inserts every item and counts it'
);
select results_eq(
  $$ select d.brand_name, d.base_pay_cents, d.base_min_views, d.cpm_rate::text, d.retainer_cents, d.daily_target_posts,
            d.view_bonus_mode, e.slug
     from public.deals d join public.entities e on e.id = d.entity_id
     where d.source = 'ripple' and d.source_id = 'pgtap-0011-dA' $$,
  $$ values ('Deal A'::text, 3500::bigint, 1000, '2.2500'::text, 10000::bigint, 3, 'REPLACE'::text, 'ugc'::text) $$,
  'an imported deal carries its pay structure (defaults fill what Ripple left out) and is UGC'
);
select results_eq(
  $$ select p.exclude_from_pay, p.manual_override_cents, p.base_pay_cents_snap, p.base_min_views_snap,
            p.view_bonuses_snap, p.view_bonus_mode_snap, p.cpm_rate_snap::text, p.cpm_view_unit_snap,
            p.cpm_cap_views_snap, p.cpm_min_views_snap, p.cpm_tiers_snap, p.cpm_mode_snap, p.cpm_tier_mode_snap,
            p.video_group_id, a.handle, d.source_id
     from public.posts p join public.deals d on d.id = p.deal_id left join public.deal_accounts a on a.id = p.account_id
     where p.source = 'ripple' and p.source_id = 'pgtap-0011-p1' $$,
  $$ values (true, 1250::bigint, 3500::bigint, 1000, '[{"views":10000,"bonusCents":5000}]'::jsonb, 'ADD'::text,
             '2.2500'::text, 1000, 500000, 100, '[{"views":100000,"ratePerUnit":3.5}]'::jsonb, 'REPLACE'::text,
             'COMBINED_BRACKETED'::text, 'uv1'::text, 'me'::text, 'pgtap-0011-dA'::text) $$,
  'an imported post keeps every Ripple rate snapshot, its exclude flag and override, its deal and account'
);
select results_eq(
  $$ select p.base_pay_cents_snap, p.cpm_rate_snap, p.exclude_from_pay, p.manual_override_cents
     from public.posts p where p.source = 'ripple' and p.source_id = 'pgtap-0011-p2' $$,
  $$ values (null::bigint, null::numeric, false, null::bigint) $$,
  'a Ripple post without a snapshot keeps none (the pay math falls back to the deal)'
);
select results_eq(
  $$ select s.captured_day::text, s.views, s.source from public.post_view_snapshots s
     join public.posts p on p.id = s.post_id where p.source_id = 'pgtap-0011-p1' order by 1 $$,
  $$ values ('2026-10-02'::text, 400::bigint, 'ripple'::text), ('2026-10-03', 900::bigint, 'ripple') $$,
  'view snapshots land on their post and day'
);
select is(
  (select count(*)::int from public.import_ripple_map where ripple_id like 'pgtap-0011-%'),
  13, 'every Ripple id is in the map (two accounts fold into one, two readings into one day)'
);

-- A rerun inserts nothing.
insert into imp select 'run2', private.ripple_import_apply((select j from imp where k = 'payload'));
select is(
  (select j from imp where k = 'run2'),
  '{"counts": {"deal_template": {"inserted": 0, "skipped_existing": 1, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0},
    "deal": {"inserted": 0, "skipped_existing": 2, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0},
    "deal_account": {"inserted": 0, "skipped_existing": 1, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0},
    "post": {"inserted": 0, "skipped_existing": 3, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0},
    "post_view_snapshot": {"inserted": 0, "skipped_existing": 4, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0}}, "url_collision_flagged": []}'::jsonb,
  'a rerun inserts nothing'
);

-- The owner edits deal A and the template, deletes deal B (its post goes with it) and post p2.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
update public.deals set base_pay_cents = 9999, brand_name = 'Deal A (mine)' where source = 'ripple' and source_id = 'pgtap-0011-dA';
update public.deal_templates set base_pay_cents = 1 where source = 'ripple' and source_id = 'pgtap-0011-m1';
update public.posts set exclude_from_pay = false where source = 'ripple' and source_id = 'pgtap-0011-p1';
delete from public.deals where source = 'ripple' and source_id = 'pgtap-0011-dB';
delete from public.posts where source = 'ripple' and source_id = 'pgtap-0011-p2';
reset role;

insert into imp select 'run3', private.ripple_import_apply((select j from imp where k = 'payload'));
select is(
  (select j from imp where k = 'run3'),
  '{"counts": {"deal_template": {"inserted": 0, "skipped_existing": 1, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0},
    "deal": {"inserted": 0, "skipped_existing": 1, "skipped_deleted": 1, "skipped_conflict": 0, "skipped_url_collision": 0},
    "deal_account": {"inserted": 0, "skipped_existing": 1, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0},
    "post": {"inserted": 0, "skipped_existing": 1, "skipped_deleted": 2, "skipped_conflict": 0, "skipped_url_collision": 0},
    "post_view_snapshot": {"inserted": 0, "skipped_existing": 2, "skipped_deleted": 2, "skipped_conflict": 0, "skipped_url_collision": 0}}, "url_collision_flagged": []}'::jsonb,
  'after owner deletions a rerun reports them as skipped_deleted and inserts nothing'
);
select is(
  (select count(*)::int from public.deals where source = 'ripple' and source_id = 'pgtap-0011-dB'),
  0, 'an owner-deleted deal stays deleted'
);
select is(
  (select count(*)::int from public.posts where source = 'ripple' and source_id in ('pgtap-0011-p2', 'pgtap-0011-p3')),
  0, 'owner-deleted posts (directly and with their deal) stay deleted'
);
select results_eq(
  $$ select d.brand_name, d.base_pay_cents, t.base_pay_cents, p.exclude_from_pay
     from public.deals d, public.deal_templates t, public.posts p
     where d.source_id = 'pgtap-0011-dA' and t.source_id = 'pgtap-0011-m1' and p.source_id = 'pgtap-0011-p1' $$,
  $$ values ('Deal A (mine)'::text, 9999::bigint, 1::bigint, false) $$,
  'the owner''s edits to a deal, a template and a post survive a rerun'
);

-- New Ripple items still come in; a post URL Hydra already tracks is skipped, not overwritten.
insert into public.posts (deal_id, platform, url, posted_at, source)
select id, 'TIKTOK', 'https://tiktok.com/@me/video/pgtap-0011-own', '2026-10-05T00:00:00Z', 'hydra'
from public.deals where source_id = 'pgtap-0011-dA';
update imp set j = jsonb_set(j, '{deals,0,posts}', (j #> '{deals,0,posts}') || $json$[
  {"ripple_ids": ["pgtap-0011-p4"], "account": "pgtap-0011-dA|TIKTOK|me",
   "row": {"platform": "TIKTOK", "url": "https://tiktok.com/@me/video/pgtap-0011-4", "posted_at": "2026-10-06T10:00:00.000Z",
           "exclude_from_pay": true, "source": "ripple", "source_id": "pgtap-0011-p4"},
   "snapshots": [{"ripple_ids": ["pgtap-0011-s6"], "row": {"captured_day": "2026-10-06",
      "captured_at": "2026-10-06T12:00:00.000Z", "views": 10, "held": false}}]},
  {"ripple_ids": ["pgtap-0011-p5"], "account": "pgtap-0011-dA|TIKTOK|me",
   "row": {"platform": "TIKTOK", "url": "https://tiktok.com/@me/video/pgtap-0011-own", "posted_at": "2026-10-05T00:00:00.000Z",
           "exclude_from_pay": true, "source": "ripple", "source_id": "pgtap-0011-p5"},
   "snapshots": [{"ripple_ids": ["pgtap-0011-s7"], "row": {"captured_day": "2026-10-05",
      "captured_at": "2026-10-05T12:00:00.000Z", "views": 10, "held": false}}]}
]$json$::jsonb)
where k = 'payload';
insert into imp select 'run4', private.ripple_import_apply((select j from imp where k = 'payload'));
select is(
  (select j from imp where k = 'run4') #> '{counts,post}',
  '{"inserted": 1, "skipped_existing": 1, "skipped_deleted": 2, "skipped_conflict": 0, "skipped_url_collision": 1}'::jsonb,
  'a new Ripple post is inserted on a rerun; one whose URL Hydra already tracks is a URL collision'
);
select is(
  (select j from imp where k = 'run4') -> 'url_collision_flagged',
  '["pgtap-0011-p5"]'::jsonb,
  'a colliding post that carried an exclude flag is named for the importer to warn about'
);
select results_eq(
  $$ select url, source, exclude_from_pay from public.posts
     where url in ('https://tiktok.com/@me/video/pgtap-0011-4', 'https://tiktok.com/@me/video/pgtap-0011-own') order by url $$,
  $$ values ('https://tiktok.com/@me/video/pgtap-0011-4'::text, 'ripple'::text, true),
            ('https://tiktok.com/@me/video/pgtap-0011-own', 'hydra', false) $$,
  'the new post imports with its flag; the owner''s post at the same URL is untouched'
);
-- A lost map row: the deal is there but no longer in the map.
delete from public.import_ripple_map where entity = 'deal' and ripple_id = 'pgtap-0011-dA';
insert into imp select 'run5', private.ripple_import_apply((select j from imp where k = 'payload'));
select is(
  (select j from imp where k = 'run5') #> '{counts,deal}',
  '{"inserted": 0, "skipped_existing": 0, "skipped_deleted": 1, "skipped_conflict": 1, "skipped_url_collision": 0}'::jsonb,
  'a source=ripple deal with no map row is never adopted (skipped_conflict), nor duplicated'
);
select results_eq(
  $$ select (select count(*)::int from public.import_ripple_map where entity = 'deal' and ripple_id = 'pgtap-0011-dA'),
            (select count(*)::int from public.deals where source_id = 'pgtap-0011-dA'),
            (select count(*)::int from public.posts p join public.deals d on d.id = p.deal_id where d.source_id = 'pgtap-0011-dA') $$,
  $$ values (0, 1, 3) $$,
  'it gets no map row and none of its children are added under it'
);
select is(
  (select j from imp where k = 'run5') #> '{counts,post}',
  '{"inserted": 0, "skipped_existing": 0, "skipped_deleted": 1, "skipped_conflict": 4, "skipped_url_collision": 0}'::jsonb,
  'its posts are skipped with the deal''s reason'
);

-- A planted row: a source=ripple deal the database owner wrote by hand with no map row.
insert into public.deals (brand_name, start_date, source, source_id) values ('Hand-made', '2026-10-01', 'ripple', 'pgtap-0011-dC');
select is(
  (private.ripple_import_apply($json${"deals": [{"ripple_ids": ["pgtap-0011-dC"], "row": {"brand_name": "Deal C",
    "start_date": "2026-10-01", "source_id": "pgtap-0011-dC"}, "accounts": [], "posts": []}]}$json$)) #> '{counts,deal,skipped_conflict}',
  '1'::jsonb, 'the import does not adopt a source=ripple row it did not write'
);
select is(
  (private.ripple_import_apply($json${"deals": [
    {"ripple_ids": ["pgtap-0011-dD"], "row": {"brand_name": "Deal D", "start_date": "2026-10-01", "source_id": "pgtap-0011-dD"}},
    {"ripple_ids": ["pgtap-0011-dD2"], "row": {"brand_name": "Deal D again", "start_date": "2026-10-01", "source_id": "pgtap-0011-dD"}}
  ]}$json$)) #> '{counts,deal}',
  '{"inserted": 1, "skipped_existing": 1, "skipped_deleted": 0, "skipped_conflict": 0, "skipped_url_collision": 0}'::jsonb,
  'a row the same call wrote is the one it may reuse'
);

-- Tombstones are deterministic: if any Ripple id of an item maps to a deleted row, it is deleted.
insert into public.import_ripple_map (entity, ripple_id, hydra_id) values ('deal_template', 'pgtap-0011-a-ghost', gen_random_uuid());
select results_eq(
  $$ select (private.ripple_import_apply('{"templates": [{"ripple_ids": ["pgtap-0011-m1", "pgtap-0011-a-ghost"],
              "row": {"brand_name": "x", "source_id": "pgtap-0011-m1"}}]}') #>> '{counts,deal_template,skipped_deleted}')::int
     from generate_series(1, 3) $$,
  $$ values (1), (1), (1) $$,
  'an item with one deleted and one present mapping is skipped_deleted, every run'
);
select throws_ok(
  $$ select private.ripple_import_apply('{"templates": [{"ripple_ids": [], "row": {"brand_name": "x", "source_id": "pgtap-0011-m9"}}]}') $$,
  'P0001', 'Ripple import: a deal_template item has no Ripple id',
  'an item with no Ripple id fails the call'
);
select throws_ok(
  $$ select private.ripple_import_apply('{"deals": [{"ripple_ids": ["pgtap-0011-d9"], "row": {"brand_name": "x", "start_date": "2026-10-01", "source_id": null}}]}') $$,
  'P0001', null,
  'a deal with no source_id fails the call'
);
select throws_ok(
  $$ select private.ripple_import_apply('{"templates": [{"ripple_ids": ["pgtap-0011-bad"], "row": {"brand_name": "x", "source_id": "pgtap-0011-bad", "nope": 1}}]}') $$,
  'P0001', 'Ripple import: public.deal_templates has no column nope',
  'an unknown column fails the call instead of being dropped'
);

-- hydra_ro reads (it cannot see pgTAP, so it writes to a temp table).
grant hydra_ro to postgres with set true;
create temp table ro_out (k text primary key, v text) on commit drop;
grant all on ro_out to hydra_ro;
set local role hydra_ro;
insert into ro_out select 'templates', count(*)::text from public.deal_templates where source_id = 'cm-master-1';
insert into ro_out select 'map', count(*)::text from public.import_ripple_map where ripple_id = 'cm-master-1';
reset role;
select results_eq(
  $$ select k, v from ro_out order by k $$,
  $$ values ('map'::text, '2'::text), ('templates', '1') $$,
  'hydra_ro reads templates and the import map'
);

select * from finish();
rollback;
