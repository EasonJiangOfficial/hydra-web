-- Hydra 0200: approve all (owner, 2026-11-22: "quitting apps, changing stuff requires approval, there should be a
-- mode that approves all actions"). With it on, Hydra runs every gated step without asking, except a deletion
-- (owner rule: "every deletion of anything" asks, no exceptions). The approval row is still written, already
-- approved, as the audit trail (Gmail send needs it). Read once per turn or call by the server loop, the MCP gate
-- and the relay approval route; shown and toggled on every surface through GET and PATCH /api/agent/state.
-- Owner-only RLS and the grants are 0070's (the table is not new). Plain SQL, safe to re-run.

alter table public.agent_settings add column if not exists approve_all boolean not null default false;

-- One auto-approved MCP run per device, tool and input within 2 minutes of the last (the store renames an older holder
-- of the key, so the window slides): a retried or doubled call finds the key taken
-- and asks the owner instead, as it did before approve all (no second email). Unique, so it holds across instances.
alter table public.agent_approvals add column if not exists dedupe_key text unique
  check (dedupe_key is null or length(dedupe_key) <= 200);

-- What each Hydra Desktop declared on its last relay poll (relay-schema.ts capabilitiesSchema), written by the
-- service role on GET /relay/next; an older Mac sends none, which clears it. Approve all runs a Mac step without an
-- ask only when every live desktop declared approveAllDeletionTags (that Mac asks locally for any deletion).
alter table public.agent_devices add column if not exists capabilities jsonb not null default '{}'::jsonb
  check (jsonb_typeof(capabilities) = 'object' and length(capabilities::text) <= 500);

-- A risky Mac step approve all let through (the owner never said yes) is bound to a desktop that tags its own
-- deletions: the claim hands it only to a pull that itself declares approveAllDeletionTags (GET /api/agent/jobs reads
-- the request's CAPABILITIES_HEADER), never to an older build that paired or a Mac that downgraded since the gate. It
-- waits queued until such a desktop pulls. Every other job claims as in 0070.
alter table public.agent_desktop_jobs add column if not exists needs_tags boolean not null default false;

drop function if exists public.agent_claim_desktop_jobs(uuid, int);
create or replace function public.agent_claim_desktop_jobs(p_device uuid, p_limit int default 10, p_tags boolean default false)
returns setof public.agent_desktop_jobs
language plpgsql security invoker set search_path = '' as $$
begin
  -- Nested on purpose: the service role never calls is_owner() (no execute right needed).
  if current_user <> 'service_role' then
    if not (select public.is_owner()) then
      raise exception 'agent: no access' using errcode = '42501';
    end if;
  end if;
  return query
  with next_jobs as (
    select j.id from public.agent_desktop_jobs j
    where j.status = 'queued' and (not j.needs_tags or coalesce(p_tags, false))
    order by j.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update public.agent_desktop_jobs j
  set status = 'claimed', device_id = p_device, claimed_at = now()
  from next_jobs
  where j.id = next_jobs.id
  returning j.*;
end $$;
revoke execute on function public.agent_claim_desktop_jobs(uuid, int, boolean) from public, anon;
grant execute on function public.agent_claim_desktop_jobs(uuid, int, boolean) to authenticated, service_role;
