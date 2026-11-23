-- Hydra 0090: Google connectors (Gmail + Calendar). DESIGN.md 6.9 and 10; PLAN.md U15.
-- Plain SQL, safe to re-run.
--
-- One Google sign-in. Its tokens are AES-256-GCM ciphertext (src/lib/bank/crypto.ts, the same key
-- as the Plaid tokens; AAD = the account row id). Every write runs as service_role from
-- src/lib/google/*. The owner and hydra_ro read only the columns that hold no secret.
--
-- Calendar sync (two-way, on the dedicated "Hydra" calendar):
-- - google_calendar_sync: the calendar id and the pull's sync token. The pull stores its next token
--   with a compare-and-set on the token it started from, so two pulls at once (webhook + cron)
--   cannot move it backwards.
-- - google_calendar_links: Planning task or event <-> Google event. item_id has no foreign key on
--   purpose: after the owner deletes a Planning item, the link still names the Google event to remove.
--   pending = 'delete_in_hydra': the event was deleted in Google; Hydra asks before deleting its item.
-- - google_watch_channels: push-notification channels. Only the SHA-256 of the channel token is kept.

create table if not exists public.google_accounts (
  id uuid primary key default gen_random_uuid(),
  -- One Google sign-in: a second row is refused. Reconnecting replaces this row.
  one_sign_in boolean not null default true unique check (one_sign_in),
  email text not null check (char_length(email) between 3 and 320),
  scopes text not null default '',
  -- 'v1.<iv>.<tag>.<ciphertext>'; the check stops a plaintext token from ever landing here.
  access_token text not null check (access_token like 'v1.%'),
  access_expires_at timestamptz not null,
  refresh_token text not null check (refresh_token like 'v1.%'),
  status text not null default 'active' check (status in ('active', 'reauth_required')),
  last_error text, -- Google's error code only, never a token or a body
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.google_calendar_sync (
  account_id uuid primary key references public.google_accounts (id) on delete cascade,
  calendar_id text, -- the "Hydra" calendar; null until created
  sync_token text, -- null = the next pull is a full sync
  last_pulled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.google_calendar_links (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.google_accounts (id) on delete cascade,
  item_kind text not null check (item_kind in ('task', 'event')),
  item_id uuid not null,
  google_event_id text not null,
  google_etag text, -- the version Hydra last wrote or read: a pull that sees it again skips it
  google_updated_at timestamptz,
  pending text check (pending in ('delete_in_hydra')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_kind, item_id),
  unique (account_id, google_event_id)
);
create index if not exists google_calendar_links_pending on public.google_calendar_links (pending)
  where pending is not null;

create table if not exists public.google_watch_channels (
  id text primary key, -- the channel id Hydra gave Google (X-Goog-Channel-ID)
  account_id uuid not null references public.google_accounts (id) on delete cascade,
  resource_id text not null,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  address text not null check (address like 'https://%'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

drop trigger if exists google_accounts_touch_updated_at on public.google_accounts;
create trigger google_accounts_touch_updated_at before update on public.google_accounts
  for each row execute function private.touch_updated_at();
drop trigger if exists google_calendar_sync_touch_updated_at on public.google_calendar_sync;
create trigger google_calendar_sync_touch_updated_at before update on public.google_calendar_sync
  for each row execute function private.touch_updated_at();
drop trigger if exists google_calendar_links_touch_updated_at on public.google_calendar_links;
create trigger google_calendar_links_touch_updated_at before update on public.google_calendar_links
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS and grants. Owner only, read only. Tokens, the sync token and channel secrets: service_role only.
-- ---------------------------------------------------------------------------
alter table public.google_accounts enable row level security;
alter table public.google_calendar_sync enable row level security;
alter table public.google_calendar_links enable row level security;
alter table public.google_watch_channels enable row level security;

revoke all on public.google_accounts, public.google_calendar_sync, public.google_calendar_links,
  public.google_watch_channels
  from public, anon, authenticated, hydra_ro;

grant select (id, email, scopes, status, last_error, created_at, updated_at)
  on public.google_accounts to authenticated, hydra_ro;
grant select (account_id, calendar_id, last_pulled_at, created_at, updated_at)
  on public.google_calendar_sync to authenticated, hydra_ro;
grant select on public.google_calendar_links to authenticated, hydra_ro;
grant all on public.google_accounts, public.google_calendar_sync, public.google_calendar_links,
  public.google_watch_channels
  to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['google_accounts', 'google_calendar_sync', 'google_calendar_links'] loop
    execute format('drop policy if exists %1$s_owner_select on public.%1$s', t);
    execute format(
      'create policy %1$s_owner_select on public.%1$s for select to authenticated using ((select public.is_owner()))', t);
    execute format('drop policy if exists %1$s_ro_select on public.%1$s', t);
    execute format('create policy %1$s_ro_select on public.%1$s for select to hydra_ro using (true)', t);
  end loop;
end;
$$;
