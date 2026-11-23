-- Hydra 0020: bank layer. Bank items (encrypted provider tokens), accounts, daily balances, transactions.
-- DESIGN.md sections 5, 9 and 11; PLAN.md U2. Plain SQL, safe to re-run.
--
-- Money is integer cents.
-- transactions.amount_cents: positive = money into the account, negative = money out
--   (Plaid reports the opposite sign; the adapter flips it).
-- balances.current_cents for card and loan accounts: the amount owed, positive (as Plaid reports it).
--
-- Write paths (PLAN.md Wave 1 write-path checks):
-- - Two syncs at once: bank_apply_sync_page takes an advisory lock per bank item, then compares
--   and sets the cursor. The loser gets 'conflict' and writes nothing.
-- - Death between pages: one call = one transaction = one page of rows plus its cursor.
-- - Retry after partial success: transactions upsert on (account_id, provider_transaction_id).
-- - Pending to posted: the posted row takes over the pending row, so the owner's edits stay.

-- ---------------------------------------------------------------------------
-- bank_items: one row per bank login (a Plaid Item). The access token is AES-256-GCM
-- ciphertext (src/lib/bank/crypto.ts); the key lives only in the host's environment.
-- ---------------------------------------------------------------------------
create table if not exists public.bank_items (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'plaid' check (provider in ('plaid')),
  provider_item_id text not null,
  institution_id text,
  institution_name text,
  -- 'v1.<iv>.<tag>.<ciphertext>'; the check stops a plaintext token from ever landing here.
  access_token text not null check (access_token like 'v1.%'),
  cursor text, -- latest committed sync cursor; null = never synced
  sync_anchor_cursor text, -- cursor the open pagination loop started from; null = no open loop
  status text not null default 'active'
    check (status in ('active', 'login_required', 'pending_expiration', 'revoked', 'error')),
  last_synced_at timestamptz,
  last_error text, -- provider error code only, never a token or a body
  sync_requested_at timestamptz, -- set by the webhook; cleared by the sync that covers it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_item_id)
);

-- Ten Plaid Trial slots are a lifetime budget: one live link per institution. Repair with update mode.
create unique index if not exists bank_items_one_link_per_institution
  on public.bank_items (provider, institution_id)
  where institution_id is not null and status <> 'revoked';

-- ---------------------------------------------------------------------------
-- accounts: linked (bank_item_id set) or manual. Cards carry the last statement balance and due
-- date from the feed, plus owner overrides (Canadian Liabilities coverage is limited).
-- ---------------------------------------------------------------------------
create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  bank_item_id uuid references public.bank_items (id) on delete restrict,
  provider_account_id text,
  kind text not null check (kind in ('cash', 'card', 'loan', 'asset')),
  entity_id uuid not null references public.entities (id),
  name text not null,
  nickname text,
  mask text,
  institution text,
  in_net_worth boolean not null default true,
  is_manual boolean not null default false,
  statement_balance_cents bigint,
  statement_due_on date,
  statement_balance_override_cents bigint,
  statement_due_on_override date,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bank_item_id, provider_account_id),
  constraint accounts_manual_has_no_item check (is_manual = (bank_item_id is null)),
  constraint accounts_linked_has_provider_id check (bank_item_id is null or provider_account_id is not null)
);

-- ---------------------------------------------------------------------------
-- balances: one row per account per day (the owner's time zone). The last write of the day wins.
-- ---------------------------------------------------------------------------
create table if not exists public.balances (
  account_id uuid not null references public.accounts (id) on delete cascade,
  as_of date not null,
  current_cents bigint,
  available_cents bigint,
  limit_cents bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, as_of)
);

-- ---------------------------------------------------------------------------
-- transactions. category_id, tax_line_id and recurring_id get their foreign keys in 0030 (U3).
-- `renamed` keeps an owner's rename when the feed sends a newer name.
-- ---------------------------------------------------------------------------
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete restrict,
  provider_transaction_id text,
  pending boolean not null default false,
  pending_transaction_id text,
  posted_on date not null,
  authorized_on date,
  amount_cents bigint not null,
  name text not null,
  renamed boolean not null default false,
  merchant text,
  raw_description text,
  note text,
  entity_id uuid not null references public.entities (id),
  entity_manual boolean not null default false, -- the owner set the business by hand: rules leave it
  category_id uuid,
  category_source text not null default 'none'
    check (category_source in ('rule', 'manual', 'import', 'none')),
  tax_line_id uuid,
  is_transfer boolean not null default false,
  transfer_pair_id uuid references public.transactions (id) on delete set null,
  hidden boolean not null default false,
  recurring_id uuid,
  source text not null check (source in ('plaid', 'csv', 'ofx', 'manual')),
  import_hash text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, provider_transaction_id),
  constraint transactions_plaid_has_provider_id check (source <> 'plaid' or provider_transaction_id is not null)
);
alter table public.transactions add column if not exists entity_manual boolean not null default false;

