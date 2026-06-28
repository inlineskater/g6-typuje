-- Second Garden Slot — enables users to grow a second plant after purchasing the certificate
-- Run in Supabase SQL Editor after garden.sql and garden-accessories.sql

-- ── 1. Add unlock flag to profiles ────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS second_garden_unlocked boolean NOT NULL DEFAULT false;

-- ── 2. Add slot_index to gardens ──────────────────────────────────────────

ALTER TABLE public.gardens ADD COLUMN IF NOT EXISTS slot_index integer NOT NULL DEFAULT 1;

-- Backfill any existing rows that predate the column
UPDATE public.gardens SET slot_index = 1 WHERE slot_index IS NULL OR slot_index = 0;

-- Drop old unique-on-user-id, replace with unique-on-(user_id, slot_index)
ALTER TABLE public.gardens DROP CONSTRAINT IF EXISTS gardens_user_id_key;
ALTER TABLE public.gardens ADD CONSTRAINT gardens_user_slot_key UNIQUE (user_id, slot_index);

-- ── 3. Replace create_garden — add optional p_slot_index ──────────────────

DROP FUNCTION IF EXISTS public.create_garden(text, text);

CREATE OR REPLACE FUNCTION public.create_garden(
  p_plant_type  text,
  p_plant_name  text,
  p_slot_index  integer DEFAULT 1
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_id   uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_plant_type NOT IN ('sunflower','rose','cactus','tulip','cherry','herb','tree','banana') THEN
    RAISE EXCEPTION 'bad_plant_type';
  END IF;
  IF length(trim(p_plant_name)) < 1 THEN RAISE EXCEPTION 'bad_plant_name'; END IF;
  IF p_slot_index NOT IN (1, 2)    THEN RAISE EXCEPTION 'bad_slot_index'; END IF;

  IF p_slot_index = 1 THEN
    IF EXISTS (SELECT 1 FROM public.gardens WHERE user_id = v_user AND slot_index = 1) THEN
      RAISE EXCEPTION 'already_has_garden';
    END IF;
  END IF;

  IF p_slot_index = 2 THEN
    IF NOT EXISTS (SELECT 1 FROM public.gardens WHERE user_id = v_user AND slot_index = 1) THEN
      RAISE EXCEPTION 'no_first_garden';
    END IF;
    IF NOT (SELECT second_garden_unlocked FROM public.profiles WHERE id = v_user) THEN
      RAISE EXCEPTION 'second_slot_locked';
    END IF;
    IF EXISTS (SELECT 1 FROM public.gardens WHERE user_id = v_user AND slot_index = 2) THEN
      RAISE EXCEPTION 'already_has_garden';
    END IF;
  END IF;

  INSERT INTO public.gardens (user_id, plant_type, plant_name, slot_index)
  VALUES (v_user, p_plant_type, trim(p_plant_name), p_slot_index)
  RETURNING id INTO v_id;

  RETURN json_build_object('garden_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.create_garden(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_garden(text, text, integer) TO authenticated;

-- ── 4. Replace water_plant — add p_slot_index ─────────────────────────────

DROP FUNCTION IF EXISTS public.water_plant();

CREATE OR REPLACE FUNCTION public.water_plant(p_slot_index integer DEFAULT 1)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user        uuid := auth.uid();
  v_garden      public.gardens%ROWTYPE;
  v_today       date := CURRENT_DATE;
  v_streak      integer;
  v_waters      integer;
  v_reward      integer;
  v_stage       integer;
  v_weekday_gap integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_garden
  FROM public.gardens
  WHERE user_id = v_user AND slot_index = p_slot_index
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_garden'; END IF;

  -- Cooldown check: 5 hours
  IF v_garden.last_watered_at IS NOT NULL
     AND v_garden.last_watered_at + interval '5 hours' > now() THEN
    RAISE EXCEPTION 'cooldown';
  END IF;

  -- Daily cap: reset waters_today if new day, then check < 3
  IF v_garden.last_water_date = v_today THEN
    v_waters := v_garden.waters_today;
  ELSE
    v_waters := 0;
  END IF;
  IF v_waters >= 3 THEN RAISE EXCEPTION 'daily_limit'; END IF;

  -- Streak calculation (weekends don't break streak)
  IF v_garden.last_water_date = v_today THEN
    v_streak := v_garden.streak_days;
  ELSIF v_garden.last_water_date = v_today - 1 THEN
    v_streak := v_garden.streak_days + 1;
  ELSIF v_garden.last_water_date IS NOT NULL THEN
    SELECT COUNT(*) INTO v_weekday_gap
    FROM generate_series(
      v_garden.last_water_date + 1,
      v_today - 1,
      '1 day'::interval
    ) AS d
    WHERE EXTRACT(DOW FROM d::date) NOT IN (0, 6);
    IF v_weekday_gap = 0 THEN
      v_streak := v_garden.streak_days + 1;
    ELSE
      v_streak := 1;
    END IF;
  ELSE
    v_streak := 1;
  END IF;

  v_reward := LEAST(10 + (v_streak - 1) * 2, 20);
  v_stage  := LEAST(v_streak, 6);

  UPDATE public.gardens SET
    streak_days     = v_streak,
    stage           = v_stage,
    last_water_date = v_today,
    waters_today    = v_waters + 1,
    last_watered_at = now()
  WHERE id = v_garden.id;

  UPDATE public.profiles SET coins = coins + v_reward WHERE id = v_user;

  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, v_reward, 'garden_water',
          jsonb_build_object('slot_index', p_slot_index, 'streak', v_streak, 'stage', v_stage, 'waters_today', v_waters + 1));

  RETURN json_build_object(
    'coins_earned', v_reward,
    'streak_days',  v_streak,
    'stage',        v_stage,
    'waters_today', v_waters + 1,
    'next_water_at', now() + interval '5 hours'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.water_plant(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.water_plant(integer) TO authenticated;

-- ── 5. Replace change_plant_type — add p_slot_index ───────────────────────

DROP FUNCTION IF EXISTS public.change_plant_type(text);

CREATE OR REPLACE FUNCTION public.change_plant_type(
  p_plant_type  text,
  p_slot_index  integer DEFAULT 1
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_id   uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_plant_type NOT IN ('sunflower','rose','cactus','tulip','cherry','herb','tree','banana') THEN
    RAISE EXCEPTION 'bad_plant_type';
  END IF;

  UPDATE public.gardens
     SET plant_type = p_plant_type
   WHERE user_id = v_user AND slot_index = p_slot_index
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RAISE EXCEPTION 'no_garden'; END IF;

  RETURN json_build_object('plant_type', p_plant_type);
END;
$$;

REVOKE ALL ON FUNCTION public.change_plant_type(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_plant_type(text, integer) TO authenticated;

-- ── 6. Replace purchase_accessory — add p_slot_index ──────────────────────

DROP FUNCTION IF EXISTS public.purchase_accessory(text, integer);

CREATE OR REPLACE FUNCTION public.purchase_accessory(
  p_accessory_id text,
  p_price        integer DEFAULT NULL,
  p_slot_index   integer DEFAULT 1
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_garden public.gardens%ROWTYPE;
  v_price integer;
  v_is_admin boolean := false;
  v_coins_left integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  v_price := CASE p_accessory_id
    WHEN 'flaga_pl'      THEN 10
    WHEN 'mushroom'      THEN 10
    WHEN 'ladybug'       THEN 10
    WHEN 'bee'           THEN 10
    WHEN 'butterfly'     THEN 10
    WHEN 'snail'         THEN 10
    WHEN 'frog'          THEN 10
    WHEN 'gnome'         THEN 12
    WHEN 'lantern'       THEN 11
    WHEN 'crystal'       THEN 12
    WHEN 'cat'           THEN 15
    WHEN 'star'          THEN 10
    WHEN 'zubrowka'      THEN 12
    WHEN 'piwo'          THEN 10
    WHEN 'pierogi'       THEN 11
    WHEN 'kielbasa'      THEN 11
    WHEN 'pope'          THEN 15
    WHEN 'disco_polo'    THEN 13
    WHEN 'schabowy'      THEN 11
    WHEN 'bigos'         THEN 10
    WHEN 'vodka'         THEN 12
    WHEN 'orzel'         THEN 14
    WHEN 'maluch'        THEN 15
    WHEN 'rosol'         THEN 10
    WHEN 'zapiekanka'    THEN 10
    WHEN 'lody'          THEN 10
    WHEN 'kebab'         THEN 11
    WHEN 'track_suit'    THEN 13
    WHEN 'sandal_socks'  THEN 14
    WHEN 'grill'         THEN 12
    WHEN 'taczka'        THEN 11
    WHEN 'bmw'           THEN 9999
    -- Słowiańska mitologia
    WHEN 'leszy'           THEN 18
    WHEN 'domowik'         THEN 16
    WHEN 'strzyga'         THEN 20
    WHEN 'poludnica'       THEN 19
    WHEN 'wodnik'          THEN 17
    WHEN 'rusalka'         THEN 21
    WHEN 'bies'            THEN 18
    WHEN 'licho'           THEN 16
    WHEN 'skrzat'          THEN 15
    WHEN 'zmij'            THEN 30
    WHEN 'perun'           THEN 28
    WHEN 'swarog'          THEN 26
    WHEN 'weles'           THEN 24
    WHEN 'marzanna'        THEN 17
    WHEN 'dziewanna_d'     THEN 15
    WHEN 'kikimora'        THEN 16
    WHEN 'topielec'        THEN 18
    WHEN 'latawiec_d'      THEN 17
    WHEN 'mokosz'          THEN 19
    WHEN 'czart'           THEN 18
    WHEN 'mamuna'          THEN 16
    WHEN 'planetnik'       THEN 20
    WHEN 'boruta'          THEN 25
    WHEN 'zmora'           THEN 17
    WHEN 'skarbnik'        THEN 22
    -- Staropolskie / sarmackie
    WHEN 'kontusz'         THEN 20
    WHEN 'zupan'           THEN 18
    WHEN 'karabela'        THEN 24
    WHEN 'szabla'          THEN 26
    WHEN 'husaria'         THEN 35
    WHEN 'miod_pitny'      THEN 16
    WHEN 'krupnik'         THEN 14
    WHEN 'bimber'          THEN 13
    WHEN 'oscypek'         THEN 12
    WHEN 'zurek'           THEN 12
    WHEN 'kapliczka'       THEN 18
    WHEN 'krzyz'           THEN 15
    WHEN 'bocian'          THEN 17
    WHEN 'zuraw'           THEN 16
    WHEN 'chata'           THEN 19
    WHEN 'woz'             THEN 18
    WHEN 'kosa'            THEN 17
    WHEN 'cep'             THEN 14
    WHEN 'beczka'          THEN 13
    WHEN 'samowar'         THEN 16
    WHEN 'piernik'         THEN 14
    WHEN 'makowiec'        THEN 15
    WHEN 'sledz'           THEN 12
    WHEN 'kogut'           THEN 13
    WHEN 'snopek'          THEN 12
    -- Wiedźmin / Witcher
    WHEN 'wiedzmin'        THEN 40
    WHEN 'medalion'        THEN 30
    WHEN 'srebrny_miecz'   THEN 28
    WHEN 'stalowy_miecz'   THEN 24
    WHEN 'znak_igni'       THEN 22
    WHEN 'znak_aard'       THEN 22
    WHEN 'znak_quen'       THEN 22
    WHEN 'plotka'          THEN 26
    WHEN 'jaskier'         THEN 20
    WHEN 'yennefer'        THEN 35
    WHEN 'ciri'            THEN 33
    WHEN 'triss'           THEN 30
    WHEN 'gwint'           THEN 18
    WHEN 'eliksir'         THEN 17
    WHEN 'jaskolcze'       THEN 16
    WHEN 'bestiariusz'     THEN 15
    WHEN 'kaer_morhen'     THEN 45
    WHEN 'toussaint'       THEN 20
    WHEN 'kikimora_w'      THEN 18
    WHEN 'utopiec'         THEN 17
    WHEN 'leszy_w'         THEN 22
    WHEN 'strzyga_w'       THEN 21
    WHEN 'gryf'            THEN 24
    WHEN 'bazyliszek'      THEN 26
    WHEN 'ghul'            THEN 18
    WHEN 'nilfgaard'       THEN 25
    WHEN 'geralt'          THEN 50
    WHEN 'vesemir'         THEN 28
    WHEN 'regis'           THEN 27
    WHEN 'lambert'         THEN 24
    -- Funny mix
    WHEN 'gar_smalcu'      THEN 11
    WHEN 'ogorki'          THEN 10
    WHEN 'kapelusz_grzyb'  THEN 14
    WHEN 'prawdziwki'      THEN 13
    WHEN 'wodz'            THEN 22
    WHEN 'gusla'           THEN 17
    WHEN 'dziady'          THEN 18
    WHEN 'sobotka'         THEN 19
    WHEN 'wianek'          THEN 14
    WHEN 'zarna'           THEN 12
    WHEN 'gesle'           THEN 15
    WHEN 'rogaty'          THEN 16
    WHEN 'podkowa'         THEN 13
    WHEN 'czaszka_pal'     THEN 16
    WHEN 'kruk'            THEN 15
    WHEN 'wataha'          THEN 18
    WHEN 'niedzwiedz'      THEN 20
    WHEN 'zubr'            THEN 22
    WHEN 'sokol'           THEN 17
    WHEN 'dab_bartek'      THEN 19
    ELSE NULL
  END;
  IF v_price IS NULL THEN RAISE EXCEPTION 'invalid_accessory'; END IF;

  SELECT public.is_admin(v_user) INTO v_is_admin;
  IF v_is_admin THEN v_price := 0; END IF;

  SELECT * INTO v_garden
  FROM public.gardens WHERE user_id = v_user AND slot_index = p_slot_index
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_garden'; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.gardens
    WHERE user_id = v_user
      AND p_accessory_id = ANY(accessories)
  ) THEN
    RAISE EXCEPTION 'already_owned';
  END IF;

  UPDATE public.profiles SET coins = coins - v_price WHERE id = v_user AND coins >= v_price
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  UPDATE public.gardens
    SET accessories = array_append(accessories, p_accessory_id)
  WHERE user_id = v_user AND slot_index = p_slot_index;

  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, -v_price, 'garden_accessory',
          jsonb_build_object('accessory_id', p_accessory_id, 'slot_index', p_slot_index));

  RETURN json_build_object('ok', true, 'accessory_id', p_accessory_id, 'price_paid', v_price, 'coins_left', v_coins_left);
END;
$fn$;

REVOKE ALL ON FUNCTION public.purchase_accessory(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_accessory(text, integer, integer) TO authenticated;

-- ── 7. Replace equip_accessory — add p_slot_index ─────────────────────────

DROP FUNCTION IF EXISTS public.equip_accessory(text, text);

CREATE OR REPLACE FUNCTION public.equip_accessory(
  p_slot         text,
  p_accessory_id text,
  p_slot_index   integer DEFAULT 1
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_garden public.gardens%ROWTYPE;
  v_slot text := p_slot;
  v_accessory text := nullif(p_accessory_id, '');
  v_equipped jsonb;
  v_existing_slot text;
  v_existing_value jsonb;
  v_existing_size integer := 14;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  v_slot := CASE v_slot
    WHEN 'left'  THEN '3'
    WHEN 'top'   THEN '1'
    WHEN 'right' THEN '5'
    ELSE v_slot
  END;
  IF v_slot NOT IN ('0','1','2','3','4','5','6','7','8') THEN RAISE EXCEPTION 'invalid_slot'; END IF;

  SELECT * INTO v_garden
  FROM public.gardens WHERE user_id = v_user AND slot_index = p_slot_index
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_garden'; END IF;

  IF v_accessory IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.gardens
    WHERE user_id = v_user
      AND v_accessory = ANY(accessories)
  ) THEN
    RAISE EXCEPTION 'not_owned';
  END IF;

  v_equipped := COALESCE(v_garden.equipped, '{}'::jsonb);

  IF v_accessory IS NULL THEN
    v_equipped := v_equipped - v_slot;
  ELSE
    SELECT key, value INTO v_existing_slot, v_existing_value
    FROM jsonb_each(v_equipped)
    WHERE CASE
      WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}'
      WHEN jsonb_typeof(value) = 'object' THEN value ->> 'id'
      ELSE NULL
    END = v_accessory
    LIMIT 1;

    IF v_existing_slot IS NOT NULL THEN
      IF jsonb_typeof(v_existing_value) = 'object'
         AND COALESCE(v_existing_value ->> 'size', '') ~ '^\d+$' THEN
        v_existing_size := (v_existing_value ->> 'size')::integer;
      END IF;
      v_existing_size := GREATEST(10, LEAST(34, v_existing_size));
      v_equipped := v_equipped - v_existing_slot;
    END IF;

    v_equipped := jsonb_set(
      v_equipped,
      ARRAY[v_slot],
      jsonb_build_object('id', v_accessory, 'size', v_existing_size),
      true
    );
  END IF;

  UPDATE public.gardens SET equipped = v_equipped
  WHERE user_id = v_user AND slot_index = p_slot_index;

  RETURN json_build_object('ok', true);
END;
$fn$;

REVOKE ALL ON FUNCTION public.equip_accessory(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.equip_accessory(text, text, integer) TO authenticated;

-- ── 8. Replace set_accessory_size — add p_slot_index ──────────────────────

DROP FUNCTION IF EXISTS public.set_accessory_size(text, integer);

CREATE OR REPLACE FUNCTION public.set_accessory_size(
  p_slot       text,
  p_size       integer,
  p_slot_index integer DEFAULT 1
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_garden public.gardens%ROWTYPE;
  v_slot text := p_slot;
  v_size integer;
  v_equipped jsonb;
  v_entry jsonb;
  v_accessory text;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  v_slot := CASE v_slot
    WHEN 'left'  THEN '3'
    WHEN 'top'   THEN '1'
    WHEN 'right' THEN '5'
    ELSE v_slot
  END;
  IF v_slot NOT IN ('0','1','2','3','4','5','6','7','8') THEN RAISE EXCEPTION 'invalid_slot'; END IF;
  IF p_size IS NULL THEN RAISE EXCEPTION 'invalid_accessory_size'; END IF;
  v_size := GREATEST(10, LEAST(34, p_size));

  SELECT * INTO v_garden
  FROM public.gardens WHERE user_id = v_user AND slot_index = p_slot_index
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_garden'; END IF;

  v_equipped := COALESCE(v_garden.equipped, '{}'::jsonb);
  v_entry := v_equipped -> v_slot;
  IF v_entry IS NULL THEN RAISE EXCEPTION 'no_accessory'; END IF;

  IF jsonb_typeof(v_entry) = 'string' THEN
    v_accessory := v_entry #>> '{}';
  ELSIF jsonb_typeof(v_entry) = 'object' THEN
    v_accessory := v_entry ->> 'id';
  END IF;

  IF v_accessory IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.gardens
    WHERE user_id = v_user
      AND v_accessory = ANY(accessories)
  ) THEN
    RAISE EXCEPTION 'invalid_accessory';
  END IF;

  v_equipped := jsonb_set(
    v_equipped,
    ARRAY[v_slot],
    jsonb_build_object('id', v_accessory, 'size', v_size),
    true
  );

  UPDATE public.gardens SET equipped = v_equipped
  WHERE user_id = v_user AND slot_index = p_slot_index;

  RETURN json_build_object('ok', true, 'slot', v_slot, 'size', v_size);
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_accessory_size(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_accessory_size(text, integer, integer) TO authenticated;

-- ── 9. New RPC: activate_garden_certificate ───────────────────────────────

CREATE OR REPLACE FUNCTION public.activate_garden_certificate()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user        uuid := auth.uid();
  v_price       integer := 800;
  v_coins_left  integer;
  v_item_def_id uuid;
  v_unlocked    boolean;
  v_is_admin    boolean;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT second_garden_unlocked
    INTO v_unlocked
  FROM public.profiles WHERE id = v_user;
  SELECT public.is_admin(v_user) INTO v_is_admin;

  IF v_unlocked IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_unlocked             THEN RAISE EXCEPTION 'already_unlocked'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.gardens WHERE user_id = v_user AND slot_index = 1) THEN
    RAISE EXCEPTION 'no_first_garden';
  END IF;

  IF v_is_admin THEN v_price := 0; END IF;

  UPDATE public.profiles
     SET coins = coins - v_price,
         second_garden_unlocked = true
   WHERE id = v_user AND coins >= v_price
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient'; END IF;

  SELECT id INTO v_item_def_id
  FROM public.hero_item_defs WHERE slug = 'garden_certificate' AND is_active = true
  LIMIT 1;

  IF v_item_def_id IS NOT NULL THEN
    INSERT INTO public.hero_item_instances (item_def_id, owner_id, acquired_from, origin_label)
    VALUES (v_item_def_id, v_user, 'shop', 'Sklep');
  END IF;

  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, -v_price, 'garden_certificate',
          jsonb_build_object('slot_unlocked', 2));

  RETURN json_build_object('ok', true, 'coins_left', v_coins_left);
END;
$$;

REVOKE ALL ON FUNCTION public.activate_garden_certificate() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_garden_certificate() TO authenticated;

-- ── 10. Insert garden certificate hero item def ────────────────────────────

ALTER TABLE public.hero_item_defs ALTER COLUMN effect_game DROP NOT NULL;

ALTER TABLE public.hero_item_defs DROP CONSTRAINT IF EXISTS hero_item_defs_effect_game_check;
ALTER TABLE public.hero_item_defs ADD CONSTRAINT hero_item_defs_effect_game_check
  CHECK (effect_game IS NULL OR effect_game IN ('roulette','slots','whack_boss','bug_jumper','flappy_pants','snake','invoice_horde','var_patrol','poker','tavern','global'));

INSERT INTO public.hero_item_defs (
  slug, name, emoji, slot, price, rarity, description,
  effect_game, effect_type, effect_value, sale_type, is_active
)
VALUES (
  'garden_certificate',
  '📜 Certyfikat Drugiego Ogródka',
  '📜',
  'trinket',
  800,
  'epic',
  'Pozwala posadzić drugi kwiatek i podwoić codzienne zarobki z podlewania.',
  'global',
  'extra_garden_slot',
  1,
  'shop',
  true
)
ON CONFLICT (slug) DO NOTHING;

NOTIFY pgrst, 'reload schema';
