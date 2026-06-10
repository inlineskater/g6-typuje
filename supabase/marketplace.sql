-- Peer-to-peer marketplace ("Targowisko") for Rynek Proroctw G6.
-- Run after supabase/schema.sql.
-- Any authenticated user can list their own IRL services/goods for coins.
-- Sellers receive the coins (coins transfer from buyer to seller, not burned).

-- ── Tables ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.marketplace_listings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  emoji        text NOT NULL DEFAULT '🛍️',
  title        text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  description  text NOT NULL DEFAULT '',
  listing_type text NOT NULL CHECK (listing_type IN ('fixed','auction')),
  price        integer NOT NULL CHECK (price > 0),
  min_increment integer NOT NULL DEFAULT 10 CHECK (min_increment > 0),
  ends_at      timestamptz,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','cancelled')),
  buyer_id     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  final_price  integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  settled_at   timestamptz,
  CHECK (listing_type <> 'auction' OR ends_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.marketplace_bids (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.marketplace_listings(id) ON DELETE CASCADE,
  bidder_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount     integer NOT NULL CHECK (amount > 0),
  status     text NOT NULL DEFAULT 'leading' CHECK (status IN ('leading','outbid','won')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS marketplace_listings_status_created_idx
  ON public.marketplace_listings(status, created_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_listings_seller_idx
  ON public.marketplace_listings(seller_id, created_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_bids_listing_idx
  ON public.marketplace_bids(listing_id, amount DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS marketplace_bids_bidder_idx
  ON public.marketplace_bids(bidder_id, created_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_bids     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketplace_listings_select" ON public.marketplace_listings;
CREATE POLICY "marketplace_listings_select" ON public.marketplace_listings
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "marketplace_bids_select" ON public.marketplace_bids;
CREATE POLICY "marketplace_bids_select" ON public.marketplace_bids
  FOR SELECT USING (true);

REVOKE ALL ON public.marketplace_listings, public.marketplace_bids FROM anon, authenticated;
GRANT SELECT ON public.marketplace_listings, public.marketplace_bids TO anon, authenticated;

-- ── View: marketplace_cards ───────────────────────────────────────────────────
-- Exposes all fields needed for card rendering: seller/buyer nicks, current bid,
-- next minimum bid, and top-3 bidders as a JSON array.

CREATE OR REPLACE VIEW public.marketplace_cards AS
SELECT
  l.id,
  l.seller_id,
  sp.nick AS seller_nick,
  l.emoji,
  l.title,
  l.description,
  l.listing_type,
  l.price,
  l.min_increment,
  l.ends_at,
  l.status,
  l.buyer_id,
  bp.nick AS buyer_nick,
  l.final_price,
  l.created_at,
  l.settled_at,
  -- current bid: winning_bid if settled, else top leading bid amount
  COALESCE(
    l.final_price,
    lb.amount
  ) AS current_bid,
  COALESCE(l.buyer_id, lb.bidder_id) AS current_bidder_id,
  lbp.nick AS current_bidder_nick,
  CASE
    WHEN l.listing_type = 'auction' AND l.status = 'open' AND lb.amount IS NOT NULL
      THEN lb.amount + l.min_increment
    WHEN l.listing_type = 'auction' AND l.status = 'open'
      THEN l.price
    ELSE NULL
  END AS next_min_bid,
  tb.top_bidders
FROM public.marketplace_listings l
JOIN public.profiles sp ON sp.id = l.seller_id
LEFT JOIN public.profiles bp ON bp.id = l.buyer_id
-- top leading bid
LEFT JOIN LATERAL (
  SELECT b.bidder_id, b.amount
    FROM public.marketplace_bids b
   WHERE b.listing_id = l.id
     AND b.status IN ('leading','won')
   ORDER BY b.amount DESC, b.created_at ASC
   LIMIT 1
) lb ON true
LEFT JOIN public.profiles lbp ON lbp.id = lb.bidder_id
-- top-3 bidders
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object('nick', p.nick, 'amount', top.max_amount)
    ORDER BY top.max_amount DESC
  ) AS top_bidders
  FROM (
    SELECT b.bidder_id, MAX(b.amount) AS max_amount
      FROM public.marketplace_bids b
     WHERE b.listing_id = l.id
     GROUP BY b.bidder_id
     ORDER BY max_amount DESC
     LIMIT 3
  ) top
  JOIN public.profiles p ON p.id = top.bidder_id
) tb ON true
WHERE l.status = 'open'
   OR l.created_at > now() - interval '14 days';

GRANT SELECT ON public.marketplace_cards TO anon, authenticated;

-- ── RPCs ──────────────────────────────────────────────────────────────────────

-- Create a new marketplace listing (any authenticated user).
DROP FUNCTION IF EXISTS public.create_marketplace_listing(text, text, text, text, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.create_marketplace_listing(
  p_emoji        text,
  p_title        text,
  p_description  text,
  p_listing_type text,
  p_price        integer,
  p_duration_hours integer DEFAULT 72,
  p_min_increment  integer DEFAULT 10
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user     uuid := auth.uid();
  v_listing  public.marketplace_listings%ROWTYPE;
  v_duration integer := LEAST(GREATEST(COALESCE(p_duration_hours, 72), 1), 720);
  v_incr     integer := LEAST(GREATEST(COALESCE(p_min_increment, 10), 1), 1000000);
  v_ends_at  timestamptz;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_listing_type NOT IN ('fixed','auction') THEN RAISE EXCEPTION 'bad_listing_type'; END IF;
  IF length(trim(COALESCE(p_title, ''))) < 1 THEN RAISE EXCEPTION 'bad_title'; END IF;
  IF p_price IS NULL OR p_price < 1 THEN RAISE EXCEPTION 'bad_price'; END IF;

  IF p_listing_type = 'auction' THEN
    v_ends_at := now() + (v_duration || ' hours')::interval;
  END IF;

  INSERT INTO public.marketplace_listings
    (seller_id, emoji, title, description, listing_type, price, min_increment, ends_at)
  VALUES (
    v_user,
    COALESCE(NULLIF(trim(p_emoji), ''), '🛍️'),
    trim(p_title),
    trim(COALESCE(p_description, '')),
    p_listing_type,
    p_price,
    v_incr,
    v_ends_at
  )
  RETURNING * INTO v_listing;

  RETURN json_build_object('ok', true, 'listing_id', v_listing.id);
END;
$$;

-- Buy a fixed-price listing; coins transfer from buyer to seller.
DROP FUNCTION IF EXISTS public.buy_marketplace_listing(uuid);

CREATE OR REPLACE FUNCTION public.buy_marketplace_listing(p_listing_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_listing   public.marketplace_listings%ROWTYPE;
  v_coins_left integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_listing
    FROM public.marketplace_listings
   WHERE id = p_listing_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'listing_not_found'; END IF;
  IF v_listing.listing_type <> 'fixed' THEN RAISE EXCEPTION 'not_fixed_listing'; END IF;
  IF v_listing.status <> 'open' THEN RAISE EXCEPTION 'listing_not_open'; END IF;
  IF v_listing.seller_id = v_user THEN RAISE EXCEPTION 'cannot_buy_own'; END IF;

  -- Deduct price from buyer
  UPDATE public.profiles
     SET coins = coins - v_listing.price
   WHERE id = v_user
     AND coins >= v_listing.price
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  -- Credit price to seller
  UPDATE public.profiles
     SET coins = coins + v_listing.price
   WHERE id = v_listing.seller_id;

  -- Settle listing
  UPDATE public.marketplace_listings
     SET status = 'settled',
         buyer_id = v_user,
         final_price = v_listing.price,
         settled_at = now()
   WHERE id = p_listing_id;

  -- Coin transaction records (if coin_transactions table exists)
  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (
      v_user,
      -v_listing.price,
      'marketplace_purchase',
      jsonb_build_object('listing_id', p_listing_id, 'title', v_listing.title)
    );
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (
      v_listing.seller_id,
      v_listing.price,
      'marketplace_sale',
      jsonb_build_object('listing_id', p_listing_id, 'title', v_listing.title, 'buyer_id', v_user)
    );
  END IF;

  RETURN json_build_object('ok', true, 'coins_left', v_coins_left);
END;
$$;

-- Place a bid on an auction listing; escrow coins, auto-refund previous leader.
DROP FUNCTION IF EXISTS public.place_marketplace_bid(uuid, integer);

CREATE OR REPLACE FUNCTION public.place_marketplace_bid(p_listing_id uuid, p_amount integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user     uuid := auth.uid();
  v_listing  public.marketplace_listings%ROWTYPE;
  v_previous public.marketplace_bids%ROWTYPE;
  v_has_previous boolean := false;
  v_required integer;
  v_min_bid  integer;
  v_coins_left integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_amount IS NULL OR p_amount < 1 THEN RAISE EXCEPTION 'bad_bid'; END IF;

  SELECT * INTO v_listing
    FROM public.marketplace_listings
   WHERE id = p_listing_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'listing_not_found'; END IF;
  IF v_listing.listing_type <> 'auction' THEN RAISE EXCEPTION 'not_auction_listing'; END IF;
  IF v_listing.status <> 'open' THEN RAISE EXCEPTION 'listing_not_open'; END IF;
  IF now() >= v_listing.ends_at THEN RAISE EXCEPTION 'auction_finished'; END IF;
  IF v_listing.seller_id = v_user THEN RAISE EXCEPTION 'cannot_bid_own'; END IF;

  SELECT * INTO v_previous
    FROM public.marketplace_bids
   WHERE listing_id = p_listing_id
     AND status = 'leading'
   ORDER BY amount DESC, created_at ASC
   LIMIT 1
   FOR UPDATE;
  v_has_previous := FOUND;

  v_min_bid := CASE
    WHEN v_has_previous THEN v_previous.amount + v_listing.min_increment
    ELSE v_listing.price
  END;
  IF p_amount < v_min_bid THEN RAISE EXCEPTION 'bid_too_low'; END IF;

  -- Incremental top-up if we're already leading
  v_required := CASE
    WHEN v_has_previous AND v_previous.bidder_id = v_user THEN p_amount - v_previous.amount
    ELSE p_amount
  END;
  IF v_required < 1 THEN RAISE EXCEPTION 'bid_too_low'; END IF;

  -- Deduct from bidder
  UPDATE public.profiles
     SET coins = coins - v_required
   WHERE id = v_user
     AND coins >= v_required
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  -- Outbid previous leader (refund if different bidder)
  IF v_has_previous THEN
    UPDATE public.marketplace_bids
       SET status = 'outbid'
     WHERE id = v_previous.id;

    IF v_previous.bidder_id <> v_user THEN
      UPDATE public.profiles
         SET coins = coins + v_previous.amount
       WHERE id = v_previous.bidder_id;

      IF to_regclass('public.coin_transactions') IS NOT NULL THEN
        INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
        VALUES (
          v_previous.bidder_id,
          v_previous.amount,
          'marketplace_outbid_refund',
          jsonb_build_object('listing_id', p_listing_id)
        );
      END IF;
    END IF;
  END IF;

  -- Insert new leading bid
  INSERT INTO public.marketplace_bids (listing_id, bidder_id, amount, status)
  VALUES (p_listing_id, v_user, p_amount, 'leading');

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (
      v_user,
      -v_required,
      'marketplace_bid_reserved',
      jsonb_build_object('listing_id', p_listing_id, 'bid_amount', p_amount)
    );
  END IF;

  RETURN json_build_object('ok', true, 'coins_left', v_coins_left, 'current_bid', p_amount);
END;
$$;

-- Settle an auction after its end time. Credits seller with winning bid.
DROP FUNCTION IF EXISTS public.settle_marketplace_listing(uuid);

CREATE OR REPLACE FUNCTION public.settle_marketplace_listing(p_listing_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_listing public.marketplace_listings%ROWTYPE;
  v_bid     public.marketplace_bids%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_listing
    FROM public.marketplace_listings
   WHERE id = p_listing_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'listing_not_found'; END IF;

  -- Idempotent: return current state if already settled/cancelled
  IF v_listing.status IN ('settled','cancelled') THEN
    RETURN json_build_object('ok', true, 'status', v_listing.status,
      'buyer_id', v_listing.buyer_id, 'final_price', v_listing.final_price);
  END IF;
  IF v_listing.listing_type <> 'auction' THEN RAISE EXCEPTION 'not_auction_listing'; END IF;
  IF now() < v_listing.ends_at THEN RAISE EXCEPTION 'auction_still_open'; END IF;

  -- Find the top leading bid
  SELECT * INTO v_bid
    FROM public.marketplace_bids
   WHERE listing_id = p_listing_id
     AND status = 'leading'
   ORDER BY amount DESC, created_at ASC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    -- No bids — cancel
    UPDATE public.marketplace_listings
       SET status = 'cancelled', settled_at = now()
     WHERE id = p_listing_id;
    RETURN json_build_object('ok', true, 'status', 'cancelled');
  END IF;

  -- Mark winning bid
  UPDATE public.marketplace_bids
     SET status = 'won'
   WHERE id = v_bid.id;

  -- Settle listing
  UPDATE public.marketplace_listings
     SET status = 'settled',
         buyer_id = v_bid.bidder_id,
         final_price = v_bid.amount,
         settled_at = now()
   WHERE id = p_listing_id;

  -- Credit seller with the escrowed winning bid
  UPDATE public.profiles
     SET coins = coins + v_bid.amount
   WHERE id = v_listing.seller_id;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (
      v_listing.seller_id,
      v_bid.amount,
      'marketplace_sale',
      jsonb_build_object('listing_id', p_listing_id, 'title', v_listing.title,
                         'buyer_id', v_bid.bidder_id)
    );
  END IF;

  RETURN json_build_object(
    'ok', true,
    'status', 'settled',
    'buyer_id', v_bid.bidder_id,
    'final_price', v_bid.amount
  );
END;
$$;

-- Cancel an open listing (seller or admin). For auctions with an active leading
-- bid, the current leader is refunded their escrowed coins. Cannot cancel a
-- listing that has already been sold/settled.
DROP FUNCTION IF EXISTS public.cancel_marketplace_listing(uuid);

CREATE OR REPLACE FUNCTION public.cancel_marketplace_listing(p_listing_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_listing public.marketplace_listings%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_listing
    FROM public.marketplace_listings
   WHERE id = p_listing_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'listing_not_found'; END IF;
  IF v_listing.seller_id <> v_user AND NOT public.is_admin(v_user) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF v_listing.status <> 'open' THEN
    RETURN json_build_object('ok', true, 'status', v_listing.status);
  END IF;
  IF v_listing.buyer_id IS NOT NULL THEN RAISE EXCEPTION 'already_sold'; END IF;

  -- Refund any outstanding leading bid before cancelling
  IF v_listing.listing_type = 'auction' THEN
    DECLARE
      v_leading public.marketplace_bids%ROWTYPE;
    BEGIN
      SELECT * INTO v_leading
        FROM public.marketplace_bids
       WHERE listing_id = p_listing_id AND status = 'leading'
       FOR UPDATE;
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

  UPDATE public.marketplace_listings
     SET status = 'cancelled', settled_at = now()
   WHERE id = p_listing_id;

  RETURN json_build_object('ok', true, 'status', 'cancelled');
END;
$$;

-- ── Grants ────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.create_marketplace_listing(text, text, text, text, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.buy_marketplace_listing(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.place_marketplace_bid(uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_marketplace_listing(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_marketplace_listing(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_marketplace_listing(text, text, text, text, integer, integer, integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.buy_marketplace_listing(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.place_marketplace_bid(uuid, integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.settle_marketplace_listing(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_marketplace_listing(uuid)
  TO authenticated;

-- ── Realtime ──────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'marketplace_listings'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_listings;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'marketplace_bids'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_bids;
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
