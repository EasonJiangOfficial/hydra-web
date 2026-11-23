-- pgTAP: Planning (0040). Owner-only RLS, seeds, repeat series, alert claim, property values.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(65);

-- Fixtures: an owner and a stranger. Start ownerless (a bootstrapped owner comes back on rollback).
delete from private.app_owner;
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'stranger@example.test');
select is(public.bootstrap_owner('11111111-1111-1111-1111-111111111111'), 'created', 'bootstrap creates the owner');

-- Seeds.
select results_eq(
  $$ select label, is_done from public.planning_statuses order by position $$,
  $$ values ('Not started', false), ('In progress', false), ('Blocked', false), ('Done', true) $$,
  'four statuses are seeded, only Done is done'
);
select is((select color from public.planning_statuses where label = 'Blocked'), '#6e6e73',
  'Blocked is seeded gray: red is for money lost or overdue only');
select results_eq(
  $$ select p.name, array_agg(o.label order by o.position) from public.planning_properties p
     join public.planning_property_options o on o.property_id = p.id group by p.name $$,
  $$ values ('Priority', array['Urgent', 'High', 'Medium', 'Low']) $$,
  'Priority is seeded with its four options in order'
);

-- RLS everywhere (also covers 0001's tables).
select is(
  (select count(*)::int from pg_tables where schemaname in ('public', 'private') and not rowsecurity),
  0, 'RLS is enabled on every table'
);

-- Fixture rows, written as the postgres superuser (bypasses RLS).
insert into public.planning_goals (id, title, category) values ('a0000000-0000-0000-0000-000000000001', 'Post 3 a day', 'UGC');
insert into public.planning_tasks (id, title, status_id, goal_id, due_date, position, alert_at)
select 'b0000000-0000-0000-0000-000000000001', 'Film hooks', s.id, 'a0000000-0000-0000-0000-000000000001',
  '2026-11-24', 1024, '2026-11-24 14:00+00'
from public.planning_statuses s where s.label = 'Not started';
insert into public.events (id, title, starts_at, repeat) values
  ('c0000000-0000-0000-0000-000000000001', 'Standup', '2026-11-23 15:00+00', 'weekdays');

-- Anon: no grants at all.
set local role anon;
select throws_ok($$ select * from public.planning_tasks $$, '42501', null, 'anon cannot read tasks');
select throws_ok($$ select * from public.events $$, '42501', null, 'anon cannot read events');
select throws_ok($$ select public.planning_claim_alert('task', 'b0000000-0000-0000-0000-000000000001', '2026-11-24') $$,
  '42501', null, 'anon cannot claim an alert');
reset role;

-- Stranger: zero rows, no writes.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.planning_tasks), 0, 'stranger sees zero tasks');
select is((select count(*)::int from public.events), 0, 'stranger sees zero events');
select is((select count(*)::int from public.planning_statuses), 0, 'stranger sees zero statuses');
select throws_ok(
  $$ insert into public.planning_goals (title) values ('x') $$,
  '42501', null, 'stranger cannot insert goals'
);
update public.planning_tasks set title = 'pwned';
select throws_ok(
  $$ select public.planning_claim_alert('task', 'b0000000-0000-0000-0000-000000000001', '2026-11-24') $$,
  '42501', null, 'stranger cannot claim an alert'
);
select throws_ok(
  $$ select * from public.planning_set_task_positions('[]'::jsonb) $$,
  '42501', null, 'stranger cannot move tasks'
);
reset role;
select is((select title from public.planning_tasks), 'Film hooks', 'stranger update changed nothing');

-- Owner: full access. Everything below runs as the owner unless it says reset role.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select count(*)::int from public.planning_statuses), 4, 'owner sees the statuses');

-- completed_at follows the status, whatever the client sends.
update public.planning_tasks set status_id = (select id from public.planning_statuses where is_done), completed_at = null
where id = 'b0000000-0000-0000-0000-000000000001';
select isnt((select completed_at from public.planning_tasks where id = 'b0000000-0000-0000-0000-000000000001'), null,
  'moving to a done status sets completed_at');
update public.planning_tasks set status_id = (select id from public.planning_statuses where label = 'In progress')
where id = 'b0000000-0000-0000-0000-000000000001';
select is((select completed_at from public.planning_tasks where id = 'b0000000-0000-0000-0000-000000000001'), null,
  'moving out of done clears completed_at');

