-- „Saper Maraton" (saper) seasonal game support for Rynek Proroctw G6.
--
-- Minesweeper, the one office classic the rotation never had — but not a single
-- board you pick at for five minutes. It is a NINETY SECOND marathon over a
-- stream of small boards on a five-rung ladder (6×6/5 mines up to 9×9/16).
-- Clear a board and the next one deals instantly, one rung harder; hit a mine
-- and you lose that board plus five seconds off the clock, but NOT the run.
-- That last rule is the whole design: Minesweeper's worst moment is the forced
-- 50/50 guess, and a marathon that ended on one would be miserable to play.
--
-- Scoring per cleared board: 100 + 40×rung, plus a speed bonus that decays over
-- 18 s, plus 25 per consecutive clear (capped at 5). A good human round lands
-- near 2200; a deducing bot driven at ten moves a second tops out around 8000,
-- which is why the cap is 9999 (see scripts/saper-balance.mjs).
--
-- ANTI-CHEAT. Minesweeper over a seed the client already holds is exactly what
-- an offline solver is good at. The guard is the clock rather than „Kulki G6"'s
-- per-move minimum: the round IS a tick counter, and saper-action requires a
-- submitted round to have taken at least as much wall clock as the ticks it
-- claims to have simulated. Forging a full 1800-tick log costs 90 real seconds.
--
-- Run after supabase/schema.sql and supabase/hero-items.sql.
-- After running this file:
--   • re-run supabase/season-award-gating.sql (updated with the `saper`
--     rotation entry and the 2026-08-24 override) so seasonal_game_for_week()
--     knows the game — without it the week is played and NOBODY IS PAID;
--   • re-run supabase/arcade.sql (updated to whitelist 'saper' and cap it at
--     9999) so the free „Wszystkie Gry" path works too.

CREATE OR REPLACE FUNCTION public.saper_week_start(p_ts timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Monday-starting week (Mon..Sun) in Europe/Warsaw.
  SELECT date_trunc('week', p_ts AT TIME ZONE 'Europe/Warsaw')::date;
$$;

CREATE TABLE IF NOT EXISTS public.saper_rounds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  seed          integer NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.saper_scores (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id       uuid NOT NULL UNIQUE REFERENCES public.saper_rounds(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot  text NOT NULL,
  week_start     date NOT NULL,
  score          integer NOT NULL CHECK (score >= 0),
  boards_cleared integer NOT NULL DEFAULT 0 CHECK (boards_cleared >= 0),
  boards_dealt   integer NOT NULL DEFAULT 0 CHECK (boards_dealt >= 0),
  booms          integer NOT NULL DEFAULT 0 CHECK (booms >= 0),
  best_streak    integer NOT NULL DEFAULT 0 CHECK (best_streak >= 0),
  cells_opened   integer NOT NULL DEFAULT 0 CHECK (cells_opened >= 0),
  moves          integer NOT NULL DEFAULT 0 CHECK (moves >= 0),
  duration_ms    integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  -- Carries the share of dealt boards actually disarmed. Every seasonal scores
  -- table has an `accuracy` column and index.html's SEASON_LIVE_DEFAULT
  -- tiebreaks the live podium on it, so the name is fixed even though the
  -- quantity is game-specific.
  accuracy       numeric(5,2) NOT NULL DEFAULT 0 CHECK (accuracy >= 0 AND accuracy <= 100),
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  client_meta    jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.saper_weekly_awards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start    date NOT NULL,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  rank          integer NOT NULL CHECK (rank BETWEEN 1 AND 3),
  score         integer NOT NULL CHECK (score >= 0),
  duration_ms   integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  prize_coins   integer NOT NULL CHECK (prize_coins > 0),
  awarded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, rank),
  UNIQUE (week_start, user_id)
);

CREATE INDEX IF NOT EXISTS saper_rounds_user_time_idx
  ON public.saper_rounds(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS saper_rounds_expires_idx
  ON public.saper_rounds(expires_at)
  WHERE submitted_at IS NULL;

CREATE INDEX IF NOT EXISTS saper_scores_week_rank_idx
  ON public.saper_scores(week_start, score DESC, submitted_at ASC);

CREATE INDEX IF NOT EXISTS saper_scores_user_time_idx
  ON public.saper_scores(user_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS saper_awards_week_idx
  ON public.saper_weekly_awards(week_start DESC, rank ASC);

ALTER TABLE public.saper_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saper_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saper_weekly_awards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "saper_rounds_select_own" ON public.saper_rounds;
CREATE POLICY "saper_rounds_select_own" ON public.saper_rounds
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "saper_scores_select" ON public.saper_scores;
CREATE POLICY "saper_scores_select" ON public.saper_scores
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "saper_awards_select" ON public.saper_weekly_awards;
CREATE POLICY "saper_awards_select" ON public.saper_weekly_awards
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.saper_rounds, public.saper_scores, public.saper_weekly_awards
  FROM anon, authenticated;
GRANT SELECT ON public.saper_rounds, public.saper_scores, public.saper_weekly_awards
  TO authenticated;

CREATE OR REPLACE VIEW public.saper_current_week WITH (security_invoker = true) AS
WITH current_week AS (
  SELECT public.saper_week_start(now()) AS week_start
),
round_counts AS (
  SELECT user_id, week_start, COUNT(*)::integer AS rounds_played
  FROM public.saper_scores
  GROUP BY user_id, week_start
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.week_start,
    s.score,
    COALESCE((s.client_meta->>'base_score')::int, s.score) AS base_score,
    COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0) AS item_bonus,
    s.boards_cleared,
    s.boards_dealt,
    s.booms,
    s.best_streak,
    s.cells_opened,
    s.moves,
    s.duration_ms,
    s.accuracy,
    s.submitted_at,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.saper_scores s
  JOIN current_week cw ON cw.week_start = s.week_start
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id AND rc.week_start = s.week_start
  ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, submitted_at ASC))::integer AS rank,
  user_id,
  nick,
  week_start,
  score,
  boards_cleared,
  boards_dealt,
  booms,
  best_streak,
  cells_opened,
  moves,
  duration_ms,
  accuracy,
  rounds_played,
  submitted_at,
  base_score,
  item_bonus
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.saper_all_time WITH (security_invoker = true) AS
WITH round_counts AS (
  SELECT user_id, COUNT(*)::integer AS rounds_played
  FROM public.saper_scores
  GROUP BY user_id
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.week_start AS best_week_start,
    s.score,
    COALESCE((s.client_meta->>'base_score')::int, s.score) AS base_score,
    COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0) AS item_bonus,
    s.boards_cleared,
    s.boards_dealt,
    s.booms,
    s.best_streak,
    s.cells_opened,
    s.moves,
    s.duration_ms,
    s.accuracy,
    s.submitted_at,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.saper_scores s
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id
  ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, submitted_at ASC))::integer AS rank,
  user_id,
  nick,
  best_week_start,
  score,
  boards_cleared,
  boards_dealt,
  booms,
  best_streak,
  cells_opened,
  moves,
  duration_ms,
  accuracy,
  rounds_played,
  submitted_at,
  base_score,
  item_bonus
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.saper_recent_awards WITH (security_invoker = true) AS
SELECT
  id,
  week_start,
  user_id,
  nick_snapshot AS nick,
  rank,
  score,
  duration_ms,
  prize_coins,
  awarded_at
