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
--  LEVEL INHERITANCE
--  -----------------
--  Hybrids used to mint at level 1, so breeding also destroyed net worth: an NFT is
--  valued round(20000 / edition_size × level), and burning a poz.2 parent for a poz.1
--  child threw away half its worth. The hybrid now mints at max(parentLevels).
--
--  That means the STORED stats must be BACKED OUT of the effective targets, because
--  level is applied a second time downstream:
--      harvest_crop: round(stat_yield        × (1 + (lvl-1) × 0.5))
--      plant_crop:   max(1440, stat_grow_minutes × 0.92^(lvl-1))
--  so we store
--      stat_yield        = ceil (yieldEff / (1 + (lvl-1) × 0.5))
--      stat_grow_minutes = floor(growEff  / 0.92^(lvl-1))
--  and the field values come back out as the intended targets. Rounding is directional
--  (ceil on yield, floor on grow), so the +15% promise can only ever be met or beaten,
--  never missed. At lvl 1 both reduce to the identity, so nothing changes for those.
--
--  VALUE FLOOR (the „Dziki Mieszaniec" hole)
--  ----------------------------------------
--  Level inheritance fixed the value regression for the 6 CURATED recipes, but not
--  for the catch-all: `wild_hybrid` has edition_size 500 (deliberately huge so
--  breeding never dead-ends), and net worth is round(20000 / edition_size × level),
--  so it was worth 40 × level. Breeding an uncatalogued pair turned a 5000-value
--  card into a 40-value one. Edition sizing cannot fix this — you'd need an edition
--  of 8 to be worth 2500, which defeats the point of a catch-all.
--
--  So value gets the same treatment yield and grow already had: a PER-INSTANCE
--  override. `farm_nft_instances.stat_value` holds the value **per level** (the
--  instance-level replacement for `20000 / edition_size`), and breeding sets it to
--  the better parent's per-level value whenever that beats the species formula.
--  NULL — every non-bred card, and every hybrid whose own formula already wins —
--  means "use the species formula", so nothing else in the economy shifts.
--
--  Value scales with level through the override too, so a later merge still works.
--
--  This makes the guarantee complete: a bred hybrid is never worth less than the
--  better parent it consumed. It does NOT reproduce the SUM of both parents —
--  level_up_nft isn't sum-preserving either above level 1 (two poz.2 → one poz.3
--  loses 2500), so "at least the better parent" is the consistent promise.
--
--  Existing hybrids are NOT retro-fitted (only 3 have ever been bred); this changes
--  what future breeds mint.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Per-instance net-worth override ───────────────────────────────────────
ALTER TABLE public.farm_nft_instances ADD COLUMN IF NOT EXISTS stat_value integer;
COMMENT ON COLUMN public.farm_nft_instances.stat_value IS
  'Per-instance net-worth value PER LEVEL (bred hybrids, when the species formula '
  'would value them below the parent they consumed). NULL = round(20000/edition_size).';

-- Teach the three net-worth consumers about it. Every one of them contains the
-- identical expression, so patch the LIVE definition in place rather than
-- re-transcribing three functions (economy_stats alone is 12 KB, and CLAUDE.md
-- warns that deployed copies drift from the repo). Guarded on 'ni.stat_value', so
-- re-running never nests the COALESCE.
--   · user_assets_value        (leaderboard-net-worth-items.sql) — leaderboard + economy_stats holdings
--   · user_net_worth_breakdown (leaderboard-net-worth-items.sql) — 💼 Portfel Bilans rows
--   · economy_stats            (economy-stats.sql)               — Skarbiec G6 hero_items/farm buckets
DO $patch$
DECLARE
  r      record;
  olddef text;
  newdef text;
  n      integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname IN ('user_assets_value', 'user_net_worth_breakdown', 'economy_stats')
  LOOP
    olddef := pg_get_functiondef(r.oid);
    IF position('ni.stat_value' in olddef) > 0 THEN CONTINUE; END IF;   -- already patched
    newdef := replace(olddef,
      'round(20000.0 / ni.edition_size * ni.level)',
      'COALESCE(round(ni.stat_value * ni.level), round(20000.0 / ni.edition_size * ni.level))');
    IF newdef = olddef THEN
      RAISE EXCEPTION 'farm-hybrid-income-parity: NFT value expression not found in %() — '
                      'it was reworded upstream; re-check the valuation sites by hand', r.proname;
    END IF;
    EXECUTE newdef;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'stat_value wired into % net-worth function(s)', n;
