-- Hero items, equipment, and game-effect support.
-- Run after supabase/schema.sql and supabase/heroes.sql.

CREATE TABLE IF NOT EXISTS public.hero_item_defs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9_]+$'),
  name         text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  emoji        text NOT NULL DEFAULT '🎒',
  slot         text NOT NULL CHECK (slot IN ('head','chest','legs','hands','feet','trinket','weapon')),
  price        integer NOT NULL CHECK (price >= 0),
  rarity       text NOT NULL DEFAULT 'common' CHECK (rarity IN ('common','rare','epic','legendary')),
  description  text NOT NULL DEFAULT '',
  effect_game  text CHECK (effect_game IS NULL OR effect_game IN ('roulette','slots','whack_boss','bug_jumper','flappy_pants','poker','tavern','global')),
  effect_type  text NOT NULL,
  effect_value numeric NOT NULL DEFAULT 0,
  sale_type    text NOT NULL DEFAULT 'shop' CHECK (sale_type IN ('shop','auction','both','hidden')),
  edition_size integer CHECK (edition_size IS NULL OR edition_size > 0),
  visual_effect text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hero_item_instances (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_def_id        uuid NOT NULL REFERENCES public.hero_item_defs(id) ON DELETE RESTRICT,
  owner_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  acquired_from      text NOT NULL DEFAULT 'shop',
  origin_label       text,
  serial_no          integer CHECK (serial_no IS NULL OR serial_no > 0),
  edition_size       integer CHECK (edition_size IS NULL OR edition_size > 0),
  trade_locked_until timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hero_equipment (
  user_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  slot             text NOT NULL CHECK (slot IN ('head','chest','legs','hands','feet','trinket','weapon')),
  item_instance_id uuid NOT NULL UNIQUE REFERENCES public.hero_item_instances(id) ON DELETE CASCADE,
  equipped_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, slot)
);

