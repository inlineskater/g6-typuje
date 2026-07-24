-- Targowisko: "Zlecenia zakupu" — buyer-initiated requests, the mirror image of a
-- normal listing (seller posts, buyer buys). Run AFTER marketplace.sql, farm.sql,
-- farm-marketplace.sql, farm-card-bulk-listing.sql, and nft-merge-fixes.sql.
-- Idempotent. Paste into the Supabase SQL Editor.
--
-- Two independent mechanisms, both visible to every buyer and seller:
--
-- 1) STANDING BUY ORDER (auto-fill, fixed price) — "kupię wszystkie karty
--    Marchewka po 10 monet, max 10 sztuk". The buyer sets the price and a max
--    quantity; ANY seller holding a matching item (farm card / NFT / empty
--    territory) can instantly sell into it for the buyer's stated price — no
--    negotiation, no buyer confirmation. There is NO escrow: the buyer's coins
--    are only checked/deducted live at fill time (fill_buy_order), so an order
--    can outlive the buyer's ability to pay it in full — a seller who tries to
--    fill it then just gets 'buyer_insufficient_funds' and can retry smaller.
--
-- 2) OPEN REQUEST / RFQ (no price) — "kupię cokolwiek, zaproponujcie". The buyer
--    posts only a free-text description; sellers respond with their own
--    price + qty + description (what they can do — an in-game item or an IRL
--    good/service, same honor-system as a plain Targowisko listing). The buyer
--    manually reviews all offers and accepts exactly one, which charges the
--    buyer and pays the seller directly (no escrow, no item auto-delivery —
--    like buying a non-farm-linked Targowisko listing).
--
-- Coin reasons reuse the existing 'marketplace_purchase' / 'marketplace_sale'
-- ledger tags so coin-inflow-stats.sql's "marketplace" bucket already covers
-- these without changes. Farm-item sales (card/NFT/tile fills) also run
-- through farm_apply_land_tax_autopay, mirroring buy_marketplace_listing.

-- ── 1. Standing buy orders ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.marketplace_buy_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_kind    text NOT NULL CHECK (item_kind IN ('farm_card','farm_nft','farm_tile')),
  card_species text REFERENCES public.farm_card_defs(species),
  unit_price   integer NOT NULL CHECK (unit_price > 0),
  qty_total    integer NOT NULL CHECK (qty_total > 0),
  qty_filled   integer NOT NULL DEFAULT 0 CHECK (qty_filled >= 0),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  CHECK (item_kind = 'farm_tile' OR card_species IS NOT NULL),
  CHECK (qty_filled <= qty_total)
);

