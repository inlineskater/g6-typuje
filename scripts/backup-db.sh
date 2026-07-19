#!/usr/bin/env bash
#
# Off-site logical backup for Rynek Proroctw G6 (hosted Supabase Postgres).
#
# Dumps the `public` schema (all game data: profiles, coins, trades, markets,
# farm, poker/casino history, signatures, …) with pg_dump, gzips it, and prunes
# old copies. This is a SUPPLEMENT to Supabase's native backups (Dashboard ->
# Database -> Backups / PITR), which are the primary/authoritative backup and
# also cover auth.users — see docs/BACKUPS.md.
#
# REQUIREMENTS
#   * pg_dump on PATH. It is NOT bundled with the Supabase CLI, and the CLI's
#     own `supabase db dump` needs Docker — this script avoids both by calling
#     pg_dump directly. Install the client only (no server, no Docker):
#         brew install libpq && brew link --force libpq      # macOS
#   * The DIRECT database connection string in SUPABASE_DB_URL (it contains the
#     DB password). Pass it via env only — NEVER hardcode/commit it. This repo
#     is PUBLIC and the dump contains user data, so output goes to ./backups/,
#     which is git-ignored. Do not move dumps into a tracked directory.
#     Get the URL from: Supabase Dashboard -> Project Settings -> Database ->
#     Connection string -> URI (direct 5432, or the pooler).
#
# USAGE
#   export SUPABASE_DB_URL='postgresql://postgres:<password>@db.rjovhmepanwbdgdkvylr.supabase.co:5432/postgres'
#   scripts/backup-db.sh                 # -> ./backups/rynek-<stamp>.sql.gz
#   BACKUP_KEEP=30 scripts/backup-db.sh  # keep 30 snapshots (default 14)
#
# RESTORE (into a fresh/empty project):
#   gunzip -k backups/rynek-<stamp>.sql.gz
#   psql "$SUPABASE_DB_URL" -f backups/rynek-<stamp>.sql

set -euo pipefail

DB_URL="${SUPABASE_DB_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/backups}"
KEEP="${BACKUP_KEEP:-14}"

mkdir -p "$BACKUP_DIR"

# Once-per-day catch-up guard. The launchd job fires at 03:00, on wake, AND at
# every login (RunAtLoad) so a run missed while the Mac was off/asleep is picked
# up the next time it's on. This guard makes those extra triggers safe: if today
# already has a snapshot, skip. So you get at most one backup per calendar day,
# and never a missed day as long as the Mac is on at some point that day.
# Checked before the credential checks so a "done today" skip needs nothing set.
# Override with BACKUP_FORCE=1 (e.g. for a manual/test run).
TODAY="$(date +%Y%m%d)"
if [[ -z "${BACKUP_FORCE:-}" ]] && compgen -G "$BACKUP_DIR/rynek-$TODAY-*.sql.gz" >/dev/null; then
  echo "==> A backup for today ($TODAY) already exists — skipping. Set BACKUP_FORCE=1 to override."
  exit 0
fi

if [[ -z "$DB_URL" ]]; then
  echo "ERROR: SUPABASE_DB_URL is not set." >&2
  echo "  export SUPABASE_DB_URL='postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres'" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not found. Install the Postgres client (no Docker needed):" >&2
  echo "  brew install libpq && brew link --force libpq   # macOS" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/rynek-$STAMP.sql"

echo "==> Dumping public schema to $OUT.gz"
# --no-owner/--no-privileges keep the dump portable across projects/roles.
pg_dump "$DB_URL" --schema=public --no-owner --no-privileges -f "$OUT"
gzip -f "$OUT"

echo "==> Snapshot complete ($(du -h "$OUT.gz" | cut -f1)): $(basename "$OUT").gz"

# Retention: keep the newest $KEEP snapshots, delete older ones.
if [[ "$KEEP" -gt 0 ]]; then
  mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/rynek-*.sql.gz 2>/dev/null | tail -n "+$((KEEP + 1))")
  for old in "${OLD[@]:-}"; do
    [[ -z "$old" ]] && continue
    rm -f "$old"
    echo "==> Pruned old snapshot: $(basename "$old")"
  done
fi

echo "==> Done. $(ls -1 "$BACKUP_DIR"/rynek-*.sql.gz 2>/dev/null | wc -l | tr -d ' ') snapshot(s) in $BACKUP_DIR"
