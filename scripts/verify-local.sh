#!/usr/bin/env bash
# Every check, on this Mac (owner, 2026-11-22: "dont do that test everythign on local", "disable github actions").
# Usage: pnpm verify            (from the worktree being merged)
# Steps: typecheck + lint + unit tests (pnpm gate); every supabase/tests/*.test.sql on a fresh scratch database
# made from the local Supabase stack (dropped at the end); the hydra_ro login test; the full Playwright suite on a
# free port. Exits non-zero on the first failing step. Needs the local stack running (supabase start).
set -uo pipefail
ROOT=$(git rev-parse --show-toplevel)
ADMIN=${HYDRA_ADMIN_URL:-postgresql://supabase_admin:postgres@127.0.0.1:55422}
PG=${HYDRA_PG_URL:-postgresql://postgres:postgres@127.0.0.1:55422}
step() { printf '\n== %s\n' "$1"; }

step "gate (typecheck, lint, unit tests)"
pnpm -C "$ROOT" gate || { echo "VERIFY FAILED: gate"; exit 1; }

step "pgTAP on a scratch database"
DB="hydra_scratch_verify_$$"
TMP=$(mktemp -d)
cleanup() { psql "$ADMIN/postgres" -X -q -c "drop database if exists $DB with (force)" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
# The Supabase base schemas (auth, storage, extensions...) from the local stack, without Hydra's own objects.
pg_dump "$ADMIN/postgres" -s -N public -N private -N supabase_migrations -N net -N pg_net > "$TMP/base.sql" 2>/dev/null \
  || { echo "VERIFY FAILED: pg_dump of the local stack (is supabase running?)"; exit 1; }
grep -v '^CREATE POLICY .*public\.is_owner' "$TMP/base.sql" > "$TMP/base.filtered.sql"
createdb --maintenance-db="$ADMIN/postgres" -O postgres "$DB" || { echo "VERIFY FAILED: createdb"; exit 1; }
psql "$ADMIN/$DB" -X -q -v ON_ERROR_STOP=0 -f "$TMP/base.filtered.sql" > "$TMP/base.log" 2>&1
psql "$ADMIN/$DB" -X -q -v ON_ERROR_STOP=1 <<'SQL' || { echo "VERIFY FAILED: base grants"; exit 1; }
alter schema public owner to pg_database_owner;
grant usage on schema public to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on sequences to postgres, anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on functions to postgres, anon, authenticated, service_role;
SQL
{ echo '\set ON_ERROR_STOP 1'; echo 'set client_min_messages = warning;'; for m in "$ROOT"/supabase/migrations/*.sql; do echo "\\i $m"; done; } > "$TMP/mig.sql"
psql "$PG/$DB" -X -q -At -f "$TMP/mig.sql" > "$TMP/mig.log" 2>&1 || { echo "VERIFY FAILED: migrations"; tail -5 "$TMP/mig.log"; exit 1; }
fail=0
for t in "$ROOT"/supabase/tests/*.test.sql; do
  { echo '\set ON_ERROR_STOP 1'; echo 'begin;'; echo 'set client_min_messages = warning;'; echo "\\i $t"; echo 'rollback;'; } > "$TMP/run.sql"
  out=$(psql "$PG/$DB" -X -q -At -f "$TMP/run.sql" 2>&1); rc=$?
  plan=$(grep -m1 '^1\.\.' <<<"$out"); notok=$(grep -c '^not ok' <<<"$out"); ok=$(grep -c '^ok' <<<"$out")
  if [ $rc -ne 0 ] || [ "$notok" -ne 0 ] || [ -z "$plan" ] || [ "1..$ok" != "$plan" ]; then
    fail=1; echo "FAIL $(basename "$t") rc=$rc plan=$plan ok=$ok notok=$notok"; grep -v '^ok' <<<"$out" | head -15
  else echo "PASS $(basename "$t") $plan"; fi
done
[ $fail -eq 0 ] || { echo "VERIFY FAILED: pgTAP"; exit 1; }
bash "$ROOT/supabase/tests/hydra_ro_login.sh" "$PG/$DB" || { echo "VERIFY FAILED: hydra_ro login"; exit 1; }

step "Playwright (full suite)"
PORT=""
for p in $(seq 3800 3899); do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 || { PORT=$p; break; }; done
[ -n "$PORT" ] || { echo "VERIFY FAILED: no free port in 3800-3899"; exit 1; }
E2E_PORT=$PORT pnpm -C "$ROOT" exec playwright test --reporter=line || { echo "VERIFY FAILED: Playwright"; exit 1; }

echo; echo "VERIFY PASSED: gate, pgTAP, hydra_ro login, Playwright"
