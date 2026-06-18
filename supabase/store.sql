-- Reward shop support for Rynek Proroctw G6.
-- Run after supabase/schema.sql. If available, run supabase/coin-transactions.sql
-- first so purchases are included in wallet history.

CREATE TABLE IF NOT EXISTS public.store_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  price       integer NOT NULL CHECK (price > 0),
  max_slots   integer NOT NULL DEFAULT 1 CHECK (max_slots > 0),
  slots_used  integer NOT NULL DEFAULT 0 CHECK (slots_used >= 0),
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (slots_used <= max_slots)
);

CREATE TABLE IF NOT EXISTS public.store_purchases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL REFERENCES public.store_items(id) ON DELETE CASCADE,
  buyer_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  price_paid   integer NOT NULL CHECK (price_paid > 0),
  purchased_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, buyer_id)
);

-- Self-heal older deployments whose store_purchases predates price_paid:
-- CREATE TABLE IF NOT EXISTS above is a no-op when the table already exists,
-- so backfill the column out-of-band and re-enforce its constraint.
ALTER TABLE public.store_purchases ADD COLUMN IF NOT EXISTS price_paid integer;
UPDATE public.store_purchases sp
   SET price_paid = COALESCE(si.price, 1)
  FROM public.store_items si
 WHERE sp.item_id = si.id AND sp.price_paid IS NULL;
UPDATE public.store_purchases SET price_paid = 1 WHERE price_paid IS NULL;
ALTER TABLE public.store_purchases ALTER COLUMN price_paid SET NOT NULL;
ALTER TABLE public.store_purchases DROP CONSTRAINT IF EXISTS store_purchases_price_paid_check;
ALTER TABLE public.store_purchases ADD CONSTRAINT store_purchases_price_paid_check CHECK (price_paid > 0);

CREATE INDEX IF NOT EXISTS store_items_active_created_idx
  ON public.store_items(is_active, created_at DESC);

CREATE INDEX IF NOT EXISTS store_purchases_item_idx
  ON public.store_purchases(item_id, purchased_at DESC);

CREATE INDEX IF NOT EXISTS store_purchases_buyer_idx
  ON public.store_purchases(buyer_id, purchased_at DESC);

ALTER TABLE public.store_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_purchases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "store_items_select" ON public.store_items;
CREATE POLICY "store_items_select" ON public.store_items
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "store_purchases_select" ON public.store_purchases;
CREATE POLICY "store_purchases_select" ON public.store_purchases
  FOR SELECT USING (true);

REVOKE ALL ON public.store_items, public.store_purchases FROM anon, authenticated;
GRANT SELECT ON public.store_items, public.store_purchases TO anon, authenticated;

DROP FUNCTION IF EXISTS public.create_store_item(text, text, integer, integer);

CREATE OR REPLACE FUNCTION public.create_store_item(
  p_title       text,
  p_description text,
  p_price       integer,
  p_slots       integer DEFAULT 1
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_item public.store_items%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.is_admin(v_user) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF length(trim(COALESCE(p_title, ''))) < 1 THEN RAISE EXCEPTION 'bad_title'; END IF;
  IF p_price IS NULL OR p_price < 1 THEN RAISE EXCEPTION 'bad_price'; END IF;
  IF p_slots IS NULL OR p_slots < 1 THEN RAISE EXCEPTION 'bad_slots'; END IF;

  INSERT INTO public.store_items (title, description, price, max_slots, created_by)
  VALUES (trim(p_title), trim(COALESCE(p_description, '')), p_price, p_slots, v_user)
  RETURNING * INTO v_item;

  RETURN json_build_object('ok', true, 'item_id', v_item.id);
END;
$$;

DROP FUNCTION IF EXISTS public.purchase_store_item(uuid);

CREATE OR REPLACE FUNCTION public.purchase_store_item(p_item_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_item public.store_items%ROWTYPE;
  v_coins_left integer;
  v_purchase_id uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_item
  FROM public.store_items
  WHERE id = p_item_id
    AND is_active = true
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF v_item.slots_used >= v_item.max_slots THEN RAISE EXCEPTION 'sold_out'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.store_purchases
    WHERE item_id = p_item_id AND buyer_id = v_user
  ) THEN
    RAISE EXCEPTION 'already_purchased';
  END IF;

  UPDATE public.profiles
     SET coins = coins - v_item.price
   WHERE id = v_user
     AND coins >= v_item.price
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  UPDATE public.store_items
     SET slots_used = slots_used + 1
   WHERE id = v_item.id
     AND slots_used < max_slots;
  IF NOT FOUND THEN RAISE EXCEPTION 'sold_out'; END IF;

  INSERT INTO public.store_purchases (item_id, buyer_id, price_paid)
  VALUES (p_item_id, v_user, v_item.price)
  RETURNING id INTO v_purchase_id;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (
      v_user,
      -v_item.price,
      'store_purchase',
      jsonb_build_object('item_id', p_item_id, 'title', v_item.title)
    );
  END IF;

  RETURN json_build_object(
    'ok', true,
    'purchase_id', v_purchase_id,
    'coins_left', v_coins_left
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_store_item(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purchase_store_item(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_store_item(text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_store_item(uuid) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'store_items'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.store_items;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'store_purchases'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.store_purchases;
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
