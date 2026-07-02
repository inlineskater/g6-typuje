-- Garden watering anti-automation gate ("arm-nonce")
-- Run in Supabase SQL Editor AFTER garden.sql + second-garden-slot.sql.
-- Idempotent (CREATE ... IF NOT EXISTS / CREATE OR REPLACE / REVOKE).
--
-- WHY: the public anon key + a player's own valid token + the directly-callable
-- water_plant() RPC let a cron script (curl POST /rest/v1/rpc/water_plant) farm
-- the daily watering reward without ever opening the site. This routes watering
-- through the garden-action Edge Function instead:
--   1. the browser "arms" → the function issues a single-use, ~120s nonce only to
--      a live, JWT-authenticated client (stored here, no client read/write),
--   2. the browser "waters" with that nonce → the function consumes it and calls
--      water_plant_core() over its service connection.
-- The legacy water_plant(integer) RPC is REVOKEd from clients, so a bare REST call
-- to it now fails — the current script breaks. (A determined scripter can replay
-- arm→water; this raises the bar and is the chokepoint to add stricter checks.)
--
-- Server rules are unchanged and still authoritative: 5h cooldown + 3 waters/day
-- per slot, streak/reward math — all live in water_plant_core below.

-- ── One-time, single-use watering nonces (server-owned; no client grants) ────
CREATE TABLE IF NOT EXISTS public.garden_water_nonces (
  nonce      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX IF NOT EXISTS garden_water_nonces_user_idx ON public.garden_water_nonces(user_id, expires_at);

ALTER TABLE public.garden_water_nonces ENABLE ROW LEVEL SECURITY;
-- No policies + no grants → clients cannot read or write. Only the Edge Function's
-- service connection (which bypasses RLS) touches this table.
REVOKE ALL ON public.garden_water_nonces FROM anon, authenticated;

-- ── Live-presence heartbeat (server-owned; no client grants) ─────────────────
-- The browser pings garden-action {action:'ping'} every ~30s while the Ogródek
-- tab is open and visible; watering then requires a ping within the last ~90s.
-- A headless cron sends no heartbeats, so it can't water at all — to bot it you'd
-- have to keep a real, visible session alive, which is the whole point.
CREATE TABLE IF NOT EXISTS public.garden_presence (
  user_id   uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_seen timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.garden_presence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.garden_presence FROM anon, authenticated;

-- ── water_plant_core(user, slot): the real watering logic, user passed in ────
-- Identical rules to the old water_plant(integer) but takes the caller explicitly
-- (the Edge Function has already validated the JWT). REVOKEd from every client
-- role; only the definer/service connection invokes it.
CREATE OR REPLACE FUNCTION public.water_plant_core(p_user uuid, p_slot_index integer DEFAULT 1)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user        uuid := p_user;
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

  v_reward := LEAST(15 + (v_streak - 1) * 3, 30);
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
          jsonb_build_object('slot_index', p_slot_index, 'streak', v_streak, 'stage', v_stage,
                             'waters_today', v_waters + 1, 'via', 'gate'));

  RETURN json_build_object(
    'coins_earned', v_reward,
    'streak_days',  v_streak,
    'stage',        v_stage,
    'waters_today', v_waters + 1,
    'next_water_at', now() + interval '5 hours'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.water_plant_core(uuid, integer) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- STEP 2 — RUN THIS ONLY AFTER the garden-action function is deployed AND the new
-- index.html is live. It closes the direct path: the script's bare
-- POST /rest/v1/rpc/water_plant starts failing, and the ONLY watering path becomes
-- the Edge Function. Running it earlier would break watering for everyone until
-- the new frontend ships. (Everything above is safe to run anytime — it only adds
-- new objects and leaves the old RPC working.)
-- ════════════════════════════════════════════════════════════════════════════
--
--   REVOKE ALL ON FUNCTION public.water_plant(integer) FROM PUBLIC, anon, authenticated;
--   NOTIFY pgrst, 'reload schema';
