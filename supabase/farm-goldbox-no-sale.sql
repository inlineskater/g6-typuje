-- ============================================================================
--  ⭐ „Złota Skrzynia" — WITHDRAWN FROM SALE (2026-07-27)
-- ----------------------------------------------------------------------------
--  Run AFTER supabase/farm-goldbox.sql (and re-run this file after re-running
--  it — farm-goldbox.sql carries the ⚠️ superseded buy_farm_goldbox + its
--  GRANT). Idempotent (CREATE OR REPLACE + REVOKE only).
--
--  The premium gold lootbox can no longer be BOUGHT by anybody, at any price:
--    * buy_farm_goldbox(integer) is replaced by a stub that always raises
--      'goldbox_not_for_sale' — so even a service-role / SQL Editor call
--      cannot mint new sealed gold boxes by accident, and
--    * its EXECUTE grant is revoked from anon + authenticated, so the browser
--      gets a permission error before the function body is even reached.
--
--  Everything else about the gold box is DELIBERATELY LEFT INTACT:
--    * farm_user_state.boxes_gold keeps whatever players already own,
--    * open_farm_goldbox() / open_farm_goldboxes(p_qty) still work (5 draws,
--      guaranteed rare+ floor) so nobody loses a box they already paid for,
--    * sealed gold boxes are still worth 500 in net worth (economy-stats.sql /
--      leaderboard-net-worth-items.sql), and the 'farm_goldbox_buy' burn
--      reason stays in the stats lists for the historical ledger rows.
--
--  To bring the box back: re-run supabase/farm-goldbox.sql (which restores the
--  real buy_farm_goldbox and its grant), then re-add the frontend buy UI.
-- ============================================================================

-- ── 1. Disable the purchase RPC ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.buy_farm_goldbox(p_qty integer DEFAULT 1)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Sale ended 2026-07-27. See the header of this file for how to restore it.
  RAISE EXCEPTION 'goldbox_not_for_sale';
END;
$$;

COMMENT ON FUNCTION public.buy_farm_goldbox(integer) IS
  'DISABLED 2026-07-27 (farm-goldbox-no-sale.sql): ⭐ Złota Skrzynia is no longer for sale. Always raises goldbox_not_for_sale. Opening owned boxes still works.';

-- ── 2. Drop the client grant ─────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.buy_farm_goldbox(integer) FROM PUBLIC, anon, authenticated;

-- Opening stays available to logged-in players (re-asserted here so this file
-- is safe to run on its own without weakening the surviving paths).
GRANT EXECUTE ON FUNCTION public.open_farm_goldbox()          TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_farm_goldboxes(integer) TO authenticated;
