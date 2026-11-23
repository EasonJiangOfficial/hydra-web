-- Hydra 0011: the one-time Ripple import (U16, DESIGN.md section 8). Safe to re-run.
--   deal_templates     Ripple's master campaigns: the list of "already created" deals the owner
--                      can add (brand, logo, the whole pay structure). Same columns and checks as
--                      deals, minus the deal's own entity, status and dates.
--   import_ripple_map  Ripple id -> Hydra id per entity: what the import has written.
--   ripple_import_apply  the import's only write path; database owner role only.
--   deal-logos         private Storage bucket for deal and template logos (owner only).
-- Writer: scripts/import-ripple emits SQL that calls private.ripple_import_apply, run as the
-- database owner (supabase db query / psql). Logos go to Storage with the service key.

-- ---------------------------------------------------------------------------
-- deal_templates: built from deals so a template always fits a deal's checks.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.deal_templates') is null then
    create table public.deal_templates (like public.deals including defaults including constraints);
    alter table public.deal_templates
      drop column entity_id,
      drop column status,
      drop column start_date,
      drop column end_date,
      add column archived boolean not null default false,
      add constraint deal_templates_pkey primary key (id),
      add constraint deal_templates_source_key unique (source, source_id);
  end if;
end;
$$;

drop trigger if exists deal_templates_touch_updated_at on public.deal_templates;
create trigger deal_templates_touch_updated_at
  before update on public.deal_templates
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- import_ripple_map: one row per imported Ripple row. Several Ripple rows may land on one Hydra
-- row (two Ripple accounts with the same handle on one deal; readings folded into one day).
-- hydra_id has no foreign key on purpose: the map row outlives a row the owner deletes and is the
-- tombstone that keeps a rerun from bringing it back.
-- ---------------------------------------------------------------------------
create table if not exists public.import_ripple_map (
  entity text not null
    check (entity in ('deal_template', 'deal', 'deal_account', 'post', 'post_view_snapshot')),
  ripple_id text not null check (length(ripple_id) between 1 and 200),
  hydra_id uuid not null,
  imported_at timestamptz not null default now(),
  constraint import_ripple_map_pkey primary key (entity, ripple_id)
);
create index if not exists import_ripple_map_hydra_idx on public.import_ripple_map (hydra_id);

-- ---------------------------------------------------------------------------
-- RLS: owner only; hydra_ro reads. Grants are explicit (default privileges are revoked).
-- ---------------------------------------------------------------------------
alter table public.deal_templates enable row level security;
alter table public.import_ripple_map enable row level security;

-- service_role (the Grokbot key) gets nothing here: the import runs as the database owner.
revoke all on public.deal_templates, public.import_ripple_map from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.deal_templates, public.import_ripple_map to authenticated;
grant select on public.deal_templates, public.import_ripple_map to hydra_ro;

do $$
declare
  t text;
begin
  foreach t in array array['deal_templates', 'import_ripple_map']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using ((select public.is_owner())) with check ((select public.is_owner()))',
      t || '_owner_all', t
    );
    execute format('drop policy if exists %I on public.%I', t || '_ro_select', t);
    execute format('create policy %I on public.%I for select to hydra_ro using (true)', t || '_ro_select', t);
  end loop;
end;
$$;

