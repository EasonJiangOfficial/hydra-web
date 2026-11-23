-- Hydra 0040: Planning core (DESIGN.md sections 6.2, 6.9 and 10). Ported from UGM and trimmed:
-- no assignees, people, leads, creators, content goals, SMS, Discord, staff schedules or realtime.
-- Owner-only RLS on every table, explicit grants (0001 revokes the defaults), hydra_ro read policy.
-- Plain SQL, safe to re-run.
--
-- Tasks: status (board column), goal, category, due date, alert_at, repeat. A repeating task is a
-- series of copies, one per period (UGM model): each copy has its own due date, alert_at and fired
-- marker, so a reminder is a Planning task and fires once per occurrence. The cron that extends
-- series calls planning_repeat_series() and planning_repeat_copy() (service role).
-- Events: one table, repeat and alert_at too. A repeating event is ONE row; occurrences are computed
-- by the app, so its fired markers live in planning_alert_fires (one row per occurrence).
-- Delivery of an alert is U13's job: it claims an occurrence with planning_claim_alert(), which is
-- true for exactly one caller per occurrence (unique key), so a cron overlap never delivers twice.
-- Time zone: all day math uses settings.time_zone (America/Toronto until the first login writes it).

-- ---------------------------------------------------------------------------
-- Statuses (board columns). color is a dot color from the Planning wireframe (grays, ink, red).
-- ---------------------------------------------------------------------------
create table if not exists public.planning_statuses (
  id         uuid primary key default gen_random_uuid(),
  label      text not null check (char_length(btrim(label)) between 1 and 60),
  color      text not null check (color ~* '^#[0-9a-f]{6}$'),
  position   integer not null default 0,
  is_done    boolean not null default false,
  created_at timestamptz not null default now()
);

-- Seed only an empty table, so a rerun never re-adds statuses the owner deleted.
insert into public.planning_statuses (label, color, position, is_done)
select v.label, v.color, v.position, v.is_done
from (values
  ('Not started', '#c7c7cc', 0, false),
  ('In progress', '#1d1d1f', 1, false),
  ('Blocked',     '#6e6e73', 2, false),
  ('Done',        '#8e8e93', 3, true)
) as v(label, color, position, is_done)
where not exists (select 1 from public.planning_statuses);
-- Red is for money lost or overdue only (DESIGN 7): an earlier seed's red Blocked goes gray.
update public.planning_statuses set color = '#6e6e73' where label = 'Blocked' and color = '#b3261e';

-- ---------------------------------------------------------------------------
-- Goals, their metrics (live values come from the app's metric registry, never stored) and links.
-- ---------------------------------------------------------------------------
create table if not exists public.planning_goals (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(btrim(title)) between 1 and 200),
  notes       text not null default '' check (char_length(notes) <= 20000),
  category    text check (category is null or char_length(btrim(category)) between 1 and 60),
  start_date  date,
  deadline    date,
  position    double precision not null default 0,
  achieved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint planning_goals_start_date_check check (start_date is null or deadline is null or start_date <= deadline)
);
create index if not exists planning_goals_position_idx on public.planning_goals (position);

create table if not exists public.planning_goal_metrics (
  id         uuid primary key default gen_random_uuid(),
  goal_id    uuid not null references public.planning_goals (id) on delete cascade,
  metric     text not null,
  target     numeric not null check (target > 0 and target <= 1e11),
  -- category_spend names its category here; every other metric has none.
  param      text check (param is null or char_length(btrim(param)) between 1 and 60),
  position   double precision not null default 0,
  created_at timestamptz not null default now(),
  constraint planning_goal_metrics_percent_check check (metric <> 'savings_rate' or target <= 100),
  constraint planning_goal_metrics_param_rule check ((metric = 'category_spend') = (param is not null))
);
-- The key list is (re)added here, so a second run replaces an older definition.
alter table public.planning_goal_metrics drop constraint if exists planning_goal_metrics_metric_check;
alter table public.planning_goal_metrics add constraint planning_goal_metrics_metric_check check (metric in (
  'net_worth', 'monthly_income', 'ugc_revenue', 'savings_rate', 'category_spend',
  'posts_per_day', 'streak', 'total_views', 'views_per_post', 'task_progress'));
create unique index if not exists planning_goal_metrics_goal_metric_param_key
  on public.planning_goal_metrics (goal_id, metric, coalesce(param, ''));

