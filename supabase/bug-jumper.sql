-- Bug Jumper seasonal game support for Rynek Proroctw G6.
-- Run after supabase/schema.sql and supabase/whack-boss.sql.

CREATE OR REPLACE FUNCTION public.bug_jumper_week_start(p_ts timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Monday-starting week (Mon..Sun) in Europe/Warsaw.
  SELECT date_trunc('week', p_ts AT TIME ZONE 'Europe/Warsaw')::date;
$$;

CREATE TABLE IF NOT EXISTS public.bug_jumper_rounds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  duration_ms   integer NOT NULL DEFAULT 20000 CHECK (duration_ms BETWEEN 10000 AND 60000),
  started_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '2 minutes'),
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bug_jumper_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id      uuid NOT NULL UNIQUE REFERENCES public.bug_jumper_rounds(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  week_start    date NOT NULL,
  course_id     text NOT NULL DEFAULT 'legacy_random_v1',
  score         integer NOT NULL CHECK (score >= 0),
  hits          integer NOT NULL CHECK (hits >= 0),
  misses        integer NOT NULL CHECK (misses >= 0),
  accuracy      numeric(5,2) NOT NULL DEFAULT 0 CHECK (accuracy >= 0 AND accuracy <= 100),
  max_combo     integer NOT NULL DEFAULT 0 CHECK (max_combo >= 0),
  duration_ms   integer NOT NULL DEFAULT 20000,
  completion_ms integer CHECK (completion_ms IS NULL OR completion_ms >= 0),
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  client_meta   jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.bug_jumper_weekly_awards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start    date NOT NULL,
  course_id     text NOT NULL DEFAULT 'legacy_random_v1',
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  rank          integer NOT NULL CHECK (rank BETWEEN 1 AND 3),
  score         integer NOT NULL CHECK (score >= 0),
  accuracy      numeric(5,2) NOT NULL DEFAULT 0,
  prize_coins   integer NOT NULL CHECK (prize_coins > 0),
  awarded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, rank),
  UNIQUE (week_start, user_id)
);

ALTER TABLE public.bug_jumper_scores
  ADD COLUMN IF NOT EXISTS course_id text NOT NULL DEFAULT 'legacy_random_v1',
  ADD COLUMN IF NOT EXISTS completion_ms integer;

ALTER TABLE public.bug_jumper_scores
  DROP CONSTRAINT IF EXISTS bug_jumper_scores_completion_ms_check;

ALTER TABLE public.bug_jumper_scores
  ADD CONSTRAINT bug_jumper_scores_completion_ms_check
  CHECK (completion_ms IS NULL OR completion_ms >= 0);

ALTER TABLE public.bug_jumper_weekly_awards
  ADD COLUMN IF NOT EXISTS course_id text NOT NULL DEFAULT 'legacy_random_v1';

CREATE INDEX IF NOT EXISTS bug_jumper_rounds_user_time_idx
  ON public.bug_jumper_rounds(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS bug_jumper_rounds_expires_idx
  ON public.bug_jumper_rounds(expires_at)
  WHERE submitted_at IS NULL;

CREATE INDEX IF NOT EXISTS bug_jumper_scores_week_rank_idx
  ON public.bug_jumper_scores(week_start, score DESC, accuracy DESC, submitted_at ASC);

CREATE INDEX IF NOT EXISTS bug_jumper_scores_course_week_rank_idx
  ON public.bug_jumper_scores(course_id, week_start, score DESC, completion_ms ASC NULLS LAST, accuracy DESC, submitted_at ASC);

CREATE INDEX IF NOT EXISTS bug_jumper_scores_user_time_idx
  ON public.bug_jumper_scores(user_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS bug_jumper_awards_week_idx
  ON public.bug_jumper_weekly_awards(week_start DESC, rank ASC);

ALTER TABLE public.bug_jumper_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bug_jumper_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bug_jumper_weekly_awards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bug_jumper_rounds_select_own" ON public.bug_jumper_rounds;
CREATE POLICY "bug_jumper_rounds_select_own" ON public.bug_jumper_rounds
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "bug_jumper_scores_select" ON public.bug_jumper_scores;
CREATE POLICY "bug_jumper_scores_select" ON public.bug_jumper_scores
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "bug_jumper_awards_select" ON public.bug_jumper_weekly_awards;
CREATE POLICY "bug_jumper_awards_select" ON public.bug_jumper_weekly_awards
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.bug_jumper_rounds, public.bug_jumper_scores, public.bug_jumper_weekly_awards
  FROM anon, authenticated;
GRANT SELECT ON public.bug_jumper_rounds, public.bug_jumper_scores, public.bug_jumper_weekly_awards
  TO authenticated;

CREATE OR REPLACE VIEW public.bug_jumper_current_week WITH (security_invoker = true) AS
WITH current_week AS (
  SELECT public.bug_jumper_week_start(now()) AS week_start
),
round_counts AS (
  SELECT user_id, week_start, COUNT(*)::integer AS rounds_played
  FROM public.bug_jumper_scores
  WHERE course_id = 'bug_jumper_hard_v2'
  GROUP BY user_id, week_start
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.week_start,
    s.course_id,
    s.score,
    s.score AS base_score,
    0::integer AS item_bonus,
    s.hits,
    s.misses,
    s.accuracy,
    s.max_combo,
    s.completion_ms,
    s.submitted_at,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.bug_jumper_scores s
  JOIN current_week cw ON cw.week_start = s.week_start
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id AND rc.week_start = s.week_start
  WHERE s.course_id = 'bug_jumper_hard_v2'
  ORDER BY s.user_id, s.score DESC, s.completion_ms ASC NULLS LAST, s.accuracy DESC, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, completion_ms ASC NULLS LAST, accuracy DESC, submitted_at ASC))::integer AS rank,
  user_id,
  nick,
  week_start,
  score,
  hits,
  misses,
  accuracy,
  max_combo,
  rounds_played,
  submitted_at,
  base_score,
  item_bonus,
  course_id,
  completion_ms
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.bug_jumper_all_time WITH (security_invoker = true) AS
WITH round_counts AS (
  SELECT user_id, COUNT(*)::integer AS rounds_played
  FROM public.bug_jumper_scores
  WHERE course_id = 'bug_jumper_hard_v2'
  GROUP BY user_id
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.week_start AS best_week_start,
    s.course_id,
    s.score,
    s.score AS base_score,
    0::integer AS item_bonus,
    s.hits,
    s.misses,
    s.accuracy,
    s.max_combo,
    s.completion_ms,
    s.submitted_at,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.bug_jumper_scores s
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id
  WHERE s.course_id = 'bug_jumper_hard_v2'
  ORDER BY s.user_id, s.score DESC, s.completion_ms ASC NULLS LAST, s.accuracy DESC, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, completion_ms ASC NULLS LAST, accuracy DESC, submitted_at ASC))::integer AS rank,
  user_id,
  nick,
  best_week_start,
  score,
  hits,
  misses,
  accuracy,
  max_combo,
  rounds_played,
  submitted_at,
  base_score,
  item_bonus,
  course_id,
  completion_ms
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.bug_jumper_recent_awards WITH (security_invoker = true) AS
SELECT
  id,
  week_start,
  user_id,
  nick_snapshot AS nick,
  rank,
  score,
  accuracy,
  prize_coins,
  awarded_at,
  course_id
