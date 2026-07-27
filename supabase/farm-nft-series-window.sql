-- ════════════════════════════════════════════════════════════════════════════
--  Farma — rolling ACTIVATION WINDOW for the weekly NFT series
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER: farm-weekly-nft-series.sql (whose copies of
--  farm_activate_weekly_nft() and the farm_nft_series_schedule view this file
--  SUPERSEDES — ⚠️ notes added there; re-run this file after re-running that one).
--  Idempotent; safe to re-run.
--
--  WHY
--  One edition at a time could not survive its own week. Measured 2026-07-27:
--  the office opens ~320 standard + ~70 gold boxes/week, which at the current
--  flat weights is ≈14 expected NFT hits — against an edition of 8. „Lawenda
--  Prowansalska" (nakład 8) lost 4 serials in the first 8 hours of its Monday.
--  Once an edition sells out, `minted_count < edition_size` drops it from the
--  pool and the lootbox has NO NFT to give at all (it does not error — it just
--  quietly returns fungible cards only, at full price) until the next Monday.
--  Every week therefore ended with several days of a silent 0% NFT chance.
--
--  WHAT THIS CHANGES
--  Editions now activate FARM_NFT_SERIES_LEAD_WEEKS (2) weeks EARLY, so the pool
--  holds a rolling window of three editions (this week + the next two) instead
--  of one. A sold-out edition is no longer a drought — the two behind it are
--  already droppable, and one fresh edition still joins every Monday.
--
--  NOT changed: the draw functions. open_farm_lootbox / open_farm_goldbox
--  already filter `is_active AND draw_weight > 0 AND minted_count < edition_size`,
--  so widening the activation horizon is enough. Supply per week is unchanged
--  (the same editions, the same nakłady, just available sooner), so this is a
--  smoothing change, not an inflation one.
--
--  The premiere date stays meaningful: series_week is still the Monday the
--  edition is *announced for*, and farm_mint_random_event_nft still prefers
--  `series_week = current Monday`, so the weekly champion keeps getting the
--  brand-new collection's card.
-- ════════════════════════════════════════════════════════════════════════════

-- ── How many weeks ahead an edition may start dropping ─────────────────────
-- Mirror of FARM_NFT_SERIES_LEAD_WEEKS in index.html.
CREATE OR REPLACE FUNCTION public.farm_nft_series_lead_weeks()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT 2;
$$;

-- Latest series_week that is allowed to be live right now.
CREATE OR REPLACE FUNCTION public.farm_nft_series_horizon()
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT public.farm_current_series_monday()
       + (public.farm_nft_series_lead_weeks() * 7) * INTERVAL '1 day';
$$;

-- ── Activation (supersedes farm-weekly-nft-series.sql) ─────────────────────
-- Same daily 22:00/23:00 UTC cron as before — the schedule is untouched, only
-- the horizon widens, so nothing needs re-scheduling.
CREATE OR REPLACE FUNCTION public.farm_activate_weekly_nft()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.farm_card_defs
     SET is_active = true
   WHERE series_week IS NOT NULL
     AND is_active = false
     AND series_week <= public.farm_nft_series_horizon();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.farm_activate_weekly_nft() FROM PUBLIC, anon, authenticated;

-- ── Public schedule view (supersedes farm-weekly-nft-series.sql) ───────────
-- `activated`/`droppable` must use the SAME horizon as the draw functions,
-- otherwise the UI would show „🔒 Wkrótce" for an edition that is already
-- dropping. Column list/order unchanged, so CREATE OR REPLACE is safe.
CREATE OR REPLACE VIEW public.farm_nft_series_schedule WITH (security_invoker = true) AS
  SELECT
    d.species, d.name, d.emoji, d.rarity, d.edition_size, d.minted_count,
    d.series_week,
    (SELECT count(*) FROM public.farm_nft_instances ni WHERE ni.species = d.species) AS live_count,
    d.series_week <= public.farm_nft_series_horizon() AS activated,
    d.is_active
      AND d.series_week <= public.farm_nft_series_horizon()
      AND d.minted_count < d.edition_size AS droppable
  FROM public.farm_card_defs d
  WHERE d.series_week IS NOT NULL
  ORDER BY d.series_week;
GRANT SELECT ON public.farm_nft_series_schedule TO anon, authenticated;

-- Catch up immediately: bring the next two weeks into the pool now.
SELECT public.farm_activate_weekly_nft();
