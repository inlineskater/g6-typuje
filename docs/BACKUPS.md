# Backups — Rynek Proroctw G6

All live data (profiles, coins, trades, markets, poker/casino history, farm state,
signatures, …) lives in the hosted Supabase Postgres project
`rjovhmepanwbdgdkvylr`. The SQL in `supabase/*.sql` is only the *schema/logic* and
is already version-controlled — it is **not** a backup of the data. Losing the
project (accidental `reset-data.sql`, a bad migration, or account loss) loses
every player's coins and history unless there is a data backup.

There are two layers. Use both.

## 1. Native Supabase backups (primary — do this first)

This is the authoritative, hands-off backup and the real answer for a hosted DB.

- **Dashboard → Database → Backups.** On the **Pro** plan Supabase takes
  automatic **daily** logical backups (7-day retention) with no setup.
- **Point-in-Time Recovery (PITR)** is an add-on that lets you restore to any
  second within the retention window — worth enabling given the app mints/burns
  coins continuously.
- On the **Free** plan there are **no automated backups** — this is the main gap
  the script below fills, but upgrading is the more robust fix.

Action: open the dashboard, confirm which plan/backups are active, and enable
daily backups (+ PITR if the budget allows).

## 2. Off-site snapshot script (supplementary)

`scripts/backup-db.sh` produces a fully restorable **roles + schema + data**
snapshot using the Supabase CLI (already installed; no `pg_dump` needed), gzips
it, and prunes old copies. Run it manually before risky migrations and/or on a
schedule for an independent off-Supabase copy.

```bash
# The direct connection string — Dashboard → Project Settings → Database →
# Connection string → URI. Contains the DB password; keep it out of the repo.
export SUPABASE_DB_URL='postgresql://postgres:<password>@db.rjovhmepanwbdgdkvylr.supabase.co:5432/postgres'

scripts/backup-db.sh                 # → ./backups/rynek-<stamp>.{roles,schema,data}.sql.gz
BACKUP_KEEP=30 scripts/backup-db.sh  # keep 30 snapshots instead of the default 14
```

> ⚠️ **The GitHub repo is public and dumps contain user data.** Output goes to
> `./backups/`, which is git-ignored. Never move a dump into a tracked folder,
> and never paste one into an issue/PR. For an off-machine copy, upload to
> private storage (e.g. an encrypted drive or a private bucket) — not git.

### Scheduling (optional)

- **Local (cron), simplest:** run daily at 03:00 with the env var exported in the
  cron environment:
  ```
  0 3 * * *  SUPABASE_DB_URL='postgresql://…' /path/to/rynek-proroctw/scripts/backup-db.sh >> ~/rynek-backup.log 2>&1
  ```
  Downside: only runs while that machine is on.
- **GitHub Actions:** possible with `SUPABASE_DB_URL` stored as a repo secret, but
  the workflow must upload the dump as a **private artifact / to external
  storage** — it must **never** commit the dump back to this public repo. Given
  that constraint, native Supabase backups are the better scheduled option.

## Restore

Into a fresh/empty Supabase project (or the same one after a wipe), in order:

```bash
gunzip -k backups/rynek-<stamp>.roles.sql.gz
gunzip -k backups/rynek-<stamp>.schema.sql.gz
gunzip -k backups/rynek-<stamp>.data.sql.gz

psql "$SUPABASE_DB_URL" -f backups/rynek-<stamp>.roles.sql
psql "$SUPABASE_DB_URL" -f backups/rynek-<stamp>.schema.sql
psql "$SUPABASE_DB_URL" -f backups/rynek-<stamp>.data.sql
```

Notes:
- `auth.users` (login accounts) is managed by Supabase Auth and is covered by the
  **native** backups, not this logical `public`-schema dump. A full disaster
  recovery therefore relies on native backups for auth + this dump (or native) for
  game data. Test a restore into a throwaway project at least once so it isn't the
  first time under pressure.
- After restoring, run `NOTIFY pgrst, 'reload schema';` (or restart the API) so
  PostgREST picks up the restored schema.
