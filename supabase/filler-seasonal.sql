-- „Filler" (filler) — Phase 2 seasonal-game promotion for Rynek Proroctw G6.
-- Run after supabase/filler.sql. Debuts via SEASONAL_OVERRIDES on the week
-- ⚠️ 2026-08-05: this file is DEPLOYED AND ARMED but Filler is scheduled for
-- NO WEEK — the 2026-08-10 slot below was reassigned to „Kulki G6" (a PvP game
-- needs two players online at once, a bad bet for a pre-planned unsupervised
-- week). The season gate means the cron job simply skips; to schedule a Filler
-- week later, add the SEASONAL_OVERRIDES entry + the matching WHEN clause in
-- seasonal_game_for_week(). Nothing here needs to change.
-- starting 2026-08-10 (see index.html + supabase/season-award-gating.sql,
-- which must both be updated in the same deploy as this file).
--
-- Unlike every other seasonal game's promotion, there is no `filler_rounds`
-- table here: `filler_matches`/`filler_match_players` (supabase/filler.sql)
-- ALREADY are the "round" — Filler is server-authoritative for every move
-- (see that file's header comment and docs/filler.md), so a match's full
-- lifecycle (start, moves, finish) already lives there for BOTH the arcade
-- and seasonal contexts. This file only adds what's new for the seasonal
-- side: a scores/weekly-awards pair, the three standard leaderboard views,
-- and the award payout — the same shape every other seasonal game uses.
--
-- The one Edge Function change this requires (in filler-action's
-- finishScoring/scoreOnePlayer) is a single extra INSERT into
-- filler_scores, gated on the match's `arcade_mode` being false (i.e.
-- launched from the seasonal tab, not the „Wszystkie Gry" picker) — see
-- docs/filler.md's Phase 2 section.
--
-- ── WEEKLY RANKING IS A LEAGUE, NOT A HIGH SCORE (2026-08-04) ─────────────
-- Every other seasonal game ranks a player's single best run of the week,
-- which is right for a solo game and WRONG for this one: Filler is the only
-- PvP game in the rotation, and "best single match" means one lucky win ends
-- your week — there is no reason to ever play a second opponent, which is
-- precisely the behaviour this game exists to create.
--
-- So the week ranks accumulated LEAGUE POINTS (public.filler_league_week),
-- built to reward breadth of opposition above all:
--
--   per match : (win ? 100 : 35) + round(match_score / 10)      -- 0..35 bonus
--   × decay   : Nth match against the SAME opponent this week
--               1st 100% · 2nd 70% · 3rd 45% · 4th 25% · 5th 15% · 6th+ 10%
--   + bonus   : 60 × distinct opponents faced
--
-- Losses score. That is deliberate and load-bearing: if losing were worth
-- nothing, the correct play would be to avoid the strong colleagues, and the
-- people most worth playing would get no games. A win is still worth ~3x a
-- loss, so ducking is never profitable.
--
-- The decay plus the distinct-opponent bonus are what make farming one
-- partner pointless — 10 matches against a single opponent is worth far less
-- than 5 against five different ones — and they are also the anti-collusion
-- mechanism, since a two-account pair cannot manufacture distinct opponents
-- and their 5th+ rematch is worth 10%. It composes with the guards already in
-- filler-action (a resigner scores nothing, matches under
-- FILLER_SCORE_MIN_MOVES plies score nothing, and a 20s per-user cooldown
-- sits in front of every insert), so feeding wins by instant-resigning is
-- both rate-limited and decayed into irrelevance.
--
-- ⚠️ The formula lives in exactly ONE place — filler_league_week() — which the
-- current-week view, the all-time view and the Monday payout all call. Do not
-- re-implement it in a view or in the client; the frontend reads the ranked
-- rows straight off filler_current_week.

CREATE OR REPLACE FUNCTION public.filler_week_start(p_ts timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Monday-starting week (Mon..Sun) in Europe/Warsaw.
  SELECT date_trunc('week', p_ts AT TIME ZONE 'Europe/Warsaw')::date;
$$;

CREATE TABLE IF NOT EXISTS public.filler_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id      uuid NOT NULL REFERENCES public.filler_matches(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  week_start    date NOT NULL,
  score         integer NOT NULL CHECK (score >= 0),
  tiles         integer NOT NULL DEFAULT 0 CHECK (tiles >= 0),
  moves_made    integer NOT NULL DEFAULT 0 CHECK (moves_made >= 0),
  won           boolean NOT NULL,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  client_meta   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- One scored row per player per match — a match can only ever finish once,
  -- and finishScoring only ever calls scoreOnePlayer once per human seat.
  UNIQUE (match_id, user_id)
);

-- WHO you played is a first-class ranking input (repeat-opponent decay +
-- distinct-opponent bonus — see the header), so it gets a real indexed,
-- referential column rather than living in client_meta->>'opp' where it
-- started. ON DELETE SET NULL, not CASCADE: if an opponent's profile is ever
-- deleted, your match still happened and must keep its points. Nullable for
-- exactly that case, and filler_league_week() falls back to the match_id as
-- the grouping key so a NULL simply behaves like a one-off opponent instead
-- of silently merging every such match into one bucket.
ALTER TABLE public.filler_scores
  ADD COLUMN IF NOT EXISTS opponent_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.filler_weekly_awards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start    date NOT NULL,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  rank          integer NOT NULL CHECK (rank BETWEEN 1 AND 3),
  score         integer NOT NULL CHECK (score >= 0),
  prize_coins   integer NOT NULL CHECK (prize_coins > 0),
  awarded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, rank),
  UNIQUE (week_start, user_id)
);

