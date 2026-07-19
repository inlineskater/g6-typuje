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

`scripts/backup-db.sh` dumps the **`public` schema** (all game data) with
`pg_dump`, gzips it, and prunes old copies. Run it manually before risky
migrations and/or on a schedule for an independent off-Supabase copy.

Requires `pg_dump` on PATH. It is **not** bundled with the Supabase CLI, and the
CLI's own `supabase db dump` needs **Docker** — this script avoids both by
calling `pg_dump` directly. Install just the client (no server, no Docker):

```bash
brew install libpq && brew link --force libpq   # macOS

# Direct connection string — Dashboard → Project Settings → Database →
# Connection string → URI. Contains the DB password; keep it out of the repo.
export SUPABASE_DB_URL='postgresql://postgres:<password>@db.rjovhmepanwbdgdkvylr.supabase.co:5432/postgres'

scripts/backup-db.sh                 # → ./backups/rynek-<stamp>.sql.gz
BACKUP_KEEP=30 scripts/backup-db.sh  # keep 30 snapshots instead of the default 14
```

> ⚠️ **The GitHub repo is public and dumps contain user data.** Output goes to
> `./backups/`, which is git-ignored. Never move a dump into a tracked folder,
> and never paste one into an issue/PR. For an off-machine copy, upload to
> private storage (e.g. an encrypted drive or a private bucket) — not git.

### Scheduling — macOS launchd (installed)

A launchd agent is installed at `~/Library/LaunchAgents/com.rynek-proroctw.backup.plist`
(reference copy committed at `scripts/com.rynek-proroctw.backup.plist`). It runs
`scripts/backup-db.sh` **daily at 03:00** — and on the next wake if the Mac was
asleep. To activate it, one-time:

1. Install pg_dump (no Docker):
   ```bash
   brew install libpq && brew link --force libpq
   ```
2. Create the secret env file (holds the DB password — kept out of the repo, in
   your home dir, sourced by the job) and lock it down:
   ```bash
   printf "export SUPABASE_DB_URL='postgresql://postgres:<pw>@db.rjovhmepanwbdgdkvylr.supabase.co:5432/postgres'\n" > ~/.rynek-backup.env
   chmod 600 ~/.rynek-backup.env
   ```
   (Connection string: Dashboard → Project Settings → Database → Connection string → URI.)
3. Load and test it once:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.rynek-proroctw.backup.plist
   launchctl start com.rynek-proroctw.backup     # run now instead of waiting for 03:00
   tail -20 ~/.rynek-backup.log                   # check output
   ls -lh backups/                                # confirm rynek-<stamp>.sql.gz appeared
   ```

Stop/remove: `launchctl unload ~/Library/LaunchAgents/com.rynek-proroctw.backup.plist`.

> Caveats vs native backups: runs only while this Mac is on, no point-in-time
> recovery, and it dumps only the `public` schema — **login accounts (`auth.users`)
> are not covered**. It's game-data insurance, not full disaster recovery.

- **GitHub Actions** is also possible (store `SUPABASE_DB_URL` as a repo secret,
  upload the dump as a private artifact — **never** commit it to this public repo),
  but the launchd job above is simpler.

## Restore

Into a fresh/empty Supabase project (or the same one after a wipe), in order:

```bash
gunzip -k backups/rynek-<stamp>.sql.gz
psql "$SUPABASE_DB_URL" -f backups/rynek-<stamp>.sql
```

Notes:
- `auth.users` (login accounts) is managed by Supabase Auth and is covered by the
  **native** backups, not this logical `public`-schema dump. A full disaster
  recovery therefore relies on native backups for auth + this dump (or native) for
  game data. Test a restore into a throwaway project at least once so it isn't the
  first time under pressure.
- After restoring, run `NOTIFY pgrst, 'reload schema';` (or restart the API) so
  PostgREST picks up the restored schema.
