-- Hydra 0115: balance history computed from transactions. A bank link gives one real balance per
-- day from the day it was linked, so every day before it had no balance and the net worth chart
-- showed one dot. These functions walk each account back from its next real balance through its
-- posted transactions. Nothing new is stored: a real daily balance from a sync replaces the estimate
-- for its day (and anchors the days before it) as soon as it lands. Plain SQL, safe to re-run.
--
-- Signs (0020): amount_cents is money into the account (+) or out (-). balances.current_cents is the
-- value for cash and assets, and the amount owed (positive) for cards and loans. So, with A the next
-- real balance on or after day d and S the posted amounts dated after d up to A:
--   cash, asset: value(d) = value(A) - S      card, loan: owed(d) = owed(A) + S
-- A real balance on d itself is used as is. Days after an account's last real balance carry it flat
-- (not estimated). Every posted row counts (hidden and transfers too: they moved the balance);
-- pending rows never do. Before an account's first transaction the walk-back is flat by itself.
--
-- reports_net_worth (0050) is left as it was; the app reads net_worth_history instead.
-- Security invoker everywhere (RLS of the caller: the owner, or hydra_ro). STABLE, no writes.

-- ---------------------------------------------------------------------------
-- account_balance_days: one row per account per day from p_from to p_to. One pass: a day grid per
-- account, the posted amounts summed per day, a running sum, and window groups that find each day's
-- next real balance (gd) and last real balance (ga). current_cents is null when the account has no
-- real balance to anchor on. available and limit are given on real days only.
-- ---------------------------------------------------------------------------
create or replace function public.account_balance_days(p_account_ids uuid[], p_from date, p_to date)
returns table (account_id uuid, day date, current_cents bigint, available_cents bigint, limit_cents bigint, estimated boolean)
language sql
stable
set search_path = ''
as $$
  with acc as (
    select a.id, case when a.kind in ('card', 'loan') then -1 else 1 end as sgn
    from public.accounts a
    where a.id = any (p_account_ids)
  ),
  -- The owner's today. A real balance dated after it is not in effect yet: it counts from its own
  -- day on (as in 0050), and no earlier day anchors on it.
  td as (
    select (now() at time zone coalesce((select s.time_zone from public.settings s limit 1), 'UTC'))::date as d
  ),
  -- The grid runs to the last real balance up to today, so a day before it can anchor on it even
  -- past p_to.
  lim as (
    select greatest(p_to, (
      select max(b.as_of) from public.balances b cross join td
      where b.account_id = any (p_account_ids) and b.current_cents is not null and b.as_of <= td.d
    )) as last
  ),
  grid as (
    select acc.id, acc.sgn, p_from + n as day
    from acc cross join lim cross join generate_series(0, lim.last - p_from) n
  ),
  mv as (
    select t.account_id, t.posted_on, sum(t.amount_cents)::bigint as cents
    from public.transactions t cross join lim
    where t.account_id = any (p_account_ids)
      and not t.pending
      and t.posted_on between p_from and lim.last
    group by t.account_id, t.posted_on
  ),
  c as (
    select
      g.id, g.sgn, g.day,
      b.current_cents as real, b.available_cents, b.limit_cents,
      sum(coalesce(mv.cents, 0)) over (partition by g.id order by g.day) as cum,
      count(b.current_cents) over (partition by g.id order by g.day) as ga,
      count(case when g.day <= td.d then b.current_cents end) over (partition by g.id order by g.day desc) as gd
    from grid g
    cross join td
    left join mv on mv.account_id = g.id and mv.posted_on = g.day
    left join public.balances b on b.account_id = g.id and b.as_of = g.day and b.current_cents is not null
  ),
  k as (
    select
      c.*,
      -- Each gd > 0 group holds one real balance up to today (its last day) and the days before it.
      -- Days after today are all in gd = 0, so a later real balance never lands in a gd > 0 group.
      max(c.real) over (partition by c.id, c.gd) as next_real,
      max(case when c.real is not null then c.cum end) over (partition by c.id, c.gd) as next_cum,
      -- Each ga group holds one real balance (its first day) and the days after it.
      max(c.real) over (partition by c.id, c.ga) as prev_real
    from c
  )
  select
    k.id,
    k.day,
    case
      when k.gd > 0 then k.next_real - k.sgn * (k.next_cum - k.cum)
      when k.ga > 0 then k.prev_real
      else (
        select b.current_cents from public.balances b
        where b.account_id = k.id and b.as_of < p_from and b.current_cents is not null
        order by b.as_of desc limit 1
      )
    end::bigint,
    k.available_cents,
    k.limit_cents,
    k.real is null and k.gd > 0
  from k
  where k.day <= p_to
  order by k.id, k.day;