-- Repeat: a rule needs a due date; the first rule starts the series; a client cannot forge the series.
select throws_ok(
  $$ update public.planning_tasks set repeat_rule = 'weekly', due_date = null where id = 'b0000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'a repeating task needs a due date'
);
select throws_ok(
  $$ update public.planning_tasks set repeat_rule = 'yearly' where id = 'b0000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'an unknown repeat rule is refused'
);
update public.planning_tasks set repeat_rule = 'weekly', repeat_series_id = 'd0000000-0000-0000-0000-000000000009'
where id = 'b0000000-0000-0000-0000-000000000001';
select results_eq(
  $$ select repeat_series_id, repeat_period, repeat_anchor_day::int from public.planning_tasks where id = 'b0000000-0000-0000-0000-000000000001' $$,
  $$ values ('b0000000-0000-0000-0000-000000000001'::uuid, '2026-11-24'::date, 24) $$,
  'the first rule starts the series on its own id and due date (a forged series id is ignored)'
);

-- Property value on the task, so the copy can carry it.
insert into public.planning_task_values (task_id, property_id, option_ids)
select 'b0000000-0000-0000-0000-000000000001', p.id, array[o.id]
from public.planning_properties p join public.planning_property_options o on o.property_id = p.id
where p.name = 'Priority' and o.label = 'High';
select is((select count(*)::int from public.planning_task_values), 1, 'owner sets a select value');
select throws_ok(
  $$ insert into public.planning_task_values (task_id, property_id, text_value)
     select 'b0000000-0000-0000-0000-000000000001', id, 'x' from public.planning_properties where name = 'Priority' $$,
  'P0001', 'planning: bad property value', 'a text value on a select property is refused'
);
select throws_ok(
  $$ insert into public.planning_properties (name, type) values ('priority', 'text') $$,
  '23505', null, 'property names are unique ignoring case'
);

-- The cron's functions are service-role only.
select throws_ok(
  $$ select public.planning_repeat_copy('b0000000-0000-0000-0000-000000000001', '2026-12-01') $$,
  '42501', null, 'the owner cannot call planning_repeat_copy'
);
select throws_ok($$ select * from public.planning_repeat_series() $$, '42501', null, 'the owner cannot call planning_repeat_series');
reset role;

-- Cron: one copy per period; an alert shifts with it; property values come along.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select isnt(
  public.planning_repeat_copy('b0000000-0000-0000-0000-000000000001', '2026-12-01', '2026-12-01 14:00+00'), null,
  'a repeat copy is made for the next period'
);
select is(
  public.planning_repeat_copy('b0000000-0000-0000-0000-000000000001', '2026-12-01', '2026-12-01 14:00+00'), null,
  'the same period is never copied twice'
);
select results_eq(
  $$ select t.due_date, t.alert_at, t.repeat_series_id, s.is_done, t.title from public.planning_tasks t
     join public.planning_statuses s on s.id = t.status_id
     where t.due_date = '2026-12-01' $$,
  $$ values ('2026-12-01'::date, '2026-12-01 14:00+00'::timestamptz, 'b0000000-0000-0000-0000-000000000001'::uuid, false, 'Film hooks') $$,
  'the copy keeps the series, shifts the alert and starts not done'
);
select is(
  (select count(*)::int from public.planning_task_values v join public.planning_tasks t on t.id = v.task_id where t.due_date = '2026-12-01'),
  1, 'the copy carries the property value'
);
select results_eq(
  $$ select series_id, latest_period, rule from public.planning_repeat_series() $$,
  $$ values ('b0000000-0000-0000-0000-000000000001'::uuid, '2026-12-01'::date, 'weekly') $$,
  'the series list shows the latest copy'
);
reset role;

-- Deleting the latest copy turns the series off (the cron never recreates it).
delete from public.planning_tasks where due_date = '2026-12-01';
select is(
  (select count(*)::int from public.planning_repeat_series()), 0,
  'deleting the latest copy ends the series'
);
select is(
  (select repeat_rule from public.planning_tasks where id = 'b0000000-0000-0000-0000-000000000001'), null,
  'the previous copy no longer repeats'
);

