-- ════════════════════════════════════════════════════════════════════════════
--  Farma — Osiągnięcia (achievements) + more passive perks  (Lever 3, expanded)
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER: farm.sql, farm-plant-lock-fix.sql, farm-seasonal-contracts.sql,
--             farm-weekly-nft-series.sql, farm-nft-breeding.sql,
--             farm-collector-perks.sql.  Idempotent.
--
--  Expands the single „Renoma Kolekcjonera" perk into a 5-track achievement wall.
--  ALL FIVE grant a real, server-enforced bonus (no decorative badges). Stage
--  thresholds + labels live in the FRONTEND (ACHIEVEMENTS config in index.html);
--  this file returns raw metrics + the enforced bonus percentages, so the two
--  stay trivially in sync.
--
--    1. 🏅 Renoma Kolekcjonera  — distinct NFT species → +NPC crop price
--         (farm_collector_bonus, applied in sell_crop_to_npc)
--    2. 🌱 Zielony Kciuk         — Σ owned NFT levels → faster growth
--         (farm_growth_bonus, applied in plant_crop, below)
--    3. 🧬 Mistrz Hybryd         — hybrids bred → cheaper breeding
--         (farm_breed_discount, applied in breed_nft)
--    4. 🗓️ Sezonowy Łowca        — distinct weekly series → +contract premium
--         (farm_seasonal_bonus, applied in sell_crop_to_npc's event bonus)
--    5. 🏞️ Potentat Ziemski      — tiles owned → +harvest yield
--         (farm_yield_bonus, applied in harvest_crop, below)
--
--  farm_achievements(p_user) is callable for ANY user id, so the UI can preview
--  another player's progress.  Formulas here MIRROR the JS bonus math — keep both.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Bonus helpers (enforced server-side) ───────────────────────────────────
-- Growth: −1% grow time per owned NFT level, capped −20% (24h floor still applies).
CREATE OR REPLACE FUNCTION public.farm_growth_bonus(p_user uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT LEAST(0.20, 0.01 * COALESCE((
    SELECT sum(level) FROM public.farm_nft_instances WHERE owner_id = p_user), 0))::numeric;
$$;
GRANT EXECUTE ON FUNCTION public.farm_growth_bonus(uuid) TO authenticated;

-- Breeding discount: −5% per hybrid bred, capped −30%.
CREATE OR REPLACE FUNCTION public.farm_breed_discount(p_user uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT LEAST(0.30, 0.05 * COALESCE((
    SELECT count(*) FROM public.farm_hybrid_births WHERE bred_by = p_user), 0))::numeric;
$$;
GRANT EXECUTE ON FUNCTION public.farm_breed_discount(uuid) TO authenticated;

-- Seasonal contract premium: +2% per distinct weekly series owned, capped +20%.
-- Applied to the weekly farm-contract bonus in sell_crop_to_npc.
CREATE OR REPLACE FUNCTION public.farm_seasonal_bonus(p_user uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT LEAST(0.20, 0.02 * COALESCE((
    SELECT count(DISTINCT ni.species)
      FROM public.farm_nft_instances ni
      JOIN public.farm_card_defs d ON d.species = ni.species
     WHERE ni.owner_id = p_user AND d.series_week IS NOT NULL), 0))::numeric;
$$;
GRANT EXECUTE ON FUNCTION public.farm_seasonal_bonus(uuid) TO authenticated;

-- Harvest yield: +2% per owned (non-migration) tile, capped +15%.
-- Rate is 2%/tile (not 1%) because the land tax makes territory genuinely scarce:
-- with a fair cap of ~4 tiles, the observed maximum across all players is 5 and
-- 7 would already be exceptional — so a 1%/tile rate would never feel like anything.
-- NOTE: deliberately NOT a land-tax discount — the tax is the anti-hoarding soft
-- cap, so discounting it for owning many tiles would undercut its whole purpose.
CREATE OR REPLACE FUNCTION public.farm_yield_bonus(p_user uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT LEAST(0.15, 0.02 * COALESCE((
    SELECT count(*) FROM public.farm_tiles
     WHERE owner_id = p_user AND acquired_via IS DISTINCT FROM 'migration'), 0))::numeric;
$$;
GRANT EXECUTE ON FUNCTION public.farm_yield_bonus(uuid) TO authenticated;

-- ── Aggregate: raw metrics + enforced bonuses (any user, for preview) ──────
CREATE OR REPLACE FUNCTION public.farm_achievements(p_user uuid DEFAULT auth.uid())
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT json_build_object(
    'user_id', p_user,
    'nick', (SELECT nick FROM public.profiles WHERE id = p_user),
    'distinct_species', COALESCE((SELECT count(DISTINCT species) FROM public.farm_nft_instances WHERE owner_id = p_user), 0),
    'nft_count',        COALESCE((SELECT count(*)               FROM public.farm_nft_instances WHERE owner_id = p_user), 0),
    'nft_level_sum',    COALESCE((SELECT sum(level)             FROM public.farm_nft_instances WHERE owner_id = p_user), 0),
    'hybrids_bred',     COALESCE((SELECT count(*)               FROM public.farm_hybrid_births WHERE bred_by  = p_user), 0),
    'distinct_series',  COALESCE((SELECT count(DISTINCT ni.species)
                                    FROM public.farm_nft_instances ni
                                    JOIN public.farm_card_defs d ON d.species = ni.species
                                   WHERE ni.owner_id = p_user AND d.series_week IS NOT NULL), 0),
    'tiles_owned',      COALESCE((SELECT count(*) FROM public.farm_tiles
                                   WHERE owner_id = p_user AND acquired_via IS DISTINCT FROM 'migration'), 0),
    'price_bonus_pct',    round(public.farm_collector_bonus(p_user) * 100)::int,
    'growth_bonus_pct',   round(public.farm_growth_bonus(p_user)    * 100)::int,
    'breed_discount_pct', round(public.farm_breed_discount(p_user)  * 100)::int,
    'seasonal_bonus_pct', round(public.farm_seasonal_bonus(p_user)  * 100)::int,
    'yield_bonus_pct',    round(public.farm_yield_bonus(p_user)     * 100)::int
  );
$$;
GRANT EXECUTE ON FUNCTION public.farm_achievements(uuid) TO authenticated;

-- Every player's metrics in ONE call — powers the per-achievement comparison
-- table (accordion) under each track, so the UI doesn't fire N round-trips.
CREATE OR REPLACE FUNCTION public.farm_achievements_all()
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(json_agg(public.farm_achievements(p.id) ORDER BY p.nick), '[]'::json)
    FROM public.profiles p
   WHERE COALESCE(p.is_admin, false) = false
     AND (EXISTS (SELECT 1 FROM public.farm_tiles t
                   WHERE t.owner_id = p.id AND t.acquired_via IS DISTINCT FROM 'migration')
          OR EXISTS (SELECT 1 FROM public.farm_nft_instances n WHERE n.owner_id = p.id));
$$;
GRANT EXECUTE ON FUNCTION public.farm_achievements_all() TO authenticated;

-- Players with any farm footprint (for the „podejrzyj innych" picker).
CREATE OR REPLACE FUNCTION public.farm_achievement_players()
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(json_agg(json_build_object('id', id, 'nick', nick) ORDER BY nick), '[]'::json)
    FROM public.profiles p
   WHERE COALESCE(p.is_admin, false) = false
     AND (EXISTS (SELECT 1 FROM public.farm_tiles t
                   WHERE t.owner_id = p.id AND t.acquired_via IS DISTINCT FROM 'migration')
          OR EXISTS (SELECT 1 FROM public.farm_nft_instances n WHERE n.owner_id = p.id));
$$;
GRANT EXECUTE ON FUNCTION public.farm_achievement_players() TO authenticated;

-- ── Supersede plant_crop: apply the „Zielony Kciuk" growth speedup ─────────
-- Verbatim copy of the farm-plant-lock-fix.sql version, with ONLY the grow-time
-- line multiplied by (1 - farm_growth_bonus). The 24h floor (greatest(1440,…))
-- is preserved, so the perk speeds sub-…-day growth toward the floor, never below.
-- ⚠️ Supersedes plant_crop from farm-plant-lock-fix.sql — re-run this after re-running that.
CREATE OR REPLACE FUNCTION public.plant_crop(p_x integer, p_y integer, p_species text, p_instance_id uuid DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user         uuid := auth.uid();
  v_tile         public.farm_tiles%ROWTYPE;
  v_def          public.farm_card_defs%ROWTYPE;
  v_coll         public.farm_collection%ROWTYPE;
  v_level        integer;
  v_owned        integer;
  v_planted      integer;
  v_grow_minutes numeric;
  v_ready        timestamptz;
  v_nft_inst     public.farm_nft_instances%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_tile FROM public.farm_tiles WHERE x = p_x AND y = p_y FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tile_not_owned'; END IF;
  IF v_tile.owner_id <> v_user THEN RAISE EXCEPTION 'not_your_tile'; END IF;
  IF v_tile.acquired_via = 'migration' THEN RAISE EXCEPTION 'zen_tile'; END IF;
  IF v_tile.listed THEN RAISE EXCEPTION 'tile_listed'; END IF;
  IF v_tile.planted_species IS NOT NULL THEN RAISE EXCEPTION 'tile_occupied'; END IF;
  PERFORM public.farm_assert_can_plant(v_user);

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = p_species AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'bad_species'; END IF;

  IF v_def.edition_size IS NOT NULL THEN
    IF p_instance_id IS NULL THEN RAISE EXCEPTION 'nft_requires_instance'; END IF;

    SELECT * INTO v_nft_inst FROM public.farm_nft_instances
     WHERE id = p_instance_id AND species = p_species FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'nft_not_found'; END IF;
    IF v_nft_inst.owner_id <> v_user THEN RAISE EXCEPTION 'not_owner'; END IF;
    IF v_nft_inst.listed THEN RAISE EXCEPTION 'nft_listed'; END IF;

    IF EXISTS (SELECT 1 FROM public.farm_tiles WHERE planted_instance_id = p_instance_id) THEN
      RAISE EXCEPTION 'nft_already_planted';
    END IF;

    v_level := v_nft_inst.level;
  ELSE
    SELECT * INTO v_coll FROM public.farm_collection
     WHERE user_id = v_user AND species = p_species FOR UPDATE;
    IF v_coll IS NULL THEN RAISE EXCEPTION 'no_card'; END IF;

    v_level := v_coll.level;

    IF v_level >= 2 THEN
      NULL;
    ELSE
      v_owned := COALESCE(v_coll.count, 0);
      IF v_owned < 1 THEN RAISE EXCEPTION 'no_card'; END IF;

      SELECT count(*) INTO v_planted
        FROM public.farm_tiles
       WHERE owner_id = v_user AND planted_species = p_species;
      IF v_planted >= v_owned THEN RAISE EXCEPTION 'no_free_card'; END IF;
    END IF;
  END IF;

  -- Level speeds growth (~8%/level); „Zielony Kciuk" trims it further; 24h floor holds.
  -- Bred hybrids carry their own synergy grow time (farm_nft_instances.stat_grow_minutes).
  v_grow_minutes := greatest(1440,
    COALESCE(v_nft_inst.stat_grow_minutes, v_def.base_grow_minutes)
      * power(0.92, v_level - 1) * (1 - public.farm_growth_bonus(v_user)));
  v_ready := now() + (v_grow_minutes * interval '1 minute');

  UPDATE public.farm_tiles
     SET planted_species = p_species, planted_level = v_level,
         planted_at = now(), ready_at = v_ready,
         planted_instance_id = p_instance_id
   WHERE x = p_x AND y = p_y;

  RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'species', p_species,
    'level', v_level, 'ready_at', v_ready);
END;
$$;
REVOKE ALL ON FUNCTION public.plant_crop(integer, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plant_crop(integer, integer, text, uuid) TO authenticated;

-- ── Supersede harvest_crop: apply the „Potentat Ziemski" yield bonus ───────
-- Verbatim copy of the nft-leveling-rework.sql version (which clears
-- planted_instance_id), with ONLY the yield line scaled by farm_yield_bonus.
-- ⚠️ Supersedes harvest_crop from nft-leveling-rework.sql — re-run this after that.
CREATE OR REPLACE FUNCTION public.harvest_crop(p_x integer, p_y integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_tile  public.farm_tiles%ROWTYPE;
  v_def   public.farm_card_defs%ROWTYPE;
  v_yield integer;
  v_exp   timestamptz;
  v_qty   integer;
  v_inst_yield integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_tile FROM public.farm_tiles WHERE x = p_x AND y = p_y FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tile_not_owned'; END IF;
  IF v_tile.owner_id <> v_user THEN RAISE EXCEPTION 'not_your_tile'; END IF;
  IF v_tile.planted_species IS NULL THEN RAISE EXCEPTION 'tile_empty'; END IF;
  IF v_tile.ready_at IS NULL OR now() < v_tile.ready_at THEN RAISE EXCEPTION 'not_ready'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_tile.planted_species;
  IF NOT FOUND THEN RAISE EXCEPTION 'bad_species'; END IF;

  -- Bred hybrids carry their own synergy yield (farm_nft_instances.stat_yield).
  IF v_tile.planted_instance_id IS NOT NULL THEN
    SELECT stat_yield INTO v_inst_yield
      FROM public.farm_nft_instances WHERE id = v_tile.planted_instance_id;
  END IF;

  -- Level scales yield (+50%/level); „Potentat Ziemski" adds its territory bonus.
  v_yield := round(COALESCE(v_inst_yield, v_def.base_yield) * (1 + (v_tile.planted_level - 1) * 0.5)
                   * (1 + public.farm_yield_bonus(v_user)))::integer;
  v_exp   := now() + interval '5 days';

  INSERT INTO public.farm_inventory (user_id, crop_type, qty, harvested_at, expires_at)
  VALUES (v_user, v_def.crop_type, v_yield, now(), v_exp);

  SELECT COALESCE(sum(qty), 0) INTO v_qty FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = v_def.crop_type AND expires_at > now();

  UPDATE public.farm_tiles
     SET planted_species = NULL, planted_level = NULL, planted_at = NULL, ready_at = NULL,
         planted_instance_id = NULL   -- free the NFT instance so it can merge/list/replant
   WHERE x = p_x AND y = p_y;

  RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'crop_type', v_def.crop_type,
    'harvested', v_yield, 'inventory_qty', v_qty, 'expires_at', v_exp);
END;
$$;
REVOKE ALL ON FUNCTION public.harvest_crop(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.harvest_crop(integer, integer) TO authenticated;
