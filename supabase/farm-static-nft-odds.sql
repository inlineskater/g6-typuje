-- ═══════════════════════════════════════════════════════════════════════════
-- Farma: STATIC NFT drop odds + lootbox opening log
-- ═══════════════════════════════════════════════════════════════════════════
-- Run LAST among the farm/lootbox files — AFTER farm.sql, nft-leveling-rework.sql,
-- nft-merge-fixes.sql and farm-goldbox.sql (this file copies the LIVE draw logic
-- from nft-merge-fixes.sql `open_farm_lootbox` and farm-goldbox.sql
-- `open_farm_goldbox` and re-applies its own edits on top). Idempotent; safe to
-- re-run. Re-run this file again after re-running any of those, so the copied
-- draw logic (minted_count serials/supply/persona index) stays current.
--
-- WHAT CHANGES (2026-07-17):
--   1. FLAT NFT odds for everyone. The old anti-hoarding penalty — NFT draw
--      weight divided by power(3, owned_nfts) in the standard box and
--      power(2, owned_nfts) in the gold box — is REMOVED. Owning NFTs no longer
--      lowers your chance of drawing another one. The chance is now identical
--      for every player, every box, forever (the only remaining scarcity limit
--      is the per-edition minted-ever cap of 8/10/15/25).
--      • The voucher (free-tile) territory decay divisor stays UNCHANGED — this
--        change is only about NFT card odds, per the product decision.
--      • The gold box keeps its 5 draws + guaranteed rare-or-better first draw.
--   2. NFT share HALVED vs the old 0-owned baseline. Rather than fractional NFT
--      weights, every NON-NFT `draw_weight` is DOUBLED (absolute, idempotent
--      values below); NFT weights stay 2/1/1/1. That cuts the NFT fraction of
--      the pool roughly in half.
--
--      Resulting static per-box chances (distinct draws, computed exactly):
--        STANDARD box (3 draws):  ANY NFT ≈ 6.91%
--          Diamentowa Róża 2.80% · Słonecznik/Lotos/Banan 1.40% each
--        GOLD box (5 draws, rare+ floor): ANY NFT ≈ 16.44%
--          Diamentowa Róża 6.80% · Słonecznik/Lotos/Banan 3.44% each
--
--   3. Lootbox opening LOG. A new public-SELECT `farm_lootbox_opens` table
--      records one row per box opened (who, which box type, what dropped),
--      written inside both open functions. It powers the in-game „Historia
--      otwarć skrzynek" global feed popup and fixes the fact that box OPENS were
--      never logged (only buys were) — enabling real drop-rate auditing.
--
-- Keep in sync with index.html: farmEffectiveDrawWeight (now static), the
-- catalog/help odds copy, and the seed weights in farm.sql (updated alongside).

-- ── 0. Rebalanced draw weights (idempotent absolute values) ─────────────────
-- Non-NFT weights doubled vs the original farm.sql seed; NFT weights unchanged.
-- Absolute SETs (not `weight*2`) so a re-run is idempotent.
UPDATE public.farm_card_defs SET draw_weight = 60 WHERE species = 'carrot';
UPDATE public.farm_card_defs SET draw_weight = 56 WHERE species = 'potato';
UPDATE public.farm_card_defs SET draw_weight = 48 WHERE species = 'tomato';
UPDATE public.farm_card_defs SET draw_weight = 26 WHERE species = 'corn';
UPDATE public.farm_card_defs SET draw_weight = 24 WHERE species = 'chili';
UPDATE public.farm_card_defs SET draw_weight = 18 WHERE species = 'strawberry';
UPDATE public.farm_card_defs SET draw_weight = 10 WHERE species = 'pumpkin';
UPDATE public.farm_card_defs SET draw_weight =  8 WHERE species = 'grapes';
UPDATE public.farm_card_defs SET draw_weight =  6 WHERE species = 'pineapple';
-- NFT weights stay 2 / 1 / 1 / 1 (diamond_rose / golden_sunflower / crystal_lotus / aeae_banana).
UPDATE public.farm_card_defs SET draw_weight = 2 WHERE species = 'diamond_rose';
UPDATE public.farm_card_defs SET draw_weight = 1 WHERE species = 'golden_sunflower';
UPDATE public.farm_card_defs SET draw_weight = 1 WHERE species = 'crystal_lotus';
UPDATE public.farm_card_defs SET draw_weight = 1 WHERE species = 'aeae_banana';

