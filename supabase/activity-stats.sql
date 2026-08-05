-- Per-player activity statistics for the „📅 Aktywność" card on the Statystyki tab.
--
-- Answers: when was someone last seen, how many days have they actually played,
-- what is their current daily streak, and WHAT do they play (event counts per
-- area of the portal).
--
-- Why this is server-side rather than a frontend aggregate: most of the event
-- sources are own-row RLS (every casino spin table, every seasonal *_scores
-- table, canvas_paint_log has no client grants at all), so a browser literally
-- cannot see another player's plays. SECURITY DEFINER is what makes a
-- cross-player activity table possible.
--
-- All day bucketing is Europe/Warsaw, matching every other date-sensitive
-- feature in the app (weekly awards, garden watering, farm price rolls).
--
-- Idempotent: safe to re-run. Run after the game/farm/canvas SQL files.

CREATE OR REPLACE FUNCTION public.player_activity_stats()
RETURNS TABLE (
  user_id        uuid,
  nick           text,
  last_active_at timestamptz,
  first_active_at timestamptz,
  active_days    bigint,
  streak_days    bigint,
  best_streak    bigint,
  events_30d     bigint,
  total_events   bigint,
  casino         bigint,
  games          bigint,
  farm           bigint,
  markets        bigint,
  football       bigint,
  marketplace    bigint,
  canvas         bigint,
  top_kind       text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH events AS (
    -- ── 🎰 Kasyno (house games + poker) ──────────────────────────────────
    SELECT user_id, 'casino'::text AS kind, created_at FROM public.roulette_spins
    UNION ALL SELECT user_id, 'casino', created_at FROM public.slots_spins
    UNION ALL SELECT user_id, 'casino', created_at FROM public.plinko_spins
    UNION ALL SELECT user_id, 'casino', created_at FROM public.mines_spins
    UNION ALL SELECT user_id, 'casino', created_at FROM public.crash_spins
    UNION ALL SELECT user_id, 'casino', created_at FROM public.wheel_spins
    UNION ALL SELECT user_id, 'casino', created_at FROM public.poker_ledger

    -- ── 🎮 Gry (seasonal rounds + the free arcade) ───────────────────────
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.whack_boss_scores
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.bug_jumper_scores
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.flappy_pants_scores
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.snake_scores
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.invoice_horde_scores
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.var_patrol_scores
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.egg_catch_scores
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.super_mariusz_scores
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.popup_panic_scores
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.tetris_scores
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.healer_dungeon_scores
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.filler_scores
    UNION ALL SELECT user_id, 'games', submitted_at FROM public.bubble_breaker_scores
    UNION ALL SELECT user_id, 'games', created_at   FROM public.arcade_scores

    -- ── 📊 Rynki predykcyjne / ⚽ Mundial ────────────────────────────────
    UNION ALL SELECT user_id, 'markets',  created_at FROM public.trades
    UNION ALL SELECT user_id, 'football', created_at FROM public.football_bets

    -- ── 🎨 Wspólne Płótno ────────────────────────────────────────────────
    -- canvas_paint_log, not canvas_pixels: the pixel table is last-write-wins,
    -- so painting over someone erases the evidence that they ever painted.
    UNION ALL SELECT user_id, 'canvas', painted_at FROM public.canvas_paint_log

    -- ── 🌱 Ogródek + Farma, 🛍️ Targowisko ───────────────────────────────
    -- These leave no dedicated event table, so the coin ledger is the record.
    UNION ALL
    SELECT ct.user_id,
           CASE WHEN ct.reason LIKE 'marketplace%' THEN 'marketplace' ELSE 'farm' END,
           ct.created_at
    FROM public.coin_transactions ct
    WHERE ct.reason LIKE 'farm%'
       OR ct.reason LIKE 'garden%'
       OR ct.reason LIKE 'marketplace%'
       OR ct.reason IN ('card_levelup', 'lootbox_open', 'harvest_crop')
  ),
  ev AS (
    SELECT e.user_id, e.kind, e.created_at,
           (e.created_at AT TIME ZONE 'Europe/Warsaw')::date AS day
    FROM events e
    WHERE e.user_id IS NOT NULL AND e.created_at IS NOT NULL
  ),
  totals AS (
    SELECT
      user_id,
      MAX(created_at) AS last_active_at,
      MIN(created_at) AS first_active_at,
      COUNT(*)::bigint AS total_events,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::bigint AS events_30d,
      COUNT(*) FILTER (WHERE kind = 'casino')::bigint      AS casino,
      COUNT(*) FILTER (WHERE kind = 'games')::bigint       AS games,
      COUNT(*) FILTER (WHERE kind = 'farm')::bigint        AS farm,
      COUNT(*) FILTER (WHERE kind = 'markets')::bigint     AS markets,
      COUNT(*) FILTER (WHERE kind = 'football')::bigint    AS football,
      COUNT(*) FILTER (WHERE kind = 'marketplace')::bigint AS marketplace,
      COUNT(*) FILTER (WHERE kind = 'canvas')::bigint      AS canvas
    FROM ev
    GROUP BY user_id
  ),
  days AS (
    SELECT DISTINCT user_id, day FROM ev
  ),
  -- Classic gaps-and-islands: consecutive days share (day - row_number).
  islands AS (
    SELECT user_id, day,
           day - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY day))::integer AS grp
    FROM days
  ),
  runs AS (
    SELECT user_id, COUNT(*)::bigint AS len, MAX(day) AS last_day
    FROM islands
    GROUP BY user_id, grp
  ),
  streaks AS (
    SELECT
      user_id,
      COUNT(*)::bigint AS active_days_calc,
      MAX(len) AS best_streak,
      -- A run only counts as the CURRENT streak if it reaches today or
      -- yesterday; anything older is a streak the player already broke.
      COALESCE(MAX(len) FILTER (
        WHERE last_day >= ((now() AT TIME ZONE 'Europe/Warsaw')::date - 1)
      ), 0) AS streak_days
    FROM runs
    GROUP BY user_id
  ),
  day_counts AS (
    SELECT user_id, COUNT(*)::bigint AS active_days FROM days GROUP BY user_id
  ),
  top AS (
    SELECT DISTINCT ON (user_id) user_id, kind
    FROM (SELECT user_id, kind, COUNT(*) AS n FROM ev GROUP BY user_id, kind) k
    ORDER BY user_id, n DESC, kind
  )
  SELECT
    p.id AS user_id,
    p.nick,
    t.last_active_at,
    t.first_active_at,
    COALESCE(dc.active_days, 0)  AS active_days,
    COALESCE(s.streak_days, 0)   AS streak_days,
    COALESCE(s.best_streak, 0)   AS best_streak,
    COALESCE(t.events_30d, 0)    AS events_30d,
    COALESCE(t.total_events, 0)  AS total_events,
    COALESCE(t.casino, 0)        AS casino,
    COALESCE(t.games, 0)         AS games,
    COALESCE(t.farm, 0)          AS farm,
    COALESCE(t.markets, 0)       AS markets,
    COALESCE(t.football, 0)      AS football,
    COALESCE(t.marketplace, 0)   AS marketplace,
    COALESCE(t.canvas, 0)        AS canvas,
    top.kind                     AS top_kind
  FROM public.profiles p
  JOIN totals t     ON t.user_id = p.id
  LEFT JOIN streaks s   ON s.user_id = p.id
  LEFT JOIN day_counts dc ON dc.user_id = p.id
  LEFT JOIN top     ON top.user_id = p.id
  WHERE COALESCE(p.is_admin, false) = false
  ORDER BY t.last_active_at DESC NULLS LAST;
$$;

-- `anon` must be named explicitly: Supabase's ALTER DEFAULT PRIVILEGES grants it
-- EXECUTE on new public functions directly, so revoking from PUBLIC alone leaves
-- the panel readable without logging in. Same two lines as coin-inflow-stats.sql.
REVOKE ALL ON FUNCTION public.player_activity_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.player_activity_stats() TO authenticated;
