-- Farm: enforce "one plant card can be planted only once at a time"
-- =================================================================
-- Bug: plant_crop() only checked that a farm_collection row existed; it never compared
-- how many tiles already hold a species against how many cards the player owns, and
-- planting never reserved/consumed a card. So a single card (incl. a unique NFT) could be
-- planted on unlimited tiles at once, and a card could be sold while still planted.
--
-- Rule enforced here: for every species, currently-planted tiles <= cards owned.
-- A card frees up for replanting when its tile is harvested (harvest_crop clears the tile).
--
-- Owned-count source:
--   * regular card (farm_card_defs.edition_size IS NULL): farm_collection.count
--     (authoritative: listing decrements, buying increments; it includes planted copies).
--   * NFT card (edition_size IS NOT NULL): count of un-listed farm_nft_instances owned
--     (farm_collection.count is stale for NFTs — it is not updated on sale).
--
-- Idempotent: CREATE OR REPLACE + a one-time targeted cleanup. Paste into the Supabase
-- SQL Editor (this feature is not wired through the repo migration flow).

-- ── 1. plant_crop — block planting more copies than you own ─────────────────

CREATE OR REPLACE FUNCTION public.plant_crop(p_x integer, p_y integer, p_species text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user         uuid := auth.uid();
  v_tile         public.farm_tiles%ROWTYPE;
  v_def          public.farm_card_defs%ROWTYPE;
  v_level        integer;
  v_owned        integer;
  v_planted      integer;
  v_grow_minutes numeric;
  v_ready        timestamptz;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_tile FROM public.farm_tiles WHERE x = p_x AND y = p_y FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tile_not_owned'; END IF;
  IF v_tile.owner_id <> v_user THEN RAISE EXCEPTION 'not_your_tile'; END IF;
  IF v_tile.acquired_via = 'migration' THEN RAISE EXCEPTION 'zen_tile'; END IF;  -- plant block, not farmland
  IF v_tile.planted_species IS NOT NULL THEN RAISE EXCEPTION 'tile_occupied'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = p_species AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'bad_species'; END IF;

  -- planted_level mirrors the collection level (default 1 if no collection row, e.g. NFT-only)
  SELECT level INTO v_level FROM public.farm_collection
   WHERE user_id = v_user AND species = p_species;
  v_level := COALESCE(v_level, 1);

  -- How many of this card the player owns (see header for why the source differs).
  IF v_def.edition_size IS NOT NULL THEN
    SELECT count(*) INTO v_owned
      FROM public.farm_nft_instances
     WHERE owner_id = v_user AND species = p_species AND NOT listed;
  ELSE
    SELECT COALESCE(count, 0) INTO v_owned
      FROM public.farm_collection
     WHERE user_id = v_user AND species = p_species;
    -- A leveled card (>=L2) IS the upgraded card you still hold: always >=1 plantable,
    -- even after level_up_card drained the dupe fuel to 0. (Level-1 cards sold down to
    -- count=0 own nothing and correctly stay 'no_card'.)
    IF v_level >= 2 THEN v_owned := GREATEST(COALESCE(v_owned, 0), 1); END IF;
  END IF;
  IF COALESCE(v_owned, 0) < 1 THEN RAISE EXCEPTION 'no_card'; END IF;

  -- "One card -> one planted tile at a time." The target tile is empty (checked above)
  -- and row-locked, so it is not yet part of this count.
  SELECT count(*) INTO v_planted
    FROM public.farm_tiles
   WHERE owner_id = v_user AND planted_species = p_species;
  IF v_planted >= v_owned THEN RAISE EXCEPTION 'no_free_card'; END IF;

  -- Level speeds growth up (~8%/level) but never below the 24h floor: harvests
  -- happen at most once a day. Keep GROW_FLOOR_MIN (1440) in sync with index.html.
  v_grow_minutes := greatest(1440, v_def.base_grow_minutes * power(0.92, v_level - 1));
  v_ready := now() + (v_grow_minutes * interval '1 minute');

  UPDATE public.farm_tiles
     SET planted_species = p_species, planted_level = v_level,
         planted_at = now(), ready_at = v_ready
   WHERE x = p_x AND y = p_y;

  RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'species', p_species,
    'level', v_level, 'ready_at', v_ready);
END;
$function$;

-- ── 2. create_farm_card_listing — can't sell a planted regular card ─────────

