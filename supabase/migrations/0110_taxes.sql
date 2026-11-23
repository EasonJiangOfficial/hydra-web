-- Hydra 0110: taxes (U12). DESIGN.md section 6 item 6. Plain SQL, safe to re-run.
--
-- tax_settings:            the set-aside rate the owner types, one per entity and year.
-- tax_estimated_payments:  estimated payments the owner made (one per quarter), amount and paid date.
-- tax_documents:           metadata for W-9s, 1099s and uploads; the files live in the private
--                          storage bucket tax-docs (owner only).
-- Hydra does not file and gives no tax advice: these rows only hold what the owner types.

create table if not exists public.tax_settings (
  entity_id uuid not null references public.entities (id),
  year int not null check (year between 2000 and 2100),
  set_aside_bps int not null check (set_aside_bps between 0 and 10000), -- 2500 = 25%
  updated_at timestamptz not null default now(),
  primary key (entity_id, year)
);

create table if not exists public.tax_estimated_payments (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id),
  year int not null check (year between 2000 and 2100),
  quarter int not null check (quarter between 1 and 4), -- Q4 is due in January of year + 1
  amount_cents bigint not null check (amount_cents > 0),
  paid_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, year, quarter)
);

create table if not exists public.tax_documents (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id),
  year int not null check (year between 2000 and 2100),
  kind text not null check (kind in ('w9', '1099', 'other')),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  payer text check (payer is null or char_length(btrim(payer)) between 1 and 200),
  storage_path text not null unique check (char_length(storage_path) between 1 and 500),
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  created_at timestamptz not null default now()
);
create index if not exists tax_documents_entity_year on public.tax_documents (entity_id, year, created_at desc);

drop trigger if exists tax_settings_touch_updated_at on public.tax_settings;
create trigger tax_settings_touch_updated_at
  before update on public.tax_settings
  for each row execute function private.touch_updated_at();
drop trigger if exists tax_estimated_payments_touch_updated_at on public.tax_estimated_payments;
create trigger tax_estimated_payments_touch_updated_at
  before update on public.tax_estimated_payments
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS and grants. Owner only; hydra_ro (the assistant) reads. Anon gets nothing.
-- ---------------------------------------------------------------------------
alter table public.tax_settings enable row level security;
alter table public.tax_estimated_payments enable row level security;
alter table public.tax_documents enable row level security;

revoke all on public.tax_settings, public.tax_estimated_payments, public.tax_documents
  from public, anon, authenticated, hydra_ro;
grant select, insert, update, delete on public.tax_settings, public.tax_estimated_payments, public.tax_documents to authenticated;
grant select on public.tax_settings, public.tax_estimated_payments, public.tax_documents to hydra_ro;
grant all on public.tax_settings, public.tax_estimated_payments, public.tax_documents to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['tax_settings', 'tax_estimated_payments', 'tax_documents'] loop
    execute format('drop policy if exists %1$s_owner_select on public.%1$s', t);
    execute format(
      'create policy %1$s_owner_select on public.%1$s for select to authenticated using ((select public.is_owner()))', t);
    execute format('drop policy if exists %1$s_owner_insert on public.%1$s', t);
    execute format(
      'create policy %1$s_owner_insert on public.%1$s for insert to authenticated with check ((select public.is_owner()))', t);
    execute format('drop policy if exists %1$s_owner_update on public.%1$s', t);
    execute format(
      'create policy %1$s_owner_update on public.%1$s for update to authenticated '
      'using ((select public.is_owner())) with check ((select public.is_owner()))', t);
    execute format('drop policy if exists %1$s_owner_delete on public.%1$s', t);
    execute format(
      'create policy %1$s_owner_delete on public.%1$s for delete to authenticated using ((select public.is_owner()))', t);
    execute format('drop policy if exists %1$s_ro_select on public.%1$s', t);
    execute format('create policy %1$s_ro_select on public.%1$s for select to hydra_ro using (true)', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- tax-docs: private bucket, owner only. Object path: <entity slug>/<year>/<uuid>-<file name>
-- (tax_documents.storage_path). PDFs and images, 25 MB.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tax-docs', 'tax-docs', false, 26214400, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists tax_docs_owner_select on storage.objects;
create policy tax_docs_owner_select on storage.objects
  for select to authenticated
  using (bucket_id = 'tax-docs' and (select public.is_owner()));
drop policy if exists tax_docs_owner_insert on storage.objects;
create policy tax_docs_owner_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'tax-docs' and (select public.is_owner()));
drop policy if exists tax_docs_owner_update on storage.objects;
create policy tax_docs_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'tax-docs' and (select public.is_owner()))
  with check (bucket_id = 'tax-docs' and (select public.is_owner()));
drop policy if exists tax_docs_owner_delete on storage.objects;
create policy tax_docs_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'tax-docs' and (select public.is_owner()));
