-- Hydra 0140: Personal Brand (owner, 2026-11-22: "also add a page for Personal Brand that tracks my
-- personal instagram account and analytics on that and posts"). Safe to re-run.
--
-- deals.personal_brand            a deal whose posts are the owner's own account, not UGC work. Its
--                                 posts show on /brand and nowhere in the UGC tracker (daily cards,
--                                 analytics, money). The view sync still reads them.
-- personal_brand_followers        the follower count per owner-zone day: typed by the owner
--                                 (source 'manual') until a daily sync writes it (source 'sync').

alter table public.deals add column if not exists personal_brand boolean not null default false;

-- The imported unpaid "Personal Brand" deal (153 Instagram posts) moves off the UGC tracker.
update public.deals set personal_brand = true
where lower(btrim(brand_name)) = 'personal brand' and not personal_brand;

create table if not exists public.personal_brand_followers (
  day date primary key,
  followers bigint not null check (followers between 0 and 10000000000),
  source text not null default 'manual' check (source in ('manual', 'sync')),
  updated_at timestamptz not null default now()
);

drop trigger if exists personal_brand_followers_touch_updated_at on public.personal_brand_followers;
create trigger personal_brand_followers_touch_updated_at
  before update on public.personal_brand_followers
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS and grants. Owner only; hydra_ro (the assistant) reads; service_role (a future daily sync)
-- reads and upserts. Anon gets nothing.
-- ---------------------------------------------------------------------------
alter table public.personal_brand_followers enable row level security;

revoke all on public.personal_brand_followers from public, anon, authenticated, service_role, hydra_ro;
grant select, insert, update, delete on public.personal_brand_followers to authenticated;
grant select, insert, update on public.personal_brand_followers to service_role;
grant select on public.personal_brand_followers to hydra_ro;

drop policy if exists personal_brand_followers_owner_all on public.personal_brand_followers;
create policy personal_brand_followers_owner_all on public.personal_brand_followers
  for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
drop policy if exists personal_brand_followers_ro_select on public.personal_brand_followers;
create policy personal_brand_followers_ro_select on public.personal_brand_followers
  for select to hydra_ro using (true);

-- ---------------------------------------------------------------------------
-- Activity and undo (0130): the new table is logged. Skipped where 0130 has not run.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('private.activity_tables') is not null then
    insert into private.activity_tables (tbl, logged, reason)
    values ('personal_brand_followers', true, null)
    on conflict (tbl) do update set logged = excluded.logged, reason = excluded.reason;
    drop trigger if exists "0_activity_capture" on public.personal_brand_followers;
    create trigger "0_activity_capture" after insert or update or delete on public.personal_brand_followers
      for each row execute function private.activity_capture('day');
  end if;
end;
$$;
