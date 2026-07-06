-- Bug Jumper Hard Course v2 rollout.
-- Preserves legacy random-course scores and makes active Bug Jumper boards use
-- only the fixed hard course.

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

CREATE INDEX IF NOT EXISTS bug_jumper_scores_course_week_rank_idx
  ON public.bug_jumper_scores(course_id, week_start, score DESC, completion_ms ASC NULLS LAST, accuracy DESC, submitted_at ASC);

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
      CASE rank WHEN 1 THEN 500 WHEN 2 THEN 250 WHEN 3 THEN 100 END AS prize_coins
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

GRANT SELECT ON public.bug_jumper_current_week, public.bug_jumper_all_time, public.bug_jumper_recent_awards
  TO authenticated;

NOTIFY pgrst, 'reload schema';
