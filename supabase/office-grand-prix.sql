-- Office Grand Prix G6 (office_grand_prix)
-- Authoritative multiplayer race storage, read-only browser surface, private
-- Realtime authorization, and weekly awards.
--
-- Deployment order:
--   1. schema.sql, coin-transactions.sql, arcade.sql
--   2. this file
--   3. season-award-gating.sql and polish-midnight-schedules.sql
--   4. deploy functions/office-grand-prix-action with JWT verification enabled
--
-- The browser receives SELECT only. All lobby mutations, archive entry fees,
-- submissions, deterministic replay, and official score writes are performed
-- by the office-grand-prix-action Edge Function.

CREATE OR REPLACE FUNCTION public.office_grand_prix_week_start(
  p_ts timestamptz DEFAULT now()
)
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT date_trunc('week', p_ts AT TIME ZONE 'Europe/Warsaw')::date;
$$;

-- Server-derived mode:
--   test     — free public test through Sunday 2026-07-26
--   seasonal — the active weekly game after the official launch
--   arcade   — post-season one-coin archive play
--
-- Dynamic SQL keeps this file deployable before seasonal_game_for_week(date)
-- is updated with the new rotation entry.
CREATE OR REPLACE FUNCTION public.office_grand_prix_mode(
  p_ts timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_local timestamp := p_ts AT TIME ZONE 'Europe/Warsaw';
  v_week date := public.office_grand_prix_week_start(p_ts);
  v_game text;
BEGIN
  IF v_local < timestamp '2026-07-27 00:00:00' THEN
    RETURN 'test';
  END IF;

  IF to_regprocedure('public.seasonal_game_for_week(date)') IS NOT NULL THEN
    EXECUTE 'SELECT public.seasonal_game_for_week($1)'
      INTO v_game
      USING v_week;
  END IF;

  IF v_game = 'office_grand_prix' THEN
    RETURN 'seasonal';
  END IF;
  RETURN 'arcade';
END;
$$;

CREATE TABLE IF NOT EXISTS public.office_grand_prix_sessions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status                   text NOT NULL DEFAULT 'lobby'
                           CHECK (status IN (
                             'lobby', 'countdown', 'racing', 'finished', 'cancelled'
                           )),
  game_mode                text NOT NULL
                           CHECK (game_mode IN ('test', 'seasonal', 'arcade')),
  seed                     integer NOT NULL CHECK (seed >= 0),
  max_players              smallint NOT NULL DEFAULT 8
                           CHECK (max_players = 8),
  created_by               uuid NOT NULL
                           REFERENCES public.profiles(id) ON DELETE RESTRICT,
  coordinator_id           uuid
                           REFERENCES public.profiles(id) ON DELETE SET NULL,
  coordinator_claimed_at   timestamptz,
  coordinator_heartbeat_at timestamptz,
  countdown_started_at     timestamptz,
  roster_locks_at          timestamptz,
  roster_locked_at         timestamptz,
  race_starts_at           timestamptz,
  race_started_at          timestamptz,
  race_ends_at             timestamptz,
  submissions_due_at       timestamptz,
  finished_at              timestamptz,
  version                  integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (countdown_started_at IS NULL AND roster_locks_at IS NULL AND race_starts_at IS NULL)
    OR
    (countdown_started_at IS NOT NULL
      AND roster_locks_at = countdown_started_at + interval '10 seconds'
      AND race_starts_at = countdown_started_at + interval '15 seconds')
  ),
  CHECK (
    race_started_at IS NULL
    OR (
      race_ends_at = race_started_at + interval '90 seconds'
      AND submissions_due_at = race_started_at + interval '100 seconds'
    )
  )
);

-- Exactly one lobby/countdown/race may exist at a time. Expression indexes are
-- used because the singleton key is intentionally not part of the data model.
CREATE UNIQUE INDEX IF NOT EXISTS office_grand_prix_one_active_session_idx
  ON public.office_grand_prix_sessions ((1))
  WHERE status IN ('lobby', 'countdown', 'racing');

