-- Hydra 0030: money rules. Categories, Schedule C tax lines, the category to tax line map, ordered
-- rules, recurring series, and the foreign keys 0020 left open on transactions.
-- DESIGN.md section 9; PLAN.md U3. Plain SQL, safe to re-run.
--
-- The rule matcher runs in TypeScript (src/lib/rules/match.ts); the database holds the rules and
-- does the writes in one statement each, so the guards below hold under concurrency:
-- - A rule run against a row the owner just edited: rules_apply_patches only updates rows whose
--   category_source is not 'manual', re-checked after the row lock (UPDATE re-evaluates its WHERE).
-- - Two pairings of the same row at once: ledger_pair_transfers locks every row of the list in id
--   order (so two runs never deadlock), then compares and sets (both must still be unpaired).
-- - A pairing and a deal match of the same row at once: both lock the transaction row first, so the
--   later one sees the other's write and refuses (deal_payments_refuse_transfer).
-- - Two rule reorders at once: rules_reorder locks every rule and refuses a stale list.
-- - transactions.tax_line_id overrides the line its category maps to for the row's entity.

-- ---------------------------------------------------------------------------
-- categories: two levels (a parent and its subcategories). entity_id null = shared by every entity.
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  parent_id uuid references public.categories (id) on delete restrict,
  kind text not null check (kind in ('income', 'expense', 'transfer')),
  entity_id uuid references public.entities (id),
  color text check (color ~ '^#[0-9a-fA-F]{6}$'),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists categories_name_key
  on public.categories (entity_id, parent_id, lower(name)) nulls not distinct;
create index if not exists categories_parent on public.categories (parent_id);

-- A subcategory sits under a top-level category of the same kind and entity.
create or replace function private.categories_check_parent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  p public.categories;
begin
  if tg_op = 'UPDATE'
     and (new.kind <> old.kind or new.entity_id is distinct from old.entity_id)
     and exists (select 1 from public.categories c where c.parent_id = new.id) then
    raise exception 'categories: parent differs' using errcode = '23514';
  end if;
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'categories: bad parent' using errcode = '23514';
  end if;
  if exists (select 1 from public.categories c where c.parent_id = new.id) then
    raise exception 'categories: two levels only' using errcode = '23514';
  end if;
  select * into p from public.categories c where c.id = new.parent_id;
  if p.parent_id is not null then
    raise exception 'categories: two levels only' using errcode = '23514';
  end if;
  if p.id is not null and (p.kind <> new.kind or p.entity_id is distinct from new.entity_id) then
    raise exception 'categories: parent differs' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists categories_check_parent on public.categories;
create trigger categories_check_parent before insert or update on public.categories
  for each row execute function private.categories_check_parent();
drop trigger if exists categories_touch_updated_at on public.categories;
create trigger categories_touch_updated_at before update on public.categories
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- tax_lines: IRS Schedule C (Form 1040), Part II expense lines. Seeded below; read-only to the app.
-- ---------------------------------------------------------------------------
create table if not exists public.tax_lines (
  id uuid primary key default gen_random_uuid(),
  schedule text not null default 'C',
  part text not null default 'II',
  code text not null,
  name text not null,
  position int not null,
  unique (schedule, code)
);

insert into public.tax_lines (code, name, position)
values
  ('8', 'Advertising', 8),
  ('9', 'Car and truck expenses', 9),
  ('10', 'Commissions and fees', 10),
  ('11', 'Contract labor', 11),
  ('12', 'Depletion', 12),
  ('13', 'Depreciation and section 179 expense deduction', 13),
  ('14', 'Employee benefit programs', 14),
  ('15', 'Insurance (other than health)', 15),
  ('16a', 'Interest: mortgage (paid to banks, etc.)', 16),
  ('16b', 'Interest: other', 17),
  ('17', 'Legal and professional services', 18),
  ('18', 'Office expense', 19),
  ('19', 'Pension and profit-sharing plans', 20),
  ('20a', 'Rent or lease: vehicles, machinery, and equipment', 21),
  ('20b', 'Rent or lease: other business property', 22),
  ('21', 'Repairs and maintenance', 23),
  ('22', 'Supplies (not included in Part III)', 24),
  ('23', 'Taxes and licenses', 25),
  ('24a', 'Travel', 26),
  ('24b', 'Deductible meals', 27),
  ('25', 'Utilities', 28),
  ('26', 'Wages (less employment credits)', 29),
  ('27a', 'Energy efficient commercial buildings deduction', 30),
  ('27b', 'Other expenses', 31),
  ('30', 'Business use of your home', 32)
