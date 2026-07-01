-- NFT merge follow-up fixes. Run AFTER farm.sql, farm-marketplace.sql and
-- nft-leveling-rework.sql (and re-run it after re-running any of those three,
-- because they carry older copies of the functions patched here). Idempotent.
--
-- What this fixes:
--   1. SERIAL COLLISION: open_farm_lootbox derived the next serial (and the
--      edition supply gate) from count(*) of LIVE farm_nft_instances. Serials
--      are dense 1..N, so as soon as a merge burns an instance the live count
--      drops below the highest serial and the next draw of that species tries
--      to re-mint an existing serial → UNIQUE(species, serial_no) violation →
--      the WHOLE lootbox opening aborts. It also silently re-opened "sold out"
--      editions (live count < edition_size again after a burn), contradicting
--      the merge rule that the pool permanently shrinks.
--      Fix: farm_card_defs.minted_count — a monotonic minted-ever counter,
--      incremented under the existing def row lock — now drives the serial,
--      the supply gate, and the persona-name index.
--   2. PROVENANCE WIPE: farm_nft_transfers.instance_id was ON DELETE CASCADE,
--      so burning the fuel NFT in level_up_nft deleted its entire transfer
--      history — including the 'merge_fuel' row written one statement earlier.
--      Fix: instance_id becomes nullable with ON DELETE SET NULL; burned cards
--      keep their paper trail (mint, sales, merge_fuel).
--   3. SETTLE DEADLOCK: settle_marketplace_listing raised land_tax_debt when
--      the winning bidder of a farm-tile auction had unpaid kataster debt,
--      making the auction permanently unsettleable (seller unpaid, winner's
--      escrow locked). Fix: void the auction instead — refund the winner's
--      escrow, release the tile to the seller, mark the listing cancelled.
--   4. AMBIGUOUS RPC: the old 3-arg plant_crop(int,int,text) still coexisted
--      with the 4-arg instance-aware version (p_instance_id DEFAULT NULL); a
--      PostgREST call with 3 named args matches both. The frontend always
--      sends 4 args, but drop the dead 3-arg overload to remove the trap.

-- ── 1a. minted-ever counter on farm_card_defs ───────────────────────────────
ALTER TABLE public.farm_card_defs
  ADD COLUMN IF NOT EXISTS minted_count integer NOT NULL DEFAULT 0;

-- Backfill: minted-ever is at least the live count, the highest live serial,
-- and the highest serial ever logged in farm_nft_transfers (covers instances
-- burned before this fix whose transfer rows the old CASCADE already deleted
-- as best we can). GREATEST keeps re-runs monotonic.
UPDATE public.farm_card_defs d
   SET minted_count = GREATEST(
     d.minted_count,
     COALESCE((SELECT count(*)          FROM public.farm_nft_instances ni WHERE ni.species = d.species), 0),
     COALESCE((SELECT max(ni.serial_no) FROM public.farm_nft_instances ni WHERE ni.species = d.species), 0),
     COALESCE((SELECT max(t.serial_no)  FROM public.farm_nft_transfers t  WHERE t.species  = d.species), 0)
   )
 WHERE d.edition_size IS NOT NULL;

-- ── 2. farm_nft_transfers must survive the instance being burned ────────────
ALTER TABLE public.farm_nft_transfers ALTER COLUMN instance_id DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE public.farm_nft_transfers DROP CONSTRAINT IF EXISTS farm_nft_transfers_instance_id_fkey;
  ALTER TABLE public.farm_nft_transfers
    ADD CONSTRAINT farm_nft_transfers_instance_id_fkey
    FOREIGN KEY (instance_id) REFERENCES public.farm_nft_instances(id) ON DELETE SET NULL;
END $$;

