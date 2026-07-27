-- ════════════════════════════════════════════════════════════════════════════
--  Farma — hybrid synergy measured in COINS/DAY, not units  (breeding fix)
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER: farm-nft-breeding.sql (whose copies of farm_hybrid_stats and
--  breed_nft are SUPERSEDED by this file — re-run this after re-running that).
--  Idempotent.
--
--  THE BUG
--  -------
--  „Krzyżowanie kart: … jedna hybryda, lepsza od obu rodziców" was false for the
--  only stat players actually optimise: ≈ Zysk/doba.
--
--  The old synergy guaranteed +15% UNITS and −5% grow time. But every hybrid
--  species harvests crop_type 'seasonal_bloom' (base_price 50), while the premium
--  parents harvest their own dedicated crops:
--
--      aeae_banana 120   crystal_lotus 80   golden_sunflower 55   diamond_rose 40
--
--  So a hybrid grew MORE units of a MUCH cheaper crop and earned less per day than
--  the parents it burned. Real case: Królewski Banan Ae Ae poz.2 (180 szt. / 88.3 h
--  / ≈5870🪙 per day) × Kryształowy Lotos poz.1 (≈2000🪙) produced a Rajski Lotos of
--  207 szt. / 83.9 h / ≈2961🪙 — half the income of parent A, for two burned NFTs
--  plus a coin cost.
--
--  THE FIX
--  -------
--  Derive the hybrid's per-instance yield from parent INCOME instead of parent unit
--  count, correcting for the difference in crop price:
--
--      grow  = max(1440, floor(min(parentGrow) × 0.95))          -- unchanged
--      yield = ceil(max(parentIncomePerDay) × 1.15 × days / hybridCropPrice)
--
--  so the hybrid out-EARNS the better parent by 15% whatever crops are involved.
--  Parent stats are the EFFECTIVE, level-scaled ones (a poz.2 parent really yields
--  base×1.5 and grows in base×0.92 time), so burning a levelled parent is correctly
--  priced in — comparing base stats would let the hybrid come out weaker.
--
--  Two floors keep the result sane for cheap/odd pairs:
--    · never fewer units than the old rule promised — ceil(max(parentYield) × 1.15)
--    · never below the hybrid species' own catalogue base_yield
--
--  Generalises to every pair, including the „Dziki Mieszaniec" catch-all and
--  hybrid × hybrid chains, because it reads whatever crop price the result carries.
--  No schema change: stat_yield / stat_grow_minutes already exist, and plant_crop /
--  harvest_crop already COALESCE onto them.
--
--  Existing hybrids are NOT retro-fitted (only 3 have ever been bred); this changes
--  what future breeds mint.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Synergy preview / mint stats ───────────────────────────────────────────
-- Gains a 3rd argument, so breed_nft can pass the species it ACTUALLY resolved
-- (a sold-out curated edition falls back to wild_hybrid, which may price its crop
-- differently). The 2-arg form is dropped rather than left alongside, so no
-- ambiguous overload can be resolved by accident.
DROP FUNCTION IF EXISTS public.farm_hybrid_stats(uuid, uuid);

