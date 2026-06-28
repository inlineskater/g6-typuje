-- Garden accessories - cosmetic items displayed near plants
-- Run in Supabase SQL Editor after garden.sql

ALTER TABLE public.gardens ADD COLUMN IF NOT EXISTS accessories text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.gardens ADD COLUMN IF NOT EXISTS equipped jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.purchase_accessory(p_accessory_id text, p_price integer DEFAULT NULL)
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

  SELECT * INTO v_garden FROM public.gardens WHERE user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_garden'; END IF;

  IF p_accessory_id = ANY(v_garden.accessories) THEN RAISE EXCEPTION 'already_owned'; END IF;

  UPDATE public.profiles SET coins = coins - v_price WHERE id = v_user AND coins >= v_price
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  UPDATE public.gardens SET accessories = array_append(accessories, p_accessory_id) WHERE user_id = v_user;

  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, -v_price, 'garden_accessory',
          jsonb_build_object('accessory_id', p_accessory_id));

  RETURN json_build_object('ok', true, 'accessory_id', p_accessory_id, 'price_paid', v_price, 'coins_left', v_coins_left);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.equip_accessory(p_slot text, p_accessory_id text)
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

  SELECT * INTO v_garden FROM public.gardens WHERE user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_garden'; END IF;

  IF v_accessory IS NOT NULL AND NOT (v_accessory = ANY(v_garden.accessories)) THEN
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

  UPDATE public.gardens SET equipped = v_equipped WHERE user_id = v_user;

  RETURN json_build_object('ok', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.set_accessory_size(p_slot text, p_size integer)
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

  SELECT * INTO v_garden FROM public.gardens WHERE user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_garden'; END IF;

  v_equipped := COALESCE(v_garden.equipped, '{}'::jsonb);
  v_entry := v_equipped -> v_slot;
  IF v_entry IS NULL THEN RAISE EXCEPTION 'no_accessory'; END IF;

  IF jsonb_typeof(v_entry) = 'string' THEN
    v_accessory := v_entry #>> '{}';
  ELSIF jsonb_typeof(v_entry) = 'object' THEN
    v_accessory := v_entry ->> 'id';
  END IF;

  IF v_accessory IS NULL OR NOT (v_accessory = ANY(v_garden.accessories)) THEN
    RAISE EXCEPTION 'invalid_accessory';
  END IF;

  v_equipped := jsonb_set(
    v_equipped,
    ARRAY[v_slot],
    jsonb_build_object('id', v_accessory, 'size', v_size),
    true
  );

  UPDATE public.gardens SET equipped = v_equipped WHERE user_id = v_user;

  RETURN json_build_object('ok', true, 'slot', v_slot, 'size', v_size);
END;
$fn$;

REVOKE ALL ON FUNCTION public.purchase_accessory(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_accessory(text, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.equip_accessory(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.equip_accessory(text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.set_accessory_size(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_accessory_size(text, integer) TO authenticated;

-- Migrate existing flag_pl owners to flaga_pl
UPDATE public.gardens
SET accessories = array_replace(accessories, 'flag_pl', 'flaga_pl')
WHERE 'flag_pl' = ANY(accessories);

UPDATE public.gardens
SET equipped = replace(equipped::text, '"flag_pl"', '"flaga_pl"')::jsonb
WHERE equipped::text LIKE '%flag_pl%';

NOTIFY pgrst, 'reload schema';
