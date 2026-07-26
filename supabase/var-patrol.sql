-- VAR Patrol support for Rynek Proroctw G6.
-- „VAR Patrol 📺" — a rapid football-officiating judgement/reaction seasonal game.
-- Mirrors the Whack-a-Boss stack (server-issued schedule + timing-validated answers).
-- Run after supabase/schema.sql on an existing project. Idempotent; paste into the
-- Supabase SQL Editor → Run.

CREATE OR REPLACE FUNCTION public.var_patrol_week_start(p_ts timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Monday-starting week (Mon..Sun) in Europe/Warsaw.
  SELECT date_trunc('week', p_ts AT TIME ZONE 'Europe/Warsaw')::date;
$$;

CREATE TABLE IF NOT EXISTS public.var_patrol_rounds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  schedule      jsonb NOT NULL,
  answers       jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms   integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  started_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.var_patrol_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id      uuid NOT NULL UNIQUE REFERENCES public.var_patrol_rounds(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  week_start    date NOT NULL,
  score         integer NOT NULL CHECK (score >= 0),
  hits          integer NOT NULL CHECK (hits >= 0),
  misses        integer NOT NULL CHECK (misses >= 0),
  accuracy      numeric(5,2) NOT NULL DEFAULT 0 CHECK (accuracy >= 0 AND accuracy <= 100),
  max_combo     integer NOT NULL DEFAULT 0 CHECK (max_combo >= 0),
  duration_ms   integer NOT NULL DEFAULT 0,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  client_meta   jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.var_patrol_weekly_awards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start    date NOT NULL,
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

CREATE INDEX IF NOT EXISTS var_patrol_rounds_user_time_idx
  ON public.var_patrol_rounds(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS var_patrol_rounds_expires_idx
  ON public.var_patrol_rounds(expires_at)
  WHERE submitted_at IS NULL;

CREATE INDEX IF NOT EXISTS var_patrol_scores_week_rank_idx
  ON public.var_patrol_scores(week_start, score DESC, accuracy DESC, submitted_at ASC);

CREATE INDEX IF NOT EXISTS var_patrol_scores_user_time_idx
  ON public.var_patrol_scores(user_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS var_patrol_awards_week_idx
  ON public.var_patrol_weekly_awards(week_start DESC, rank ASC);

ALTER TABLE public.var_patrol_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.var_patrol_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.var_patrol_weekly_awards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "var_patrol_rounds_select_own" ON public.var_patrol_rounds;
CREATE POLICY "var_patrol_rounds_select_own" ON public.var_patrol_rounds
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "var_patrol_scores_select" ON public.var_patrol_scores;
CREATE POLICY "var_patrol_scores_select" ON public.var_patrol_scores
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "var_patrol_awards_select" ON public.var_patrol_weekly_awards;
CREATE POLICY "var_patrol_awards_select" ON public.var_patrol_weekly_awards
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.var_patrol_rounds, public.var_patrol_scores, public.var_patrol_weekly_awards
  FROM anon, authenticated;
GRANT SELECT ON public.var_patrol_rounds, public.var_patrol_scores, public.var_patrol_weekly_awards
  TO authenticated;

CREATE OR REPLACE VIEW public.var_patrol_current_week WITH (security_invoker = true) AS
WITH current_week AS (
  SELECT public.var_patrol_week_start(now()) AS week_start
),
round_counts AS (
  SELECT user_id, week_start, COUNT(*)::integer AS rounds_played
  FROM public.var_patrol_scores
  WHERE client_meta @> '{"server_validated": true}'::jsonb
  GROUP BY user_id, week_start
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.week_start,
    s.score,
    s.hits,
    s.misses,
    s.accuracy,
    s.max_combo,
    s.submitted_at,
    COALESCE(
      (s.client_meta->>'base_score')::int,
      GREATEST(0, s.score - COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0))
    ) AS base_score,
    COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0) AS item_bonus,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.var_patrol_scores s
  JOIN current_week cw ON cw.week_start = s.week_start
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id AND rc.week_start = s.week_start
  WHERE s.client_meta @> '{"server_validated": true}'::jsonb
  ORDER BY s.user_id, s.score DESC, s.accuracy DESC, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, accuracy DESC, submitted_at ASC))::integer AS rank,
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
  item_bonus
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.var_patrol_all_time WITH (security_invoker = true) AS
WITH round_counts AS (
  SELECT user_id, COUNT(*)::integer AS rounds_played
  FROM public.var_patrol_scores
  WHERE client_meta @> '{"server_validated": true}'::jsonb
  GROUP BY user_id
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.week_start AS best_week_start,
    s.score,
    s.hits,
    s.misses,
    s.accuracy,
    s.max_combo,
    s.submitted_at,
    COALESCE(
      (s.client_meta->>'base_score')::int,
      GREATEST(0, s.score - COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0))
    ) AS base_score,
    COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0) AS item_bonus,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.var_patrol_scores s
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id
  WHERE s.client_meta @> '{"server_validated": true}'::jsonb
  ORDER BY s.user_id, s.score DESC, s.accuracy DESC, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, accuracy DESC, submitted_at ASC))::integer AS rank,
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
  item_bonus
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.var_patrol_recent_awards WITH (security_invoker = true) AS
SELECT
  id,
  week_start,
  user_id,
  nick_snapshot AS nick,
  rank,
  score,
  accuracy,
  prize_coins,
  awarded_at
