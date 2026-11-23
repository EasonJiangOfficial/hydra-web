-- Hydra 0050: reports queries. One view and seven functions that the Reports page, the Dashboard,
-- Taxes and the Hydra Agent read. DESIGN.md section 9; PLAN.md U5. Plain SQL, safe to re-run.
--
-- Rules every report follows (they match src/lib/ledger/totals.ts):
-- - Money is integer cents. A row counts once, as income or as spending.
-- - Transfers and card payments (is_transfer, or a 'transfer' category) and hidden rows count as nothing.
-- - A category's kind decides where a row counts, not its sign: a refund in an expense category
--   reduces that category. An uncategorized row counts by sign (money in = income).
-- - Subcategories roll up into their top-level category.
-- - Every function takes p_scope ('all', or an entity slug: 'personal', 'ugc') and an inclusive date
--   range, and returns the ids of the rows it used (row_ids = transaction ids, account_ids = accounts)
--   so the Hydra Agent can cite them.
-- - Lists (cash flow links, categories, payers) keep only groups whose net is above zero.
--   The monthly trend, the income summary and the cash flow's savings / drawn link keep net
--   totals over every row. The cash flow shows the groups a refund pushed below zero as one
--   'Refunds' source (expense groups) and one 'Reversals' destination (income groups), so it still
--   balances. Headline totals come from the net totals (src/lib/reports/queries.ts cashFlow).
-- - Security invoker everywhere: RLS of the caller applies (the owner, or hydra_ro). No function
--   writes. The functions are STABLE, so hydra_ro (read-only transactions) can run them.

-- ---------------------------------------------------------------------------
-- reports_flow: one row per transaction that counts as income or spending.
--   kind: 'income' | 'expense'. cents: positive for the kind (a refund in an expense category is
--   negative spending). tax_line_id: the row's own line, else its category's line for the row's
--   entity, else its parent category's line.
-- ---------------------------------------------------------------------------
create or replace view public.reports_flow with (security_invoker = true) as
select
  t.id,
  t.posted_on,
  t.entity_id,
  e.slug as entity_slug,
  t.account_id,
  t.category_id,
  coalesce(c.parent_id, c.id) as top_category_id,
  k.kind,
  case when k.kind = 'income' then t.amount_cents else -t.amount_cents end as cents,
  coalesce(nullif(btrim(t.merchant), ''), t.name) as payer,
  coalesce(t.tax_line_id, m.tax_line_id, mp.tax_line_id) as tax_line_id
from public.transactions t
join public.entities e on e.id = t.entity_id
left join public.categories c on c.id = t.category_id
cross join lateral (
  select coalesce(c.kind, case when t.amount_cents >= 0 then 'income' else 'expense' end) as kind
) k
left join public.category_tax_lines m on m.category_id = t.category_id and m.entity_id = t.entity_id
left join public.category_tax_lines mp on mp.category_id = c.parent_id and mp.entity_id = t.entity_id
where not t.hidden
  and not t.is_transfer
  and k.kind <> 'transfer';

-- ---------------------------------------------------------------------------
-- reports_net_worth: one row per day. Each account counts its latest balance on or before the day.
-- Cash and manual assets add; cards and loans (stored as the amount owed) subtract. Accounts not in
-- net worth, closed by that day, or with no balance yet are left out.
-- ---------------------------------------------------------------------------
create or replace function public.reports_net_worth(p_scope text, p_from date, p_to date)
returns table (day date, assets_cents bigint, debts_cents bigint, net_cents bigint, account_ids uuid[])
language sql
stable
set search_path = ''
as $$
  select
    s.day,
    s.assets,
    s.debts,
    s.assets - s.debts,
    s.ids
  from (
    select
      d.day,
      coalesce(sum(x.cents) filter (where x.kind in ('cash', 'asset')), 0)::bigint as assets,
      coalesce(sum(x.cents) filter (where x.kind in ('card', 'loan')), 0)::bigint as debts,
      coalesce(array_agg(x.id order by x.id) filter (where x.id is not null), '{}'::uuid[]) as ids
    from (select p_from + n as day from generate_series(0, p_to - p_from) n) d
    left join lateral (
      select a.id, a.kind, b.current_cents as cents
      from public.accounts a
      join public.entities e on e.id = a.entity_id
      cross join lateral (
        select b.current_cents
        from public.balances b
        where b.account_id = a.id and b.as_of <= d.day
        order by b.as_of desc
        limit 1
      ) b
      where a.in_net_worth
        and (a.closed_at is null or a.closed_at::date > d.day)
        and (p_scope = 'all' or e.slug = p_scope)
        and b.current_cents is not null
    ) x on true
    group by d.day
  ) s
  order by s.day;