-- ── 1b. open_farm_lootbox on minted_count ───────────────────────────────────
-- Reproduces the nft-leveling-rework.sql version verbatim except that every
-- edition-supply read (eligibility, weights, the locked re-check, the serial,
-- the persona-name index) now uses farm_card_defs.minted_count, which is
-- incremented under the same def row lock that already serialized minting.
CREATE OR REPLACE FUNCTION public.open_farm_lootbox()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_draws     constant integer := 3;       -- cards per box (keep in sync with index.html)
  v_voucher_p constant numeric := 0.07;    -- base natural chance for a free-tile voucher
  v_coins     integer;
  v_boxes     integer;
  v_vouchers  integer := 0;
  v_tiles     integer := 0;
  v_territory integer := 0;
  v_owned_nfts integer := 0;
  v_eff_voucher_p numeric := 0;
  v_got_vch   boolean := false;
  v_starter   integer := 0;       -- starter openings remaining (guarantee window)
  v_guar      boolean := false;   -- a tile voucher is still guaranteed within the window
  v_drop_vch  boolean := false;
  v_eligible  integer;
  v_target    integer;
  v_got       integer := 0;
  v_attempts  integer := 0;
  v_total     numeric;
  v_roll      numeric;
  v_species   text;
  v_def       public.farm_card_defs%ROWTYPE;
  v_new_count integer;
  v_serial    integer;
  v_nft_idx   integer;
  v_nft_name  text;
  v_nft_id    uuid;
  v_picked    text[] := ARRAY[]::text[];
  v_cards     jsonb  := '[]'::jsonb;
  v_card      jsonb;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  -- Consume one sealed box (bought earlier via buy_farm_lootbox, or the starter gift).
  UPDATE public.farm_user_state SET boxes = boxes - 1
   WHERE user_id = v_user AND boxes >= 1
  RETURNING boxes, tile_vouchers, starter_opens_left, guaranteed_voucher
       INTO v_boxes, v_vouchers, v_starter, v_guar;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_box'; END IF;
  SELECT coins INTO v_coins FROM public.profiles WHERE id = v_user;
  SELECT count(*) INTO v_owned_nfts FROM public.farm_nft_instances WHERE owner_id = v_user;
  SELECT count(*) INTO v_tiles FROM public.farm_tiles
   WHERE owner_id = v_user AND acquired_via <> 'migration';
  v_territory := v_tiles + COALESCE(v_vouchers, 0);
  v_eff_voucher_p := v_voucher_p / power(3::numeric, greatest(v_territory, 0));

  -- Eligible = active + weighted, and either uncapped OR an NFT edition with
  -- minted-ever supply left (burned cards do NOT return to the pool).
  SELECT count(*) INTO v_eligible
    FROM public.farm_card_defs d
   WHERE d.is_active AND d.draw_weight > 0
     AND (d.edition_size IS NULL OR d.minted_count < d.edition_size);
  IF v_eligible = 0 THEN RAISE EXCEPTION 'pool_empty'; END IF;
  v_target := least(v_draws, v_eligible);

  -- Draw distinct cards; NFTs get a freshly minted serial. A sold-out edition that
  -- slips through (race) is excluded and we redraw (bounded attempts).
  WHILE v_got < v_target AND v_attempts < 40 LOOP
    v_attempts := v_attempts + 1;

    SELECT sum(CASE WHEN d.edition_size IS NOT NULL
                    THEN d.draw_weight::numeric / power(3::numeric, v_owned_nfts)
                    ELSE d.draw_weight::numeric END)
      INTO v_total
      FROM public.farm_card_defs d
     WHERE d.is_active AND d.draw_weight > 0 AND d.species <> ALL(v_picked)
       AND (d.edition_size IS NULL OR d.minted_count < d.edition_size);
    EXIT WHEN v_total IS NULL OR v_total <= 0;

    v_roll := random() * v_total;
    SELECT species INTO v_species FROM (
      SELECT d.species,
             sum(CASE WHEN d.edition_size IS NOT NULL
                      THEN d.draw_weight::numeric / power(3::numeric, v_owned_nfts)
                      ELSE d.draw_weight::numeric END)
             OVER (ORDER BY d.species) AS cum
        FROM public.farm_card_defs d
       WHERE d.is_active AND d.draw_weight > 0 AND d.species <> ALL(v_picked)
         AND (d.edition_size IS NULL OR d.minted_count < d.edition_size)
    ) q
    WHERE q.cum > v_roll
    ORDER BY q.cum
    LIMIT 1;
    EXIT WHEN v_species IS NULL;

    SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_species FOR UPDATE;
    v_picked := array_append(v_picked, v_species);

    IF v_def.edition_size IS NOT NULL THEN
      -- NFT: re-check minted-ever supply under the row lock, then mint the next serial
      IF v_def.minted_count >= v_def.edition_size THEN
        CONTINUE;   -- sold out (race); already excluded via v_picked, try another card
      END IF;
      v_serial := v_def.minted_count + 1;
      -- unique funny name from the species' persona pool, by per-pool mint order
      -- (minted-ever, so a burned card never frees its name for reuse)
      SELECT COALESCE(sum(d2.minted_count), 0) INTO v_nft_idx
        FROM public.farm_card_defs d2
       WHERE d2.edition_size IS NOT NULL
         AND public.farm_nft_pool(d2.species) = public.farm_nft_pool(v_species);
      v_nft_name := public.farm_nft_persona(v_species, v_nft_idx);
      INSERT INTO public.farm_nft_instances (species, serial_no, edition_size, owner_id, acquired_from, nft_name)
      VALUES (v_species, v_serial, v_def.edition_size, v_user, 'lootbox', v_nft_name)
      RETURNING id INTO v_nft_id;
      UPDATE public.farm_card_defs SET minted_count = minted_count + 1 WHERE species = v_species;
      -- provenance log (farm-marketplace.sql); guarded so farm.sql stands alone
      IF to_regclass('public.farm_nft_transfers') IS NOT NULL THEN
        INSERT INTO public.farm_nft_transfers (instance_id, species, serial_no, from_owner, to_owner, price, kind)
        VALUES (v_nft_id, v_species, v_serial, NULL, v_user, NULL, 'mint');
      END IF;
      v_owned_nfts := v_owned_nfts + 1; -- same box gets lower odds for another NFT draw
    END IF;

    -- NFT level lives on farm_nft_instances, not farm_collection — only
    -- fungible (non-NFT) species get a farm_collection row/increment here.
    IF v_def.edition_size IS NULL THEN
      INSERT INTO public.farm_collection (user_id, species, count, level)
      VALUES (v_user, v_species, 1, 1)
      ON CONFLICT (user_id, species) DO UPDATE SET count = farm_collection.count + 1
      RETURNING count INTO v_new_count;
    ELSE
      v_new_count := NULL;
    END IF;

    v_card := jsonb_build_object(
      'species', v_species, 'name', v_def.name, 'emoji', v_def.emoji,
      'rarity', v_def.rarity, 'new_count', v_new_count);
    IF v_def.edition_size IS NOT NULL THEN
      v_card := v_card || jsonb_build_object('nft', true, 'id', v_nft_id, 'serial_no', v_serial, 'edition_size', v_def.edition_size, 'nft_name', v_nft_name);
    END IF;
    v_cards := v_cards || v_card;
    v_got := v_got + 1;
  END LOOP;

  -- Free-tile voucher: natural odds shrink with existing territory. The starter
  -- guarantee only survives while the player has no tile and no held voucher.
  IF v_guar AND v_territory > 0 THEN v_guar := false; END IF;
  IF v_starter > 0 THEN v_starter := v_starter - 1; END IF;
  v_drop_vch := (random() < v_eff_voucher_p) OR (v_guar AND v_starter = 0);
  IF v_drop_vch AND v_guar THEN v_guar := false; END IF;  -- guarantee satisfied

  UPDATE public.farm_user_state
     SET tile_vouchers = tile_vouchers + (CASE WHEN v_drop_vch THEN 1 ELSE 0 END),
         starter_opens_left = v_starter, guaranteed_voucher = v_guar
   WHERE user_id = v_user
  RETURNING tile_vouchers INTO v_vouchers;
  IF v_drop_vch THEN
    v_got_vch := true;
    v_cards := v_cards || jsonb_build_object('voucher', true);
  END IF;

  RETURN json_build_object('ok', true, 'coins', v_coins, 'boxes', v_boxes,
    'tile_vouchers', v_vouchers, 'got_voucher', v_got_vch, 'cards', v_cards);
