-- ═══════════════════════════════════════════════════════════════════════════
--  Farma weekly contract („🏆 Wyzwanie") — MAKE THE MONDAY PAYOUT RELIABLE
--  Run AFTER: farm.sql, farm-seasonal-contracts.sql, polish-midnight-schedules.sql
--  Idempotent (CREATE OR REPLACE + cron.schedule upsert only). Safe to re-run.
--
--  WHY THIS FILE EXISTS
--  ────────────────────
--  On 2026-08-03 00:00 Europe/Warsaw the contract payout for week 2026-07-27
--  died with `deadlock detected` and NOBODY WAS PAID (3 rank prizes + 7 bar
--  prizes = 5000🪙 + 42 boxes + 1 NFT, settled by hand afterwards). Three
--  independent faults had to line up, and this file fixes all three:
--
--   1. COLLISION. `farm_seasonal_weekly_awards` ('0 22,23 * * 0') and
--      `farm_land_tax_daily_summer`/`_winter` ('0 22|23 * * *') fired in the
--      SAME SECOND, and `award_farm_seasonal_week` and `assess_farm_land_tax`
--      both write `public.farm_user_state`. The award function walks
--      contributors `qty DESC`; the tax pass walks its own set in another
--      order — so they grab the same rows in opposite orders. Textbook
--      deadlock; which one Postgres shot was pure luck.
--      → the land-tax jobs move to minute 10. They keep their own Warsaw
--        hour-00 gate, so 22:10/23:10 UTC is still 00:10 Warsaw in both DST
--        halves and the tax day they assess is unchanged.
--
--   2. NO RETRY. The two UTC hours exist for DST safety, NOT as a retry: the
--      command's Warsaw-hour gate means the 23:00 UTC run answers
--      `skipped: not_midnight_warsaw`. So a failure at midnight is final.
--      → the job now calls award_farm_seasonal_week_cron(), which retries a
--        deadlock/serialization failure up to 5× with backoff.
--
--   3. THE FIX GOT REVERTED. award_farm_seasonal_week_cron() already existed
--      in the live database with exactly that retry loop — written ad-hoc after
--      an earlier failure (week 2026-07-13 was likewise awarded late, at
--      2026-07-20 07:14) and never committed to any file in supabase/. Both
--      farm-seasonal-contracts.sql and polish-midnight-schedules.sql
--      re-`cron.schedule` this job with the raw inline call, so the next re-run
--      of either silently pointed the job back at the unprotected function.
--      That is why the same bug bit twice.
--      → the wrapper now lives HERE, in the repo, and both of those files
--        carry a ⚠️ note pointing at this one.
--
--  Plus a belt-and-braces net so a missed week heals itself instead of waiting
--  for someone to notice: award_farm_seasonal_week_catchup() pays ANY closed,
--  unpaid week (bounded lookback) and runs hourly.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
--  1. The Monday job's entry point: DST gate + deadlock retry.
--     Kept byte-compatible with the ad-hoc definition that was already live.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.award_farm_seasonal_week_cron()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_attempt integer := 0;
  v_max     integer := 5;
  v_result  json;
BEGIN
  -- DST-safe gate: the cron fires at both 22:00 and 23:00 UTC (the two hours
  -- that can be Warsaw midnight); act only when it is genuinely 00:xx Warsaw.
  IF EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0 THEN
    RETURN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw');
  END IF;

  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      v_result := public.award_farm_seasonal_week(
        public.farm_seasonal_week_start(now() - interval '7 days')
      );
      RETURN v_result;
    EXCEPTION
      WHEN deadlock_detected OR serialization_failure THEN
        IF v_attempt >= v_max THEN
          RAISE;
        END IF;
        PERFORM pg_sleep(0.4 * v_attempt);  -- brief backoff, then retry
    END;
  END LOOP;
END;
$function$;


-- ───────────────────────────────────────────────────────────────────────────
--  2. Self-healing catch-up. NO Warsaw-hour gate on purpose — this is exactly
--     the thing that must still work when the midnight run did not.
--
--     award_farm_seasonal_week() is idempotent (it returns `already_awarded`
--     when the event already has rows), so running this hourly costs one
--     EXISTS probe per closed week and pays nothing twice.
--
--     LOOKBACK IS BOUNDED (4 weeks). A week whose contributors all end up
--     ineligible inserts no award rows, so it stays "unpaid" forever and would
--     otherwise be retried until the end of time.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.award_farm_seasonal_week_catchup()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_week    date;
  v_attempt integer;
  v_max     integer := 5;
  v_done    jsonb := '[]'::jsonb;
  v_result  json;
BEGIN
  FOR v_week IN
    SELECT e.week_start
      FROM public.farm_seasonal_events e
     WHERE e.week_start >= DATE '2026-07-06'
       -- only CLOSED weeks; award_farm_seasonal_week() raises week_not_closed
       AND e.week_start < public.farm_seasonal_week_start(now())
       AND e.week_start >= (public.farm_seasonal_week_start(now()) - interval '4 weeks')
       AND NOT EXISTS (
         SELECT 1 FROM public.farm_seasonal_weekly_awards a WHERE a.event_id = e.id
       )
       -- a week nobody sold into has nothing to pay; skip it silently
       AND EXISTS (
         SELECT 1 FROM public.farm_seasonal_event_sales s WHERE s.event_id = e.id
       )
     ORDER BY e.week_start
  LOOP
    v_attempt := 0;
    LOOP
      v_attempt := v_attempt + 1;
      BEGIN
        v_result := public.award_farm_seasonal_week(v_week);
        v_done := v_done || jsonb_build_object('week_start', v_week, 'result', v_result);
        EXIT;
      EXCEPTION
        WHEN deadlock_detected OR serialization_failure THEN
          IF v_attempt >= v_max THEN
            RAISE;
          END IF;
          PERFORM pg_sleep(0.4 * v_attempt);
      END;
    END LOOP;
  END LOOP;

  RETURN json_build_object('ok', true, 'weeks_paid', jsonb_array_length(v_done), 'detail', v_done);
END;
$function$;


-- ───────────────────────────────────────────────────────────────────────────
--  3. Rewire the schedules.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN

    -- (a) Monday payout → the retrying wrapper (the gate now lives in the
    --     function, so the command is a plain call).
    PERFORM cron.schedule(
      'farm_seasonal_weekly_awards',
      '0 22,23 * * 0',
      $cron$SELECT public.award_farm_seasonal_week_cron();$cron$
    );

    -- (b) Land tax off minute 0 — this is the actual root-cause fix. Both
    --     jobs still land inside Warsaw hour 00, which is all
    --     assess_farm_land_tax() gates on.
    PERFORM cron.schedule('farm_land_tax_daily_summer', '10 22 * * *',
      $cron$SELECT public.assess_farm_land_tax();$cron$);
    PERFORM cron.schedule('farm_land_tax_daily_winter', '10 23 * * *',
      $cron$SELECT public.assess_farm_land_tax();$cron$);

    -- (c) Hourly self-heal. Minute 25 is deliberately free of every other
    --     farm job (price roll :00, price snapshot :00, rot cleanup :00,
    --     NFT activation :00, filler sweep every :10) so the catch-up can
    --     never re-create the very collision it exists to recover from.
    PERFORM cron.schedule(
      'farm_seasonal_awards_catchup',
      '25 * * * *',
      $cron$SELECT public.award_farm_seasonal_week_catchup();$cron$
    );
  END IF;
EXCEPTION WHEN invalid_schema_name OR undefined_function THEN
  NULL;
END $$;

NOTIFY pgrst, 'reload schema';
