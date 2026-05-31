-- Hero score-bonus reflected in game leaderboards and weekly awards.
--
-- Behaviour:
--   * Edge Functions apply the strongest equipped seasonal score_bonus at submit time.
--   * Leaderboards and awards use the stored score only, so changing equipment later
--     cannot alter historical ranks or apply the bonus twice.
--   * base_score/item_bonus are exposed from score client_meta for UI display.
--
-- Idempotent; safe to re-run. Apply via Supabase SQL Editor or the Management API.

-- 1. Per-user leaderboard bonus (cross-game, strongest score_bonus item).
CREATE OR REPLACE VIEW public.hero_score_bonus AS
SELECT user_id, MAX(effect_value)::integer AS bonus
FROM public.public_hero_equipment
WHERE effect_type = 'score_bonus'
GROUP BY user_id;

GRANT SELECT ON public.hero_score_bonus TO anon, authenticated;

-- 2. Bug Jumper — current week
CREATE OR REPLACE VIEW public.bug_jumper_current_week WITH (security_invoker = true) AS
WITH current_week AS (
  SELECT public.bug_jumper_week_start(now()) AS week_start
),
round_counts AS (
  SELECT user_id, week_start, count(*)::integer AS rounds_played
  FROM public.bug_jumper_scores
  GROUP BY user_id, week_start
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id, s.nick_snapshot AS nick, s.week_start, s.score, s.hits, s.misses,
    s.accuracy, s.max_combo, s.submitted_at,
    COALESCE((s.client_meta->>'base_score')::int, s.score) AS base_score,
    COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0) AS item_bonus,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.bug_jumper_scores s
  JOIN current_week cw ON cw.week_start = s.week_start
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id AND rc.week_start = s.week_start
  ORDER BY s.user_id, s.score DESC, s.accuracy DESC, s.submitted_at
)
SELECT
  row_number() OVER (ORDER BY ub.score DESC, ub.accuracy DESC, ub.submitted_at)::integer AS rank,
  ub.user_id,
  ub.nick,
  ub.week_start,
  ub.score,
  ub.hits,
  ub.misses,
  ub.accuracy,
  ub.max_combo,
  ub.rounds_played,
  ub.submitted_at,
  ub.base_score,
  ub.item_bonus
FROM user_best ub
ORDER BY rank;

-- 3. Bug Jumper — all time
CREATE OR REPLACE VIEW public.bug_jumper_all_time WITH (security_invoker = true) AS
WITH round_counts AS (
  SELECT user_id, count(*)::integer AS rounds_played
  FROM public.bug_jumper_scores
  GROUP BY user_id
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id, s.nick_snapshot AS nick, s.week_start AS best_week_start, s.score, s.hits, s.misses,
    s.accuracy, s.max_combo, s.submitted_at,
    COALESCE((s.client_meta->>'base_score')::int, s.score) AS base_score,
    COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0) AS item_bonus,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.bug_jumper_scores s
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id
  ORDER BY s.user_id, s.score DESC, s.accuracy DESC, s.submitted_at
)
SELECT
  row_number() OVER (ORDER BY ub.score DESC, ub.accuracy DESC, ub.submitted_at)::integer AS rank,
  ub.user_id,
  ub.nick,
  ub.best_week_start,
  ub.score,
  ub.hits,
  ub.misses,
  ub.accuracy,
  ub.max_combo,
  ub.rounds_played,
  ub.submitted_at,
  ub.base_score,
  ub.item_bonus
FROM user_best ub
ORDER BY rank;

-- 4. Whack-a-Boss — current week
CREATE OR REPLACE VIEW public.whack_boss_current_week WITH (security_invoker = true) AS
WITH current_week AS (
  SELECT public.whack_boss_week_start(now()) AS week_start
),
round_counts AS (
  SELECT user_id, week_start, count(*)::integer AS rounds_played
  FROM public.whack_boss_scores
  GROUP BY user_id, week_start
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id, s.nick_snapshot AS nick, s.week_start, s.score, s.hits, s.misses,
    s.accuracy, s.max_combo, s.submitted_at,
    COALESCE(
      (s.client_meta->>'base_score')::int,
      GREATEST(0, s.score - COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0))
    ) AS base_score,
    COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0) AS item_bonus,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.whack_boss_scores s
  JOIN current_week cw ON cw.week_start = s.week_start
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id AND rc.week_start = s.week_start
  ORDER BY s.user_id, s.score DESC, s.accuracy DESC, s.submitted_at
)
SELECT
  row_number() OVER (ORDER BY ub.score DESC, ub.accuracy DESC, ub.submitted_at)::integer AS rank,
  ub.user_id,
  ub.nick,
  ub.week_start,
  ub.score,
  ub.hits,
  ub.misses,
  ub.accuracy,
  ub.max_combo,
  ub.rounds_played,
  ub.submitted_at,
  ub.base_score,
  ub.item_bonus
FROM user_best ub
ORDER BY rank;

-- 5. Whack-a-Boss — all time
CREATE OR REPLACE VIEW public.whack_boss_all_time WITH (security_invoker = true) AS
WITH round_counts AS (
  SELECT user_id, count(*)::integer AS rounds_played
  FROM public.whack_boss_scores
  GROUP BY user_id
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id, s.nick_snapshot AS nick, s.week_start AS best_week_start, s.score, s.hits, s.misses,
    s.accuracy, s.max_combo, s.submitted_at,
    COALESCE(
      (s.client_meta->>'base_score')::int,
      GREATEST(0, s.score - COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0))
    ) AS base_score,
    COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0) AS item_bonus,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.whack_boss_scores s
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id
  ORDER BY s.user_id, s.score DESC, s.accuracy DESC, s.submitted_at
)
SELECT
  row_number() OVER (ORDER BY ub.score DESC, ub.accuracy DESC, ub.submitted_at)::integer AS rank,
  ub.user_id,
  ub.nick,
  ub.best_week_start,
  ub.score,
  ub.hits,
  ub.misses,
  ub.accuracy,
  ub.max_combo,
  ub.rounds_played,
  ub.submitted_at,
  ub.base_score,
  ub.item_bonus
FROM user_best ub
ORDER BY rank;

-- 6. Bug Jumper weekly award — rank and record by stored score.
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

  IF EXISTS (SELECT 1 FROM public.bug_jumper_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, accuracy, prize_coins
      FROM public.bug_jumper_weekly_awards
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
    FROM public.bug_jumper_scores s
    WHERE s.week_start = p_week_start
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
      CASE rank WHEN 1 THEN 100 WHEN 2 THEN 50 WHEN 3 THEN 25 END AS prize_coins
    FROM ranked
    WHERE rank <= 3
  ),
  inserted AS (
    INSERT INTO public.bug_jumper_weekly_awards
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
    FROM public.bug_jumper_weekly_awards
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

-- 7. Whack-a-Boss weekly award — rank and record by stored score.
CREATE OR REPLACE FUNCTION public.award_whack_boss_week(
  p_week_start date DEFAULT public.whack_boss_week_start(now() - interval '7 days')
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_week date := public.whack_boss_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.whack_boss_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, accuracy, prize_coins
      FROM public.whack_boss_weekly_awards
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
    FROM public.whack_boss_scores s
    WHERE s.week_start = p_week_start
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
      CASE rank WHEN 1 THEN 100 WHEN 2 THEN 50 WHEN 3 THEN 25 END AS prize_coins
    FROM ranked
    WHERE rank <= 3
  ),
  inserted AS (
    INSERT INTO public.whack_boss_weekly_awards
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
    FROM public.whack_boss_weekly_awards
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

NOTIFY pgrst, 'reload schema';
