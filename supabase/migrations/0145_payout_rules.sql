-- Payout matching (src/lib/ugc/payout-match.ts). Brand payouts land as PayPal transfers, wires,
-- real-time transfers and ACH without the brand's name, so Hydra suggests which deposit pays which
-- deal and the owner confirms (a deal_payments row, the existing match path) or says "Not this".
--
-- payout_match_rejections: a "Not this" answer. That deposit is never suggested for that deal again.
-- payout_rules: a learned payer pattern ("PayPal transfers around the 1st are Wordwise"), offered
--   after two confirmations. 'accepted' rules raise the suggestion; 'declined' stops the offer.

create table if not exists public.payout_match_rejections (
  deal_id uuid not null references public.deals (id) on delete cascade,
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (deal_id, transaction_id)
);
create index if not exists payout_match_rejections_tx_idx on public.payout_match_rejections (transaction_id);

create table if not exists public.payout_rules (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals (id) on delete cascade,
  -- payerKey() of the deposit name: lower case, digits and punctuation gone, first words.
  payer_key text not null check (char_length(payer_key) between 1 and 200),
  -- The day of the month the payouts arrive near; null = any day.
  day_of_month integer check (day_of_month between 1 and 31),
  day_window integer not null default 3 check (day_window between 0 and 15),
  decision text not null check (decision in ('accepted', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_rules_deal_payer_key unique (deal_id, payer_key)
);

drop trigger if exists payout_rules_touch_updated_at on public.payout_rules;
create trigger payout_rules_touch_updated_at
  before update on public.payout_rules
  for each row execute function private.touch_updated_at();

-- RLS: owner only; hydra_ro reads. Grants are explicit.
alter table public.payout_match_rejections enable row level security;
alter table public.payout_rules enable row level security;

revoke all on public.payout_match_rejections, public.payout_rules from public, anon, authenticated, service_role;
grant select, insert, delete on public.payout_match_rejections to authenticated;
grant select, insert, update, delete on public.payout_rules to authenticated;
grant select on public.payout_match_rejections, public.payout_rules to hydra_ro;

do $$
declare
  t text;
begin
  foreach t in array array['payout_match_rejections', 'payout_rules']
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

-- Activity and undo (0130): both tables are logged, like transfer_rejections. Skipped where 0130 has not run.
do $$
begin
  if to_regclass('private.activity_tables') is not null then
    insert into private.activity_tables (tbl, logged, reason)
    values ('payout_match_rejections', true, null), ('payout_rules', true, null)
    on conflict (tbl) do update set logged = excluded.logged, reason = excluded.reason;
    drop trigger if exists "0_activity_capture" on public.payout_match_rejections;
    create trigger "0_activity_capture" after insert or update or delete on public.payout_match_rejections
      for each row execute function private.activity_capture('deal_id', 'transaction_id');
    drop trigger if exists "0_activity_capture" on public.payout_rules;
    create trigger "0_activity_capture" after insert or update or delete on public.payout_rules
      for each row execute function private.activity_capture('id');
  end if;
end;
$$;
