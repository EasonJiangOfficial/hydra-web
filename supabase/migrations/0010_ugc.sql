-- Hydra 0010: UGC deals, accounts, posts, view snapshots, payments, day targets. DESIGN.md section 8.
-- Money is integer cents (bigint). CPM rates are dollars per view unit, numeric(12,4) (a rate, not
-- an amount: $0.0125 per 1,000 views does not fit whole cents). Pay math is src/lib/ugc. Safe to re-run.

-- ---------------------------------------------------------------------------
-- deals: one creator's UGC deals with every Ripple pay column that matters to one creator.
-- ---------------------------------------------------------------------------
create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id), -- always UGC (trigger below)
  brand_name text not null check (length(btrim(brand_name)) between 1 and 200),
  logo_path text check (logo_path is null or length(logo_path) between 1 and 500), -- Storage object path
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  start_date date not null,
  end_date date,
  per_deal_model boolean not null default false, -- off: pay per video (calcPay); on: Ripple's per-deal aggregate
  -- Base pay per video, gated by a minimum view count. null = no base pay.
  base_pay_cents bigint check (base_pay_cents >= 0),
  base_min_views integer not null default 0 check (base_min_views >= 0),
  -- View bonus tiers [{views, bonusCents}]; REPLACE = max(base, bonus), ADD = base + bonus.
  view_bonuses jsonb not null default '[]' check (jsonb_typeof(view_bonuses) = 'array'),
  view_bonus_mode text not null default 'REPLACE' check (view_bonus_mode in ('REPLACE', 'ADD')),
  -- CPM: dollars per cpm_view_unit views, optional cap, floor (cpm_min_views), marginal tiers [{views, ratePerUnit}].
  cpm_rate numeric(12, 4) check (cpm_rate >= 0),
  cpm_view_unit integer not null default 1000 check (cpm_view_unit > 0),
  cpm_cap_views integer check (cpm_cap_views >= 0),
  cpm_min_views integer check (cpm_min_views >= 0),
  cpm_tiers jsonb not null default '[]' check (jsonb_typeof(cpm_tiers) = 'array'),
  cpm_mode text not null default 'ADD' check (cpm_mode in ('ADD', 'REPLACE')),
  cpm_tier_mode text not null default 'PER_VIDEO'
    check (cpm_tier_mode in ('PER_VIDEO', 'COMBINED_BRACKETED', 'COMBINED_FLAT')),
  -- One video on several accounts: HIGHEST = best account's views, COMBINED = their sum.
  view_aggregation_mode text not null default 'HIGHEST' check (view_aggregation_mode in ('HIGHEST', 'COMBINED')),
  view_freeze_days integer check (view_freeze_days between 1 and 365), -- null = 14
  retainer_cents bigint check (retainer_cents >= 0), -- per pay cycle; null = none
  flat_rate_cents bigint check (flat_rate_cents >= 0), -- one time; null = none
  daily_target_posts integer not null default 1 check (daily_target_posts between 0 and 30),
  pay_cycle text check (pay_cycle in ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'DAYS_OF_MONTH')),
  pay_cycle_anchor_day integer check (pay_cycle_anchor_day between 1 and 31),
  pay_cycle_anchor_weekday integer check (pay_cycle_anchor_weekday between 0 and 6),
  pay_cycle_anchor_days integer[] not null default '{}',
  -- How a bank deposit matches this deal: {payerContains?, minCents?, maxCents?}.
  payout_rule jsonb not null default '{}' check (jsonb_typeof(payout_rule) = 'object'),
  source text not null default 'hydra' check (source in ('hydra', 'ripple')),
  source_id text, -- the Ripple Campaign id for imports; one row per (source, source_id)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deals_dates_check check (end_date is null or end_date >= start_date),
  constraint deals_source_key unique (source, source_id)
);

-- Every deal belongs to the UGC entity, whatever the writer sends.
create or replace function private.deals_set_entity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.entity_id := (select e.id from public.entities e where e.slug = 'ugc');
  return new;
end;
$$;
revoke execute on function private.deals_set_entity() from public;