FROM public.bug_jumper_weekly_awards
WHERE course_id = 'bug_jumper_hard_v2'
ORDER BY week_start DESC, rank ASC;

CREATE OR REPLACE FUNCTION public.award_bug_jumper_week(
  p_week_start date DEFAULT public.bug_jumper_week_start(now() - interval '7 days')
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_week date := public.bug_jumper_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.bug_jumper_weekly_awards
    WHERE week_start = p_week_start
      AND course_id = 'bug_jumper_hard_v2'
  ) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, accuracy, prize_coins
      FROM public.bug_jumper_weekly_awards
      WHERE week_start = p_week_start
        AND course_id = 'bug_jumper_hard_v2'
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
      s.accuracy,
      s.completion_ms,
      s.submitted_at
    FROM public.bug_jumper_scores s
    WHERE s.week_start = p_week_start
      AND s.course_id = 'bug_jumper_hard_v2'
    ORDER BY s.user_id, s.score DESC, s.completion_ms ASC NULLS LAST, s.accuracy DESC, s.submitted_at ASC
  ),
  ranked AS (
    SELECT
      user_id,
      nick_snapshot,
      score,
      accuracy,
      (ROW_NUMBER() OVER (ORDER BY score DESC, completion_ms ASC NULLS LAST, accuracy DESC, submitted_at ASC))::integer AS rank
    FROM user_best
  ),
  winners AS (
    SELECT
      user_id,
      nick_snapshot,
      rank,
      score,
      accuracy,
      CASE rank WHEN 1 THEN 100 WHEN 2 THEN 50 WHEN 3 THEN 25 END AS prize_coins
    FROM ranked
    WHERE rank <= 3
  ),
  inserted AS (
    INSERT INTO public.bug_jumper_weekly_awards
      (week_start, course_id, user_id, nick_snapshot, rank, score, accuracy, prize_coins)
    SELECT p_week_start, 'bug_jumper_hard_v2', user_id, nick_snapshot, rank, score, accuracy, prize_coins
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
    SELECT rank, nick_snapshot AS nick, score, accuracy, prize_coins
    FROM public.bug_jumper_weekly_awards
    WHERE week_start = p_week_start
      AND course_id = 'bug_jumper_hard_v2'
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

REVOKE ALL ON FUNCTION public.bug_jumper_week_start(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_bug_jumper_week(date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.bug_jumper_week_start(timestamptz) TO authenticated;
GRANT SELECT ON public.bug_jumper_current_week, public.bug_jumper_all_time, public.bug_jumper_recent_awards
  TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'bug_jumper_scores'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bug_jumper_scores;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'bug_jumper_weekly_awards'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bug_jumper_weekly_awards;
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule(jobname)
    FROM cron.job
    WHERE jobname = 'bug_jumper_weekly_awards';

    PERFORM cron.schedule(
      'bug_jumper_weekly_awards',
      '5 0 * * 1',
      $cron$SELECT public.award_bug_jumper_week(public.bug_jumper_week_start(now() - interval '7 days'));$cron$
    );
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