create table if not exists public.planning_goal_links (
  id         uuid primary key default gen_random_uuid(),
  goal_id    uuid not null references public.planning_goals (id) on delete cascade,
  url        text not null check (url ~* '^https?://[^[:space:]]+$' and char_length(url) <= 2000),
  title      text check (title is null or char_length(btrim(title)) between 1 and 200),
  position   double precision not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists planning_goal_links_goal_id_idx on public.planning_goal_links (goal_id, position);

-- ---------------------------------------------------------------------------
-- Tasks. repeat_* columns are server-owned (planning_tasks_repeat_series below).
-- ---------------------------------------------------------------------------
create table if not exists public.planning_tasks (
  id                uuid primary key default gen_random_uuid(),
  title             text not null check (char_length(btrim(title)) between 1 and 200),
  notes             text not null default '' check (char_length(notes) <= 20000),
  status_id         uuid not null references public.planning_statuses (id) on delete restrict,
  goal_id           uuid references public.planning_goals (id) on delete set null,
  category          text check (category is null or char_length(btrim(category)) between 1 and 60),
  due_date          date,
  -- Order within a status (board column).
  position          double precision not null default 0,
  -- When Hydra tells the owner (DESIGN.md 6.9). Fired once per occurrence: planning_alert_fires.
  alert_at          timestamptz,
  repeat_rule       text,
  repeat_series_id  uuid,
  repeat_period     date,
  repeat_anchor_day smallint,
  repeat_since      date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);
alter table public.planning_tasks drop constraint if exists planning_tasks_repeat_rule_check;
alter table public.planning_tasks add constraint planning_tasks_repeat_rule_check
  check (repeat_rule is null or repeat_rule in ('daily', 'weekdays', 'weekly', 'monthly'));
alter table public.planning_tasks drop constraint if exists planning_tasks_repeat_needs_due;
alter table public.planning_tasks add constraint planning_tasks_repeat_needs_due
  check (repeat_rule is null or due_date is not null);
create index if not exists planning_tasks_status_position_idx on public.planning_tasks (status_id, position);
create index if not exists planning_tasks_goal_id_idx on public.planning_tasks (goal_id);
create index if not exists planning_tasks_alert_idx on public.planning_tasks (alert_at) where alert_at is not null;
-- The idempotency key of a repeat copy.
create unique index if not exists planning_tasks_repeat_series_period_key
  on public.planning_tasks (repeat_series_id, repeat_period) where repeat_series_id is not null;

-- ---------------------------------------------------------------------------
-- Events. google_event_id stays null until the Google Calendar sync (U15) links it.
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  id              uuid primary key default gen_random_uuid(),
  title           text not null check (char_length(btrim(title)) between 1 and 200),
  starts_at       timestamptz not null,
  ends_at         timestamptz,
  all_day         boolean not null default false,
  category        text check (category is null or char_length(btrim(category)) between 1 and 60),
  repeat          text check (repeat is null or repeat in ('daily', 'weekdays', 'weekly', 'monthly')),
  notes           text not null default '' check (char_length(notes) <= 20000),
  alert_at        timestamptz,
  google_event_id text unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint events_end_after_start check (ends_at is null or ends_at >= starts_at)
);
create index if not exists events_starts_at_idx on public.events (starts_at);

-- One row per (task or event, occurrence date) whose alert was claimed.
create table if not exists public.planning_alert_fires (
  kind          text not null check (kind in ('task', 'event')),
  item_id       uuid not null,
  occurrence_on date not null,
  fired_at      timestamptz not null default now(),
  primary key (kind, item_id, occurrence_on)
);

