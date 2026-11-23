-- Hydra 0060: dashboard layouts (U17). One desktop layout and one phone layout for the owner.
-- DESIGN.md section 6 item 1. Plain SQL, safe to re-run.
--
-- items is a jsonb array of {id, x, y, w, h, hidden?}. The app validates and normalizes it on
-- read; the database only checks the shape and a size cap. updated_at is the compare-and-set
-- token: a save names the updated_at it last saw, and the update matches only if it is unchanged.

create table if not exists public.dashboard_layouts (
  user_id uuid not null references private.app_owner (user_id) on delete cascade,
  breakpoint text not null check (breakpoint in ('desktop', 'phone')),
  items jsonb not null default '[]'::jsonb
    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 64),
  updated_at timestamptz not null default now(),
  primary key (user_id, breakpoint)
);

drop trigger if exists dashboard_layouts_touch_updated_at on public.dashboard_layouts;
create trigger dashboard_layouts_touch_updated_at
  before update on public.dashboard_layouts
  for each row execute function private.touch_updated_at();

alter table public.dashboard_layouts enable row level security;

-- Grants are explicit (default privileges are revoked in 0001).
revoke all on public.dashboard_layouts from public, anon, authenticated;
grant select, insert, update, delete on public.dashboard_layouts to authenticated;
grant all on public.dashboard_layouts to service_role;

drop policy if exists dashboard_layouts_owner_select on public.dashboard_layouts;
create policy dashboard_layouts_owner_select on public.dashboard_layouts
  for select to authenticated
  using ((select public.is_owner()) and user_id = (select auth.uid()));
drop policy if exists dashboard_layouts_owner_insert on public.dashboard_layouts;
create policy dashboard_layouts_owner_insert on public.dashboard_layouts
  for insert to authenticated
  with check ((select public.is_owner()) and user_id = (select auth.uid()));
drop policy if exists dashboard_layouts_owner_update on public.dashboard_layouts;
create policy dashboard_layouts_owner_update on public.dashboard_layouts
  for update to authenticated
  using ((select public.is_owner()) and user_id = (select auth.uid()))
  with check ((select public.is_owner()) and user_id = (select auth.uid()));
drop policy if exists dashboard_layouts_owner_delete on public.dashboard_layouts;
create policy dashboard_layouts_owner_delete on public.dashboard_layouts
  for delete to authenticated
  using ((select public.is_owner()) and user_id = (select auth.uid()));
