-- „Łap Jajka" (egg_catch) seasonal game support for Rynek Proroctw G6.
-- A Nu-pogodi/Elektronika-style egg catcher: eggs roll down 4 chutes, the wolf
-- catches them at one of 4 positions, 3 broken eggs end the run.
-- Run after supabase/schema.sql and supabase/hero-items.sql.
-- After running this file, re-run supabase/season-award-gating.sql (updated with
-- the egg_catch rotation entry) so seasonal_game_for_week() knows the game.

CREATE OR REPLACE FUNCTION public.egg_catch_week_start(p_ts timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Monday-starting week (Mon..Sun) in Europe/Warsaw.
  SELECT date_trunc('week', p_ts AT TIME ZONE 'Europe/Warsaw')::date;
$$;

CREATE TABLE IF NOT EXISTS public.egg_catch_rounds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  seed          integer NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.egg_catch_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id      uuid NOT NULL UNIQUE REFERENCES public.egg_catch_rounds(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  week_start    date NOT NULL,
  score         integer NOT NULL CHECK (score >= 0),
  eggs          integer NOT NULL DEFAULT 0 CHECK (eggs >= 0),
  misses        integer NOT NULL DEFAULT 0 CHECK (misses >= 0),
  moves         integer NOT NULL DEFAULT 0 CHECK (moves >= 0),
  duration_ms   integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  accuracy      numeric(5,2) NOT NULL DEFAULT 0 CHECK (accuracy >= 0 AND accuracy <= 100),
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  client_meta   jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.egg_catch_weekly_awards (
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

CREATE INDEX IF NOT EXISTS egg_catch_rounds_user_time_idx
  ON public.egg_catch_rounds(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS egg_catch_rounds_expires_idx
  ON public.egg_catch_rounds(expires_at)
  WHERE submitted_at IS NULL;

CREATE INDEX IF NOT EXISTS egg_catch_scores_week_rank_idx
  ON public.egg_catch_scores(week_start, score DESC, submitted_at ASC);

CREATE INDEX IF NOT EXISTS egg_catch_scores_user_time_idx
  ON public.egg_catch_scores(user_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS egg_catch_awards_week_idx
  ON public.egg_catch_weekly_awards(week_start DESC, rank ASC);

ALTER TABLE public.egg_catch_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.egg_catch_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.egg_catch_weekly_awards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "egg_catch_rounds_select_own" ON public.egg_catch_rounds;
CREATE POLICY "egg_catch_rounds_select_own" ON public.egg_catch_rounds
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "egg_catch_scores_select" ON public.egg_catch_scores;
CREATE POLICY "egg_catch_scores_select" ON public.egg_catch_scores
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "egg_catch_awards_select" ON public.egg_catch_weekly_awards;
CREATE POLICY "egg_catch_awards_select" ON public.egg_catch_weekly_awards
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.egg_catch_rounds, public.egg_catch_scores, public.egg_catch_weekly_awards
  FROM anon, authenticated;
GRANT SELECT ON public.egg_catch_rounds, public.egg_catch_scores, public.egg_catch_weekly_awards
  TO authenticated;

CREATE OR REPLACE VIEW public.egg_catch_current_week WITH (security_invoker = true) AS
WITH current_week AS (
  SELECT public.egg_catch_week_start(now()) AS week_start
),
round_counts AS (
  SELECT user_id, week_start, COUNT(*)::integer AS rounds_played
  FROM public.egg_catch_scores
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
    s.eggs,
    s.misses,
    s.moves,
    s.duration_ms,
    s.accuracy,
    s.submitted_at,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.egg_catch_scores s
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
  eggs,
  misses,
  moves,
  duration_ms,
  accuracy,
  rounds_played,
  submitted_at,
  base_score,
  item_bonus
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.egg_catch_all_time WITH (security_invoker = true) AS
WITH round_counts AS (
  SELECT user_id, COUNT(*)::integer AS rounds_played
  FROM public.egg_catch_scores
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
    s.eggs,
    s.misses,
    s.moves,
    s.duration_ms,
    s.accuracy,
    s.submitted_at,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.egg_catch_scores s
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id
  ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, submitted_at ASC))::integer AS rank,
  user_id,
  nick,
  best_week_start,
  score,
  eggs,
  misses,
  moves,
  duration_ms,
  accuracy,
  rounds_played,
  submitted_at,
  base_score,
  item_bonus
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.egg_catch_recent_awards WITH (security_invoker = true) AS
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
FROM public.egg_catch_weekly_awards
ORDER BY week_start DESC, rank ASC;

CREATE OR REPLACE FUNCTION public.award_egg_catch_week(
  p_week_start date DEFAULT public.egg_catch_week_start(now() - interval '7 days')
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_week date := public.egg_catch_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.egg_catch_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, duration_ms, prize_coins
      FROM public.egg_catch_weekly_awards
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
    FROM public.egg_catch_scores s
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
      CASE rank WHEN 1 THEN 100 WHEN 2 THEN 50 WHEN 3 THEN 25 END AS prize_coins
    FROM ranked
    WHERE rank <= 3
  ),
  inserted AS (
    INSERT INTO public.egg_catch_weekly_awards
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
    FROM public.egg_catch_weekly_awards
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

REVOKE ALL ON FUNCTION public.egg_catch_week_start(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_egg_catch_week(date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.egg_catch_week_start(timestamptz) TO authenticated;
GRANT SELECT ON public.egg_catch_current_week, public.egg_catch_all_time, public.egg_catch_recent_awards
  TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'egg_catch_scores'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.egg_catch_scores;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'egg_catch_weekly_awards'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.egg_catch_weekly_awards;
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
    WHERE jobname = 'egg_catch_weekly_awards';

    PERFORM cron.schedule(
      'egg_catch_weekly_awards',
      '5 0 * * 1',
      $cron$SELECT CASE WHEN public.seasonal_game_for_week(public.egg_catch_week_start(now() - interval '7 days')) = 'egg_catch'
          THEN public.award_egg_catch_week(public.egg_catch_week_start(now() - interval '7 days'))
          ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$cron$
    );
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