FROM public.var_patrol_weekly_awards
ORDER BY week_start DESC, rank ASC;

CREATE OR REPLACE FUNCTION public.award_var_patrol_week(
  p_week_start date DEFAULT public.var_patrol_week_start(now() - interval '7 days')
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_week date := public.var_patrol_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.var_patrol_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, accuracy, prize_coins
      FROM public.var_patrol_weekly_awards
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
      s.accuracy,
      s.submitted_at
    FROM public.var_patrol_scores s
    WHERE s.week_start = p_week_start
      AND s.client_meta @> '{"server_validated": true}'::jsonb
    ORDER BY s.user_id, s.score DESC, s.accuracy DESC, s.submitted_at ASC
  ),
  ranked AS (
    SELECT
      user_id,
      nick_snapshot,
      score,
      accuracy,
      (ROW_NUMBER() OVER (ORDER BY score DESC, accuracy DESC, submitted_at ASC))::integer AS rank
    FROM user_best
  ),
  winners AS (
    SELECT
      user_id,
      nick_snapshot,
      rank,
      score,
      accuracy,
      CASE rank WHEN 1 THEN 1000 WHEN 2 THEN 500 WHEN 3 THEN 200 END AS prize_coins
    FROM ranked
    WHERE rank <= 3
  ),
  inserted AS (
    INSERT INTO public.var_patrol_weekly_awards
      (week_start, user_id, nick_snapshot, rank, score, accuracy, prize_coins)
    SELECT p_week_start, user_id, nick_snapshot, rank, score, accuracy, prize_coins
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
    FROM public.var_patrol_weekly_awards
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

REVOKE ALL ON FUNCTION public.var_patrol_week_start(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_var_patrol_week(date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.var_patrol_week_start(timestamptz) TO authenticated;
GRANT SELECT ON public.var_patrol_current_week, public.var_patrol_all_time, public.var_patrol_recent_awards
  TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'var_patrol_scores'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.var_patrol_scores;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'var_patrol_weekly_awards'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.var_patrol_weekly_awards;
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule(jobname)
    FROM cron.job
    WHERE jobname = 'var_patrol_weekly_awards';

    PERFORM cron.schedule(
      'var_patrol_weekly_awards',
      '0 22,23 * * 0',
      $cron$SELECT CASE
        WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer = 0
          THEN public.award_var_patrol_week(public.var_patrol_week_start(now() - interval '7 days'))
        ELSE json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      END;$cron$
    );
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