drop trigger if exists deals_set_entity on public.deals;
create trigger deals_set_entity
  before insert or update of entity_id on public.deals
  for each row execute function private.deals_set_entity();

drop trigger if exists deals_touch_updated_at on public.deals;
create trigger deals_touch_updated_at
  before update on public.deals
  for each row execute function private.touch_updated_at();

-- Pause history: [{from, to}] owner-zone days with no posting target (to null = still paused). The
-- trigger keeps it, so a pause never erases the missed money and targets of the days before it.
alter table public.deals
  add column if not exists paused_spans jsonb not null default '[]' check (jsonb_typeof(paused_spans) = 'array');

-- Pausing opens a span on today (owner zone); leaving a pause closes it on yesterday (a same-day
-- pause leaves nothing). src/lib/ugc/ledger.ts nextPausedSpans is the same rule in TypeScript.
create or replace function private.deals_track_pause()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  today date := (now() at time zone coalesce((select s.time_zone from public.settings s limit 1), 'UTC'))::date;
begin
  if new.status = 'paused' and old.status <> 'paused' then
    new.paused_spans := coalesce(new.paused_spans, '[]') || jsonb_build_array(jsonb_build_object('from', today, 'to', null));
  elsif old.status = 'paused' and new.status <> 'paused' then
    new.paused_spans := coalesce((
      select jsonb_agg(case when e ->> 'to' is null then jsonb_build_object('from', e ->> 'from', 'to', today - 1) else e end
                       order by i)
      from jsonb_array_elements(coalesce(new.paused_spans, '[]')) with ordinality as t (e, i)
      where not (e ->> 'to' is null and (e ->> 'from')::date > today - 1)
    ), '[]');
  end if;
  return new;
end;
$$;
revoke execute on function private.deals_track_pause() from public;

drop trigger if exists deals_track_pause on public.deals;
create trigger deals_track_pause
  before update of status on public.deals
  for each row execute function private.deals_track_pause();