CREATE OR REPLACE FUNCTION public.create_farm_card_listing(p_species text, p_listing_type text, p_price integer, p_duration_hours integer DEFAULT 72, p_min_increment integer DEFAULT 10)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user    uuid := auth.uid();
  v_def     public.farm_card_defs%ROWTYPE;
  v_cnt     integer;
  v_planted integer;
  v_dur     integer := LEAST(GREATEST(COALESCE(p_duration_hours, 72), 1), 720);
  v_incr    integer := LEAST(GREATEST(COALESCE(p_min_increment, 10), 1), 1000000);
  v_ends    timestamptz;
  v_id      uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_listing_type NOT IN ('fixed','auction') THEN RAISE EXCEPTION 'bad_listing_type'; END IF;
  IF p_price IS NULL OR p_price < 1 THEN RAISE EXCEPTION 'bad_price'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = p_species;
  IF NOT FOUND THEN RAISE EXCEPTION 'bad_species'; END IF;
  IF v_def.edition_size IS NOT NULL THEN RAISE EXCEPTION 'use_nft_listing'; END IF; -- NFTs go via instance

  -- A copy that is currently keeping a tile planted cannot be sold out from under it.
  SELECT count(*) INTO v_planted
    FROM public.farm_tiles
   WHERE owner_id = v_user AND planted_species = p_species;

  -- reserve one *free* duplicate (count must stay >= planted; claim first, rolls back on failure)
  UPDATE public.farm_collection SET count = count - 1
   WHERE user_id = v_user AND species = p_species AND count > v_planted
  RETURNING count INTO v_cnt;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.farm_collection
                WHERE user_id = v_user AND species = p_species AND count >= 1) THEN
      RAISE EXCEPTION 'card_planted';   -- owns copies, but all are planted
    ELSE
      RAISE EXCEPTION 'no_duplicate';   -- owns none to sell
    END IF;
  END IF;

  IF p_listing_type = 'auction' THEN v_ends := now() + (v_dur || ' hours')::interval; END IF;

  INSERT INTO public.marketplace_listings
    (seller_id, emoji, title, description, listing_type, price, min_increment, ends_at, item_kind, card_species)
  VALUES (
    v_user, COALESCE(v_def.emoji, '🃏'),
    v_def.name || ' (karta rośliny)',
    'Duplikat karty rośliny „' || v_def.name || '" (poziom 1).',
    p_listing_type, p_price, v_incr, v_ends, 'farm_card', p_species)
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'listing_id', v_id, 'count_left', v_cnt);
END;
$function$;

-- ── 3. create_farm_nft_listing — can't sell a planted NFT ───────────────────

CREATE OR REPLACE FUNCTION public.create_farm_nft_listing(p_instance_id uuid, p_listing_type text, p_price integer, p_duration_hours integer DEFAULT 72, p_min_increment integer DEFAULT 10)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user    uuid := auth.uid();
  v_inst    public.farm_nft_instances%ROWTYPE;
  v_def     public.farm_card_defs%ROWTYPE;
  v_owned   integer;
  v_planted integer;
  v_dur     integer := LEAST(GREATEST(COALESCE(p_duration_hours, 72), 1), 720);
  v_incr    integer := LEAST(GREATEST(COALESCE(p_min_increment, 10), 1), 1000000);
  v_ends    timestamptz;
  v_id      uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_listing_type NOT IN ('fixed','auction') THEN RAISE EXCEPTION 'bad_listing_type'; END IF;
  IF p_price IS NULL OR p_price < 1 THEN RAISE EXCEPTION 'bad_price'; END IF;

  SELECT * INTO v_inst FROM public.farm_nft_instances WHERE id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'nft_not_found'; END IF;
  IF v_inst.owner_id <> v_user THEN RAISE EXCEPTION 'not_owner'; END IF;
  IF v_inst.listed THEN RAISE EXCEPTION 'already_listed'; END IF;

  -- Selling this instance must still leave enough owned copies to back every planted tile
  -- of the species (this still-un-listed instance is included in v_owned).
  SELECT count(*) INTO v_owned
    FROM public.farm_nft_instances
   WHERE owner_id = v_user AND species = v_inst.species AND NOT listed;
  SELECT count(*) INTO v_planted
    FROM public.farm_tiles
   WHERE owner_id = v_user AND planted_species = v_inst.species;
  IF (v_owned - 1) < v_planted THEN RAISE EXCEPTION 'card_planted'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_inst.species;
  IF p_listing_type = 'auction' THEN v_ends := now() + (v_dur || ' hours')::interval; END IF;

  UPDATE public.farm_nft_instances SET listed = true WHERE id = p_instance_id;

  INSERT INTO public.marketplace_listings
    (seller_id, emoji, title, description, listing_type, price, min_increment, ends_at, item_kind, nft_instance_id)
  VALUES (
    v_user, COALESCE(v_def.emoji, '💎'),
    COALESCE(v_inst.nft_name, v_def.name) || ' #' || v_inst.serial_no || '/' || v_inst.edition_size,
    'Karta NFT: ' || v_def.name || ' (limitowana, numerowana).',
    p_listing_type, p_price, v_incr, v_ends, 'farm_nft', p_instance_id)
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'listing_id', v_id);
END;
$function$;

-- ── 4. One-time cleanup: Adam's excess diamond_rose tile ────────────────────
-- Adam owns 1 diamond_rose (NFT "Dobrawa") but has it planted on 2 tiles. Keep the tile
-- closest to harvest (earliest planted_at) and clear the rest. Targeted on purpose — a
-- blanket "planted > owned" sweep would also clear Filip's corn, which is legitimate
-- (its count reached 0 via level_up_card, not via this bug).
WITH adam AS (SELECT id FROM public.profiles WHERE nick = 'Adam'),
ranked AS (
  SELECT t.x, t.y,
         row_number() OVER (ORDER BY t.planted_at ASC NULLS LAST, t.x, t.y) AS rn
    FROM public.farm_tiles t
    JOIN adam ON adam.id = t.owner_id
   WHERE t.planted_species = 'diamond_rose'
)
UPDATE public.farm_tiles t
   SET planted_species = NULL, planted_level = NULL, planted_at = NULL, ready_at = NULL
  FROM ranked r
 WHERE t.x = r.x AND t.y = r.y AND r.rn > 1;

NOTIFY pgrst, 'reload schema';
