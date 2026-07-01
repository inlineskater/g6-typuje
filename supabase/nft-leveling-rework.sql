-- NFT Leveling Rework: Move level from farm_collection to farm_nft_instances
-- Run AFTER farm.sql and farm-marketplace.sql. Idempotent.
--
-- What this does:
--   • Adds `level` column to farm_nft_instances (the NFT now carries its own level)
--   • Adds `planted_instance_id` to farm_tiles (tracks which specific NFT is planted)
--   • Migrates existing leveled users (Ilo, Maciek, Adam) → level goes to lowest-serial NFT
--   • Resets farm_collection.level for NFT species (no longer the source of truth)
--   • Creates level_up_nft() RPC: merge two same-level NFTs into one higher-level NFT
--   • Updates plant_crop to read level from the NFT instance
--   • Updates open_farm_lootbox to stop incrementing farm_collection.count for NFTs
--   • Updates marketplace views to expose NFT level

-- ── Schema changes ─────────────────────────────────────────────────────────

-- 1. NFT instances now carry their own level
ALTER TABLE public.farm_nft_instances
  ADD COLUMN IF NOT EXISTS level integer NOT NULL DEFAULT 1;
DO $$ BEGIN
  ALTER TABLE public.farm_nft_instances
    ADD CONSTRAINT farm_nft_instances_level_chk CHECK (level >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Tiles track which specific NFT instance is planted (NULL for fungible cards)
ALTER TABLE public.farm_tiles
  ADD COLUMN IF NOT EXISTS planted_instance_id uuid;
DO $$ BEGIN
  ALTER TABLE public.farm_tiles
    ADD CONSTRAINT farm_tiles_planted_instance_fk
    FOREIGN KEY (planted_instance_id) REFERENCES public.farm_nft_instances(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Data migration ─────────────────────────────────────────────────────────

-- 3. Migrate existing leveled users: give L2 to their lowest-serial NFT
--    (Only Ilo/crystal_lotus, Maciek/diamond_rose, Adam/aeae_banana — all at L2)
UPDATE public.farm_nft_instances ni SET level = fc.level
FROM public.farm_collection fc, public.farm_card_defs d
WHERE fc.user_id = ni.owner_id
  AND fc.species = ni.species
  AND d.species = fc.species
  AND d.edition_size IS NOT NULL
  AND fc.level > 1
  AND ni.level = 1   -- don't re-apply on re-run
  AND ni.serial_no = (
    SELECT min(ni2.serial_no) FROM public.farm_nft_instances ni2
    WHERE ni2.owner_id = ni.owner_id AND ni2.species = ni.species
  );

-- 4. Reset farm_collection level for NFT species (level now lives on instance)
UPDATE public.farm_collection fc SET level = 1, count = 0
FROM public.farm_card_defs d
WHERE d.species = fc.species AND d.edition_size IS NOT NULL AND fc.level > 1;

-- 5. Backfill planted_instance_id for currently planted NFT tiles
UPDATE public.farm_tiles ft SET planted_instance_id = (
  SELECT ni.id FROM public.farm_nft_instances ni
  WHERE ni.owner_id = ft.owner_id AND ni.species = ft.planted_species AND NOT ni.listed
  ORDER BY ni.serial_no LIMIT 1
)
WHERE ft.planted_species IS NOT NULL
  AND ft.planted_instance_id IS NULL
  AND EXISTS (
    SELECT 1 FROM public.farm_card_defs d
    WHERE d.species = ft.planted_species AND d.edition_size IS NOT NULL
  );

-- ── RPC: level_up_nft (merge two same-level NFTs) ─────────────────────────
-- Merges two NFT instances of the same species and same level. The "hero"
-- survives and gains +1 level; the "fuel" is permanently destroyed.
-- Cost: 50 * current_level² coins (same formula as the old level_up_card).
CREATE OR REPLACE FUNCTION public.level_up_nft(p_hero_id uuid, p_fuel_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user   uuid := auth.uid();
  v_hero   public.farm_nft_instances%ROWTYPE;
  v_fuel   public.farm_nft_instances%ROWTYPE;
  v_cost   integer;
  v_coins  integer;
  v_new_level integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_hero_id = p_fuel_id THEN RAISE EXCEPTION 'same_instance'; END IF;

  -- Lock both in deterministic order to prevent deadlocks
  IF p_hero_id < p_fuel_id THEN
    SELECT * INTO v_hero FROM public.farm_nft_instances WHERE id = p_hero_id FOR UPDATE;
    SELECT * INTO v_fuel FROM public.farm_nft_instances WHERE id = p_fuel_id FOR UPDATE;
  ELSE
    SELECT * INTO v_fuel FROM public.farm_nft_instances WHERE id = p_fuel_id FOR UPDATE;
    SELECT * INTO v_hero FROM public.farm_nft_instances WHERE id = p_hero_id FOR UPDATE;
  END IF;

  -- Check each row var explicitly (NOT FOUND only reflects the last SELECT above,
  -- so a missing fuel would otherwise be mislabeled as 'hero_not_found').
  IF v_hero.id IS NULL THEN RAISE EXCEPTION 'hero_not_found'; END IF;
  IF v_fuel.id IS NULL THEN RAISE EXCEPTION 'fuel_not_found'; END IF;
  IF v_hero.owner_id <> v_user THEN RAISE EXCEPTION 'not_owner_hero'; END IF;
  IF v_fuel.owner_id <> v_user THEN RAISE EXCEPTION 'not_owner_fuel'; END IF;
  IF v_hero.species <> v_fuel.species THEN RAISE EXCEPTION 'different_species'; END IF;
  IF v_hero.level <> v_fuel.level THEN RAISE EXCEPTION 'different_level'; END IF;
  IF v_hero.listed THEN RAISE EXCEPTION 'hero_listed'; END IF;
  IF v_fuel.listed THEN RAISE EXCEPTION 'fuel_listed'; END IF;

  -- Neither can be currently planted
  IF EXISTS (SELECT 1 FROM public.farm_tiles WHERE planted_instance_id = p_hero_id) THEN
    RAISE EXCEPTION 'hero_planted';
  END IF;
  IF EXISTS (SELECT 1 FROM public.farm_tiles WHERE planted_instance_id = p_fuel_id) THEN
    RAISE EXCEPTION 'fuel_planted';
  END IF;

  v_cost := 50 * v_hero.level * v_hero.level;
  v_new_level := v_hero.level + 1;

  -- Charge coins
  UPDATE public.profiles SET coins = coins - v_cost
   WHERE id = v_user AND coins >= v_cost
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  -- Log provenance for the fuel (before destroying it)
  IF to_regclass('public.farm_nft_transfers') IS NOT NULL THEN
    INSERT INTO public.farm_nft_transfers (instance_id, species, serial_no, from_owner, to_owner, price, kind)
    VALUES (p_fuel_id, v_fuel.species, v_fuel.serial_no, v_user, NULL, v_cost, 'merge_fuel');
    INSERT INTO public.farm_nft_transfers (instance_id, species, serial_no, from_owner, to_owner, price, kind)
    VALUES (p_hero_id, v_hero.species, v_hero.serial_no, v_user, v_user, v_cost, 'merge_hero');
  END IF;

  -- Destroy the fuel NFT
  DELETE FROM public.farm_nft_instances WHERE id = p_fuel_id;

  -- Upgrade the hero NFT
  UPDATE public.farm_nft_instances SET level = v_new_level WHERE id = p_hero_id;

  -- Coin transaction log
  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_cost, 'card_levelup', jsonb_build_object(
      'species', v_hero.species, 'new_level', v_new_level,
      'hero_id', p_hero_id, 'hero_name', v_hero.nft_name, 'hero_serial', v_hero.serial_no,
      'fuel_id', p_fuel_id, 'fuel_name', v_fuel.nft_name, 'fuel_serial', v_fuel.serial_no
    ));
  END IF;

  RETURN json_build_object(
    'ok', true, 'coins', v_coins, 'species', v_hero.species,
    'new_level', v_new_level, 'hero_id', p_hero_id,
    'hero_name', v_hero.nft_name, 'hero_serial', v_hero.serial_no,
    'fuel_name', v_fuel.nft_name, 'fuel_serial', v_fuel.serial_no
  );
END;
$$;

-- ── Update farm_nft_transfers to accept new kind values ────────────────────
DO $$ BEGIN
  ALTER TABLE public.farm_nft_transfers DROP CONSTRAINT IF EXISTS farm_nft_transfers_kind_check;
  ALTER TABLE public.farm_nft_transfers
    ADD CONSTRAINT farm_nft_transfers_kind_check CHECK (kind IN ('mint','sale','merge_fuel','merge_hero'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A 'merge_fuel' provenance row records a BURNED card, so it has no recipient
-- (to_owner = NULL). The column was originally NOT NULL (every transfer used to
-- have a recipient); relax it to match from_owner (nullable for 'mint' rows).
-- Without this the merge INSERT fails and the whole level_up_nft txn rolls back.
ALTER TABLE public.farm_nft_transfers ALTER COLUMN to_owner DROP NOT NULL;

-- ── Update plant_crop to read level from NFT instance ──────────────────────
-- Replaces the function from farm-plant-once-fix.sql to support instance-aware planting.
CREATE OR REPLACE FUNCTION public.plant_crop(p_x integer, p_y integer, p_species text, p_instance_id uuid DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user         uuid := auth.uid();
  v_tile         public.farm_tiles%ROWTYPE;
  v_def          public.farm_card_defs%ROWTYPE;
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
    -- Fungible card: unchanged behavior
    SELECT level INTO v_level FROM public.farm_collection
     WHERE user_id = v_user AND species = p_species;
    IF v_level IS NULL THEN RAISE EXCEPTION 'no_card'; END IF;

    SELECT COALESCE(count, 0) INTO v_owned
      FROM public.farm_collection
     WHERE user_id = v_user AND species = p_species;
    IF v_level >= 2 THEN v_owned := GREATEST(COALESCE(v_owned, 0), 1); END IF;
    IF COALESCE(v_owned, 0) < 1 THEN RAISE EXCEPTION 'no_card'; END IF;

    SELECT count(*) INTO v_planted
      FROM public.farm_tiles
     WHERE owner_id = v_user AND planted_species = p_species;
    IF v_planted >= v_owned THEN RAISE EXCEPTION 'no_free_card'; END IF;
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

-- ── Update harvest_crop to clear planted_instance_id ───────────────────────
-- Redefined here (not in farm.sql) because farm.sql runs BEFORE the
-- planted_instance_id column is added above. Without clearing it, a harvested
-- NFT crop leaves the tile still pointing at the instance, so the NFT is treated
-- as permanently planted (can't merge, list, or re-plant it). Only the closing
-- UPDATE differs from the farm.sql original — the NFT instance is freed.
CREATE OR REPLACE FUNCTION public.harvest_crop(p_x integer, p_y integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_tile  public.farm_tiles%ROWTYPE;
  v_def   public.farm_card_defs%ROWTYPE;
  v_yield integer;
  v_exp   timestamptz;
  v_qty   integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_tile FROM public.farm_tiles WHERE x = p_x AND y = p_y FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tile_not_owned'; END IF;
  IF v_tile.owner_id <> v_user THEN RAISE EXCEPTION 'not_your_tile'; END IF;
  IF v_tile.planted_species IS NULL THEN RAISE EXCEPTION 'tile_empty'; END IF;
  IF v_tile.ready_at IS NULL OR now() < v_tile.ready_at THEN RAISE EXCEPTION 'not_ready'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_tile.planted_species;
  IF NOT FOUND THEN RAISE EXCEPTION 'bad_species'; END IF;

  v_yield := round(v_def.base_yield * (1 + (v_tile.planted_level - 1) * 0.5))::integer;
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

-- ── Update open_farm_lootbox: skip farm_collection.count for NFT species ───
-- ⚠️ SUPERSEDED by nft-merge-fixes.sql, which re-derives serials/supply from
--    farm_card_defs.minted_count (live-instance counts break after merges burn
--    cards). Re-run nft-merge-fixes.sql after re-running this file.
-- farm_collection is no longer the source of truth for NFT levels (the level
-- now lives on the individual farm_nft_instances row), so an NFT draw must not
-- create/increment a farm_collection row anymore. The only change from the
-- farm.sql original is wrapping that INSERT in an edition_size IS NULL check
-- (with an explicit ELSE so v_new_count doesn't leak a stale value from a
-- prior loop iteration into this card's JSON result). Everything else
-- (odds, dedup, NFT mint block) is reproduced verbatim.
CREATE OR REPLACE FUNCTION public.open_farm_lootbox()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_draws     constant integer := 3;       -- cards per box (keep in sync with index.html)
  v_voucher_p constant numeric := 0.07;    -- base natural chance for a free-tile voucher
  v_coins     integer;
  v_boxes     integer;
  v_vouchers  integer := 0;
  v_tiles     integer := 0;
  v_territory integer := 0;
  v_owned_nfts integer := 0;
  v_eff_voucher_p numeric := 0;
  v_got_vch   boolean := false;
  v_starter   integer := 0;       -- starter openings remaining (guarantee window)
  v_guar      boolean := false;   -- a tile voucher is still guaranteed within the window
  v_drop_vch  boolean := false;
  v_eligible  integer;
  v_target    integer;
  v_got       integer := 0;
  v_attempts  integer := 0;
  v_total     numeric;
  v_roll      numeric;
  v_species   text;
  v_def       public.farm_card_defs%ROWTYPE;
  v_new_count integer;
  v_minted    integer;
  v_serial    integer;
  v_nft_idx   integer;
  v_nft_name  text;
  v_nft_id    uuid;
  v_picked    text[] := ARRAY[]::text[];
  v_cards     jsonb  := '[]'::jsonb;
  v_card      jsonb;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  -- Consume one sealed box (bought earlier via buy_farm_lootbox, or the starter gift).
  UPDATE public.farm_user_state SET boxes = boxes - 1
   WHERE user_id = v_user AND boxes >= 1
  RETURNING boxes, tile_vouchers, starter_opens_left, guaranteed_voucher
       INTO v_boxes, v_vouchers, v_starter, v_guar;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_box'; END IF;
  SELECT coins INTO v_coins FROM public.profiles WHERE id = v_user;
  SELECT count(*) INTO v_owned_nfts FROM public.farm_nft_instances WHERE owner_id = v_user;
  SELECT count(*) INTO v_tiles FROM public.farm_tiles
   WHERE owner_id = v_user AND acquired_via <> 'migration';
  v_territory := v_tiles + COALESCE(v_vouchers, 0);
  v_eff_voucher_p := v_voucher_p / power(3::numeric, greatest(v_territory, 0));

  -- Eligible = active + weighted, and either uncapped OR an NFT edition with supply left.
  SELECT count(*) INTO v_eligible
    FROM public.farm_card_defs d
   WHERE d.is_active AND d.draw_weight > 0
     AND (d.edition_size IS NULL
          OR (SELECT count(*) FROM public.farm_nft_instances ni WHERE ni.species = d.species) < d.edition_size);
  IF v_eligible = 0 THEN RAISE EXCEPTION 'pool_empty'; END IF;
  v_target := least(v_draws, v_eligible);

  -- Draw distinct cards; NFTs get a freshly minted serial. A sold-out edition that
  -- slips through (race) is excluded and we redraw (bounded attempts).
  WHILE v_got < v_target AND v_attempts < 40 LOOP
    v_attempts := v_attempts + 1;

    SELECT sum(CASE WHEN d.edition_size IS NOT NULL
                    THEN d.draw_weight::numeric / power(3::numeric, v_owned_nfts)
                    ELSE d.draw_weight::numeric END)
      INTO v_total
      FROM public.farm_card_defs d
     WHERE d.is_active AND d.draw_weight > 0 AND d.species <> ALL(v_picked)
       AND (d.edition_size IS NULL
            OR (SELECT count(*) FROM public.farm_nft_instances ni WHERE ni.species = d.species) < d.edition_size);
    EXIT WHEN v_total IS NULL OR v_total <= 0;

    v_roll := random() * v_total;
    SELECT species INTO v_species FROM (
      SELECT d.species,
             sum(CASE WHEN d.edition_size IS NOT NULL
                      THEN d.draw_weight::numeric / power(3::numeric, v_owned_nfts)
                      ELSE d.draw_weight::numeric END)
             OVER (ORDER BY d.species) AS cum
        FROM public.farm_card_defs d
       WHERE d.is_active AND d.draw_weight > 0 AND d.species <> ALL(v_picked)
         AND (d.edition_size IS NULL
              OR (SELECT count(*) FROM public.farm_nft_instances ni WHERE ni.species = d.species) < d.edition_size)
    ) q
    WHERE q.cum > v_roll
    ORDER BY q.cum
    LIMIT 1;
    EXIT WHEN v_species IS NULL;

    SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_species FOR UPDATE;
    v_picked := array_append(v_picked, v_species);

    IF v_def.edition_size IS NOT NULL THEN
      -- NFT: re-check supply under the row lock, then mint the next serial number
      SELECT count(*) INTO v_minted FROM public.farm_nft_instances WHERE species = v_species;
      IF v_minted >= v_def.edition_size THEN
        CONTINUE;   -- sold out (race); already excluded via v_picked, try another card
      END IF;
      v_serial := v_minted + 1;
      -- unique funny name from the species' persona pool, by per-pool mint order
      SELECT count(*) INTO v_nft_idx FROM public.farm_nft_instances ni
       WHERE public.farm_nft_pool(ni.species) = public.farm_nft_pool(v_species);
      v_nft_name := public.farm_nft_persona(v_species, v_nft_idx);
      INSERT INTO public.farm_nft_instances (species, serial_no, edition_size, owner_id, acquired_from, nft_name)
      VALUES (v_species, v_serial, v_def.edition_size, v_user, 'lootbox', v_nft_name)
      RETURNING id INTO v_nft_id;
      -- provenance log (farm-marketplace.sql); guarded so farm.sql stands alone
      IF to_regclass('public.farm_nft_transfers') IS NOT NULL THEN
        INSERT INTO public.farm_nft_transfers (instance_id, species, serial_no, from_owner, to_owner, price, kind)
        VALUES (v_nft_id, v_species, v_serial, NULL, v_user, NULL, 'mint');
      END IF;
      v_owned_nfts := v_owned_nfts + 1; -- same box gets lower odds for another NFT draw
    END IF;

    -- NFT level now lives on farm_nft_instances, not farm_collection — only
    -- fungible (non-NFT) species get a farm_collection row/increment here.
    IF v_def.edition_size IS NULL THEN
      INSERT INTO public.farm_collection (user_id, species, count, level)
      VALUES (v_user, v_species, 1, 1)
      ON CONFLICT (user_id, species) DO UPDATE SET count = farm_collection.count + 1
      RETURNING count INTO v_new_count;
    ELSE
      v_new_count := NULL;
    END IF;

    v_card := jsonb_build_object(
      'species', v_species, 'name', v_def.name, 'emoji', v_def.emoji,
      'rarity', v_def.rarity, 'new_count', v_new_count);
    IF v_def.edition_size IS NOT NULL THEN
      v_card := v_card || jsonb_build_object('nft', true, 'id', v_nft_id, 'serial_no', v_serial, 'edition_size', v_def.edition_size, 'nft_name', v_nft_name);
    END IF;
    v_cards := v_cards || v_card;
    v_got := v_got + 1;
  END LOOP;

  -- Free-tile voucher: natural odds shrink with existing territory. The starter
  -- guarantee only survives while the player has no tile and no held voucher.
  IF v_guar AND v_territory > 0 THEN v_guar := false; END IF;
  IF v_starter > 0 THEN v_starter := v_starter - 1; END IF;
  v_drop_vch := (random() < v_eff_voucher_p) OR (v_guar AND v_starter = 0);
  IF v_drop_vch AND v_guar THEN v_guar := false; END IF;  -- guarantee satisfied

  UPDATE public.farm_user_state
     SET tile_vouchers = tile_vouchers + (CASE WHEN v_drop_vch THEN 1 ELSE 0 END),
         starter_opens_left = v_starter, guaranteed_voucher = v_guar
   WHERE user_id = v_user
  RETURNING tile_vouchers INTO v_vouchers;
  IF v_drop_vch THEN
    v_got_vch := true;
    v_cards := v_cards || jsonb_build_object('voucher', true);
  END IF;

  RETURN json_build_object('ok', true, 'coins', v_coins, 'boxes', v_boxes,
    'tile_vouchers', v_vouchers, 'got_voucher', v_got_vch, 'cards', v_cards);
END;
$$;

-- ── Update level_up_card: reject NFT species ────────────────────────────────
-- The old per-species farm_collection.level field is dead for NFT species (the
-- level now lives on each farm_nft_instances row). Block this RPC from being
-- called on an NFT species so it can't silently write a no-op level into a
-- field nothing reads anymore — NFT leveling goes through level_up_nft (merge).
-- The guard runs BEFORE the farm_collection lookup so a brand-new NFT owner
-- (who may have no farm_collection row at all) gets the real error instead of
-- a misleading 'no_card'.
CREATE OR REPLACE FUNCTION public.level_up_card(p_species text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user         uuid := auth.uid();
  v_def          public.farm_card_defs%ROWTYPE;
  v_row          public.farm_collection%ROWTYPE;
  v_dupes_needed integer;
  v_coin_cost    integer;
  v_coins        integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = p_species;
  IF FOUND AND v_def.edition_size IS NOT NULL THEN RAISE EXCEPTION 'nft_use_level_up_nft'; END IF;

  SELECT * INTO v_row FROM public.farm_collection
   WHERE user_id = v_user AND species = p_species FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_card'; END IF;

  v_dupes_needed := 2 * v_row.level;
  v_coin_cost    := 50 * v_row.level * v_row.level;

  IF v_row.count < v_dupes_needed THEN RAISE EXCEPTION 'not_enough_cards'; END IF;

  UPDATE public.profiles SET coins = coins - v_coin_cost
   WHERE id = v_user AND coins >= v_coin_cost
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  UPDATE public.farm_collection
     SET count = count - v_dupes_needed, level = level + 1
   WHERE user_id = v_user AND species = p_species;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_coin_cost, 'card_levelup', jsonb_build_object('species', p_species, 'new_level', v_row.level + 1));
  END IF;

  RETURN json_build_object('ok', true, 'coins', v_coins, 'species', p_species,
    'level', v_row.level + 1, 'count', v_row.count - v_dupes_needed);
END;
$$;

-- ── Update create_farm_nft_listing: include level in title ──────────────────
CREATE OR REPLACE FUNCTION public.create_farm_nft_listing(
  p_instance_id uuid, p_listing_type text, p_price integer,
  p_duration_hours integer DEFAULT 72, p_min_increment integer DEFAULT 10)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_inst  public.farm_nft_instances%ROWTYPE;
  v_def   public.farm_card_defs%ROWTYPE;
  v_dur   integer := LEAST(GREATEST(COALESCE(p_duration_hours, 72), 1), 720);
  v_incr  integer := LEAST(GREATEST(COALESCE(p_min_increment, 10), 1), 1000000);
  v_ends  timestamptz;
  v_id    uuid;
  v_title text;
  v_stars text;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_listing_type NOT IN ('fixed','auction') THEN RAISE EXCEPTION 'bad_listing_type'; END IF;
  IF p_price IS NULL OR p_price < 1 THEN RAISE EXCEPTION 'bad_price'; END IF;

  SELECT * INTO v_inst FROM public.farm_nft_instances WHERE id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'nft_not_found'; END IF;
  IF v_inst.owner_id <> v_user THEN RAISE EXCEPTION 'not_owner'; END IF;
  IF v_inst.listed THEN RAISE EXCEPTION 'already_listed'; END IF;

  -- Can't list an NFT that's currently planted
  IF EXISTS (SELECT 1 FROM public.farm_tiles WHERE planted_instance_id = p_instance_id) THEN
    RAISE EXCEPTION 'nft_planted';
  END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_inst.species;
  IF p_listing_type = 'auction' THEN v_ends := now() + (v_dur || ' hours')::interval; END IF;

  UPDATE public.farm_nft_instances SET listed = true WHERE id = p_instance_id;

  -- Build title with level stars
  v_stars := CASE WHEN v_inst.level > 1 THEN ' ' || repeat('⭐', v_inst.level) ELSE '' END;
  v_title := COALESCE(v_inst.nft_name, v_def.name) || ' #' || v_inst.serial_no || '/' || v_inst.edition_size || v_stars;

  INSERT INTO public.marketplace_listings
    (seller_id, emoji, title, description, listing_type, price, min_increment, ends_at, item_kind, nft_instance_id)
  VALUES (
    v_user, COALESCE(v_def.emoji, '💎'),
    v_title,
    'Karta NFT: ' || v_def.name || ' (limitowana, numerowana).' || CASE WHEN v_inst.level > 1 THEN ' Poziom ' || v_inst.level || '.' ELSE '' END,
    p_listing_type, p_price, v_incr, v_ends, 'farm_nft', p_instance_id)
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'listing_id', v_id);
END;
$$;

-- ── Update marketplace_cards view: expose nft_level ─────────────────────────
DROP VIEW IF EXISTS public.marketplace_cards;
CREATE OR REPLACE VIEW public.marketplace_cards AS
SELECT
  l.id, l.seller_id, sp.nick AS seller_nick, l.emoji, l.title, l.description,
  l.listing_type, l.price, l.min_increment, l.ends_at, l.status, l.buyer_id,
  bp.nick AS buyer_nick, l.final_price, l.created_at, l.settled_at,
  COALESCE(l.final_price, lb.amount) AS current_bid,
  COALESCE(l.buyer_id, lb.bidder_id) AS current_bidder_id,
  lbp.nick AS current_bidder_nick,
  CASE
    WHEN l.listing_type = 'auction' AND l.status = 'open' AND lb.amount IS NOT NULL THEN lb.amount + l.min_increment
    WHEN l.listing_type = 'auction' AND l.status = 'open' THEN l.price
    ELSE NULL
  END AS next_min_bid,
  tb.top_bidders,
  -- item linkage (NULL for plain IRL goods)
  l.item_kind, l.nft_instance_id, l.card_species, l.farm_tile_x, l.farm_tile_y,
  ni.serial_no    AS nft_serial,
  ni.edition_size AS nft_edition,
  ni.nft_name     AS nft_name,
  ni.level        AS nft_level,
  ft.asset_value  AS farm_tile_asset_value
FROM public.marketplace_listings l
JOIN public.profiles sp ON sp.id = l.seller_id
LEFT JOIN public.profiles bp ON bp.id = l.buyer_id
LEFT JOIN public.farm_nft_instances ni ON ni.id = l.nft_instance_id
LEFT JOIN public.farm_tiles ft ON ft.x = l.farm_tile_x AND ft.y = l.farm_tile_y
LEFT JOIN LATERAL (
  SELECT b.bidder_id, b.amount FROM public.marketplace_bids b
   WHERE b.listing_id = l.id AND b.status IN ('leading','won')
   ORDER BY b.amount DESC, b.created_at ASC LIMIT 1
) lb ON true
LEFT JOIN public.profiles lbp ON lbp.id = lb.bidder_id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('nick', p.nick, 'amount', top.max_amount) ORDER BY top.max_amount DESC) AS top_bidders
  FROM (
    SELECT b.bidder_id, MAX(b.amount) AS max_amount FROM public.marketplace_bids b
     WHERE b.listing_id = l.id GROUP BY b.bidder_id ORDER BY max_amount DESC LIMIT 3
  ) top JOIN public.profiles p ON p.id = top.bidder_id
) tb ON true
WHERE l.status = 'open' OR l.created_at > now() - interval '14 days';

GRANT SELECT ON public.marketplace_cards TO anon, authenticated;

-- ── Update economy-stats: NFT valuation factors in level ───────────────────
-- The NFT scarcity formula was: round(20000.0 / ni.edition_size)
-- Now: round(20000.0 / ni.edition_size * ni.level)
-- This is applied via the economy-stats.sql view; we note it here for reference.
-- The actual view needs to be re-created from economy-stats.sql with the updated formula.

-- ── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.level_up_nft(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.level_up_nft(uuid, uuid) TO authenticated;

-- plant_crop now has a new signature with optional p_instance_id
REVOKE ALL ON FUNCTION public.plant_crop(integer, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plant_crop(integer, integer, text, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
