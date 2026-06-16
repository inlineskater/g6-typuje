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
--              + marketplace_escrow  (leading bids on open Targowisko auctions)
--              + hero_auction_escrow (leading bids on open hero-item auctions)
--
-- Note: marketplace_escrow + hero_auction_escrow are NOT part of any per-user
-- net_worth (leaderboard view doesn't add them back), so total_supply ≥ SUM(holdings).
-- This is expected and correct — those coins left profiles but haven't yet settled.
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.economy_stats()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  -- ── per-player net_worth, matching the leaderboard view formula ──────────
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
      -- coins minted via garden harvest, admin grants, top-ups, daily interest
      COALESCE((
        SELECT sum(ct.delta)
          FROM public.coin_transactions ct
         WHERE ct.delta > 0
           AND ct.reason IN ('garden_water','admin_grant','zapps_topup','daily_interest')
      ), 0::numeric) AS ledger_minted,

      -- weekly game prize payouts (100/50/25 per rank per season)
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
                             'canvas_pixel')
      ), 0::numeric) AS shop_burned,

      -- ── house (bank) P&L ────────────────────────────────────────────────
      -- football/Mundial: lost_stakes − paid_payouts (positive = house net burned)
      COALESCE((
        SELECT sum(CASE WHEN status='lost' THEN stake ELSE 0 END)
             - sum(CASE WHEN status='won'  THEN potential_payout ELSE 0 END)
          FROM public.football_bets
         WHERE status IN ('won','lost')
      ), 0::bigint)::numeric AS football_house_net,

      -- slots + roulette: total_bet − total_won (positive = house net burned)
      COALESCE((SELECT sum(10 - total_won) FROM public.slots_spins), 0::bigint)::numeric
        + COALESCE((SELECT sum(total_bet - total_won) FROM public.roulette_spins), 0::bigint)::numeric
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
    'marketplace_escrow',  round(b.marketplace_escrow)::bigint,
    'hero_auction_escrow', round(b.hero_auction_escrow)::bigint,
    'total_supply',        round(b.total_cash + b.market_positions + b.football_open
                                 + b.poker_stacks + b.hero_items + b.accessories
                                 + b.marketplace_escrow + b.hero_auction_escrow)::bigint,

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