-- ---------------------------------------------------------------------------
-- Task properties (owner-made fields: select, multi-select, number, text, checkbox, date, url).
-- "Empty" is always no row in planning_task_values.
-- ---------------------------------------------------------------------------
create table if not exists public.planning_properties (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  type          text not null check (type in ('select', 'multi_select', 'number', 'text', 'checkbox', 'date', 'url')),
  number_format text not null default 'number' check (number_format in ('number', 'percent', 'dollar')),
  position      integer not null default 0,
  show_on_board boolean not null default true,
  show_in_list  boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists planning_properties_name_key on public.planning_properties (lower(btrim(name)));

create table if not exists public.planning_property_options (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.planning_properties (id) on delete cascade,
  label       text not null check (char_length(btrim(label)) between 1 and 60),
  color       text not null check (color ~* '^#[0-9a-f]{6}$'),
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists planning_property_options_label_key
  on public.planning_property_options (property_id, lower(btrim(label)));

create table if not exists public.planning_task_values (
  task_id      uuid not null references public.planning_tasks (id) on delete cascade,
  property_id  uuid not null references public.planning_properties (id) on delete cascade,
  text_value   text check (char_length(text_value) <= 2000),
  number_value numeric check (number_value is null or abs(number_value) < 1e12),
  date_value   date,
  bool_value   boolean,
  option_ids   uuid[] check (cardinality(option_ids) <= 30),
  updated_at   timestamptz not null default now(),
  primary key (task_id, property_id)
);
create index if not exists planning_task_values_property_id_idx on public.planning_task_values (property_id);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
drop trigger if exists planning_tasks_touch on public.planning_tasks;
create trigger planning_tasks_touch before update on public.planning_tasks
  for each row execute function private.touch_updated_at();
drop trigger if exists planning_goals_touch on public.planning_goals;
create trigger planning_goals_touch before update on public.planning_goals
  for each row execute function private.touch_updated_at();
drop trigger if exists events_touch on public.events;
create trigger events_touch before update on public.events
  for each row execute function private.touch_updated_at();
drop trigger if exists planning_properties_touch on public.planning_properties;
create trigger planning_properties_touch before update on public.planning_properties
  for each row execute function private.touch_updated_at();
drop trigger if exists planning_task_values_touch on public.planning_task_values;
create trigger planning_task_values_touch before update on public.planning_task_values
  for each row execute function private.touch_updated_at();

-- completed_at is computed on every write from the status (a client value never sticks).
create or replace function public.planning_tasks_completed_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.planning_statuses s where s.id = new.status_id and s.is_done) then
    new.completed_at := null;
  elsif tg_op = 'UPDATE'
    and exists (select 1 from public.planning_statuses s where s.id = old.status_id and s.is_done) then
    new.completed_at := coalesce(old.completed_at, now());
  else
    new.completed_at := now();
  end if;
  return new;
end $$;
drop trigger if exists planning_tasks_completed_at on public.planning_tasks;
create trigger planning_tasks_completed_at before insert or update on public.planning_tasks
  for each row execute function public.planning_tasks_completed_at();

create or replace function public.planning_statuses_done_changed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.is_done is distinct from old.is_done then
    update public.planning_tasks t
    set completed_at = case when new.is_done then coalesce(t.completed_at, now()) end
    where t.status_id = new.id;
  end if;
  return null;
end $$;
drop trigger if exists planning_statuses_done_changed on public.planning_statuses;
create trigger planning_statuses_done_changed after update of is_done on public.planning_statuses
  for each row execute function public.planning_statuses_done_changed();

-- The server-owned repeat columns. A signed-in client's values are ignored; the service role
-- (the cron's planning_repeat_copy) keeps its own. Rules, as in UGM:
-- - repeat_series_id: the series' first task, set the first time a rule is set, never changed.
-- - repeat_period: the schedule date a copy stands for. Moving a copy's due date does not move it,
--   so a moved copy never skips or doubles a period. The schedule re-anchors on the due date only
--   when the owner is choosing it (no other copy yet, the period is still ahead, or Repeat is
--   turned back on), and never onto a date at or before another copy's period.
-- - repeat_anchor_day: the monthly day of month (Jan 31 -> Feb 28 -> Mar 31).
-- - repeat_since: the owner's day the rule was last turned on; no late copies before it.
create or replace function public.planning_tasks_repeat_series() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_today date := (now() at time zone coalesce(
    (select s.time_zone from public.settings s limit 1), 'America/Toronto'))::date;
begin
  if tg_op = 'UPDATE' then
    new.repeat_series_id := old.repeat_series_id;
    new.repeat_anchor_day := old.repeat_anchor_day;
    new.repeat_since := old.repeat_since;
    new.repeat_period := old.repeat_period;
    if old.repeat_series_id is not null and new.due_date <> old.repeat_period
      and (old.repeat_period > v_today
        or (new.repeat_rule is not null and old.repeat_rule is null)
        or not exists (select 1 from public.planning_tasks t
          where t.repeat_series_id = old.repeat_series_id and t.id <> old.id))
      and not exists (select 1 from public.planning_tasks t
        where t.repeat_series_id = old.repeat_series_id and t.id <> old.id
          and t.repeat_period >= new.due_date)
    then
      new.repeat_period := new.due_date;
      new.repeat_anchor_day := extract(day from new.due_date);
    end if;
  elsif (select auth.uid()) is not null then
    new.repeat_series_id := null;
    new.repeat_period := null;
    new.repeat_anchor_day := null;
    new.repeat_since := null;
  end if;
  if new.repeat_rule is not null and new.repeat_series_id is null then
    new.repeat_series_id := new.id;
    new.repeat_period := new.due_date;
    new.repeat_anchor_day := extract(day from new.due_date);
    new.repeat_since := v_today;
  elsif tg_op = 'UPDATE' and new.repeat_rule is not null and old.repeat_rule is null then
    new.repeat_since := v_today;
  end if;
  return new;
end $$;
drop trigger if exists planning_tasks_repeat_series on public.planning_tasks;
create trigger planning_tasks_repeat_series before insert or update on public.planning_tasks
  for each row execute function public.planning_tasks_repeat_series();

-- Deletes of tasks run one at a time, so two deletes of a series' two newest copies cannot each see
-- the other as the latest and leave the series on.
-- ponytail: one lock for every task delete (a handful a day); per-series keys if deletes ever queue.
create or replace function public.planning_tasks_repeat_delete_lock() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('public.planning_tasks repeat delete'));
  return null;
end $$;
drop trigger if exists planning_tasks_repeat_delete_lock on public.planning_tasks;
create trigger planning_tasks_repeat_delete_lock before delete on public.planning_tasks
  for each statement execute function public.planning_tasks_repeat_delete_lock();

-- Deleting the latest copy turns the series off, so the cron never recreates the deleted copy.
create or replace function public.planning_tasks_repeat_deleted() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.repeat_series_id is not null and not exists (
    select 1 from public.planning_tasks t
    where t.repeat_series_id = old.repeat_series_id and t.repeat_period > old.repeat_period
  ) then
    update public.planning_tasks t set repeat_rule = null
    where t.repeat_rule is not null and t.id = (
      select l.id from public.planning_tasks l
      where l.repeat_series_id = old.repeat_series_id
      order by l.repeat_period desc nulls last, l.created_at desc, l.id desc limit 1);
  end if;
  return null;
end $$;
drop trigger if exists planning_tasks_repeat_deleted on public.planning_tasks;
create trigger planning_tasks_repeat_deleted after delete on public.planning_tasks
  for each row execute function public.planning_tasks_repeat_deleted();

-- An alert moves with its item when a write moves the item and leaves the alert as it was (a drag
-- on the page, a pull from Google): a task's alert keeps its wall clock time the same number of
-- days from the due date (owner's zone), an event's alert keeps its lead before the start. A write
-- that sets alert_at itself wins.
create or replace function public.planning_alert_follow_move() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_tz text;
begin
  if old.alert_at is null or new.alert_at is distinct from old.alert_at then
    return new;
  end if;
  if tg_table_name = 'events' then
    if new.starts_at is distinct from old.starts_at then
      new.alert_at := old.alert_at + (new.starts_at - old.starts_at);
    end if;
  elsif old.due_date is not null and new.due_date is not null and new.due_date <> old.due_date then
    v_tz := coalesce((select s.time_zone from public.settings s limit 1), 'America/Toronto');
    new.alert_at := ((old.alert_at at time zone v_tz) + make_interval(days => new.due_date - old.due_date)) at time zone v_tz;
  end if;
  return new;
end $$;
drop trigger if exists planning_tasks_alert_follow on public.planning_tasks;
create trigger planning_tasks_alert_follow before update of due_date on public.planning_tasks
  for each row execute function public.planning_alert_follow_move();
drop trigger if exists events_alert_follow on public.events;
create trigger events_alert_follow before update of starts_at on public.events
  for each row execute function public.planning_alert_follow_move();

-- Alert markers follow their item: a moved or re-set alert fires again; a deleted item leaves none.
-- An update that writes the same values (a Google pull of a title edit) keeps them: `update of`
-- fires whenever the column is in the SET list, so the values are compared here.
-- A task has one alert, keyed on the alert's own day: only a change of alert_at re-arms it. A due
-- date move that drags the alert along (planning_alert_follow_move) changes alert_at; adding or
-- clearing a due date leaves it, so a fired alert stays fired. due_date stays in `update of` so a
-- due-date-only write whose alert the follow trigger moved still runs this.
create or replace function public.planning_alert_fires_reset() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_kind text := case tg_table_name when 'events' then 'event' else 'task' end;
begin
  if tg_op = 'DELETE' then
    delete from public.planning_alert_fires where kind = v_kind and item_id = old.id;
    return null;
  end if;
  -- Separate branches: a plpgsql expression naming a column the table lacks fails when planned.
  if new.alert_at is not distinct from old.alert_at then
    if v_kind = 'task' then
      return null;
    elsif new.starts_at is not distinct from old.starts_at and new.repeat is not distinct from old.repeat then
      return null;
    end if;
  end if;
  delete from public.planning_alert_fires where kind = v_kind and item_id = new.id;
  return null;
end $$;
drop trigger if exists planning_tasks_alert_reset on public.planning_tasks;
create trigger planning_tasks_alert_reset after update of alert_at, due_date or delete on public.planning_tasks
  for each row execute function public.planning_alert_fires_reset();
drop trigger if exists events_alert_reset on public.events;
create trigger events_alert_reset after update of alert_at, starts_at, repeat or delete on public.events
  for each row execute function public.planning_alert_fires_reset();

-- Property guards (as UGM): the type is fixed, at most 50 properties and 100 options each, new ones
-- land after the last. Adds are serialized with an advisory lock.
create or replace function public.planning_properties_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.type is distinct from old.type then
      raise exception 'planning: property type is fixed';
    end if;
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('public.planning_properties order'));
  if (select count(*) from public.planning_properties) >= 50 then
    raise exception 'planning: too many properties';
  end if;
  new.position := coalesce((select max(p.position) + 1 from public.planning_properties p), 0);
  return new;
end $$;
drop trigger if exists planning_properties_guard on public.planning_properties;
create trigger planning_properties_guard before insert or update on public.planning_properties
  for each row execute function public.planning_properties_guard();

create or replace function public.planning_property_options_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.property_id := old.property_id;
    new.created_at := old.created_at;
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('public.planning_property_options order ' || new.property_id::text));
  if not exists (
    select 1 from public.planning_properties p
    where p.id = new.property_id and p.type in ('select', 'multi_select')
  ) then
    -- An unknown property is the FK's refusal, not this one.
    if exists (select 1 from public.planning_properties p where p.id = new.property_id) then
      raise exception 'planning: options need a select';
    end if;
    return new;
  end if;
  if (select count(*) from public.planning_property_options o where o.property_id = new.property_id) >= 100 then
    raise exception 'planning: too many options';
  end if;
  new.position := coalesce((
    select max(o.position) + 1 from public.planning_property_options o where o.property_id = new.property_id
  ), 0);
  return new;