$$;

-- ---------------------------------------------------------------------------
-- reports_cash_flow: the Sankey links. Income sources -> Income -> each expense category, taxes set
-- aside ('taxes': expense rows in a top-level category named Taxes), and Savings. When spending
-- is above income, 'drawn' (Drawn from savings) -> Income covers the gap. A group whose net is below
-- zero is not listed: expense groups (net refunds) feed Income as 'Refunds', income groups (net
-- reversals) leave it as 'Reversals'. Money into Income equals money out of it, to the cent (RM-02).
-- Node ids: income:<category id|none>, income, expense:<category id|none>, taxes, savings, drawn,
-- refunds, reversals.
-- ---------------------------------------------------------------------------
create or replace function public.reports_cash_flow(p_scope text, p_from date, p_to date)
returns table (source_id text, source_label text, target_id text, target_label text, cents bigint, row_ids uuid[])
language sql
stable
set search_path = ''
as $$
  with f as (
    select r.*, tc.name as top_name
    from public.reports_flow r
    left join public.categories tc on tc.id = r.top_category_id
    where (p_scope = 'all' or r.entity_slug = p_scope)
      and r.posted_on between p_from and p_to
  ),
  ig as (
    select 'income:' || coalesce(f.top_category_id::text, 'none') as id,
           coalesce(min(f.top_name), 'Uncategorized income') as label,
           sum(f.cents)::bigint as cents,
           array_agg(f.id order by f.posted_on, f.id) as ids
    from f
    where f.kind = 'income'
    group by f.top_category_id
  ),
  inc as (select * from ig where ig.cents > 0),
  eg as (
    select n.id, min(n.label) as label, sum(n.cents)::bigint as cents, array_agg(n.tid order by n.posted_on, n.tid) as ids
    from (
      select
        case when lower(f.top_name) = 'taxes' then 'taxes' else 'expense:' || coalesce(f.top_category_id::text, 'none') end as id,
        case when lower(f.top_name) = 'taxes' then 'Taxes set aside' else coalesce(f.top_name, 'Uncategorized') end as label,
        f.cents, f.id as tid, f.posted_on
      from f
      where f.kind = 'expense'
    ) n
    group by n.id
  ),
  exp as (select * from eg where eg.cents > 0),
  -- Savings and drawn come from the net totals of every row, not the listed groups: a category a
  -- refund pushed to zero or below drops off the list but still counts (MONEY-04).
  tot as (
    select coalesce(sum(f.cents) filter (where f.kind = 'income'), 0) as i,
           coalesce(sum(f.cents) filter (where f.kind = 'expense'), 0) as e
    from f
  )
  select l.source_id, l.source_label, l.target_id, l.target_label, l.cents::bigint, l.row_ids
  from (
    select inc.id as source_id, inc.label as source_label, 'income' as target_id, 'Income' as target_label,
           inc.cents, inc.ids as row_ids
    from inc
    union all
    select 'income', 'Income', exp.id, exp.label, exp.cents, exp.ids from exp
    union all
    select 'income', 'Income', 'savings', 'Savings', tot.i - tot.e, '{}'::uuid[] from tot where tot.i > tot.e
    union all
    select 'drawn', 'Drawn from savings', 'income', 'Income', tot.e - tot.i, '{}'::uuid[] from tot where tot.e > tot.i
    union all
    select 'refunds', 'Refunds', 'income', 'Income', -sum(eg.cents),
           (select array_agg(u order by u) from eg x cross join unnest(x.ids) u where x.cents < 0)
    from eg where eg.cents < 0 having count(*) > 0
    union all
    select 'income', 'Income', 'reversals', 'Reversals', -sum(ig.cents),
           (select array_agg(u order by u) from ig x cross join unnest(x.ids) u where x.cents < 0)
    from ig where ig.cents < 0 having count(*) > 0
  ) l
  order by l.cents desc, l.source_id, l.target_id;
