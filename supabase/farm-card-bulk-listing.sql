-- Farm: sell MORE THAN ONE fungible plant card in a single Targowisko listing
-- ===========================================================================
-- Previously create_farm_card_listing reserved exactly one duplicate, so a seller
-- could only ever list a single „Karta rośliny" at a time. This adds a bundle
-- quantity: a listing can carry N duplicates of one species, reserved at create,
-- delivered together to the buyer for the single listing/auction price.
--
-- Run AFTER farm-marketplace.sql + nft-leveling-rework.sql + farm-plant-once-fix.sql
-- (it supersedes their create_farm_card_listing / farm_marketplace_deliver /
-- farm_marketplace_release / marketplace_cards copies — re-run this after re-running
-- any of them). Idempotent. Paste into the Supabase SQL Editor.

-- ── 1. Bundle quantity column on the listing ────────────────────────────────
ALTER TABLE public.marketplace_listings
  ADD COLUMN IF NOT EXISTS qty integer NOT NULL DEFAULT 1;
DO $$ BEGIN
  ALTER TABLE public.marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_qty_chk;
  ALTER TABLE public.marketplace_listings
    ADD CONSTRAINT marketplace_qty_chk CHECK (qty >= 1);
END $$;

-- ── 2. create_farm_card_listing — reserve N free duplicates ─────────────────
-- The old 5-arg signature must be dropped so the 6-arg (p_qty DEFAULT 1) form is
-- not ambiguous with a 5-arg call.
DROP FUNCTION IF EXISTS public.create_farm_card_listing(text, text, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.create_farm_card_listing(
  p_species text, p_listing_type text, p_price integer,
  p_duration_hours integer DEFAULT 72, p_min_increment integer DEFAULT 10,
  p_qty integer DEFAULT 1)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_def     public.farm_card_defs%ROWTYPE;
  v_cnt     integer;
  v_planted integer;
  v_free    integer;
  v_qty     integer := LEAST(GREATEST(COALESCE(p_qty, 1), 1), 999);
  v_dur     integer := LEAST(GREATEST(COALESCE(p_duration_hours, 72), 1), 720);
  v_incr    integer := LEAST(GREATEST(COALESCE(p_min_increment, 10), 1), 1000000);
  v_ends    timestamptz;
  v_id      uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_listing_type NOT IN ('fixed','auction') THEN RAISE EXCEPTION 'bad_listing_type'; END IF;
  IF p_price IS NULL OR p_price < 1 THEN RAISE EXCEPTION 'bad_price'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = p_species;
  IF NOT FOUND THEN RAISE EXCEPTION 'bad_species'; END IF;
  IF v_def.edition_size IS NOT NULL THEN RAISE EXCEPTION 'use_nft_listing'; END IF; -- NFTs go via instance

  -- Copies keeping a tile planted cannot be sold out from under it.
  SELECT count(*) INTO v_planted
    FROM public.farm_tiles
   WHERE owner_id = v_user AND planted_species = p_species;

  SELECT COALESCE(count, 0) INTO v_cnt
    FROM public.farm_collection
   WHERE user_id = v_user AND species = p_species;
  IF COALESCE(v_cnt, 0) < 1 THEN RAISE EXCEPTION 'no_duplicate'; END IF;   -- owns none

  v_free := v_cnt - v_planted;                    -- duplicates not backing a planted tile
  IF v_free < 1 THEN RAISE EXCEPTION 'card_planted'; END IF;               -- all planted
  IF v_free < v_qty THEN RAISE EXCEPTION 'not_enough_cards'; END IF;       -- not enough free

  -- reserve v_qty free duplicates (claim first; rolls back if anything below fails)
  UPDATE public.farm_collection SET count = count - v_qty
   WHERE user_id = v_user AND species = p_species AND count >= v_planted + v_qty
  RETURNING count INTO v_cnt;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_enough_cards'; END IF;            -- lost a race

  IF p_listing_type = 'auction' THEN v_ends := now() + (v_dur || ' hours')::interval; END IF;

  INSERT INTO public.marketplace_listings
    (seller_id, emoji, title, description, listing_type, price, min_increment, ends_at, item_kind, card_species, qty)
  VALUES (
    v_user, COALESCE(v_def.emoji, '🃏'),
    v_def.name || ' (karta rośliny)' || CASE WHEN v_qty > 1 THEN ' ×' || v_qty ELSE '' END,
    CASE WHEN v_qty > 1
      THEN v_qty || '× duplikat karty rośliny „' || v_def.name || '" (poziom 1).'
      ELSE 'Duplikat karty rośliny „' || v_def.name || '" (poziom 1).' END,
    p_listing_type, p_price, v_incr, v_ends, 'farm_card', p_species, v_qty)
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'listing_id', v_id, 'count_left', v_cnt, 'qty', v_qty);
END;
$$;

