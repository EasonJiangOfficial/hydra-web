-- Hydra 0118: Planning category colors (owner, 2026-11-21: "for the differnet statuses or categories
-- or tags there should be a color selector"). Categories are free text on tasks, goals and events,
-- so a color is keyed by the category text. A category with no row has no color. Owner-only RLS,
-- explicit grants and the hydra_ro read policy, as every Planning table (0040). Safe to re-run.

create table if not exists public.planning_category_colors (
  category   text primary key check (char_length(btrim(category)) between 1 and 60),
  color      text not null check (color ~* '^#[0-9a-f]{6}$'),
  updated_at timestamptz not null default now()
);

alter table public.planning_category_colors enable row level security;
drop policy if exists planning_category_colors_owner_select on public.planning_category_colors;
create policy planning_category_colors_owner_select on public.planning_category_colors
  for select to authenticated using ((select public.is_owner()));
drop policy if exists planning_category_colors_owner_insert on public.planning_category_colors;
create policy planning_category_colors_owner_insert on public.planning_category_colors
  for insert to authenticated with check ((select public.is_owner()));
drop policy if exists planning_category_colors_owner_update on public.planning_category_colors;
create policy planning_category_colors_owner_update on public.planning_category_colors
  for update to authenticated using ((select public.is_owner())) with check ((select public.is_owner()));
drop policy if exists planning_category_colors_owner_delete on public.planning_category_colors;
create policy planning_category_colors_owner_delete on public.planning_category_colors
  for delete to authenticated using ((select public.is_owner()));
drop policy if exists planning_category_colors_ro_select on public.planning_category_colors;
create policy planning_category_colors_ro_select on public.planning_category_colors
  for select to hydra_ro using (true);

revoke all on public.planning_category_colors from public, anon, authenticated;
grant select, insert, update, delete on public.planning_category_colors to authenticated;
grant all on public.planning_category_colors to service_role;
grant select on public.planning_category_colors to hydra_ro;