$$;

-- ---------------------------------------------------------------------------
-- reports_spending_by_category: spending per top-level expense category (the donut and its table).
-- The share of the total is computed by the caller from cents (src/lib/reports/queries.ts).
-- ---------------------------------------------------------------------------
create or replace function public.reports_spending_by_category(p_scope text, p_from date, p_to date)
returns table (category_id uuid, name text, color text, cents bigint, tx_count int, row_ids uuid[])
language sql
stable
set search_path = ''
as $$
  select
    f.top_category_id,
    coalesce(min(tc.name), 'Uncategorized'),
    min(tc.color),
    sum(f.cents)::bigint,
    count(*)::int,
    array_agg(f.id order by f.posted_on, f.id)
  from public.reports_flow f
  left join public.categories tc on tc.id = f.top_category_id
  where f.kind = 'expense'
    and (p_scope = 'all' or f.entity_slug = p_scope)
    and f.posted_on between p_from and p_to
  group by f.top_category_id
  having sum(f.cents) > 0
  order by sum(f.cents) desc, coalesce(min(tc.name), 'Uncategorized');
$$;

-- ---------------------------------------------------------------------------
-- reports_income_by_payer: income totalled per payer (merchant, else name; case and outer spaces
-- ignored). Year to date = the caller passes January 1 to today.
-- ---------------------------------------------------------------------------
create or replace function public.reports_income_by_payer(p_scope text, p_from date, p_to date)
returns table (payer text, cents bigint, tx_count int, row_ids uuid[])
language sql
stable
set search_path = ''
as $$
  select
    min(f.payer collate "C"),
    sum(f.cents)::bigint,
    count(*)::int,
    array_agg(f.id order by f.posted_on, f.id)
  from public.reports_flow f
  where f.kind = 'income'
    and (p_scope = 'all' or f.entity_slug = p_scope)
    and f.posted_on between p_from and p_to
  group by lower(btrim(f.payer))
  having sum(f.cents) > 0
  order by sum(f.cents) desc, min(f.payer collate "C");
$$;

-- ---------------------------------------------------------------------------
-- reports_monthly_trend: income, spending and net for each calendar month the range touches
-- (months with no rows are zeros). The first and last month count only the days in the range.
-- ---------------------------------------------------------------------------
create or replace function public.reports_monthly_trend(p_scope text, p_from date, p_to date)
returns table (month date, income_cents bigint, spending_cents bigint, net_cents bigint, tx_count int, row_ids uuid[])
language sql
stable
set search_path = ''
as $$
  select
    s.month, s.income, s.spending, s.income - s.spending, s.n, s.ids
  from (
    select
      m.month,
      coalesce(sum(f.cents) filter (where f.kind = 'income'), 0)::bigint as income,
      coalesce(sum(f.cents) filter (where f.kind = 'expense'), 0)::bigint as spending,
      count(f.id)::int as n,
      coalesce(array_agg(f.id order by f.posted_on, f.id) filter (where f.id is not null), '{}'::uuid[]) as ids
    from (
      select g::date as month
      from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') g
    ) m
    left join public.reports_flow f
      on date_trunc('month', f.posted_on)::date = m.month
     and (p_scope = 'all' or f.entity_slug = p_scope)
     and f.posted_on between p_from and p_to
    group by m.month
  ) s
  order by s.month;
$$;