-- ── 3. Deliver / release the whole bundle ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_marketplace_deliver(
  p_listing public.marketplace_listings, p_buyer uuid, p_price integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inst public.farm_nft_instances%ROWTYPE;
  v_tile public.farm_tiles%ROWTYPE;
  v_qty  integer := GREATEST(COALESCE(p_listing.qty, 1), 1);
BEGIN
  IF p_listing.item_kind = 'farm_nft' THEN
    SELECT * INTO v_inst FROM public.farm_nft_instances
     WHERE id = p_listing.nft_instance_id FOR UPDATE;
    IF FOUND THEN
      UPDATE public.farm_nft_instances
         SET owner_id = p_buyer, listed = false, acquired_from = 'marketplace', acquired_at = now()
       WHERE id = v_inst.id;
      INSERT INTO public.farm_nft_transfers (instance_id, species, serial_no, from_owner, to_owner, price, kind)
      VALUES (v_inst.id, v_inst.species, v_inst.serial_no, p_listing.seller_id, p_buyer, p_price, 'sale');
    END IF;
  ELSIF p_listing.item_kind = 'farm_card' THEN
    -- credit the whole bundle (all level 1) of the species to the buyer
    INSERT INTO public.farm_collection (user_id, species, count, level)
    VALUES (p_buyer, p_listing.card_species, v_qty, 1)
    ON CONFLICT (user_id, species) DO UPDATE SET count = farm_collection.count + v_qty;
  ELSIF p_listing.item_kind = 'farm_tile' THEN
    SELECT * INTO v_tile FROM public.farm_tiles
     WHERE x = p_listing.farm_tile_x AND y = p_listing.farm_tile_y
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'tile_not_found'; END IF;
    IF v_tile.owner_id <> p_listing.seller_id THEN RAISE EXCEPTION 'tile_not_available'; END IF;
    IF NOT v_tile.listed THEN RAISE EXCEPTION 'tile_not_listed'; END IF;
    IF v_tile.acquired_via = 'migration' THEN RAISE EXCEPTION 'zen_tile'; END IF;
    IF v_tile.planted_species IS NOT NULL THEN RAISE EXCEPTION 'tile_occupied'; END IF;

    UPDATE public.farm_tiles
       SET owner_id = p_buyer,
           acquired_via = 'marketplace',
           acquired_at = now(),
           listed = false,
           asset_value = p_price
     WHERE x = p_listing.farm_tile_x AND y = p_listing.farm_tile_y;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.farm_marketplace_release(p_listing public.marketplace_listings)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_qty integer := GREATEST(COALESCE(p_listing.qty, 1), 1);
BEGIN
  IF p_listing.item_kind = 'farm_nft' AND p_listing.nft_instance_id IS NOT NULL THEN
    UPDATE public.farm_nft_instances SET listed = false WHERE id = p_listing.nft_instance_id;
  ELSIF p_listing.item_kind = 'farm_card' THEN
    INSERT INTO public.farm_collection (user_id, species, count, level)
    VALUES (p_listing.seller_id, p_listing.card_species, v_qty, 1)
    ON CONFLICT (user_id, species) DO UPDATE SET count = farm_collection.count + v_qty;
  ELSIF p_listing.item_kind = 'farm_tile' THEN
    UPDATE public.farm_tiles
       SET listed = false
     WHERE x = p_listing.farm_tile_x
       AND y = p_listing.farm_tile_y
       AND owner_id = p_listing.seller_id;
  END IF;
END;
$$;

-- ── 4. Expose qty on the card view ──────────────────────────────────────────
CREATE OR REPLACE VIEW public.marketplace_cards AS
SELECT
  l.id, l.seller_id, sp.nick AS seller_nick, l.emoji, l.title, l.description,
  l.listing_type, l.price, l.min_increment, l.ends_at, l.status, l.buyer_id,
  bp.nick AS buyer_nick, l.final_price, l.created_at, l.settled_at,
  COALESCE(l.final_price, lb.amount) AS current_bid,
  COALESCE(l.buyer_id, lb.bidder_id) AS current_bidder_id,
  lbp.nick AS current_bidder_nick,
  CASE
    WHEN l.listing_type = 'auction' AND l.status = 'open' AND lb.amount IS NOT NULL THEN lb.amount + l.min_increment
    WHEN l.listing_type = 'auction' AND l.status = 'open' THEN l.price
    ELSE NULL
  END AS next_min_bid,
  tb.top_bidders,
  -- item linkage (NULL for plain IRL goods)
  l.item_kind, l.nft_instance_id, l.card_species, l.farm_tile_x, l.farm_tile_y,
  ni.serial_no    AS nft_serial,
  ni.edition_size AS nft_edition,
  ni.nft_name     AS nft_name,
  ni.level        AS nft_level,
  ft.asset_value  AS farm_tile_asset_value,
  -- new columns must be APPENDED (CREATE OR REPLACE VIEW can't reorder existing ones)
  l.qty
FROM public.marketplace_listings l
JOIN public.profiles sp ON sp.id = l.seller_id
LEFT JOIN public.profiles bp ON bp.id = l.buyer_id
LEFT JOIN public.farm_nft_instances ni ON ni.id = l.nft_instance_id
LEFT JOIN public.farm_tiles ft ON ft.x = l.farm_tile_x AND ft.y = l.farm_tile_y
LEFT JOIN LATERAL (
  SELECT b.bidder_id, b.amount FROM public.marketplace_bids b
   WHERE b.listing_id = l.id AND b.status IN ('leading','won')
   ORDER BY b.amount DESC, b.created_at ASC LIMIT 1
) lb ON true
LEFT JOIN public.profiles lbp ON lbp.id = lb.bidder_id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('nick', p.nick, 'amount', top.max_amount) ORDER BY top.max_amount DESC) AS top_bidders
  FROM (
    SELECT b.bidder_id, MAX(b.amount) AS max_amount FROM public.marketplace_bids b
     WHERE b.listing_id = l.id GROUP BY b.bidder_id ORDER BY max_amount DESC LIMIT 3
  ) top JOIN public.profiles p ON p.id = top.bidder_id
) tb ON true
WHERE l.status = 'open' OR l.created_at > now() - interval '14 days';

-- ── 5. Grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.create_farm_card_listing(text, text, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_farm_card_listing(text, text, integer, integer, integer, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.farm_marketplace_deliver(public.marketplace_listings, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_marketplace_release(public.marketplace_listings)                 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.marketplace_cards TO anon, authenticated;
