-- Garden accessories - cosmetic items displayed near plants
-- Run in Supabase SQL Editor after garden.sql

ALTER TABLE public.gardens ADD COLUMN IF NOT EXISTS accessories text[] NOT NULL DEFAULT '{}';

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

REVOKE ALL ON FUNCTION public.purchase_accessory(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_accessory(text, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