end $$;
drop trigger if exists planning_property_options_guard on public.planning_property_options;
create trigger planning_property_options_guard before insert or update on public.planning_property_options
  for each row execute function public.planning_property_options_guard();

-- Exactly the type's column(s) set, with a real value. Option ids must be options of THIS property.
-- Named options are locked (KEY SHARE, id order) so a concurrent option delete cannot pass this check
-- and miss its cleanup.
create or replace function public.planning_task_values_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_type text;
  v_ok boolean;
  v_found integer := 0;
begin
  select p.type into v_type from public.planning_properties p where p.id = new.property_id;
  if v_type is null then
    return new;
  end if;
  if new.option_ids is not null then
    select count(*) into v_found from (
      select 1 from public.planning_property_options po
      where po.id = any(new.option_ids) and po.property_id = new.property_id
      order by po.id for key share
    ) l;
  end if;
  v_ok := case v_type
    when 'select' then cardinality(new.option_ids) = 1
    when 'multi_select' then cardinality(new.option_ids) >= 1
    when 'number' then new.number_value is not null
    when 'text' then btrim(new.text_value) <> ''
    when 'url' then new.text_value ~* '^https?://' and char_length(new.text_value) <= 500
    when 'checkbox' then new.bool_value is true
    when 'date' then new.date_value is not null
  end
    and (new.option_ids is null or v_type in ('select', 'multi_select'))
    and (new.number_value is null or v_type = 'number')
    and (new.text_value is null or v_type in ('text', 'url'))
    and (new.bool_value is null or v_type = 'checkbox')
    and (new.date_value is null or v_type = 'date')
    and coalesce(cardinality(new.option_ids), 0) = (select count(distinct x) from unnest(new.option_ids) x)
    and coalesce(cardinality(new.option_ids), 0) = v_found;
  if not coalesce(v_ok, false) then
    raise exception 'planning: bad property value';
  end if;
  return new;
