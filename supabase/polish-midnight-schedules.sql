-- Keep player-facing day/week boundaries on Europe/Warsaw rather than the
-- database/pg_cron UTC clock. Run after garden-water-gate.sql,
-- season-award-gating.sql, farm.sql, and farm-seasonal-contracts.sql.

-- ── Ogród Zen: the daily watering allowance resets at Warsaw 00:00 ────────

CREATE OR REPLACE FUNCTION public.water_plant_core(p_user uuid, p_slot_index integer DEFAULT 1)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user        uuid := p_user;
  v_garden      public.gardens%ROWTYPE;
  v_today       date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
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

  IF v_garden.last_watered_at IS NOT NULL
     AND v_garden.last_watered_at + interval '5 hours' > now() THEN
    RAISE EXCEPTION 'cooldown';
  END IF;

  IF v_garden.last_water_date = v_today THEN
    v_waters := v_garden.waters_today;
  ELSE
    v_waters := 0;
  END IF;
  IF v_waters >= 3 THEN RAISE EXCEPTION 'daily_limit'; END IF;

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

-- ── Weekly payouts: Monday 00:00 Europe/Warsaw, DST-safe ───────────────────

DO $$
DECLARE
  v_game text;
  v_command text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    FOREACH v_game IN ARRAY ARRAY[
      'whack_boss', 'bug_jumper', 'flappy_pants', 'snake',
      'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz',
      'popup_panic'
    ]
    LOOP
      v_command := format(
        'SELECT CASE '
        'WHEN EXTRACT(hour FROM (now() AT TIME ZONE ''Europe/Warsaw''))::integer <> 0 '
        'THEN json_build_object(''ok'', true, ''skipped'', ''not_midnight_warsaw'') '
        'WHEN public.seasonal_game_for_week(public.%I(now() - interval ''7 days'')) = %L '
        'THEN public.%I(public.%I(now() - interval ''7 days'')) '
        'ELSE json_build_object(''ok'', true, ''skipped'', ''not_in_season'') END;',
        v_game || '_week_start', v_game,
        'award_' || v_game || '_week', v_game || '_week_start'
      );
      PERFORM cron.schedule(
        v_game || '_weekly_awards',
        '0 22,23 * * 0',
        v_command
      );
    END LOOP;

    -- ⚠️ SUPERSEDED by supabase/farm-seasonal-award-reliability.sql — RE-RUN
    -- THAT FILE AFTER THIS ONE. This raw call has no deadlock retry, and the
    -- 23:00 UTC attempt is a DST gate rather than a retry, so a collision with
    -- the land-tax cron over public.farm_user_state loses a whole week's
    -- contract payout (happened for 2026-07-13 and 2026-07-27). That file
    -- repoints this job at award_farm_seasonal_week_cron() and moves the
    -- land-tax jobs off minute 0. Leaving this block as-is reverts the fix.
    PERFORM cron.schedule(
      'farm_seasonal_weekly_awards',
      '0 22,23 * * 0',
      $cron$SELECT CASE
        WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer = 0
          THEN public.award_farm_seasonal_week(public.farm_seasonal_week_start(now() - interval '7 days'))
        ELSE json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      END;$cron$
    );

    -- Expired lots are already hidden by live queries; this keeps the physical
    -- cleanup aligned with the same local-day boundary too.
    PERFORM cron.schedule(
      'farm_rot_cleanup',
      '0 22,23 * * *',
      $cron$SELECT public.farm_rot_cleanup()
        WHERE EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer = 0;$cron$
    );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