END $patch$;

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
    SELECT i.species, i.level,
           COALESCE(i.stat_yield, d.base_yield) * (1 + (i.level - 1) * 0.5) AS y,
           GREATEST(1440, COALESCE(i.stat_grow_minutes, d.base_grow_minutes)
                          * power(0.92, i.level - 1)) AS g,
           COALESCE(m.base_price, 0) AS price,
           -- per-level value basis, mirroring the net-worth formula
           COALESCE(i.stat_value, 20000.0 / i.edition_size) AS vbasis
      FROM public.farm_nft_instances i
      JOIN public.farm_card_defs d ON d.species = i.species
      LEFT JOIN public.farm_market m ON m.crop_type = d.crop_type
     WHERE i.id IN (p_a, p_b)
  ),
  agg AS (
    SELECT max(y) AS max_y,
           min(g) AS min_g,
           max(y * price / (g / 1440.0)) AS best_income,   -- coins/day, per parent
           max(level) AS lvl,                              -- inherited by the hybrid
           max(round(vbasis * level)) AS best_parent_value, -- net worth floor
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
    SELECT h.species, d.base_yield, d.edition_size, COALESCE(m.base_price, 0) AS price
      FROM h
      JOIN public.farm_card_defs d ON d.species = h.species
      LEFT JOIN public.farm_market m ON m.crop_type = d.crop_type
  ),
  -- EFFECTIVE targets: what the card must actually deliver in the field.
  calc AS (
    SELECT hd.species, hd.price, hd.base_yield, hd.edition_size,
           GREATEST(1440, floor(agg.min_g * 0.95)) AS grow_eff,
           agg.max_y, agg.min_g, agg.best_income, agg.lvl, agg.best_parent_value,
           (1 + (agg.lvl - 1) * 0.5)  AS ymult,
           power(0.92, agg.lvl - 1)   AS gmult,
           round(20000.0 / hd.edition_size * agg.lvl) AS species_value
      FROM agg, hd
  ),
  eff AS (
    SELECT c.*,
           GREATEST(
             -- income parity: out-earn the better parent by 15% at the hybrid's
             -- own crop price (the −1e-9 keeps ceil() identical to the JS mirror
             -- when the quotient lands exactly on an integer)
             CASE WHEN c.price > 0
                  THEN ceil(c.best_income * 1.15 * (c.grow_eff / 1440.0) / c.price - 1e-9)
                  ELSE 0 END,
             ceil(c.max_y * 1.15 - 1e-9),        -- floor: the old unit promise
             c.base_yield                        -- floor: the catalogue card
           ) AS yield_eff
      FROM calc c
  ),
  -- Back out the BASE stats to store, so the level multiplier downstream
  -- REPRODUCES the targets above instead of applying on top of them.
  fin AS (
    SELECT e.*,
           ceil (e.yield_eff / e.ymult - 1e-9) AS stat_yield,
           floor(e.grow_eff  / e.gmult + 1e-9) AS stat_grow,
           -- per-level value basis, stored ONLY when the species formula would
           -- value the hybrid below the parent it consumed (the wild_hybrid hole).
           -- ceil, so round(stat_value × lvl) can never dip under the floor.
           CASE WHEN e.species_value >= e.best_parent_value THEN NULL
                ELSE ceil(e.best_parent_value / e.lvl) END AS stat_value
      FROM eff e
  )
  SELECT json_build_object(
    -- what breed_nft writes onto the instance
    'level',               lvl::int,
    'stat_yield',          stat_yield::int,
    'stat_grow_minutes',   stat_grow::int,
    'stat_value',          stat_value::int,
    -- what the player sees / the field actually produces
    'yield',               round(stat_yield * ymult)::int,
    'grow_minutes',        GREATEST(1440, floor(stat_grow * gmult))::int,
    'hybrid_species',      species,
    'hybrid_price',        price::int,
    'value',               COALESCE(round(stat_value * lvl), species_value)::int,
    'parent_best_value',   best_parent_value::int,
    'per_day',             CASE WHEN price > 0 THEN round(
                             round(stat_yield * ymult) * price
                             / (GREATEST(1440, floor(stat_grow * gmult)) / 1440.0))::int END,
    'parent_max_yield',    max_y::int,
    'parent_min_grow',     min_g::int,
    'parent_best_per_day', round(best_income)::int)
  FROM fin;
$$;
GRANT EXECUTE ON FUNCTION public.farm_hybrid_stats(uuid, uuid, text) TO authenticated;

-- ── breed_nft: resolved species in, level + backed-out base stats out ──────
-- Copy of the farm-nft-breeding.sql definition with two changes: the
-- farm_hybrid_stats call now carries v_hybrid (post sold-out fallback) so the
-- minted stats are priced against the crop the hybrid will really harvest, and
-- the instance is minted at the INHERITED level with the backed-out base stats
-- rather than hardcoded level 1.
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
  v_level      integer;
  v_stat_value integer;
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
  -- v_hybrid's own crop, at the inherited level (see farm_hybrid_stats).
  -- stat_yield / stat_grow_minutes are the BASE stats — level is re-applied by
  -- harvest_crop / plant_crop, so storing the effective values here would
  -- double-count it.
  SELECT (h->>'stat_yield')::int, (h->>'stat_grow_minutes')::int, (h->>'level')::int,
         (h->>'stat_value')::int
    INTO v_stat_yield, v_stat_grow, v_level, v_stat_value
    FROM public.farm_hybrid_stats(v_a.id, v_b.id, v_hybrid) AS h;

  INSERT INTO public.farm_nft_instances
    (species, serial_no, edition_size, owner_id, acquired_from, nft_name, level,
     stat_yield, stat_grow_minutes, stat_value)
  VALUES
    (v_hybrid, v_serial, v_def.edition_size, v_user, 'breeding', v_name, v_level,
     v_stat_yield, v_stat_grow, v_stat_value)
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
      'name', v_def.name, 'emoji', v_def.emoji, 'level', v_level,
      'stat_yield', v_stat_yield, 'stat_grow_minutes', v_stat_grow,
      'stat_value', v_stat_value,
      'parent_a', json_build_object('species', v_a.species, 'serial_no', v_a.serial_no),
      'parent_b', json_build_object('species', v_b.species, 'serial_no', v_b.serial_no),
      'curated', v_hybrid <> 'wild_hybrid'));
END $$;
REVOKE ALL ON FUNCTION public.breed_nft(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.breed_nft(uuid, uuid) TO authenticated;