FROM public.saper_weekly_awards
ORDER BY week_start DESC, rank ASC;

CREATE OR REPLACE FUNCTION public.award_saper_week(
  p_week_start date DEFAULT public.saper_week_start(now() - interval '7 days')
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_week date := public.saper_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.saper_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, duration_ms, prize_coins
      FROM public.saper_weekly_awards
      WHERE week_start = p_week_start
      ORDER BY rank
    ) a;

    RETURN json_build_object(
      'ok', true,
      'already_awarded', true,
      'week_start', p_week_start,
      'awards', v_awards
    );
  END IF;

  WITH user_best AS (
    SELECT DISTINCT ON (s.user_id)
      s.user_id,
      s.nick_snapshot,
      s.score,
      s.duration_ms,
      s.submitted_at
    FROM public.saper_scores s
    WHERE s.week_start = p_week_start
    ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
  ),
  ranked AS (
    SELECT
      user_id,
      nick_snapshot,
      score,
      duration_ms,
      (ROW_NUMBER() OVER (ORDER BY score DESC, submitted_at ASC))::integer AS rank
    FROM user_best
  ),
  winners AS (
    SELECT
      user_id,
      nick_snapshot,
      rank,
      score,
      duration_ms,
      CASE rank WHEN 1 THEN 1000 WHEN 2 THEN 500 WHEN 3 THEN 200 END AS prize_coins
    FROM ranked
    WHERE rank <= 3
  ),
  inserted AS (
    INSERT INTO public.saper_weekly_awards
      (week_start, user_id, nick_snapshot, rank, score, duration_ms, prize_coins)
    SELECT p_week_start, user_id, nick_snapshot, rank, score, duration_ms, prize_coins
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
    SELECT rank, nick_snapshot AS nick, score, duration_ms, prize_coins
    FROM public.saper_weekly_awards
    WHERE week_start = p_week_start
    ORDER BY rank
  ) a;

  RETURN json_build_object(
    'ok', true,
    'already_awarded', false,
    'week_start', p_week_start,
    'awards_created', v_inserted_count,
    'coins_awarded', v_total_prize,
    'awards', v_awards
  );
END;
$$;

REVOKE ALL ON FUNCTION public.saper_week_start(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_saper_week(date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.saper_week_start(timestamptz) TO authenticated;
GRANT SELECT ON public.saper_current_week, public.saper_all_time, public.saper_recent_awards
  TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'saper_scores'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.saper_scores;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'saper_weekly_awards'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.saper_weekly_awards;
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Season-gated weekly award (the gate lives in seasonal_game_for_week(); the
-- cron command is only parsed at run time, so scheduling works even before the
-- updated season-award-gating.sql is applied — but apply it before Monday).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule(jobname)
    FROM cron.job
    WHERE jobname = 'saper_weekly_awards';

    PERFORM cron.schedule(
      'saper_weekly_awards',
      '0 22,23 * * 0',
      $cron$SELECT CASE
        WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
          THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
        WHEN public.seasonal_game_for_week(public.saper_week_start(now() - interval '7 days')) = 'saper'
          THEN public.award_saper_week(public.saper_week_start(now() - interval '7 days'))
          ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$cron$
    );
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