-- Only the import (database owner role) writes source='ripple' templates (0010's source guard).
drop trigger if exists deal_templates_guard_ripple_source on public.deal_templates;
create trigger deal_templates_guard_ripple_source
  before insert or update of source on public.deal_templates
  for each row execute function private.guard_ripple_source();

-- ---------------------------------------------------------------------------
-- private.ripple_import_apply(payload): insert-only, one transaction per call.
--   payload = {templates: [item], deals: [item + {accounts: [item + {key}],
--              posts: [item + {account: <account key>, snapshots: [item]}]}]}
--   item    = {ripple_ids: [text, at least one], row: {column: value}}; templates, deals and posts
--             need row.source_id.
-- Per item, in this order:
--   skipped_deleted        a Ripple id of the item is in import_ripple_map and its Hydra row is
--                          gone: the owner deleted it, it stays deleted. Any deleted mapping wins.
--   skipped_existing       mapped and its row is there: never updated, the owner's edits stay.
--   inserted               new: inserted with its map rows.
--   skipped_url_collision  a post whose URL Hydra already tracks under another source. The Ripple
--                          ids of such posts that carried an exclude flag or manual override are
--                          returned in url_collision_flagged, for the importer to print.
--   skipped_conflict       its natural key is held by a row this call did not write (a
--                          source='ripple' row with no map row): never adopted.
-- Children of a skipped parent with no row are skipped with the parent's reason.
-- Returns {counts: {entity: {status: n}}, url_collision_flagged: [ripple id]}.
-- Runs as the caller: only the database owner role, whose source='ripple' inserts keep the rate
-- snapshot, exclude flag and manual override (0010). No API role can execute these functions.
-- ---------------------------------------------------------------------------
create or replace function private.ripple_import_count(c jsonb, entity text, status text, n integer default 1)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_set(c, array[entity, status], to_jsonb((c #>> array[entity, status])::integer + n));
$$;

create or replace function private.ripple_import_row(
  p_entity text, p_table text, p_ripple_ids text[], p_row jsonb,
  out status text, out hydra_id uuid
)
language plpgsql
set search_path = ''
as $$
declare
  mapped integer;
  missing integer;
  cols text;
  unknown text;
begin
  if coalesce(cardinality(p_ripple_ids), 0) = 0 or array_position(p_ripple_ids, null) is not null
     or exists (select 1 from unnest(p_ripple_ids) r where btrim(r) = '') then
    raise exception 'Ripple import: a % item has no Ripple id', p_entity;
  end if;
  if p_table in ('deal_templates', 'deals', 'posts') and nullif(btrim(p_row ->> 'source_id'), '') is null then
    raise exception 'Ripple import: a % item has no source_id (Ripple ids %)', p_entity, p_ripple_ids;
  end if;

  -- Mapped already: any mapping whose row is gone is a tombstone; else the first present row by
  -- Ripple id (deterministic).
  execute format(
    'select count(*)::integer, (count(*) filter (where t.id is null))::integer, '
    '(array_agg(m.hydra_id order by m.ripple_id) filter (where t.id is not null))[1] '
    'from public.import_ripple_map m left join public.%I t on t.id = m.hydra_id '
    'where m.entity = $1 and m.ripple_id = any ($2)',
    p_table
  ) into mapped, missing, hydra_id using p_entity, p_ripple_ids;
  if mapped > 0 then
    if missing > 0 then
      status := 'skipped_deleted';
      hydra_id := null;
      return;
    end if;
    status := 'skipped_existing';
  else
    select string_agg(k, ', ') into unknown
    from jsonb_object_keys(p_row) k
    where not exists (
      select 1 from pg_attribute a
      where a.attrelid = format('public.%I', p_table)::regclass and a.attname = k and a.attnum > 0 and not a.attisdropped
    );
    if unknown is not null then
      raise exception 'Ripple import: public.% has no column %', p_table, unknown;
    end if;
    select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(p_row) k;
    execute format(
      'insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I, $1) '
      'on conflict do nothing returning id',
      p_table, cols
    ) into hydra_id using p_row;
    if hydra_id is not null then
      status := 'inserted';
      insert into pg_temp.ripple_import_seen values (hydra_id);
    else
      -- The natural key is taken. Reuse only a row this call inserted (the same thing twice in one
      -- payload); a row the call did not write (no map row) is never adopted.
      if p_table in ('deal_templates', 'deals', 'posts') then
        execute format('select id from public.%I where source = ''ripple'' and source_id = $1', p_table)
          into hydra_id using p_row ->> 'source_id';
      elsif p_table = 'deal_accounts' then
        select a.id into hydra_id from public.deal_accounts a
        where a.deal_id = (p_row ->> 'deal_id')::uuid and a.platform = p_row ->> 'platform' and a.handle = p_row ->> 'handle';
      elsif p_table = 'post_view_snapshots' then
        select s.id into hydra_id from public.post_view_snapshots s
        where s.post_id = (p_row ->> 'post_id')::uuid and s.captured_day = (p_row ->> 'captured_day')::date;
      end if;
      if hydra_id is not null and not exists (select 1 from pg_temp.ripple_import_seen x where x.id = hydra_id) then
        hydra_id := null;
      end if;
      if hydra_id is not null then
        status := 'skipped_existing';
      elsif p_table = 'posts'
            and not exists (select 1 from public.posts x where x.source = 'ripple' and x.source_id = p_row ->> 'source_id')
            and exists (select 1 from public.posts x where x.url = p_row ->> 'url') then
        status := 'skipped_url_collision';
      else
        status := 'skipped_conflict';
      end if;
    end if;
  end if;
  if hydra_id is not null then
    insert into public.import_ripple_map (entity, ripple_id, hydra_id)
    select p_entity, r, hydra_id from unnest(p_ripple_ids) r
    on conflict do nothing;
  end if;
end;
$$;

create or replace function private.ripple_import_apply(payload jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  counts jsonb := '{}';
  flagged jsonb := '[]';
  e text;
  t jsonb;
  d jsonb;
  a jsonb;
  p jsonb;
  s jsonb;
  dr record;
  ar record;
  pr record;
  sr record;
  account_ids jsonb;
  ripple constant jsonb := '{"source": "ripple"}';
  ids text[];
begin
  if not pg_has_role(coalesce(nullif(current_setting('role'), 'none'), session_user), 'postgres', 'member') then
    raise exception 'the Ripple import runs only as the database owner role' using errcode = '42501';
  end if;
  -- The rows this call inserts (ripple_import_row reuses only these on a natural-key clash).
  create temp table if not exists ripple_import_seen (id uuid primary key) on commit drop;
  truncate pg_temp.ripple_import_seen;
  foreach e in array array['deal_template', 'deal', 'deal_account', 'post', 'post_view_snapshot'] loop
    counts := counts || jsonb_build_object(e, jsonb_build_object(
      'inserted', 0, 'skipped_existing', 0, 'skipped_deleted', 0, 'skipped_conflict', 0, 'skipped_url_collision', 0));
  end loop;

  for t in select * from jsonb_array_elements(coalesce(payload -> 'templates', '[]')) loop
    select * into dr from private.ripple_import_row(
      'deal_template', 'deal_templates', array(select jsonb_array_elements_text(t -> 'ripple_ids')), (t -> 'row') || ripple);
    counts := private.ripple_import_count(counts, 'deal_template', dr.status);
  end loop;

  for d in select * from jsonb_array_elements(coalesce(payload -> 'deals', '[]')) loop
    select * into dr from private.ripple_import_row(
      'deal', 'deals', array(select jsonb_array_elements_text(d -> 'ripple_ids')), (d -> 'row') || ripple);
    counts := private.ripple_import_count(counts, 'deal', dr.status);
    if dr.hydra_id is null then
      counts := private.ripple_import_count(counts, 'deal_account', dr.status, jsonb_array_length(coalesce(d -> 'accounts', '[]')));
      counts := private.ripple_import_count(counts, 'post', dr.status, jsonb_array_length(coalesce(d -> 'posts', '[]')));
      counts := private.ripple_import_count(counts, 'post_view_snapshot', dr.status, (
        select coalesce(sum(jsonb_array_length(coalesce(x -> 'snapshots', '[]'))), 0)::integer
        from jsonb_array_elements(coalesce(d -> 'posts', '[]')) x));
      continue;
    end if;

    account_ids := '{}';
    for a in select * from jsonb_array_elements(coalesce(d -> 'accounts', '[]')) loop
      select * into ar from private.ripple_import_row(
        'deal_account', 'deal_accounts', array(select jsonb_array_elements_text(a -> 'ripple_ids')),
        (a -> 'row') || jsonb_build_object('deal_id', dr.hydra_id));
      counts := private.ripple_import_count(counts, 'deal_account', ar.status);
      account_ids := account_ids || jsonb_build_object(a ->> 'key', ar.hydra_id);
    end loop;

    for p in select * from jsonb_array_elements(coalesce(d -> 'posts', '[]')) loop
      ids := array(select jsonb_array_elements_text(p -> 'ripple_ids'));
      select * into pr from private.ripple_import_row(
        'post', 'posts', ids,
        (p -> 'row') || ripple || jsonb_build_object('deal_id', dr.hydra_id, 'account_id', account_ids -> (p ->> 'account')));
      counts := private.ripple_import_count(counts, 'post', pr.status);
      if pr.status = 'skipped_url_collision'
         and (coalesce((p #>> '{row,exclude_from_pay}')::boolean, false) or coalesce(p #> '{row,manual_override_cents}', 'null') <> 'null'::jsonb) then
        flagged := flagged || to_jsonb(ids);
      end if;
      if pr.hydra_id is null then
        counts := private.ripple_import_count(counts, 'post_view_snapshot', pr.status, jsonb_array_length(coalesce(p -> 'snapshots', '[]')));
        continue;
      end if;
      for s in select * from jsonb_array_elements(coalesce(p -> 'snapshots', '[]')) loop
        select * into sr from private.ripple_import_row(
          'post_view_snapshot', 'post_view_snapshots', array(select jsonb_array_elements_text(s -> 'ripple_ids')),
          (s -> 'row') || ripple || jsonb_build_object('post_id', pr.hydra_id));
        counts := private.ripple_import_count(counts, 'post_view_snapshot', sr.status);
      end loop;
    end loop;
  end loop;
  return jsonb_build_object('counts', counts, 'url_collision_flagged', flagged);
end;
$$;

revoke all on function private.ripple_import_count(jsonb, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.ripple_import_row(text, text, text[], jsonb) from public, anon, authenticated, service_role;
revoke all on function private.ripple_import_apply(jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- deal-logos: private bucket. deals.logo_path and deal_templates.logo_path hold the object path
-- inside this bucket (imports: 'ripple/<Ripple storage path>'). Raster images only, 10 MB
-- (one Ripple logo is 6 MB).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('deal-logos', 'deal-logos', false, 10485760, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists deal_logos_owner_select on storage.objects;
create policy deal_logos_owner_select on storage.objects
  for select to authenticated
  using (bucket_id = 'deal-logos' and (select public.is_owner()));
drop policy if exists deal_logos_owner_insert on storage.objects;
create policy deal_logos_owner_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'deal-logos' and (select public.is_owner()));
drop policy if exists deal_logos_owner_update on storage.objects;
create policy deal_logos_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'deal-logos' and (select public.is_owner()))
  with check (bucket_id = 'deal-logos' and (select public.is_owner()));
drop policy if exists deal_logos_owner_delete on storage.objects;
create policy deal_logos_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'deal-logos' and (select public.is_owner()));
