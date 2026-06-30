-- Phase 2: sell Farma plant cards, serialized NFT cards, and empty territories between players, reusing
-- the Targowisko (marketplace) auction/escrow engine. Run AFTER marketplace.sql
-- and farm.sql. Idempotent (ALTER ... IF NOT EXISTS / CREATE OR REPLACE).
--
-- What this adds:
--   • item linkage on marketplace_listings (item_kind + nft_instance_id / card_species / farm tile coords)
--   • a `listed` reservation flag on farm_nft_instances (can't double-list / lose it)
--   • a `listed` reservation flag on farm_tiles (can't plant / double-list while for sale)
--   • farm_nft_transfers: full provenance + price history per NFT (mint + each sale)
--   • create_farm_nft_listing / create_farm_card_listing / create_farm_tile_listing (reserve the item at create)
--   • item-aware buy / settle / cancel (transfer ownership on sale, release on cancel)
--   • marketplace_cards view extended with the item columns for rendering
--
-- Coin flow is unchanged from marketplace.sql (buyer→seller, escrow on bid, refund
-- on outbid/cancel). Only the *item* moves on top of that.

-- ── Schema additions ────────────────────────────────────────────────────────
ALTER TABLE public.marketplace_listings ADD COLUMN IF NOT EXISTS item_kind       text;
ALTER TABLE public.marketplace_listings ADD COLUMN IF NOT EXISTS nft_instance_id uuid REFERENCES public.farm_nft_instances(id) ON DELETE SET NULL;
ALTER TABLE public.marketplace_listings ADD COLUMN IF NOT EXISTS card_species    text REFERENCES public.farm_card_defs(species);
ALTER TABLE public.marketplace_listings ADD COLUMN IF NOT EXISTS farm_tile_x     integer;
ALTER TABLE public.marketplace_listings ADD COLUMN IF NOT EXISTS farm_tile_y     integer;
DO $$ BEGIN
  ALTER TABLE public.marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_item_kind_chk;
  ALTER TABLE public.marketplace_listings
    ADD CONSTRAINT marketplace_item_kind_chk CHECK (item_kind IS NULL OR item_kind IN ('farm_nft','farm_card','farm_tile'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reserve flag: an NFT instance that is currently listed for sale.
ALTER TABLE public.farm_nft_instances ADD COLUMN IF NOT EXISTS listed boolean NOT NULL DEFAULT false;

-- Reserve/value fields for territories listed on Targowisko.
ALTER TABLE public.farm_tiles ADD COLUMN IF NOT EXISTS listed boolean NOT NULL DEFAULT false;
ALTER TABLE public.farm_tiles ADD COLUMN IF NOT EXISTS asset_value integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE public.farm_tiles DROP CONSTRAINT IF EXISTS farm_tiles_acquired_via_check;
  ALTER TABLE public.farm_tiles
    ADD CONSTRAINT farm_tiles_acquired_via_check CHECK (acquired_via IN ('migration','purchase','lootbox','marketplace'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.farm_tiles
    ADD CONSTRAINT farm_tiles_asset_value_chk CHECK (asset_value >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.farm_tiles
    ADD CONSTRAINT farm_tiles_listed_empty_chk CHECK (NOT listed OR planted_species IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS farm_tiles_listed_idx ON public.farm_tiles(listed) WHERE listed;

-- Existing purchased tiles were historically valued from their farm_tile_buy
-- ledger row. Move that cost basis onto the current tile so ownership transfers
-- can move land value with the tile.
DO $$
BEGIN
  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE public.farm_tiles ft
         SET asset_value = COALESCE((
          SELECT (ct.meta->>'price')::integer
            FROM public.coin_transactions ct
           WHERE ct.user_id = ft.owner_id
             AND ct.reason = 'farm_tile_buy'
             AND ct.meta ? 'price'
             AND ct.meta ? 'x'
             AND ct.meta ? 'y'
             AND (ct.meta->>'x')::integer = ft.x
             AND (ct.meta->>'y')::integer = ft.y
           ORDER BY ct.created_at DESC
           LIMIT 1
        ), ft.asset_value)
       WHERE ft.asset_value = 0
         AND ft.acquired_via = 'purchase'
         AND EXISTS (
          SELECT ct.meta
            FROM public.coin_transactions ct
           WHERE ct.user_id = ft.owner_id
             AND ct.reason = 'farm_tile_buy'
             AND ct.meta ? 'price'
             AND ct.meta ? 'x'
             AND ct.meta ? 'y'
             AND (ct.meta->>'x')::integer = ft.x
             AND (ct.meta->>'y')::integer = ft.y
           LIMIT 1
        )
    $sql$;
  END IF;
END $$;

-- Provenance + price log for serialized NFTs (public showcase, like the instances).
-- One row per ownership event: 'mint' (price NULL) and each 'sale' (price = coins paid).
CREATE TABLE IF NOT EXISTS public.farm_nft_transfers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES public.farm_nft_instances(id) ON DELETE CASCADE,
  species     text NOT NULL,
  serial_no   integer NOT NULL,
  from_owner  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  to_owner    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  price       integer,                       -- NULL = mint / non-coin transfer
  kind        text NOT NULL CHECK (kind IN ('mint','sale')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_nft_transfers_instance_idx ON public.farm_nft_transfers(instance_id, created_at);
CREATE INDEX IF NOT EXISTS farm_nft_transfers_species_idx  ON public.farm_nft_transfers(species, serial_no);

-- ── RLS / grants ──────────────────────────────────────────────────────────
ALTER TABLE public.farm_nft_transfers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_nft_transfers_select" ON public.farm_nft_transfers;
CREATE POLICY "farm_nft_transfers_select" ON public.farm_nft_transfers
  FOR SELECT TO anon, authenticated USING (true);
REVOKE ALL ON public.farm_nft_transfers FROM anon, authenticated;
GRANT SELECT ON public.farm_nft_transfers TO anon, authenticated;

-- ── Backfill mint history for NFTs minted before this log existed ───────────
INSERT INTO public.farm_nft_transfers (instance_id, species, serial_no, from_owner, to_owner, price, kind, created_at)
SELECT ni.id, ni.species, ni.serial_no, NULL, ni.owner_id, NULL, 'mint', ni.acquired_at
  FROM public.farm_nft_instances ni
 WHERE NOT EXISTS (
   SELECT 1 FROM public.farm_nft_transfers t WHERE t.instance_id = ni.id AND t.kind = 'mint');

-- ── Helper: deliver the sold item to the buyer + log NFT provenance ─────────
-- Called by buy/settle once coins have moved. Transfers the NFT instance owner or
-- credits the fungible card to the buyer. SECURITY DEFINER (invoked from definer fns).
CREATE OR REPLACE FUNCTION public.farm_marketplace_deliver(
  p_listing public.marketplace_listings, p_buyer uuid, p_price integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inst public.farm_nft_instances%ROWTYPE;
  v_tile public.farm_tiles%ROWTYPE;
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
    -- credit one duplicate (level 1) of the species to the buyer
    INSERT INTO public.farm_collection (user_id, species, count, level)
    VALUES (p_buyer, p_listing.card_species, 1, 1)
    ON CONFLICT (user_id, species) DO UPDATE SET count = farm_collection.count + 1;
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

-- ── Helper: release a reserved item back to the seller (cancel / no-sale) ───
CREATE OR REPLACE FUNCTION public.farm_marketplace_release(p_listing public.marketplace_listings)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_listing.item_kind = 'farm_nft' AND p_listing.nft_instance_id IS NOT NULL THEN
    UPDATE public.farm_nft_instances SET listed = false WHERE id = p_listing.nft_instance_id;
  ELSIF p_listing.item_kind = 'farm_card' THEN
    INSERT INTO public.farm_collection (user_id, species, count, level)
    VALUES (p_listing.seller_id, p_listing.card_species, 1, 1)
    ON CONFLICT (user_id, species) DO UPDATE SET count = farm_collection.count + 1;
  ELSIF p_listing.item_kind = 'farm_tile' THEN
    UPDATE public.farm_tiles
       SET listed = false
     WHERE x = p_listing.farm_tile_x
       AND y = p_listing.farm_tile_y
       AND owner_id = p_listing.seller_id;
  END IF;
END;
$$;

-- ── create_farm_nft_listing ─────────────────────────────────────────────────
-- List a serialized NFT you own. Reserves it (listed=true) so it can't be double-sold.
CREATE OR REPLACE FUNCTION public.create_farm_nft_listing(
  p_instance_id uuid, p_listing_type text, p_price integer,
  p_duration_hours integer DEFAULT 72, p_min_increment integer DEFAULT 10)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_inst  public.farm_nft_instances%ROWTYPE;
  v_def   public.farm_card_defs%ROWTYPE;
  v_dur   integer := LEAST(GREATEST(COALESCE(p_duration_hours, 72), 1), 720);
  v_incr  integer := LEAST(GREATEST(COALESCE(p_min_increment, 10), 1), 1000000);
  v_ends  timestamptz;
  v_id    uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_listing_type NOT IN ('fixed','auction') THEN RAISE EXCEPTION 'bad_listing_type'; END IF;
  IF p_price IS NULL OR p_price < 1 THEN RAISE EXCEPTION 'bad_price'; END IF;

  SELECT * INTO v_inst FROM public.farm_nft_instances WHERE id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'nft_not_found'; END IF;
  IF v_inst.owner_id <> v_user THEN RAISE EXCEPTION 'not_owner'; END IF;
  IF v_inst.listed THEN RAISE EXCEPTION 'already_listed'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_inst.species;
  IF p_listing_type = 'auction' THEN v_ends := now() + (v_dur || ' hours')::interval; END IF;

  UPDATE public.farm_nft_instances SET listed = true WHERE id = p_instance_id;

  INSERT INTO public.marketplace_listings
    (seller_id, emoji, title, description, listing_type, price, min_increment, ends_at, item_kind, nft_instance_id)
  VALUES (
    v_user, COALESCE(v_def.emoji, '💎'),
    COALESCE(v_inst.nft_name, v_def.name) || ' #' || v_inst.serial_no || '/' || v_inst.edition_size,
    'Karta NFT: ' || v_def.name || ' (limitowana, numerowana).',
    p_listing_type, p_price, v_incr, v_ends, 'farm_nft', p_instance_id)
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'listing_id', v_id);
END;
$$;

-- ── create_farm_card_listing ────────────────────────────────────────────────
-- List one duplicate of a fungible plant card you own (always sold at level 1).
-- Reserves it by decrementing your farm_collection count at create time.
CREATE OR REPLACE FUNCTION public.create_farm_card_listing(
  p_species text, p_listing_type text, p_price integer,
  p_duration_hours integer DEFAULT 72, p_min_increment integer DEFAULT 10)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_def   public.farm_card_defs%ROWTYPE;
  v_cnt   integer;
  v_dur   integer := LEAST(GREATEST(COALESCE(p_duration_hours, 72), 1), 720);
  v_incr  integer := LEAST(GREATEST(COALESCE(p_min_increment, 10), 1), 1000000);
  v_ends  timestamptz;
  v_id    uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_listing_type NOT IN ('fixed','auction') THEN RAISE EXCEPTION 'bad_listing_type'; END IF;
  IF p_price IS NULL OR p_price < 1 THEN RAISE EXCEPTION 'bad_price'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = p_species;
  IF NOT FOUND THEN RAISE EXCEPTION 'bad_species'; END IF;
  IF v_def.edition_size IS NOT NULL THEN RAISE EXCEPTION 'use_nft_listing'; END IF; -- NFTs go via instance

  -- reserve one duplicate (claim first; rolls back if anything below fails)
  UPDATE public.farm_collection SET count = count - 1
   WHERE user_id = v_user AND species = p_species AND count >= 1
  RETURNING count INTO v_cnt;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_duplicate'; END IF;

  IF p_listing_type = 'auction' THEN v_ends := now() + (v_dur || ' hours')::interval; END IF;

  INSERT INTO public.marketplace_listings
    (seller_id, emoji, title, description, listing_type, price, min_increment, ends_at, item_kind, card_species)
  VALUES (
    v_user, COALESCE(v_def.emoji, '🃏'),
    v_def.name || ' (karta rośliny)',
    'Duplikat karty rośliny „' || v_def.name || '" (poziom 1).',
    p_listing_type, p_price, v_incr, v_ends, 'farm_card', p_species)
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'listing_id', v_id, 'count_left', v_cnt);
END;
$$;

-- ── create_farm_tile_listing ───────────────────────────────────────────────
-- List one empty, non-migration territory tile. Reserves it with farm_tiles.listed
-- so it cannot be planted or listed again while the offer is open.
CREATE OR REPLACE FUNCTION public.create_farm_tile_listing(
  p_x integer, p_y integer, p_listing_type text, p_price integer,
  p_duration_hours integer DEFAULT 72, p_min_increment integer DEFAULT 10)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_tile  public.farm_tiles%ROWTYPE;
  v_dur   integer := LEAST(GREATEST(COALESCE(p_duration_hours, 72), 1), 720);
  v_incr  integer := LEAST(GREATEST(COALESCE(p_min_increment, 10), 1), 1000000);
  v_ends  timestamptz;
  v_id    uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_x < 0 OR p_x >= 13 OR p_y < 0 OR p_y >= 4 THEN RAISE EXCEPTION 'bad_coords'; END IF;
  IF p_listing_type NOT IN ('fixed','auction') THEN RAISE EXCEPTION 'bad_listing_type'; END IF;
  IF p_price IS NULL OR p_price < 1 THEN RAISE EXCEPTION 'bad_price'; END IF;

  SELECT * INTO v_tile FROM public.farm_tiles WHERE x = p_x AND y = p_y FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tile_not_owned'; END IF;
  IF v_tile.owner_id <> v_user THEN RAISE EXCEPTION 'not_owner'; END IF;
  IF v_tile.acquired_via = 'migration' THEN RAISE EXCEPTION 'zen_tile'; END IF;
  IF v_tile.planted_species IS NOT NULL THEN RAISE EXCEPTION 'tile_occupied'; END IF;
  IF v_tile.listed THEN RAISE EXCEPTION 'already_listed'; END IF;

  IF p_listing_type = 'auction' THEN v_ends := now() + (v_dur || ' hours')::interval; END IF;

  UPDATE public.farm_tiles SET listed = true WHERE x = p_x AND y = p_y;

  INSERT INTO public.marketplace_listings
    (seller_id, emoji, title, description, listing_type, price, min_increment, ends_at, item_kind, farm_tile_x, farm_tile_y)
  VALUES (
    v_user, '🏡',
    'Działka Ogródka [' || p_x || ',' || p_y || ']',
    'Pusta działka gotowa do obsadzenia w Ogródku.',
    p_listing_type, p_price, v_incr, v_ends, 'farm_tile', p_x, p_y)
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'listing_id', v_id, 'x', p_x, 'y', p_y);
END;
$$;

-- ── buy_marketplace_listing (item-aware) ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.buy_marketplace_listing(p_listing_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user       uuid := auth.uid();
  v_listing    public.marketplace_listings%ROWTYPE;
  v_coins_left integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_listing FROM public.marketplace_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'listing_not_found'; END IF;
  IF v_listing.listing_type <> 'fixed' THEN RAISE EXCEPTION 'not_fixed_listing'; END IF;
  IF v_listing.status <> 'open' THEN RAISE EXCEPTION 'listing_not_open'; END IF;
  IF v_listing.seller_id = v_user THEN RAISE EXCEPTION 'cannot_buy_own'; END IF;

  UPDATE public.profiles SET coins = coins - v_listing.price
   WHERE id = v_user AND coins >= v_listing.price
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  UPDATE public.profiles SET coins = coins + v_listing.price WHERE id = v_listing.seller_id;

  UPDATE public.marketplace_listings
     SET status = 'settled', buyer_id = v_user, final_price = v_listing.price, settled_at = now()
   WHERE id = p_listing_id;

  -- deliver the linked Farma item, if any
  PERFORM public.farm_marketplace_deliver(v_listing, v_user, v_listing.price);

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_listing.price, 'marketplace_purchase',
            jsonb_build_object('listing_id', p_listing_id, 'title', v_listing.title));
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_listing.seller_id, v_listing.price, 'marketplace_sale',
            jsonb_build_object('listing_id', p_listing_id, 'title', v_listing.title, 'buyer_id', v_user));
  END IF;

  RETURN json_build_object('ok', true, 'coins_left', v_coins_left);
END;
$$;

-- ── settle_marketplace_listing (item-aware) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.settle_marketplace_listing(p_listing_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_listing public.marketplace_listings%ROWTYPE;
  v_bid     public.marketplace_bids%ROWTYPE;
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

  UPDATE public.marketplace_bids SET status = 'won' WHERE id = v_bid.id;
  UPDATE public.marketplace_listings
     SET status = 'settled', buyer_id = v_bid.bidder_id, final_price = v_bid.amount, settled_at = now()
   WHERE id = p_listing_id;

  UPDATE public.profiles SET coins = coins + v_bid.amount WHERE id = v_listing.seller_id;

  PERFORM public.farm_marketplace_deliver(v_listing, v_bid.bidder_id, v_bid.amount);

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_listing.seller_id, v_bid.amount, 'marketplace_sale',
            jsonb_build_object('listing_id', p_listing_id, 'title', v_listing.title, 'buyer_id', v_bid.bidder_id));
  END IF;

  RETURN json_build_object('ok', true, 'status', 'settled', 'buyer_id', v_bid.bidder_id, 'final_price', v_bid.amount);
END;
$$;

-- ── cancel_marketplace_listing (item-aware) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_marketplace_listing(p_listing_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_listing public.marketplace_listings%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_listing FROM public.marketplace_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'listing_not_found'; END IF;
  IF v_listing.seller_id <> v_user AND NOT public.is_admin(v_user) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF v_listing.status <> 'open' THEN RETURN json_build_object('ok', true, 'status', v_listing.status); END IF;
  IF v_listing.buyer_id IS NOT NULL THEN RAISE EXCEPTION 'already_sold'; END IF;

  -- refund any outstanding leading bid before cancelling
  IF v_listing.listing_type = 'auction' THEN
    DECLARE v_leading public.marketplace_bids%ROWTYPE;
    BEGIN
      SELECT * INTO v_leading FROM public.marketplace_bids
       WHERE listing_id = p_listing_id AND status = 'leading' FOR UPDATE;
      IF FOUND THEN
        UPDATE public.marketplace_bids SET status = 'outbid' WHERE id = v_leading.id;
        UPDATE public.profiles SET coins = coins + v_leading.amount WHERE id = v_leading.bidder_id;
        IF to_regclass('public.coin_transactions') IS NOT NULL THEN
          INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
          VALUES (v_leading.bidder_id, v_leading.amount, 'marketplace_outbid_refund',
                  jsonb_build_object('listing_id', p_listing_id, 'reason', 'listing_cancelled'));
        END IF;
      END IF;
    END;
  END IF;

  UPDATE public.marketplace_listings SET status = 'cancelled', settled_at = now() WHERE id = p_listing_id;
  PERFORM public.farm_marketplace_release(v_listing);

  RETURN json_build_object('ok', true, 'status', 'cancelled');
END;
$$;

-- ── marketplace_cards view: expose the item columns for rendering ───────────
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
  ni.serial_no   AS nft_serial,
  ni.edition_size AS nft_edition,
  ni.nft_name     AS nft_name,
  ft.asset_value  AS farm_tile_asset_value
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

GRANT SELECT ON public.marketplace_cards TO anon, authenticated;

-- ── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.create_farm_nft_listing(uuid, text, integer, integer, integer)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_farm_card_listing(text, text, integer, integer, integer)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_farm_tile_listing(integer, integer, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_farm_nft_listing(uuid, text, integer, integer, integer)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_farm_card_listing(text, text, integer, integer, integer)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_farm_tile_listing(integer, integer, text, integer, integer, integer) TO authenticated;
-- buy/settle/cancel keep their existing grants from marketplace.sql (CREATE OR REPLACE
-- preserves grants). The deliver/release helpers are definer-internal:
REVOKE ALL ON FUNCTION public.farm_marketplace_deliver(public.marketplace_listings, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_marketplace_release(public.marketplace_listings)                 FROM PUBLIC, anon, authenticated;

-- ── Realtime ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='farm_nft_transfers') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_nft_transfers;
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