end $$;
drop trigger if exists planning_task_values_check on public.planning_task_values;
create trigger planning_task_values_check before insert or update on public.planning_task_values
  for each row execute function public.planning_task_values_check();

-- Deleted options leave every value. A value left with none of its options is deleted first, then
-- the rest drop the gone ids in order. One pass per statement.
create or replace function public.planning_property_options_deleted() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_gone uuid[];
begin
  select coalesce(array_agg(g.id), '{}') into v_gone from gone g;
  delete from public.planning_task_values v
  where v.option_ids && v_gone and v.option_ids <@ v_gone;
  update public.planning_task_values v
  set option_ids = array(
    select o.id from unnest(v.option_ids) with ordinality o(id, ord)
    where not (o.id = any(v_gone)) order by o.ord
  )
  where v.option_ids && v_gone;
  return null;
end $$;
drop trigger if exists planning_property_options_deleted on public.planning_property_options;
create trigger planning_property_options_deleted after delete on public.planning_property_options
  referencing old table as gone for each statement execute function public.planning_property_options_deleted();

-- ---------------------------------------------------------------------------
-- RPCs (security invoker: RLS and is_owner() both apply)
-- ---------------------------------------------------------------------------

-- Move tasks: p_items is [{id, position, status_id?}], applied in ONE update. An unknown or repeated
-- id raises and nothing changes; so does anything but a JSON array.
create or replace function public.planning_set_task_positions(p_items jsonb)
returns setof public.planning_tasks language plpgsql security invoker set search_path = '' as $$
declare
  v_count bigint;