-- Alert claim: one winner per occurrence; a moved alert re-arms.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(public.planning_claim_alert('task', 'b0000000-0000-0000-0000-000000000001', '2026-11-24'), true, 'first claim wins');
select is(public.planning_claim_alert('task', 'b0000000-0000-0000-0000-000000000001', '2026-11-24'), false, 'a second claim of the same occurrence loses');
select is(public.planning_claim_alert('task', 'b0000000-0000-0000-0000-000000000001', '2026-11-25'), true, 'another occurrence is its own claim');
select is(public.planning_claim_alert('event', 'c0000000-0000-0000-0000-000000000001', '2026-11-24'), true, 'an event occurrence is claimed too');
select throws_ok(
  $$ select public.planning_claim_alert('task', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '2026-11-24') $$,
  'P0001', 'planning: unknown item', 'claiming an unknown item raises'
);
select throws_ok(
  $$ select public.planning_claim_alert('habit', 'b0000000-0000-0000-0000-000000000001', '2026-11-24') $$,
  'P0001', 'planning: bad alert kind', 'claiming an unknown kind raises'
);
update public.planning_tasks set alert_at = '2026-11-24 16:00+00' where id = 'b0000000-0000-0000-0000-000000000001';
select is(public.planning_claim_alert('task', 'b0000000-0000-0000-0000-000000000001', '2026-11-24'), true, 'moving the alert re-arms it');
select is(
  (select count(*)::int from public.planning_alert_fires where kind = 'task'), 1,
  'a moved alert cleared its old markers'
);

-- An update that writes the same timing (a Google pull of a title edit) keeps the fired markers.
update public.planning_tasks set title = 'Film hooks v2', due_date = due_date, alert_at = alert_at
where id = 'b0000000-0000-0000-0000-000000000001';
select is(public.planning_claim_alert('task', 'b0000000-0000-0000-0000-000000000001', '2026-11-24'), false,
  'a same-value write to due_date and alert_at does not re-arm a fired task alert');
update public.events set title = 'Standup v2', starts_at = starts_at, repeat = repeat, alert_at = alert_at
where id = 'c0000000-0000-0000-0000-000000000001';
select is(public.planning_claim_alert('event', 'c0000000-0000-0000-0000-000000000001', '2026-11-24'), false,
  'a same-value write to starts_at, repeat and alert_at does not re-arm a fired event alert');

-- Adding or clearing a due date leaves the alert as it was, so a fired alert stays fired.
insert into public.planning_tasks (id, title, status_id, position, alert_at)
select 'b0000000-0000-0000-0000-000000000008', 'Call mom', s.id, 3072, '2026-11-21 14:00+00'
from public.planning_statuses s where s.label = 'Not started';
select is(public.planning_claim_alert('task', 'b0000000-0000-0000-0000-000000000008', '2026-11-21'), true,
  'an undated task alert fires on its own day');
update public.planning_tasks set due_date = '2026-11-27' where id = 'b0000000-0000-0000-0000-000000000008';
select is(public.planning_claim_alert('task', 'b0000000-0000-0000-0000-000000000008', '2026-11-21'), false,
  'adding a due date does not re-arm a fired alert');
update public.planning_tasks set due_date = null where id = 'b0000000-0000-0000-0000-000000000008';
select is(public.planning_claim_alert('task', 'b0000000-0000-0000-0000-000000000008', '2026-11-21'), false,
  'clearing a due date does not re-arm a fired alert');
delete from public.planning_tasks where id = 'b0000000-0000-0000-0000-000000000008';

-- A move that leaves the alert alone takes the alert with it (DST: 09:00 stays 09:00 in Toronto).
insert into public.planning_tasks (id, title, status_id, due_date, position, alert_at)
select 'b0000000-0000-0000-0000-000000000009', 'Send W-9', s.id, '2026-10-31', 2048, '2026-10-31 13:00+00'
from public.planning_statuses s where s.label = 'Not started';
update public.planning_tasks set due_date = '2026-11-07' where id = 'b0000000-0000-0000-0000-000000000009';
select is((select alert_at from public.planning_tasks where id = 'b0000000-0000-0000-0000-000000000009'),
  '2026-11-07 14:00+00'::timestamptz, 'a task moved across DST keeps its 09:00 alert');
update public.planning_tasks set due_date = '2026-11-08', alert_at = '2026-11-08 20:00+00' where id = 'b0000000-0000-0000-0000-000000000009';
select is((select alert_at from public.planning_tasks where id = 'b0000000-0000-0000-0000-000000000009'),
  '2026-11-08 20:00+00'::timestamptz, 'a write that sets the alert itself wins');
update public.events set alert_at = '2026-11-23 14:50+00' where id = 'c0000000-0000-0000-0000-000000000001';
update public.events set starts_at = '2026-11-24 15:00+00' where id = 'c0000000-0000-0000-0000-000000000001';
select is((select alert_at from public.events where id = 'c0000000-0000-0000-0000-000000000001'),
  '2026-11-24 14:50+00'::timestamptz, 'an event moved without its alert keeps the 10 minute lead');
