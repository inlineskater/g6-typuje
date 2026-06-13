-- Net Worth: include owned assets (hero items + certificates + garden accessories)
-- plus restore the poker stack that football.sql's view redefinition dropped.
--
-- Net Worth = coins
--           + open prediction-market position value (unresolved trades)
--           + open Mundial (football) stakes
--           + live poker stack
--           + owned hero items & certificates (shop price, or auction winning bid)
--           + garden accessories (price paid, from the coin ledger)
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
         + public.user_assets_value(p.id) AS net_worth
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
                 WHERE ct.user_id = p_uid AND ct.reason = 'garden_accessory'), 0) AS accessories
  )
  SELECT json_build_object(
    'cash',             round(cash)::int,
    'market_positions', round(market_positions)::int,
    'football_open',    round(football_open)::int,
    'poker_stack',      round(poker_stack)::int,
    'hero_items',       round(hero_items)::int,
    'accessories',      round(accessories)::int,
    'total',            round(cash + market_positions + football_open + poker_stack + hero_items + accessories)::int,
    'items', COALESCE((
      SELECT json_agg(it ORDER BY (it->>'value')::int DESC)
        FROM (
          SELECT json_build_object(
                   'name',  d.emoji || ' ' || d.name,
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
