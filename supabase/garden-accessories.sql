-- Garden accessories - cosmetic items displayed near plants
-- Run in Supabase SQL Editor after garden.sql

ALTER TABLE public.gardens ADD COLUMN IF NOT EXISTS accessories text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.gardens ADD COLUMN IF NOT EXISTS equipped jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.purchase_accessory(p_accessory_id text, p_price integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_garden public.gardens%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_price < 0 THEN RAISE EXCEPTION 'invalid_price'; END IF;

  SELECT * INTO v_garden FROM public.gardens WHERE user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_garden'; END IF;

  IF p_accessory_id = ANY(v_garden.accessories) THEN RAISE EXCEPTION 'already_owned'; END IF;

  UPDATE public.profiles SET coins = coins - p_price WHERE id = v_user AND coins >= p_price;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  UPDATE public.gardens SET accessories = array_append(accessories, p_accessory_id) WHERE user_id = v_user;

  RETURN json_build_object('ok', true, 'accessory_id', p_accessory_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.equip_accessory(p_slot text, p_accessory_id text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_garden public.gardens%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_slot NOT IN ('left','right','top') THEN RAISE EXCEPTION 'invalid_slot'; END IF;

  SELECT * INTO v_garden FROM public.gardens WHERE user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_garden'; END IF;

  IF p_accessory_id IS NOT NULL AND p_accessory_id != '' AND NOT (p_accessory_id = ANY(v_garden.accessories)) THEN
    RAISE EXCEPTION 'not_owned';
  END IF;

  IF p_accessory_id IS NULL OR p_accessory_id = '' THEN
    UPDATE public.gardens SET equipped = equipped - p_slot WHERE user_id = v_user;
  ELSE
    UPDATE public.gardens SET equipped = jsonb_set(equipped, ARRAY[p_slot], to_jsonb(p_accessory_id)) WHERE user_id = v_user;
  END IF;

  RETURN json_build_object('ok', true);
END;
$fn$;

REVOKE ALL ON FUNCTION public.purchase_accessory(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_accessory(text, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.equip_accessory(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.equip_accessory(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
