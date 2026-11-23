-- Hydra 0100: web push subscriptions (U20). One row per browser or installed phone app the owner
-- turned notifications on in. DESIGN.md section 6 item 9 (reminders and routines reach the phone).
-- Plain SQL, safe to re-run.
--
-- The owner reads, adds and removes their own rows. The server job that sends a push uses the
-- service role (src/lib/push/send.ts) and prunes a row when the push service says it is gone.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references private.app_owner (user_id) on delete cascade,
  endpoint text not null check (endpoint ~ '^https://' and length(endpoint) <= 2048),
  p256dh text not null check (length(p256dh) between 1 and 512),
  auth text not null check (length(auth) between 1 and 512),
  user_agent text check (length(user_agent) <= 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (endpoint)
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

drop trigger if exists push_subscriptions_touch_updated_at on public.push_subscriptions;
create trigger push_subscriptions_touch_updated_at
  before update on public.push_subscriptions
  for each row execute function private.touch_updated_at();

alter table public.push_subscriptions enable row level security;

-- Grants are explicit (default privileges are revoked in 0001). Update is granted so the subscribe
-- route can upsert on endpoint (a browser that subscribes twice refreshes its keys, not a new row).
revoke all on public.push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;

drop policy if exists push_subscriptions_owner_select on public.push_subscriptions;
create policy push_subscriptions_owner_select on public.push_subscriptions
  for select to authenticated
  using ((select public.is_owner()) and user_id = (select auth.uid()));
drop policy if exists push_subscriptions_owner_insert on public.push_subscriptions;
create policy push_subscriptions_owner_insert on public.push_subscriptions
  for insert to authenticated
  with check ((select public.is_owner()) and user_id = (select auth.uid()));
drop policy if exists push_subscriptions_owner_update on public.push_subscriptions;
create policy push_subscriptions_owner_update on public.push_subscriptions
  for update to authenticated
  using ((select public.is_owner()) and user_id = (select auth.uid()))
  with check ((select public.is_owner()) and user_id = (select auth.uid()));
drop policy if exists push_subscriptions_owner_delete on public.push_subscriptions;
create policy push_subscriptions_owner_delete on public.push_subscriptions
  for delete to authenticated
  using ((select public.is_owner()) and user_id = (select auth.uid()));
