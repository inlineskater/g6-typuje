-- Bug Jumper: average of your best 5 runs, not just your single best (2026-07).
--
-- Previously the weekly/all-time leaderboards and the weekly award both took
-- your single best round (DISTINCT ON user_id ... ORDER BY score DESC). Now
-- they average your top 5 scoring rounds instead (fewer than 5 played just
-- averages over however many you have) — rewards a consistently good run of
-- attempts over one lucky round, without requiring endless grinding to keep
-- climbing (only your best 5 ever count, extra rounds below that don't hurt
-- or help). The per-round score itself is unchanged (0-30, one point per
-- line reached) — this only changes how rounds are AGGREGATED into a rank.
--
-- Run after supabase/bug-jumper-dynamic-course.sql. Idempotent.
--
-- ⚠️ SUPERSEDES bug-jumper-dynamic-course.sql's copies of
--    bug_jumper_current_week, bug_jumper_all_time, and award_bug_jumper_week
--    (single-best-row DISTINCT ON logic). bug_jumper_recent_awards is
--    untouched — it just reads whatever award_bug_jumper_week already wrote.
--
-- hits/misses/max_combo/base_score/item_bonus are dropped from the two
-- leaderboard views: they were per-round fields with no single sensible value
-- once 5 rounds are averaged together, and nothing in index.html or
-- bug-jumper-action reads them for bug_jumper specifically.

-- CREATE OR REPLACE VIEW can't drop columns (hits/misses/max_combo/etc. are
-- gone below), so the two leaderboard views must be dropped first. Nothing
-- else depends on them (verified via pg_depend before writing this).
DROP VIEW IF EXISTS public.bug_jumper_current_week;
DROP VIEW IF EXISTS public.bug_jumper_all_time;

CREATE OR REPLACE VIEW public.bug_jumper_current_week WITH (security_invoker = true) AS
WITH current_week AS (
  SELECT public.bug_jumper_week_start(now()) AS week_start
),
eligible AS (
  SELECT s.*
  FROM public.bug_jumper_scores s
  JOIN current_week cw ON cw.week_start = s.week_start
  WHERE s.course_id = 'bug_jumper_dynamic_v1'
),
ranked_runs AS (
  SELECT
    e.*,
    ROW_NUMBER() OVER (
      PARTITION BY e.user_id
      ORDER BY e.score DESC, e.completion_ms ASC NULLS LAST, e.submitted_at ASC
    ) AS run_rank
  FROM eligible e
),
top_runs AS (
  SELECT * FROM ranked_runs WHERE run_rank <= 5
),
user_agg AS (
  SELECT
    t.user_id,
    (ARRAY_AGG(t.nick_snapshot ORDER BY t.submitted_at DESC))[1] AS nick,
    ROUND(AVG(t.score), 2) AS score,
    COUNT(*)::integer AS rounds_played,
    MIN(t.completion_ms) FILTER (WHERE t.completion_ms IS NOT NULL) AS completion_ms,
    MAX(t.submitted_at) AS submitted_at
  FROM top_runs t
  GROUP BY t.user_id
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, completion_ms ASC NULLS LAST, submitted_at ASC))::integer AS rank,
  user_id,
  nick,
  (SELECT week_start FROM current_week) AS week_start,
  score,
  rounds_played,
  submitted_at,
  'bug_jumper_dynamic_v1' AS course_id,
  completion_ms
FROM user_agg
ORDER BY rank;

CREATE OR REPLACE VIEW public.bug_jumper_all_time WITH (security_invoker = true) AS
WITH eligible AS (
  SELECT s.*
  FROM public.bug_jumper_scores s
  WHERE s.course_id = 'bug_jumper_dynamic_v1'
),
ranked_runs AS (
  SELECT
    e.*,
    ROW_NUMBER() OVER (
      PARTITION BY e.user_id
      ORDER BY e.score DESC, e.completion_ms ASC NULLS LAST, e.submitted_at ASC
    ) AS run_rank
  FROM eligible e
),
top_runs AS (
  SELECT * FROM ranked_runs WHERE run_rank <= 5
),
user_agg AS (
  SELECT
    user_id,
    (ARRAY_AGG(nick_snapshot ORDER BY submitted_at DESC))[1] AS nick,
    MAX(week_start) AS best_week_start,
    ROUND(AVG(score), 2) AS score,
    COUNT(*)::integer AS rounds_played,
    MIN(completion_ms) FILTER (WHERE completion_ms IS NOT NULL) AS completion_ms,
    MAX(submitted_at) AS submitted_at
  FROM top_runs
  GROUP BY user_id
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, completion_ms ASC NULLS LAST, submitted_at ASC))::integer AS rank,
  user_id,
  nick,
  best_week_start,
  score,
  rounds_played,
  submitted_at,
  'bug_jumper_dynamic_v1' AS course_id,
  completion_ms
FROM user_agg
ORDER BY rank;

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
      AND course_id = 'bug_jumper_dynamic_v1'
  ) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, accuracy, prize_coins
      FROM public.bug_jumper_weekly_awards
      WHERE week_start = p_week_start
        AND course_id = 'bug_jumper_dynamic_v1'
      ORDER BY rank
    ) a;

    RETURN json_build_object(
      'ok', true,
      'already_awarded', true,
      'week_start', p_week_start,
      'awards', v_awards
    );
  END IF;

  WITH eligible AS (
    SELECT s.*
    FROM public.bug_jumper_scores s
    WHERE s.week_start = p_week_start
      AND s.course_id = 'bug_jumper_dynamic_v1'
  ),
  ranked_runs AS (
    SELECT
      e.*,
      ROW_NUMBER() OVER (
        PARTITION BY e.user_id
        ORDER BY e.score DESC, e.completion_ms ASC NULLS LAST, e.submitted_at ASC
      ) AS run_rank
    FROM eligible e
  ),
  top_runs AS (
    SELECT * FROM ranked_runs WHERE run_rank <= 5
  ),
  user_agg AS (
    SELECT
      user_id,
      (ARRAY_AGG(nick_snapshot ORDER BY submitted_at DESC))[1] AS nick_snapshot,
      AVG(score) AS avg_score,
      MIN(completion_ms) FILTER (WHERE completion_ms IS NOT NULL) AS best_completion_ms,
      MAX(submitted_at) AS submitted_at
    FROM top_runs
    GROUP BY user_id
  ),
  ranked AS (
    SELECT
      user_id,
      nick_snapshot,
      avg_score,
      best_completion_ms,
      (ROW_NUMBER() OVER (ORDER BY avg_score DESC, best_completion_ms ASC NULLS LAST, submitted_at ASC))::integer AS rank
    FROM user_agg
  ),
  winners AS (
    SELECT
      user_id,
      nick_snapshot,
      rank,
      ROUND(avg_score)::integer AS score,
      ROUND((avg_score / 30.0) * 100, 2) AS accuracy,
      CASE rank WHEN 1 THEN 1000 WHEN 2 THEN 500 WHEN 3 THEN 200 END AS prize_coins
    FROM ranked
    WHERE rank <= 3
  ),
  inserted AS (
    INSERT INTO public.bug_jumper_weekly_awards
      (week_start, course_id, user_id, nick_snapshot, rank, score, accuracy, prize_coins)
    SELECT p_week_start, 'bug_jumper_dynamic_v1', user_id, nick_snapshot, rank, score, accuracy, prize_coins
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
      AND course_id = 'bug_jumper_dynamic_v1'
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
