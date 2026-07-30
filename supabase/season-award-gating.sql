-- Season-gate the weekly award cron jobs.
--
-- Problem: all seasonal award_*_week() pg_cron jobs fire every Monday, regardless
-- of which game was actually in season that week. The Edge Functions accept
-- rounds for any game in any week, so a few off-season rounds (e.g. someone
-- opening Whack-a-Boss during a Bug Jumper week) would trigger a full
-- 100/50/25 payout for a game nobody was competing in.
--
-- Fix: seasonal_game_for_week() mirrors SEASONAL_ANCHOR_WEEK_START,
-- SEASONAL_ROTATION, and SEASONAL_OVERRIDES from index.html, and each cron
-- job only calls its award function when its game was in season.
--
-- ⚠️ Keep this function in sync with the rotation constants in index.html.
--    If you add a SEASONAL_OVERRIDES entry or change the rotation there,
--    update the CASE below and re-run this file.
--
-- Idempotent; paste into the Supabase SQL Editor → Run.

CREATE OR REPLACE FUNCTION public.seasonal_game_for_week(p_week_start date)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_week_start::text
    -- SEASONAL_OVERRIDES
    WHEN '2026-06-08' THEN 'bug_jumper'  -- Bug Jumper: Hard Course
    WHEN '2026-06-15' THEN 'snake'
    WHEN '2026-06-22' THEN 'var_patrol'  -- VAR Patrol debut
    WHEN '2026-06-29' THEN 'invoice_horde'  -- Najazd Ticketów
    WHEN '2026-07-06' THEN 'egg_catch'  -- Łap Jajka debut
    WHEN '2026-07-13' THEN 'super_mariusz'  -- Super Mariusz debut
    WHEN '2026-07-20' THEN 'popup_panic'  -- Zamknij Popupy! debut
    WHEN '2026-07-27' THEN 'tetris'  -- Tetris G6 debut
    WHEN '2026-08-03' THEN 'bug_jumper'  -- Bug Jumper: Dynamic Course relaunch (pushed a week by the Tetris debut)
    WHEN '2026-08-10' THEN 'healer_dungeon'  -- Uzdrowiciel G6 debut
    -- SEASONAL_ROTATION from its 2026-05-18 Monday anchor.
    ELSE
      (ARRAY[
        'whack_boss','bug_jumper','flappy_pants','snake','invoice_horde',
        'var_patrol','egg_catch','super_mariusz','popup_panic','tetris','healer_dungeon'
      ])[
        (GREATEST(0, (p_week_start - DATE '2026-05-18') / 7) % 11) + 1
      ]
  END;
$$;

-- pg_cron runs in UTC/GMT. Warsaw midnight is 22:00 UTC in summer and
-- 23:00 UTC in winter, so each job tries both and the first CASE arm keeps
-- only the invocation that lands at local 00:00.
-- cron.schedule() with an existing jobname replaces that job's command.
SELECT cron.schedule(
  'whack_boss_weekly_awards',
  '0 22,23 * * 0',
  $$SELECT CASE WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
      THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      WHEN public.seasonal_game_for_week(public.whack_boss_week_start(now() - interval '7 days')) = 'whack_boss'
      THEN public.award_whack_boss_week(public.whack_boss_week_start(now() - interval '7 days'))
      ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$$
);

SELECT cron.schedule(
  'bug_jumper_weekly_awards',
  '0 22,23 * * 0',
  $$SELECT CASE WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
      THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      WHEN public.seasonal_game_for_week(public.bug_jumper_week_start(now() - interval '7 days')) = 'bug_jumper'
      THEN public.award_bug_jumper_week(public.bug_jumper_week_start(now() - interval '7 days'))
      ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$$
);

SELECT cron.schedule(
  'flappy_pants_weekly_awards',
  '0 22,23 * * 0',
  $$SELECT CASE WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
      THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      WHEN public.seasonal_game_for_week(public.flappy_pants_week_start(now() - interval '7 days')) = 'flappy_pants'
      THEN public.award_flappy_pants_week(public.flappy_pants_week_start(now() - interval '7 days'))
      ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$$
);

SELECT cron.schedule(
  'snake_weekly_awards',
  '0 22,23 * * 0',
  $$SELECT CASE WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
      THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      WHEN public.seasonal_game_for_week(public.snake_week_start(now() - interval '7 days')) = 'snake'
      THEN public.award_snake_week(public.snake_week_start(now() - interval '7 days'))
      ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$$
);

SELECT cron.schedule(
  'invoice_horde_weekly_awards',
  '0 22,23 * * 0',
  $$SELECT CASE WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
      THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      WHEN public.seasonal_game_for_week(public.invoice_horde_week_start(now() - interval '7 days')) = 'invoice_horde'
      THEN public.award_invoice_horde_week(public.invoice_horde_week_start(now() - interval '7 days'))
      ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$$
);

SELECT cron.schedule(
  'var_patrol_weekly_awards',
  '0 22,23 * * 0',
  $$SELECT CASE WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
      THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      WHEN public.seasonal_game_for_week(public.var_patrol_week_start(now() - interval '7 days')) = 'var_patrol'
      THEN public.award_var_patrol_week(public.var_patrol_week_start(now() - interval '7 days'))
      ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$$
);

SELECT cron.schedule(
  'egg_catch_weekly_awards',
  '0 22,23 * * 0',
  $$SELECT CASE WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
      THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      WHEN public.seasonal_game_for_week(public.egg_catch_week_start(now() - interval '7 days')) = 'egg_catch'
      THEN public.award_egg_catch_week(public.egg_catch_week_start(now() - interval '7 days'))
      ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$$
);

SELECT cron.schedule(
  'super_mariusz_weekly_awards',
  '0 22,23 * * 0',
  $$SELECT CASE WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
      THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      WHEN public.seasonal_game_for_week(public.super_mariusz_week_start(now() - interval '7 days')) = 'super_mariusz'
      THEN public.award_super_mariusz_week(public.super_mariusz_week_start(now() - interval '7 days'))
      ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$$
);

SELECT cron.schedule(
  'popup_panic_weekly_awards',
  '0 22,23 * * 0',
  $$SELECT CASE WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
      THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      WHEN public.seasonal_game_for_week(public.popup_panic_week_start(now() - interval '7 days')) = 'popup_panic'
      THEN public.award_popup_panic_week(public.popup_panic_week_start(now() - interval '7 days'))
      ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$$
);

SELECT cron.schedule(
  'tetris_weekly_awards',
  '0 22,23 * * 0',
  $$SELECT CASE WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
      THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      WHEN public.seasonal_game_for_week(public.tetris_week_start(now() - interval '7 days')) = 'tetris'
      THEN public.award_tetris_week(public.tetris_week_start(now() - interval '7 days'))
      ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$$
);

SELECT cron.schedule(
  'healer_dungeon_weekly_awards',
  '0 22,23 * * 0',
  $$SELECT CASE WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
      THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
      WHEN public.seasonal_game_for_week(public.healer_dungeon_week_start(now() - interval '7 days')) = 'healer_dungeon'
      THEN public.award_healer_dungeon_week(public.healer_dungeon_week_start(now() - interval '7 days'))
      ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$$
);