CREATE INDEX IF NOT EXISTS filler_scores_week_rank_idx
  ON public.filler_scores(week_start, score DESC, submitted_at ASC);
CREATE INDEX IF NOT EXISTS filler_scores_user_time_idx
  ON public.filler_scores(user_id, submitted_at DESC);
-- Feeds filler_league_week()'s per-(player, opponent) ROW_NUMBER window in
-- exactly the order the window declares, so the ranking is an index scan.
CREATE INDEX IF NOT EXISTS filler_scores_week_user_opp_idx
  ON public.filler_scores(week_start, user_id, opponent_id, submitted_at);
CREATE INDEX IF NOT EXISTS filler_awards_week_idx
  ON public.filler_weekly_awards(week_start DESC, rank ASC);

ALTER TABLE public.filler_scores        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.filler_weekly_awards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "filler_scores_select" ON public.filler_scores;
CREATE POLICY "filler_scores_select" ON public.filler_scores
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "filler_awards_select" ON public.filler_weekly_awards;
CREATE POLICY "filler_awards_select" ON public.filler_weekly_awards
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.filler_scores, public.filler_weekly_awards FROM anon, authenticated;
GRANT SELECT ON public.filler_scores, public.filler_weekly_awards TO authenticated;
-- filler-action's own privileged SUPABASE_DB_URL connection is the only
-- writer, same as every other table in supabase/filler.sql.

