-- Ogródek (Garden) — plant growing mini-game
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run)

-- ── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE public.gardens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid UNIQUE NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  plant_type      text NOT NULL CHECK (plant_type IN ('sunflower','rose','cactus','tulip','cherry','herb','tree','banana','palm')),
  plant_name      text NOT NULL,
  stage           integer NOT NULL DEFAULT 1,
  streak_days     integer NOT NULL DEFAULT 0,
  last_water_date date,
  waters_today    integer NOT NULL DEFAULT 0,
  last_watered_at timestamptz,
  created_at      timestamptz DEFAULT now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX gardens_user_id_idx ON public.gardens(user_id);

-- ── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.gardens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gardens_select" ON public.gardens FOR SELECT USING (true);

GRANT SELECT ON public.gardens TO anon, authenticated;

-- ── Realtime ───────────────────────────────────────────────────────────────

ALTER PUBLICATION supabase_realtime ADD TABLE public.gardens;

-- ── RPC: create_garden ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_garden(p_plant_type text, p_plant_name text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_id   uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_plant_type NOT IN ('sunflower','rose','cactus','tulip','cherry','herb','tree','banana') THEN RAISE EXCEPTION 'bad_plant_type'; END IF;
  IF length(trim(p_plant_name)) < 1 THEN RAISE EXCEPTION 'bad_plant_name'; END IF;
  IF EXISTS (SELECT 1 FROM public.gardens WHERE user_id = v_user) THEN RAISE EXCEPTION 'already_has_garden'; END IF;

  INSERT INTO public.gardens (user_id, plant_type, plant_name)
  VALUES (v_user, p_plant_type, trim(p_plant_name))
  RETURNING id INTO v_id;

  RETURN json_build_object('garden_id', v_id);
END;
$$;

-- ── RPC: water_plant ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.water_plant()
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

  SELECT * INTO v_garden FROM public.gardens WHERE user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_garden'; END IF;

  -- Cooldown check: 5 hours
  IF v_garden.last_watered_at IS NOT NULL AND v_garden.last_watered_at + interval '5 hours' > now() THEN
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
    v_streak := v_garden.streak_days;           -- same day, keep streak
  ELSIF v_garden.last_water_date = v_today - 1 THEN
    v_streak := v_garden.streak_days + 1;       -- consecutive day
  ELSIF v_garden.last_water_date IS NOT NULL THEN
    -- Count Mon–Fri days in the gap; if only weekend days were skipped, streak survives
    SELECT COUNT(*) INTO v_weekday_gap
    FROM generate_series(
      v_garden.last_water_date + 1,
      v_today - 1,
      '1 day'::interval
    ) AS d
    WHERE EXTRACT(DOW FROM d::date) NOT IN (0, 6); -- 0=Sun, 6=Sat
    IF v_weekday_gap = 0 THEN
      v_streak := v_garden.streak_days + 1;     -- gap was only weekend days
    ELSE
      v_streak := 1;                            -- missed at least one weekday
    END IF;
  ELSE
    v_streak := 1;                              -- first watering ever
  END IF;

  -- Reward: 10 + (streak-1)*2, capped at 20
  v_reward := LEAST(10 + (v_streak - 1) * 2, 20);

  -- Stage: matches streak days, capped at 6
  v_stage := LEAST(v_streak, 6);

  -- Update garden
  UPDATE public.gardens SET
    streak_days     = v_streak,
    stage           = v_stage,
    last_water_date = v_today,
    waters_today    = v_waters + 1,
    last_watered_at = now()
  WHERE id = v_garden.id;

  -- Credit coins
  UPDATE public.profiles SET coins = coins + v_reward WHERE id = v_user;

  RETURN json_build_object(
    'coins_earned', v_reward,
    'streak_days',  v_streak,
    'stage',        v_stage,
    'waters_today', v_waters + 1,
    'next_water_at', now() + interval '5 hours'
  );
END;
$$;

-- ── RPC: change_plant_type ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.change_plant_type(p_plant_type text)
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
   WHERE user_id = v_user
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RAISE EXCEPTION 'no_garden'; END IF;

  RETURN json_build_object('plant_type', p_plant_type);
END;
$$;

-- ── Grants ─────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.create_garden(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.water_plant() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.change_plant_type(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_garden(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.water_plant() TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_plant_type(text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ── Cleanup for existing deployments ───────────────────────────────────────
-- If your Supabase already has the old admire pieces, run this once to drop them:
--
--   DROP FUNCTION IF EXISTS public.admire_garden(uuid);
--   DROP TABLE    IF EXISTS public.garden_admires;