on conflict (schedule, code) do update set name = excluded.name, position = excluded.position;

-- ---------------------------------------------------------------------------
-- category_tax_lines: one line per category per entity.
-- ---------------------------------------------------------------------------
create table if not exists public.category_tax_lines (
  category_id uuid not null references public.categories (id) on delete cascade,
  entity_id uuid not null references public.entities (id),
  tax_line_id uuid not null references public.tax_lines (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (category_id, entity_id)
);

-- ---------------------------------------------------------------------------
-- rules: ordered by position; the first enabled rule whose conditions all match wins.
-- conditions: [{field, op, value}]; actions: [{type, ...}]. Shapes: src/lib/rules/model.ts.
-- ---------------------------------------------------------------------------
create table if not exists public.rules (
  id uuid primary key default gen_random_uuid(),
  position int not null,
  conditions jsonb not null
    check (jsonb_typeof(conditions) = 'array' and jsonb_array_length(conditions) between 1 and 20),
  actions jsonb not null
    check (jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) between 1 and 6),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rules_position on public.rules (position, created_at);

drop trigger if exists rules_touch_updated_at on public.rules;
create trigger rules_touch_updated_at before update on public.rules
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- recurring: series found by src/lib/recurring/detect.ts (same name, steady amount, steady gap).
-- name_key is the normalized name. A dismissed series is never suggested again.
-- last_price_change: {"from_cents": int, "to_cents": int, "on": "YYYY-MM-DD"}.
-- ---------------------------------------------------------------------------
create table if not exists public.recurring (
  id uuid primary key default gen_random_uuid(),
  name_key text not null unique check (length(name_key) between 1 and 200),
  name text not null,
  average_amount_cents bigint not null,
  gap_days int not null check (gap_days > 0),
  last_seen_on date not null,
  next_expected_on date not null,
  status text not null default 'suggested' check (status in ('suggested', 'confirmed', 'dismissed')),
  last_price_change jsonb check (last_price_change is null or jsonb_typeof(last_price_change) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists recurring_touch_updated_at on public.recurring;
create trigger recurring_touch_updated_at before update on public.recurring
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The foreign keys 0020 left open on transactions.
-- ---------------------------------------------------------------------------
alter table public.transactions drop constraint if exists transactions_category_id_fkey;
alter table public.transactions add constraint transactions_category_id_fkey
  foreign key (category_id) references public.categories (id) on delete restrict;
alter table public.transactions drop constraint if exists transactions_tax_line_id_fkey;
alter table public.transactions add constraint transactions_tax_line_id_fkey
  foreign key (tax_line_id) references public.tax_lines (id) on delete restrict;
alter table public.transactions drop constraint if exists transactions_recurring_id_fkey;
alter table public.transactions add constraint transactions_recurring_id_fkey
  foreign key (recurring_id) references public.recurring (id) on delete set null;

create index if not exists transactions_category on public.transactions (category_id);
create index if not exists transactions_recurring on public.transactions (recurring_id);
create index if not exists transactions_needs_review on public.transactions (posted_on desc, id desc)
  where category_id is null and not is_transfer and not hidden;

-- ---------------------------------------------------------------------------
-- Default categories for one US creator: Personal, UGC (sole proprietor), shared transfers.
-- Seeded into an empty table only, so a re-run never brings back what the owner merged or deleted.
-- ---------------------------------------------------------------------------
do $$
declare
  personal uuid := (select id from public.entities where slug = 'personal');
  ugc uuid := (select id from public.entities where slug = 'ugc');
begin
  if exists (select 1 from public.categories) then
    return;
  end if;

  insert into public.categories (name, kind, entity_id)
  select v.name, v.kind, v.entity
  from (values
    ('Transfers', 'transfer', null::uuid),
    ('Card payments', 'transfer', null),
    ('Paycheck', 'income', personal),
    ('Interest', 'income', personal),
    ('Gifts received', 'income', personal),
    ('Other income', 'income', personal),
    ('Housing', 'expense', personal),
    ('Food', 'expense', personal),
    ('Transportation', 'expense', personal),
    ('Shopping', 'expense', personal),
    ('Subscriptions', 'expense', personal),
    ('Health', 'expense', personal),
    ('Personal care', 'expense', personal),
    ('Entertainment', 'expense', personal),
    ('Travel', 'expense', personal),
    ('Education', 'expense', personal),
    ('Gifts and donations', 'expense', personal),
    ('Fees and interest', 'expense', personal),
    ('Taxes', 'expense', personal),
    ('Other', 'expense', personal),
    ('Brand deals', 'income', ugc),
    ('Platform payouts', 'income', ugc),
    ('Affiliate income', 'income', ugc),
    ('Other business income', 'income', ugc),
    ('Advertising', 'expense', ugc),
    ('Platform and payment fees', 'expense', ugc),
    ('Contract editors', 'expense', ugc),
    ('Equipment', 'expense', ugc),
    ('Props and products', 'expense', ugc),
    ('Software and apps', 'expense', ugc),
    ('Phone and internet', 'expense', ugc),
    ('Business travel', 'expense', ugc),
    ('Business meals', 'expense', ugc),
    ('Courses', 'expense', ugc),
    ('Legal and accounting', 'expense', ugc),
    ('Insurance', 'expense', ugc),
    ('Taxes and licenses', 'expense', ugc),
    ('Home office', 'expense', ugc),
    ('Bank fees', 'expense', ugc),
    ('Other business expenses', 'expense', ugc)
  ) as v(name, kind, entity)
  on conflict do nothing;

  insert into public.categories (name, kind, entity_id, parent_id)
  select v.name, 'expense', personal, p.id
  from (values
    ('Rent', 'Housing'), ('Utilities', 'Housing'), ('Phone and internet', 'Housing'),
    ('Groceries', 'Food'), ('Dining out', 'Food'), ('Coffee', 'Food'),
    ('Gas', 'Transportation'), ('Rideshare and transit', 'Transportation'),
    ('Parking', 'Transportation'), ('Car', 'Transportation'),
    ('Clothing', 'Shopping'), ('Electronics', 'Shopping'), ('Household', 'Shopping')
  ) as v(name, parent)
  join public.categories p on p.entity_id = personal and p.parent_id is null and p.name = v.parent
  on conflict do nothing;

  insert into public.category_tax_lines (category_id, entity_id, tax_line_id)
  select c.id, ugc, t.id
  from (values
    ('Advertising', '8'),
    ('Platform and payment fees', '10'),
    ('Contract editors', '11'),
    ('Equipment', '22'),
    ('Props and products', '22'),
    ('Software and apps', '18'),
    ('Phone and internet', '25'),
    ('Business travel', '24a'),
    ('Business meals', '24b'),
    ('Courses', '27b'),
    ('Legal and accounting', '17'),
    ('Insurance', '15'),
    ('Taxes and licenses', '23'),
    ('Home office', '30'),
    ('Bank fees', '27b'),
    ('Other business expenses', '27b')
  ) as v(category, code)
  join public.categories c on c.entity_id = ugc and c.parent_id is null and c.name = v.category
  join public.tax_lines t on t.schedule = 'C' and t.code = v.code
  on conflict do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- rules_apply_patches: write what the matcher decided, in one statement.
-- p_patches: [{id, category_id?, entity_id?, name?, tax_line_id?, is_transfer?, recurring_id?}].
-- Never touches a row whose category_source is 'manual', nor the business of a row whose
-- entity_manual is set (the owner picked it). A rename never replaces an earlier rename.
-- Returns the number of rows written.
-- ---------------------------------------------------------------------------
create or replace function public.rules_apply_patches(p_patches jsonb)
returns int
language sql
set search_path = ''
as $$
  with p as (
    select (x->>'id')::uuid as id, x from jsonb_array_elements(coalesce(p_patches, '[]')) x
  ), u as (
    update public.transactions t set
      category_id = case when p.x ? 'category_id' then (p.x->>'category_id')::uuid else t.category_id end,
      category_source = case when p.x ? 'category_id' then 'rule' else t.category_source end,
      entity_id = case when t.entity_manual then t.entity_id else coalesce((p.x->>'entity_id')::uuid, t.entity_id) end,
      name = case when (p.x ? 'name') and not t.renamed then p.x->>'name' else t.name end,
      renamed = t.renamed or (p.x ? 'name'),
      tax_line_id = coalesce((p.x->>'tax_line_id')::uuid, t.tax_line_id),
      is_transfer = t.is_transfer or coalesce((p.x->>'is_transfer')::boolean, false),
      recurring_id = coalesce((p.x->>'recurring_id')::uuid, t.recurring_id)
    from p
    where t.id = p.id and t.category_source <> 'manual'
      and not (t.entity_manual and (p.x - 'id' - 'entity_id') = '{}'::jsonb)
    returning 1
  )
  select count(*)::int from u;
$$;

-- ---------------------------------------------------------------------------
-- ledger_pair_transfers: pair two of the owner's transactions as one transfer or card payment.
-- p_pairs: [{a, b}]. All rows are locked (id order), then each pair must still be unpaired, on different accounts,
-- with opposite signs, and neither may be a deposit matched to a deal payment (that is UGC income,
-- never a transfer). A pair that fails the check is skipped. Returns the number of pairs made.
-- ---------------------------------------------------------------------------
create or replace function public.ledger_pair_transfers(p_pairs jsonb)
returns int
language plpgsql
set search_path = ''
as $$
declare
  x jsonb;
  a public.transactions;
  b public.transactions;
  n int := 0;
begin
  -- Every row of the list, locked once in id order: two runs with crossing lists queue, never deadlock.
  perform 1 from public.transactions t
  where t.id in (
    select (e.value->>k)::uuid from jsonb_array_elements(coalesce(p_pairs, '[]')) e, unnest(array['a', 'b']) k
  )
  order by t.id for update;
  for x in select value from jsonb_array_elements(coalesce(p_pairs, '[]')) loop
    a := null;
    b := null;
    select * into a from public.transactions t where t.id = (x->>'a')::uuid;
    select * into b from public.transactions t where t.id = (x->>'b')::uuid;
    continue when a.id is null or b.id is null or a.id = b.id
      or a.transfer_pair_id is not null or b.transfer_pair_id is not null
      or a.account_id = b.account_id
      or a.amount_cents = 0 or sign(a.amount_cents) <> -sign(b.amount_cents)
      or exists (select 1 from public.deal_payments d where d.transaction_id in (a.id, b.id));
    update public.transactions t set is_transfer = true, transfer_pair_id = b.id where t.id = a.id;
    update public.transactions t set is_transfer = true, transfer_pair_id = a.id where t.id = b.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- deal_payments_refuse_transfer: a deposit paired as a transfer is never a deal payment. The row
-- lock serializes with ledger_pair_transfers (which locks, then checks deal_payments): whichever
-- commits first wins and the other refuses or skips.
-- ---------------------------------------------------------------------------
create or replace function private.deal_payments_refuse_transfer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Lock first, then read: the check sees a pairing that committed while this waited.
  perform 1 from public.transactions t where t.id = new.transaction_id for update;
  if exists (select 1 from public.transactions t where t.id = new.transaction_id and t.is_transfer) then
    raise exception 'This deposit is a transfer between your accounts' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists deal_payments_refuse_transfer on public.deal_payments;
create trigger deal_payments_refuse_transfer
  before insert or update of transaction_id on public.deal_payments
  for each row execute function private.deal_payments_refuse_transfer();

-- ---------------------------------------------------------------------------
-- transfer_rejections: the owner said "Not a transfer" to a suggested pair (Needs review), so it
-- is not suggested again. Stored once per pair, smaller id first. Goes with either row.
-- ---------------------------------------------------------------------------
create table if not exists public.transfer_rejections (
  a_id uuid not null references public.transactions (id) on delete cascade,
  b_id uuid not null references public.transactions (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (a_id, b_id),
  check (a_id < b_id)
);
create index if not exists transfer_rejections_b on public.transfer_rejections (b_id);

-- ---------------------------------------------------------------------------
-- ledger_unpair_transfer: undo a pair (or a rule's transfer mark). Unpairing is a manual edit:
-- both rows become category_source 'manual', so rules and auto pairing leave them alone.
-- Returns the number of rows changed (0, 1 or 2).
-- ---------------------------------------------------------------------------
create or replace function public.ledger_unpair_transfer(p_id uuid)
returns int
language sql
set search_path = ''
as $$
  with u as (
    update public.transactions t set is_transfer = false, transfer_pair_id = null, category_source = 'manual'
    where t.id = p_id
       or t.transfer_pair_id = p_id
       or t.id = (select x.transfer_pair_id from public.transactions x where x.id = p_id)
    returning 1
  )
  select count(*)::int from u;
$$;

-- ---------------------------------------------------------------------------
-- recurring_apply_detection: save what detection found, in one transaction.
-- p_series: [{name_key, name, average_amount_cents, gap_days, last_seen_on, next_expected_on,
--             last_price_change, transaction_ids}]. A dismissed series is left as is. Member rows
-- with no recurring_id yet are linked. Returns the number of series saved.
-- ---------------------------------------------------------------------------
create or replace function public.recurring_apply_detection(p_series jsonb)
returns int
language plpgsql
set search_path = ''
as $$
declare
  s jsonb;
  v_id uuid;
  n int := 0;
begin
  for s in select value from jsonb_array_elements(coalesce(p_series, '[]')) loop
    v_id := null;
    insert into public.recurring as r (
      name_key, name, average_amount_cents, gap_days, last_seen_on, next_expected_on, last_price_change
    ) values (
      s->>'name_key', s->>'name', (s->>'average_amount_cents')::bigint, (s->>'gap_days')::int,
      (s->>'last_seen_on')::date, (s->>'next_expected_on')::date, nullif(s->'last_price_change', 'null'::jsonb)
    )
    on conflict (name_key) do update set
      name = excluded.name,
      average_amount_cents = excluded.average_amount_cents,
      gap_days = excluded.gap_days,
      last_seen_on = excluded.last_seen_on,
      next_expected_on = excluded.next_expected_on,
      last_price_change = coalesce(excluded.last_price_change, r.last_price_change)
    where r.status <> 'dismissed'
    returning r.id into v_id;
    continue when v_id is null;
    n := n + 1;
    update public.transactions t set recurring_id = v_id
    where t.recurring_id is null
      and t.id in (select value::uuid from jsonb_array_elements_text(coalesce(s->'transaction_ids', '[]')));
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- rules_reorder: set every rule's position from a full, current list of ids.
-- ---------------------------------------------------------------------------
create or replace function public.rules_reorder(p_ids uuid[])
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.rules r for update;
  if (select count(*) from public.rules) <> coalesce(cardinality(p_ids), 0)
     or (select count(distinct x) from unnest(p_ids) x) <> coalesce(cardinality(p_ids), 0)
     or exists (select 1 from public.rules r where r.id <> all (p_ids)) then
    raise exception 'rules: changed';
  end if;
  update public.rules r set position = o.ord
  from unnest(p_ids) with ordinality as o(id, ord)
  where r.id = o.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- categories_merge: move everything from one category into another of the same kind, then
-- delete the first. Transactions, subcategories, tax line maps (the target's map wins) and rule
-- actions follow. Returns the number of transactions moved.
-- ---------------------------------------------------------------------------
create or replace function public.categories_merge(p_from uuid, p_into uuid)
returns int
language plpgsql
set search_path = ''
as $$
declare
  f public.categories;
  i public.categories;
  n int;
begin
  if p_from = p_into then
    raise exception 'categories: same category';
  end if;
  perform 1 from public.categories c where c.id in (p_from, p_into) order by c.id for update;
  select * into f from public.categories c where c.id = p_from;
  select * into i from public.categories c where c.id = p_into;
  if f.id is null or i.id is null then
    raise exception 'categories: unknown category';
  end if;
  if f.kind <> i.kind then
    raise exception 'categories: kinds differ';
  end if;

  update public.transactions t set category_id = p_into where t.category_id = p_from;
  get diagnostics n = row_count;
  update public.categories c set parent_id = p_into where c.parent_id = p_from;
  delete from public.category_tax_lines m
  where m.category_id = p_from
    and exists (select 1 from public.category_tax_lines k where k.category_id = p_into and k.entity_id = m.entity_id);
  update public.category_tax_lines m set category_id = p_into where m.category_id = p_from;
  update public.rules r set actions = (
    select jsonb_agg(
      case when e.a->>'type' = 'set_category' and e.a->>'categoryId' = p_from::text
           then jsonb_set(e.a, '{categoryId}', to_jsonb(p_into::text)) else e.a end
      order by e.ord)
    from jsonb_array_elements(r.actions) with ordinality as e(a, ord)
  )
  where r.actions @> jsonb_build_array(jsonb_build_object('type', 'set_category', 'categoryId', p_from::text));
  delete from public.categories c where c.id = p_from;
  return n;
end;
$$;

revoke execute on function public.rules_apply_patches(jsonb) from public, anon;
revoke execute on function public.ledger_pair_transfers(jsonb) from public, anon;
revoke execute on function public.ledger_unpair_transfer(uuid) from public, anon;
revoke execute on function public.recurring_apply_detection(jsonb) from public, anon;
revoke execute on function public.rules_reorder(uuid[]) from public, anon;
revoke execute on function public.categories_merge(uuid, uuid) from public, anon;
-- Security invoker: RLS keeps every write to the owner; the daily jobs run as service_role.
grant execute on function public.rules_apply_patches(jsonb) to authenticated, service_role;
grant execute on function public.ledger_pair_transfers(jsonb) to authenticated, service_role;
grant execute on function public.ledger_unpair_transfer(uuid) to authenticated, service_role;
grant execute on function public.recurring_apply_detection(jsonb) to authenticated, service_role;
grant execute on function public.rules_reorder(uuid[]) to authenticated, service_role;
grant execute on function public.categories_merge(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS and grants. Owner only; hydra_ro reads; tax_lines are read-only to the app.
-- ---------------------------------------------------------------------------
alter table public.categories enable row level security;
alter table public.tax_lines enable row level security;
alter table public.category_tax_lines enable row level security;
alter table public.rules enable row level security;
alter table public.recurring enable row level security;
alter table public.transfer_rejections enable row level security;

revoke all on public.categories, public.tax_lines, public.category_tax_lines, public.rules, public.recurring,
  public.transfer_rejections from public, anon, authenticated, hydra_ro;
grant select, insert, update, delete on public.categories, public.category_tax_lines, public.rules to authenticated;
grant select, insert, update on public.recurring to authenticated;
grant select, insert on public.transfer_rejections to authenticated;
grant select on public.tax_lines to authenticated;
grant select on public.categories, public.tax_lines, public.category_tax_lines, public.rules, public.recurring,
  public.transfer_rejections to hydra_ro;
grant all on public.categories, public.tax_lines, public.category_tax_lines, public.rules, public.recurring,
  public.transfer_rejections to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['categories', 'tax_lines', 'category_tax_lines', 'rules', 'recurring', 'transfer_rejections'] loop
    execute format('drop policy if exists %1$s_owner_select on public.%1$s', t);
    execute format(
      'create policy %1$s_owner_select on public.%1$s for select to authenticated using ((select public.is_owner()))', t);
    execute format('drop policy if exists %1$s_ro_select on public.%1$s', t);
    execute format('create policy %1$s_ro_select on public.%1$s for select to hydra_ro using (true)', t);
  end loop;
  drop policy if exists transfer_rejections_owner_insert on public.transfer_rejections;
  create policy transfer_rejections_owner_insert on public.transfer_rejections
    for insert to authenticated with check ((select public.is_owner()));
  foreach t in array array['categories', 'category_tax_lines', 'rules', 'recurring'] loop
    execute format('drop policy if exists %1$s_owner_insert on public.%1$s', t);
    execute format(
      'create policy %1$s_owner_insert on public.%1$s for insert to authenticated with check ((select public.is_owner()))', t);
    execute format('drop policy if exists %1$s_owner_update on public.%1$s', t);
    execute format(
      'create policy %1$s_owner_update on public.%1$s for update to authenticated '
      'using ((select public.is_owner())) with check ((select public.is_owner()))', t);
  end loop;
  foreach t in array array['categories', 'category_tax_lines', 'rules'] loop
    execute format('drop policy if exists %1$s_owner_delete on public.%1$s', t);
    execute format(
      'create policy %1$s_owner_delete on public.%1$s for delete to authenticated using ((select public.is_owner()))', t);
  end loop;
end;
$$;
