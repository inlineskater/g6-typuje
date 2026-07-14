-- Gross coin inflow statistics for the Statistics page.
-- Counts positive coin movements after registration; the initial 1000 coins
-- are intentionally excluded.
--
-- Idempotent: safe to re-run after the economy/game/shop SQL files.

CREATE OR REPLACE FUNCTION public.coin_inflow_stats()
RETURNS TABLE (
  user_id uuid,
  nick text,
  total_inflow bigint,
  garden bigint,
  markets bigint,
  football bigint,
  hazard bigint,
  seasonal_games bigint,
  marketplace bigint,
  passive bigint,
  topups bigint,
  returns_cashouts bigint,
  other bigint,
  inflow_count bigint,
  last_inflow_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  coin_tx AS (
    SELECT
      ct.user_id,
      COALESCE(SUM(ct.delta) FILTER (WHERE ct.reason = 'garden_water'), 0)::bigint AS garden,
      COALESCE(SUM(ct.delta) FILTER (WHERE ct.reason = 'marketplace_sale'), 0)::bigint AS marketplace,
      COALESCE(SUM(ct.delta) FILTER (WHERE ct.reason = 'daily_interest'), 0)::bigint AS passive,
      COALESCE(SUM(ct.delta) FILTER (WHERE ct.reason IN ('zapps_topup','admin_grant')), 0)::bigint AS topups,
      COALESCE(SUM(ct.delta) FILTER (
        WHERE ct.reason IN (
          'marketplace_outbid_refund',
          'hero_auction_outbid_refund',
          'hero_auction_edition_refund'
        )
      ), 0)::bigint AS returns_cashouts,
      COALESCE(SUM(ct.delta) FILTER (
        WHERE ct.reason NOT IN (
          'garden_water',
          'marketplace_sale',
          'daily_interest',
          'zapps_topup',
          'admin_grant',
          'marketplace_outbid_refund',
          'hero_auction_outbid_refund',
          'hero_auction_edition_refund'
        )
      ), 0)::bigint AS other,
      COUNT(*)::bigint AS inflow_count,
      MAX(ct.created_at) AS last_inflow_at
    FROM public.coin_transactions ct
    WHERE ct.delta > 0
    GROUP BY ct.user_id
  ),
  market_totals AS (
    SELECT
      m.id AS market_id,
      m.resolution,
      COALESCE(m.resolved_at, m.created_at) AS event_at,
      COALESCE(SUM(t.amount), 0)::bigint AS total_pot,
      COALESCE(SUM(t.amount) FILTER (WHERE t.side <> m.resolution), 0)::bigint AS losing_pot,
      COALESCE(SUM(t.shares) FILTER (WHERE t.side = m.resolution), 0::numeric) AS total_winning_shares
    FROM public.markets m
    JOIN public.trades t ON t.market_id = m.id
    WHERE m.resolved = true
      AND m.resolution IN ('YES','NO')
    GROUP BY m.id, m.resolution, COALESCE(m.resolved_at, m.created_at)
  ),
  market_raw_payouts AS (
    SELECT
      mt.market_id,
      t.user_id,
      mt.event_at,
      mt.total_pot,
      SUM(t.amount)::numeric
        + mt.losing_pot::numeric * SUM(t.shares)::numeric / mt.total_winning_shares AS exact_payout
    FROM market_totals mt
    JOIN public.trades t
      ON t.market_id = mt.market_id
     AND t.side = mt.resolution
    WHERE mt.total_pot > 0
      AND mt.total_winning_shares > 0
    GROUP BY mt.market_id, t.user_id, mt.event_at, mt.total_pot, mt.losing_pot, mt.total_winning_shares
  ),
  market_ranked_payouts AS (
    SELECT
      market_id,
      user_id,
      event_at,
      FLOOR(exact_payout)::bigint AS base_payout,
      ROW_NUMBER() OVER (
        PARTITION BY market_id
        ORDER BY exact_payout - FLOOR(exact_payout) DESC, user_id
      ) AS fractional_rank,
      (
        total_pot - SUM(FLOOR(exact_payout)::bigint) OVER (PARTITION BY market_id)
      )::bigint AS remainder_coins
    FROM market_raw_payouts
  ),
  market_payouts AS (
    SELECT
      user_id,
      SUM(base_payout + CASE WHEN fractional_rank <= GREATEST(remainder_coins, 0) THEN 1 ELSE 0 END)::bigint AS markets,
      COUNT(*)::bigint AS inflow_count,
      MAX(event_at) AS last_inflow_at
    FROM market_ranked_payouts
    GROUP BY user_id
  ),
  football_inflows AS (
    SELECT
      user_id,
      COALESCE(SUM(potential_payout) FILTER (WHERE status = 'won'), 0)::bigint AS football,
      COALESCE(SUM(stake) FILTER (WHERE status = 'void'), 0)::bigint AS returns_cashouts,
      COUNT(*) FILTER (WHERE status IN ('won','void'))::bigint AS inflow_count,
      MAX(COALESCE(settled_at, created_at)) FILTER (WHERE status IN ('won','void')) AS last_inflow_at
    FROM public.football_bets
    WHERE status IN ('won','void')
    GROUP BY user_id
  ),
  hazard_inflows AS (
    SELECT
      user_id,
      SUM(amount)::bigint AS hazard,
      COUNT(*)::bigint AS inflow_count,
      MAX(created_at) AS last_inflow_at
    FROM (
      SELECT user_id, total_won AS amount, created_at
      FROM public.roulette_spins
      WHERE total_won > 0
      UNION ALL
      SELECT user_id, total_won AS amount, created_at
      FROM public.slots_spins
      WHERE total_won > 0
      UNION ALL
      SELECT user_id, total_won AS amount, created_at
      FROM public.plinko_spins
      WHERE total_won > 0
      UNION ALL
      SELECT user_id, total_won AS amount, created_at
      FROM public.mines_spins
      WHERE total_won > 0
      UNION ALL
      SELECT user_id, total_won AS amount, created_at
      FROM public.crash_spins
      WHERE total_won > 0
      UNION ALL
      SELECT user_id, total_won AS amount, created_at
      FROM public.wheel_spins
      WHERE total_won > 0
      UNION ALL
      SELECT user_id, total_won AS amount, created_at
      FROM public.coin_pusher_spins
      WHERE total_won > 0 AND ends_at <= now()
    ) h
    GROUP BY user_id
  ),
  poker_cashouts AS (
    SELECT
      user_id,
      SUM(amount)::bigint AS returns_cashouts,
      COUNT(*)::bigint AS inflow_count,
      MAX(created_at) AS last_inflow_at
    FROM public.poker_ledger
    WHERE type = 'cashout'
    GROUP BY user_id
  ),
  seasonal_awards AS (
    SELECT user_id, prize_coins, awarded_at FROM public.whack_boss_weekly_awards
    UNION ALL
    SELECT user_id, prize_coins, awarded_at FROM public.bug_jumper_weekly_awards
    UNION ALL
    SELECT user_id, prize_coins, awarded_at FROM public.flappy_pants_weekly_awards
    UNION ALL
    SELECT user_id, prize_coins, awarded_at FROM public.snake_weekly_awards
    UNION ALL
    SELECT user_id, prize_coins, awarded_at FROM public.invoice_horde_weekly_awards
    UNION ALL
    SELECT user_id, prize_coins, awarded_at FROM public.var_patrol_weekly_awards
    UNION ALL
    SELECT user_id, prize_coins, awarded_at FROM public.egg_catch_weekly_awards
  ),
  seasonal_inflows AS (
    SELECT
      user_id,
      SUM(prize_coins)::bigint AS seasonal_games,
      COUNT(*)::bigint AS inflow_count,
      MAX(awarded_at) AS last_inflow_at
    FROM seasonal_awards
    GROUP BY user_id
  )
  SELECT
    p.id AS user_id,
    p.nick,
    (
      COALESCE(ct.garden, 0)
      + COALESCE(mp.markets, 0)
      + COALESCE(fb.football, 0)
      + COALESCE(hz.hazard, 0)
      + COALESCE(sa.seasonal_games, 0)
      + COALESCE(ct.marketplace, 0)
      + COALESCE(ct.passive, 0)
      + COALESCE(ct.topups, 0)
      + COALESCE(ct.returns_cashouts, 0)
      + COALESCE(fb.returns_cashouts, 0)
      + COALESCE(pk.returns_cashouts, 0)
      + COALESCE(ct.other, 0)
    )::bigint AS total_inflow,
    COALESCE(ct.garden, 0)::bigint AS garden,
    COALESCE(mp.markets, 0)::bigint AS markets,
    COALESCE(fb.football, 0)::bigint AS football,
    COALESCE(hz.hazard, 0)::bigint AS hazard,
    COALESCE(sa.seasonal_games, 0)::bigint AS seasonal_games,
    COALESCE(ct.marketplace, 0)::bigint AS marketplace,
    COALESCE(ct.passive, 0)::bigint AS passive,
    COALESCE(ct.topups, 0)::bigint AS topups,
    (
      COALESCE(ct.returns_cashouts, 0)
      + COALESCE(fb.returns_cashouts, 0)
      + COALESCE(pk.returns_cashouts, 0)
    )::bigint AS returns_cashouts,
    COALESCE(ct.other, 0)::bigint AS other,
    (
      COALESCE(ct.inflow_count, 0)
      + COALESCE(mp.inflow_count, 0)
      + COALESCE(fb.inflow_count, 0)
      + COALESCE(hz.inflow_count, 0)
      + COALESCE(pk.inflow_count, 0)
      + COALESCE(sa.inflow_count, 0)
    )::bigint AS inflow_count,
    GREATEST(
      ct.last_inflow_at,
      mp.last_inflow_at,
      fb.last_inflow_at,
      hz.last_inflow_at,
      pk.last_inflow_at,
      sa.last_inflow_at
    ) AS last_inflow_at
  FROM public.profiles p
  LEFT JOIN coin_tx ct ON ct.user_id = p.id
  LEFT JOIN market_payouts mp ON mp.user_id = p.id
  LEFT JOIN football_inflows fb ON fb.user_id = p.id
  LEFT JOIN hazard_inflows hz ON hz.user_id = p.id
  LEFT JOIN poker_cashouts pk ON pk.user_id = p.id
  LEFT JOIN seasonal_inflows sa ON sa.user_id = p.id
  WHERE NOT p.is_admin
  ORDER BY total_inflow DESC, p.nick;
$$;

REVOKE ALL ON FUNCTION public.coin_inflow_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coin_inflow_stats() TO authenticated;

NOTIFY pgrst, 'reload schema';
