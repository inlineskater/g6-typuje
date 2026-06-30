-- Farma anti-hoarding balance patch.
-- Run this on prod instead of rerunning farm.sql; it only replaces the affected
-- RPCs and does not reseed card definitions or market prices.

BEGIN;

ALTER TABLE public.farm_tiles ADD COLUMN IF NOT EXISTS asset_value integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE public.farm_tiles
    ADD CONSTRAINT farm_tiles_asset_value_chk CHECK (asset_value >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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

  SELECT count(*) INTO v_tiles FROM public.farm_tiles WHERE owner_id = v_user;
  v_price := least(50000::numeric, floor(350::numeric * power(2::numeric, v_tiles)))::integer;

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

CREATE OR REPLACE FUNCTION public.open_farm_lootbox()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_draws     constant integer := 3;
  v_voucher_p constant numeric := 0.07;
  v_coins     integer;
  v_boxes     integer;
  v_vouchers  integer := 0;
  v_tiles     integer := 0;
  v_territory integer := 0;
  v_owned_nfts integer := 0;
  v_eff_voucher_p numeric := 0;
  v_got_vch   boolean := false;
  v_starter   integer := 0;
  v_guar      boolean := false;
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
  v_minted    integer;
  v_serial    integer;
  v_nft_idx   integer;
  v_nft_name  text;
  v_nft_id    uuid;
  v_picked    text[] := ARRAY[]::text[];
  v_cards     jsonb  := '[]'::jsonb;
  v_card      jsonb;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  UPDATE public.farm_user_state SET boxes = boxes - 1
   WHERE user_id = v_user AND boxes >= 1
  RETURNING boxes, tile_vouchers, starter_opens_left, guaranteed_voucher
       INTO v_boxes, v_vouchers, v_starter, v_guar;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_box'; END IF;
  SELECT coins INTO v_coins FROM public.profiles WHERE id = v_user;
  SELECT count(*) INTO v_owned_nfts FROM public.farm_nft_instances WHERE owner_id = v_user;
  SELECT count(*) INTO v_tiles FROM public.farm_tiles WHERE owner_id = v_user;
  v_territory := v_tiles + COALESCE(v_vouchers, 0);
  v_eff_voucher_p := v_voucher_p / power(3::numeric, greatest(v_territory, 0));

  SELECT count(*) INTO v_eligible
    FROM public.farm_card_defs d
   WHERE d.is_active AND d.draw_weight > 0
     AND (d.edition_size IS NULL
          OR (SELECT count(*) FROM public.farm_nft_instances ni WHERE ni.species = d.species) < d.edition_size);
  IF v_eligible = 0 THEN RAISE EXCEPTION 'pool_empty'; END IF;
  v_target := least(v_draws, v_eligible);

  WHILE v_got < v_target AND v_attempts < 40 LOOP
    v_attempts := v_attempts + 1;

    SELECT sum(CASE WHEN d.edition_size IS NOT NULL
                    THEN d.draw_weight::numeric / power(3::numeric, v_owned_nfts)
                    ELSE d.draw_weight::numeric END)
      INTO v_total
      FROM public.farm_card_defs d
     WHERE d.is_active AND d.draw_weight > 0 AND d.species <> ALL(v_picked)
       AND (d.edition_size IS NULL
            OR (SELECT count(*) FROM public.farm_nft_instances ni WHERE ni.species = d.species) < d.edition_size);
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
         AND (d.edition_size IS NULL
              OR (SELECT count(*) FROM public.farm_nft_instances ni WHERE ni.species = d.species) < d.edition_size)
    ) q
    WHERE q.cum > v_roll
    ORDER BY q.cum
    LIMIT 1;
    EXIT WHEN v_species IS NULL;

    SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_species FOR UPDATE;
    v_picked := array_append(v_picked, v_species);

    IF v_def.edition_size IS NOT NULL THEN
      SELECT count(*) INTO v_minted FROM public.farm_nft_instances WHERE species = v_species;
      IF v_minted >= v_def.edition_size THEN
        CONTINUE;
      END IF;
      v_serial := v_minted + 1;
      SELECT count(*) INTO v_nft_idx FROM public.farm_nft_instances ni
       WHERE public.farm_nft_pool(ni.species) = public.farm_nft_pool(v_species);
      v_nft_name := public.farm_nft_persona(v_species, v_nft_idx);
      INSERT INTO public.farm_nft_instances (species, serial_no, edition_size, owner_id, acquired_from, nft_name)
      VALUES (v_species, v_serial, v_def.edition_size, v_user, 'lootbox', v_nft_name)
      RETURNING id INTO v_nft_id;
      IF to_regclass('public.farm_nft_transfers') IS NOT NULL THEN
        INSERT INTO public.farm_nft_transfers (instance_id, species, serial_no, from_owner, to_owner, price, kind)
        VALUES (v_nft_id, v_species, v_serial, NULL, v_user, NULL, 'mint');
      END IF;
      v_owned_nfts := v_owned_nfts + 1;
    END IF;

    INSERT INTO public.farm_collection (user_id, species, count, level)
    VALUES (v_user, v_species, 1, 1)
    ON CONFLICT (user_id, species) DO UPDATE SET count = farm_collection.count + 1
    RETURNING count INTO v_new_count;

    v_card := jsonb_build_object(
      'species', v_species, 'name', v_def.name, 'emoji', v_def.emoji,
      'rarity', v_def.rarity, 'new_count', v_new_count);
    IF v_def.edition_size IS NOT NULL THEN
      v_card := v_card || jsonb_build_object('nft', true, 'id', v_nft_id, 'serial_no', v_serial, 'edition_size', v_def.edition_size, 'nft_name', v_nft_name);
    END IF;
    v_cards := v_cards || v_card;
    v_got := v_got + 1;
  END LOOP;

  IF v_guar AND v_territory > 0 THEN v_guar := false; END IF;
  IF v_starter > 0 THEN v_starter := v_starter - 1; END IF;
  v_drop_vch := (random() < v_eff_voucher_p) OR (v_guar AND v_starter = 0);
  IF v_drop_vch AND v_guar THEN v_guar := false; END IF;

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

REVOKE ALL ON FUNCTION public.buy_farm_tile(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_farm_lootbox() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buy_farm_tile(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_farm_lootbox() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