begin
  if not (select public.is_owner()) then
    raise exception 'planning: no access' using errcode = '42501';
  end if;
  if coalesce(jsonb_typeof(p_items), '') <> 'array' then
    raise exception 'planning: bad positions';
  end if;
  return query
  update public.planning_tasks t
  set position = i.position, status_id = coalesce(i.status_id, t.status_id)
  from jsonb_to_recordset(p_items) as i(id uuid, position double precision, status_id uuid)
  where t.id = i.id
  returning t.*;
  get diagnostics v_count = row_count;
  if v_count <> jsonb_array_length(p_items) then
    raise exception 'planning: unknown task';
  end if;
end $$;

-- Add a status after the last one (max + 1: a delete leaves a gap). Same lock as delete and reorder.
create or replace function public.planning_create_status(
  p_id uuid, p_label text, p_color text, p_is_done boolean
) returns public.planning_statuses language plpgsql security invoker set search_path = '' as $$
declare
  v_status public.planning_statuses;
begin
  if not (select public.is_owner()) then
    raise exception 'planning: no access' using errcode = '42501';
  end if;
  perform 1 from public.planning_statuses for update;
  insert into public.planning_statuses (id, label, color, is_done, position)
  select p_id, p_label, p_color, p_is_done, coalesce(max(position), -1) + 1
  from public.planning_statuses
  returning * into v_status;
  return v_status;
end $$;

-- position = 0-based index in p_ids, which must be exactly the full set of statuses.
create or replace function public.planning_reorder_statuses(p_ids uuid[])
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if not (select public.is_owner()) then
    raise exception 'planning: no access' using errcode = '42501';
  end if;
  perform 1 from public.planning_statuses for update;
  if coalesce(cardinality(p_ids), 0) <> (select count(*) from public.planning_statuses)
     or exists (select 1 from public.planning_statuses s where not (s.id = any(p_ids))) then
    raise exception 'planning: statuses changed';
  end if;
  update public.planning_statuses s
  set position = o.ord - 1
  from unnest(p_ids) with ordinality as o(id, ord)
  where s.id = o.id;
end $$;

