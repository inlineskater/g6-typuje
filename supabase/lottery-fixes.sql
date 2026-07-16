-- Loteria po Mundialu — calculation fixes (2026-07-16 audit).
-- Run after lottery.sql + canvas-paint-log.sql. Idempotent (CREATE OR REPLACE).
--
-- Supersedes the mundial_lottery_standings() copies in lottery.sql and
-- canvas-paint-log.sql (both carry ⚠️ notes). Two CTE fixes, found by auditing
-- every category against the underlying data lifecycle:
--
-- 1. Targowisko OVERCOUNT: every cancel path (cancel_marketplace_listing,
--    no-bid settle, unpaid-tax void in nft-merge-fixes.sql) sets
--    settled_at = now() with status='cancelled', so filtering on
--    `settled_at IS NOT NULL` handed sellers a ticket per CANCELLED listing.
--    Now filters status = 'settled' (real completed trades only).
--
-- 2. Farma UNDERCOUNT (same lost-history class as the canvas bug):
--    farm_inventory lots are DELETEd when fully sold (sell_crop_to_npc) and
--    purged when rotten (farm_rot_cleanup, 5 days), so "days harvested" quietly
--    vanished — two active farmers showed 0/8. The coin_transactions ledger is
--    immutable, so `reason = 'farm_crop_sale'` days are unioned in as durable
--    evidence of farming activity (a sale happens within 5 days of its harvest,
--    matching the "Zbieraj plony (dzień)" label; tile/box purchases stay
--    excluded — buying isn't farming).
--
-- Everything else was verified correct: mundial/rynek/kasyno/sezonowe counts,
-- ogrod/ozdoby/dzialki ownership math (ozdoby checks `equipped` jsonb — a
-- decorated plant — NOT the owned-accessories array), breadth ×2 over the 7
-- activity categories, the +1 welcome ticket, and bank_net parity with
-- computeFootballHouseStats().realizedProfit in index.html.

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
    UNION ALL SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date
      FROM coin_transactions WHERE reason = 'farm_crop_sale'
  ) s GROUP BY user_id),
market_p AS (
  SELECT uid user_id, LEAST(6, count(*)) t FROM (
    SELECT seller_id uid FROM marketplace_listings WHERE status = 'settled'
    UNION ALL SELECT buyer_id FROM marketplace_listings WHERE status = 'settled' AND buyer_id IS NOT NULL
  ) s GROUP BY uid),
canvas AS (
  SELECT user_id, LEAST(6, count(DISTINCT d)) t FROM (
    SELECT last_user_id user_id, (updated_at AT TIME ZONE 'Europe/Warsaw')::date d
    FROM canvas_pixels WHERE last_user_id IS NOT NULL
    UNION
    SELECT user_id, (painted_at AT TIME ZONE 'Europe/Warsaw')::date d
    FROM canvas_paint_log
  ) s GROUP BY user_id),
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
  'multiplier',    10,
  'prize_pool',    GREATEST(0, (SELECT net FROM bank)) * 10,
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

NOTIFY pgrst, 'reload schema';