-- A matched deal payment (0010) is tied to the real transaction: same id, amount and date. A
-- sync that changes the amount or date updates the payment; one that removes the transaction
-- (bank_apply_sync_page's removed list) deletes the payment with it, so none is left orphaned.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_id_amount_posted_key') then
    alter table public.transactions
      add constraint transactions_id_amount_posted_key unique (id, amount_cents, posted_on);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deal_payments_transaction_fkey') then
    alter table public.deal_payments
      add constraint deal_payments_transaction_fkey
      foreign key (transaction_id, amount_cents, paid_on)
      references public.transactions (id, amount_cents, posted_on)
      on update cascade on delete cascade;
  end if;
end;
$$;

-- A change that turns the deposit zero or negative (a reversal, a sign fix) unmatches the payment
-- first. A payment is always positive (0010's check), so the cascade would fail the whole sync
-- page and stick the cursor. BEFORE the update, so the cascade then finds no payment to move.
create or replace function private.bank_unmatch_reversed_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.deal_payments p where p.transaction_id = old.id;
  return new;
end;
$$;

drop trigger if exists transactions_unmatch_reversed_payment on public.transactions;
create trigger transactions_unmatch_reversed_payment before update on public.transactions
  for each row when (old.amount_cents > 0 and new.amount_cents <= 0)
  execute function private.bank_unmatch_reversed_payment();

create index if not exists transactions_account_posted on public.transactions (account_id, posted_on desc);
create index if not exists transactions_posted on public.transactions (posted_on desc, id desc);
create index if not exists transactions_entity_posted on public.transactions (entity_id, posted_on desc);

-- ---------------------------------------------------------------------------
-- Triggers: updated_at, and the entity default (accounts: Personal; transactions: the account's).
-- ---------------------------------------------------------------------------
create or replace function private.bank_fill_entity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.entity_id is null then
    if tg_table_name = 'accounts' then
      select e.id into new.entity_id from public.entities e where e.slug = 'personal';
    else
      select a.entity_id into new.entity_id from public.accounts a where a.id = new.account_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists accounts_fill_entity on public.accounts;
create trigger accounts_fill_entity before insert on public.accounts
  for each row execute function private.bank_fill_entity();
drop trigger if exists transactions_fill_entity on public.transactions;
create trigger transactions_fill_entity before insert on public.transactions
  for each row execute function private.bank_fill_entity();

drop trigger if exists bank_items_touch_updated_at on public.bank_items;
create trigger bank_items_touch_updated_at before update on public.bank_items
  for each row execute function private.touch_updated_at();
drop trigger if exists accounts_touch_updated_at on public.accounts;
create trigger accounts_touch_updated_at before update on public.accounts
  for each row execute function private.touch_updated_at();
drop trigger if exists balances_touch_updated_at on public.balances;
create trigger balances_touch_updated_at before update on public.balances
  for each row execute function private.touch_updated_at();
drop trigger if exists transactions_touch_updated_at on public.transactions;
create trigger transactions_touch_updated_at before update on public.transactions
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- bank_apply_sync_page: one page of a provider sync, in one transaction.
-- Returns 'applied', or 'conflict' when another sync moved the cursor first (nothing is written).
-- Rows are provider-neutral JSON (src/lib/bank/sync.ts builds them):
--   accounts: [{provider_account_id, name, mask, kind, current_cents, available_cents, limit_cents}]
--   added, modified: [{provider_account_id, provider_transaction_id, pending, pending_transaction_id,
--                      posted_on, authorized_on, amount_cents, name, merchant, raw_description}]
--   removed: [{provider_transaction_id}]
-- A rewind (Plaid: restart the whole pagination loop) is a call with no rows and
-- p_next_cursor = the anchor cursor.
-- ---------------------------------------------------------------------------
create or replace function public.bank_apply_sync_page(
  p_item_id uuid,
  p_expected_cursor text,
  p_next_cursor text,
  p_has_more boolean,
  p_as_of date,
  p_started_at timestamptz,
  p_accounts jsonb default '[]',
  p_added jsonb default '[]',
  p_modified jsonb default '[]',
  p_removed jsonb default '[]'
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_cursor text;
  v_institution text;
  v_account uuid;
  r jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('hydra.bank_item:' || p_item_id::text, 0));

  select b.cursor, b.institution_name into v_cursor, v_institution
  from public.bank_items b where b.id = p_item_id for update;
  if not found then
    raise exception 'bank item % not found', p_item_id using errcode = 'P0002';
  end if;
  if v_cursor is distinct from p_expected_cursor then
    return 'conflict';
  end if;

  insert into public.accounts (bank_item_id, provider_account_id, kind, name, mask, institution, is_manual)
  select p_item_id, a->>'provider_account_id', a->>'kind', a->>'name', a->>'mask', v_institution, false
  from jsonb_array_elements(coalesce(p_accounts, '[]')) a
  on conflict (bank_item_id, provider_account_id)
  do update set name = excluded.name, mask = excluded.mask;

  insert into public.balances (account_id, as_of, current_cents, available_cents, limit_cents)
  select ac.id, p_as_of, (a->>'current_cents')::bigint, (a->>'available_cents')::bigint, (a->>'limit_cents')::bigint
  from jsonb_array_elements(coalesce(p_accounts, '[]')) a
  join public.accounts ac on ac.bank_item_id = p_item_id and ac.provider_account_id = a->>'provider_account_id'
  where coalesce(a->>'current_cents', a->>'available_cents', a->>'limit_cents') is not null
  on conflict (account_id, as_of) do update set
    current_cents = excluded.current_cents,
    available_cents = excluded.available_cents,
    limit_cents = excluded.limit_cents;

  -- ponytail: row-by-row loop; a page is at most 500 rows. Set-based if pages ever get big.
  for r in select value from jsonb_array_elements(coalesce(p_added, '[]') || coalesce(p_modified, '[]')) loop
    select ac.id into v_account from public.accounts ac
    where ac.bank_item_id = p_item_id and ac.provider_account_id = r->>'provider_account_id';
    if v_account is null then
      raise exception 'transaction % names unknown account %', r->>'provider_transaction_id', r->>'provider_account_id'
        using errcode = 'P0002';
    end if;

    -- Pending to posted: the posted row takes over the pending row (one row, owner edits kept).
    if r->>'pending_transaction_id' is not null then
      update public.transactions t set provider_transaction_id = r->>'provider_transaction_id'
      where t.account_id = v_account
        and t.provider_transaction_id = r->>'pending_transaction_id'
        and not exists (
          select 1 from public.transactions x
          where x.account_id = v_account and x.provider_transaction_id = r->>'provider_transaction_id'
        );
    end if;

    insert into public.transactions as t (
      account_id, provider_transaction_id, pending, pending_transaction_id, posted_on, authorized_on,
      amount_cents, name, merchant, raw_description, source
    ) values (
      v_account, r->>'provider_transaction_id', coalesce((r->>'pending')::boolean, false),
      r->>'pending_transaction_id', (r->>'posted_on')::date, (r->>'authorized_on')::date,
      (r->>'amount_cents')::bigint, r->>'name', r->>'merchant', r->>'raw_description', 'plaid'
    )
    on conflict (account_id, provider_transaction_id) do update set
      pending = excluded.pending,
      pending_transaction_id = excluded.pending_transaction_id,
      posted_on = excluded.posted_on,
      authorized_on = excluded.authorized_on,
      amount_cents = excluded.amount_cents,
      name = case when t.renamed then t.name else excluded.name end,
      merchant = excluded.merchant,
      raw_description = excluded.raw_description;
  end loop;

  -- Removed last, so a pending row merged above is not deleted by its own removal.
  delete from public.transactions t
  using jsonb_array_elements(coalesce(p_removed, '[]')) rm, public.accounts ac
  where ac.bank_item_id = p_item_id
    and t.account_id = ac.id
    and t.provider_transaction_id = rm->>'provider_transaction_id';

  update public.bank_items b set
    cursor = p_next_cursor,
    sync_anchor_cursor = case when p_has_more then coalesce(b.sync_anchor_cursor, coalesce(p_expected_cursor, '')) end,
    last_synced_at = case when p_has_more then b.last_synced_at else now() end,
    sync_requested_at = case
      when not p_has_more and b.sync_requested_at <= p_started_at then null
      else b.sync_requested_at
    end,
    last_error = null,
    status = case when b.status in ('login_required', 'error') then 'active' else b.status end
  where b.id = p_item_id;

  return 'applied';
end;
$$;

revoke execute on function public.bank_apply_sync_page(uuid, text, text, boolean, date, timestamptz, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.bank_apply_sync_page(uuid, text, text, boolean, date, timestamptz, jsonb, jsonb, jsonb, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- RLS and grants. Owner only. The sync jobs and the token writes run as service_role.
-- bank_items: nobody but service_role reads the token or the cursors (column grants).
-- ---------------------------------------------------------------------------
alter table public.bank_items enable row level security;
alter table public.accounts enable row level security;
alter table public.balances enable row level security;
alter table public.transactions enable row level security;

revoke all on public.bank_items, public.accounts, public.balances, public.transactions
  from public, anon, authenticated, hydra_ro;

grant select (
  id, provider, provider_item_id, institution_id, institution_name, status, last_synced_at, last_error,
  sync_requested_at, created_at, updated_at
) on public.bank_items to authenticated, hydra_ro;
grant select, insert, update on public.accounts, public.balances, public.transactions to authenticated;
grant select on public.accounts, public.balances, public.transactions to hydra_ro;
grant all on public.bank_items, public.accounts, public.balances, public.transactions to service_role;

drop policy if exists bank_items_owner_select on public.bank_items;
create policy bank_items_owner_select on public.bank_items
  for select to authenticated using ((select public.is_owner()));
drop policy if exists bank_items_ro_select on public.bank_items;
create policy bank_items_ro_select on public.bank_items for select to hydra_ro using (true);

do $$
declare
  t text;
begin
  foreach t in array array['accounts', 'balances', 'transactions'] loop
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
    execute format('drop policy if exists %1$s_ro_select on public.%1$s', t);
    execute format('create policy %1$s_ro_select on public.%1$s for select to hydra_ro using (true)', t);
  end loop;
end;
$$;