END;
$$;

-- ── 3. settle_marketplace_listing: void instead of deadlock on tax debt ─────
-- Identical to the farm-marketplace.sql version except the farm_assert_can_expand
-- guard: if the winning bidder cannot take the land (unpaid kataster debt), the
-- auction is VOIDED — winner's escrow refunded, tile released to the seller,
-- listing cancelled — instead of raising forever and freezing the escrow.
CREATE OR REPLACE FUNCTION public.settle_marketplace_listing(p_listing_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_listing public.marketplace_listings%ROWTYPE;
  v_bid     public.marketplace_bids%ROWTYPE;
  v_sale_tax json;
  v_seller_net integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_listing FROM public.marketplace_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'listing_not_found'; END IF;
  IF v_listing.status IN ('settled','cancelled') THEN
    RETURN json_build_object('ok', true, 'status', v_listing.status,
      'buyer_id', v_listing.buyer_id, 'final_price', v_listing.final_price);
  END IF;
  IF v_listing.listing_type <> 'auction' THEN RAISE EXCEPTION 'not_auction_listing'; END IF;
  IF now() < v_listing.ends_at THEN RAISE EXCEPTION 'auction_still_open'; END IF;

  SELECT * INTO v_bid FROM public.marketplace_bids
   WHERE listing_id = p_listing_id AND status = 'leading'
   ORDER BY amount DESC, created_at ASC LIMIT 1 FOR UPDATE;

  IF NOT FOUND THEN
    -- no bids: cancel and release the reserved item back to the seller
    UPDATE public.marketplace_listings SET status = 'cancelled', settled_at = now() WHERE id = p_listing_id;
    PERFORM public.farm_marketplace_release(v_listing);
    RETURN json_build_object('ok', true, 'status', 'cancelled');
  END IF;

  IF v_listing.item_kind = 'farm_tile' THEN
    BEGIN
      PERFORM public.farm_assert_can_expand(v_bid.bidder_id, p_listing_id);
    EXCEPTION WHEN raise_exception THEN
      -- winner can't take the land (land_tax_debt): void — refund the winner's
      -- escrow, release the tile, cancel the listing. Without this the auction
      -- would be permanently unsettleable and the escrow frozen.
      UPDATE public.marketplace_bids SET status = 'outbid' WHERE id = v_bid.id;
      UPDATE public.profiles SET coins = coins + v_bid.amount WHERE id = v_bid.bidder_id;
      IF to_regclass('public.coin_transactions') IS NOT NULL THEN
        INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
        VALUES (v_bid.bidder_id, v_bid.amount, 'marketplace_outbid_refund',
                jsonb_build_object('listing_id', p_listing_id, 'reason', 'winner_land_tax_debt'));
      END IF;
      UPDATE public.marketplace_listings SET status = 'cancelled', settled_at = now() WHERE id = p_listing_id;
      PERFORM public.farm_marketplace_release(v_listing);
      RETURN json_build_object('ok', true, 'status', 'cancelled', 'reason', 'winner_land_tax_debt');
    END;
  END IF;

  UPDATE public.marketplace_bids SET status = 'won' WHERE id = v_bid.id;
  UPDATE public.marketplace_listings
     SET status = 'settled', buyer_id = v_bid.bidder_id, final_price = v_bid.amount, settled_at = now()
   WHERE id = p_listing_id;

  IF v_listing.item_kind IN ('farm_tile','farm_nft','farm_card') THEN
    v_sale_tax := public.farm_apply_land_tax_autopay(
      v_listing.seller_id, v_bid.amount, 'farm_marketplace_sale',
      jsonb_build_object('listing_id', p_listing_id, 'item_kind', v_listing.item_kind, 'buyer_id', v_bid.bidder_id)
    );
    v_seller_net := COALESCE((v_sale_tax->>'net')::integer, v_bid.amount);
  ELSE
    v_seller_net := v_bid.amount;
  END IF;

  UPDATE public.profiles SET coins = coins + v_seller_net WHERE id = v_listing.seller_id;

  PERFORM public.farm_marketplace_deliver(v_listing, v_bid.bidder_id, v_bid.amount);

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_listing.seller_id, v_bid.amount, 'marketplace_sale',
            jsonb_build_object('listing_id', p_listing_id, 'title', v_listing.title, 'buyer_id', v_bid.bidder_id));
  END IF;

  RETURN json_build_object('ok', true, 'status', 'settled', 'buyer_id', v_bid.bidder_id, 'final_price', v_bid.amount);
END;
$$;

-- ── 4. drop the superseded 3-arg plant_crop overload ────────────────────────
-- The frontend always calls the 4-arg version (p_instance_id, DEFAULT NULL);
-- keeping the 3-arg one makes a 3-named-arg PostgREST call ambiguous (HTTP 300).
DROP FUNCTION IF EXISTS public.plant_crop(integer, integer, text);

NOTIFY pgrst, 'reload schema';
