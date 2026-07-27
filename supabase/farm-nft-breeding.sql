-- ════════════════════════════════════════════════════════════════════════════
--  Farma — NFT breeding / hybrids  (Lever 2)
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER: farm.sql, farm-marketplace.sql, nft-leveling-rework.sql,
--             nft-merge-fixes.sql, farm-weekly-nft-series.sql.  Idempotent.
--
--  breed_nft(a, b): consume TWO owned, unlisted, unplanted NFT instances of
--  DIFFERENT species + a coin burn → mint ONE serialized HYBRID instance.
--  Both parents are destroyed (the sacrifice that justifies the new mint), and
--  the hybrid is itself an edition-capped, serialized, plantable NFT — so fusion
--  stops being a pure drain and becomes a generator of novel collectible content.
--
--  Curated recipes: specific unordered pairs map to a hand-designed hybrid with a
--  good name + art. Any uncatalogued different-species pair falls back to the
--  large-edition catch-all „Dziki Mieszaniec 🌈", so breeding NEVER dead-ends.
--
--  Hybrids live in farm_card_defs with is_hybrid=true and draw_weight=0, so they
--  are excluded from every lootbox / seasonal-reward draw (which all filter
--  draw_weight > 0) yet are still catalogued, plantable, valued for net worth
--  (edition_size ⇒ round(20000/edition_size * level)), and tradeable on Targowisko.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Persona pool: Slavic deities for legendary hybrids ─────────────────────
CREATE OR REPLACE FUNCTION public.farm_nft_pool(p_species text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_species IN (
      'wild_hybrid', 'sunrose', 'paradise_lotus', 'crystal_peony',
      'golden_nenufar', 'royal_rose_banana', 'sunny_banana'
    ) THEN 'hybrid'
    WHEN p_species = 'aeae_banana' THEN 'hawaii'
    WHEN public.farm_nft_is_female(p_species) THEN 'female'
    ELSE 'male' END;
$$;

CREATE OR REPLACE FUNCTION public.farm_nft_persona(p_species text, p_idx integer)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE public.farm_nft_pool(p_species)
    WHEN 'hybrid' THEN (ARRAY[
      'Światowid','Perun','Weles','Swaróg','Radogost','Jaryło',
      'Dziewanna','Marzanna','Żywia','Lel','Polel','Trzygłów',
      'Prowe','Porewit','Rugewit','Kupała','Dola','Nyja','Chors','Rod'
    ])[ (abs(p_idx) % 20) + 1 ]
    WHEN 'hawaii' THEN (ARRAY[
      'Kai','Leilani','Keanu','Nalani','Koa','Mahina','Kawika',
      'Noelani','Kainoa','Makoa','Kekoa','Iolana','Alaula','Pualani'
    ])[ (abs(p_idx) % 14) + 1 ]
    ELSE public.farm_nft_name(p_idx, public.farm_nft_is_female(p_species))
  END;
$$;

-- ── Hybrid species catalog (is_hybrid, never dropped: draw_weight 0) ───────
INSERT INTO public.farm_card_defs
  (species, name, emoji, rarity, draw_weight, base_grow_minutes, base_yield, crop_type, edition_size, is_hybrid, is_active)
VALUES
  ('sunrose',           'Słoneczna Róża',           '🌹', 'legendary', 0, 4320, 130, 'seasonal_bloom',  12, true, true),
  ('paradise_lotus',    'Rajski Lotos',             '🪷', 'legendary', 0, 5760, 140, 'seasonal_bloom',   8, true, true),
  ('crystal_peony',     'Kryształowa Peonia',       '🌸', 'legendary', 0, 4320, 125, 'seasonal_bloom',  10, true, true),
  ('golden_nenufar',    'Złoty Nenufar',            '🌼', 'legendary', 0, 5760, 135, 'seasonal_bloom',  10, true, true),
  ('royal_rose_banana', 'Różany Banan Królewski',   '🌹', 'legendary', 0, 5760, 145, 'seasonal_bloom',   8, true, true),
  ('sunny_banana',      'Słoneczny Banan',          '🍌', 'legendary', 0, 5760, 140, 'seasonal_bloom',   8, true, true),
  -- Catch-all fallback: large edition so breeding any uncatalogued pair always works.
  ('wild_hybrid',       'Dziki Mieszaniec',         '🌈', 'legendary', 0, 4320, 110, 'seasonal_bloom', 500, true, true)
ON CONFLICT (species) DO UPDATE SET
  name = EXCLUDED.name, emoji = EXCLUDED.emoji, rarity = EXCLUDED.rarity,
  draw_weight = 0, base_grow_minutes = EXCLUDED.base_grow_minutes,
  base_yield = EXCLUDED.base_yield, crop_type = EXCLUDED.crop_type,
  edition_size = EXCLUDED.edition_size, is_hybrid = true;

-- ── Recipe map (canonical order: a_species < b_species) ────────────────────
CREATE TABLE IF NOT EXISTS public.farm_hybrid_recipes (
  a_species      text NOT NULL REFERENCES public.farm_card_defs(species),
  b_species      text NOT NULL REFERENCES public.farm_card_defs(species),
  hybrid_species text NOT NULL REFERENCES public.farm_card_defs(species),
  PRIMARY KEY (a_species, b_species),
  CHECK (a_species < b_species)
);
INSERT INTO public.farm_hybrid_recipes (a_species, b_species, hybrid_species) VALUES
  ('aeae_banana',   'crystal_lotus',     'paradise_lotus'),
  ('aeae_banana',   'diamond_rose',      'royal_rose_banana'),
  ('aeae_banana',   'golden_sunflower',  'sunny_banana'),
  ('crystal_lotus', 'diamond_rose',      'crystal_peony'),
  ('crystal_lotus', 'golden_sunflower',  'golden_nenufar'),
  ('diamond_rose',  'golden_sunflower',  'sunrose')
ON CONFLICT (a_species, b_species) DO UPDATE SET hybrid_species = EXCLUDED.hybrid_species;

GRANT SELECT ON public.farm_hybrid_recipes TO anon, authenticated;

-- ── Lineage log (public: powers the hybrid card's „rodowód" art) ───────────
CREATE TABLE IF NOT EXISTS public.farm_hybrid_births (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id    uuid REFERENCES public.farm_nft_instances(id) ON DELETE SET NULL,
  hybrid_species text NOT NULL,
  hybrid_serial  integer NOT NULL,
  parent_a_species text NOT NULL,
  parent_a_serial  integer NOT NULL,
  parent_b_species text NOT NULL,
  parent_b_serial  integer NOT NULL,
  bred_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  coin_cost      integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_hybrid_births_instance_idx ON public.farm_hybrid_births(instance_id);
CREATE INDEX IF NOT EXISTS farm_hybrid_births_time_idx     ON public.farm_hybrid_births(created_at DESC);
ALTER TABLE public.farm_hybrid_births ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_hybrid_births_select" ON public.farm_hybrid_births;
CREATE POLICY "farm_hybrid_births_select" ON public.farm_hybrid_births FOR SELECT USING (true);
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_hybrid_births;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL; END $$;

-- Extend farm_nft_transfers.kind to allow the breeding parent-burn provenance
-- (the CHECK from nft-leveling-rework.sql only allows mint/sale/merge_*).
DO $$ BEGIN
  ALTER TABLE public.farm_nft_transfers DROP CONSTRAINT IF EXISTS farm_nft_transfers_kind_check;
  ALTER TABLE public.farm_nft_transfers
    ADD CONSTRAINT farm_nft_transfers_kind_check
    CHECK (kind IN ('mint','sale','merge_fuel','merge_hero','breed_parent'));
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ── RPC: breed_nft ─────────────────────────────────────────────────────────
-- Cost: 400 * (levelA + levelB) coins, burned. Both parents destroyed; one
-- serialized hybrid minted to the caller.
--
-- ⚠️ SUPERSEDED by supabase/farm-hybrid-income-parity.sql — that file passes the
-- resolved hybrid species into farm_hybrid_stats so the minted stats are priced
-- against the crop the hybrid actually harvests. Re-run it after re-running this.
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

  -- Synergy stats: strictly better than either parent (see farm_hybrid_stats).
  SELECT (h->>'yield')::int, (h->>'grow_minutes')::int
    INTO v_stat_yield, v_stat_grow
    FROM public.farm_hybrid_stats(v_a.id, v_b.id) AS h;

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

-- ── Public view: recent hybrid births (feed + card lineage) ────────────────
CREATE OR REPLACE VIEW public.farm_hybrid_recent WITH (security_invoker = true) AS
  SELECT b.hybrid_species, d.name AS hybrid_name, d.emoji AS hybrid_emoji,
         b.hybrid_serial, b.parent_a_species, b.parent_a_serial,
         b.parent_b_species, b.parent_b_serial,
         p.nick AS bred_by_nick, b.created_at
  FROM public.farm_hybrid_births b
  JOIN public.farm_card_defs d ON d.species = b.hybrid_species
  LEFT JOIN public.profiles p ON p.id = b.bred_by
  ORDER BY b.created_at DESC
  LIMIT 30;
GRANT SELECT ON public.farm_hybrid_recent TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
--  Hybrid SYNERGY stats (per-instance overrides)
-- ════════════════════════════════════════════════════════════════════════════
--  A bred hybrid must be strictly BETTER than either parent, otherwise breeding
--  (which burns two NFTs) is never worth it. Species-level stats can't express
--  that — the same hybrid species can come from different parent pairs — so each
--  bred instance carries its OWN stats, derived from its parents:
--      yield = ceil(max(parentYield)  × 1.15)   → out-yields both parents
--      grow  = floor(min(parentGrow)  × 0.95)   → faster than both parents
--  NULL columns mean "use the species default" (every non-bred card).
--
--  ⚠️ SUPERSEDED by supabase/farm-hybrid-income-parity.sql. The unit-count rule
--  below is NOT enough: hybrids harvest 'seasonal_bloom' (price 50) while premium
--  parents harvest crops worth 80–120, so +15% units could still mean HALF the
--  coins/day. That file re-derives yield from parent INCOME. Re-run it after
--  re-running this one.
ALTER TABLE public.farm_nft_instances ADD COLUMN IF NOT EXISTS stat_yield integer;
ALTER TABLE public.farm_nft_instances ADD COLUMN IF NOT EXISTS stat_grow_minutes integer;
COMMENT ON COLUMN public.farm_nft_instances.stat_yield IS
  'Per-instance yield override (bred hybrids). NULL = farm_card_defs.base_yield.';
COMMENT ON COLUMN public.farm_nft_instances.stat_grow_minutes IS
  'Per-instance grow-time override (bred hybrids). NULL = farm_card_defs.base_grow_minutes.';

-- Deterministic synergy preview — the client mirrors this exact math so the
-- player sees the resulting stats BEFORE committing the merge.
CREATE OR REPLACE FUNCTION public.farm_hybrid_stats(p_a uuid, p_b uuid)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH p AS (
    -- EFFECTIVE (level-scaled) parent stats, not base: a level-3 parent really
    -- yields base×2, so comparing bases would let a hybrid come out WEAKER than
    -- the parents that were burned for it.
    SELECT COALESCE(i.stat_yield, d.base_yield) * (1 + (i.level - 1) * 0.5) AS y,
           GREATEST(1440, COALESCE(i.stat_grow_minutes, d.base_grow_minutes)
                          * power(0.92, i.level - 1)) AS g
      FROM public.farm_nft_instances i
      JOIN public.farm_card_defs d ON d.species = i.species
     WHERE i.id IN (p_a, p_b)
  )
  SELECT json_build_object(
    'yield', ceil(max(y) * 1.15)::int,
    'grow_minutes', greatest(1440, floor(min(g) * 0.95))::int,
    'parent_max_yield', max(y)::int,
    'parent_min_grow', min(g)::int)
  FROM p;
$$;
GRANT EXECUTE ON FUNCTION public.farm_hybrid_stats(uuid, uuid) TO authenticated;
