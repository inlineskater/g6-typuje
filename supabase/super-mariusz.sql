-- „Super Mariusz" (super_mariusz) seasonal game support for Rynek Proroctw G6.
-- A Mario-style HARDMODE one-life speedrun platformer on a fixed shared course
-- (course_id = 'super_mariusz_v2'). Score = PROGRESS: the stored `score` is
-- the tile column reached by the player's center (peak x, capped at the flag
-- column = 455), so the existing ORDER BY score DESC leaderboard/award
-- machinery ranks distance first; every finisher scores exactly the cap and
-- `completion_ms ASC NULLS LAST` (Bug Jumper pattern) decides only among
-- finishers. A death (spike/enemy/pit) or the 5-minute cap is a DNF:
-- completed = false, completion_ms = NULL — but the progress score still
-- counts, so DNFs rank below finishers yet CAN win weekly awards when few
-- (or no) players finish the brutal course.
-- Run after supabase/schema.sql and supabase/hero-items.sql.
-- After running this file, re-run supabase/season-award-gating.sql (updated
-- with the super_mariusz rotation entry) so seasonal_game_for_week() knows it.

CREATE OR REPLACE FUNCTION public.super_mariusz_week_start(p_ts timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Monday-starting week (Mon..Sun) in Europe/Warsaw.
  SELECT date_trunc('week', p_ts AT TIME ZONE 'Europe/Warsaw')::date;
$$;

CREATE TABLE IF NOT EXISTS public.super_mariusz_rounds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  seed          integer NOT NULL DEFAULT 1,
  course_id     text NOT NULL DEFAULT 'super_mariusz_v2',
  started_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.super_mariusz_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id      uuid NOT NULL UNIQUE REFERENCES public.super_mariusz_rounds(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  week_start    date NOT NULL,
  course_id     text NOT NULL DEFAULT 'super_mariusz_v2',
  score         integer NOT NULL DEFAULT 0 CHECK (score >= 0),
  completion_ms integer CHECK (completion_ms IS NULL OR completion_ms >= 0),
  completed     boolean NOT NULL DEFAULT false,
  moves         integer NOT NULL DEFAULT 0 CHECK (moves >= 0),
  duration_ms   integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  client_meta   jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.super_mariusz_weekly_awards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start    date NOT NULL,
  course_id     text NOT NULL DEFAULT 'super_mariusz_v2',
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  rank          integer NOT NULL CHECK (rank BETWEEN 1 AND 3),
  score         integer NOT NULL CHECK (score >= 0),
  completion_ms integer,
  prize_coins   integer NOT NULL CHECK (prize_coins > 0),
  awarded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, rank),
  UNIQUE (week_start, user_id)
);