CREATE OR REPLACE FUNCTION public.farm_hybrid_stats(p_a uuid, p_b uuid, p_hybrid text DEFAULT NULL)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH p AS (
    -- EFFECTIVE (level-scaled) parent stats + the price of the crop each one
    -- actually harvests. Unrounded on purpose: the client mirror rounds only for
    -- display, and rounding here would drift the two previews apart.
    SELECT i.species,
           COALESCE(i.stat_yield, d.base_yield) * (1 + (i.level - 1) * 0.5) AS y,
           GREATEST(1440, COALESCE(i.stat_grow_minutes, d.base_grow_minutes)
                          * power(0.92, i.level - 1)) AS g,
           COALESCE(m.base_price, 0) AS price
      FROM public.farm_nft_instances i
      JOIN public.farm_card_defs d ON d.species = i.species
      LEFT JOIN public.farm_market m ON m.crop_type = d.crop_type
     WHERE i.id IN (p_a, p_b)
  ),
  agg AS (
    SELECT max(y) AS max_y,
           min(g) AS min_g,
           max(y * price / (g / 1440.0)) AS best_income,   -- coins/day, per parent
           min(species) AS sp_lo,
           max(species) AS sp_hi
      FROM p
  ),
  -- Resolve the result species exactly like breed_nft: curated recipe for the
  -- unordered pair, else the „Dziki Mieszaniec" catch-all.
  h AS (
    SELECT COALESCE(
             p_hybrid,
             (SELECT r.hybrid_species FROM public.farm_hybrid_recipes r
               WHERE r.a_species = agg.sp_lo AND r.b_species = agg.sp_hi),
             'wild_hybrid') AS species
      FROM agg
  ),
  hd AS (
    SELECT h.species, d.base_yield, COALESCE(m.base_price, 0) AS price
      FROM h
      JOIN public.farm_card_defs d ON d.species = h.species
      LEFT JOIN public.farm_market m ON m.crop_type = d.crop_type
  ),
  calc AS (
    SELECT hd.species, hd.price, hd.base_yield,
           GREATEST(1440, floor(agg.min_g * 0.95)) AS grow,
           agg.max_y, agg.min_g, agg.best_income
      FROM agg, hd
  ),
  final AS (
    SELECT c.*,
           GREATEST(
             -- income parity: out-earn the better parent by 15% at the hybrid's
             -- own crop price (the −1e-9 keeps ceil() identical to the JS mirror
             -- when the quotient lands exactly on an integer)
             CASE WHEN c.price > 0
                  THEN ceil(c.best_income * 1.15 * (c.grow / 1440.0) / c.price - 1e-9)
                  ELSE 0 END,
             ceil(c.max_y * 1.15 - 1e-9),        -- floor: the old unit promise
             c.base_yield                        -- floor: the catalogue card
           ) AS yield
      FROM calc c
  )
  SELECT json_build_object(
    'yield',               yield::int,
    'grow_minutes',        grow::int,
    'hybrid_species',      species,
    'hybrid_price',        price::int,
    'per_day',             CASE WHEN price > 0
                                THEN round(yield * price / (grow / 1440.0))::int
                                ELSE NULL END,
    'parent_max_yield',    max_y::int,
    'parent_min_grow',     min_g::int,
    'parent_best_per_day', round(best_income)::int)
  FROM final;
$$;
GRANT EXECUTE ON FUNCTION public.farm_hybrid_stats(uuid, uuid, text) TO authenticated;

