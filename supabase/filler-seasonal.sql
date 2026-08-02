-- „Filler" (filler) — Phase 2 seasonal-game promotion for Rynek Proroctw G6.
-- Run after supabase/filler.sql. Debuts via SEASONAL_OVERRIDES on the week
-- starting 2026-08-10 (see index.html + supabase/season-award-gating.sql,
-- which must both be updated in the same deploy as this file).
--
-- Unlike every other seasonal game's promotion, there is no `filler_rounds`
-- table here: `filler_matches`/`filler_match_players` (supabase/filler.sql)
-- ALREADY are the "round" — Filler is server-authoritative for every move
-- (see that file's header comment and docs/filler.md), so a match's full
-- lifecycle (start, moves, finish) already lives there for BOTH the arcade
-- and seasonal contexts. This file only adds what's new for the seasonal
-- side: a scores/weekly-awards pair, the three standard leaderboard views,
-- and the award payout — the same shape every other seasonal game uses.
--
-- The one Edge Function change this requires (in filler-action's
-- finishScoring/scoreOnePlayer) is a single extra INSERT into
-- filler_scores, gated on the match's `arcade_mode` being false (i.e.
-- launched from the seasonal tab, not the „Wszystkie Gry" picker) — see
-- docs/filler.md's Phase 2 section.

CREATE OR REPLACE FUNCTION public.filler_week_start(p_ts timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Monday-starting week (Mon..Sun) in Europe/Warsaw.
  SELECT date_trunc('week', p_ts AT TIME ZONE 'Europe/Warsaw')::date;
$$;

CREATE TABLE IF NOT EXISTS public.filler_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id      uuid NOT NULL REFERENCES public.filler_matches(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  week_start    date NOT NULL,
  score         integer NOT NULL CHECK (score >= 0),
  tiles         integer NOT NULL DEFAULT 0 CHECK (tiles >= 0),
  moves_made    integer NOT NULL DEFAULT 0 CHECK (moves_made >= 0),
  won           boolean NOT NULL,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  client_meta   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- One scored row per player per match — a match can only ever finish once,
  -- and finishScoring only ever calls scoreOnePlayer once per human seat.
  UNIQUE (match_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.filler_weekly_awards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start    date NOT NULL,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  rank          integer NOT NULL CHECK (rank BETWEEN 1 AND 3),
  score         integer NOT NULL CHECK (score >= 0),
  prize_coins   integer NOT NULL CHECK (prize_coins > 0),
  awarded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, rank),
  UNIQUE (week_start, user_id)
);

CREATE INDEX IF NOT EXISTS filler_scores_week_rank_idx
  ON public.filler_scores(week_start, score DESC, submitted_at ASC);
CREATE INDEX IF NOT EXISTS filler_scores_user_time_idx
  ON public.filler_scores(user_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS filler_awards_week_idx
  ON public.filler_weekly_awards(week_start DESC, rank ASC);

ALTER TABLE public.filler_scores        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.filler_weekly_awards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "filler_scores_select" ON public.filler_scores;
CREATE POLICY "filler_scores_select" ON public.filler_scores
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "filler_awards_select" ON public.filler_weekly_awards;
CREATE POLICY "filler_awards_select" ON public.filler_weekly_awards
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.filler_scores, public.filler_weekly_awards FROM anon, authenticated;
GRANT SELECT ON public.filler_scores, public.filler_weekly_awards TO authenticated;
-- filler-action's own privileged SUPABASE_DB_URL connection is the only
-- writer, same as every other table in supabase/filler.sql.

CREATE OR REPLACE VIEW public.filler_current_week WITH (security_invoker = true) AS
WITH current_week AS (
  SELECT public.filler_week_start(now()) AS week_start
),
match_counts AS (
  SELECT user_id, week_start, COUNT(*)::integer AS matches_played
  FROM public.filler_scores
  GROUP BY user_id, week_start
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.week_start,
    s.score,
    s.tiles,
    s.moves_made,
    s.won,
    s.submitted_at,
    COALESCE(mc.matches_played, 1) AS matches_played
  FROM public.filler_scores s
  JOIN current_week cw ON cw.week_start = s.week_start
  LEFT JOIN match_counts mc ON mc.user_id = s.user_id AND mc.week_start = s.week_start
  ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, submitted_at ASC))::integer AS rank,
  user_id, nick, week_start, score, tiles, moves_made, won, matches_played, submitted_at
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.filler_all_time WITH (security_invoker = true) AS
WITH match_counts AS (
  SELECT user_id, COUNT(*)::integer AS matches_played
  FROM public.filler_scores
  GROUP BY user_id
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.week_start AS best_week_start,
    s.score,
    s.tiles,
    s.moves_made,
    s.won,
    s.submitted_at,
    COALESCE(mc.matches_played, 1) AS matches_played
  FROM public.filler_scores s
  LEFT JOIN match_counts mc ON mc.user_id = s.user_id
  ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, submitted_at ASC))::integer AS rank,
  user_id, nick, best_week_start, score, tiles, moves_made, won, matches_played, submitted_at
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.filler_recent_awards WITH (security_invoker = true) AS
SELECT id, week_start, user_id, nick_snapshot AS nick, rank, score, prize_coins, awarded_at
FROM public.filler_weekly_awards
ORDER BY week_start DESC, rank ASC;

CREATE OR REPLACE FUNCTION public.award_filler_week(
  p_week_start date DEFAULT public.filler_week_start(now() - interval '7 days')
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_week date := public.filler_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.filler_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, prize_coins
      FROM public.filler_weekly_awards
      WHERE week_start = p_week_start
      ORDER BY rank
    ) a;

    RETURN json_build_object(
      'ok', true, 'already_awarded', true, 'week_start', p_week_start, 'awards', v_awards
    );
  END IF;

  WITH user_best AS (
    SELECT DISTINCT ON (s.user_id)
      s.user_id, s.nick_snapshot, s.score, s.submitted_at
    FROM public.filler_scores s
    WHERE s.week_start = p_week_start
    ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
  ),
  ranked AS (
    SELECT
      user_id, nick_snapshot, score,
      (ROW_NUMBER() OVER (ORDER BY score DESC, submitted_at ASC))::integer AS rank
    FROM user_best
  ),
  winners AS (
    SELECT
      user_id, nick_snapshot, rank, score,
      CASE rank WHEN 1 THEN 1000 WHEN 2 THEN 500 WHEN 3 THEN 200 END AS prize_coins
    FROM ranked
    WHERE rank <= 3
  ),
  inserted AS (
    INSERT INTO public.filler_weekly_awards (week_start, user_id, nick_snapshot, rank, score, prize_coins)
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
    FROM public.filler_weekly_awards
    WHERE week_start = p_week_start
    ORDER BY rank
  ) a;

  RETURN json_build_object(
    'ok', true, 'already_awarded', false, 'week_start', p_week_start,
    'awards_created', v_inserted_count, 'coins_awarded', v_total_prize, 'awards', v_awards
  );
END;
$$;

REVOKE ALL ON FUNCTION public.filler_week_start(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_filler_week(date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.filler_week_start(timestamptz) TO authenticated;
GRANT SELECT ON public.filler_current_week, public.filler_all_time, public.filler_recent_awards TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'filler_scores'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.filler_scores;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'filler_weekly_awards'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.filler_weekly_awards;
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Season-gated weekly award (the gate lives in seasonal_game_for_week(); the
-- cron command is only parsed at run time, so scheduling works even before
-- the updated season-award-gating.sql is applied — but apply it before the
-- 2026-08-10 debut Monday).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule(jobname)
    FROM cron.job
    WHERE jobname = 'filler_weekly_awards';

    PERFORM cron.schedule(
      'filler_weekly_awards',
      '0 22,23 * * 0',
      $cron$SELECT CASE
        WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
          THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
        WHEN public.seasonal_game_for_week(public.filler_week_start(now() - interval '7 days')) = 'filler'
          THEN public.award_filler_week(public.filler_week_start(now() - interval '7 days'))
          ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$cron$
    );
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
