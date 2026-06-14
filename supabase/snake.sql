-- Snake seasonal game support for Rynek Proroctw G6.
-- Run after supabase/schema.sql and supabase/hero-items.sql.

CREATE OR REPLACE FUNCTION public.snake_week_start(p_ts timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Monday-starting week (Mon..Sun) in Europe/Warsaw.
  SELECT date_trunc('week', p_ts AT TIME ZONE 'Europe/Warsaw')::date;
$$;

CREATE TABLE IF NOT EXISTS public.snake_rounds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  seed          integer NOT NULL,
  duration_ms   integer NOT NULL DEFAULT 120000 CHECK (duration_ms BETWEEN 10000 AND 180000),
  started_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '3 minutes'),
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.snake_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id      uuid NOT NULL UNIQUE REFERENCES public.snake_rounds(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  week_start    date NOT NULL,
  score         integer NOT NULL CHECK (score >= 0),
  apples        integer NOT NULL DEFAULT 0 CHECK (apples >= 0),
  moves         integer NOT NULL DEFAULT 0 CHECK (moves >= 0),
  duration_ms   integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  accuracy      numeric(5,2) NOT NULL DEFAULT 0 CHECK (accuracy >= 0 AND accuracy <= 100),
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  client_meta   jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.snake_weekly_awards (
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

CREATE INDEX IF NOT EXISTS snake_rounds_user_time_idx
  ON public.snake_rounds(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS snake_rounds_expires_idx
  ON public.snake_rounds(expires_at)
  WHERE submitted_at IS NULL;

DROP INDEX IF EXISTS public.snake_scores_week_rank_idx;
CREATE INDEX snake_scores_week_rank_idx
  ON public.snake_scores(week_start, score DESC, submitted_at ASC);

CREATE INDEX IF NOT EXISTS snake_scores_user_time_idx
  ON public.snake_scores(user_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS snake_awards_week_idx
  ON public.snake_weekly_awards(week_start DESC, rank ASC);

ALTER TABLE public.snake_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snake_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snake_weekly_awards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "snake_rounds_select_own" ON public.snake_rounds;
CREATE POLICY "snake_rounds_select_own" ON public.snake_rounds
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "snake_scores_select" ON public.snake_scores;
CREATE POLICY "snake_scores_select" ON public.snake_scores
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "snake_awards_select" ON public.snake_weekly_awards;
CREATE POLICY "snake_awards_select" ON public.snake_weekly_awards
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.snake_rounds, public.snake_scores, public.snake_weekly_awards
  FROM anon, authenticated;
GRANT SELECT ON public.snake_rounds, public.snake_scores, public.snake_weekly_awards
  TO authenticated;

CREATE OR REPLACE VIEW public.snake_current_week WITH (security_invoker = true) AS
WITH current_week AS (
  SELECT public.snake_week_start(now()) AS week_start
),
round_counts AS (
  SELECT user_id, week_start, COUNT(*)::integer AS rounds_played
  FROM public.snake_scores
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
    s.apples,
    s.moves,
    s.duration_ms,
    s.accuracy,
    s.submitted_at,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.snake_scores s
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
  apples,
  moves,
  duration_ms,
  accuracy,
  rounds_played,
  submitted_at,
  base_score,
  item_bonus
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.snake_all_time WITH (security_invoker = true) AS
WITH round_counts AS (
  SELECT user_id, COUNT(*)::integer AS rounds_played
  FROM public.snake_scores
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
    s.apples,
    s.moves,
    s.duration_ms,
    s.accuracy,
    s.submitted_at,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.snake_scores s
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id
  ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, submitted_at ASC))::integer AS rank,
  user_id,
  nick,
  best_week_start,
  score,
  apples,
  moves,
  duration_ms,
  accuracy,
  rounds_played,
  submitted_at,
  base_score,
  item_bonus
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.snake_recent_awards WITH (security_invoker = true) AS
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
FROM public.snake_weekly_awards
ORDER BY week_start DESC, rank ASC;

CREATE OR REPLACE FUNCTION public.award_snake_week(
  p_week_start date DEFAULT public.snake_week_start(now() - interval '7 days')
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_week date := public.snake_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.snake_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, duration_ms, prize_coins
      FROM public.snake_weekly_awards
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
    FROM public.snake_scores s
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
    INSERT INTO public.snake_weekly_awards
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
    FROM public.snake_weekly_awards
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

REVOKE ALL ON FUNCTION public.snake_week_start(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_snake_week(date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.snake_week_start(timestamptz) TO authenticated;
GRANT SELECT ON public.snake_current_week, public.snake_all_time, public.snake_recent_awards
  TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'snake_scores'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.snake_scores;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'snake_weekly_awards'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.snake_weekly_awards;
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule(jobname)
    FROM cron.job
    WHERE jobname = 'snake_weekly_awards';

    PERFORM cron.schedule(
      'snake_weekly_awards',
      '5 0 * * 1',
      $cron$SELECT public.award_snake_week(public.snake_week_start(now() - interval '7 days'));$cron$
    );
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
