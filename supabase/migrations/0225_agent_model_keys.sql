-- Hydra 0225: provider keys for the agent's other models (owner, 2026-11-22: "also could you allow me to connected
-- different models and switch between them and their effort levels like grok, chatgpt"; Grok through an xAI API key
-- pasted once in Settings > Agent > Models; ChatGPT through "Sign in with ChatGPT" on the Mac, so no key here).
-- Plain SQL, safe to re-run.
--
-- agent_model_keys   one row per connected provider (xai only). `sealed` is AES-256-GCM ciphertext
--                    (src/lib/bank/crypto.ts, HYDRA_TOKEN_KEY like the Plaid and Google tokens; AAD
--                    'agent_model_key:<provider>'). Every write runs as service_role from /api/agent/models/keys after
--                    the key passed the provider's free model list. The relay brains read it through
--                    /api/agent/relay/keys/[provider] (service role). The owner and hydra_ro read only the provider,
--                    the last four characters and the dates.
-- Model ids and efforts need no change: agent_settings.model is free text and the effort checks already allow low..max.

create table if not exists public.agent_model_keys (
  provider text primary key check (provider in ('xai')),
  -- 'v1.<iv>.<tag>.<ciphertext>'; the check stops a plaintext key from ever landing here.
  sealed text not null check (sealed like 'v1.%' and char_length(sealed) <= 1000),
  hint text not null check (char_length(hint) = 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists agent_model_keys_touch_updated_at on public.agent_model_keys;
create trigger agent_model_keys_touch_updated_at before update on public.agent_model_keys
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS and grants. Owner and hydra_ro: read only, never `sealed`. service_role: everything.
-- ---------------------------------------------------------------------------
alter table public.agent_model_keys enable row level security;

revoke all on public.agent_model_keys from public, anon, authenticated, hydra_ro;
grant select (provider, hint, created_at, updated_at) on public.agent_model_keys to authenticated, hydra_ro;
grant all on public.agent_model_keys to service_role;

drop policy if exists agent_model_keys_owner_select on public.agent_model_keys;
create policy agent_model_keys_owner_select on public.agent_model_keys for select to authenticated
  using ((select public.is_owner()));
drop policy if exists agent_model_keys_ro_select on public.agent_model_keys;
create policy agent_model_keys_ro_select on public.agent_model_keys for select to hydra_ro using (true);

-- Activity and undo (0130): not logged (a secret; removing a key asks first and is not undone).
do $$
begin
  if to_regclass('private.activity_tables') is not null then
    insert into private.activity_tables (tbl, logged, reason)
    values ('agent_model_keys', false, 'agent provider API keys')
    on conflict (tbl) do update set logged = excluded.logged, reason = excluded.reason;
  end if;
end;
$$;
