-- Loteria po Mundialu — activity-based raffle.
--
-- The prize pool = 100 × the Bank's net profit from settled Mundial bets (the
-- multiplier was 10 until 2026-07-31, when prizes were raised ten-fold; it is
-- ALSO copied into canvas-paint-log.sql and lottery-fixes.sql, which redefine
-- this function — move all three together or a re-run reverts the pool. (the
-- same `realizedProfit` shown in the Mundial tab). Tickets are earned across the
-- WHOLE portal (Mundial, prediction markets, casino, seasonal games, farm,
-- marketplace, canvas) plus ownership rewards (zen garden, plant decorations,
-- owned farm plots) and a "wszechstronność" (breadth) bonus for touching many
-- of the core activities — this promotes broad engagement, not grinding one game.
--
-- This file ships the read-only standings function used by the 🎟️ Loteria tab.
-- The actual draw runs at the end of July (separate job); until then this is a
-- live leaderboard of who holds how many tickets, with a full per-category split.
--
-- Idempotent (CREATE OR REPLACE). Clients call it via sb.rpc('mundial_lottery_standings').
--
-- ⚠️ This file's mundial_lottery_standings() copy is superseded TWICE — re-run
-- canvas-paint-log.sql then lottery-fixes.sql after re-running this file:
--   • canvas-paint-log.sql: the `canvas` CTE here reads only canvas_pixels'
--     current-owner column, which is last-write-wins and loses a player's days
--     once their pixels get painted over; the fix unions in canvas_paint_log.
--   • lottery-fixes.sql: the `market_p` CTE here counts CANCELLED listings
--     (cancel paths also set settled_at), and the `farm` CTE loses days when
--     crop lots are sold/rotted out of farm_inventory.

-- Per-source caps (keep in sync with LOTTERY_EARN / LOTTERY_OWNER in index.html):
--   Mundial (settled bets)          1 / bet          cap 15
--   Rynek (prediction-market bets)  1 / bet          cap 10
--   Kasyno (any house game)         1 / day played   cap 10
--   Sezonowe (weekly arcade)        1 / week scored  cap  8
--   Farma (farming activity)        1 / active day   cap  8
--   Targowisko (completed trades)   1 / trade        cap  6
--   Wspólne Płótno                  1 / day painted  cap  6
--   Bonus wszechstronności          +2 / of the 7 categories above with >=1 ticket (max +14)
--   Ogród Zen                       +2 for >=1 zen plant, +3 more for a 2nd    cap  5
--   Ozdoby (decorated plants)       +2 / plant that has an accessory           cap  4
--   Działki (owned farm plots)      +2 / owned non-migration farm tile         cap 12
--   Base                            +1 for every (non-admin) account
-- Admin accounts (is_admin = true) are excluded from the raffle entirely.

CREATE OR REPLACE FUNCTION public.mundial_lottery_standings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH mundial AS (
  SELECT user_id, LEAST(15, count(*)) t
  FROM football_bets WHERE status IN ('won','lost') GROUP BY user_id),
markets AS (
  SELECT user_id, LEAST(10, count(*)) t FROM trades GROUP BY user_id),
casino AS (
  SELECT user_id, LEAST(10, count(DISTINCT d)) t FROM (
    SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date d FROM plinko_spins
    UNION ALL SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date FROM mines_spins
    UNION ALL SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date FROM crash_spins
    UNION ALL SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date FROM wheel_spins
    UNION ALL SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date FROM roulette_spins
    UNION ALL SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date FROM slots_spins
  ) s GROUP BY user_id),
seasonal AS (
  SELECT user_id, LEAST(8, count(DISTINCT wk)) t FROM (
    SELECT user_id, week_start wk FROM whack_boss_scores
    UNION ALL SELECT user_id, week_start FROM bug_jumper_scores
    UNION ALL SELECT user_id, week_start FROM flappy_pants_scores
    UNION ALL SELECT user_id, week_start FROM snake_scores
    UNION ALL SELECT user_id, week_start FROM invoice_horde_scores
    UNION ALL SELECT user_id, week_start FROM var_patrol_scores
    UNION ALL SELECT user_id, week_start FROM egg_catch_scores
    UNION ALL SELECT user_id, week_start FROM super_mariusz_scores
  ) s GROUP BY user_id),
farm AS (
  SELECT user_id, LEAST(8, count(DISTINCT d)) t FROM (
    SELECT user_id, (sold_at AT TIME ZONE 'Europe/Warsaw')::date d FROM farm_seasonal_event_sales
    UNION ALL SELECT user_id, (harvested_at AT TIME ZONE 'Europe/Warsaw')::date FROM farm_inventory
  ) s GROUP BY user_id),
