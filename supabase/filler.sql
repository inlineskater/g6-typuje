-- „Filler" — 1v1 territory flood-fill (the classic 1990 Gamos Ltd DOS game,
-- international release "7 Colors"). Two players start in opposite corners of
-- a colored-tile grid; each turn the active player picks a color and every
-- tile of that color connected to their territory joins it; majority wins.
--
-- SERVER-AUTHORITATIVE FOR EVERY MOVE (Poker/Roulette/Wheel model), NOT the
-- client-replayed-tick-simulation pattern every other seasonal/arcade game in
-- this repo uses (Snake/Tetris/Healer Dungeon/etc.). Reasons, in order:
--   1. It's PvP, so a live shared authority is unavoidable anyway.
--   2. Moves are infrequent discrete color-picks, not a 50ms physics tick —
--      a live round-trip per move is cheap and correct.
--   3. It unifies bot-mode and PvP-mode under ONE Edge Function / ONE pair of
--      tables: a "vs bot" match is just a 2-seat match where seat 1 is
--      (user_id NULL, is_bot true) — exactly Poker's bots.sql trick.
--   4. There is NO hidden information — the whole board is public to both
--      players at all times — so unlike Poker (hidden deck + per-caller
--      sanitization) or Mines/Crash (separate *_round_secrets tables),
--      Filler needs no secrets table at all.
-- Net effect: zero parity contracts. The client never runs an authoritative
-- sim; it only renders whatever board state the server returns. There is
-- deliberately no scripts/filler-parity.mjs — nothing to keep in sync.
--
-- Scoring: only PvP results ever reach public.arcade_scores (game_type =
-- 'filler'). Bot matches are pure practice and never score, win or lose —
-- record_arcade_score's per-user-per-game rate-limit doesn't apply here
-- (filler-action writes arcade_scores directly, bypassing that RPC, because
-- it is already authoritative for the whole match), so scoring a free,
-- risk-free, unlimited-attempts bot win would be farmable forever against a
-- best-per-user-ever leaderboard — scaling the score down doesn't close that,
-- only excluding it does.
-- ⚠️ supabase/arcade.sql needs ZERO changes for this: 'filler' is
-- deliberately absent from pay_arcade_entry's allowlist and
-- record_arcade_score's score-cap CASE, so a forged client call to
-- self-report a Filler score fails cleanly with invalid_game_type —
-- filler-action's own privileged SUPABASE_DB_URL connection (same role
-- Poker/Wheel already write `profiles`/their own tables through, unaffected
-- by RLS: there is no FORCE ROW LEVEL SECURITY anywhere in this repo) is
-- provably the only writer of game_type='filler' rows.
--
-- Run after supabase/schema.sql and supabase/arcade.sql. Idempotent.

