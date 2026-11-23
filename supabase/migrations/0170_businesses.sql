-- Hydra 0170: businesses (owner, 2026-11-22: "I should be able to add busineses"). The owner adds,
-- renames, closes, reopens and deletes rows in public.entities. Close keeps history; delete only when
-- nothing uses the business. Personal can never be closed or deleted. Safe to re-run.
-- Activity capture (0130) already logs entities on insert, update and delete, so the undo bar works.

-- ---------------------------------------------------------------------------
-- Row rules. The existing rows (personal, ugc sole_prop, ugm llc closed) comply.
-- ---------------------------------------------------------------------------
alter table public.entities drop constraint if exists entities_tax_shape_check;
alter table public.entities add constraint entities_tax_shape_check
  check (tax_shape is null or tax_shape in ('sole_prop', 'llc', 's_corp', 'partnership', 'other'));

alter table public.entities drop constraint if exists entities_slug_format;
alter table public.entities add constraint entities_slug_format
  check (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$' and slug <> 'all');

alter table public.entities drop constraint if exists entities_name_length;
alter table public.entities add constraint entities_name_length
  check (char_length(btrim(name)) between 1 and 60);

alter table public.entities drop constraint if exists entities_personal_open;
alter table public.entities add constraint entities_personal_open
  check (kind <> 'personal' or status = 'active');

alter table public.entities drop constraint if exists entities_personal_no_tax;
alter table public.entities add constraint entities_personal_no_tax
  check (kind <> 'personal' or tax_shape is null);

-- ---------------------------------------------------------------------------
-- Slug and kind never change after insert; closing stamps closed_on (the owner's day, settings.time_zone,
-- America/Toronto until the first login writes it, as 0040 does), reopening clears it.
-- ---------------------------------------------------------------------------
create or replace function private.entities_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.slug is distinct from old.slug then
    raise exception 'entities: the slug cannot change' using errcode = 'check_violation';
  end if;
  if new.kind is distinct from old.kind then
    raise exception 'entities: the kind cannot change' using errcode = 'check_violation';
  end if;
  if new.status = 'closed' and old.status = 'active' and new.closed_on is null then
    new.closed_on := (now() at time zone coalesce((select s.time_zone from public.settings s limit 1), 'America/Toronto'))::date;
  elsif new.status = 'active' then
    new.closed_on := null;
  end if;
  return new;
end;
$$;
revoke execute on function private.entities_guard_update() from public;

drop trigger if exists entities_guard_update on public.entities;
create trigger entities_guard_update
  before update on public.entities
  for each row execute function private.entities_guard_update();

-- ---------------------------------------------------------------------------
-- Delete: never Personal; never a business anything points at. Every foreign key to entities is
-- checked (accounts, transactions, deals, categories, tax rows, any later table), plus rules whose
-- actions set this entity. The foreign keys stay as the backstop. The Schedule C category map
-- (category_tax_lines) is setup, not use: a new business gets UGC's map, and a delete removes it first
-- (logged, so an undo puts both back).
-- Security definer: the check must see every referencing row, whatever RLS the caller has.
-- ---------------------------------------------------------------------------
create or replace function private.entity_in_use(p_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
  v_hit boolean;
begin
  for r in
    select c.conrelid::regclass as rel, a.attname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.entities'::regclass and cardinality(c.conkey) = 1
      and c.conrelid <> 'public.category_tax_lines'::regclass
  loop
    execute format('select exists (select 1 from %s where %I = $1)', r.rel, r.attname) using p_id into v_hit;
    if v_hit then
      return true;
    end if;
  end loop;
  return exists (
    select 1 from public.rules x
    where x.actions @> jsonb_build_array(jsonb_build_object('type', 'set_entity', 'entityId', p_id::text)));
end;
$$;
revoke execute on function private.entity_in_use(uuid) from public;

create or replace function private.entities_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.kind = 'personal' then
    raise exception 'entities: Personal cannot be deleted' using errcode = 'check_violation';
  end if;
  if private.entity_in_use(old.id) then
    raise exception 'In use: close it instead' using errcode = 'foreign_key_violation', table = 'entities';
  end if;
  delete from public.category_tax_lines m where m.entity_id = old.id;
  return old;
end;
$$;
revoke execute on function private.entities_guard_delete() from public;

drop trigger if exists entities_guard_delete on public.entities;
create trigger entities_guard_delete
  before delete on public.entities
  for each row execute function private.entities_guard_delete();

-- The Settings page shows which businesses are in use (Delete is off for those).
create or replace function public.entities_in_use()
returns table (id uuid, in_use boolean, accounts int)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, private.entity_in_use(e.id),
         (select count(*)::int from public.accounts a where a.entity_id = e.id)
  from public.entities e
  where (select public.is_owner())
     or coalesce(nullif(current_setting('role', true), 'none'), session_user::text) in ('service_role', 'postgres', 'hydra_ro');
$$;
revoke execute on function public.entities_in_use() from public, anon;
grant execute on function public.entities_in_use() to authenticated, service_role, hydra_ro;

-- ---------------------------------------------------------------------------
-- Grants and policies: the owner may add and delete businesses (never another Personal).
-- ---------------------------------------------------------------------------
grant insert, delete on public.entities to authenticated;

drop policy if exists entities_owner_insert on public.entities;
create policy entities_owner_insert on public.entities
  for insert to authenticated
  with check ((select public.is_owner()) and kind = 'business');
drop policy if exists entities_owner_delete on public.entities;
create policy entities_owner_delete on public.entities
  for delete to authenticated using ((select public.is_owner()) and kind = 'business');