-- ---------------------------------------------------------------------------
-- deal_accounts: the platform accounts a deal's videos go up on (label only, no OAuth).
-- ---------------------------------------------------------------------------
create table if not exists public.deal_accounts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals (id) on delete cascade,
  platform text not null check (platform in ('INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'FACEBOOK')),
  handle text not null check (length(handle) between 1 and 100 and handle = lower(handle)),
  created_at timestamptz not null default now(),
  constraint deal_accounts_handle_key unique (deal_id, platform, handle),
  constraint deal_accounts_id_deal_key unique (id, deal_id)
);

-- ---------------------------------------------------------------------------
-- posts: one row per post URL. Rate snapshot columns are copied from the deal at insert, so a later
-- rate edit never reprices an old video. Posts sharing video_group_id are one video, paid once.
-- ---------------------------------------------------------------------------
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals (id) on delete cascade,
  account_id uuid,
  platform text not null check (platform in ('INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'FACEBOOK')),
  url text not null check (url ~ '^https://[^\s]+$' and length(url) <= 2000), -- normalized by the app
  title text check (length(title) <= 500),
  posted_at timestamptz not null,
  video_group_id text check (length(video_group_id) between 1 and 200),
  exclude_from_pay boolean not null default false, -- owner only (trigger below)
  manual_override_cents bigint check (manual_override_cents >= 0), -- owner only (trigger below)
  base_pay_cents_snap bigint,
  base_min_views_snap integer,
  view_bonuses_snap jsonb,
  view_bonus_mode_snap text,
  cpm_rate_snap numeric(12, 4),
  cpm_view_unit_snap integer,
  cpm_cap_views_snap integer,
  cpm_min_views_snap integer,
  cpm_tiers_snap jsonb,
  cpm_mode_snap text,
  cpm_tier_mode_snap text,
  source text not null default 'hydra' check (source in ('hydra', 'grokbot', 'ripple')),
  source_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint posts_url_key unique (url),
  constraint posts_source_key unique (source, source_id),
  -- The account must belong to the post's own deal.
  constraint posts_account_fkey foreign key (account_id, deal_id)
    references public.deal_accounts (id, deal_id) on delete set null (account_id)
);

create index if not exists posts_deal_posted_idx on public.posts (deal_id, posted_at);
create index if not exists posts_posted_idx on public.posts (posted_at);
create index if not exists posts_deal_group_idx on public.posts (deal_id, video_group_id) where video_group_id is not null;
create index if not exists posts_account_idx on public.posts (account_id) where account_id is not null;

-- The Ripple import exemption covers ANY source='ripple' post INSERT from a session whose role is a
-- member of postgres: the import (private.ripple_import_apply, 0011, which no API role can execute),
-- but also Studio, pg-meta and any job run as the database owner. Such an insert keeps the rate
-- snapshot, exclude flag and manual override it carries. The hosted CLI's cli_login_postgres is a
-- member. The test is on the session's outer role (the SET ROLE in force, else the login role), not
-- current_user, so a security definer function owned by postgres that an API role calls cannot pass
-- it. service_role (the Grokbot key), authenticated and anon are not members, and the source guard
-- below stops them from writing source='ripple' rows at all.

-- Source guard: only a postgres-member session may insert a source='ripple' row or change a row's
-- source to or from 'ripple' (TG_ARGV[0] = 'to_only': only to). So a row labelled 'ripple' was
-- written by the import (or by the database owner), never planted by an API key for the import to
-- adopt. post_view_snapshots uses 'to_only': Grokbot's set-views upsert may replace a Ripple
-- reading of the same day with its own (source becomes 'grokbot').
create or replace function private.guard_ripple_source()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if ((tg_op = 'INSERT' and new.source = 'ripple')
      or (tg_op = 'UPDATE' and new.source is distinct from old.source
          and (new.source = 'ripple' or (old.source = 'ripple' and coalesce(tg_argv[0], '') <> 'to_only'))))
     and not pg_has_role(coalesce(nullif(current_setting('role'), 'none'), session_user), 'postgres', 'member') then
    raise exception 'only the Ripple import (database owner role) writes source=ripple rows on %', tg_table_name
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function private.guard_ripple_source() from public;

drop trigger if exists deals_guard_ripple_source on public.deals;
create trigger deals_guard_ripple_source
  before insert or update of source on public.deals
  for each row execute function private.guard_ripple_source();
drop trigger if exists posts_guard_ripple_source on public.posts;
create trigger posts_guard_ripple_source
  before insert or update of source on public.posts
  for each row execute function private.guard_ripple_source();

-- Rate snapshot. Insert: copy the deal's current rates. Update: the snapshot is frozen, unless the
-- post moves to another deal, which re-snapshots. A Ripple import insert keeps the snapshot it
-- carries (a null snapshot falls back to the deal's rate in the pay math).
create or replace function private.posts_snapshot_rates()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  d public.deals%rowtype;
begin
  if tg_op = 'INSERT' and new.source = 'ripple'
     and pg_has_role(coalesce(nullif(current_setting('role'), 'none'), session_user), 'postgres', 'member') then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.deal_id is not distinct from old.deal_id then
    new.base_pay_cents_snap := old.base_pay_cents_snap;
    new.base_min_views_snap := old.base_min_views_snap;
    new.view_bonuses_snap := old.view_bonuses_snap;
    new.view_bonus_mode_snap := old.view_bonus_mode_snap;
    new.cpm_rate_snap := old.cpm_rate_snap;
    new.cpm_view_unit_snap := old.cpm_view_unit_snap;
    new.cpm_cap_views_snap := old.cpm_cap_views_snap;
    new.cpm_min_views_snap := old.cpm_min_views_snap;
    new.cpm_tiers_snap := old.cpm_tiers_snap;
    new.cpm_mode_snap := old.cpm_mode_snap;
    new.cpm_tier_mode_snap := old.cpm_tier_mode_snap;
    return new;
  end if;
  select * into d from public.deals where id = new.deal_id;
  if not found then
    return new; -- the foreign key (or RLS) rejects the row
  end if;
  new.base_pay_cents_snap := d.base_pay_cents;
  new.base_min_views_snap := d.base_min_views;
  new.view_bonuses_snap := d.view_bonuses;
  new.view_bonus_mode_snap := d.view_bonus_mode;
  new.cpm_rate_snap := d.cpm_rate;
  new.cpm_view_unit_snap := d.cpm_view_unit;
  new.cpm_cap_views_snap := d.cpm_cap_views;
  new.cpm_min_views_snap := d.cpm_min_views;
  new.cpm_tiers_snap := d.cpm_tiers;
  new.cpm_mode_snap := d.cpm_mode;
  new.cpm_tier_mode_snap := d.cpm_tier_mode;
  return new;
end;
$$;
revoke execute on function private.posts_snapshot_rates() from public;

drop trigger if exists posts_snapshot_rates on public.posts;
create trigger posts_snapshot_rates
  before insert or update on public.posts
  for each row execute function private.posts_snapshot_rates();

-- Only the owner excludes a video from pay or sets a manual override. The Grokbot key (service
-- role, no owner session) cannot. A Ripple import insert by the database owner role may carry both
-- (see the exemption above). Security definer so is_owner() runs for any caller; auth.uid() still
-- reads the caller's JWT, and the 'role' setting still names the caller's role.
create or replace function private.posts_guard_exclude()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and (new.exclude_from_pay or new.manual_override_cents is not null))
     or (tg_op = 'UPDATE' and (new.exclude_from_pay is distinct from old.exclude_from_pay
                               or new.manual_override_cents is distinct from old.manual_override_cents)) then
    if not (
      public.is_owner()
      or (tg_op = 'INSERT' and new.source = 'ripple'
          and pg_has_role(coalesce(nullif(current_setting('role'), 'none'), session_user), 'postgres', 'member'))
    ) then
      raise exception 'only the owner can exclude a video from pay or override its pay' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function private.posts_guard_exclude() from public;

drop trigger if exists posts_guard_exclude on public.posts;
create trigger posts_guard_exclude
  before insert or update of exclude_from_pay, manual_override_cents on public.posts
  for each row execute function private.posts_guard_exclude();

drop trigger if exists posts_touch_updated_at on public.posts;
create trigger posts_touch_updated_at
  before update on public.posts
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- post_view_snapshots: one reading per post per owner-zone day. A held reading (a jump over the
-- set multiple) is stored but not paid until the owner forces it.
-- ---------------------------------------------------------------------------
create table if not exists public.post_view_snapshots (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  captured_day date not null,
  captured_at timestamptz not null default now(),
  views bigint not null check (views >= 0),
  likes bigint check (likes >= 0),
  comments bigint check (comments >= 0),
  held boolean not null default false,
  source text not null default 'hydra' check (source in ('hydra', 'grokbot', 'ripple')),
  constraint post_view_snapshots_day_key unique (post_id, captured_day)
);

drop trigger if exists post_view_snapshots_guard_ripple_source on public.post_view_snapshots;
create trigger post_view_snapshots_guard_ripple_source
  before insert or update of source on public.post_view_snapshots
  for each row execute function private.guard_ripple_source('to_only');

-- ---------------------------------------------------------------------------
-- deal_payments: a bank deposit matched to a deal. One transaction links to one deal.
-- transaction_id is a plain uuid here; the bank layer (0020) owns transactions and adds the
-- foreign key that ties it (id, amount, date) to the real transaction.
-- ---------------------------------------------------------------------------
create table if not exists public.deal_payments (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals (id) on delete cascade,
  transaction_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  paid_on date not null,
  created_at timestamptz not null default now(),
  constraint deal_payments_transaction_key unique (transaction_id)
);
create index if not exists deal_payments_deal_idx on public.deal_payments (deal_id, paid_on);

-- ---------------------------------------------------------------------------
-- day_targets: a per-day override of a deal's posting target. 0 = a day off (no missed money).
-- ---------------------------------------------------------------------------
create table if not exists public.day_targets (
  deal_id uuid not null references public.deals (id) on delete cascade,
  day date not null,
  target integer not null check (target between 0 and 30),
  updated_at timestamptz not null default now(),
  primary key (deal_id, day)
);
create index if not exists day_targets_day_idx on public.day_targets (day);

drop trigger if exists day_targets_touch_updated_at on public.day_targets;
create trigger day_targets_touch_updated_at
  before update on public.day_targets
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- ugc_post_views: per post, the payable views (latest trusted reading captured inside the freeze
-- window: posted_at + freeze days of exactly 24 h, default 14; src/lib/ugc/view-freeze.ts) and the
-- latest reading of any kind. security_invoker: the caller's RLS applies.
-- ---------------------------------------------------------------------------
create or replace view public.ugc_post_views
with (security_invoker = true)
as
select
  p.id as post_id,
  p.deal_id,
  (
    select s.views
    from public.post_view_snapshots s
    where s.post_id = p.id
      and not s.held
      and s.captured_at <= p.posted_at + make_interval(hours => 24 * coalesce(d.view_freeze_days, 14))
    order by s.captured_at desc
    limit 1
  ) as payable_views,
  latest.views as latest_views,
  latest.captured_at as last_captured_at,
  latest.captured_day as last_captured_day,
  coalesce(latest.held, false) as latest_held
from public.posts p
join public.deals d on d.id = p.deal_id
left join lateral (
  select s.views, s.captured_at, s.captured_day, s.held
  from public.post_view_snapshots s
  where s.post_id = p.id
  order by s.captured_day desc, s.captured_at desc
  limit 1
) latest on true;

-- The last trusted (not held) reading per post captured at or before p_at: the baseline the
-- set-views guard compares a new reading with. Caller's rights, so RLS applies.
create or replace function public.ugc_last_trusted_views(p_post_ids uuid[], p_at timestamptz)
returns table (post_id uuid, views bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct on (s.post_id) s.post_id, s.views
  from public.post_view_snapshots s
  where s.post_id = any (p_post_ids) and not s.held and s.captured_at <= p_at
  order by s.post_id, s.captured_at desc;
$$;
revoke execute on function public.ugc_last_trusted_views(uuid[], timestamptz) from public, anon;
grant execute on function public.ugc_last_trusted_views(uuid[], timestamptz) to authenticated, service_role, hydra_ro;

-- ---------------------------------------------------------------------------
-- RLS: owner only; hydra_ro reads. Grants are explicit (default privileges are revoked).
-- ---------------------------------------------------------------------------
alter table public.deals enable row level security;
alter table public.deal_accounts enable row level security;
alter table public.posts enable row level security;
alter table public.post_view_snapshots enable row level security;
alter table public.deal_payments enable row level security;
alter table public.day_targets enable row level security;

revoke all on public.deals, public.deal_accounts, public.posts, public.post_view_snapshots,
  public.deal_payments, public.day_targets, public.ugc_post_views from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.deals, public.deal_accounts, public.posts,
  public.post_view_snapshots, public.deal_payments, public.day_targets to authenticated;
grant select on public.ugc_post_views to authenticated;
-- service_role (the Grokbot key, src/app/api/ugc/v1) gets exactly what Grokbot does: read deals,
-- upsert accounts, add posts and update only their account, group and title (lib/ugc/writes.ts
-- addPost), upsert view readings. No deletes, no deal edits, no moving a post to another deal, no
-- edits to a post's URL, date or pay fields.
grant select on public.deals, public.deal_accounts, public.posts, public.post_view_snapshots,
  public.deal_payments, public.day_targets, public.ugc_post_views to service_role;
grant insert, update on public.deal_accounts, public.post_view_snapshots to service_role;
grant insert on public.posts to service_role;
grant update (account_id, video_group_id, title) on public.posts to service_role;
grant select on public.deals, public.deal_accounts, public.posts, public.post_view_snapshots,
  public.deal_payments, public.day_targets, public.ugc_post_views to hydra_ro;

do $$
declare
  t text;
begin
  foreach t in array array['deals', 'deal_accounts', 'posts', 'post_view_snapshots', 'deal_payments', 'day_targets']
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
