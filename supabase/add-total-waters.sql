-- Garden: track lifetime waterings (total_waters) so plant size reflects all-time care,
-- separate from streak_days (consecutive days). Run in Supabase SQL Editor. Idempotent.

-- ── 1. Column ──────────────────────────────────────────────────────────────

ALTER TABLE public.gardens
  ADD COLUMN IF NOT EXISTS total_waters integer NOT NULL DEFAULT 0;

-- ── 2. Backfill from historical garden_water coin transactions ─────────────
-- Each watering inserts a coin_transactions row (reason='garden_water'); legacy
-- rows have no slot_index in meta and are treated as slot 1.

UPDATE public.gardens g
SET total_waters = sub.cnt
FROM (
  SELECT user_id,
         COALESCE((meta->>'slot_index')::int, 1) AS slot,
         COUNT(*)::int AS cnt
  FROM public.coin_transactions
  WHERE reason = 'garden_water'
  GROUP BY user_id, COALESCE((meta->>'slot_index')::int, 1)
) sub
WHERE sub.user_id = g.user_id
  AND sub.slot = g.slot_index;

-- ── 3. Replace water_plant — increment total_waters and return it ──────────

DROP FUNCTION IF EXISTS public.water_plant(integer);

CREATE OR REPLACE FUNCTION public.water_plant(p_slot_index integer DEFAULT 1)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user        uuid := auth.uid();
  v_garden      public.gardens%ROWTYPE;
  v_today       date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_streak      integer;
  v_waters      integer;
  v_total       integer;
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
  v_total  := COALESCE(v_garden.total_waters, 0) + 1;

  UPDATE public.gardens SET
    streak_days     = v_streak,
    stage           = v_stage,
    last_water_date = v_today,
    waters_today    = v_waters + 1,
    total_waters    = v_total,
    last_watered_at = now()
  WHERE id = v_garden.id;

  UPDATE public.profiles SET coins = coins + v_reward WHERE id = v_user;

  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, v_reward, 'garden_water',
          jsonb_build_object('slot_index', p_slot_index, 'streak', v_streak, 'stage', v_stage,
                             'waters_today', v_waters + 1, 'total_waters', v_total));

  RETURN json_build_object(
    'coins_earned',  v_reward,
    'streak_days',   v_streak,
    'stage',         v_stage,
    'waters_today',  v_waters + 1,
    'total_waters',  v_total,
    'next_water_at', now() + interval '5 hours'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.water_plant(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.water_plant(integer) TO authenticated;