-- Delete a status. Its tasks must move first: p_move_to names the target; they land after the
-- target's last task in their old order. The last status cannot go.
create or replace function public.planning_delete_status(p_status uuid, p_move_to uuid default null)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_base double precision;
begin
  if not (select public.is_owner()) then
    raise exception 'planning: no access' using errcode = '42501';
  end if;
  perform 1 from public.planning_statuses for update;
  if not exists (select 1 from public.planning_statuses where id <> p_status) then
    raise exception 'planning: last status';
  end if;
  if exists (select 1 from public.planning_tasks where status_id = p_status) then
    if p_move_to is null then
      raise exception 'planning: status in use';
    end if;
    if p_move_to = p_status or not exists (select 1 from public.planning_statuses where id = p_move_to) then
      raise exception 'planning: bad move target';
    end if;
    select coalesce(max(position), 0) into v_base from public.planning_tasks where status_id = p_move_to;
    update public.planning_tasks t
    set status_id = p_move_to, position = v_base + 1024 * o.rn
    from (
      select id, row_number() over (order by position, created_at, id) as rn
      from public.planning_tasks where status_id = p_status
    ) o
    where t.id = o.id;
  end if;
  delete from public.planning_statuses where id = p_status;
end $$;

create or replace function public.planning_reorder_properties(p_ids uuid[])
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if not (select public.is_owner()) then
    raise exception 'planning: no access' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('public.planning_properties order'));
  perform 1 from public.planning_properties for update;
  if coalesce(cardinality(p_ids), 0) <> (select count(*) from public.planning_properties)
     or exists (select 1 from public.planning_properties p where not (p.id = any(p_ids))) then
    raise exception 'planning: properties changed';
  end if;
  update public.planning_properties p
  set position = o.ord - 1
  from unnest(p_ids) with ordinality as o(id, ord)
  where p.id = o.id;
end $$;

create or replace function public.planning_reorder_options(p_property uuid, p_ids uuid[])
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if not (select public.is_owner()) then
    raise exception 'planning: no access' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('public.planning_property_options order ' || p_property::text));
  perform 1 from public.planning_property_options where property_id = p_property for update;
  if coalesce(cardinality(p_ids), 0) <> (
       select count(*) from public.planning_property_options where property_id = p_property)
     or exists (
       select 1 from public.planning_property_options o
       where o.property_id = p_property and not (o.id = any(p_ids))) then
    raise exception 'planning: options changed';
  end if;
  update public.planning_property_options o
  set position = n.ord - 1
  from unnest(p_ids) with ordinality as n(id, ord)
  where o.id = n.id and o.property_id = p_property;
end $$;

-- Claim one alert occurrence: true for exactly ONE caller per (kind, item, occurrence date), false
-- for every retry, overlap or second device. The unique key is the compare-and-set: two callers at
-- once block on each other and the second one inserts nothing.
create or replace function public.planning_claim_alert(p_kind text, p_item uuid, p_occurrence date)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_n bigint;
begin
  -- The owner (the pages and the agent) or the service role (the cron that delivers alerts).
  if current_user <> 'service_role' and not (select public.is_owner()) then
    raise exception 'planning: no access' using errcode = '42501';
  end if;
  if p_kind not in ('task', 'event') then
    raise exception 'planning: bad alert kind';
  end if;
  if not exists (
    select 1 from public.planning_tasks where p_kind = 'task' and id = p_item
    union all
    select 1 from public.events where p_kind = 'event' and id = p_item
  ) then
    raise exception 'planning: unknown item';
  end if;
  insert into public.planning_alert_fires (kind, item_id, occurrence_on)
  values (p_kind, p_item, p_occurrence)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- Cron side (service role only). Each series' LATEST copy (max period) with its rule, the series'
-- monthly day and the day the repeat turned on; only series whose latest copy still repeats.
create or replace function public.planning_repeat_series()
returns table (series_id uuid, latest_id uuid, latest_period date, rule text, anchor_day smallint, since date)
language sql stable security invoker set search_path = '' as $$
  select s.series_id, s.latest_id, s.latest_period, s.rule, s.anchor_day, s.since
  from (
    select distinct on (t.repeat_series_id)
      t.repeat_series_id as series_id, t.id as latest_id, t.repeat_period as latest_period,
      t.repeat_rule as rule, t.repeat_anchor_day as anchor_day, t.repeat_since as since
    from public.planning_tasks t
    where t.repeat_series_id is not null and t.repeat_period is not null
    order by t.repeat_series_id, t.repeat_period desc, t.created_at desc, t.id desc
  ) s
  where s.rule is not null
$$;