-- ── The league table for one week ────────────────────────────────────────
-- THE single definition of the weekly ranking (see the header for the why).
-- The current-week view, the all-time view and award_filler_week() all call
-- this, so the formula can never drift between what players watch during the
-- week and what actually gets paid on Monday.
--
-- The points column is deliberately named `score`: the seasonal podium, the
-- awards table and the shared frontend row-mapping all key on that name, and
-- renaming it here would mean special-casing Filler in five unrelated places
-- to gain nothing.
CREATE OR REPLACE FUNCTION public.filler_league_week(p_week_start date)
RETURNS TABLE (
  rank           integer,
  user_id        uuid,
  nick           text,
  week_start     date,
  score          integer,   -- league points
  matches_played integer,
  wins           integer,
  opponents      integer,   -- distinct humans faced this week
  best_match     integer,   -- best single-match score, shown as a stat only
  submitted_at   timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH scored AS (
    SELECT
      s.user_id, s.nick_snapshot, s.won, s.score, s.submitted_at,
      COALESCE(s.opponent_id, s.match_id) AS opp_key,
      ROW_NUMBER() OVER (
        PARTITION BY s.user_id, COALESCE(s.opponent_id, s.match_id)
        ORDER BY s.submitted_at, s.id
      ) AS nth_vs_opp
    FROM public.filler_scores s
    WHERE s.week_start = p_week_start
  ),
  -- Every column reference in this body is alias-qualified ON PURPOSE: the
  -- RETURNS TABLE columns above (score, user_id, submitted_at, …) are OUT
  -- parameters and share names with columns of filler_scores, and an
  -- unqualified reference to one of those is ambiguous.
  weighted AS (
    SELECT
      sc.user_id, sc.nick_snapshot, sc.won, sc.score, sc.submitted_at, sc.opp_key,
      ((CASE WHEN sc.won THEN 100 ELSE 35 END) + ROUND(sc.score / 10.0))
      * CASE sc.nth_vs_opp
          WHEN 1 THEN 1.00 WHEN 2 THEN 0.70 WHEN 3 THEN 0.45
          WHEN 4 THEN 0.25 WHEN 5 THEN 0.15 ELSE 0.10
        END AS pts
    FROM scored sc
  ),
  agg AS (
    SELECT
      w.user_id,
      -- The nick as of the player's most recent match, so a rename shows up.
      (array_agg(w.nick_snapshot ORDER BY w.submitted_at DESC))[1] AS nick,
      (ROUND(SUM(w.pts)) + 60 * COUNT(DISTINCT w.opp_key))::integer AS points,
      COUNT(*)::integer                          AS matches_played,
      COUNT(*) FILTER (WHERE w.won)::integer     AS wins,
      COUNT(DISTINCT w.opp_key)::integer         AS opponents,
      MAX(w.score)::integer                      AS best_match,
      MIN(w.submitted_at)                        AS first_at
    FROM weighted w
    GROUP BY w.user_id
  )
  -- Ties break on wins, then on who got there first — same "earliest
  -- submission wins" convention every other seasonal game uses.
  SELECT
    (ROW_NUMBER() OVER (ORDER BY a.points DESC, a.wins DESC, a.first_at ASC))::integer,
    a.user_id, a.nick, p_week_start, a.points,
    a.matches_played, a.wins, a.opponents, a.best_match, a.first_at
  FROM agg a
  ORDER BY 1;
$$;

-- DROP, not CREATE OR REPLACE: these views previously exposed a different
-- column list (tiles/moves_made/won from the old best-single-match ranking),
-- and CREATE OR REPLACE VIEW cannot drop or rename a column.
DROP VIEW IF EXISTS public.filler_current_week;
CREATE VIEW public.filler_current_week WITH (security_invoker = true) AS
  SELECT * FROM public.filler_league_week(public.filler_week_start(now()));

-- All-time = each player's BEST WEEK, which is the league analogue of every
-- other game's "best single run ever" (a lifetime sum would just rank by
-- seniority).
DROP VIEW IF EXISTS public.filler_all_time;
CREATE VIEW public.filler_all_time WITH (security_invoker = true) AS
WITH weeks AS (
  SELECT DISTINCT week_start FROM public.filler_scores
),
per_week AS (
  SELECT l.user_id, l.nick, l.week_start, l.score, l.matches_played,
         l.wins, l.opponents, l.best_match, l.submitted_at
  FROM weeks w
  CROSS JOIN LATERAL public.filler_league_week(w.week_start) l
),
best AS (
  SELECT DISTINCT ON (p.user_id)
    p.user_id, p.nick, p.week_start AS best_week_start, p.score,
    p.matches_played, p.wins, p.opponents, p.best_match, p.submitted_at
  FROM per_week p
  ORDER BY p.user_id, p.score DESC, p.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY b.score DESC, b.submitted_at ASC))::integer AS rank,
  b.user_id, b.nick, b.best_week_start, b.score,
  b.matches_played, b.wins, b.opponents, b.best_match, b.submitted_at
