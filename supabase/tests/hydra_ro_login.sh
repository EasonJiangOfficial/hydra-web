#!/usr/bin/env bash
# Proves hydra_ro's role settings on a REAL login (pgTAP can only emulate them with SET ROLE).
# Local Supabase only: gives hydra_ro a throwaway login for a few seconds, then takes it back.
# Usage: bash supabase/tests/hydra_ro_login.sh [db-url]
#   default: $HYDRA_DB_URL, else the local stack in config.toml (CI runs `supabase db start` on it)
set -euo pipefail
DB="${1:-${HYDRA_DB_URL:-postgresql://postgres:postgres@127.0.0.1:55422/postgres}}"
PW="ro-$RANDOM-$RANDOM"
HOSTPART="${DB#*@}"
RO="postgresql://hydra_ro:${PW}@${HOSTPART}"

restore() { psql "$DB" -qAtc "alter role hydra_ro nologin password null" >/dev/null; }
trap restore EXIT
psql "$DB" -qAtc "alter role hydra_ro login password '${PW}'" >/dev/null

fail=0
check() { # name, expected sqlstate or value, sql
  local out
  out=$(psql "$RO" -qAt -v VERBOSITY=sqlstate -c "$3" 2>&1 || true)
  if [[ "$out" == *"$2"* ]]; then echo "ok   $1"; else echo "FAIL $1: $out"; fail=1; fi
}
check "statement_timeout is 5s" "5s" "show statement_timeout"
check "transactions are read-only" "on" "show default_transaction_read_only"
check "reads entities" "3" "select count(*) from public.entities"
check "write is refused" "25006" "update public.entities set name = 'x'"
check "pg_sleep(6) is cancelled" "57014" "select pg_sleep(6)"
exit $fail