CREATE INDEX IF NOT EXISTS office_grand_prix_sessions_status_time_idx
  ON public.office_grand_prix_sessions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS office_grand_prix_sessions_coordinator_idx
  ON public.office_grand_prix_sessions(coordinator_id)
  WHERE coordinator_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.office_grand_prix_participants (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               uuid NOT NULL
                           REFERENCES public.office_grand_prix_sessions(id)
                           ON DELETE CASCADE,
  slot                     smallint NOT NULL CHECK (slot BETWEEN 0 AND 7),
  user_id                  uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot            text NOT NULL CHECK (length(nick_snapshot) BETWEEN 1 AND 80),
  cosmetic                 smallint NOT NULL CHECK (cosmetic BETWEEN 0 AND 7),
  is_bot                   boolean NOT NULL DEFAULT false,
  is_ready                 boolean NOT NULL DEFAULT false,
  joined_at                timestamptz NOT NULL DEFAULT now(),
  ready_at                 timestamptz,
  entry_fee_charged        boolean NOT NULL DEFAULT false,
  entry_fee_charged_at     timestamptz,
  submission_received_at   timestamptz,
  finished                 boolean,
  finish_place             smallint CHECK (finish_place BETWEEN 1 AND 8),
  completion_ms            integer CHECK (
                             completion_ms IS NULL
                             OR completion_ms BETWEEN 50 AND 90000
                           ),
  points                   smallint CHECK (points BETWEEN 0 AND 12),
  result_json              jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_finalized_at      timestamptz,
  arcade_score_recorded_at timestamptz,
  UNIQUE (session_id, slot),
  UNIQUE (session_id, cosmetic),
  CHECK (
    (is_bot AND user_id IS NULL AND is_ready)
    OR
    (NOT is_bot AND user_id IS NOT NULL)
  ),
  CHECK (
    (entry_fee_charged AND entry_fee_charged_at IS NOT NULL)
    OR
    (NOT entry_fee_charged AND entry_fee_charged_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS office_grand_prix_participants_user_idx
  ON public.office_grand_prix_participants(session_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS office_grand_prix_participants_user_time_idx
  ON public.office_grand_prix_participants(user_id, joined_at DESC)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.office_grand_prix_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL
                  REFERENCES public.office_grand_prix_sessions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL
                  REFERENCES public.profiles(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (
                    length(idempotency_key) BETWEEN 8 AND 100
                    AND idempotency_key ~ '^[A-Za-z0-9:_-]+$'
                  ),
  payload_hash    text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  elapsed_ticks   smallint NOT NULL CHECK (elapsed_ticks BETWEEN 1 AND 1800),
  input_events    smallint NOT NULL CHECK (input_events BETWEEN 0 AND 1800),
  input_log       jsonb NOT NULL CHECK (jsonb_typeof(input_log) = 'array'),
  client_meta     jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, user_id),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS office_grand_prix_submissions_session_idx
  ON public.office_grand_prix_submissions(session_id, received_at);

CREATE INDEX IF NOT EXISTS office_grand_prix_submissions_user_time_idx
  ON public.office_grand_prix_submissions(user_id, received_at DESC);

CREATE TABLE IF NOT EXISTS public.office_grand_prix_scores (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL
                   REFERENCES public.office_grand_prix_sessions(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL
                   REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot    text NOT NULL,
  week_start       date NOT NULL,
  game_mode        text NOT NULL CHECK (game_mode IN ('test', 'seasonal', 'arcade')),
  finish_place     smallint NOT NULL CHECK (finish_place BETWEEN 1 AND 8),
  placement_points smallint NOT NULL CHECK (placement_points BETWEEN 0 AND 10),
  fastest_bonus    smallint NOT NULL DEFAULT 0 CHECK (fastest_bonus IN (0, 2)),
  total_points     smallint NOT NULL CHECK (total_points BETWEEN 0 AND 12),
  finished         boolean NOT NULL,
  completion_ms    integer CHECK (
                     completion_ms IS NULL
                     OR completion_ms BETWEEN 50 AND 90000
                   ),
  input_events     smallint NOT NULL DEFAULT 0 CHECK (input_events BETWEEN 0 AND 1800),
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  server_meta      jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (session_id, user_id),
  CHECK (total_points = placement_points + fastest_bonus),
  CHECK (
    (finished AND completion_ms IS NOT NULL AND placement_points > 0)
    OR
    (NOT finished AND completion_ms IS NULL
      AND placement_points = 0 AND fastest_bonus = 0 AND total_points = 0)
  )
);

CREATE INDEX IF NOT EXISTS office_grand_prix_scores_week_user_rank_idx
  ON public.office_grand_prix_scores(
    week_start,
    user_id,
    total_points DESC,
    completion_ms ASC,
    submitted_at ASC
  )
  WHERE game_mode = 'seasonal';

CREATE INDEX IF NOT EXISTS office_grand_prix_scores_week_rank_idx
  ON public.office_grand_prix_scores(
    week_start,
    total_points DESC,
    finish_place ASC,
    completion_ms ASC,
    submitted_at ASC
  )
  WHERE game_mode = 'seasonal';

CREATE INDEX IF NOT EXISTS office_grand_prix_scores_user_time_idx
  ON public.office_grand_prix_scores(user_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS public.office_grand_prix_weekly_awards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start       date NOT NULL,
  user_id          uuid NOT NULL
                   REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot    text NOT NULL,
  rank             smallint NOT NULL CHECK (rank BETWEEN 1 AND 3),
  score            integer NOT NULL CHECK (score BETWEEN 0 AND 60),
  wins             smallint NOT NULL DEFAULT 0 CHECK (wins BETWEEN 0 AND 5),
  combined_time_ms integer NOT NULL CHECK (combined_time_ms BETWEEN 0 AND 450000),
  races_counted    smallint NOT NULL CHECK (races_counted BETWEEN 1 AND 5),
  prize_coins      integer NOT NULL CHECK (prize_coins IN (500, 250, 100)),
  awarded_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, rank),
  UNIQUE (week_start, user_id)
);

CREATE INDEX IF NOT EXISTS office_grand_prix_awards_week_idx
  ON public.office_grand_prix_weekly_awards(week_start DESC, rank ASC);

ALTER TABLE public.office_grand_prix_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_grand_prix_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_grand_prix_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_grand_prix_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_grand_prix_weekly_awards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "office_grand_prix_sessions_select" ON public.office_grand_prix_sessions;
CREATE POLICY "office_grand_prix_sessions_select"
  ON public.office_grand_prix_sessions
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "office_grand_prix_participants_select" ON public.office_grand_prix_participants;
CREATE POLICY "office_grand_prix_participants_select"
  ON public.office_grand_prix_participants
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "office_grand_prix_submissions_select_own" ON public.office_grand_prix_submissions;
CREATE POLICY "office_grand_prix_submissions_select_own"
  ON public.office_grand_prix_submissions
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "office_grand_prix_scores_select" ON public.office_grand_prix_scores;
CREATE POLICY "office_grand_prix_scores_select"
  ON public.office_grand_prix_scores
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "office_grand_prix_awards_select" ON public.office_grand_prix_weekly_awards;
CREATE POLICY "office_grand_prix_awards_select"
  ON public.office_grand_prix_weekly_awards
  FOR SELECT TO authenticated
  USING (true);

REVOKE ALL
  ON public.office_grand_prix_sessions,
     public.office_grand_prix_participants,
     public.office_grand_prix_submissions,
     public.office_grand_prix_scores,
     public.office_grand_prix_weekly_awards
  FROM PUBLIC, anon, authenticated;

GRANT SELECT
  ON public.office_grand_prix_sessions,
     public.office_grand_prix_participants,
     public.office_grand_prix_submissions,
     public.office_grand_prix_scores,
     public.office_grand_prix_weekly_awards
  TO authenticated;

-- Weekly leaderboard: only the player's five best official seasonal races
-- count. Tie breakers are wins, combined race time, then the earlier result.
CREATE OR REPLACE VIEW public.office_grand_prix_current_week
WITH (security_invoker = true)
AS
WITH eligible AS (
  SELECT
    s.*,
    ROW_NUMBER() OVER (
      PARTITION BY s.user_id, s.week_start
      ORDER BY
        s.total_points DESC,
        s.finished DESC,
        s.completion_ms ASC NULLS LAST,
        s.submitted_at ASC,
        s.session_id
    ) AS race_number
  FROM public.office_grand_prix_scores s
  WHERE s.game_mode = 'seasonal'
    AND s.week_start = public.office_grand_prix_week_start(now())
),
counted AS (
  SELECT * FROM eligible WHERE race_number <= 5
),
rollup AS (
  SELECT
    user_id,
    week_start,
    (ARRAY_AGG(nick_snapshot ORDER BY submitted_at DESC))[1] AS nick,
    SUM(total_points)::integer AS score,
    COUNT(*) FILTER (WHERE finish_place = 1)::integer AS wins,
    SUM(COALESCE(completion_ms, 90000))::integer AS combined_time_ms,
    COUNT(*)::integer AS races_counted,
    MIN(submitted_at) AS first_result_at,
    MAX(submitted_at) AS latest_result_at
  FROM counted
  GROUP BY user_id, week_start
)
SELECT
  ROW_NUMBER() OVER (
    ORDER BY score DESC, wins DESC, combined_time_ms ASC, first_result_at ASC, user_id
  )::integer AS rank,
  user_id,
  nick,
  week_start,
  score,
  wins,
  combined_time_ms,
  races_counted,
  first_result_at,
  latest_result_at
FROM rollup
ORDER BY rank;

CREATE OR REPLACE VIEW public.office_grand_prix_all_time
WITH (security_invoker = true)
AS
WITH eligible AS (
  SELECT
    s.*,
    ROW_NUMBER() OVER (
      PARTITION BY s.user_id, s.week_start
      ORDER BY
        s.total_points DESC,
        s.finished DESC,
        s.completion_ms ASC NULLS LAST,
        s.submitted_at ASC,
        s.session_id
    ) AS race_number
  FROM public.office_grand_prix_scores s
  WHERE s.game_mode = 'seasonal'
),
counted AS (
  SELECT * FROM eligible WHERE race_number <= 5
),
rollup AS (
  SELECT
    user_id,
    (ARRAY_AGG(nick_snapshot ORDER BY submitted_at DESC))[1] AS nick,
    SUM(total_points)::integer AS score,
    COUNT(*) FILTER (WHERE finish_place = 1)::integer AS wins,
    SUM(COALESCE(completion_ms, 90000))::bigint AS combined_time_ms,
    COUNT(*)::integer AS races_counted,
    COUNT(DISTINCT week_start)::integer AS weeks_played,
    MIN(submitted_at) AS first_result_at,
    MAX(submitted_at) AS latest_result_at
  FROM counted
  GROUP BY user_id
)
SELECT
  ROW_NUMBER() OVER (
    ORDER BY score DESC, wins DESC, combined_time_ms ASC, first_result_at ASC, user_id
  )::integer AS rank,
  user_id,
  nick,
  score,
  wins,
  combined_time_ms,
  races_counted,
  weeks_played,
  first_result_at,
  latest_result_at
FROM rollup
ORDER BY rank;

-- The test leaderboard deliberately becomes empty at launch. Historical test
-- rows remain available to administrators in the base table for diagnostics,
-- but can never enter seasonal rankings or awards.
CREATE OR REPLACE VIEW public.office_grand_prix_test_standings
WITH (security_invoker = true)
AS
WITH user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.finish_place,
    s.completion_ms,
    s.submitted_at
  FROM public.office_grand_prix_scores s
  WHERE s.game_mode = 'test'
    AND public.office_grand_prix_mode(now()) = 'test'
    AND s.finished
  ORDER BY s.user_id, s.finish_place ASC, s.completion_ms ASC, s.submitted_at ASC
)
SELECT
  ROW_NUMBER() OVER (
    ORDER BY finish_place ASC, completion_ms ASC, submitted_at ASC, user_id
  )::integer AS rank,
  user_id,
  nick,
  finish_place,
  completion_ms,
  submitted_at
FROM user_best
ORDER BY rank;

-- Stable compatibility name used by the portal's shared leaderboard loader.
-- During the free test it exposes the disposable test standings; from launch
-- onward it becomes the official five-best-races weekly leaderboard.
CREATE OR REPLACE VIEW public.office_grand_prix_weekly_leaderboard
WITH (security_invoker = true)
AS
SELECT
  rank,
  user_id,
  nick,
  week_start,
  score,
  wins,
  combined_time_ms,
  races_counted,
  first_result_at,
  latest_result_at
FROM public.office_grand_prix_current_week
UNION ALL
SELECT
  rank,
  user_id,
  nick,
  public.office_grand_prix_week_start(now()) AS week_start,
  CASE finish_place
    WHEN 1 THEN 10 WHEN 2 THEN 8 WHEN 3 THEN 6 WHEN 4 THEN 5
    WHEN 5 THEN 4 WHEN 6 THEN 3 WHEN 7 THEN 2 ELSE 1
  END::integer AS score,
  CASE WHEN finish_place = 1 THEN 1 ELSE 0 END::integer AS wins,
  completion_ms AS combined_time_ms,
  1::integer AS races_counted,
  submitted_at AS first_result_at,
  submitted_at AS latest_result_at
FROM public.office_grand_prix_test_standings;

CREATE OR REPLACE VIEW public.office_grand_prix_recent_awards
WITH (security_invoker = true)
AS
SELECT
  id,
  week_start,
  user_id,
  nick_snapshot AS nick,
  rank,
  score,
  wins,
  combined_time_ms,
  races_counted,
  prize_coins,
  awarded_at
FROM public.office_grand_prix_weekly_awards
ORDER BY week_start DESC, rank ASC;

CREATE OR REPLACE FUNCTION public.award_office_grand_prix_week(
  p_week_start date DEFAULT public.office_grand_prix_week_start(now() - interval '7 days')
)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_current_week date := public.office_grand_prix_week_start(now());
  v_game text;
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  -- Serialize retries and cron overlap for the same week.
  PERFORM pg_advisory_xact_lock(hashtext(
    'office_grand_prix_award:' || p_week_start::text
  ));

  IF to_regprocedure('public.seasonal_game_for_week(date)') IS NOT NULL THEN
    EXECUTE 'SELECT public.seasonal_game_for_week($1)'
      INTO v_game
      USING p_week_start;
    IF v_game IS DISTINCT FROM 'office_grand_prix' THEN
      RAISE EXCEPTION 'not_in_season';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.office_grand_prix_weekly_awards
    WHERE week_start = p_week_start
  ) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT
        rank,
        nick_snapshot AS nick,
        score,
        wins,
        combined_time_ms,
        races_counted,
        prize_coins
      FROM public.office_grand_prix_weekly_awards
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

  WITH eligible AS (
    SELECT
      s.*,
      ROW_NUMBER() OVER (
        PARTITION BY s.user_id
        ORDER BY
          s.total_points DESC,
          s.finished DESC,
          s.completion_ms ASC NULLS LAST,
          s.submitted_at ASC,
          s.session_id
      ) AS race_number
    FROM public.office_grand_prix_scores s
    WHERE s.game_mode = 'seasonal'
      AND s.week_start = p_week_start
  ),
  counted AS (
    SELECT * FROM eligible WHERE race_number <= 5
  ),
  user_totals AS (
    SELECT
      user_id,
      (ARRAY_AGG(nick_snapshot ORDER BY submitted_at DESC))[1] AS nick_snapshot,
      SUM(total_points)::integer AS score,
      COUNT(*) FILTER (WHERE finish_place = 1)::integer AS wins,
      SUM(COALESCE(completion_ms, 90000))::integer AS combined_time_ms,
      COUNT(*)::integer AS races_counted,
      MIN(submitted_at) AS first_result_at
    FROM counted
    GROUP BY user_id
  ),
  ranked AS (
    SELECT
      *,
      ROW_NUMBER() OVER (
        ORDER BY
          score DESC,
          wins DESC,
          combined_time_ms ASC,
          first_result_at ASC,
          user_id
      )::integer AS rank
    FROM user_totals
  ),
  winners AS (
    SELECT
      user_id,
      nick_snapshot,
      rank,
      score,
      wins,
      combined_time_ms,
      races_counted,
      CASE rank WHEN 1 THEN 500 WHEN 2 THEN 250 WHEN 3 THEN 100 END AS prize_coins
    FROM ranked
    WHERE rank <= 3
  ),
  inserted AS (
    INSERT INTO public.office_grand_prix_weekly_awards (
      week_start,
      user_id,
      nick_snapshot,
      rank,
      score,
      wins,
      combined_time_ms,
      races_counted,
      prize_coins
    )
    SELECT
      p_week_start,
      user_id,
      nick_snapshot,
      rank,
      score,
      wins,
      combined_time_ms,
      races_counted,
      prize_coins
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
    SELECT
      rank,
      nick_snapshot AS nick,
      score,
      wins,
      combined_time_ms,
      races_counted,
      prize_coins
    FROM public.office_grand_prix_weekly_awards
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

REVOKE ALL ON FUNCTION public.office_grand_prix_week_start(timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_grand_prix_mode(timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_office_grand_prix_week(date)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.office_grand_prix_week_start(timestamptz)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_grand_prix_mode(timestamptz)
  TO authenticated;

REVOKE ALL
  ON public.office_grand_prix_current_week,
     public.office_grand_prix_weekly_leaderboard,
     public.office_grand_prix_all_time,
     public.office_grand_prix_test_standings,
     public.office_grand_prix_recent_awards
  FROM PUBLIC, anon, authenticated;

GRANT SELECT
  ON public.office_grand_prix_current_week,
     public.office_grand_prix_weekly_leaderboard,
     public.office_grand_prix_all_time,
     public.office_grand_prix_test_standings,
     public.office_grand_prix_recent_awards
  TO authenticated;

-- Private Realtime channels:
--   ogp:<session-id>                 Presence + coordinator snapshots
--   ogp-input:<session-id>:<slot>    slot owner -> coordinator input batches
--
-- The client must create these channels with config.private = true. Presence is
-- limited to slow-changing lobby state; 3 Hz race inputs use Broadcast.
-- RLS is managed and already enabled by Supabase on realtime.messages. Hosted
-- projects deliberately reject ALTER TABLE here, while allowing policy DDL.

DROP POLICY IF EXISTS "office_grand_prix_realtime_receive" ON realtime.messages;
CREATE POLICY "office_grand_prix_realtime_receive"
  ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.messages.extension IN ('broadcast', 'presence')
    AND (
      EXISTS (
        SELECT 1
        FROM public.office_grand_prix_participants p
        WHERE p.user_id = (SELECT auth.uid())
          AND (SELECT realtime.topic()) = 'ogp:' || p.session_id::text
      )
      OR
      EXISTS (
        SELECT 1
        FROM public.office_grand_prix_sessions s
        JOIN public.office_grand_prix_participants me
          ON me.session_id = s.id
         AND me.user_id = (SELECT auth.uid())
        JOIN public.office_grand_prix_participants owner
          ON owner.session_id = s.id
        WHERE
          (me.slot = owner.slot OR s.coordinator_id = (SELECT auth.uid()))
          AND (SELECT realtime.topic()) =
            'ogp-input:' || s.id::text || ':' || owner.slot::text
      )
    )
  );

DROP POLICY IF EXISTS "office_grand_prix_realtime_send" ON realtime.messages;
CREATE POLICY "office_grand_prix_realtime_send"
  ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      realtime.messages.extension = 'presence'
      AND EXISTS (
        SELECT 1
        FROM public.office_grand_prix_participants p
        WHERE p.user_id = (SELECT auth.uid())
          AND (SELECT realtime.topic()) = 'ogp:' || p.session_id::text
      )
    )
    OR
    (
      realtime.messages.extension = 'broadcast'
      AND EXISTS (
        SELECT 1
        FROM public.office_grand_prix_sessions s
        JOIN public.office_grand_prix_participants p
          ON p.session_id = s.id
         AND p.user_id = (SELECT auth.uid())
        WHERE s.coordinator_id = (SELECT auth.uid())
          AND (SELECT realtime.topic()) = 'ogp:' || s.id::text
      )
    )
    OR
    (
      realtime.messages.extension = 'broadcast'
      AND EXISTS (
        SELECT 1
        FROM public.office_grand_prix_participants p
        WHERE p.user_id = (SELECT auth.uid())
          AND NOT p.is_bot
          AND (SELECT realtime.topic()) =
            'ogp-input:' || p.session_id::text || ':' || p.slot::text
      )
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'office_grand_prix_scores'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE public.office_grand_prix_scores;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'office_grand_prix_weekly_awards'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE public.office_grand_prix_weekly_awards;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