-- ---------------------------------------------------------------------------
-- reports_tax_lines: expense totals per entity, calendar year and Schedule C line. Rows with no
-- tax line are left out. A net refund shows as a negative total.
-- ---------------------------------------------------------------------------
create or replace function public.reports_tax_lines(p_scope text, p_from date, p_to date)
returns table (
  entity_id uuid, entity_slug text, year int, tax_line_id uuid, code text, name text,
  cents bigint, tx_count int, row_ids uuid[]
)
language sql
stable
set search_path = ''
as $$
  select
    f.entity_id,
    f.entity_slug,
    extract(year from f.posted_on)::int,
    tl.id,
    tl.code,
    tl.name,
    sum(f.cents)::bigint,
    count(*)::int,
    array_agg(f.id order by f.posted_on, f.id)
  from public.reports_flow f
  join public.tax_lines tl on tl.id = f.tax_line_id
  where f.kind = 'expense'
    and (p_scope = 'all' or f.entity_slug = p_scope)
    and f.posted_on between p_from and p_to
  group by f.entity_id, f.entity_slug, extract(year from f.posted_on), tl.id, tl.code, tl.name, tl.position
  having sum(f.cents) <> 0
  order by f.entity_slug, extract(year from f.posted_on), tl.position;
$$;

-- ---------------------------------------------------------------------------
-- reports_income_summary: one row. Income before card bills = income in the range. Net after card
-- bills = that minus what the open cards owe now (each card's latest balance on or before p_to).
-- ---------------------------------------------------------------------------
create or replace function public.reports_income_summary(p_scope text, p_from date, p_to date)
returns table (
  income_cents bigint, card_balance_cents bigint, net_after_cards_cents bigint,
  income_row_ids uuid[], card_account_ids uuid[]
)
language sql
stable
set search_path = ''
as $$
  select
    i.cents,
    c.cents,
    i.cents - c.cents,
    i.ids,
    c.ids
  from (
    select
      coalesce(sum(f.cents), 0)::bigint as cents,
      coalesce(array_agg(f.id order by f.posted_on, f.id) filter (where f.id is not null), '{}'::uuid[]) as ids
    from public.reports_flow f
    where f.kind = 'income'
      and (p_scope = 'all' or f.entity_slug = p_scope)
      and f.posted_on between p_from and p_to
  ) i
  cross join (
    select
      coalesce(sum(b.current_cents), 0)::bigint as cents,
      coalesce(array_agg(a.id order by a.id) filter (where a.id is not null), '{}'::uuid[]) as ids
    from public.accounts a
    join public.entities e on e.id = a.entity_id
    cross join lateral (
      select b.current_cents
      from public.balances b
      where b.account_id = a.id and b.as_of <= p_to
      order by b.as_of desc
      limit 1
    ) b
    where a.kind = 'card'
      and (a.closed_at is null or a.closed_at::date > p_to)
      and (p_scope = 'all' or e.slug = p_scope)
      and b.current_cents is not null
  ) c;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Default privileges give nothing, so every grant is explicit. Anon gets none.
-- ---------------------------------------------------------------------------
revoke all on public.reports_flow from public, anon;
grant select on public.reports_flow to authenticated, hydra_ro, service_role;

revoke execute on function public.reports_net_worth(text, date, date) from public, anon;
revoke execute on function public.reports_cash_flow(text, date, date) from public, anon;
revoke execute on function public.reports_spending_by_category(text, date, date) from public, anon;
revoke execute on function public.reports_income_by_payer(text, date, date) from public, anon;
revoke execute on function public.reports_monthly_trend(text, date, date) from public, anon;
revoke execute on function public.reports_tax_lines(text, date, date) from public, anon;
revoke execute on function public.reports_income_summary(text, date, date) from public, anon;
grant execute on function public.reports_net_worth(text, date, date) to authenticated, hydra_ro, service_role;
grant execute on function public.reports_cash_flow(text, date, date) to authenticated, hydra_ro, service_role;
grant execute on function public.reports_spending_by_category(text, date, date) to authenticated, hydra_ro, service_role;
grant execute on function public.reports_income_by_payer(text, date, date) to authenticated, hydra_ro, service_role;
grant execute on function public.reports_monthly_trend(text, date, date) to authenticated, hydra_ro, service_role;
grant execute on function public.reports_tax_lines(text, date, date) to authenticated, hydra_ro, service_role;
grant execute on function public.reports_income_summary(text, date, date) to authenticated, hydra_ro, service_role;
