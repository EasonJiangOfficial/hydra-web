-- Hydra 0130: Activity and undo (owner, 2026-11-21: "I should be able to undo deletions and undo past
-- behaviors"; 30 days; one Activity list for pages and the agent). Capture is in the database: a row
-- trigger on every owner data table writes the before and after image of each change. Safe to re-run.
--
-- What is logged: writes made as role `authenticated` (the owner's session), plus any write that
-- carries the `x-hydra-actor` request header (a service-role client opting in). Service-role writes
-- without the header (bank sync, cron, imports) and the database owner's writes are not logged.
-- Grouping: header `x-hydra-activity: <uuid>` is the activity id; without it, one activity per
-- transaction. undo_activity groups its own writes under a fresh id with undo_of set.

-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------
create table if not exists public.activity (
  id               uuid primary key default gen_random_uuid(),
  at               timestamptz not null default now(),
  actor            text not null check (actor in ('you', 'hydra', 'routine')),
  txid             bigint, -- the grouping key when no activity header came with the write
  undone_at        timestamptz,
  undo_of          uuid references public.activity (id) on delete set null,
  agent_action_id  uuid -- plain uuid: the agent may log its action after the write
);
create index if not exists activity_at_idx on public.activity (at desc, id desc);
create index if not exists activity_txid_idx on public.activity (txid) where txid is not null;
create index if not exists activity_agent_action_idx on public.activity (agent_action_id) where agent_action_id is not null;

create table if not exists public.activity_rows (
  activity_id  uuid not null references public.activity (id) on delete cascade,
  seq          bigint generated always as identity,
  tbl          text not null,
  op           text not null check (op in ('insert', 'update', 'delete')),
  pk           jsonb not null,
  old          jsonb,
  new          jsonb,
  primary key (activity_id, seq)
);

-- Every public table is either logged or excluded with a reason (supabase/tests/0130 fails on a
-- table in neither list).
create table if not exists private.activity_tables (
  tbl     text primary key,
  logged  boolean not null,
  reason  text check (logged or length(reason) > 0)
);
alter table private.activity_tables enable row level security;
revoke all on private.activity_tables from public, anon, authenticated, hydra_ro;

insert into private.activity_tables (tbl, logged, reason) values
  ('accounts', true, null),
  ('balances', true, null),
  ('categories', true, null),
  ('category_tax_lines', true, null),
  ('dashboard_layouts', true, null),
  ('day_targets', true, null),
  ('deal_accounts', true, null),
  ('deal_payments', true, null),
  ('deal_templates', true, null),
  ('deals', true, null),
  ('entities', true, null),
  ('events', true, null),
  ('planning_category_colors', true, null),
  ('planning_goal_links', true, null),
  ('planning_goal_metrics', true, null),
  ('planning_goals', true, null),
  ('planning_properties', true, null),
  ('planning_property_options', true, null),
  ('planning_statuses', true, null),
  ('planning_task_values', true, null),
  ('planning_tasks', true, null),
  ('post_view_snapshots', true, null),
  ('posts', true, null),
  ('recurring', true, null),
  ('rules', true, null),
  ('settings', true, null),
  ('tax_documents', true, null),
  ('tax_estimated_payments', true, null),
  ('tax_lines', true, null),
  ('tax_settings', true, null),
  ('transactions', true, null),
  ('transfer_rejections', true, null),
  ('agent_memory', true, null),
  ('agent_routines', true, null),
  ('agent_settings', true, null),
  ('activity', false, 'the activity log itself'),
  ('activity_rows', false, 'the activity log itself'),
  ('agent_threads', false, 'agent internals: chat threads'),
  ('agent_messages', false, 'agent internals: messages'),
  ('agent_actions', false, 'agent internals: the tool log, shown in Activity on its own'),
  ('agent_approvals', false, 'agent internals: approvals'),
  ('agent_notifications', false, 'agent internals: notifications'),
  ('agent_routine_runs', false, 'agent internals: run log'),
  ('agent_rate_limits', false, 'agent internals: rate limits'),
  ('agent_desktop_jobs', false, 'relay jobs to the Mac'),
  ('agent_relay_turns', false, 'relay: web and phone turns queued for the owner''s brain'),
  ('agent_relay_events', false, 'relay: streamed turn events'),
  ('agent_devices', false, 'devices'),
  ('agent_pairing_codes', false, 'pairing codes'),
  ('api_keys', false, 'api keys'),
  ('api_key_rate_limits', false, 'api key rate limits'),
  ('push_subscriptions', false, 'push subscriptions'),
  ('bank_items', false, 'Plaid item secrets and sync cursors'),
  ('google_accounts', false, 'Google OAuth tokens'),
  ('google_calendar_sync', false, 'sync cursors'),
  ('google_calendar_links', false, 'Google mirror state: a restored item is pushed again by the sync'),
  ('google_watch_channels', false, 'Google push channels'),
  ('import_ripple_map', false, 'import bookkeeping'),
  ('planning_alert_fires', false, 'alert fire markers')
on conflict (tbl) do update set logged = excluded.logged, reason = excluded.reason;

-- ---------------------------------------------------------------------------
-- Capture. Security definer (writes the log the caller cannot), empty search_path, UTC so the
-- images compare equal whatever the session's zone.
-- ---------------------------------------------------------------------------
create or replace function private.activity_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_forced text := nullif(current_setting('hydra.activity_id', true), '');
  v_headers jsonb;
  v_actor text;
  v_hid text;
  v_aid text;
  v_id uuid;
  v_txid bigint;
  v_old jsonb;
  v_new jsonb;
begin
  if v_forced is not null then
    v_id := v_forced::uuid; -- undo_activity made the activity row already
  else
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
    v_actor := v_headers ->> 'x-hydra-actor';
    if v_actor is null or v_actor not in ('you', 'hydra', 'routine') then
      if coalesce(nullif(current_setting('role', true), 'none'), session_user::text) <> 'authenticated' then
        return null; -- service role or database owner without the header: not logged
      end if;
      v_actor := 'you';
    end if;
    v_hid := v_headers ->> 'x-hydra-activity';
    v_aid := v_headers ->> 'x-hydra-agent-action';
    if v_aid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_aid := null;
    end if;
    if v_hid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_id := v_hid::uuid;
      insert into public.activity (id, actor, agent_action_id)
      values (v_id, v_actor, v_aid::uuid)
      on conflict (id) do nothing;
    else
      v_txid := txid_current();
      select a.id into v_id from public.activity a where a.txid = v_txid limit 1;
      if v_id is null then
        insert into public.activity (actor, txid, agent_action_id)
        values (v_actor, v_txid, v_aid::uuid)
        returning id into v_id;
      end if;
    end if;
  end if;

  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
  elsif tg_op = 'DELETE' then
    v_old := to_jsonb(old);
  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    if v_old = v_new then
      return null;
    end if;
  end if;

  insert into public.activity_rows (activity_id, tbl, op, pk, old, new)
  values (
    v_id,
    tg_table_name,
    lower(tg_op),
    (select jsonb_object_agg(k, coalesce(v_new, v_old) -> k) from unnest(tg_argv) k),
    v_old,
    v_new
  );
  return null;
end;
$$;
revoke execute on function private.activity_capture() from public;

-- (Re)attach the capture trigger to every logged table, with its primary key columns as arguments.
-- Named "0_..." so it runs before the foreign-key cascades (triggers fire in name order, and the
-- "RI_..." triggers sort after a digit): a parent row gets a lower seq than the rows it cascades to.
do $$
declare
  t record;
  v_pk text;
begin
  for t in select a.tbl from private.activity_tables a where a.logged loop
    select string_agg(quote_literal(att.attname), ', ' order by k.ord)
      into v_pk
      from pg_index i
      cross join lateral unnest(i.indkey) with ordinality k (attnum, ord)
      join pg_attribute att on att.attrelid = i.indrelid and att.attnum = k.attnum
      where i.indrelid = format('public.%I', t.tbl)::regclass and i.indisprimary;
    if v_pk is null then
      raise exception 'activity: % has no primary key', t.tbl;
    end if;
    execute format('drop trigger if exists "0_activity_capture" on public.%I', t.tbl);
    execute format(
      'create trigger "0_activity_capture" after insert or update or delete on public.%I '
      'for each row execute function private.activity_capture(%s)', t.tbl, v_pk);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants: the owner reads the log; nobody writes it but the functions below.
-- ---------------------------------------------------------------------------
alter table public.activity enable row level security;
alter table public.activity_rows enable row level security;
revoke all on public.activity, public.activity_rows from public, anon, authenticated, hydra_ro;
grant select on public.activity, public.activity_rows to authenticated;
grant all on public.activity, public.activity_rows to service_role;

drop policy if exists activity_owner_select on public.activity;
create policy activity_owner_select on public.activity
  for select to authenticated using ((select public.is_owner()));
drop policy if exists activity_rows_owner_select on public.activity_rows;
create policy activity_rows_owner_select on public.activity_rows
  for select to authenticated using ((select public.is_owner()));

-- A manual transaction (one the owner typed) can be deleted by the owner's own session, so the
-- delete is logged and undone like any other. A bank row or a paired transfer cannot.
grant delete on public.transactions to authenticated;
drop policy if exists transactions_owner_delete_manual on public.transactions;
create policy transactions_owner_delete_manual on public.transactions
  for delete to authenticated
  using ((select public.is_owner()) and source = 'manual' and transfer_pair_id is null);

-- ---------------------------------------------------------------------------
-- Undo helpers.
-- ---------------------------------------------------------------------------

-- "(a, b)" and the matching "where (a, b) = (select a, b from jsonb_populate_record(null::t, $1))".
create or replace function private.activity_pk_where(p_tbl text, p_pk jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select format('(%1$s) = (select %1$s from jsonb_populate_record(null::public.%2$I, $1))',
                string_agg(format('%I', k), ', ' order by k), p_tbl)
  from jsonb_object_keys(p_pk) k;
$$;
revoke execute on function private.activity_pk_where(text, jsonb) from public;

-- The row as it is now, or null. Locked (FOR UPDATE) until the undo commits, so a write that lands
-- after the changed-since check waits for the undo instead of being overwritten unseen.
create or replace function private.activity_current(p_tbl text, p_pk jsonb)
returns jsonb
language plpgsql
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v jsonb;
begin
  execute format('select to_jsonb(t) from public.%I t where %s for update', p_tbl, private.activity_pk_where(p_tbl, p_pk))
    using p_pk into v;
  return v;
end;
$$;
revoke execute on function private.activity_current(text, jsonb) from public;

-- Reverse one logged row. An insert is deleted; an update gets back its old values in the columns
-- it changed; a delete is put back with the same id (over a row that took the id, when forced).
create or replace function private.activity_reverse(p_tbl text, p_op text, p_pk jsonb, p_old jsonb, p_new jsonb)
returns void
language plpgsql
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_cols text;
  v_pkcols text;
begin
  if p_op = 'insert' then
    execute format('delete from public.%I where %s', p_tbl, private.activity_pk_where(p_tbl, p_pk)) using p_pk;
  elsif p_op = 'update' then
    select string_agg(format('%I', k), ', ') into v_cols
    from jsonb_object_keys(p_old) k
    where (p_old -> k) is distinct from (p_new -> k)
      and exists (select 1 from pg_attribute a
                  where a.attrelid = format('public.%I', p_tbl)::regclass and a.attname = k
                    and a.attnum > 0 and not a.attisdropped and a.attgenerated = '');
    if v_cols is null then
      return;
    end if;
    execute format('update public.%1$I set (%2$s) = (select %2$s from jsonb_populate_record(null::public.%1$I, $2)) where %3$s',
                   p_tbl, v_cols, private.activity_pk_where(p_tbl, p_pk))
      using p_pk, p_old;
  else
    select string_agg(format('%I', a.attname), ', ' order by a.attnum) into v_cols
    from pg_attribute a
    where a.attrelid = format('public.%I', p_tbl)::regclass and a.attnum > 0 and not a.attisdropped
      and a.attgenerated = '' and p_old ? a.attname;
    select string_agg(format('%I', k), ', ' order by k) into v_pkcols from jsonb_object_keys(p_pk) k;
    execute format(
      'insert into public.%1$I as t (%2$s) overriding system value '
      'select %2$s from jsonb_populate_record(null::public.%1$I, $1) '
      'on conflict (%3$s) do update set (%2$s) = row(%4$s)',
      p_tbl, v_cols, v_pkcols,
      (select string_agg('excluded.' || c, ', ') from unnest(string_to_array(v_cols, ', ')) c))
      using p_old;
  end if;
end;
$$;
revoke execute on function private.activity_reverse(text, text, jsonb, jsonb, jsonb) from public;

-- Rows of other tables that point at this row (any foreign key) and that the activity did not touch:
-- undoing the row's insert would delete them (cascade), unlink them (set null) or be refused
-- (restrict). [{tbl, n}] per child table, or [] when none.
create or replace function private.activity_children(p_tbl text, p_row jsonb, p_activity uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  c record;
  v_n bigint;
  v_out jsonb := '[]';
begin
  for c in
    select ch.relname as child,
      (select string_agg(format('%I', a.attname), ', ' order by k.ord)
         from unnest(con.conkey) with ordinality k (attnum, ord)
         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as fkcols,
      (select string_agg(format('%I', a.attname), ', ' order by k.ord)
         from unnest(con.confkey) with ordinality k (attnum, ord)
         join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as refcols,
      (select array_agg(a.attname::text order by k.ord)
         from pg_index i cross join lateral unnest(i.indkey) with ordinality k (attnum, ord)
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         where i.indrelid = con.conrelid and i.indisprimary) as pkcols
    from pg_constraint con
    join pg_class ch on ch.oid = con.conrelid
    join pg_namespace n on n.oid = ch.relnamespace
    where con.contype = 'f' and n.nspname = 'public'
      and con.confrelid = format('public.%I', p_tbl)::regclass
  loop
    execute format(
      'select count(*) from public.%1$I c where (%2$s) = (select %3$s from jsonb_populate_record(null::public.%4$I, $1)) '
      'and not exists (select 1 from public.activity_rows r where r.activity_id = $2 and r.tbl = %5$L '
      'and r.pk = (select jsonb_object_agg(k, to_jsonb(c) -> k) from unnest($3::text[]) k))',
      c.child, c.fkcols, c.refcols, p_tbl, c.child)
      using p_row, p_activity, c.pkcols into v_n;
    if v_n > 0 then
      v_out := v_out || jsonb_build_object('tbl', c.child, 'n', v_n);
    end if;
  end loop;
  return v_out;
end;
$$;
revoke execute on function private.activity_children(text, jsonb, uuid) from public;

-- The owner's row-level rules for one command ('d' delete, 'w' update, 'a' insert) on a table, as one
-- SQL condition over the row's columns: permissive policies or'd, restrictive ones and'd. Null when
-- no policy lets the owner do it. p_check: the WITH CHECK side (the row as written).
create or replace function private.activity_policy(p_tbl text, p_cmd text, p_check boolean)
returns text
language sql
stable
set search_path = ''
as $$
  select case when bool_or(p.polpermissive) then
      '(' || string_agg(e, ' or ') filter (where p.polpermissive) || ')'
      || coalesce(' and ' || string_agg(e, ' and ') filter (where not p.polpermissive), '')
    end
  from pg_policy p
  cross join lateral (select coalesce(pg_get_expr(case when p_check then coalesce(p.polwithcheck, p.polqual) else p.polqual end, p.polrelid), 'true') as e) x
  where p.polrelid = format('public.%I', p_tbl)::regclass
    and p.polcmd::text in (p_cmd, '*')
    and (0::oid = any (p.polroles) or (select r.oid from pg_roles r where r.rolname = 'authenticated') = any (p.polroles));
$$;
revoke execute on function private.activity_policy(text, text, boolean) from public;

-- Would the owner's own session be allowed this reversal? The same grants and row rules a direct
-- write from the page meets: an undo never writes what the owner could not write himself.
-- p_op is the logged op (its reversal: insert -> delete, update -> update back, delete -> insert).
create or replace function private.activity_owner_may(p_tbl text, p_op text, p_pk jsonb, p_old jsonb)
returns boolean
language plpgsql
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_rel regclass := format('public.%I', p_tbl)::regclass;
  v_priv text := case p_op when 'insert' then 'DELETE' when 'update' then 'UPDATE' else 'INSERT' end;
  v_using text;
  v_check text;
  v_ok boolean;
begin
  if not has_table_privilege('authenticated', v_rel, v_priv) then
    return false;
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = v_rel) then
    return true;
  end if;
  if p_op in ('insert', 'update') then
    v_using := private.activity_policy(p_tbl, case p_op when 'insert' then 'd' else 'w' end, false);
    if v_using is null then
      return false;
    end if;
    -- A row already gone (a forced undo) is nothing to check.
    execute format('select coalesce((select (%s) from public.%I where %s), true)', v_using, p_tbl, private.activity_pk_where(p_tbl, p_pk))
      using p_pk into v_ok;
    if not v_ok then
      return false;
    end if;
  end if;
  if p_op in ('delete', 'update') then
    v_check := private.activity_policy(p_tbl, case p_op when 'delete' then 'a' else 'w' end, true);
    if v_check is null then
      return false;
    end if;
    execute format('select (%s) from jsonb_populate_record(null::public.%I, $1)', v_check, p_tbl) using p_old into v_ok;
    return coalesce(v_ok, false);
  end if;
  return true;
end;
$$;
revoke execute on function private.activity_owner_may(text, text, jsonb, jsonb) from public;

-- ---------------------------------------------------------------------------
-- undo_activity(id, force): one transaction. Returns
--   {ok: true, undoId} | {ok: false, error: 'changed_since', changed: [...], blocked?: true} |
--   {ok: false, error: 'expired' | 'already_undone' | 'not_found'}.
-- blocked: the undo would break a rule (a name taken since, a two-level category tree, a row the owner
-- may not write); force cannot help, nothing was changed.
-- Security definer with an explicit owner check: putting rows back exactly needs some BEFORE row
-- triggers off for the restore (the ones that stamp updated_at, re-snapshot rates, renumber positions
-- or refuse Ripple rows), and only the table owner can switch them off. The guards stay on, and each
-- reversed row must pass the owner's own grants and row rules (activity_owner_may), so an undo writes
-- nothing the owner's session could not.
-- ponytail: ALTER TABLE ... DISABLE TRIGGER takes a SHARE ROW EXCLUSIVE lock and makes PostgREST
-- reload its schema cache on each undo; fine for one owner, a per-trigger bypass flag if it is not.
-- ---------------------------------------------------------------------------
create or replace function public.undo_activity(p_id uuid, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_role text := coalesce(nullif(current_setting('role', true), 'none'), session_user::text);
  v_headers jsonb := nullif(current_setting('request.headers', true), '')::jsonb;
  v_check boolean;
  v_actor text;
  a public.activity%rowtype;
  v_undo uuid := gen_random_uuid();
  v_changed jsonb := '[]';
  v_cur jsonb;
  v_diff text[];
  v_kid jsonb;
  p record;
  v_row record;
  v_trig text;
  v_off text[];
  v_pending bigint[];
  v_next bigint[];
  v_seq bigint;
  v_progress boolean;
  v_err text;
  v_state text;
  v_con text;
  v_tab text;
begin
  if not (public.is_owner() or v_role in ('service_role', 'postgres')) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  -- The owner's session meets the owner's row rules; the service role (the agent's device path) and
  -- the database owner bypass RLS anyway.
  v_check := v_role not in ('service_role', 'postgres');
  select * into a from public.activity where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if a.undone_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_undone');
  end if;
  if a.at < now() - make_interval(days => 30) then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  -- Changed since: each row the action touched must still be as the action left it, in the
  -- columns the action changed (a deleted row must still be gone), and a row it added must have
  -- no newer rows pointing at it. One pass over the activity's rows (no per-row rescans).
  for p in
    with r as (
      select x.seq, x.tbl, x.op, x.pk, x.old, x.new from public.activity_rows x where x.activity_id = p_id
    ),
    keys as (
      select r.tbl, r.pk, array_agg(distinct k) as cols
      from r, jsonb_object_keys(coalesce(r.new, r.old)) k
      where r.op <> 'update' or (r.old -> k) is distinct from (r.new -> k)
      group by r.tbl, r.pk
    ),
    g as (
      select r.tbl, r.pk,
        (array_agg(r.op order by r.seq))[1] as first_op,
        (array_agg(r.op order by r.seq desc))[1] as last_op,
        (array_agg(r.new order by r.seq desc))[1] as last_new,
        (array_agg(r.old order by r.seq))[1] as first_old,
        min(r.seq) as first_seq
      from r
      group by r.tbl, r.pk
    )
    select g.tbl, g.pk, g.first_op, g.last_op, g.last_new, g.first_old, k.cols
    from g left join keys k on k.tbl = g.tbl and k.pk = g.pk
    order by g.first_seq
  loop
    v_cur := private.activity_current(p.tbl, p.pk);
    if p.last_op = 'delete' then
      if v_cur is not null then
        v_changed := v_changed || jsonb_build_object('tbl', p.tbl, 'what', 'back', 'row', v_cur);
      end if;
    elsif v_cur is null then
      v_changed := v_changed || jsonb_build_object('tbl', p.tbl, 'what', 'gone', 'row', coalesce(p.last_new, p.first_old));
    else
      select array_agg(k order by k) into v_diff from unnest(p.cols) k where (v_cur -> k) is distinct from (p.last_new -> k);
      if v_diff is not null then
        v_changed := v_changed || jsonb_build_object('tbl', p.tbl, 'what', 'changed', 'cols', to_jsonb(v_diff), 'row', v_cur);
      end if;
      -- Undoing an add deletes the row: later rows under it (a deal's posts, a goal's tasks) would go too.
      if p.first_op = 'insert' then
        for v_kid in select * from jsonb_array_elements(private.activity_children(p.tbl, v_cur, p_id)) loop
          v_changed := v_changed || jsonb_build_object('tbl', p.tbl, 'what', 'children', 'row', v_cur,
                                                       'child', v_kid ->> 'tbl', 'n', (v_kid ->> 'n')::int);
        end loop;
      end if;
    end if;
  end loop;
  if jsonb_array_length(v_changed) > 0 and not p_force then
    return jsonb_build_object('ok', false, 'error', 'changed_since', 'changed', v_changed);
  end if;

  -- The undo is itself an activity (undo_of set), so undoing it redoes the original.
  v_actor := coalesce(v_headers ->> 'x-hydra-actor', 'you');
  if v_actor not in ('you', 'hydra', 'routine') then
    v_actor := 'you';
  end if;

  -- A rule the restore would break rolls the whole undo back (this block is a savepoint) and is
  -- answered as blocked, not as an error.
  begin
    insert into public.activity (id, actor, undo_of) values (v_undo, v_actor, p_id);
    perform set_config('hydra.activity_id', v_undo::text, true);

    -- Rows go back exactly as logged: the BEFORE row triggers that rewrite a row (stamps, snapshots,
    -- positions, the Ripple source guard) are off for the restore. Guards that refuse a bad row stay on.
    v_off := array(
      select format('public.%I', c.relname) || ' ' || format('%I', t.tgname)
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc f on f.oid = t.tgfoid
      where n.nspname = 'public' and not t.tgisinternal and t.tgenabled <> 'D'
        and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & (4 | 16)) <> 0
        and f.proname in ('touch_updated_at', 'bank_fill_entity', 'deals_set_entity', 'deals_track_pause',
                          'planning_alert_follow_move', 'planning_tasks_completed_at', 'planning_tasks_repeat_series',
                          'posts_snapshot_rates', 'guard_ripple_source', 'posts_guard_exclude',
                          'bank_unmatch_reversed_payment', 'planning_properties_guard', 'planning_property_options_guard')
        and c.relname in (select x.tbl from public.activity_rows x where x.activity_id = p_id));
    foreach v_trig in array v_off loop
      execute 'alter table ' || split_part(v_trig, ' ', 1) || ' disable trigger ' || split_part(v_trig, ' ', 2);
    end loop;

    -- Newest first. A row that hits a foreign key or a guard (a child before its parent, a value
    -- before its option) waits for the next pass; a pass with no progress fails the whole undo.
    v_pending := array(select x.seq from public.activity_rows x where x.activity_id = p_id order by x.seq desc);
    loop
      v_next := '{}';
      v_progress := false;
      foreach v_seq in array v_pending loop
        select * into v_row from public.activity_rows x where x.activity_id = p_id and x.seq = v_seq;
        if v_check and not private.activity_owner_may(v_row.tbl, v_row.op, v_row.pk, v_row.old) then
          raise exception 'activity: the owner may not % this %',
            case v_row.op when 'insert' then 'delete' when 'update' then 'change' else 'add' end, v_row.tbl
            using errcode = '42501', table = v_row.tbl;
        end if;
        begin
          perform private.activity_reverse(v_row.tbl, v_row.op, v_row.pk, v_row.old, v_row.new);
          v_progress := true;
        exception when foreign_key_violation or unique_violation or check_violation or raise_exception then
          get stacked diagnostics v_state = returned_sqlstate, v_err = message_text, v_con = constraint_name, v_tab = table_name;
          v_next := v_next || v_seq;
        end;
      end loop;
      exit when cardinality(v_next) = 0;
      if not v_progress then
        raise exception using errcode = v_state, message = v_err, constraint = coalesce(v_con, ''), table = coalesce(v_tab, '');
      end if;
      v_pending := v_next;
    end loop;

    -- What the two planning guards check, for the rows they did not see.
    if exists (select 1 from public.activity_rows x where x.activity_id = p_id and x.tbl = 'planning_properties' and x.op = 'delete')
       and (select count(*) from public.planning_properties) > 50 then
      raise exception 'planning: too many properties' using table = 'planning_properties';
    end if;
    if exists (
      select 1 from public.planning_property_options o
      join public.planning_properties pp on pp.id = o.property_id
      where o.id in (select (x.pk ->> 'id')::uuid from public.activity_rows x
                     where x.activity_id = p_id and x.tbl = 'planning_property_options' and x.op = 'delete')
        and (pp.type not in ('select', 'multi_select')
             or (select count(*) from public.planning_property_options o2 where o2.property_id = pp.id) > 100)) then
      raise exception 'planning: options need a select, at most 100' using table = 'planning_property_options';
    end if;

    foreach v_trig in array v_off loop
      execute 'alter table ' || split_part(v_trig, ' ', 1) || ' enable trigger ' || split_part(v_trig, ' ', 2);
    end loop;
    perform set_config('hydra.activity_id', '', true);
  exception when foreign_key_violation or unique_violation or check_violation or raise_exception
              or not_null_violation or exclusion_violation or insufficient_privilege then
    get stacked diagnostics v_state = returned_sqlstate, v_err = message_text, v_con = constraint_name, v_tab = table_name;
    perform set_config('hydra.activity_id', '', true);
    return jsonb_build_object('ok', false, 'error', 'changed_since', 'blocked', true, 'changed', jsonb_build_array(
      jsonb_build_object('tbl', nullif(v_tab, ''), 'what', 'blocked',
        'why', case v_state when '23505' then 'taken' when '23503' then 'linked' when '42501' then 'not_allowed' else 'rule' end,
        'constraint', nullif(v_con, ''), 'msg', v_err)));
  end;

  update public.activity set undone_at = now() where id = p_id;
  if a.undo_of is not null then
    update public.activity set undone_at = null where id = a.undo_of; -- redone: undoable again
  end if;
  return jsonb_build_object('ok', true, 'undoId', v_undo);
end;
$$;
revoke execute on function public.undo_activity(uuid, boolean) from public, anon;
grant execute on function public.undo_activity(uuid, boolean) to authenticated, service_role;

-- undo_activities(ids, force): the activities of one page delete made of several calls (three rules,
-- a video's posts), undone newest first in one transaction: all come back or none. Returns
-- {ok: true, undoId, undoIds} or the first failing undo_activity result (nothing changed).
create or replace function public.undo_activities(p_ids uuid[], p_force boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r jsonb;
  v_fail jsonb;
  v_undo uuid[] := '{}';
  i int;
begin
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 100 then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  begin
    for i in reverse cardinality(p_ids) .. 1 loop
      r := public.undo_activity(p_ids[i], p_force);
      if not coalesce((r ->> 'ok')::boolean, false) then
        v_fail := r;
        raise exception 'undo_activities: roll back' using errcode = 'HU001';
      end if;
      v_undo := v_undo || (r ->> 'undoId')::uuid;
    end loop;
  exception when sqlstate 'HU001' then
    return v_fail;
  end;
  return jsonb_build_object('ok', true, 'undoId', v_undo[cardinality(v_undo)], 'undoIds', to_jsonb(v_undo));
end;
$$;
revoke execute on function public.undo_activities(uuid[], boolean) from public, anon;
grant execute on function public.undo_activities(uuid[], boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- activity_list: one page, newest first, with the agent's logged actions that have no activity
-- rows yet (kind 'agent'). Security invoker: RLS applies (the owner reads, anyone else gets none).
-- Until agent writes are tagged (decision 10), an agent step outside a routine ran through the
-- owner's session, so its Hydra rows are already a 'db' entry: only its outside steps (Gmail,
-- calendar, the Mac) show as 'agent', or the same change would show, and undo, twice.
-- Keep the tool pattern in step with OUTSIDE_TOOL in src/lib/agent/tools.ts.
-- ---------------------------------------------------------------------------
create or replace function public.activity_list(
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit int default 50
)
returns table (
  id uuid, at timestamptz, actor text, undone_at timestamptz, undo_of uuid, kind text,
  row_count int, rows jsonb, summary text, has_inverse boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select u.* from (
    select a.id, a.at, a.actor, a.undone_at, a.undo_of, 'db'::text,
      (select count(*)::int from public.activity_rows r where r.activity_id = a.id),
      coalesce((select jsonb_agg(jsonb_build_object('seq', x.seq, 'tbl', x.tbl, 'op', x.op, 'old', x.old, 'new', x.new) order by x.seq)
                from (select * from public.activity_rows r where r.activity_id = a.id order by r.seq limit 20) x), '[]'::jsonb),
      null::text, null::boolean
    from public.activity a
    union all
    select g.id, g.created_at, case when g.surface = 'routine' then 'routine' else 'hydra' end, g.undone_at,
      (select o.id from public.agent_actions o where o.undo_action_id = g.id limit 1), 'agent'::text,
      0, '[]'::jsonb, g.summary, g.inverse is not null
    from public.agent_actions g
    where not exists (select 1 from public.activity a where a.agent_action_id = g.id)
      and (g.surface = 'routine' or g.tool ~ '^(gmail|calendar|mac)_')
  ) u (id, at, actor, undone_at, undo_of, kind, row_count, rows, summary, has_inverse)
  where p_before_at is null or (u.at, u.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
  order by u.at desc, u.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 201); -- 200 and one more, to know there is a next page
$$;
revoke execute on function public.activity_list(timestamptz, uuid, int) from public, anon;
grant execute on function public.activity_list(timestamptz, uuid, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- activity_trash / prune_activity: the daily cron first lists the trash objects
-- (trash/<activity id>/<path>) that the deletes of activity older than 30 days left, removes them,
-- and only then removes the activity with its row images (prune_activity returns the same list for
-- rows that aged in between). A failed file remove keeps the rows, so the next run tries again.
-- ---------------------------------------------------------------------------
create or replace function public.activity_trash(p_days int default 30)
returns table (bucket text, path text)
language sql
stable
security definer
set search_path = ''
as $$
  select case r.tbl when 'tax_documents' then 'tax-docs' else 'deal-logos' end,
         'trash/' || r.activity_id || '/' || (case r.tbl when 'tax_documents' then r.old ->> 'storage_path' else r.old ->> 'logo_path' end)
  from public.activity_rows r
  join public.activity a on a.id = r.activity_id
  where a.at < now() - make_interval(days => p_days)
    and r.op = 'delete' and r.tbl in ('tax_documents', 'deals')
    and (case r.tbl when 'tax_documents' then r.old ->> 'storage_path' else r.old ->> 'logo_path' end) is not null;
$$;
revoke execute on function public.activity_trash(int) from public, anon, authenticated;
grant execute on function public.activity_trash(int) to service_role;

create or replace function public.prune_activity(p_days int default 30)
returns table (bucket text, path text)
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.activity where at < now() - make_interval(days => p_days) returning id
  )
  select case r.tbl when 'tax_documents' then 'tax-docs' else 'deal-logos' end,
         'trash/' || r.activity_id || '/' || (case r.tbl when 'tax_documents' then r.old ->> 'storage_path' else r.old ->> 'logo_path' end)
  from public.activity_rows r
  join gone on gone.id = r.activity_id
  where r.op = 'delete' and r.tbl in ('tax_documents', 'deals')
    and (case r.tbl when 'tax_documents' then r.old ->> 'storage_path' else r.old ->> 'logo_path' end) is not null;
$$;
revoke execute on function public.prune_activity(int) from public, anon, authenticated;
grant execute on function public.prune_activity(int) to service_role;
