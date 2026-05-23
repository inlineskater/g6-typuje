-- Heroes & Tavern — cosmetic character system
-- Run in Supabase SQL Editor after schema.sql

CREATE TABLE public.user_heroes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid UNIQUE NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  hero_name    text NOT NULL CHECK (length(trim(hero_name)) BETWEEN 1 AND 32),
  skin_tone    text NOT NULL DEFAULT 'medium'  CHECK (skin_tone    IN ('light','medium','tan','dark')),
  hair_style   text NOT NULL DEFAULT 'short'   CHECK (hair_style   IN ('bald','short','medium','long','curly')),
  hair_color   text NOT NULL DEFAULT 'brown'   CHECK (hair_color   IN ('brown','black','blonde','red','gray','white')),
  beard        text NOT NULL DEFAULT 'none'    CHECK (beard        IN ('none','stubble','goatee','full')),
  body_shape   text NOT NULL DEFAULT 'average' CHECK (body_shape   IN ('slim','average','stocky')),
  outfit       text NOT NULL DEFAULT 'tunic'   CHECK (outfit       IN ('tunic','armor','robe','cloak')),
  outfit_color text NOT NULL DEFAULT 'blue'    CHECK (outfit_color IN ('blue','red','green','purple','gray')),
  weapon       text NOT NULL DEFAULT 'fists'   CHECK (weapon       IN ('sword','axe','staff','bow','fists')),
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX user_heroes_user_id_idx ON public.user_heroes(user_id);

ALTER TABLE public.user_heroes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "heroes_select" ON public.user_heroes FOR SELECT USING (true);
CREATE POLICY "heroes_insert" ON public.user_heroes FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "heroes_update" ON public.user_heroes FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "heroes_delete" ON public.user_heroes FOR DELETE USING (user_id = auth.uid());
GRANT SELECT ON public.user_heroes TO anon, authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE public.user_heroes;

CREATE OR REPLACE FUNCTION public.save_hero(
  p_hero_name    text,
  p_skin_tone    text,
  p_hair_style   text,
  p_hair_color   text,
  p_beard        text,
  p_body_shape   text,
  p_outfit       text,
  p_outfit_color text,
  p_weapon       text
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF length(trim(p_hero_name)) < 1  THEN RAISE EXCEPTION 'bad_hero_name'; END IF;
  IF length(trim(p_hero_name)) > 32 THEN RAISE EXCEPTION 'hero_name_too_long'; END IF;
  IF p_skin_tone    NOT IN ('light','medium','tan','dark')                     THEN RAISE EXCEPTION 'bad_skin_tone'; END IF;
  IF p_hair_style   NOT IN ('bald','short','medium','long','curly')            THEN RAISE EXCEPTION 'bad_hair_style'; END IF;
  IF p_hair_color   NOT IN ('brown','black','blonde','red','gray','white')     THEN RAISE EXCEPTION 'bad_hair_color'; END IF;
  IF p_beard        NOT IN ('none','stubble','goatee','full')                  THEN RAISE EXCEPTION 'bad_beard'; END IF;
  IF p_body_shape   NOT IN ('slim','average','stocky')                         THEN RAISE EXCEPTION 'bad_body_shape'; END IF;
  IF p_outfit       NOT IN ('tunic','armor','robe','cloak')                    THEN RAISE EXCEPTION 'bad_outfit'; END IF;
  IF p_outfit_color NOT IN ('blue','red','green','purple','gray')              THEN RAISE EXCEPTION 'bad_outfit_color'; END IF;
  IF p_weapon       NOT IN ('sword','axe','staff','bow','fists')               THEN RAISE EXCEPTION 'bad_weapon'; END IF;

  INSERT INTO public.user_heroes
    (user_id, hero_name, skin_tone, hair_style, hair_color,
     beard, body_shape, outfit, outfit_color, weapon, updated_at)
  VALUES
    (v_user, trim(p_hero_name), p_skin_tone, p_hair_style, p_hair_color,
     p_beard, p_body_shape, p_outfit, p_outfit_color, p_weapon, now())
  ON CONFLICT (user_id) DO UPDATE SET
    hero_name    = EXCLUDED.hero_name,
    skin_tone    = EXCLUDED.skin_tone,
    hair_style   = EXCLUDED.hair_style,
    hair_color   = EXCLUDED.hair_color,
    beard        = EXCLUDED.beard,
    body_shape   = EXCLUDED.body_shape,
    outfit       = EXCLUDED.outfit,
    outfit_color = EXCLUDED.outfit_color,
    weapon       = EXCLUDED.weapon,
    updated_at   = now();

  RETURN json_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.save_hero(text,text,text,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_hero(text,text,text,text,text,text,text,text,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