CREATE TABLE IF NOT EXISTS public.marketplace_buy_order_fills (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES public.marketplace_buy_orders(id) ON DELETE CASCADE,
  seller_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  qty        integer NOT NULL CHECK (qty > 0),
  unit_price integer NOT NULL CHECK (unit_price > 0),
  total      integer NOT NULL CHECK (total > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_buy_orders_status_idx ON public.marketplace_buy_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_buy_orders_buyer_idx  ON public.marketplace_buy_orders(buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_buy_order_fills_order_idx ON public.marketplace_buy_order_fills(order_id, created_at);

ALTER TABLE public.marketplace_buy_orders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_buy_order_fills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketplace_buy_orders_select" ON public.marketplace_buy_orders;
CREATE POLICY "marketplace_buy_orders_select" ON public.marketplace_buy_orders FOR SELECT USING (true);
DROP POLICY IF EXISTS "marketplace_buy_order_fills_select" ON public.marketplace_buy_order_fills;
CREATE POLICY "marketplace_buy_order_fills_select" ON public.marketplace_buy_order_fills FOR SELECT USING (true);

REVOKE ALL ON public.marketplace_buy_orders, public.marketplace_buy_order_fills FROM anon, authenticated;
GRANT SELECT ON public.marketplace_buy_orders, public.marketplace_buy_order_fills TO anon, authenticated;

-- Rendering view: buyer nick + card def details + remaining qty.
CREATE OR REPLACE VIEW public.marketplace_buy_order_cards AS
SELECT
  o.id, o.buyer_id, bp.nick AS buyer_nick, o.item_kind, o.card_species,
  d.name AS card_name, d.emoji AS card_emoji, d.edition_size,
  o.unit_price, o.qty_total, o.qty_filled, (o.qty_total - o.qty_filled) AS qty_remaining,
  o.status, o.created_at, o.closed_at
FROM public.marketplace_buy_orders o
JOIN public.profiles bp ON bp.id = o.buyer_id
LEFT JOIN public.farm_card_defs d ON d.species = o.card_species
WHERE o.status = 'open' OR o.created_at > now() - interval '14 days';

GRANT SELECT ON public.marketplace_buy_order_cards TO anon, authenticated;

-- Create a standing buy order. p_card_species is required for farm_card/farm_nft
-- (must match the def's NFT-ness for the chosen kind) and ignored for farm_tile.
CREATE OR REPLACE FUNCTION public.create_buy_order(
  p_item_kind    text,
  p_card_species text,
  p_unit_price   integer,
  p_qty          integer
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_def     public.farm_card_defs%ROWTYPE;
  v_species text := p_card_species;
  v_qty     integer := LEAST(GREATEST(COALESCE(p_qty, 1), 1), 999);
  v_id      uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_item_kind NOT IN ('farm_card','farm_nft','farm_tile') THEN RAISE EXCEPTION 'bad_item_kind'; END IF;
  IF p_unit_price IS NULL OR p_unit_price < 1 THEN RAISE EXCEPTION 'bad_price'; END IF;

  IF p_item_kind = 'farm_tile' THEN
    v_species := NULL;
  ELSE
    IF v_species IS NULL THEN RAISE EXCEPTION 'bad_species'; END IF;
    SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_species;
    IF NOT FOUND THEN RAISE EXCEPTION 'bad_species'; END IF;
    IF p_item_kind = 'farm_card' AND v_def.edition_size IS NOT NULL THEN RAISE EXCEPTION 'use_nft_kind'; END IF;
    IF p_item_kind = 'farm_nft'  AND v_def.edition_size IS NULL     THEN RAISE EXCEPTION 'use_card_kind'; END IF;
  END IF;

  INSERT INTO public.marketplace_buy_orders (buyer_id, item_kind, card_species, unit_price, qty_total)
  VALUES (v_user, p_item_kind, v_species, p_unit_price, v_qty)
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'order_id', v_id, 'qty', v_qty);
END;
$$;

-- Cancel an open buy order (buyer or admin). Nothing to refund — no escrow.
CREATE OR REPLACE FUNCTION public.cancel_buy_order(p_order_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_order public.marketplace_buy_orders%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_order FROM public.marketplace_buy_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v_order.buyer_id <> v_user AND NOT public.is_admin(v_user) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF v_order.status <> 'open' THEN RETURN json_build_object('ok', true, 'status', v_order.status); END IF;

  UPDATE public.marketplace_buy_orders SET status = 'cancelled', closed_at = now() WHERE id = p_order_id;
  RETURN json_build_object('ok', true, 'status', 'cancelled');
END;
$$;

-- Fill (part of) a buy order: seller supplies the matching item, gets paid
-- the buyer's stated unit_price immediately. No escrow — the buyer's balance
-- is checked live; a shortfall rolls back the whole item transfer too.
-- p_qty only matters for item_kind='farm_card' (a bundle); NFTs/tiles are
-- always exactly one unique item per call, so p_qty is forced to 1 for them.
CREATE OR REPLACE FUNCTION public.fill_buy_order(
  p_order_id    uuid,
  p_qty         integer DEFAULT 1,
  p_instance_id uuid DEFAULT NULL,
  p_tile_x      integer DEFAULT NULL,
  p_tile_y      integer DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user       uuid := auth.uid();
  v_order      public.marketplace_buy_orders%ROWTYPE;
  v_remaining  integer;
  v_qty        integer;
  v_total      integer;
  v_coins_left integer;
  v_sale_tax   json;
  v_seller_net integer;
  v_planted    integer;
  v_free       integer;
  v_cnt        integer;
  v_inst       public.farm_nft_instances%ROWTYPE;
  v_tile       public.farm_tiles%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_order FROM public.marketplace_buy_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v_order.status <> 'open' THEN RAISE EXCEPTION 'order_not_open'; END IF;
  IF v_order.buyer_id = v_user THEN RAISE EXCEPTION 'cannot_fill_own'; END IF;

  v_remaining := v_order.qty_total - v_order.qty_filled;
  v_qty := CASE WHEN v_order.item_kind = 'farm_card'
                THEN LEAST(GREATEST(COALESCE(p_qty, 1), 1), v_remaining)
                ELSE 1 END;
  IF v_qty < 1 OR v_qty > v_remaining THEN RAISE EXCEPTION 'not_enough_remaining'; END IF;

  -- ── transfer the item from seller (caller) to the buyer ────────────────
  IF v_order.item_kind = 'farm_card' THEN
    SELECT count(*) INTO v_planted FROM public.farm_tiles
     WHERE owner_id = v_user AND planted_species = v_order.card_species;
    SELECT COALESCE(count, 0) INTO v_cnt FROM public.farm_collection
     WHERE user_id = v_user AND species = v_order.card_species;
    v_free := COALESCE(v_cnt, 0) - v_planted;
    IF v_free < v_qty THEN RAISE EXCEPTION 'not_enough_cards'; END IF;

    UPDATE public.farm_collection SET count = count - v_qty
     WHERE user_id = v_user AND species = v_order.card_species AND count >= v_planted + v_qty
    RETURNING count INTO v_cnt;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_enough_cards'; END IF;

    INSERT INTO public.farm_collection (user_id, species, count, level)
    VALUES (v_order.buyer_id, v_order.card_species, v_qty, 1)
    ON CONFLICT (user_id, species) DO UPDATE SET count = farm_collection.count + v_qty;

  ELSIF v_order.item_kind = 'farm_nft' THEN
    IF p_instance_id IS NULL THEN RAISE EXCEPTION 'bad_instance'; END IF;
    SELECT * INTO v_inst FROM public.farm_nft_instances WHERE id = p_instance_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'nft_not_found'; END IF;
    IF v_inst.owner_id <> v_user THEN RAISE EXCEPTION 'not_owner'; END IF;
    IF v_inst.listed THEN RAISE EXCEPTION 'already_listed'; END IF;
    IF v_inst.species <> v_order.card_species THEN RAISE EXCEPTION 'species_mismatch'; END IF;

    UPDATE public.farm_nft_instances
       SET owner_id = v_order.buyer_id, acquired_from = 'marketplace', acquired_at = now()
     WHERE id = v_inst.id;
    INSERT INTO public.farm_nft_transfers (instance_id, species, serial_no, from_owner, to_owner, price, kind)
    VALUES (v_inst.id, v_inst.species, v_inst.serial_no, v_user, v_order.buyer_id, v_order.unit_price, 'sale');

  ELSIF v_order.item_kind = 'farm_tile' THEN
    IF p_tile_x IS NULL OR p_tile_y IS NULL THEN RAISE EXCEPTION 'bad_coords'; END IF;
    SELECT * INTO v_tile FROM public.farm_tiles WHERE x = p_tile_x AND y = p_tile_y FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'tile_not_owned'; END IF;
    IF v_tile.owner_id <> v_user THEN RAISE EXCEPTION 'not_owner'; END IF;
    IF v_tile.acquired_via = 'migration' THEN RAISE EXCEPTION 'zen_tile'; END IF;
    IF v_tile.planted_species IS NOT NULL THEN RAISE EXCEPTION 'tile_occupied'; END IF;
    IF v_tile.listed THEN RAISE EXCEPTION 'already_listed'; END IF;

    PERFORM public.farm_assert_can_expand(v_order.buyer_id);

    UPDATE public.farm_tiles
       SET owner_id = v_order.buyer_id, acquired_via = 'marketplace', acquired_at = now(), asset_value = v_order.unit_price
     WHERE x = p_tile_x AND y = p_tile_y;
  END IF;

  -- ── move coins — checked live, no escrow ────────────────────────────────
  v_total := v_qty * v_order.unit_price;

  UPDATE public.profiles SET coins = coins - v_total
   WHERE id = v_order.buyer_id AND coins >= v_total
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'buyer_insufficient_funds'; END IF;

  v_sale_tax := public.farm_apply_land_tax_autopay(
    v_user, v_total, 'farm_marketplace_sale',
    jsonb_build_object('buy_order_id', p_order_id, 'item_kind', v_order.item_kind, 'buyer_id', v_order.buyer_id)
  );
  v_seller_net := COALESCE((v_sale_tax->>'net')::integer, v_total);
  UPDATE public.profiles SET coins = coins + v_seller_net WHERE id = v_user;

  UPDATE public.marketplace_buy_orders
     SET qty_filled = qty_filled + v_qty,
         status     = CASE WHEN qty_filled + v_qty >= qty_total THEN 'closed' ELSE status END,
         closed_at  = CASE WHEN qty_filled + v_qty >= qty_total THEN now() ELSE closed_at END
   WHERE id = p_order_id;

  INSERT INTO public.marketplace_buy_order_fills (order_id, seller_id, qty, unit_price, total)
  VALUES (p_order_id, v_user, v_qty, v_order.unit_price, v_total);

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_order.buyer_id, -v_total, 'marketplace_purchase',
            jsonb_build_object('buy_order_id', p_order_id, 'item_kind', v_order.item_kind, 'seller_id', v_user));
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, v_seller_net, 'marketplace_sale',
            jsonb_build_object('buy_order_id', p_order_id, 'item_kind', v_order.item_kind, 'buyer_id', v_order.buyer_id));
  END IF;

  RETURN json_build_object('ok', true, 'coins_left', v_coins_left, 'qty', v_qty, 'total', v_total);
END;
$$;

-- ── 2. Open requests (RFQ) with seller offers ───────────────────────────────

CREATE TABLE IF NOT EXISTS public.marketplace_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  description       text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 300),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  accepted_offer_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz
);

CREATE TABLE IF NOT EXISTS public.marketplace_request_offers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES public.marketplace_requests(id) ON DELETE CASCADE,
  seller_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  price       integer NOT NULL CHECK (price > 0),
  qty         integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','withdrawn')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.marketplace_requests
    ADD CONSTRAINT marketplace_requests_accepted_offer_fkey
    FOREIGN KEY (accepted_offer_id) REFERENCES public.marketplace_request_offers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS marketplace_requests_status_idx ON public.marketplace_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_requests_buyer_idx  ON public.marketplace_requests(buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_request_offers_request_idx ON public.marketplace_request_offers(request_id, created_at);
CREATE INDEX IF NOT EXISTS marketplace_request_offers_seller_idx  ON public.marketplace_request_offers(seller_id, created_at DESC);

ALTER TABLE public.marketplace_requests       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_request_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketplace_requests_select" ON public.marketplace_requests;
CREATE POLICY "marketplace_requests_select" ON public.marketplace_requests FOR SELECT USING (true);
DROP POLICY IF EXISTS "marketplace_request_offers_select" ON public.marketplace_request_offers;
CREATE POLICY "marketplace_request_offers_select" ON public.marketplace_request_offers FOR SELECT USING (true);

REVOKE ALL ON public.marketplace_requests, public.marketplace_request_offers FROM anon, authenticated;
GRANT SELECT ON public.marketplace_requests, public.marketplace_request_offers TO anon, authenticated;

-- Rendering view: request + every offer against it as a JSON array (mirrors
-- marketplace_cards' top_bidders pattern), newest offer last.
CREATE OR REPLACE VIEW public.marketplace_request_cards AS
SELECT
  r.id, r.buyer_id, bp.nick AS buyer_nick, r.description, r.status,
  r.accepted_offer_id, r.created_at, r.closed_at,
  COALESCE(oa.offers, '[]'::jsonb) AS offers
FROM public.marketplace_requests r
JOIN public.profiles bp ON bp.id = r.buyer_id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object(
    'id', o.id, 'seller_id', o.seller_id, 'seller_nick', sp.nick,
    'price', o.price, 'qty', o.qty, 'description', o.description,
    'status', o.status, 'created_at', o.created_at
  ) ORDER BY o.created_at ASC) AS offers
  FROM public.marketplace_request_offers o
  JOIN public.profiles sp ON sp.id = o.seller_id
  WHERE o.request_id = r.id
) oa ON true
WHERE r.status = 'open' OR r.created_at > now() - interval '14 days';

GRANT SELECT ON public.marketplace_request_cards TO anon, authenticated;

-- Post an open request. No price — sellers propose their own below.
CREATE OR REPLACE FUNCTION public.create_marketplace_request(p_description text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_id   uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF length(trim(COALESCE(p_description, ''))) < 1 THEN RAISE EXCEPTION 'bad_description'; END IF;

  INSERT INTO public.marketplace_requests (buyer_id, description)
  VALUES (v_user, left(trim(p_description), 300))
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'request_id', v_id);
END;
$$;

-- Cancel an open request (buyer or admin); declines any still-pending offers.
CREATE OR REPLACE FUNCTION public.cancel_marketplace_request(p_request_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_req  public.marketplace_requests%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_req FROM public.marketplace_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF v_req.buyer_id <> v_user AND NOT public.is_admin(v_user) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF v_req.status <> 'open' THEN RETURN json_build_object('ok', true, 'status', v_req.status); END IF;

  UPDATE public.marketplace_requests SET status = 'cancelled', closed_at = now() WHERE id = p_request_id;
  UPDATE public.marketplace_request_offers SET status = 'declined'
   WHERE request_id = p_request_id AND status = 'pending';

  RETURN json_build_object('ok', true, 'status', 'cancelled');
END;
$$;

-- Propose (or update) your own offer on someone else's open request. A seller
-- can only have one active offer per request — re-offering updates the
-- pending one in place rather than piling up duplicates.
CREATE OR REPLACE FUNCTION public.create_request_offer(
  p_request_id  uuid,
  p_price       integer,
  p_qty         integer DEFAULT 1,
  p_description text DEFAULT ''
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_req  public.marketplace_requests%ROWTYPE;
  v_qty  integer := LEAST(GREATEST(COALESCE(p_qty, 1), 1), 999);
  v_desc text := left(trim(COALESCE(p_description, '')), 300);
  v_id   uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_price IS NULL OR p_price < 1 THEN RAISE EXCEPTION 'bad_price'; END IF;

  SELECT * INTO v_req FROM public.marketplace_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF v_req.status <> 'open' THEN RAISE EXCEPTION 'request_not_open'; END IF;
  IF v_req.buyer_id = v_user THEN RAISE EXCEPTION 'cannot_offer_own'; END IF;

  UPDATE public.marketplace_request_offers
     SET price = p_price, qty = v_qty, description = v_desc, created_at = now()
   WHERE request_id = p_request_id AND seller_id = v_user AND status = 'pending'
  RETURNING id INTO v_id;

  IF NOT FOUND THEN
    INSERT INTO public.marketplace_request_offers (request_id, seller_id, price, qty, description)
    VALUES (p_request_id, v_user, p_price, v_qty, v_desc)
    RETURNING id INTO v_id;
  END IF;

  RETURN json_build_object('ok', true, 'offer_id', v_id);
END;
$$;

-- Seller retracts their own pending offer.
CREATE OR REPLACE FUNCTION public.withdraw_request_offer(p_offer_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_offer public.marketplace_request_offers%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_offer FROM public.marketplace_request_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;
  IF v_offer.seller_id <> v_user THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF v_offer.status <> 'pending' THEN RETURN json_build_object('ok', true, 'status', v_offer.status); END IF;

  UPDATE public.marketplace_request_offers SET status = 'withdrawn' WHERE id = p_offer_id;
  RETURN json_build_object('ok', true, 'status', 'withdrawn');
END;
$$;

-- Buyer dismisses one offer without accepting it (request stays open for more).
CREATE OR REPLACE FUNCTION public.decline_request_offer(p_offer_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_offer public.marketplace_request_offers%ROWTYPE;
  v_req   public.marketplace_requests%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_offer FROM public.marketplace_request_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;
  SELECT * INTO v_req FROM public.marketplace_requests WHERE id = v_offer.request_id;
  IF v_req.buyer_id <> v_user AND NOT public.is_admin(v_user) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF v_offer.status <> 'pending' THEN RETURN json_build_object('ok', true, 'status', v_offer.status); END IF;

  UPDATE public.marketplace_request_offers SET status = 'declined' WHERE id = p_offer_id;
  RETURN json_build_object('ok', true, 'status', 'declined');
END;
$$;

-- Buyer accepts one seller's offer: pays price*qty directly to the seller
-- (no escrow, no item auto-delivery — honor-system like a plain IRL listing),
-- closes the request, and declines every other pending offer on it.
CREATE OR REPLACE FUNCTION public.accept_request_offer(p_offer_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user       uuid := auth.uid();
  v_offer      public.marketplace_request_offers%ROWTYPE;
  v_req        public.marketplace_requests%ROWTYPE;
  v_total      integer;
  v_coins_left integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_offer FROM public.marketplace_request_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;
  IF v_offer.status <> 'pending' THEN RAISE EXCEPTION 'offer_not_pending'; END IF;

  SELECT * INTO v_req FROM public.marketplace_requests WHERE id = v_offer.request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF v_req.buyer_id <> v_user THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF v_req.status <> 'open' THEN RAISE EXCEPTION 'request_not_open'; END IF;

  v_total := v_offer.price * v_offer.qty;

  UPDATE public.profiles SET coins = coins - v_total
   WHERE id = v_user AND coins >= v_total
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  UPDATE public.profiles SET coins = coins + v_total WHERE id = v_offer.seller_id;

  UPDATE public.marketplace_request_offers SET status = 'accepted' WHERE id = p_offer_id;
  UPDATE public.marketplace_request_offers SET status = 'declined'
   WHERE request_id = v_req.id AND status = 'pending' AND id <> p_offer_id;
  UPDATE public.marketplace_requests
     SET status = 'closed', accepted_offer_id = p_offer_id, closed_at = now()
   WHERE id = v_req.id;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_total, 'marketplace_purchase',
            jsonb_build_object('request_id', v_req.id, 'offer_id', p_offer_id, 'seller_id', v_offer.seller_id));
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_offer.seller_id, v_total, 'marketplace_sale',
            jsonb_build_object('request_id', v_req.id, 'offer_id', p_offer_id, 'buyer_id', v_user));
  END IF;

  RETURN json_build_object('ok', true, 'coins_left', v_coins_left, 'total', v_total);
END;
$$;

-- ── Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.create_buy_order(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_buy_order(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fill_buy_order(uuid, integer, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_marketplace_request(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_marketplace_request(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_request_offer(uuid, integer, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.withdraw_request_offer(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decline_request_offer(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_request_offer(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_buy_order(text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_buy_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fill_buy_order(uuid, integer, uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_marketplace_request(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_marketplace_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_request_offer(uuid, integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_request_offer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decline_request_offer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_request_offer(uuid) TO authenticated;

-- ── Realtime ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='marketplace_buy_orders') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_buy_orders;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='marketplace_buy_order_fills') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_buy_order_fills;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='marketplace_requests') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_requests;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='marketplace_request_offers') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_request_offers;
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