-- ── 1. Lootbox opening log ──────────────────────────────────────────────────
-- One row per box opened. Public SELECT (like the crop-sales feed) so the feed
-- doubles as a fairness auditor; no client writes — populated only by the
-- SECURITY DEFINER open functions below.
CREATE TABLE IF NOT EXISTS public.farm_lootbox_opens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text,
  box_type      text NOT NULL CHECK (box_type IN ('standard','gold')),
  card_count    integer NOT NULL DEFAULT 0,
  got_nft       boolean NOT NULL DEFAULT false,
  got_voucher   boolean NOT NULL DEFAULT false,
  nft_species   text,            -- first NFT drawn this box (NULL if none)
  nft_serial    integer,         -- its serial (NULL if none)
  cards         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- full drawn-cards payload
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_lootbox_opens_created_idx ON public.farm_lootbox_opens (created_at DESC);
CREATE INDEX IF NOT EXISTS farm_lootbox_opens_user_idx    ON public.farm_lootbox_opens (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS farm_lootbox_opens_nft_idx     ON public.farm_lootbox_opens (created_at DESC) WHERE got_nft;

ALTER TABLE public.farm_lootbox_opens ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY farm_lootbox_opens_read ON public.farm_lootbox_opens FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

REVOKE ALL ON public.farm_lootbox_opens FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.farm_lootbox_opens TO anon, authenticated;

-- Realtime so the feed updates live (mirrors the farm.sql publication block).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'farm_lootbox_opens'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_lootbox_opens';
    END IF;
  END IF;
END $$;

-- Shared helper: log one opened box. Guarded call sites so the open functions
-- still stand alone if this table is absent.
CREATE OR REPLACE FUNCTION public.farm_log_lootbox_open(
  p_user uuid, p_box_type text, p_cards jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_nick     text;
  v_is_admin boolean := false;
  v_count    integer := 0;
  v_nft      boolean := false;
  v_vch      boolean := false;
  v_species  text := NULL;
  v_serial   integer := NULL;
  c          jsonb;
BEGIN
  -- Admins are excluded from the stats/luck table (staff account), so their
  -- opens are never logged in the first place.
  SELECT nick, COALESCE(is_admin, false) INTO v_nick, v_is_admin
    FROM public.profiles WHERE id = p_user;
  IF v_is_admin THEN RETURN; END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_cards, '[]'::jsonb)) LOOP
    IF COALESCE((c->>'voucher')::boolean, false) THEN
      v_vch := true;
    ELSE
      v_count := v_count + 1;
      IF COALESCE((c->>'nft')::boolean, false) AND NOT v_nft THEN
        v_nft := true;
        v_species := c->>'species';
        v_serial  := (c->>'serial_no')::integer;
      END IF;
    END IF;
  END LOOP;
  INSERT INTO public.farm_lootbox_opens
    (user_id, nick_snapshot, box_type, card_count, got_nft, got_voucher, nft_species, nft_serial, cards)
  VALUES (p_user, v_nick, p_box_type, v_count, v_nft, v_vch, v_species, v_serial, COALESCE(p_cards, '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.farm_log_lootbox_open(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ── 2. open_farm_lootbox — FLAT NFT odds + logging ──────────────────────────
-- Verbatim copy of the LIVE nft-merge-fixes.sql version with exactly two edits:
--   • NFT draw weight is used AS-IS (removed `/ power(3, v_owned_nfts)` from
--     both the total and the cumulative-window weight expressions). v_owned_nfts
--     is still counted/incremented but no longer scales the odds — kept only so
--     a future edit could reference it; it does not affect the draw.
--   • A guarded farm_log_lootbox_open('standard', …) call before RETURN.
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

  -- Eligible = active + weighted, and either uncapped OR an NFT edition with
  -- minted-ever supply left (burned cards do NOT return to the pool).
  SELECT count(*) INTO v_eligible
    FROM public.farm_card_defs d
   WHERE d.is_active AND d.draw_weight > 0
     AND (d.edition_size IS NULL OR d.minted_count < d.edition_size);
  IF v_eligible = 0 THEN RAISE EXCEPTION 'pool_empty'; END IF;
  v_target := least(v_draws, v_eligible);

  -- Draw distinct cards; NFTs get a freshly minted serial. NFT odds are FLAT —
  -- the raw draw_weight is used regardless of how many NFTs the caller owns.
  WHILE v_got < v_target AND v_attempts < 40 LOOP
    v_attempts := v_attempts + 1;

    SELECT sum(d.draw_weight::numeric)
      INTO v_total
      FROM public.farm_card_defs d
     WHERE d.is_active AND d.draw_weight > 0 AND d.species <> ALL(v_picked)
       AND (d.edition_size IS NULL OR d.minted_count < d.edition_size);
    EXIT WHEN v_total IS NULL OR v_total <= 0;

    v_roll := random() * v_total;
    SELECT species INTO v_species FROM (
      SELECT d.species,
             sum(d.draw_weight::numeric) OVER (ORDER BY d.species) AS cum
        FROM public.farm_card_defs d
       WHERE d.is_active AND d.draw_weight > 0 AND d.species <> ALL(v_picked)
         AND (d.edition_size IS NULL OR d.minted_count < d.edition_size)
    ) q
    WHERE q.cum > v_roll
    ORDER BY q.cum
    LIMIT 1;
    EXIT WHEN v_species IS NULL;

    SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_species FOR UPDATE;
    v_picked := array_append(v_picked, v_species);

    IF v_def.edition_size IS NOT NULL THEN
      -- NFT: re-check minted-ever supply under the row lock, then mint the next serial
      IF v_def.minted_count >= v_def.edition_size THEN
        CONTINUE;   -- sold out (race); already excluded via v_picked, try another card
      END IF;
      v_serial := v_def.minted_count + 1;
      -- unique funny name from the species' persona pool, by per-pool mint order
      -- (minted-ever, so a burned card never frees its name for reuse)
      SELECT COALESCE(sum(d2.minted_count), 0) INTO v_nft_idx
        FROM public.farm_card_defs d2
       WHERE d2.edition_size IS NOT NULL
         AND public.farm_nft_pool(d2.species) = public.farm_nft_pool(v_species);
      v_nft_name := public.farm_nft_persona(v_species, v_nft_idx);
      INSERT INTO public.farm_nft_instances (species, serial_no, edition_size, owner_id, acquired_from, nft_name)
      VALUES (v_species, v_serial, v_def.edition_size, v_user, 'lootbox', v_nft_name)
      RETURNING id INTO v_nft_id;
      UPDATE public.farm_card_defs SET minted_count = minted_count + 1 WHERE species = v_species;
      -- provenance log (farm-marketplace.sql); guarded so farm.sql stands alone
      IF to_regclass('public.farm_nft_transfers') IS NOT NULL THEN
        INSERT INTO public.farm_nft_transfers (instance_id, species, serial_no, from_owner, to_owner, price, kind)
        VALUES (v_nft_id, v_species, v_serial, NULL, v_user, NULL, 'mint');
      END IF;
      v_owned_nfts := v_owned_nfts + 1; -- counted only; no longer scales odds
    END IF;

    -- NFT level lives on farm_nft_instances, not farm_collection — only
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

  -- Opening log (guarded so the function stands alone without the log table).
  IF to_regclass('public.farm_lootbox_opens') IS NOT NULL THEN
    PERFORM public.farm_log_lootbox_open(v_user, 'standard', v_cards);
  END IF;

  RETURN json_build_object('ok', true, 'coins', v_coins, 'boxes', v_boxes,
    'tile_vouchers', v_vouchers, 'got_voucher', v_got_vch, 'cards', v_cards);
END;
$$;

-- ── 3. open_farm_goldbox — FLAT NFT odds + logging ──────────────────────────
-- Verbatim copy of the LIVE farm-goldbox.sql version with the same two edits:
--   • NFT draw weight used AS-IS (removed `/ power(2, v_owned_nfts)`).
--   • A guarded farm_log_lootbox_open('gold', …) call before RETURN.
-- The 5 draws + guaranteed rare-or-better first draw + boosted voucher base are
-- all preserved.
CREATE OR REPLACE FUNCTION public.open_farm_goldbox()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user          uuid := auth.uid();
  v_draws         constant integer := 5;     -- cards per gold box — mirror FARM_GOLDBOX_DRAWS in index.html
  v_voucher_p     constant numeric := 0.15;  -- boosted base chance for a free-tile voucher
  v_coins         integer;
  v_boxes_gold    integer;
  v_vouchers      integer := 0;
  v_tiles         integer := 0;
  v_territory     integer := 0;
  v_owned_nfts    integer := 0;
  v_eff_voucher_p numeric := 0;
  v_got_vch       boolean := false;
  v_drop_vch      boolean := false;
  v_eligible      integer;
  v_target        integer;
  v_got           integer := 0;
  v_attempts      integer := 0;
  v_total         numeric;
  v_roll          numeric;
  v_species       text;
  v_def           public.farm_card_defs%ROWTYPE;
  v_new_count     integer;
  v_serial        integer;
  v_nft_idx       integer;
  v_nft_name      text;
  v_nft_id        uuid;
  v_picked        text[] := ARRAY[]::text[];
  v_cards         jsonb  := '[]'::jsonb;
  v_card          jsonb;
  v_rare_only     boolean;
  v_rare_eligible integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  -- Consume one sealed GOLD box (bought earlier via buy_farm_goldbox). Gold
  -- boxes are never part of the starter gift, so starter_opens_left /
  -- guaranteed_voucher are neither read nor written here.
  UPDATE public.farm_user_state SET boxes_gold = boxes_gold - 1
   WHERE user_id = v_user AND boxes_gold >= 1
  RETURNING boxes_gold, tile_vouchers
       INTO v_boxes_gold, v_vouchers;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_goldbox'; END IF;
  SELECT coins INTO v_coins FROM public.profiles WHERE id = v_user;
  SELECT count(*) INTO v_owned_nfts FROM public.farm_nft_instances WHERE owner_id = v_user;
  SELECT count(*) INTO v_tiles FROM public.farm_tiles
   WHERE owner_id = v_user AND acquired_via <> 'migration';
  v_territory := v_tiles + COALESCE(v_vouchers, 0);
  v_eff_voucher_p := v_voucher_p / power(3::numeric, greatest(v_territory, 0));

  -- Eligible = active + weighted, and either uncapped OR an NFT edition with
  -- minted-ever supply left (burned cards do NOT return to the pool).
  SELECT count(*) INTO v_eligible
    FROM public.farm_card_defs d
   WHERE d.is_active AND d.draw_weight > 0
     AND (d.edition_size IS NULL OR d.minted_count < d.edition_size);
  IF v_eligible = 0 THEN RAISE EXCEPTION 'pool_empty'; END IF;
  v_target := least(v_draws, v_eligible);

  -- Guaranteed rarity floor: how many rare+ cards are drawable at all right now.
  SELECT count(*) INTO v_rare_eligible FROM public.farm_card_defs d
   WHERE d.is_active AND d.draw_weight > 0 AND d.rarity IN ('rare','epic','legendary')
     AND (d.edition_size IS NULL OR d.minted_count < d.edition_size);

  -- Draw distinct cards; NFTs get a freshly minted serial. NFT odds are FLAT.
  -- The first successful draw is forced rare-or-better whenever v_rare_eligible > 0.
  WHILE v_got < v_target AND v_attempts < 40 LOOP
    v_attempts := v_attempts + 1;
    v_rare_only := (v_got = 0 AND v_rare_eligible > 0);

    SELECT sum(d.draw_weight::numeric)
      INTO v_total
      FROM public.farm_card_defs d
     WHERE d.is_active AND d.draw_weight > 0 AND d.species <> ALL(v_picked)
       AND (d.edition_size IS NULL OR d.minted_count < d.edition_size)
       AND (NOT v_rare_only OR d.rarity IN ('rare','epic','legendary'));
    EXIT WHEN v_total IS NULL OR v_total <= 0;

    v_roll := random() * v_total;
    SELECT species INTO v_species FROM (
      SELECT d.species,
             sum(d.draw_weight::numeric) OVER (ORDER BY d.species) AS cum
        FROM public.farm_card_defs d
       WHERE d.is_active AND d.draw_weight > 0 AND d.species <> ALL(v_picked)
         AND (d.edition_size IS NULL OR d.minted_count < d.edition_size)
         AND (NOT v_rare_only OR d.rarity IN ('rare','epic','legendary'))
    ) q
    WHERE q.cum > v_roll
    ORDER BY q.cum
    LIMIT 1;
    EXIT WHEN v_species IS NULL;

    SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_species FOR UPDATE;
    v_picked := array_append(v_picked, v_species);

    IF v_def.edition_size IS NOT NULL THEN
      -- NFT: re-check minted-ever supply under the row lock, then mint the next serial
      IF v_def.minted_count >= v_def.edition_size THEN
        CONTINUE;   -- sold out (race); already excluded via v_picked, try another card
      END IF;
      v_serial := v_def.minted_count + 1;
      -- unique funny name from the species' persona pool, by per-pool mint order
      -- (minted-ever, so a burned card never frees its name for reuse)
      SELECT COALESCE(sum(d2.minted_count), 0) INTO v_nft_idx
        FROM public.farm_card_defs d2
       WHERE d2.edition_size IS NOT NULL
         AND public.farm_nft_pool(d2.species) = public.farm_nft_pool(v_species);
      v_nft_name := public.farm_nft_persona(v_species, v_nft_idx);
      INSERT INTO public.farm_nft_instances (species, serial_no, edition_size, owner_id, acquired_from, nft_name)
      VALUES (v_species, v_serial, v_def.edition_size, v_user, 'lootbox', v_nft_name)
      RETURNING id INTO v_nft_id;
      UPDATE public.farm_card_defs SET minted_count = minted_count + 1 WHERE species = v_species;
      -- provenance log (farm-marketplace.sql); guarded so farm.sql stands alone
      IF to_regclass('public.farm_nft_transfers') IS NOT NULL THEN
        INSERT INTO public.farm_nft_transfers (instance_id, species, serial_no, from_owner, to_owner, price, kind)
        VALUES (v_nft_id, v_species, v_serial, NULL, v_user, NULL, 'mint');
      END IF;
      v_owned_nfts := v_owned_nfts + 1; -- counted only; no longer scales odds
    END IF;

    -- NFT level lives on farm_nft_instances, not farm_collection — only
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

  -- Free-tile voucher: boosted base chance, same territory decay as the
  -- standard box. No starter guarantee for gold boxes — plain roll.
  v_drop_vch := (random() < v_eff_voucher_p);

  UPDATE public.farm_user_state
     SET tile_vouchers = tile_vouchers + (CASE WHEN v_drop_vch THEN 1 ELSE 0 END)
   WHERE user_id = v_user
  RETURNING tile_vouchers INTO v_vouchers;
  IF v_drop_vch THEN
    v_got_vch := true;
    v_cards := v_cards || jsonb_build_object('voucher', true);
  END IF;

  -- Opening log (guarded so the function stands alone without the log table).
  IF to_regclass('public.farm_lootbox_opens') IS NOT NULL THEN
    PERFORM public.farm_log_lootbox_open(v_user, 'gold', v_cards);
  END IF;

  RETURN json_build_object('ok', true, 'coins', v_coins, 'boxes_gold', v_boxes_gold,
    'tile_vouchers', v_vouchers, 'got_voucher', v_got_vch, 'cards', v_cards);
END;
$$;

-- ── 4. Grants (unchanged from the superseded files) ─────────────────────────
REVOKE ALL ON FUNCTION public.open_farm_lootbox()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_farm_goldbox()  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_farm_lootbox() TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_farm_goldbox() TO authenticated;