$$;

-- ---------------------------------------------------------------------------
-- net_worth_history: one row per day, from the first transaction or real balance of any account in
-- scope (or p_from, if later) to p_to. Cash and assets add; cards and loans subtract. Accounts not in
-- net worth, closed by that day, or with no real balance at all are left out. estimated: some
-- account's value that day came from transactions, not a real balance.
-- ---------------------------------------------------------------------------
create or replace function public.net_worth_history(p_scope text, p_from date, p_to date)
returns table (day date, assets_cents bigint, debts_cents bigint, net_cents bigint, account_ids uuid[], estimated boolean)
language sql
stable
set search_path = ''
as $$
  with acc as (
    select a.id, a.kind, a.closed_at
    from public.accounts a
    join public.entities e on e.id = a.entity_id
    where a.in_net_worth and (p_scope = 'all' or e.slug = p_scope)
  ),
  ids as (select coalesce(array_agg(acc.id), '{}'::uuid[]) as v from acc),
  -- No rows at all: no days (greatest() alone would skip the null and start at p_from).
  first as (
    select least(
      (select min(t.posted_on) from public.transactions t join acc on acc.id = t.account_id where not t.pending),
      (select min(b.as_of) from public.balances b join acc on acc.id = b.account_id where b.current_cents is not null)
    ) as d
  ),
  start as (select case when f.d is not null then greatest(p_from, f.d) end as d from first f),
  x as (
    select v.day, v.current_cents as cents, v.estimated, acc.id, acc.kind
    from start
    cross join ids
    cross join lateral public.account_balance_days(ids.v, start.d, p_to) v
    join acc on acc.id = v.account_id
    where v.current_cents is not null
      and (acc.closed_at is null or acc.closed_at::date > v.day)
  ),
  days as (
    select s.d + n as day
    from start s cross join generate_series(0, p_to - s.d) n
    where s.d is not null
  )
  select
    d.day,
    coalesce(sum(x.cents) filter (where x.kind in ('cash', 'asset')), 0)::bigint,
    coalesce(sum(x.cents) filter (where x.kind in ('card', 'loan')), 0)::bigint,
    (coalesce(sum(x.cents) filter (where x.kind in ('cash', 'asset')), 0)
      - coalesce(sum(x.cents) filter (where x.kind in ('card', 'loan')), 0))::bigint,
    coalesce(array_agg(x.id order by x.id) filter (where x.id is not null), '{}'::uuid[]),
    coalesce(bool_or(x.estimated), false)
  from days d
  left join x on x.day = d.day
  group by d.day
  order by d.day;
$$;

-- ---------------------------------------------------------------------------
-- account_balance_history: one account's daily balances for its chart and the Hydra Agent. By
-- default from its first transaction or real balance (at most the last 1000 days: PostgREST returns
-- 1000 rows) to its last real balance. Days with no balance to anchor on are left out.
-- ---------------------------------------------------------------------------
create or replace function public.account_balance_history(p_account_id uuid, p_from date default null, p_to date default null)
returns table (as_of date, current_cents bigint, available_cents bigint, limit_cents bigint, estimated boolean)
language sql
stable
set search_path = ''
as $$
  with r as (
    select coalesce(p_to, (
      select max(b.as_of) from public.balances b where b.account_id = p_account_id and b.current_cents is not null
    )) as to_d
  ),
  f as (
    select r.to_d, coalesce(p_from, greatest(r.to_d - 999, least(
      (select min(t.posted_on) from public.transactions t where t.account_id = p_account_id and not t.pending),
      (select min(b.as_of) from public.balances b where b.account_id = p_account_id and b.current_cents is not null)
    ))) as from_d
    from r
  )
  select v.day, v.current_cents, v.available_cents, v.limit_cents, v.estimated
  from f cross join lateral public.account_balance_days(array[p_account_id], f.from_d, f.to_d) v
  where f.from_d is not null and f.to_d is not null and v.current_cents is not null
  order by v.day;
$$;

revoke execute on function public.account_balance_days(uuid[], date, date) from public, anon;
revoke execute on function public.net_worth_history(text, date, date) from public, anon;
revoke execute on function public.account_balance_history(uuid, date, date) from public, anon;
grant execute on function public.account_balance_days(uuid[], date, date) to authenticated, hydra_ro, service_role;
grant execute on function public.net_worth_history(text, date, date) to authenticated, hydra_ro, service_role;
grant execute on function public.account_balance_history(uuid, date, date) to authenticated, hydra_ro, service_role;
