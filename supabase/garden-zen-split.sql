-- Ogródek Zen split — decouple zen plants from the crop farm board
-- Run in the Supabase SQL Editor (or via the Management API query endpoint).
-- Idempotent: safe to re-run.
--
-- Background: the „Farma" board (farm_tiles) used to display each Ogródek zen plant
-- as a `acquired_via='migration'` tile (one per gardens row, packed into row 0),
-- linked to its gardens row by zen_garden_id. The frontend now renders the zen
-- garden as a SEPARATE left-hand panel driven directly by the `gardens` table
-- (🧘 Ogród Zen), so those migration tiles are no longer needed on the crop board.
--
-- This drops them, reclaiming their cells as ordinary plantable farmland. It is
-- safe because migration tiles never carry crops / NFTs / marketplace listings,
-- and zen_garden_id is a plain column (NOT a foreign key), so the `gardens` rows
-- — the real source of truth for every zen plant — are untouched.

-- Freeing row 0 also unlocks the extra display plot the frontend maps to (0,0)
-- (FARM_EXTRA_TILES in index.html) — until this DELETE runs, buying it fails
-- with "tile_taken" because a migration tile still occupies that coordinate.
DELETE FROM public.farm_tiles WHERE acquired_via = 'migration';

-- ── Land-tax capacity: count only purchasable cells ─────────────────────────
-- The frontend hides row 0 (except the (0,0) extra tile), so the fair share
-- must be computed over the 40 reachable cells — not the full 13×4 grid, which
-- would inflate the tax-free cap with 12 cells nobody can buy. Mirrors the
-- updated copy in farm.sql.
CREATE OR REPLACE FUNCTION public.farm_normal_tile_capacity()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Purchasable cells only: data rows 1-3 (13×3) + the single row-0 tile (0,0)
  -- the frontend exposes (FARM_EXTRA_TILES in index.html). The rest of row 0 is
  -- hidden farmland reserved by the zen split and rejected by buy_farm_tile,
  -- so it must not inflate the land-tax fair share.
  SELECT 13 * 3 + 1;
$$;

-- ── buy_farm_tile: reject hidden row-0 coordinates ───────────────────────────
-- After the DELETE above frees row 0, a crafted RPC call could buy e.g. (5,0) —
-- a tile the UI never renders but which still counts for pricing/tax/capacity.
-- Only (0,0) (FARM_EXTRA_TILES in index.html) is a real purchasable plot.
-- Full body mirrors farm.sql's buy_farm_tile with the added row-0 guard.
CREATE OR REPLACE FUNCTION public.buy_farm_tile(p_x integer, p_y integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user     uuid := auth.uid();
  v_tiles    integer;
  v_price    integer;
  v_claimed  uuid;
  v_coins    integer;
  v_voucher  boolean := false;
  v_vouchers integer := 0;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_x < 0 OR p_x >= 13 OR p_y < 0 OR p_y >= 4 THEN RAISE EXCEPTION 'bad_coords'; END IF;
  -- Row 0 is the legacy zen row, hidden by the frontend since the zen split —
  -- only (0,0) (FARM_EXTRA_TILES in index.html) is purchasable, so a crafted RPC
  -- call can't buy an invisible tile that still counts for pricing/tax.
  IF p_y = 0 AND p_x <> 0 THEN RAISE EXCEPTION 'bad_coords'; END IF;

  INSERT INTO public.farm_user_state (user_id) VALUES (v_user)
  ON CONFLICT (user_id) DO NOTHING;
  PERFORM public.farm_assert_can_expand(v_user);

  -- Exclude legacy zen 'migration' tiles: they were never bought, and the client
  -- price quote (farmTilePrice/farmOwnedTileCount in index.html) doesn't count
  -- them — counting them here would double the charged price vs the shown one.
  SELECT count(*) INTO v_tiles FROM public.farm_tiles
   WHERE owner_id = v_user AND acquired_via <> 'migration';
  v_price := least(50000::numeric, floor(350::numeric * power(2::numeric, v_tiles)))::integer;

  -- A free-tile voucher (dropped by a seed box) claims a tile for 0 coins.
  -- Consume one under a row lock; if none, fall back to the escalating coin price.
  UPDATE public.farm_user_state SET tile_vouchers = tile_vouchers - 1
   WHERE user_id = v_user AND tile_vouchers > 0
  RETURNING tile_vouchers INTO v_vouchers;
  IF FOUND THEN v_voucher := true; ELSE v_price := v_price; END IF;

  INSERT INTO public.farm_tiles (x, y, owner_id, acquired_via, asset_value)
  VALUES (p_x, p_y, v_user, CASE WHEN v_voucher THEN 'lootbox' ELSE 'purchase' END,
          CASE WHEN v_voucher THEN 0 ELSE v_price END)
  ON CONFLICT (x, y) DO NOTHING
  RETURNING owner_id INTO v_claimed;
  IF v_claimed IS NULL THEN RAISE EXCEPTION 'tile_taken'; END IF;

  IF v_voucher THEN
    -- free claim via voucher: no coin movement, no ledger row
    SELECT coins INTO v_coins FROM public.profiles WHERE id = v_user;
    RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'price', 0,
                             'coins', v_coins, 'via', 'voucher', 'tile_vouchers', v_vouchers);
  END IF;

  UPDATE public.profiles SET coins = coins - v_price
   WHERE id = v_user AND coins >= v_price
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_price, 'farm_tile_buy', jsonb_build_object('x', p_x, 'y', p_y, 'price', v_price));
  END IF;

  RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'price', v_price,
                           'coins', v_coins, 'via', 'coins');
END;
$$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ────────────────────────────────────────────────────────────────
-- Expect: migration_tiles = 0, gardens_total unchanged (zen data preserved).
--   SELECT
--     (SELECT count(*) FROM public.farm_tiles WHERE acquired_via = 'migration') AS migration_tiles,
--     (SELECT count(*) FROM public.gardens)                                     AS gardens_total;