FROM best b
ORDER BY rank;

CREATE OR REPLACE VIEW public.filler_recent_awards WITH (security_invoker = true) AS
SELECT id, week_start, user_id, nick_snapshot AS nick, rank, score, prize_coins, awarded_at
FROM public.filler_weekly_awards
ORDER BY week_start DESC, rank ASC;

CREATE OR REPLACE FUNCTION public.award_filler_week(
  p_week_start date DEFAULT public.filler_week_start(now() - interval '7 days')
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_week date := public.filler_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.filler_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, prize_coins
      FROM public.filler_weekly_awards
      WHERE week_start = p_week_start
      ORDER BY rank
    ) a;

    RETURN json_build_object(
      'ok', true, 'already_awarded', true, 'week_start', p_week_start, 'awards', v_awards
    );
  END IF;

  -- Pays the SAME league table players watched all week (see the header) —
  -- filler_league_week() is the one definition, called here rather than
  -- re-implemented, so the podium can't disagree with the payout.
  WITH winners AS (
    SELECT
      l.user_id, l.nick AS nick_snapshot, l.rank, l.score,
      CASE l.rank WHEN 1 THEN 1000 WHEN 2 THEN 500 WHEN 3 THEN 200 END AS prize_coins
    FROM public.filler_league_week(p_week_start) l
    WHERE l.rank <= 3
  ),
  inserted AS (
    INSERT INTO public.filler_weekly_awards (week_start, user_id, nick_snapshot, rank, score, prize_coins)
    SELECT p_week_start, user_id, nick_snapshot, rank, score, prize_coins
    FROM winners
    ON CONFLICT DO NOTHING
    RETURNING *
  ),
  credited AS (
    UPDATE public.profiles p
       SET coins = p.coins + i.prize_coins
      FROM inserted i
     WHERE p.id = i.user_id
     RETURNING i.prize_coins
  )
  SELECT COUNT(*)::integer, COALESCE(SUM(prize_coins), 0)::integer
    INTO v_inserted_count, v_total_prize
  FROM credited;

  SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
    INTO v_awards
  FROM (
    SELECT rank, nick_snapshot AS nick, score, prize_coins
    FROM public.filler_weekly_awards
    WHERE week_start = p_week_start
    ORDER BY rank
  ) a;

  RETURN json_build_object(
    'ok', true, 'already_awarded', false, 'week_start', p_week_start,
    'awards_created', v_inserted_count, 'coins_awarded', v_total_prize, 'awards', v_awards
  );
END;
$$;

REVOKE ALL ON FUNCTION public.filler_week_start(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.filler_league_week(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_filler_week(date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.filler_week_start(timestamptz) TO authenticated;
-- Needed by authenticated readers because filler_current_week/_all_time are
-- security_invoker views over this function. It is STABLE and not SECURITY
-- DEFINER, so RLS on filler_scores still applies to the caller.
GRANT EXECUTE ON FUNCTION public.filler_league_week(date) TO authenticated;
GRANT SELECT ON public.filler_current_week, public.filler_all_time, public.filler_recent_awards TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'filler_scores'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.filler_scores;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'filler_weekly_awards'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.filler_weekly_awards;
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Season-gated weekly award (the gate lives in seasonal_game_for_week(); the
-- cron command is only parsed at run time, so scheduling works even before
-- the updated season-award-gating.sql is applied — but apply it before the
-- 2026-08-10 debut Monday).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule(jobname)
    FROM cron.job
    WHERE jobname = 'filler_weekly_awards';

    PERFORM cron.schedule(
      'filler_weekly_awards',
      '0 22,23 * * 0',
      $cron$SELECT CASE
        WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
          THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
        WHEN public.seasonal_game_for_week(public.filler_week_start(now() - interval '7 days')) = 'filler'
          THEN public.award_filler_week(public.filler_week_start(now() - interval '7 days'))
          ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$cron$
    );
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
