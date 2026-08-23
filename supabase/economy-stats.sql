-- economy-stats.sql
-- Server-wide economy aggregate for the "Skarbiec G6" panel.
-- Mirrors the logic from user_net_worth_breakdown + leaderboard view
-- but aggregated across ALL non-admin profiles.
--
-- total_supply = total_cash
--              + market_positions (open-trade mark-to-market, same formula as leaderboard)
--              + football_open   (escrowed stakes on open bets)
--              + poker_stacks    (chips on active seats)
--              + hero_items      (owned items at settled auction bid or shop price)
--              + accessories     (garden accessory spend, from coin ledger)
--              + farm_assets     (farm land + card-level spend + crop inventory at market + plant cards by rarity + NFT cards by scarcity + sealed seed/gold boxes + tile vouchers)
--              + marketplace_escrow  (leading bids on open Targowisko auctions)
--              + hero_auction_escrow (leading bids on open hero-item auctions)
--              + bank_assets     (Bank G6: open deposits, bonds, casino shares)
--
-- ⚠️ Requires supabase/bank.sql (bank_total_assets lives there).
--
-- Note: marketplace_escrow + hero_auction_escrow are NOT part of any per-user
-- net_worth (leaderboard view doesn't add them back), so total_supply ≥ SUM(holdings).
-- This is expected and correct — those coins left profiles but haven't yet settled.
-- Likewise farm land-tax debt: per-player net_worth (holdings/richest) is NET of
-- each player's land_tax_debt (subtracted inside user_assets_value), while the
-- supply buckets stay gross — the debt is a claim on future coins, not supply.
-- The server-wide outstanding total is exposed as 'farm_tax_debt' (informational).
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.hazard_house_net_from_spins(
  p_table regclass,
  p_bet_column text DEFAULT 'total_bet',
  p_fixed_bet integer DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric;
BEGIN
  IF p_table IS NULL THEN
    RETURN 0;
  END IF;

  IF p_fixed_bet IS NULL THEN
    EXECUTE format(
      'SELECT COALESCE(sum(%I - total_won), 0)::numeric FROM %s',
      COALESCE(p_bet_column, 'total_bet'),
      p_table
    ) INTO v_total;
  ELSE
    EXECUTE format(
      'SELECT COALESCE(sum(%s - total_won), 0)::numeric FROM %s',
      p_fixed_bet,
      p_table
    ) INTO v_total;
  END IF;

  RETURN COALESCE(v_total, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.hazard_house_net_from_spins(regclass, text, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.economy_stats()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  -- ── per-player net_worth, matching the leaderboard view formula ──────────
  -- (user_assets_value already nets out farm land_tax_debt, so holdings and
  -- richest reflect the liability just like the leaderboard does)
  player_nw AS (
    SELECT
      p.nick,
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
        + public.user_assets_value(p.id) AS net_worth
    FROM public.profiles p
    WHERE NOT p.is_admin
  ),
  -- ── server-wide supply buckets ────────────────────────────────────────────
  buckets AS (
    SELECT
      -- cash sitting in wallets
      COALESCE((
        SELECT sum(p.coins) FROM public.profiles p WHERE NOT p.is_admin
      ), 0::bigint)::numeric AS total_cash,

      -- open prediction-market position value (mark-to-market, non-admin trades)
      COALESCE((
        SELECT sum(
          CASE WHEN t.side = 'YES'
               THEN t.shares * (m.no_shares  / (m.yes_shares + m.no_shares))
               ELSE t.shares * (m.yes_shares / (m.yes_shares + m.no_shares))
          END)
        FROM public.trades t
        JOIN public.markets m ON m.id = t.market_id
        WHERE m.resolved = false
          AND t.user_id IN (SELECT id FROM public.profiles WHERE NOT is_admin)
      ), 0::numeric) AS market_positions,

      -- stakes on open football/Mundial bets (non-admin)
      COALESCE((
        SELECT sum(b.stake)
        FROM public.football_bets b
        WHERE b.status = 'open'
          AND b.user_id IN (SELECT id FROM public.profiles WHERE NOT is_admin)
      ), 0::bigint)::numeric AS football_open,

      -- chips on active poker seats (non-admin)
      COALESCE((
        SELECT sum(ps.stack)
        FROM public.poker_seats ps
        WHERE ps.user_id IN (SELECT id FROM public.profiles WHERE NOT is_admin)
      ), 0::bigint)::numeric AS poker_stacks,

      -- owned hero items + certificates at auction winning_bid or def price
      COALESCE((
        SELECT sum(COALESCE(
                 (SELECT a.winning_bid
                    FROM public.hero_item_auctions a
                   WHERE a.item_instance_id = i.id AND a.status = 'settled'
                   LIMIT 1),
                 d.price, 0))
          FROM public.hero_item_instances i
          JOIN public.hero_item_defs d ON d.id = i.item_def_id
         WHERE i.owner_id IN (SELECT id FROM public.profiles WHERE NOT is_admin)
      ), 0::numeric) AS hero_items,

      -- garden accessories (cost paid, recorded in coin ledger)
      COALESCE((
        SELECT sum(-ct.delta)
          FROM public.coin_transactions ct
         WHERE ct.reason = 'garden_accessory'
           AND ct.user_id IN (SELECT id FROM public.profiles WHERE NOT is_admin)
      ), 0::numeric) AS accessories,

      -- farm: currently owned land value + card-level investment + crop inventory at market
      -- + plant cards held (by rarity) + serialized NFT cards (scarcity value)
      COALESCE((
        SELECT sum(ft.asset_value)
          FROM public.farm_tiles ft
         WHERE ft.owner_id IN (SELECT id FROM public.profiles WHERE NOT is_admin)
      ), 0::numeric)
      + COALESCE((
        SELECT sum(-ct.delta)
          FROM public.coin_transactions ct
         WHERE ct.reason = 'card_levelup'
           AND ct.user_id IN (SELECT id FROM public.profiles WHERE NOT is_admin)
      ), 0::numeric)
      + COALESCE((
        SELECT sum(fi.qty * fm.cur_price)
          FROM public.farm_inventory fi
          JOIN public.farm_market fm ON fm.crop_type = fi.crop_type
         WHERE fi.user_id IN (SELECT id FROM public.profiles WHERE NOT is_admin)
           AND fi.expires_at > now()   -- exclude rotted crop lots
      ), 0::numeric)
      + COALESCE((
        SELECT sum(fc.count * (CASE d.rarity WHEN 'epic' THEN 150 WHEN 'rare' THEN 50 ELSE 20 END))
          FROM public.farm_collection fc
          JOIN public.farm_card_defs d ON d.species = fc.species
         WHERE d.edition_size IS NULL
           AND fc.user_id IN (SELECT id FROM public.profiles WHERE NOT is_admin)
      ), 0::numeric)
      -- ⚠️ Bred hybrids carry a per-level stat_value floor (farm-hybrid-income-parity.sql)
      -- so a hybrid is never valued below the parent it consumed. That file patches this
      -- expression in place via a guarded DO block, which means a plain re-run of THIS
      -- file silently reverted it (it did, on 2026-08-05: Skarbiec valued 7 wild_hybrids
      -- at 560 instead of 28171). Keep the COALESCE here so the two can't drift again.
      + COALESCE((
        SELECT sum(COALESCE(round(ni.stat_value * ni.level), round(20000.0 / ni.edition_size * ni.level)))
          FROM public.farm_nft_instances ni
         WHERE ni.owner_id IN (SELECT id FROM public.profiles WHERE NOT is_admin)
      ), 0::numeric)
      -- sealed (unopened) seed boxes at cost (100) + gold boxes at cost (500)
      -- + free-tile vouchers at base tile price (350)
      + COALESCE((
        SELECT sum(fus.boxes * 100 + fus.boxes_gold * 500 + fus.tile_vouchers * 350)
          FROM public.farm_user_state fus
         WHERE fus.user_id IN (SELECT id FROM public.profiles WHERE NOT is_admin)
      ), 0::numeric) AS farm_assets,

      -- outstanding farm land-tax debt (kataster) owed by non-admin players.
      -- Informational only: subtracted from each player's net worth via
      -- user_assets_value, but NOT from total_supply (see header note).
      COALESCE((
        SELECT sum(fus.land_tax_debt)
          FROM public.farm_user_state fus
         WHERE fus.user_id IN (SELECT id FROM public.profiles WHERE NOT is_admin)
      ), 0::bigint)::numeric AS farm_tax_debt,

      -- Bank G6: open Lokata/Skarbonka principal at mark, bonds at face +
      -- accrued coupons, casino shares at cost. Non-admin only.
      COALESCE(public.bank_total_assets(), 0::numeric) AS bank_assets,

      -- leading bids on open Targowisko (marketplace) auctions
      COALESCE((
        SELECT sum(b.amount)
          FROM public.marketplace_bids b
          JOIN public.marketplace_listings l ON l.id = b.listing_id
         WHERE b.status = 'leading' AND l.status = 'open'
      ), 0::bigint)::numeric AS marketplace_escrow,

      -- leading bids on open hero-item auctions
      COALESCE((
        SELECT sum(b.amount)
          FROM public.hero_item_auction_bids b
          JOIN public.hero_item_auctions a ON a.id = b.auction_id
         WHERE b.status = 'leading' AND a.status = 'open'
      ), 0::bigint)::numeric AS hero_auction_escrow,

      -- ── coin flow: minting ──────────────────────────────────────────────
      -- coins minted via garden harvest, admin grants, top-ups, daily interest,
      -- farm crop sales, farm seasonal contract/rank payouts, and the Loteria
      -- po Mundialu draw (prizes + the equal dividend)
      COALESCE((
        SELECT sum(ct.delta)
          FROM public.coin_transactions ct
         WHERE ct.delta > 0
           AND ct.reason IN ('garden_water','admin_grant','zapps_topup','daily_interest',
                             'farm_crop_sale','farm_seasonal_contract_bonus',
                             'farm_seasonal_rank_award',
                             'lottery_prize','lottery_dividend',
                             -- Bank G6 yields. bank_deposit_close /
                             -- bank_bond_redeem are NOT here: those return a
                             -- principal that was never burned, so counting
                             -- them would invent supply on every maturity.
                             'bank_deposit_interest','bank_bond_coupon',
                             'bank_share_dividend')
      ), 0::numeric) AS ledger_minted,

      -- weekly game prize payouts (game-defined top-three awards)
      COALESCE((
        SELECT sum(prize_coins) FROM (
          SELECT prize_coins FROM public.whack_boss_weekly_awards
          UNION ALL
          SELECT prize_coins FROM public.bug_jumper_weekly_awards
          UNION ALL
          SELECT prize_coins FROM public.flappy_pants_weekly_awards
          UNION ALL
          SELECT prize_coins FROM public.snake_weekly_awards
          UNION ALL
          SELECT prize_coins FROM public.invoice_horde_weekly_awards
          UNION ALL
          SELECT prize_coins FROM public.var_patrol_weekly_awards
          UNION ALL
          SELECT prize_coins FROM public.egg_catch_weekly_awards
          UNION ALL
          SELECT prize_coins FROM public.super_mariusz_weekly_awards
          UNION ALL
          SELECT prize_coins FROM public.popup_panic_weekly_awards
          UNION ALL
          -- Every seasonal game must be listed here or its prizes never count
          -- as minted supply. Tetris shipped missing from this UNION, and so
          -- did healer_dungeon and filler (added 2026-08-05 with the new
          -- bubble_breaker).
          SELECT prize_coins FROM public.tetris_weekly_awards
          UNION ALL
          SELECT prize_coins FROM public.healer_dungeon_weekly_awards
          UNION ALL
          SELECT prize_coins FROM public.filler_weekly_awards
          UNION ALL
          SELECT prize_coins FROM public.bubble_breaker_weekly_awards
        ) _awards
      ), 0::bigint)::numeric AS prizes_minted,

      -- ── coin flow: burning ──────────────────────────────────────────────
      -- coins destroyed at shops, item purchases, and misc fees
      COALESCE((
        SELECT sum(-ct.delta)
          FROM public.coin_transactions ct
         WHERE ct.delta < 0
           AND ct.reason IN ('garden_accessory','hero_item_purchase','store_purchase',
                             'garden_certificate','arcade_entry','hero_appearance_change',
                             'canvas_pixel','canvas_pixel_adjustment',
                             'farm_tile_buy','farm_box_buy','farm_goldbox_buy','lootbox_open','card_levelup',
                             'nft_breed',
                             'farm_land_tax_pay','farm_land_tax_autopay',
                             'zapps_purchase',
                             -- Casino shares are burned at purchase and then
                             -- valued in bank_assets, exactly like hero items.
                             -- bank_deposit_open / bank_bond_buy are escrow,
                             -- not burn, so they stay out (same treatment as
                             -- marketplace_bid_reserved).
                             'bank_share_buy')
      ), 0::numeric) AS shop_burned,

      -- ── house (bank) P&L ────────────────────────────────────────────────
      -- football/Mundial: lost_stakes − paid_payouts (positive = house net burned)
      COALESCE((
        SELECT sum(CASE WHEN status='lost' THEN stake ELSE 0 END)
             - sum(CASE WHEN status='won'  THEN potential_payout ELSE 0 END)
          FROM public.football_bets
         WHERE status IN ('won','lost')
      ), 0::bigint)::numeric AS football_house_net,

      -- house casino games: total_bet − total_won (positive = house net burned).
      -- `crash_spins` is optional until Rocket ships.
      public.hazard_house_net_from_spins(to_regclass('public.slots_spins'), NULL, 10)
        + public.hazard_house_net_from_spins(to_regclass('public.roulette_spins'), 'total_bet', NULL::integer)
        + public.hazard_house_net_from_spins(to_regclass('public.plinko_spins'), 'bet', NULL::integer)
        + public.hazard_house_net_from_spins(to_regclass('public.mines_spins'), 'bet', NULL::integer)
        + public.hazard_house_net_from_spins(to_regclass('public.crash_spins'), 'total_bet', NULL::integer)
        + public.hazard_house_net_from_spins(to_regclass('public.wheel_spins'), 'total_bet', NULL::integer)
        AS hazard_house_net
  )
  SELECT json_build_object(
    -- head counts
    'players',             (SELECT count(*) FROM public.profiles WHERE NOT is_admin),

    -- supply buckets
    'total_cash',          round(b.total_cash)::bigint,
    'market_positions',    round(b.market_positions)::bigint,
    'football_open',       round(b.football_open)::bigint,
    'poker_stacks',        round(b.poker_stacks)::bigint,
    'hero_items',          round(b.hero_items)::bigint,
    'accessories',         round(b.accessories)::bigint,
    'farm_assets',         round(b.farm_assets)::bigint,
    'farm_tax_debt',       round(b.farm_tax_debt)::bigint,
    'marketplace_escrow',  round(b.marketplace_escrow)::bigint,
    'hero_auction_escrow', round(b.hero_auction_escrow)::bigint,
    'bank_assets',         round(b.bank_assets)::bigint,
    'total_supply',        round(b.total_cash + b.market_positions + b.football_open
                                 + b.poker_stacks + b.hero_items + b.accessories + b.farm_assets
                                 + b.marketplace_escrow + b.hero_auction_escrow
                                 + b.bank_assets)::bigint,

    -- coin flow: minting
    'ledger_minted',       round(b.ledger_minted)::bigint,
    'prizes_minted',       round(b.prizes_minted)::bigint,
    'total_minted',        round(b.ledger_minted + b.prizes_minted)::bigint,

    -- coin flow: burning
    'shop_burned',         round(b.shop_burned)::bigint,
    'football_house_net',  round(b.football_house_net)::bigint,
    'hazard_house_net',    round(b.hazard_house_net)::bigint,
    'total_house_net',     round(b.football_house_net + b.hazard_house_net)::bigint,

    -- per-player net_worth array for distribution stats (sorted desc, no ids/nicks)
    'holdings',            (SELECT json_agg(round(net_worth)::bigint ORDER BY net_worth DESC)
                              FROM player_nw),

    -- richest non-admin player
    'richest',             (SELECT json_build_object('nick', nick, 'net_worth', round(net_worth)::bigint)
                              FROM player_nw ORDER BY net_worth DESC LIMIT 1)
  )
  FROM buckets b;
$$;

REVOKE ALL ON FUNCTION public.economy_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.economy_stats() TO anon, authenticated;