-- One copy of task p_from for period p_due, in one transaction: status = the first not-done column
-- (at its end), alert_at = p_alert_at (the app shifts it by the same offset), and every property
-- value (option ids that no longer exist are dropped; a value left with none is not copied).
-- Insert-or-ignore on (repeat_series_id, repeat_period): returns the new id, or null when that
-- period already has its copy (or p_from is gone or no longer repeats).
create or replace function public.planning_repeat_copy(p_from uuid, p_due date, p_alert_at timestamptz default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_src public.planning_tasks;
  v_status uuid;
  v_id uuid;
begin
  select * into v_src from public.planning_tasks where id = p_from for update;
  if not found or v_src.repeat_series_id is null or v_src.repeat_rule is null then
    return null;
  end if;
  select s.id into v_status from public.planning_statuses s
  order by s.is_done, s.position, s.created_at, s.id limit 1;
  insert into public.planning_tasks
    (title, notes, status_id, goal_id, category, due_date, position, alert_at,
     repeat_rule, repeat_series_id, repeat_period, repeat_anchor_day, repeat_since)
  values (
    v_src.title, v_src.notes, v_status, v_src.goal_id, v_src.category, p_due,
    coalesce((select max(t.position) from public.planning_tasks t where t.status_id = v_status), 0) + 1024,
    case when v_src.alert_at is null then null else p_alert_at end,
    v_src.repeat_rule, v_src.repeat_series_id, p_due, v_src.repeat_anchor_day, v_src.repeat_since)
  on conflict (repeat_series_id, repeat_period) where repeat_series_id is not null do nothing
  returning id into v_id;
  if v_id is null then
    return null;
  end if;
  insert into public.planning_task_values
    (task_id, property_id, text_value, number_value, date_value, bool_value, option_ids)
  select v_id, v.property_id, v.text_value, v.number_value, v.date_value, v.bool_value,
    case when v.option_ids is null then null else array(
      select u.id from unnest(v.option_ids) with ordinality u(id, ord)
      join public.planning_property_options po on po.id = u.id and po.property_id = v.property_id
      order by u.ord
    ) end
  from public.planning_task_values v
  where v.task_id = p_from
    and (v.option_ids is null or exists (
      select 1 from public.planning_property_options po
      where po.id = any(v.option_ids) and po.property_id = v.property_id));
  return v_id;
end $$;

-- The cron runs as service_role, and Postgres checks EXECUTE on is_owner() when it plans the guard
-- above (the AND does not short-circuit it). is_owner() is false for service_role (no auth.uid()).
grant execute on function public.is_owner() to service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'planning_set_task_positions(jsonb)',
    'planning_create_status(uuid, text, text, boolean)',
    'planning_reorder_statuses(uuid[])',
    'planning_delete_status(uuid, uuid)',
    'planning_reorder_properties(uuid[])',
    'planning_reorder_options(uuid, uuid[])',
    'planning_claim_alert(text, uuid, date)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'planning_repeat_series()',
    'planning_repeat_copy(uuid, date, timestamptz)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS: owner only on every table; explicit grants; hydra_ro reads.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'planning_statuses', 'planning_goals', 'planning_goal_metrics', 'planning_goal_links',
    'planning_tasks', 'events', 'planning_alert_fires',
    'planning_properties', 'planning_property_options', 'planning_task_values'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_select', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.is_owner()))', t || '_owner_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select public.is_owner()))', t || '_owner_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_update', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select public.is_owner())) with check ((select public.is_owner()))', t || '_owner_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_delete', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select public.is_owner()))', t || '_owner_delete', t);
    execute format('drop policy if exists %I on public.%I', t || '_ro_select', t);
    execute format('create policy %I on public.%I for select to hydra_ro using (true)', t || '_ro_select', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to hydra_ro', t);
  end loop;
end $$;

-- Seed Priority (select: Urgent, High, Medium, Low) only when no property is named Priority.
-- Option colors are grays (DESIGN.md section 7: no color), darker means more urgent.
do $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.planning_properties where lower(btrim(name)) = 'priority')
     or (select count(*) from public.planning_properties) >= 50 then
    return;
  end if;
  insert into public.planning_properties (name, type, show_on_board, show_in_list)
  values ('Priority', 'select', true, true)
  returning id into v_id;
  insert into public.planning_property_options (property_id, label, color) values (v_id, 'Urgent', '#1d1d1f');
  insert into public.planning_property_options (property_id, label, color) values (v_id, 'High', '#424245');
  insert into public.planning_property_options (property_id, label, color) values (v_id, 'Medium', '#6e6e73');
  insert into public.planning_property_options (property_id, label, color) values (v_id, 'Low', '#a1a1a6');
end $$;