CREATE INDEX IF NOT EXISTS hero_item_instances_owner_idx
  ON public.hero_item_instances(owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS hero_item_instances_def_idx
  ON public.hero_item_instances(item_def_id);

CREATE INDEX IF NOT EXISTS hero_equipment_user_idx
  ON public.hero_equipment(user_id);

ALTER TABLE public.hero_item_defs
  ADD COLUMN IF NOT EXISTS sale_type text NOT NULL DEFAULT 'shop',
  ADD COLUMN IF NOT EXISTS edition_size integer,
  ADD COLUMN IF NOT EXISTS visual_effect text;

ALTER TABLE public.hero_item_defs ALTER COLUMN effect_game DROP NOT NULL;

ALTER TABLE public.hero_item_defs DROP CONSTRAINT IF EXISTS hero_item_defs_rarity_check;
ALTER TABLE public.hero_item_defs ADD CONSTRAINT hero_item_defs_rarity_check
  CHECK (rarity IN ('common','rare','epic','legendary'));

ALTER TABLE public.hero_item_defs DROP CONSTRAINT IF EXISTS hero_item_defs_effect_game_check;
ALTER TABLE public.hero_item_defs ADD CONSTRAINT hero_item_defs_effect_game_check
  CHECK (effect_game IS NULL OR effect_game IN ('roulette','slots','whack_boss','bug_jumper','flappy_pants','poker','tavern','global'));

ALTER TABLE public.hero_item_defs DROP CONSTRAINT IF EXISTS hero_item_defs_sale_type_check;
ALTER TABLE public.hero_item_defs ADD CONSTRAINT hero_item_defs_sale_type_check
  CHECK (sale_type IN ('shop','auction','both','hidden'));

ALTER TABLE public.hero_item_defs DROP CONSTRAINT IF EXISTS hero_item_defs_edition_size_check;
ALTER TABLE public.hero_item_defs ADD CONSTRAINT hero_item_defs_edition_size_check
  CHECK (edition_size IS NULL OR edition_size > 0);

ALTER TABLE public.hero_item_instances
  ADD COLUMN IF NOT EXISTS origin_label text,
  ADD COLUMN IF NOT EXISTS serial_no integer,
  ADD COLUMN IF NOT EXISTS edition_size integer;

ALTER TABLE public.hero_item_instances DROP CONSTRAINT IF EXISTS hero_item_instances_serial_no_check;
ALTER TABLE public.hero_item_instances ADD CONSTRAINT hero_item_instances_serial_no_check
  CHECK (serial_no IS NULL OR serial_no > 0);

ALTER TABLE public.hero_item_instances DROP CONSTRAINT IF EXISTS hero_item_instances_edition_size_check;
ALTER TABLE public.hero_item_instances ADD CONSTRAINT hero_item_instances_edition_size_check
  CHECK (edition_size IS NULL OR edition_size > 0);

INSERT INTO public.hero_item_defs
  (slug, name, emoji, slot, price, rarity, description, effect_game, effect_type, effect_value, sale_type, edition_size, visual_effect, is_active)
VALUES
  ('lucky_trousers', 'Szczęśliwe Majtki', '🩳', 'legs', 450, 'rare',
   'Dają małą szansę ratunku przy przegranej w ruletce.',
   'roulette', 'win_chance_bonus', 1, 'shop', null, null, true),
  ('dealer_hat', 'Kapelusz Krupiera', '🎩', 'head', 100, 'common',
   'Delikatnie podbija wypłatę, gdy ruletka już wygra.',
   'roulette', 'payout_bonus', 1, 'shop', null, null, true),
  ('luck_brooch', 'Broszka Farta', '🍀', 'trinket', 150, 'rare',
   'Lekko zwiększa szansę na symbol G6 w slotach.',
   'slots', 'rare_symbol_bonus', 1, 'shop', null, null, true),
  ('reflex_gloves', 'Rękawice Refleksu', '🧤', 'hands', 150, 'common',
   'Dodają jeden punkt do wyniku Gry Sezonowej.',
   'whack_boss', 'score_bonus', 1, 'shop', null, null, true),
  ('jumper_boots', 'Buty Skoczka', '🥾', 'feet', 150, 'common',
   'Dodają jeden punkt do wyniku Bug Jumpera.',
   'bug_jumper', 'score_bonus', 1, 'shop', null, null, true),
  ('bluff_dagger', 'Sztylet Blefu', '🗡️', 'weapon', 300, 'epic',
   'Pozwala wejść do pokera z większym stackiem; pełny stack jest pobierany jako buy-in.',
   'poker', 'buy_in_bonus', 10, 'shop', null, null, true),
  ('g6_magnet', 'Magnes na G6', '🧲', 'trinket', 300, 'epic',
   'Mocniej przyciąga symbol G6 w slotach.',
   'slots', 'rare_symbol_bonus', 2, 'shop', null, null, false),
  ('fate_die', 'Kość Przeznaczenia', '🎲', 'trinket', 450, 'rare',
   'Daje dodatkową szansę ratunku przy przegranej w ruletce.',
   'roulette', 'win_chance_bonus', 1, 'shop', null, null, false),
  ('fortune_eye', 'Oko Fortuny', '🧿', 'head', 800, 'epic',
   'Silniejszy talizman ruletki dla hazardzistów z nerwami.',
   'roulette', 'win_chance_bonus', 2, 'shop', null, null, false),
  ('turbo_gloves', 'Rękawice Turbo', '🧤', 'hands', 300, 'rare',
   'Dodają większy bonus punktowy w Grze Sezonowej.',
   'whack_boss', 'score_bonus', 2, 'shop', null, null, false),
  ('rocket_boots', 'Buty Rakietowe', '🚀', 'feet', 300, 'rare',
   'Dodają większy bonus punktowy w Bug Jumperze.',
   'bug_jumper', 'score_bonus', 2, 'shop', null, null, false),
  ('bluff_vest', 'Kamizelka Blefu', '🛡️', 'chest', 500, 'rare',
   'Pozwala wejść do pokera z większym opłaconym stackiem.',
   'poker', 'buy_in_bonus', 15, 'shop', null, null, false),
  ('golden_bluff_dagger', 'Złoty Sztylet Blefu', '🗡️', 'weapon', 750, 'epic',
   'Najmocniejsze zwiększenie opłaconego stacka pokerowego w sklepie.',
   'poker', 'buy_in_bonus', 25, 'shop', null, null, false),
  ('tavern_king_crown', 'Korona Króla Karczmy', '👑', 'head', 1000, 'legendary',
   'Limitowana korona z królewską aurą w karczmie. Przedmiot do licytacji.',
   'tavern', 'gold_aura', 0, 'auction', 1, 'gold_aura', true),
  ('prophet_cloak', 'Płaszcz Proroka', '🧥', 'chest', 450, 'epic',
   'Efektowna peleryna dla bohatera, który lubi wejścia z dramatem.',
   'tavern', 'cloak_aura', 0, 'auction', 5, 'cloak_aura', true),
  ('whale_ring', 'Pierścień Wieloryba', '💍', 'trinket', 650, 'legendary',
   'Błyszczący symbol bogactwa widoczny w karczmie.',
   'tavern', 'coin_sparkle', 0, 'auction', 3, 'coin_sparkle', true),
  ('disco_aura', 'Disco Aura', '🪩', 'trinket', 300, 'epic',
   'Imprezowa aura do pokazania się przy stole w karczmie.',
   'tavern', 'disco_aura', 0, 'auction', 10, 'disco_aura', true),
  ('flame_boots', 'Buty Płomienia', '🔥', 'feet', 300, 'epic',
   'Mały płomienny ślad za bohaterem w karczmie.',
   'tavern', 'fire_trail', 0, 'auction', 8, 'fire_trail', true),
  ('tavern_megaphone', 'Megafon Karczmy', '📣', 'hands', 200, 'rare',
   'Przedmiot dla ludzi, których karczma ma słyszeć.',
   'tavern', 'loud_speech', 0, 'auction', 12, 'loud_speech', true)
ON CONFLICT (slug) DO UPDATE SET
  name         = EXCLUDED.name,
  emoji        = EXCLUDED.emoji,
  slot         = EXCLUDED.slot,
  price        = EXCLUDED.price,
  rarity       = EXCLUDED.rarity,
  description  = EXCLUDED.description,
  effect_game  = EXCLUDED.effect_game,
  effect_type  = EXCLUDED.effect_type,
  effect_value = EXCLUDED.effect_value,
  sale_type    = EXCLUDED.sale_type,
  edition_size = EXCLUDED.edition_size,
  visual_effect = EXCLUDED.visual_effect,
  is_active    = EXCLUDED.is_active;

ALTER TABLE public.hero_item_defs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hero_item_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hero_equipment      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hero_item_defs_select" ON public.hero_item_defs;
CREATE POLICY "hero_item_defs_select" ON public.hero_item_defs
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "hero_item_instances_select_own" ON public.hero_item_instances;
CREATE POLICY "hero_item_instances_select_own" ON public.hero_item_instances
  FOR SELECT TO authenticated USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "hero_equipment_select" ON public.hero_equipment;
CREATE POLICY "hero_equipment_select" ON public.hero_equipment
  FOR SELECT USING (true);

REVOKE ALL ON public.hero_item_defs, public.hero_item_instances, public.hero_equipment
  FROM anon, authenticated;
GRANT SELECT ON public.hero_item_defs, public.hero_equipment TO anon, authenticated;
GRANT SELECT ON public.hero_item_instances TO authenticated;

CREATE TABLE IF NOT EXISTS public.hero_item_auctions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_def_id      uuid NOT NULL REFERENCES public.hero_item_defs(id) ON DELETE RESTRICT,
  created_by       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  start_price      integer NOT NULL CHECK (start_price > 0),
  min_increment    integer NOT NULL DEFAULT 10 CHECK (min_increment > 0),
  starts_at        timestamptz NOT NULL DEFAULT now(),
  ends_at          timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','cancelled')),
  winner_id        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  winning_bid      integer,
  item_instance_id uuid REFERENCES public.hero_item_instances(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  settled_at       timestamptz,
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS public.hero_item_auction_bids (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL REFERENCES public.hero_item_auctions(id) ON DELETE CASCADE,
  bidder_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount     integer NOT NULL CHECK (amount > 0),
  status     text NOT NULL DEFAULT 'leading' CHECK (status IN ('leading','outbid','won')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hero_item_auctions_status_ends_idx
  ON public.hero_item_auctions(status, ends_at);

CREATE INDEX IF NOT EXISTS hero_item_auction_bids_auction_idx
  ON public.hero_item_auction_bids(auction_id, amount DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS hero_item_auction_bids_bidder_idx
  ON public.hero_item_auction_bids(bidder_id, created_at DESC);

ALTER TABLE public.hero_item_auctions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hero_item_auction_bids ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hero_item_auctions_select" ON public.hero_item_auctions;
CREATE POLICY "hero_item_auctions_select" ON public.hero_item_auctions
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "hero_item_auction_bids_select" ON public.hero_item_auction_bids;
CREATE POLICY "hero_item_auction_bids_select" ON public.hero_item_auction_bids
  FOR SELECT USING (true);

REVOKE ALL ON public.hero_item_auctions, public.hero_item_auction_bids
  FROM anon, authenticated;
GRANT SELECT ON public.hero_item_auctions, public.hero_item_auction_bids TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.purchase_hero_item(p_item_slug text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_def public.hero_item_defs%ROWTYPE;
  v_instance public.hero_item_instances%ROWTYPE;
  v_coins_left integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_def
    FROM public.hero_item_defs
   WHERE slug = p_item_slug
     AND is_active = true
     AND sale_type IN ('shop','both');
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;

  UPDATE public.profiles
     SET coins = coins - v_def.price
   WHERE id = v_user
     AND coins >= v_def.price
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  INSERT INTO public.hero_item_instances (item_def_id, owner_id, acquired_from)
  VALUES (v_def.id, v_user, 'shop')
  RETURNING * INTO v_instance;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (
      v_user,
      -v_def.price,
      'hero_item_purchase',
      jsonb_build_object('item_slug', v_def.slug, 'item_name', v_def.name)
    );
  END IF;

  RETURN json_build_object(
    'ok', true,
    'coins_left', v_coins_left,
    'instance_id', v_instance.id,
    'item_slug', v_def.slug
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.equip_hero_item(p_instance_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_instance public.hero_item_instances%ROWTYPE;
  v_def public.hero_item_defs%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT i.* INTO v_instance
    FROM public.hero_item_instances i
   WHERE i.id = p_instance_id
     AND i.owner_id = v_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_owned'; END IF;

  SELECT * INTO v_def
    FROM public.hero_item_defs
   WHERE id = v_instance.item_def_id
     AND is_active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_inactive'; END IF;

  DELETE FROM public.hero_equipment
   WHERE item_instance_id = p_instance_id
     AND user_id = v_user;

  INSERT INTO public.hero_equipment (user_id, slot, item_instance_id)
  VALUES (v_user, v_def.slot, p_instance_id)
  ON CONFLICT (user_id, slot) DO UPDATE SET
    item_instance_id = EXCLUDED.item_instance_id,
    equipped_at = now();

  RETURN json_build_object('ok', true, 'slot', v_def.slot, 'instance_id', p_instance_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.unequip_hero_item(p_slot text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_slot NOT IN ('head','chest','legs','hands','feet','trinket','weapon') THEN
    RAISE EXCEPTION 'bad_slot';
  END IF;

  DELETE FROM public.hero_equipment
   WHERE user_id = v_user
     AND slot = p_slot;

  RETURN json_build_object('ok', true, 'slot', p_slot);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_hero_item_auction(
  p_item_slug text,
  p_start_price integer,
  p_duration_hours integer DEFAULT 72,
  p_min_increment integer DEFAULT 10
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_def public.hero_item_defs%ROWTYPE;
  v_auction public.hero_item_auctions%ROWTYPE;
  v_duration integer := LEAST(GREATEST(COALESCE(p_duration_hours, 72), 1), 720);
  v_increment integer := LEAST(GREATEST(COALESCE(p_min_increment, 10), 1), 1000000);
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.is_admin(v_user) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_start_price IS NULL OR p_start_price < 1 THEN RAISE EXCEPTION 'bad_start_price'; END IF;

  SELECT * INTO v_def
    FROM public.hero_item_defs
   WHERE slug = p_item_slug
     AND is_active = true
     AND sale_type IN ('auction','both');
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_auctionable'; END IF;

  INSERT INTO public.hero_item_auctions
    (item_def_id, created_by, start_price, min_increment, starts_at, ends_at)
  VALUES
    (v_def.id, v_user, p_start_price, v_increment, now(), now() + (v_duration || ' hours')::interval)
  RETURNING * INTO v_auction;

  RETURN json_build_object('ok', true, 'auction_id', v_auction.id, 'ends_at', v_auction.ends_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.place_hero_item_bid(p_auction_id uuid, p_amount integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_auction public.hero_item_auctions%ROWTYPE;
  v_previous public.hero_item_auction_bids%ROWTYPE;
  v_has_previous boolean := false;
  v_required integer;
  v_min_bid integer;
  v_coins_left integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_amount IS NULL OR p_amount < 1 THEN RAISE EXCEPTION 'bad_bid'; END IF;

  SELECT * INTO v_auction
    FROM public.hero_item_auctions
   WHERE id = p_auction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'auction_not_found'; END IF;
  IF v_auction.status <> 'open' THEN RAISE EXCEPTION 'auction_not_open'; END IF;
  IF now() < v_auction.starts_at THEN RAISE EXCEPTION 'auction_not_started'; END IF;
  IF now() >= v_auction.ends_at THEN RAISE EXCEPTION 'auction_finished'; END IF;

  SELECT * INTO v_previous
    FROM public.hero_item_auction_bids
   WHERE auction_id = p_auction_id
     AND status = 'leading'
   ORDER BY amount DESC, created_at ASC
   LIMIT 1
   FOR UPDATE;
  v_has_previous := FOUND;

  v_min_bid := CASE
    WHEN v_has_previous THEN v_previous.amount + v_auction.min_increment
    ELSE v_auction.start_price
  END;
  IF p_amount < v_min_bid THEN RAISE EXCEPTION 'bid_too_low'; END IF;

  v_required := CASE
    WHEN v_has_previous AND v_previous.bidder_id = v_user THEN p_amount - v_previous.amount
    ELSE p_amount
  END;
  IF v_required < 1 THEN RAISE EXCEPTION 'bid_too_low'; END IF;

  UPDATE public.profiles
     SET coins = coins - v_required
   WHERE id = v_user
     AND coins >= v_required
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  IF v_has_previous THEN
    UPDATE public.hero_item_auction_bids
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
          'hero_auction_outbid_refund',
          jsonb_build_object('auction_id', p_auction_id)
        );
      END IF;
    END IF;
  END IF;

  INSERT INTO public.hero_item_auction_bids (auction_id, bidder_id, amount, status)
  VALUES (p_auction_id, v_user, p_amount, 'leading');

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (
      v_user,
      -v_required,
      'hero_auction_bid_reserved',
      jsonb_build_object('auction_id', p_auction_id, 'bid_amount', p_amount)
    );
  END IF;

  RETURN json_build_object('ok', true, 'coins_left', v_coins_left, 'current_bid', p_amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_hero_item_auction(p_auction_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_auction public.hero_item_auctions%ROWTYPE;
  v_def public.hero_item_defs%ROWTYPE;
  v_bid public.hero_item_auction_bids%ROWTYPE;
  v_instance public.hero_item_instances%ROWTYPE;
  v_serial integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_auction
    FROM public.hero_item_auctions
   WHERE id = p_auction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'auction_not_found'; END IF;

  IF v_auction.status = 'settled' THEN
    RETURN json_build_object('ok', true, 'status', 'settled', 'winner_id', v_auction.winner_id, 'winning_bid', v_auction.winning_bid);
  END IF;
  IF v_auction.status <> 'open' THEN
    RETURN json_build_object('ok', true, 'status', v_auction.status);
  END IF;
  IF now() < v_auction.ends_at THEN RAISE EXCEPTION 'auction_still_open'; END IF;

  SELECT * INTO v_def
    FROM public.hero_item_defs
   WHERE id = v_auction.item_def_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;

  SELECT * INTO v_bid
    FROM public.hero_item_auction_bids
   WHERE auction_id = p_auction_id
     AND status = 'leading'
   ORDER BY amount DESC, created_at ASC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.hero_item_auctions
       SET status = 'cancelled',
           settled_at = now()
     WHERE id = p_auction_id;
    RETURN json_build_object('ok', true, 'status', 'cancelled');
  END IF;

  SELECT COALESCE(MAX(serial_no), 0) + 1 INTO v_serial
    FROM public.hero_item_instances
   WHERE item_def_id = v_def.id
     AND acquired_from = 'auction';

  IF v_def.edition_size IS NOT NULL AND v_serial > v_def.edition_size THEN
    UPDATE public.hero_item_auction_bids
       SET status = 'outbid'
     WHERE id = v_bid.id;

    UPDATE public.profiles
       SET coins = coins + v_bid.amount
     WHERE id = v_bid.bidder_id;

    IF to_regclass('public.coin_transactions') IS NOT NULL THEN
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES (
        v_bid.bidder_id,
        v_bid.amount,
        'hero_auction_edition_refund',
        jsonb_build_object('auction_id', p_auction_id, 'item_slug', v_def.slug)
      );
    END IF;

    UPDATE public.hero_item_auctions
       SET status = 'cancelled',
           settled_at = now()
     WHERE id = p_auction_id;

    RETURN json_build_object(
      'ok', true,
      'status', 'cancelled',
      'reason', 'edition_sold_out',
      'refunded_bid', v_bid.amount
    );
  END IF;

  INSERT INTO public.hero_item_instances
    (item_def_id, owner_id, acquired_from, origin_label, serial_no, edition_size)
  VALUES
    (v_def.id, v_bid.bidder_id, 'auction', 'Aukcja', v_serial, v_def.edition_size)
  RETURNING * INTO v_instance;

  UPDATE public.hero_item_auction_bids
     SET status = 'won'
   WHERE id = v_bid.id;

  UPDATE public.hero_item_auctions
     SET status = 'settled',
         winner_id = v_bid.bidder_id,
         winning_bid = v_bid.amount,
         item_instance_id = v_instance.id,
         settled_at = now()
   WHERE id = p_auction_id;

  RETURN json_build_object(
    'ok', true,
    'status', 'settled',
    'winner_id', v_bid.bidder_id,
    'winning_bid', v_bid.amount,
    'instance_id', v_instance.id
  );
END;
$$;

CREATE OR REPLACE VIEW public.my_hero_inventory WITH (security_invoker = true) AS
SELECT
  i.id AS instance_id,
  i.owner_id,
  i.created_at,
  i.acquired_from,
  i.origin_label,
  i.serial_no,
  i.edition_size AS instance_edition_size,
  d.id AS item_def_id,
  d.slug,
  d.name,
  d.emoji,
  d.slot,
  d.price,
  d.rarity,
  d.description,
  d.effect_game,
  d.effect_type,
  d.effect_value,
  d.sale_type,
  d.visual_effect,
  (e.item_instance_id IS NOT NULL) AS equipped
FROM public.hero_item_instances i
JOIN public.hero_item_defs d ON d.id = i.item_def_id
LEFT JOIN public.hero_equipment e ON e.item_instance_id = i.id
WHERE i.owner_id = auth.uid();

CREATE OR REPLACE VIEW public.public_hero_equipment AS
SELECT
  e.user_id,
  e.slot,
  e.item_instance_id,
  e.equipped_at,
  i.acquired_from,
  i.origin_label,
  i.serial_no,
  i.edition_size AS instance_edition_size,
  d.slug,
  d.name,
  d.emoji,
  d.rarity,
  d.description,
  d.effect_game,
  d.effect_type,
  d.effect_value,
  d.sale_type,
  d.visual_effect
FROM public.hero_equipment e
JOIN public.hero_item_instances i ON i.id = e.item_instance_id
JOIN public.hero_item_defs d ON d.id = i.item_def_id
WHERE i.owner_id = e.user_id
  AND d.is_active = true;

CREATE OR REPLACE VIEW public.hero_item_auction_cards AS
SELECT
  a.id,
  a.item_def_id,
  d.slug,
  d.name,
  d.emoji,
  d.slot,
  d.rarity,
  d.description,
  d.effect_game,
  d.effect_type,
  d.effect_value,
  d.edition_size,
  d.visual_effect,
  a.start_price,
  a.min_increment,
  a.starts_at,
  a.ends_at,
  a.status,
  a.winner_id,
  wp.nick AS winner_nick,
  a.winning_bid,
  a.item_instance_id,
  a.created_at,
  COALESCE(a.winning_bid, hb.amount) AS current_bid,
  COALESCE(a.winner_id, hb.bidder_id) AS current_bidder_id,
  bp.nick AS current_bidder_nick,
  CASE
    WHEN a.status = 'open' AND hb.amount IS NOT NULL THEN hb.amount + a.min_increment
    WHEN a.status = 'open' THEN a.start_price
    ELSE NULL
  END AS next_min_bid,
  tb.top_bidders
FROM public.hero_item_auctions a
JOIN public.hero_item_defs d ON d.id = a.item_def_id
LEFT JOIN LATERAL (
  SELECT b.bidder_id, b.amount
    FROM public.hero_item_auction_bids b
   WHERE b.auction_id = a.id
     AND b.status IN ('leading','won')
   ORDER BY b.amount DESC, b.created_at ASC
   LIMIT 1
) hb ON true
LEFT JOIN public.profiles bp ON bp.id = hb.bidder_id
LEFT JOIN public.profiles wp ON wp.id = a.winner_id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object('nick', p.nick, 'amount', top.max_amount)
    ORDER BY top.max_amount DESC
  ) AS top_bidders
  FROM (
    SELECT b.bidder_id, MAX(b.amount) AS max_amount
    FROM public.hero_item_auction_bids b
    WHERE b.auction_id = a.id
    GROUP BY b.bidder_id
    ORDER BY max_amount DESC
    LIMIT 3
  ) top
  JOIN public.profiles p ON p.id = top.bidder_id
) tb ON true
WHERE a.status = 'open'
   OR a.created_at > now() - interval '14 days';

GRANT SELECT ON public.my_hero_inventory TO authenticated;
GRANT SELECT ON public.public_hero_equipment TO anon, authenticated;
GRANT SELECT ON public.hero_item_auction_cards TO anon, authenticated;

REVOKE ALL ON FUNCTION public.purchase_hero_item(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.equip_hero_item(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unequip_hero_item(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_hero_item_auction(text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.place_hero_item_bid(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_hero_item_auction(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.purchase_hero_item(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.equip_hero_item(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unequip_hero_item(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_hero_item_auction(text, integer, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.place_hero_item_bid(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.settle_hero_item_auction(uuid) TO authenticated;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.hero_item_instances;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.hero_equipment;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.hero_item_auctions;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.hero_item_auction_bids;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
