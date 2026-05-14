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
    ELSE NULL
  END;
  IF v_price IS NULL THEN RAISE EXCEPTION 'invalid_accessory'; END IF;

  SELECT nick = 'admin' INTO v_is_admin FROM public.profiles WHERE id = v_user;
  IF v_is_admin THEN v_price := 0; END IF;

  SELECT * INTO v_garden FROM public.gardens WHERE user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_garden'; END IF;

  IF p_accessory_id = ANY(v_garden.accessories) THEN RAISE EXCEPTION 'already_owned'; END IF;

  UPDATE public.profiles SET coins = coins - v_price WHERE id = v_user AND coins >= v_price
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  UPDATE public.gardens SET accessories = array_append(accessories, p_accessory_id) WHERE user_id = v_user;

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
    SELECT key INTO v_existing_slot
    FROM jsonb_each_text(v_equipped)
    WHERE value = v_accessory
    LIMIT 1;

    IF v_existing_slot IS NOT NULL THEN
      v_equipped := v_equipped - v_existing_slot;
    END IF;

    v_equipped := jsonb_set(v_equipped, ARRAY[v_slot], to_jsonb(v_accessory), true);
  END IF;

  UPDATE public.gardens SET equipped = v_equipped WHERE user_id = v_user;

  RETURN json_build_object('ok', true);
END;
$fn$;

REVOKE ALL ON FUNCTION public.purchase_accessory(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_accessory(text, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.equip_accessory(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.equip_accessory(text, text) TO authenticated;

-- Migrate existing flag_pl owners to flaga_pl
UPDATE public.gardens
SET accessories = array_replace(accessories, 'flag_pl', 'flaga_pl')
WHERE 'flag_pl' = ANY(accessories);

UPDATE public.gardens
SET equipped = replace(equipped::text, '"flag_pl"', '"flaga_pl"')::jsonb
WHERE equipped::text LIKE '%flag_pl%';

NOTIFY pgrst, 'reload schema';
