-- Hydra 0205: Connect Instagram for Personal Brand (owner, 2026-11-22: "also for personal brand is it able
-- to connect my instagram", then "yes"). Instagram API with Instagram Login. Plain SQL, safe to re-run.
--
-- instagram_connections        one row: the owner's Instagram professional account. The long-lived token is
--                              AES-256-GCM ciphertext (src/lib/bank/crypto.ts, the same key as the Plaid and
--                              Google tokens; AAD = the row id). Every write runs as service_role from
--                              src/lib/instagram/*. The owner and hydra_ro read every column but the token.
--   last_error                 Instagram's error class only (reauth_required, rate_limited, instagram_error,
--                              internal), or what a finished sync missed as a comma-separated set
--                              (insights_partial, insights_not_granted, media_cut); never a token or a body.
--                              reauth_required: the page shows Reconnect and syncs stop until a sign-in.
--   token_id                   a new uuid with every stored token (sign-in, refresh). The sync writes the row
--                              only while token_id is still the one it read, so a reconnect mid-run wins. It is
--                              the compare-and-set key so the sealed token never rides in a request URL filter.
--   sync_started_at            the sync lease: a sync claims it with a compare-and-set (null to now), so the
--                              cron and the Sync now button never run at once. A lease older than 10 minutes
--                              is a sync that died; the next sync takes it over.
-- deals                        service_role may insert brand_name, start_date and personal_brand only: the sync
--                              makes the Personal Brand deal when none exists. 0010 gave it no deal writes; it
--                              still cannot edit a deal, set pay fields or delete one.
-- personal_brand_followers     the source check also allows 'instagram' (a day the sync wrote). The sync
--                              replaces that day's row whatever its source; a count typed after it stays
--                              until the next sync of the same day.

create table if not exists public.instagram_connections (
  id uuid primary key default gen_random_uuid(),
  -- One connection: a second row is refused. Reconnecting updates this row.
  one_connection boolean not null default true unique check (one_connection),
  ig_user_id text not null check (char_length(ig_user_id) between 1 and 64),
  username text not null check (char_length(username) between 1 and 100),
  scopes text not null default '',
  -- 'v1.<iv>.<tag>.<ciphertext>'; the check stops a plaintext token from ever landing here.
  access_token text not null check (access_token like 'v1.%'),
  token_id uuid not null default gen_random_uuid(),
  expires_at timestamptz not null,
  last_synced_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 64),
  sync_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- A database that ran an earlier 0205 has the table without token_id.
alter table public.instagram_connections add column if not exists token_id uuid not null default gen_random_uuid();

drop trigger if exists instagram_connections_touch_updated_at on public.instagram_connections;
create trigger instagram_connections_touch_updated_at before update on public.instagram_connections
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS and grants. Owner only, read only. The token column: service_role only.
-- ---------------------------------------------------------------------------
alter table public.instagram_connections enable row level security;

revoke all on public.instagram_connections from public, anon, authenticated, hydra_ro;
grant select (id, ig_user_id, username, scopes, expires_at, last_synced_at, last_error, sync_started_at, created_at, updated_at)
  on public.instagram_connections to authenticated, hydra_ro;
grant all on public.instagram_connections to service_role;

drop policy if exists instagram_connections_owner_select on public.instagram_connections;
create policy instagram_connections_owner_select on public.instagram_connections
  for select to authenticated using ((select public.is_owner()));
drop policy if exists instagram_connections_ro_select on public.instagram_connections;
create policy instagram_connections_ro_select on public.instagram_connections
  for select to hydra_ro using (true);

-- ---------------------------------------------------------------------------
-- Deals: the sync makes the Personal Brand deal (src/lib/instagram/sync.ts brandDeal). These three columns only.
-- ---------------------------------------------------------------------------
grant insert (brand_name, start_date, personal_brand) on public.deals to service_role;

-- ---------------------------------------------------------------------------
-- Followers: the sync writes source 'instagram'.
-- ---------------------------------------------------------------------------
alter table public.personal_brand_followers drop constraint if exists personal_brand_followers_source_check;
alter table public.personal_brand_followers add constraint personal_brand_followers_source_check
  check (source in ('manual', 'sync', 'instagram'));

-- ---------------------------------------------------------------------------
-- Activity and undo (0130): the token table is never logged. Skipped where 0130 has not run.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('private.activity_tables') is not null then
    insert into private.activity_tables (tbl, logged, reason)
    values ('instagram_connections', false, 'Instagram OAuth token')
    on conflict (tbl) do update set logged = excluded.logged, reason = excluded.reason;
  end if;
end;
$$;
