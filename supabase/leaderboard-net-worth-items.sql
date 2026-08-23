-- Net Worth: include owned assets (hero items + certificates + garden accessories)
-- plus restore the poker stack that football.sql's view redefinition dropped.
--
-- Net Worth = coins
--           + open prediction-market position value (unresolved trades)
--           + open Mundial (football) stakes
--           + live poker stack
--           + owned hero items & certificates (shop price, or auction winning bid)
--           + garden accessories (price paid, from the coin ledger)
--           + Bank G6 holdings (open deposits at mark, bonds at face+accrued,
--             casino shares at cost) — see supabase/bank.sql
--           − outstanding farm land-tax debt (kataster liability)
--
-- ⚠️ Requires supabase/bank.sql to have been run first: bank_user_assets() is
-- defined there. Re-run THIS file after re-running bank.sql is not needed (the
-- helper is stable), but running this file on a database without bank.sql will
-- fail at CREATE time.
--
-- hero_item_instances is RLS-restricted to its owner, so the leaderboard
-- (security_invoker) view cannot aggregate other players' items directly.
-- A SECURITY DEFINER helper returns only the per-user asset TOTAL (a number),
-- so no row-level ownership data leaks. Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.user_assets_value(p_uid uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Owned hero items & certificates: auction-won items at their winning bid,
  -- shop items at the def price.
  SELECT COALESCE((
           SELECT sum(COALESCE(
                    (SELECT a.winning_bid
                       FROM public.hero_item_auctions a
                      WHERE a.item_instance_id = i.id
                        AND a.status = 'settled'
                      LIMIT 1),
                    d.price,
                    0))
             FROM public.hero_item_instances i
             JOIN public.hero_item_defs d ON d.id = i.item_def_id
            WHERE i.owner_id = p_uid
         ), 0)
       -- Garden accessories: what was paid for them (cosmetic, never sold/refunded).
       + COALESCE((
           SELECT sum(-ct.delta)
             FROM public.coin_transactions ct
            WHERE ct.user_id = p_uid
              AND ct.reason = 'garden_accessory'
         ), 0)
       -- Farm: currently owned land value + card-level investment + crop inventory at market price
       -- + plant cards held (by rarity) + serialized NFT cards (scarcity value).
       + COALESCE((
           SELECT sum(ft.asset_value)
             FROM public.farm_tiles ft
            WHERE ft.owner_id = p_uid
         ), 0)
       + COALESCE((
           SELECT sum(-ct.delta)
             FROM public.coin_transactions ct
            WHERE ct.user_id = p_uid
              AND ct.reason = 'card_levelup'
         ), 0)
       + COALESCE((
           SELECT sum(fi.qty * fm.cur_price)
             FROM public.farm_inventory fi
             JOIN public.farm_market fm ON fm.crop_type = fi.crop_type
            WHERE fi.user_id = p_uid AND fi.expires_at > now()   -- exclude rotted crop lots
         ), 0)
       + COALESCE((
           SELECT sum(fc.count * (CASE d.rarity WHEN 'epic' THEN 150 WHEN 'rare' THEN 50 ELSE 20 END))
             FROM public.farm_collection fc
             JOIN public.farm_card_defs d ON d.species = fc.species
            WHERE fc.user_id = p_uid AND d.edition_size IS NULL
         ), 0)
       -- ⚠️ COALESCE on stat_value: bred hybrids carry a per-level value floor
       -- (farm-hybrid-income-parity.sql patches this in place; keep it inline here
       -- so re-running this file can't revert it — that is how economy_stats broke).
       + COALESCE((
           SELECT sum(COALESCE(round(ni.stat_value * ni.level), round(20000.0 / ni.edition_size * ni.level)))
             FROM public.farm_nft_instances ni
            WHERE ni.owner_id = p_uid
         ), 0)
       -- sealed (unopened) seed boxes (100 each) + gold boxes (500 each)
       -- + free-tile vouchers (350 each)
       + COALESCE((
           SELECT fus.boxes * 100 + fus.boxes_gold * 500 + fus.tile_vouchers * 350
             FROM public.farm_user_state fus
            WHERE fus.user_id = p_uid
         ), 0)
       -- Bank G6: open Lokata/Skarbonka principal marked to now, bonds at
       -- face + accrued-unpaid coupons, casino shares at what was paid.
       + COALESCE(public.bank_user_assets(p_uid), 0)
       -- minus outstanding farm land-tax debt (kataster): a hard liability —
       -- autopaid from every crop/marketplace payout, accrues 10%/day interest,
       -- and blocks buying/planting until cleared. Subtracting it HERE nets it
       -- out of both the leaderboard view and economy_stats() holdings/richest,
       -- which both call this function.
       - COALESCE((
           SELECT fus.land_tax_debt
             FROM public.farm_user_state fus
            WHERE fus.user_id = p_uid
         ), 0);
$$;

REVOKE ALL ON FUNCTION public.user_assets_value(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_assets_value(uuid) TO anon, authenticated;

CREATE OR REPLACE VIEW public.leaderboard WITH (security_invoker = true) AS
SELECT p.id,
       p.nick,
       p.coins,
       p.coins::numeric
         + COALESCE((
             SELECT sum(
               CASE WHEN t.side = 'YES'
                    THEN t.shares * (m.no_shares  / (m.yes_shares + m.no_shares))
                    ELSE t.shares * (m.yes_shares / (m.yes_shares + m.no_shares))
               END)
             FROM public.trades t
             JOIN public.markets m ON m.id = t.market_id
             WHERE t.user_id = p.id AND m.resolved = false
           ), 0::numeric)
         + COALESCE((
             SELECT sum(b.stake)
             FROM public.football_bets b
             WHERE b.user_id = p.id AND b.status = 'open'
           ), 0::bigint)::numeric
         + COALESCE((
             SELECT sum(ps.stack)
             FROM public.poker_seats ps
             WHERE ps.user_id = p.id
           ), 0::bigint)::numeric
         + public.user_assets_value(p.id) AS net_worth,
       p.is_admin
FROM public.profiles p;

-- ── Per-user Net Worth breakdown (for the player profile modal) ──────────────
-- Returns each component that sums into net_worth, plus the itemized hero-item
-- list. SECURITY DEFINER so it works for ANY user despite hero_item_instances
-- being owner-only RLS — it only returns aggregate values + item names/values.
CREATE OR REPLACE FUNCTION public.user_net_worth_breakdown(p_uid uuid)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH parts AS (
    SELECT
      COALESCE((SELECT coins FROM public.profiles WHERE id = p_uid), 0) AS cash,
      COALESCE((
        SELECT sum(CASE WHEN t.side = 'YES'
                        THEN t.shares * (m.no_shares  / (m.yes_shares + m.no_shares))
                        ELSE t.shares * (m.yes_shares / (m.yes_shares + m.no_shares))
                   END)
          FROM public.trades t
          JOIN public.markets m ON m.id = t.market_id
         WHERE t.user_id = p_uid AND m.resolved = false), 0) AS market_positions,
      COALESCE((SELECT sum(b.stake) FROM public.football_bets b
                 WHERE b.user_id = p_uid AND b.status = 'open'), 0) AS football_open,
      COALESCE((SELECT sum(ps.stack) FROM public.poker_seats ps
                 WHERE ps.user_id = p_uid), 0) AS poker_stack,
      COALESCE((
        SELECT sum(COALESCE(
                 (SELECT a.winning_bid FROM public.hero_item_auctions a
                   WHERE a.item_instance_id = i.id AND a.status = 'settled' LIMIT 1),
                 d.price, 0))
          FROM public.hero_item_instances i
          JOIN public.hero_item_defs d ON d.id = i.item_def_id
         WHERE i.owner_id = p_uid), 0) AS hero_items,
      COALESCE((SELECT sum(-ct.delta) FROM public.coin_transactions ct
                 WHERE ct.user_id = p_uid AND ct.reason = 'garden_accessory'), 0) AS accessories,
      -- ── Ogródek (Farma), split into sub-components ──
      COALESCE((SELECT sum(ft.asset_value) FROM public.farm_tiles ft
                 WHERE ft.owner_id = p_uid), 0) AS farm_land,
      COALESCE((SELECT sum(-ct.delta) FROM public.coin_transactions ct
                 WHERE ct.user_id = p_uid AND ct.reason = 'card_levelup'), 0)
      + COALESCE((SELECT sum(fc.count * (CASE d.rarity WHEN 'epic' THEN 150 WHEN 'rare' THEN 50 ELSE 20 END))
                    FROM public.farm_collection fc
                    JOIN public.farm_card_defs d ON d.species = fc.species
                   WHERE fc.user_id = p_uid AND d.edition_size IS NULL), 0) AS farm_cards,
      -- ⚠️ stat_value floor for bred hybrids — see the note above.
      COALESCE((SELECT sum(COALESCE(round(ni.stat_value * ni.level), round(20000.0 / ni.edition_size * ni.level)))
                  FROM public.farm_nft_instances ni
                 WHERE ni.owner_id = p_uid), 0) AS farm_nft,
      COALESCE((SELECT sum(fi.qty * fm.cur_price)
                  FROM public.farm_inventory fi
                  JOIN public.farm_market fm ON fm.crop_type = fi.crop_type
                 WHERE fi.user_id = p_uid AND fi.expires_at > now()), 0) AS farm_crops,
      COALESCE((SELECT fus.boxes * 100 + fus.boxes_gold * 500 + fus.tile_vouchers * 350
                  FROM public.farm_user_state fus
                 WHERE fus.user_id = p_uid), 0) AS farm_boxes,
      COALESCE(public.bank_user_assets(p_uid), 0) AS bank,
      -- liability: outstanding land-tax debt (kataster), reported positive here,
      -- subtracted from 'total' below (must mirror user_assets_value)
      COALESCE((SELECT fus.land_tax_debt
                  FROM public.farm_user_state fus
                 WHERE fus.user_id = p_uid), 0) AS farm_tax_debt
  )
  SELECT json_build_object(
    'cash',             round(cash)::int,
    'market_positions', round(market_positions)::int,
    'football_open',    round(football_open)::int,
    'poker_stack',      round(poker_stack)::int,
    'hero_items',       round(hero_items)::int,
    'accessories',      round(accessories)::int,
    'bank',             round(bank)::int,
    'farm',             round(farm_land + farm_cards + farm_nft + farm_crops + farm_boxes)::int,
    'farm_parts',       json_build_object(
                          'land',   round(farm_land)::int,
                          'cards',  round(farm_cards)::int,
                          'nft',    round(farm_nft)::int,
                          'crops',  round(farm_crops)::int,
                          'boxes',  round(farm_boxes)::int),
    'farm_tax_debt',    round(farm_tax_debt)::int,
    'total',            round(cash + market_positions + football_open + poker_stack + hero_items + accessories
                              + bank
                              + farm_land + farm_cards + farm_nft + farm_crops + farm_boxes
                              - farm_tax_debt)::int,
    'items', COALESCE((
      SELECT json_agg(it ORDER BY (it->>'value')::int DESC)
        FROM (
          SELECT json_build_object(
                   -- some defs already prefix the emoji in name (e.g. the certificate)
                   'name',  CASE WHEN d.emoji IS NOT NULL AND d.name LIKE d.emoji || '%'
                                 THEN d.name ELSE COALESCE(d.emoji || ' ', '') || d.name END,
                   'value', COALESCE(
                              (SELECT a.winning_bid FROM public.hero_item_auctions a
                                WHERE a.item_instance_id = i.id AND a.status = 'settled' LIMIT 1),
                              d.price, 0),
                   'source', i.acquired_from
                 ) AS it
            FROM public.hero_item_instances i
            JOIN public.hero_item_defs d ON d.id = i.item_def_id
           WHERE i.owner_id = p_uid
        ) s
    ), '[]'::json)
  ) FROM parts;
$$;

REVOKE ALL ON FUNCTION public.user_net_worth_breakdown(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_net_worth_breakdown(uuid) TO anon, authenticated;
