-- ════════════════════════════════════════════════════════════════════════════
--  Farma — Weekly seasonal NFT series  (Lever 1)
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER: farm.sql, farm-marketplace.sql, nft-leveling-rework.sql,
--             nft-merge-fixes.sql, farm-goldbox.sql, farm-static-nft-odds.sql,
--             farm-seasonal-contracts.sql.  Idempotent; safe to re-run.
--
--  WHAT THIS ADDS
--  A new limited-edition NFT plant species goes live every Monday 00:00
--  Europe/Warsaw. Each is a serialized, edition-capped card (like the original
--  4 legendaries) that drops from the standard + gold lootboxes while its edition
--  lasts. Editions stay droppable UNTIL SOLD OUT (they overlap with newer weeks),
--  and future weeks are pre-seeded so the UI can preview them as „Wkrótce 🔒".
--
--  ACTIVATION GATE — no changes to the giant open_farm_lootbox/open_farm_goldbox
--  draw functions are required: they already filter
--      is_active AND draw_weight > 0 AND minted_count < edition_size
--  so we simply seed each weekly species with is_active=false until its Monday,
--  and a tiny Warsaw-midnight cron (farm_activate_weekly_nft) flips is_active=true
--  once series_week has arrived. „Until sold out" then falls straight out of the
--  existing minted_count < edition_size check.
--
--  EDITION SIZE is per-row (the „variable" ask): standard weeks 8, showcase/rare
--  weeks 5-6, apex weeks smaller. Tune each row's edition_size freely.
--
--  CROP: every weekly NFT is plantable and shares ONE crop_type ('seasonal_bloom')
--  + one farm_market row, so we don't spawn 52 crops/price-charts a year. The
--  collectible value lives in the serial/edition/art/perk, not a bespoke crop.
--
--  Net worth: weekly NFTs have edition_size set, so user_assets_value /
--  economy_stats already value each instance at round(20000/edition_size * level).
--  No changes needed in economy-stats.sql / leaderboard-net-worth-items.sql.
--
--  Keep the seeded rows in sync with NFT_SERIES_ROTATION in index.html.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Schema: activation date + hybrid flag on the catalog ───────────────────
ALTER TABLE public.farm_card_defs ADD COLUMN IF NOT EXISTS series_week date;
ALTER TABLE public.farm_card_defs ADD COLUMN IF NOT EXISTS is_hybrid boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.farm_card_defs.series_week IS
  'Monday (Europe/Warsaw) this weekly NFT edition activates. NULL = always-on (originals/hybrids).';
COMMENT ON COLUMN public.farm_card_defs.is_hybrid IS
  'Breeding-produced hybrid species (Lever 2). draw_weight=0 keeps them out of lootboxes.';
CREATE INDEX IF NOT EXISTS farm_card_defs_series_week_idx
  ON public.farm_card_defs(series_week) WHERE series_week IS NOT NULL;

-- ── Current Warsaw week Monday (ISO week start) ────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_current_series_monday()
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (date_trunc('week', (now() AT TIME ZONE 'Europe/Warsaw')))::date;
$$;

-- ── Persona gender: extend the feminine set with feminine weekly species ───
-- (Malwa/Dalia/Aksamitka/Lawenda/Chryzantema/Dynia are feminine in Polish, so
-- their serialized instances get women's names via farm_nft_name.)
CREATE OR REPLACE FUNCTION public.farm_nft_is_female(p_species text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_species IN (
    'diamond_rose',
    'lavender_provence', 'garden_hollyhock', 'imperial_dahlia',
    'golden_marigold', 'giant_pumpkin', 'royal_chrysanth'
  );
$$;

-- ── Shared crop + market row for every weekly bloom ────────────────────────
INSERT INTO public.farm_market (crop_type, base_price, anchor_price, cur_price) VALUES
  ('seasonal_bloom', 50, 50, 50)
ON CONFLICT (crop_type) DO UPDATE SET
  base_price   = EXCLUDED.base_price,
  anchor_price = EXCLUDED.base_price,
  cur_price    = EXCLUDED.base_price;

-- ── Seed the rotation (2026-07-27 → 2026-10-12, first 12 weeks) ────────────
-- edition_size is intentionally VARIED per week. is_active is computed at seed
-- time; the cron below activates the rest once their Monday arrives.
-- Columns: species, name, emoji, rarity, draw_weight, grow_min, yield, edition, series_week
INSERT INTO public.farm_card_defs
  (species, name, emoji, rarity, draw_weight, base_grow_minutes, base_yield, crop_type, edition_size, series_week, is_active)
VALUES
  ('lavender_provence', 'Lawenda Prowansalska',   '🪻', 'legendary', 2, 4320,  70, 'seasonal_bloom',  8, DATE '2026-07-27', DATE '2026-07-27' <= public.farm_current_series_monday()),
  ('golden_harvest',    'Złociste Żniwa',         '🌾', 'legendary', 2, 4320,  75, 'seasonal_bloom', 10, DATE '2026-08-03', DATE '2026-08-03' <= public.farm_current_series_monday()),
  ('garden_hollyhock',  'Malwa Ogrodowa',         '🌺', 'legendary', 2, 4320,  70, 'seasonal_bloom',  8, DATE '2026-08-10', DATE '2026-08-10' <= public.farm_current_series_monday()),
  ('imperial_dahlia',   'Dalia Cesarska',         '🌼', 'legendary', 1, 4320,  85, 'seasonal_bloom',  6, DATE '2026-08-17', DATE '2026-08-17' <= public.farm_current_series_monday()),
  ('golden_marigold',   'Aksamitka Złota',        '🏵️', 'legendary', 2, 4320,  70, 'seasonal_bloom',  8, DATE '2026-08-24', DATE '2026-08-24' <= public.farm_current_series_monday()),
  ('vine_grape',        'Grono Winne',            '🍇', 'legendary', 2, 4320,  80, 'seasonal_bloom',  8, DATE '2026-08-31', DATE '2026-08-31' <= public.farm_current_series_monday()),
  ('noble_boletus',     'Borowik Szlachetny',     '🍄', 'legendary', 1, 4320,  90, 'seasonal_bloom',  6, DATE '2026-09-07', DATE '2026-09-07' <= public.farm_current_series_monday()),
  ('autumn_heather',    'Wrzos Jesienny',         '🌿', 'legendary', 2, 4320,  70, 'seasonal_bloom',  8, DATE '2026-09-14', DATE '2026-09-14' <= public.farm_current_series_monday()),
  ('sweet_chestnut',    'Kasztan Jadalny',        '🌰', 'legendary', 2, 4320,  80, 'seasonal_bloom',  8, DATE '2026-09-21', DATE '2026-09-21' <= public.farm_current_series_monday()),
  ('giant_pumpkin',     'Dynia Olbrzymia',        '🎃', 'legendary', 1, 5760, 100, 'seasonal_bloom',  5, DATE '2026-09-28', DATE '2026-09-28' <= public.farm_current_series_monday()),
  ('fiery_maple',       'Klon Ognisty',           '🍁', 'legendary', 2, 4320,  75, 'seasonal_bloom',  8, DATE '2026-10-05', DATE '2026-10-05' <= public.farm_current_series_monday()),
  ('royal_chrysanth',   'Chryzantema Królewska',  '💮', 'legendary', 1, 4320,  90, 'seasonal_bloom',  6, DATE '2026-10-12', DATE '2026-10-12' <= public.farm_current_series_monday())
ON CONFLICT (species) DO UPDATE SET
  name = EXCLUDED.name, emoji = EXCLUDED.emoji, rarity = EXCLUDED.rarity,
  draw_weight = EXCLUDED.draw_weight, base_grow_minutes = EXCLUDED.base_grow_minutes,
  base_yield = EXCLUDED.base_yield, crop_type = EXCLUDED.crop_type,
  edition_size = EXCLUDED.edition_size, series_week = EXCLUDED.series_week,
  -- never re-hide an already-live edition on re-run, but let a due one turn on
  is_active = farm_card_defs.is_active
              OR (EXCLUDED.series_week <= public.farm_current_series_monday());

-- ── Weekly activation (flip is_active on once series_week arrives) ──────────
-- ⚠️ SUPERSEDED by supabase/farm-nft-series-window.sql, which activates each
-- edition 2 weeks EARLY so the pool always holds three overlapping editions
-- (one edition alone sells out in a day and leaves the boxes with no NFT to
-- give). Re-run that file after re-running this one.
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
     AND series_week <= public.farm_current_series_monday();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.farm_activate_weekly_nft() FROM PUBLIC, anon, authenticated;

-- Fire daily at 22:00 and 23:00 UTC — one of those is exactly Monday 00:00
-- Europe/Warsaw across both CEST (UTC+2) and CET (UTC+1). Idempotent + date-gated,
-- so running every day (not only Monday) is harmless and DST-proof.
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule('farm_weekly_nft_activate_2200');
    PERFORM cron.unschedule('farm_weekly_nft_activate_2300');
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.schedule('farm_weekly_nft_activate_2200', '0 22 * * *',
      'SELECT public.farm_activate_weekly_nft();');
    PERFORM cron.schedule('farm_weekly_nft_activate_2300', '0 23 * * *',
      'SELECT public.farm_activate_weekly_nft();');
  END IF;
END $$;

-- Catch up immediately for any already-due series on install.
SELECT public.farm_activate_weekly_nft();

-- ════════════════════════════════════════════════════════════════════════════
--  Lever 4 — seasonal champion gets a NEW-collection NFT
-- ════════════════════════════════════════════════════════════════════════════
--  Supersedes farm_mint_random_event_nft in farm-seasonal-contracts.sql (⚠️ that
--  copy is now stale). Same behaviour + provenance, with ONE change: it PREFERS
--  the current week's freshly-activated series (weighting active series_week=this
--  Monday editions first), so the weekly champ tends to receive the brand-new
--  collection's card — often an early serial. Falls back to any live edition,
--  then (caller's job) to boxes when nothing is mintable.
CREATE OR REPLACE FUNCTION public.farm_mint_random_event_nft(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempts integer := 0;
  v_total    numeric;
  v_roll     numeric;
  v_species  text;
  v_def      public.farm_card_defs%ROWTYPE;
  v_serial   integer;
  v_nft_idx  integer;
  v_name     text;
  v_id       uuid;
  v_monday   date := public.farm_current_series_monday();
  v_prefer   boolean;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  WHILE v_attempts < 20 LOOP
    v_attempts := v_attempts + 1;

    -- Prefer the current week's series while any of it is still mintable.
    SELECT EXISTS (
      SELECT 1 FROM public.farm_card_defs
       WHERE is_active AND edition_size IS NOT NULL AND draw_weight > 0
         AND series_week = v_monday AND minted_count < edition_size
    ) INTO v_prefer;

    SELECT sum(draw_weight)::numeric INTO v_total
      FROM public.farm_card_defs
     WHERE is_active
       AND edition_size IS NOT NULL
       AND draw_weight > 0
       AND minted_count < edition_size
       AND (NOT v_prefer OR series_week = v_monday);
    IF v_total IS NULL OR v_total <= 0 THEN
      RETURN NULL;
    END IF;

    v_roll := random() * v_total;
    SELECT species INTO v_species
      FROM (
        SELECT species, sum(draw_weight) OVER (ORDER BY species) AS cum
          FROM public.farm_card_defs
         WHERE is_active
           AND edition_size IS NOT NULL
           AND draw_weight > 0
           AND minted_count < edition_size
           AND (NOT v_prefer OR series_week = v_monday)
      ) q
     WHERE q.cum > v_roll
     ORDER BY q.cum
     LIMIT 1;

    SELECT * INTO v_def
      FROM public.farm_card_defs
     WHERE species = v_species
     FOR UPDATE;
    IF NOT FOUND OR v_def.minted_count >= v_def.edition_size THEN
      CONTINUE;
    END IF;

    v_serial := v_def.minted_count + 1;
    SELECT COALESCE(sum(d2.minted_count), 0) INTO v_nft_idx
      FROM public.farm_card_defs d2
     WHERE d2.edition_size IS NOT NULL
       AND public.farm_nft_pool(d2.species) = public.farm_nft_pool(v_species);
    v_name := public.farm_nft_persona(v_species, v_nft_idx);

    INSERT INTO public.farm_nft_instances
      (species, serial_no, edition_size, owner_id, acquired_from, nft_name)
    VALUES
      (v_species, v_serial, v_def.edition_size, p_user, 'seasonal_reward', v_name)
    RETURNING id INTO v_id;

    UPDATE public.farm_card_defs
       SET minted_count = minted_count + 1
     WHERE species = v_species;

    IF to_regclass('public.farm_nft_transfers') IS NOT NULL THEN
      INSERT INTO public.farm_nft_transfers
        (instance_id, species, serial_no, from_owner, to_owner, price, kind)
      VALUES
        (v_id, v_species, v_serial, NULL, p_user, 0, 'mint');
    END IF;

    RETURN jsonb_build_object(
      'nft', true, 'id', v_id, 'species', v_species,
      'serial_no', v_serial, 'edition_size', v_def.edition_size,
      'nft_name', v_name, 'name', v_def.name, 'emoji', v_def.emoji);
  END LOOP;

  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.farm_mint_random_event_nft(uuid) FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
--  Public read: active + upcoming series for the UI preview
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠️ SUPERSEDED by supabase/farm-nft-series-window.sql — `activated`/`droppable`
-- there use farm_nft_series_horizon() so they match the widened activation
-- window the draw functions actually see. Re-run that file after this one.
CREATE OR REPLACE VIEW public.farm_nft_series_schedule WITH (security_invoker = true) AS
  SELECT
    d.species, d.name, d.emoji, d.rarity, d.edition_size, d.minted_count,
    d.series_week,
    (SELECT count(*) FROM public.farm_nft_instances ni WHERE ni.species = d.species) AS live_count,
    d.series_week <= public.farm_current_series_monday() AS activated,
    d.is_active
      AND d.series_week <= public.farm_current_series_monday()
      AND d.minted_count < d.edition_size AS droppable
  FROM public.farm_card_defs d
  WHERE d.series_week IS NOT NULL
  ORDER BY d.series_week;
GRANT SELECT ON public.farm_nft_series_schedule TO anon, authenticated;
