-- Fix + design change for plant_crop's fungible-card planting cap.
--
-- Bug fixed: the cap check read farm_collection with a plain SELECT (no lock),
-- so concurrent plant_crop calls for the same (user, species) — double-click,
-- multiple tabs, a scripted burst — could all read the same stale planted
-- count before any of their UPDATEs committed, letting arbitrarily many
-- tiles be planted regardless of the intended cap (observed: a level-5
-- Marchewka with count=0 planted on 2 tiles at once, "Posadzono (2/1)").
--
-- Design change: a Lvl 2+ card is no longer capped at exactly one
-- simultaneously-planted tile. Once a card reaches level 2+, it can be
-- planted on any number of tiles at once (leveling up turns it into an
-- unlimited seed). Only Lvl 1 cards remain capped by farm_collection.count,
-- and that cap is now race-safe via a row lock.
--
-- Run after nft-leveling-rework.sql (which this supersedes) and after
-- nft-merge-fixes.sql. Idempotent (CREATE OR REPLACE).

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

  -- NFT species: instance-aware planting
  IF v_def.edition_size IS NOT NULL THEN
    IF p_instance_id IS NULL THEN RAISE EXCEPTION 'nft_requires_instance'; END IF;

    SELECT * INTO v_nft_inst FROM public.farm_nft_instances
     WHERE id = p_instance_id AND species = p_species FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'nft_not_found'; END IF;
    IF v_nft_inst.owner_id <> v_user THEN RAISE EXCEPTION 'not_owner'; END IF;
    IF v_nft_inst.listed THEN RAISE EXCEPTION 'nft_listed'; END IF;

    -- Check this specific instance isn't already planted elsewhere
    IF EXISTS (SELECT 1 FROM public.farm_tiles WHERE planted_instance_id = p_instance_id) THEN
      RAISE EXCEPTION 'nft_already_planted';
    END IF;

    v_level := v_nft_inst.level;  -- level comes from the NFT instance itself
  ELSE
    -- Fungible card: lock the collection row so concurrent plant_crop calls
    -- for the same (user, species) serialize instead of racing.
    SELECT * INTO v_coll FROM public.farm_collection
     WHERE user_id = v_user AND species = p_species FOR UPDATE;
    IF v_coll IS NULL THEN RAISE EXCEPTION 'no_card'; END IF;

    v_level := v_coll.level;

    IF v_level >= 2 THEN
      -- Leveled cards are an unlimited seed: no cap on simultaneous plantings.
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

  -- Level speeds growth up (~8%/level) but never below the 24h floor
  v_grow_minutes := greatest(1440, v_def.base_grow_minutes * power(0.92, v_level - 1));
  v_ready := now() + (v_grow_minutes * interval '1 minute');

  UPDATE public.farm_tiles
     SET planted_species = p_species, planted_level = v_level,
         planted_at = now(), ready_at = v_ready,
         planted_instance_id = p_instance_id  -- NULL for fungible, UUID for NFT
   WHERE x = p_x AND y = p_y;

  RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'species', p_species,
    'level', v_level, 'ready_at', v_ready);
END;
$$;
