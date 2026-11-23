-- Hydra 0080: connector API keys (Grokbot) and the connector's UGC read functions. DESIGN.md
-- sections 8 (Grokbot connector) and 11 (connector keys). Plain SQL, safe to re-run.
--
-- A key is random, shown once, stored as its SHA-256 (hex), scoped, revocable, rate limited per
-- key. The owner manages keys through RLS (src/lib/keys/actions.ts). The connector routes check a
-- presented key with api_key_authenticate(), a security-definer function only the service role may
-- call; the routes then act through the four UGC tools only (src/app/api/ugc/v1/tools.ts).

-- ---------------------------------------------------------------------------
-- api_keys: one row per key. key_hash is the only copy of the secret; prefix is for display.
-- ---------------------------------------------------------------------------
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 100),
  prefix text not null check (length(prefix) between 8 and 32),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  scope text not null default 'ugc:write' check (scope in ('ugc:write')),
  rate_limit_per_minute integer not null default 120 check (rate_limit_per_minute between 1 and 10000),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint api_keys_hash_key unique (key_hash)
);

-- ---------------------------------------------------------------------------
-- api_key_rate_limits: one fixed one-minute window per key. Written only by api_key_authenticate().
-- ---------------------------------------------------------------------------
create table if not exists public.api_key_rate_limits (
  key_id uuid primary key references public.api_keys (id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null check (request_count >= 0)
);

-- ---------------------------------------------------------------------------
-- api_key_authenticate(): the key check for the connector routes. Looks up the hash, refuses a
-- revoked key or a missing scope, counts the request in the key's current minute, refuses past
-- the key's limit, and stamps last_used_at. Status: ok | invalid | revoked | forbidden |
-- rate_limited. Security definer: the caller needs no rights on the tables. Service role only.
-- ---------------------------------------------------------------------------
create or replace function public.api_key_authenticate(p_key_hash text, p_scope text)
returns table (key_id uuid, status text, retry_after_seconds integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  k public.api_keys%rowtype;
  win timestamptz := date_trunc('minute', now());
  n integer;
begin
  select * into k from public.api_keys a where a.key_hash = p_key_hash;
  if not found then
    return query select null::uuid, 'invalid'::text, null::integer;
    return;
  end if;
  if k.revoked_at is not null then
    return query select k.id, 'revoked'::text, null::integer;
    return;
  end if;
  if k.scope is distinct from p_scope then
    return query select k.id, 'forbidden'::text, null::integer;
    return;
  end if;

  insert into public.api_key_rate_limits as r (key_id, window_start, request_count)
  values (k.id, win, 1)
  on conflict (key_id) do update
    set request_count = case when r.window_start = excluded.window_start then r.request_count + 1 else 1 end,
        window_start = excluded.window_start
  returning r.request_count into n;

  if n > k.rate_limit_per_minute then
    return query select k.id, 'rate_limited'::text,
      greatest(1, ceil(extract(epoch from (win + interval '1 minute' - now()))))::integer;
    return;
  end if;

  update public.api_keys a set last_used_at = now() where a.id = k.id;
  return query select k.id, 'ok'::text, null::integer;
end;
$$;
revoke execute on function public.api_key_authenticate(text, text) from public, anon, authenticated;
grant execute on function public.api_key_authenticate(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- ugc_posts_needing_views(): the connector's work list for the owner-zone day of p_now. A post is
-- on it while its freeze window is open (posted_at + freeze days of 24 h, default 14), it is not
-- excluded, and it has no reading that day yet. Caller's rights, so RLS applies.
-- ---------------------------------------------------------------------------
create or replace function public.ugc_posts_needing_views(p_now timestamptz default now())
returns table (
  post_id uuid,
  deal_id uuid,
  url text,
  platform text,
  account_handle text,
  posted_at timestamptz,
  freeze_ends_at timestamptz,
  last_views bigint,
  last_captured_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with z as (select coalesce((select s.time_zone from public.settings s limit 1), 'UTC') as tz),
  open_posts as (
    select p.*, p.posted_at + make_interval(hours => 24 * coalesce(d.view_freeze_days, 14)) as ends_at
    from public.posts p
    join public.deals d on d.id = p.deal_id
    where not p.exclude_from_pay and p.posted_at <= p_now
  )
  select p.id, p.deal_id, p.url, p.platform, a.handle, p.posted_at, p.ends_at, v.latest_views, v.last_captured_at
  from open_posts p
  cross join z
  left join public.deal_accounts a on a.id = p.account_id
  left join public.ugc_post_views v on v.post_id = p.id
  where p_now <= p.ends_at
    and not exists (
      select 1 from public.post_view_snapshots s
      where s.post_id = p.id and s.captured_day = (p_now at time zone z.tz)::date
    )
  order by p.posted_at, p.id;
$$;
revoke execute on function public.ugc_posts_needing_views(timestamptz) from public, anon;
grant execute on function public.ugc_posts_needing_views(timestamptz) to authenticated, service_role, hydra_ro;

-- ---------------------------------------------------------------------------
-- ugc_missed_view_days(): the missed-day warning for the dashboard (and ugc_context). For each of
-- the p_days owner-zone days before the day of p_now (1 to 60), the posts that needed a reading all
-- that day (posted before the day began, freeze window open until the day ended, not excluded)
-- and how many got one. Only days with a gap are returned. Caller's rights, so RLS applies.
-- ---------------------------------------------------------------------------
create or replace function public.ugc_missed_view_days(p_days integer default 7, p_now timestamptz default now())
returns table (day date, posts_needing integer, posts_read integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with z as (select coalesce((select s.time_zone from public.settings s limit 1), 'UTC') as tz),
  days as (
    select g::date as day,
           (g::date::timestamp at time zone z.tz) as day_start,
           ((g::date + 1)::timestamp at time zone z.tz) as day_end
    from z,
      generate_series(
        ((p_now at time zone z.tz)::date - greatest(1, least(coalesce(p_days, 7), 60)))::timestamp,
        ((p_now at time zone z.tz)::date - 1)::timestamp,
        interval '1 day'
      ) g
  )
  select dy.day, count(*)::integer, count(s.id)::integer
  from days dy
  join public.posts p on p.posted_at < dy.day_start and not p.exclude_from_pay
  join public.deals d on d.id = p.deal_id
  left join public.post_view_snapshots s on s.post_id = p.id and s.captured_day = dy.day
  where dy.day_end <= p.posted_at + make_interval(hours => 24 * coalesce(d.view_freeze_days, 14))
  group by dy.day
  having count(s.id) < count(*)
  order by dy.day;
$$;
revoke execute on function public.ugc_missed_view_days(integer, timestamptz) from public, anon;
grant execute on function public.ugc_missed_view_days(integer, timestamptz) to authenticated, service_role, hydra_ro;

-- ---------------------------------------------------------------------------
-- RLS: the owner manages keys (create, list, rename, revoke) and reads the counters. The secret
-- hash and the counters are never written through the API except by the function above.
-- ---------------------------------------------------------------------------
alter table public.api_keys enable row level security;
alter table public.api_key_rate_limits enable row level security;

revoke all on public.api_keys, public.api_key_rate_limits from public, anon, authenticated;
grant select, insert on public.api_keys to authenticated;
grant update (name, revoked_at) on public.api_keys to authenticated;
grant select on public.api_key_rate_limits to authenticated;
grant all on public.api_keys, public.api_key_rate_limits to service_role;
-- hydra_ro (0001 grants it every new table by default) never reads keys or counters.
revoke all on public.api_keys, public.api_key_rate_limits from hydra_ro;

drop policy if exists api_keys_owner_select on public.api_keys;
create policy api_keys_owner_select on public.api_keys
  for select to authenticated using ((select public.is_owner()));
drop policy if exists api_keys_owner_insert on public.api_keys;
create policy api_keys_owner_insert on public.api_keys
  for insert to authenticated
  with check ((select public.is_owner()) and last_used_at is null and revoked_at is null);
drop policy if exists api_keys_owner_update on public.api_keys;
create policy api_keys_owner_update on public.api_keys
  for update to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

drop policy if exists api_key_rate_limits_owner_select on public.api_key_rate_limits;
create policy api_key_rate_limits_owner_select on public.api_key_rate_limits
  for select to authenticated using ((select public.is_owner()));