update public.events set starts_at = '2026-11-23 15:00+00', alert_at = null where id = 'c0000000-0000-0000-0000-000000000001';
delete from public.planning_tasks where id = 'b0000000-0000-0000-0000-000000000009';

-- The cron claims as service_role: one winner per occurrence there too.
reset role;
set local role service_role;
select is(public.planning_claim_alert('task', 'b0000000-0000-0000-0000-000000000001', '2026-11-30'), true,
  'service_role (the cron) can claim an alert');
select is(public.planning_claim_alert('task', 'b0000000-0000-0000-0000-000000000001', '2026-11-30'), false,
  'a second service_role claim of the same occurrence loses');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

-- Events.
select throws_ok(
  $$ insert into public.events (title, starts_at, ends_at) values ('x', '2026-11-24 10:00+00', '2026-11-24 09:00+00') $$,
  '23514', null, 'an event cannot end before it starts'
);
select throws_ok(
  $$ insert into public.events (title, starts_at, repeat) values ('x', now(), 'hourly') $$,
  '23514', null, 'an unknown event repeat is refused'
);
update public.events set google_event_id = 'g1' where id = 'c0000000-0000-0000-0000-000000000001';
select throws_ok(
  $$ insert into public.events (title, starts_at, google_event_id) values ('y', now(), 'g1') $$,
  '23505', null, 'a Google event id links one event'
);

-- Goal metrics: the category belongs to category_spend only; savings rate is a percent.
select throws_ok(
  $$ insert into public.planning_goal_metrics (goal_id, metric, target) values ('a0000000-0000-0000-0000-000000000001', 'category_spend', 100) $$,
  '23514', null, 'category_spend needs a category'
);
select throws_ok(
  $$ insert into public.planning_goal_metrics (goal_id, metric, target, param) values ('a0000000-0000-0000-0000-000000000001', 'net_worth', 100, 'Food') $$,
  '23514', null, 'only category_spend takes a category'
);
select throws_ok(
  $$ insert into public.planning_goal_metrics (goal_id, metric, target) values ('a0000000-0000-0000-0000-000000000001', 'savings_rate', 150) $$,
  '23514', null, 'savings rate target is at most 100'
);
insert into public.planning_goal_metrics (goal_id, metric, target) values ('a0000000-0000-0000-0000-000000000001', 'posts_per_day', 3);
select throws_ok(
  $$ insert into public.planning_goal_metrics (goal_id, metric, target) values ('a0000000-0000-0000-0000-000000000001', 'posts_per_day', 4) $$,
  '23505', null, 'one row per goal and metric'
);

-- Task moves are one atomic write; an unknown id changes nothing.
select throws_ok(
  $$ select * from public.planning_set_task_positions(
       '[{"id":"b0000000-0000-0000-0000-000000000001","position":5},{"id":"ffffffff-ffff-ffff-ffff-ffffffffffff","position":6}]'::jsonb) $$,
  'P0001', 'planning: unknown task', 'a move with an unknown id raises'
);
select is((select position from public.planning_tasks where id = 'b0000000-0000-0000-0000-000000000001'), 1024::double precision,
  'and moves nothing');

-- Deleting an option strips it from values; a value left with none is deleted.
delete from public.planning_property_options where label = 'High';
select is((select count(*)::int from public.planning_task_values), 0, 'deleting an option clears the values that used it');
reset role;

-- Deleting a task removes its alert markers.
delete from public.planning_tasks where id = 'b0000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.planning_alert_fires where kind = 'task'), 0, 'deleting a task removes its alert markers');

-- hydra_ro: reads, cannot write (as 0001: switch role, then record outcomes in a temp table).
grant hydra_ro to postgres with set true;
create temp table ro_out (k text primary key, v text) on commit drop;
grant all on ro_out to hydra_ro;
set local role hydra_ro;
insert into ro_out select 'statuses', count(*)::text from public.planning_statuses;
insert into ro_out select 'events', count(*)::text from public.events;
do $$
begin
  update public.events set title = 'x';
  insert into ro_out values ('write', 'allowed');
exception when others then
  insert into ro_out values ('write', sqlstate);
end;
$$;
reset role;
select is((select v from ro_out where k = 'statuses'), '4', 'hydra_ro reads statuses');
select is((select v from ro_out where k = 'events'), '1', 'hydra_ro reads events');
select is((select v from ro_out where k = 'write'), '42501', 'hydra_ro cannot write events');

select * from finish();
rollback;