CREATE INDEX IF NOT EXISTS super_mariusz_rounds_user_time_idx
  ON public.super_mariusz_rounds(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS super_mariusz_rounds_expires_idx
  ON public.super_mariusz_rounds(expires_at)
  WHERE submitted_at IS NULL;

CREATE INDEX IF NOT EXISTS super_mariusz_scores_week_rank_idx
  ON public.super_mariusz_scores(week_start, score DESC, completion_ms ASC NULLS LAST, submitted_at ASC);

CREATE INDEX IF NOT EXISTS super_mariusz_scores_user_time_idx
  ON public.super_mariusz_scores(user_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS super_mariusz_awards_week_idx
  ON public.super_mariusz_weekly_awards(week_start DESC, rank ASC);

ALTER TABLE public.super_mariusz_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.super_mariusz_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.super_mariusz_weekly_awards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "super_mariusz_rounds_select_own" ON public.super_mariusz_rounds;
CREATE POLICY "super_mariusz_rounds_select_own" ON public.super_mariusz_rounds
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "super_mariusz_scores_select" ON public.super_mariusz_scores;
CREATE POLICY "super_mariusz_scores_select" ON public.super_mariusz_scores
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "super_mariusz_awards_select" ON public.super_mariusz_weekly_awards;
CREATE POLICY "super_mariusz_awards_select" ON public.super_mariusz_weekly_awards
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.super_mariusz_rounds, public.super_mariusz_scores, public.super_mariusz_weekly_awards
  FROM anon, authenticated;
GRANT SELECT ON public.super_mariusz_rounds, public.super_mariusz_scores, public.super_mariusz_weekly_awards
  TO authenticated;

CREATE OR REPLACE VIEW public.super_mariusz_current_week WITH (security_invoker = true) AS
WITH current_week AS (
  SELECT public.super_mariusz_week_start(now()) AS week_start
),
round_counts AS (
  SELECT user_id, week_start, COUNT(*)::integer AS rounds_played
  FROM public.super_mariusz_scores
  GROUP BY user_id, week_start
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.week_start,
    s.score,
    s.completion_ms,
    s.completed,
    s.moves,
    s.duration_ms,
    s.submitted_at,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.super_mariusz_scores s
  JOIN current_week cw ON cw.week_start = s.week_start
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id AND rc.week_start = s.week_start
  ORDER BY s.user_id, s.score DESC, s.completion_ms ASC NULLS LAST, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, completion_ms ASC NULLS LAST, submitted_at ASC))::integer AS rank,
  user_id,
  nick,
  week_start,
  score,
  completion_ms,
  completed,
  moves,
  duration_ms,
  rounds_played,
  submitted_at
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.super_mariusz_all_time WITH (security_invoker = true) AS
WITH round_counts AS (
  SELECT user_id, COUNT(*)::integer AS rounds_played
  FROM public.super_mariusz_scores
  GROUP BY user_id
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.week_start AS best_week_start,
    s.score,
    s.completion_ms,
    s.completed,
    s.moves,
    s.duration_ms,
    s.submitted_at,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.super_mariusz_scores s
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id
  ORDER BY s.user_id, s.score DESC, s.completion_ms ASC NULLS LAST, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, completion_ms ASC NULLS LAST, submitted_at ASC))::integer AS rank,
  user_id,
  nick,
  best_week_start,
  score,
  completion_ms,
  completed,
  moves,
  duration_ms,
  rounds_played,
  submitted_at
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.super_mariusz_recent_awards WITH (security_invoker = true) AS
SELECT
  id,
  week_start,
  user_id,
  nick_snapshot AS nick,
  rank,
  score,
  completion_ms,
  prize_coins,
  awarded_at
FROM public.super_mariusz_weekly_awards
ORDER BY week_start DESC, rank ASC;

CREATE OR REPLACE FUNCTION public.award_super_mariusz_week(
  p_week_start date DEFAULT public.super_mariusz_week_start(now() - interval '7 days')
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_week date := public.super_mariusz_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.super_mariusz_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, completion_ms, prize_coins
      FROM public.super_mariusz_weekly_awards
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
      s.completion_ms,
      s.submitted_at
    FROM public.super_mariusz_scores s
    WHERE s.week_start = p_week_start
      AND s.score > 0
    ORDER BY s.user_id, s.score DESC, s.completion_ms ASC NULLS LAST, s.submitted_at ASC
  ),
  ranked AS (
    SELECT
      user_id,
      nick_snapshot,
      score,
      completion_ms,
      (ROW_NUMBER() OVER (ORDER BY score DESC, completion_ms ASC NULLS LAST, submitted_at ASC))::integer AS rank
    FROM user_best
  ),
  winners AS (
    SELECT
      user_id,
      nick_snapshot,
      rank,
      score,
      completion_ms,
      CASE rank WHEN 1 THEN 500 WHEN 2 THEN 250 WHEN 3 THEN 100 END AS prize_coins
    FROM ranked
    WHERE rank <= 3
  ),
  inserted AS (
    INSERT INTO public.super_mariusz_weekly_awards
      (week_start, user_id, nick_snapshot, rank, score, completion_ms, prize_coins)
    SELECT p_week_start, user_id, nick_snapshot, rank, score, completion_ms, prize_coins
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
    SELECT rank, nick_snapshot AS nick, score, completion_ms, prize_coins
    FROM public.super_mariusz_weekly_awards
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

REVOKE ALL ON FUNCTION public.super_mariusz_week_start(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_super_mariusz_week(date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.super_mariusz_week_start(timestamptz) TO authenticated;
GRANT SELECT ON public.super_mariusz_current_week, public.super_mariusz_all_time, public.super_mariusz_recent_awards
  TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'super_mariusz_scores'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.super_mariusz_scores;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'super_mariusz_weekly_awards'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.super_mariusz_weekly_awards;
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
    WHERE jobname = 'super_mariusz_weekly_awards';

    PERFORM cron.schedule(
      'super_mariusz_weekly_awards',
      '0 22,23 * * 0',
      $cron$SELECT CASE
        WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
          THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
        WHEN public.seasonal_game_for_week(public.super_mariusz_week_start(now() - interval '7 days')) = 'super_mariusz'
          THEN public.award_super_mariusz_week(public.super_mariusz_week_start(now() - interval '7 days'))
          ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$cron$
    );
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