-- ── breed_nft: pass the RESOLVED hybrid species to the stats function ──────
-- Verbatim copy of the farm-nft-breeding.sql definition with one change: the
-- farm_hybrid_stats call now carries v_hybrid (post sold-out fallback), so the
-- minted stats are priced against the crop the hybrid will really harvest.
CREATE OR REPLACE FUNCTION public.breed_nft(p_a uuid, p_b uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_a       public.farm_nft_instances%ROWTYPE;
  v_b       public.farm_nft_instances%ROWTYPE;
  v_lo      uuid;
  v_hi      uuid;
  v_sp_lo   text;
  v_sp_hi   text;
  v_hybrid  text;
  v_def     public.farm_card_defs%ROWTYPE;
  v_cost    integer;
  v_coins   integer;
  v_serial  integer;
  v_nft_idx integer;
  v_name    text;
  v_id      uuid;
  v_stat_yield integer;
  v_stat_grow  integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_a = p_b THEN RAISE EXCEPTION 'same_instance'; END IF;

  -- Lock both parents in deterministic id order (deadlock-safe).
  IF p_a < p_b THEN v_lo := p_a; v_hi := p_b; ELSE v_lo := p_b; v_hi := p_a; END IF;
  SELECT * INTO v_a FROM public.farm_nft_instances WHERE id = v_lo FOR UPDATE;
  SELECT * INTO v_b FROM public.farm_nft_instances WHERE id = v_hi FOR UPDATE;

  IF v_a.id IS NULL OR v_b.id IS NULL THEN RAISE EXCEPTION 'parent_not_found'; END IF;
  IF v_a.owner_id <> v_user OR v_b.owner_id <> v_user THEN RAISE EXCEPTION 'not_owner'; END IF;
  IF v_a.species = v_b.species THEN RAISE EXCEPTION 'same_species'; END IF;
  IF v_a.listed OR v_b.listed THEN RAISE EXCEPTION 'parent_listed'; END IF;
  IF EXISTS (SELECT 1 FROM public.farm_tiles
              WHERE planted_instance_id IN (v_a.id, v_b.id)) THEN
    RAISE EXCEPTION 'parent_planted';
  END IF;

  -- Canonical species order for the recipe lookup.
  IF v_a.species < v_b.species THEN v_sp_lo := v_a.species; v_sp_hi := v_b.species;
  ELSE v_sp_lo := v_b.species; v_sp_hi := v_a.species; END IF;

  SELECT hybrid_species INTO v_hybrid
    FROM public.farm_hybrid_recipes
   WHERE a_species = v_sp_lo AND b_species = v_sp_hi;
  IF v_hybrid IS NULL THEN v_hybrid := 'wild_hybrid'; END IF;

  -- Lock the hybrid def; if a curated edition is sold out, fall back to wild.
  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_hybrid FOR UPDATE;
  IF v_def.minted_count >= v_def.edition_size THEN
    v_hybrid := 'wild_hybrid';
    SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_hybrid FOR UPDATE;
    IF v_def.minted_count >= v_def.edition_size THEN
      RAISE EXCEPTION 'hybrid_sold_out';
    END IF;
  END IF;

  -- Base 400/parent-level, minus the „Mistrz Hybryd" breeding discount
  -- (farm_breed_discount, defined in farm-achievements.sql — deploy both).
  v_cost := round(400 * (v_a.level + v_b.level)
                  * (1 - COALESCE(public.farm_breed_discount(v_user), 0)))::integer;
  UPDATE public.profiles SET coins = coins - v_cost
   WHERE id = v_user AND coins >= v_cost
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  v_serial := v_def.minted_count + 1;
  SELECT COALESCE(sum(d2.minted_count), 0) INTO v_nft_idx
    FROM public.farm_card_defs d2
   WHERE d2.edition_size IS NOT NULL
     AND public.farm_nft_pool(d2.species) = public.farm_nft_pool(v_hybrid);
  v_name := public.farm_nft_persona(v_hybrid, v_nft_idx);

  -- Synergy stats: +15% coins/day over the better parent, priced against
  -- v_hybrid's own crop (see farm_hybrid_stats).
  SELECT (h->>'yield')::int, (h->>'grow_minutes')::int
    INTO v_stat_yield, v_stat_grow
    FROM public.farm_hybrid_stats(v_a.id, v_b.id, v_hybrid) AS h;

  INSERT INTO public.farm_nft_instances
    (species, serial_no, edition_size, owner_id, acquired_from, nft_name, level,
     stat_yield, stat_grow_minutes)
  VALUES
    (v_hybrid, v_serial, v_def.edition_size, v_user, 'breeding', v_name, 1,
     v_stat_yield, v_stat_grow)
  RETURNING id INTO v_id;

  UPDATE public.farm_card_defs SET minted_count = minted_count + 1 WHERE species = v_hybrid;

  -- Provenance: burn both parents, mint the hybrid.
  IF to_regclass('public.farm_nft_transfers') IS NOT NULL THEN
    INSERT INTO public.farm_nft_transfers (instance_id, species, serial_no, from_owner, to_owner, price, kind)
    VALUES (v_a.id, v_a.species, v_a.serial_no, v_user, NULL, v_cost, 'breed_parent'),
           (v_b.id, v_b.species, v_b.serial_no, v_user, NULL, v_cost, 'breed_parent'),
           (v_id,  v_hybrid,     v_serial,      NULL,   v_user, 0,     'mint');
  END IF;

  INSERT INTO public.farm_hybrid_births
    (instance_id, hybrid_species, hybrid_serial, parent_a_species, parent_a_serial,
     parent_b_species, parent_b_serial, bred_by, coin_cost)
  VALUES
    (v_id, v_hybrid, v_serial, v_a.species, v_a.serial_no,
     v_b.species, v_b.serial_no, v_user, v_cost);

  -- Destroy both parents.
  DELETE FROM public.farm_nft_instances WHERE id IN (v_a.id, v_b.id);

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_cost, 'nft_breed', jsonb_build_object(
      'hybrid', v_hybrid, 'serial_no', v_serial,
      'parent_a', v_a.species, 'parent_b', v_b.species));
  END IF;

  RETURN json_build_object(
    'ok', true, 'coins', v_coins, 'cost', v_cost,
    'hybrid', json_build_object(
      'id', v_id, 'species', v_hybrid, 'serial_no', v_serial,
      'edition_size', v_def.edition_size, 'nft_name', v_name,
      'name', v_def.name, 'emoji', v_def.emoji,
      'stat_yield', v_stat_yield, 'stat_grow_minutes', v_stat_grow,
      'parent_a', json_build_object('species', v_a.species, 'serial_no', v_a.serial_no),
      'parent_b', json_build_object('species', v_b.species, 'serial_no', v_b.serial_no),
      'curated', v_hybrid <> 'wild_hybrid'));
END $$;
REVOKE ALL ON FUNCTION public.breed_nft(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.breed_nft(uuid, uuid) TO authenticated;