CREATE TABLE IF NOT EXISTS public.filler_matches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status           text NOT NULL DEFAULT 'waiting'
                     CHECK (status IN ('waiting','active','finished','cancelled')),
  -- What was REQUESTED (play_bot vs find_opponent) vs what was ACTUALLY got.
  -- A 'pvp' match that times out to a bot fallback must behave like a bot
  -- match from then on (no score, the abandon rule applies) — scoring and
  -- the abandon rule key on opponent_kind, never on mode.
  mode             text NOT NULL CHECK (mode IN ('bot','pvp')),
  opponent_kind    text CHECK (opponent_kind IN ('bot','human')), -- NULL while waiting
  -- Whether this match was launched from the arcade picker or (Phase 2) the
  -- seasonal tab. Decided once at creation from the action context, never
  -- trusted from the request body afterward. Phase 1: always true.
  arcade_mode      boolean NOT NULL DEFAULT true,
  width            smallint NOT NULL DEFAULT 31 CHECK (width  BETWEEN 6 AND 40),
  height           smallint NOT NULL DEFAULT 17 CHECK (height BETWEEN 6 AND 40),
  color_count      smallint NOT NULL DEFAULT 7  CHECK (color_count BETWEEN 3 AND 8),
  seed             bigint NOT NULL,                      -- audit/repro only; board is stored verbatim
  cells            text NOT NULL,                        -- one char per tile, '0'..'7' = color
  owners           text NOT NULL,                         -- one char per tile: '.', '0', '1'
  current_seat     smallint CHECK (current_seat IN (0,1)),      -- NULL while waiting/finished
  move_no          integer NOT NULL DEFAULT 0 CHECK (move_no >= 0), -- optimistic-concurrency token
  moves            text NOT NULL DEFAULT '',              -- one color digit per applied ply
  last_seat        smallint CHECK (last_seat IN (0,1)),
  last_color       smallint,
  last_gain        smallint NOT NULL DEFAULT 0,
  turn_deadline    timestamptz,                            -- set only once status='active'
  queue_expires_at timestamptz,                            -- 'waiting' pvp matches: bot-fallback timer
  winner_seat      smallint CHECK (winner_seat IN (0,1)),   -- NULL = abandoned/cancelled (never a draw:
                                                             -- default 21x27=567 tiles is odd)
  end_reason       text CHECK (end_reason IN
                     ('majority','partitioned','move_cap','resigned','abandoned','cancelled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT filler_matches_cells_len  CHECK (char_length(cells)  = width * height),
  CONSTRAINT filler_matches_owners_len CHECK (char_length(owners) = width * height),
  CONSTRAINT filler_matches_moves_len  CHECK (char_length(moves)  = move_no)
);

CREATE TABLE IF NOT EXISTS public.filler_match_players (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id      uuid NOT NULL REFERENCES public.filler_matches(id) ON DELETE CASCADE,
  seat          smallint NOT NULL CHECK (seat IN (0,1)),
  user_id       uuid REFERENCES public.profiles(id) ON DELETE CASCADE, -- NULL for bots
  is_bot        boolean NOT NULL DEFAULT false,
  bot_nick      text,
  nick_snapshot text NOT NULL,
  color         smallint,                                  -- current territory color
  tiles         integer  NOT NULL DEFAULT 0 CHECK (tiles >= 0),
  moves_made    integer  NOT NULL DEFAULT 0 CHECK (moves_made >= 0),
  timeouts      smallint NOT NULL DEFAULT 0,                -- consecutive auto-played turns;
                                                             -- resets to 0 on a real move; drives
                                                             -- the abandon rule (>=3 vs a bot)
  score         integer,                                    -- NULL for bots and until match end
  -- Defense in depth for "one open (waiting/active) match per user": this
  -- flag is maintained by a TRIGGER (below), not application code, so a
  -- future admin tool or rematch feature can't silently violate the
  -- invariant — a violation surfaces as a clean, recoverable 23505 instead.
  active        boolean NOT NULL DEFAULT true,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, seat),
  UNIQUE (match_id, user_id),   -- NULLs are distinct → two bot seats never collide (bots.sql shape)
  CONSTRAINT filler_players_bot_shape CHECK (
    (is_bot AND user_id IS NULL) OR (NOT is_bot AND user_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS filler_players_one_open_per_user
  ON public.filler_match_players(user_id) WHERE active AND user_id IS NOT NULL;

-- Keeps filler_match_players.active in sync with its match's status, so the
-- one-open-match constraint above holds even if a future code path forgets
-- to maintain it explicitly.
CREATE OR REPLACE FUNCTION public.filler_sync_players_active()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('finished', 'cancelled') AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    UPDATE public.filler_match_players SET active = false, updated_at = now()
     WHERE match_id = NEW.id AND active;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS filler_matches_sync_active ON public.filler_matches;
CREATE TRIGGER filler_matches_sync_active
  AFTER INSERT OR UPDATE OF status ON public.filler_matches
  FOR EACH ROW EXECUTE FUNCTION public.filler_sync_players_active();

-- FIFO queue scan (find_opponent) + the waiting→bot-fallback sweep.
CREATE INDEX IF NOT EXISTS filler_matches_waiting_idx
  ON public.filler_matches (created_at) WHERE status = 'waiting';
-- Lazy turn-timeout sweep.
CREATE INDEX IF NOT EXISTS filler_matches_active_deadline_idx
  ON public.filler_matches (turn_deadline) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS filler_matches_finished_idx
  ON public.filler_matches (finished_at DESC) WHERE status = 'finished';
CREATE INDEX IF NOT EXISTS filler_match_players_match_idx
  ON public.filler_match_players (match_id, seat);
CREATE INDEX IF NOT EXISTS filler_match_players_user_idx
  ON public.filler_match_players (user_id, joined_at DESC) WHERE user_id IS NOT NULL;

ALTER TABLE public.filler_matches       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.filler_match_players ENABLE ROW LEVEL SECURITY;

-- Communal, like poker_seats/wheel_rounds: the board carries no hidden
-- state, so every authenticated player may read every match — spectating a
-- Filler match costs nothing to allow.
DROP POLICY IF EXISTS "filler_matches_select" ON public.filler_matches;
CREATE POLICY "filler_matches_select" ON public.filler_matches
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "filler_match_players_select" ON public.filler_match_players;
CREATE POLICY "filler_match_players_select" ON public.filler_match_players
  FOR SELECT TO authenticated USING (true);

-- No client writes anywhere — every mutation goes through filler-action's own
-- privileged SUPABASE_DB_URL connection.
REVOKE ALL ON public.filler_matches, public.filler_match_players FROM anon, authenticated;
GRANT SELECT ON public.filler_matches, public.filler_match_players TO authenticated;
-- Belt-and-suspenders: the owning role (postgres, via SUPABASE_DB_URL) already
-- has this implicitly, but grant it explicitly too so a future ownership
-- change can't silently turn match-finish into a 500. See filler-action's
-- finishMatch, which wraps this insert so a failure here is non-fatal anyway.
GRANT SELECT, INSERT ON public.arcade_scores TO postgres;

-- Realtime doorbell only — the payload is never trusted, every client
-- re-fetches the authoritative snapshot via filler-action's `state` action.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime'
                   AND schemaname='public' AND tablename='filler_matches') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.filler_matches;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime'
                   AND schemaname='public' AND tablename='filler_match_players') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.filler_match_players;
    END IF;
  END IF;
END;
$$;

-- Minimal pg_cron BACKSTOP for the truly-forgotten case: everyone involved
-- closed their tab and NOBODY ever calls filler-action again, so the on-read
-- sweep (which only runs as a side effect of some request, by anyone, to
-- filler-action) never fires. The on-read sweep in the Edge Function already
-- handles the common cases smartly (bot fallback, turn-timeout auto-play via
-- the real bot heuristic) within seconds of actual traffic — this cron is
-- deliberately dumber and only exists to catch what that never sees at all.
-- "One open match per user" means a stuck match costs two SPECIFIC players
-- their ability to play at all, so it shouldn't depend on some unrelated
-- player happening to open Filler first. pg_cron is already a dependency in
-- half this repo's SQL files; this is one more schedule, not a new
-- architectural piece — and a plain SQL function here (not an HTTP call out
-- to the Edge Function) avoids needing project-ref/secret app settings or
-- loosening verify_jwt. Thresholds are deliberately long (30 min) since
-- anything with real traffic is already healed well before this ever runs.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.filler_cron_abandon_stale()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Nobody ever joined a queued match.
  UPDATE public.filler_matches
     SET status = 'cancelled', end_reason = 'abandoned', finished_at = now(),
         current_seat = NULL, turn_deadline = NULL, updated_at = now()
   WHERE status = 'waiting' AND created_at < now() - interval '30 minutes';

  -- An active match nobody has polled in a long time (the on-read sweep in
  -- filler-action would have healed anything actually being watched).
  UPDATE public.filler_matches
     SET status = 'cancelled', end_reason = 'abandoned', finished_at = now(),
         current_seat = NULL, turn_deadline = NULL, updated_at = now()
   WHERE status = 'active' AND turn_deadline < now() - interval '30 minutes';
END;
$$;

REVOKE ALL ON FUNCTION public.filler_cron_abandon_stale() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = 'filler_sweep_abandoned';
    PERFORM cron.schedule(
      'filler_sweep_abandoned',
      '*/10 * * * *',
      $cron$ select public.filler_cron_abandon_stale(); $cron$
    );
  END IF;
END;
$$;

-- Widen the board-size bounds/defaults for the 2026-08-02 resize (13x11x6 →
-- 31x17x7 — see docs/filler.md). CREATE TABLE IF NOT EXISTS above is a no-op
-- against an already-created table, so on a live project the OLD
-- BETWEEN-6-AND-24 CHECK would otherwise reject every new 31-wide match.
-- Existing 13x11 rows stay valid (13/11 are still inside 6..40) and keep
-- rendering at their own stored width/height — nothing here touches rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'filler_matches_width_check') THEN
    ALTER TABLE public.filler_matches DROP CONSTRAINT filler_matches_width_check;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'filler_matches_height_check') THEN
    ALTER TABLE public.filler_matches DROP CONSTRAINT filler_matches_height_check;
  END IF;
  ALTER TABLE public.filler_matches ADD CONSTRAINT filler_matches_width_check  CHECK (width  BETWEEN 6 AND 40);
  ALTER TABLE public.filler_matches ADD CONSTRAINT filler_matches_height_check CHECK (height BETWEEN 6 AND 40);
  ALTER TABLE public.filler_matches ALTER COLUMN width        SET DEFAULT 31;
  ALTER TABLE public.filler_matches ALTER COLUMN height       SET DEFAULT 17;
  ALTER TABLE public.filler_matches ALTER COLUMN color_count  SET DEFAULT 7;
END;
$$;

-- 2026-08-04 diamond-lattice reshape (31x17 square grid → 21x27 rendered as
-- interlocking rhombi; bot practice matches 15x19 — see docs/filler.md).
-- Column DEFAULTS only: every size already sits inside the 6..40 CHECKs above,
-- and filler-action always inserts width/height explicitly, so this is about
-- keeping a hand-written INSERT or a psql inspection honest rather than
-- unblocking anything. Existing rows keep their own stored width/height and
-- still render correctly — the client reads dimensions off the match row.
DO $$
BEGIN
  ALTER TABLE public.filler_matches ALTER COLUMN width  SET DEFAULT 21;
  ALTER TABLE public.filler_matches ALTER COLUMN height SET DEFAULT 27;
END;
$$;

NOTIFY pgrst, 'reload schema';
