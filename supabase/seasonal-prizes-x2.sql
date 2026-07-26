-- Seasonal weekly prizes x2 (2026-07-26).
--
-- Every seasonal game's Monday payout doubles: gold 500->1000, silver 250->500,
-- bronze 100->200. Already-awarded weeks are untouched: award_*_week() refuses to
-- re-award a week that already has rows in <game>_weekly_awards, so this only
-- affects payouts still to come (the current week onward).
--
-- HOW THIS FILE WAS BUILT: each function body below was dumped from the LIVE
-- production database with pg_get_functiondef() and the prize CASE swapped --
-- nothing else was touched. That matters: prod had two refinements that had never
-- been written back to the repo (whack_boss's server_validated filter, snake's
-- duration_ms tiebreak), so regenerating these from the .sql files alone would
-- have silently REVERTED them. Those two source files were fixed to match.
--
-- Canonical source file per game, for future edits:
--   award_whack_boss_week <- supabase/hero-leaderboard-bonus.sql
--   award_bug_jumper_week <- supabase/bug-jumper-top5-scoring.sql
--   award_flappy_pants_week <- supabase/flappy-pants.sql
--   award_snake_week     <- supabase/snake.sql
--   award_invoice_horde_week <- supabase/invoice-horde.sql
--   award_var_patrol_week <- supabase/var-patrol.sql
--   award_egg_catch_week <- supabase/egg-catch.sql
--   award_super_mariusz_week <- supabase/super-mariusz.sql
--   award_popup_panic_week <- supabase/popup-panic.sql
--   award_tetris_week    <- supabase/tetris.sql
--
-- WARNING: if you later change one of those source files' award function, either
-- re-generate this bundle from prod or hand-patch the matching block, otherwise
-- re-running this file reverts your change.
--
-- Idempotent (CREATE OR REPLACE only); paste into the Supabase SQL Editor -> Run.

-- ---- whack_boss ---- (canonical source: supabase/hero-leaderboard-bonus.sql)
CREATE OR REPLACE FUNCTION public.award_whack_boss_week(p_week_start date DEFAULT whack_boss_week_start((now() - '7 days'::interval)))
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- ---- bug_jumper ---- (canonical source: supabase/bug-jumper-top5-scoring.sql)
CREATE OR REPLACE FUNCTION public.award_bug_jumper_week(p_week_start date DEFAULT bug_jumper_week_start((now() - '7 days'::interval)))
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- ---- flappy_pants ---- (canonical source: supabase/flappy-pants.sql)
CREATE OR REPLACE FUNCTION public.award_flappy_pants_week(p_week_start date DEFAULT flappy_pants_week_start((now() - '7 days'::interval)))
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_week date := public.flappy_pants_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.flappy_pants_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, prize_coins
      FROM public.flappy_pants_weekly_awards
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
      s.submitted_at
    FROM public.flappy_pants_scores s
    WHERE s.week_start = p_week_start
      AND s.client_meta @> '{"server_validated": true}'::jsonb
    ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
  ),
  ranked AS (
    SELECT
      user_id,
      nick_snapshot,
      score,
      (ROW_NUMBER() OVER (ORDER BY score DESC, submitted_at ASC))::integer AS rank
    FROM user_best
  ),
  winners AS (
    SELECT
      user_id,
      nick_snapshot,
      rank,
      score,
      CASE rank WHEN 1 THEN 1000 WHEN 2 THEN 500 WHEN 3 THEN 200 END AS prize_coins
    FROM ranked
    WHERE rank <= 3
  ),
  inserted AS (
    INSERT INTO public.flappy_pants_weekly_awards
      (week_start, user_id, nick_snapshot, rank, score, prize_coins)
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
    FROM public.flappy_pants_weekly_awards
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
$function$;

-- ---- snake ---- (canonical source: supabase/snake.sql)
CREATE OR REPLACE FUNCTION public.award_snake_week(p_week_start date DEFAULT snake_week_start((now() - '7 days'::interval)))
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    ORDER BY s.user_id, s.score DESC, s.duration_ms ASC, s.submitted_at ASC
  ),
  ranked AS (
    SELECT
      user_id,
      nick_snapshot,
      score,
      duration_ms,
      (ROW_NUMBER() OVER (ORDER BY score DESC, duration_ms ASC, submitted_at ASC))::integer AS rank
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
$function$;

-- ---- invoice_horde ---- (canonical source: supabase/invoice-horde.sql)
CREATE OR REPLACE FUNCTION public.award_invoice_horde_week(p_week_start date DEFAULT invoice_horde_week_start((now() - '7 days'::interval)))
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_week date := public.invoice_horde_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.invoice_horde_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, duration_ms, prize_coins
      FROM public.invoice_horde_weekly_awards
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
    FROM public.invoice_horde_scores s
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
    INSERT INTO public.invoice_horde_weekly_awards
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
    FROM public.invoice_horde_weekly_awards
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
$function$;

-- ---- var_patrol ---- (canonical source: supabase/var-patrol.sql)
CREATE OR REPLACE FUNCTION public.award_var_patrol_week(p_week_start date DEFAULT var_patrol_week_start((now() - '7 days'::interval)))
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- ---- egg_catch ---- (canonical source: supabase/egg-catch.sql)
CREATE OR REPLACE FUNCTION public.award_egg_catch_week(p_week_start date DEFAULT egg_catch_week_start((now() - '7 days'::interval)))
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      CASE rank WHEN 1 THEN 1000 WHEN 2 THEN 500 WHEN 3 THEN 200 END AS prize_coins
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
$function$;

-- ---- super_mariusz ---- (canonical source: supabase/super-mariusz.sql)
CREATE OR REPLACE FUNCTION public.award_super_mariusz_week(p_week_start date DEFAULT super_mariusz_week_start((now() - '7 days'::interval)))
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      CASE rank WHEN 1 THEN 1000 WHEN 2 THEN 500 WHEN 3 THEN 200 END AS prize_coins
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
$function$;

-- ---- popup_panic ---- (canonical source: supabase/popup-panic.sql)
CREATE OR REPLACE FUNCTION public.award_popup_panic_week(p_week_start date DEFAULT popup_panic_week_start((now() - '7 days'::interval)))
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_week date := public.popup_panic_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.popup_panic_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, duration_ms, prize_coins
      FROM public.popup_panic_weekly_awards
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
    FROM public.popup_panic_scores s
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
    INSERT INTO public.popup_panic_weekly_awards
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
    FROM public.popup_panic_weekly_awards
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
$function$;

-- ---- tetris ---- (canonical source: supabase/tetris.sql)
CREATE OR REPLACE FUNCTION public.award_tetris_week(p_week_start date DEFAULT tetris_week_start((now() - '7 days'::interval)))
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_week date := public.tetris_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tetris_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, duration_ms, prize_coins
      FROM public.tetris_weekly_awards
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
    FROM public.tetris_scores s
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
    INSERT INTO public.tetris_weekly_awards
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
    FROM public.tetris_weekly_awards
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
$function$;

NOTIFY pgrst, 'reload schema';
