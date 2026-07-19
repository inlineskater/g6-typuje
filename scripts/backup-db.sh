#!/usr/bin/env bash
#
# Off-site logical backup for Rynek Proroctw G6 (hosted Supabase Postgres).
#
# Produces the canonical Supabase 3-file snapshot (roles + schema + data) for a
# fully restorable dump, gzips it, and prunes old backups. This is a SUPPLEMENT
# to Supabase's native backups (Dashboard -> Database -> Backups / PITR), not a
# replacement -- see docs/BACKUPS.md.
#
# SECURITY
#   * Needs the DIRECT database connection string (contains the DB password).
#     Pass it via env only -- NEVER hardcode it, never commit it. This repo is
#     PUBLIC and the dump contains user data, so output goes to ./backups/,
#     which is git-ignored. Do not move dumps into a tracked directory.
#   * Get the URL from: Supabase Dashboard -> Project Settings -> Database ->
#     Connection string -> URI (use the direct 5432 string, or the pooler).
#
# SETUP
#   # macOS/Linux (bash/zsh):
#   export SUPABASE_DB_URL='postgresql://postgres:<password>@db.rjovhmepanwbdgdkvylr.supabase.co:5432/postgres'
#
# USAGE
#   scripts/backup-db.sh                 # write a timestamped snapshot to ./backups/
#   BACKUP_KEEP=30 scripts/backup-db.sh  # keep the 30 most recent (default 14)
#   BACKUP_DIR=/mnt/ext scripts/backup-db.sh
#
# RESTORE (into a fresh/empty project) -- see docs/BACKUPS.md for the full flow:
#   gunzip -k backups/<stamp>.data.sql.gz   # (and .roles / .schema)
#   psql "$SUPABASE_DB_URL" -f backups/<stamp>.roles.sql
#   psql "$SUPABASE_DB_URL" -f backups/<stamp>.schema.sql
#   psql "$SUPABASE_DB_URL" -f backups/<stamp>.data.sql

set -euo pipefail

DB_URL="${SUPABASE_DB_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/backups}"
KEEP="${BACKUP_KEEP:-14}"

if [[ -z "$DB_URL" ]]; then
  echo "ERROR: SUPABASE_DB_URL is not set." >&2
  echo "  export SUPABASE_DB_URL='postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres'" >&2
  exit 1
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "ERROR: the Supabase CLI is not installed (brew install supabase/tap/supabase)." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
PREFIX="$BACKUP_DIR/rynek-$STAMP"

echo "==> Backing up to $PREFIX.*.sql.gz"

# 1) roles, 2) schema (DDL), 3) data -- the canonical restorable Supabase set.
echo "  - roles..."
supabase db dump --db-url "$DB_URL" --role-only -f "$PREFIX.roles.sql"
echo "  - schema..."
supabase db dump --db-url "$DB_URL"             -f "$PREFIX.schema.sql"
echo "  - data..."
supabase db dump --db-url "$DB_URL" --data-only -f "$PREFIX.data.sql"

echo "  - compressing..."
gzip -f "$PREFIX.roles.sql" "$PREFIX.schema.sql" "$PREFIX.data.sql"

SIZE="$(du -ch "$PREFIX".*.sql.gz 2>/dev/null | tail -1 | cut -f1)"
echo "==> Snapshot complete ($SIZE): $(basename "$PREFIX").{roles,schema,data}.sql.gz"

# Retention: keep the newest $KEEP snapshots (by the data file), delete older triples.
if [[ "$KEEP" -gt 0 ]]; then
  mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/rynek-*.data.sql.gz 2>/dev/null | tail -n "+$((KEEP + 1))")
  for data_gz in "${OLD[@]:-}"; do
    [[ -z "$data_gz" ]] && continue
    base="${data_gz%.data.sql.gz}"
    rm -f "$base.data.sql.gz" "$base.schema.sql.gz" "$base.roles.sql.gz"
    echo "==> Pruned old snapshot: $(basename "$base").*"
  done
fi

echo "==> Done. $(ls -1 "$BACKUP_DIR"/rynek-*.data.sql.gz 2>/dev/null | wc -l | tr -d ' ') snapshot(s) retained in $BACKUP_DIR"