market_p AS (
  SELECT uid user_id, LEAST(6, count(*)) t FROM (
    SELECT seller_id uid FROM marketplace_listings WHERE settled_at IS NOT NULL
    UNION ALL SELECT buyer_id FROM marketplace_listings WHERE settled_at IS NOT NULL AND buyer_id IS NOT NULL
  ) s GROUP BY uid),
canvas AS (
  SELECT last_user_id user_id, LEAST(6, count(DISTINCT (updated_at AT TIME ZONE 'Europe/Warsaw')::date)) t
  FROM canvas_pixels WHERE last_user_id IS NOT NULL GROUP BY last_user_id),
garden AS (
  SELECT user_id,
    LEAST(5, (CASE WHEN count(*) >= 1 THEN 2 ELSE 0 END) + (CASE WHEN count(*) >= 2 THEN 3 ELSE 0 END)) t_ogrod,
    LEAST(4, count(*) FILTER (WHERE COALESCE(equipped, '{}'::jsonb) <> '{}'::jsonb) * 2) t_ozdoby
  FROM gardens GROUP BY user_id),
tiles AS (
  SELECT owner_id user_id,
    LEAST(12, count(*) FILTER (WHERE acquired_via IS DISTINCT FROM 'migration') * 2) t_dzialki
  FROM farm_tiles WHERE owner_id IS NOT NULL GROUP BY owner_id),
per_user AS (
  SELECT p.id, p.nick,
    COALESCE(mundial.t,0) mundial, COALESCE(markets.t,0) rynek, COALESCE(casino.t,0) kasyno,
    COALESCE(seasonal.t,0) sezonowe, COALESCE(farm.t,0) farma, COALESCE(market_p.t,0) targ,
    COALESCE(canvas.t,0) plotno,
    COALESCE(garden.t_ogrod,0) ogrod, COALESCE(garden.t_ozdoby,0) ozdoby, COALESCE(tiles.t_dzialki,0) dzialki
  FROM profiles p
  LEFT JOIN mundial  ON mundial.user_id  = p.id
  LEFT JOIN markets  ON markets.user_id  = p.id
  LEFT JOIN casino   ON casino.user_id   = p.id
  LEFT JOIN seasonal ON seasonal.user_id = p.id
  LEFT JOIN farm     ON farm.user_id     = p.id
  LEFT JOIN market_p ON market_p.user_id = p.id
  LEFT JOIN canvas   ON canvas.user_id   = p.id
  LEFT JOIN garden   ON garden.user_id   = p.id
  LEFT JOIN tiles    ON tiles.user_id    = p.id
  WHERE p.is_admin IS NOT TRUE),
final AS (
  SELECT id, nick, mundial, rynek, kasyno, sezonowe, farma, targ, plotno, ogrod, ozdoby, dzialki,
    ( (mundial>0)::int + (rynek>0)::int + (kasyno>0)::int + (sezonowe>0)::int
      + (farma>0)::int + (targ>0)::int + (plotno>0)::int ) * 2 AS breadth,
    1 + mundial + rynek + kasyno + sezonowe + farma + targ + plotno + ogrod + ozdoby + dzialki
      + ( (mundial>0)::int + (rynek>0)::int + (kasyno>0)::int + (sezonowe>0)::int
          + (farma>0)::int + (targ>0)::int + (plotno>0)::int ) * 2 AS tickets
  FROM per_user),
bank AS (
  SELECT COALESCE(SUM(CASE WHEN status='won'  THEN stake - potential_payout
                           WHEN status='lost' THEN stake
                           ELSE 0 END), 0)::bigint net
  FROM football_bets)
SELECT jsonb_build_object(
  'bank_net',      (SELECT net FROM bank),
  'multiplier',    100,
  'prize_pool',    GREATEST(0, (SELECT net FROM bank)) * 100,
  'cutoff',        '2026-07-31T23:59:59+02:00',
  'draw_at',       '2026-08-01T12:00:00+02:00',
  'total_tickets', (SELECT COALESCE(SUM(tickets),0)::bigint FROM final),
  'player_count',  (SELECT count(*) FROM final),
  'players', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id, 'nick', nick,
      'mundial', mundial, 'rynek', rynek, 'kasyno', kasyno, 'sezonowe', sezonowe,
      'farma', farma, 'targ', targ, 'plotno', plotno,
      'ogrod', ogrod, 'ozdoby', ozdoby, 'dzialki', dzialki, 'breadth', breadth,
      'tickets', tickets) ORDER BY tickets DESC, nick), '[]'::jsonb)
    FROM final)
);
$$;

REVOKE ALL ON FUNCTION public.mundial_lottery_standings() FROM public;
GRANT EXECUTE ON FUNCTION public.mundial_lottery_standings() TO anon, authenticated;
