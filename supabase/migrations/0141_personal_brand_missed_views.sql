-- Hydra 0141: the missed-view warning (ugc_missed_view_days, 0080) leaves Personal Brand posts out
-- (0140, deals.personal_brand). They are not UGC work, so a skipped reading of one is no UGC gap. The
-- view sync's work list (ugc_posts_needing_views) still reads them. Same signature and grants. Safe to re-run.
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
  join public.deals d on d.id = p.deal_id and not d.personal_brand
  left join public.post_view_snapshots s on s.post_id = p.id and s.captured_day = dy.day
  where dy.day_end <= p.posted_at + make_interval(hours => 24 * coalesce(d.view_freeze_days, 14))
  group by dy.day
  having count(s.id) < count(*)
  order by dy.day;
$$;
revoke execute on function public.ugc_missed_view_days(integer, timestamptz) from public, anon;
grant execute on function public.ugc_missed_view_days(integer, timestamptz) to authenticated, service_role, hydra_ro;
