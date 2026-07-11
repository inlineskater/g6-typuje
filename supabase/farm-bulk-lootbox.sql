-- ═══════════════════════════════════════════════════════════════════════════
-- Farma: bulk lootbox opening — open_farm_lootboxes(p_qty)
-- ═══════════════════════════════════════════════════════════════════════════
-- Run AFTER farm.sql (and after nft-leveling-rework.sql / nft-merge-fixes.sql,
-- whose open_farm_lootbox() this wraps). Idempotent; safe to re-run.
--
-- Opens up to FARM_BOX_BULK_OPEN_MAX (20, mirrored in index.html) sealed boxes
-- in ONE transaction by looping the canonical single-box open_farm_lootbox().
-- Wrapping (instead of duplicating the draw logic) means this stays correct no
-- matter which superseded copy of open_farm_lootbox is currently live.
-- All per-box rules apply exactly as if the boxes were opened one by one:
-- anti-hoarding NFT/voucher odds shrink between boxes of the same batch, and
-- the starter guarantee window advances box by box.
--
-- Returns:
--   { ok, opened, coins, boxes, tile_vouchers, got_voucher,
--     packs: [ { cards:[...], got_voucher } , ... ] }   -- one entry per box,
-- where cards[] is exactly the open_farm_lootbox card payload (species /
-- rarity / new_count / nft serial fields / {voucher:true} bonus entries).

CREATE OR REPLACE FUNCTION public.open_farm_lootboxes(p_qty integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_max   constant integer := 20;   -- keep in sync with FARM_BOX_BULK_OPEN_MAX in index.html
  v_boxes integer;
  v_res   jsonb;
  v_packs jsonb := '[]'::jsonb;
  v_vch   boolean := false;
  i       integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > v_max THEN RAISE EXCEPTION 'bad_qty'; END IF;

  -- Lock the state row so the whole batch is serialized per user and we can
  -- fail fast with a clean error instead of aborting mid-loop on box #k.
  SELECT boxes INTO v_boxes FROM public.farm_user_state
   WHERE user_id = v_user FOR UPDATE;
  IF COALESCE(v_boxes, 0) < p_qty THEN RAISE EXCEPTION 'no_box'; END IF;

  FOR i IN 1..p_qty LOOP
    v_res := public.open_farm_lootbox()::jsonb;
    v_packs := v_packs || jsonb_build_array(jsonb_build_object(
      'cards', COALESCE(v_res->'cards', '[]'::jsonb),
      'got_voucher', COALESCE((v_res->>'got_voucher')::boolean, false)));
    IF COALESCE((v_res->>'got_voucher')::boolean, false) THEN v_vch := true; END IF;
  END LOOP;

  -- Totals come from the LAST inner call (state after the whole batch).
  RETURN json_build_object(
    'ok', true, 'opened', p_qty,
    'coins', v_res->'coins',
    'boxes', v_res->'boxes',
    'tile_vouchers', v_res->'tile_vouchers',
    'got_voucher', v_vch,
    'packs', v_packs);
END;
$$;

REVOKE ALL ON FUNCTION public.open_farm_lootboxes(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_farm_lootboxes(integer) TO authenticated;
