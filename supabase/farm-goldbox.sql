-- ═══════════════════════════════════════════════════════════════════════════
-- Farma: „Złota Skrzynia" ⭐ — premium lootbox (SECOND box type)
-- ═══════════════════════════════════════════════════════════════════════════
-- Run AFTER farm.sql, nft-leveling-rework.sql AND nft-merge-fixes.sql (this
-- file copies the LIVE open_farm_lootbox draw logic from nft-merge-fixes.sql,
-- lines 63-220, and re-applies its own edits on top). Idempotent; safe to
-- re-run. Re-run this file again after re-running nft-merge-fixes.sql so the
-- copied draw logic (minted_count-based serials/supply/persona index) stays
-- current.
--
-- This is a SELF-CONTAINED addition: it does NOT edit, replace, or otherwise
-- touch buy_farm_lootbox / open_farm_lootbox / open_farm_lootboxes. Those
-- functions and the plain `boxes` column are exclusively the standard
-- 100🪙 „Skrzynka z nasionami". Everything here operates on a brand-new
-- `boxes_gold` counter and brand-new `*_goldbox*` functions instead — by
-- design, this repo prefers duplicated per-feature SQL files over editing
-- live economy RPCs.
--
-- Product parameters (fixed):
--   • 500 🪙 per box (5× standard); buy cap 50/purchase (same as standard).
--   • Draws 5 DISTINCT cards (standard draws 3).
--   • Guaranteed rarity floor: the FIRST successful draw is forced to be
--     rare-or-better whenever any rare+ card is still drawable; the other 4
--     draw from the full pool as usual.
--   • Boosted NFT odds: edition weight decays by power(2, owned_nfts) instead
--     of the standard power(3, owned_nfts) — gentler decay ⇒ more NFTs.
--   • Boosted voucher odds: base chance 0.15 (standard 0.07), same territory
--     decay divisor power(3, territory).
--   • Gold boxes are NOT part of the starter gift and never touch
--     starter_opens_left / guaranteed_voucher — just a plain voucher roll.
--   • Coin reason for the burn: 'farm_goldbox_buy'.
--   • Net-worth / economy value per unopened gold box: 500 (its cost) — see
--     economy-stats.sql / leaderboard-net-worth-items.sql (edited alongside
--     this file, not here, since they're existing shared valuation RPCs).

-- ── A1. Column: sealed (unopened) gold boxes ─────────────────────────────────
-- Mirrors the existing land_tax_debt add+constraint pattern (farm.sql ~207-214).
ALTER TABLE public.farm_user_state ADD COLUMN IF NOT EXISTS boxes_gold integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE public.farm_user_state ADD CONSTRAINT farm_user_state_boxes_gold_chk CHECK (boxes_gold >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── A2. RPC: buy_farm_goldbox ────────────────────────────────────────────────
-- ⚠️ SUPERSEDED (2026-07-27): the gold box is WITHDRAWN FROM SALE. The LIVE
-- buy_farm_goldbox is the disabled stub in supabase/farm-goldbox-no-sale.sql
-- (always raises 'goldbox_not_for_sale', EXECUTE revoked from authenticated),
-- and the frontend has no buy UI. RE-RUN farm-goldbox-no-sale.sql after
-- re-running this file, or the box goes back on sale server-side. The body
-- below is kept only so the sale CAN be restored deliberately.
-- BURN 500 per box and add sealed (unopened) gold boxes to the buyer's
-- inventory. Opened later via open_farm_goldbox (same two-step flow as the
-- standard box: buy in the Sklep, open from 🎒 Mój Majątek). Reason
-- 'farm_goldbox_buy' (keep economy-stats.sql / leaderboard-net-worth-items.sql
-- in sync — both already edited to include it).
CREATE OR REPLACE FUNCTION public.buy_farm_goldbox(p_qty integer DEFAULT 1)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user       uuid := auth.uid();
  v_cost       integer;
  v_coins      integer;
  v_boxes_gold integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > 50 THEN RAISE EXCEPTION 'bad_qty'; END IF;
  v_cost := 500 * p_qty;

  UPDATE public.profiles SET coins = coins - v_cost
   WHERE id = v_user AND coins >= v_cost
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  INSERT INTO public.farm_user_state (user_id, boxes_gold)
  VALUES (v_user, p_qty)
  ON CONFLICT (user_id) DO UPDATE SET boxes_gold = farm_user_state.boxes_gold + EXCLUDED.boxes_gold
  RETURNING boxes_gold INTO v_boxes_gold;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_cost, 'farm_goldbox_buy', jsonb_build_object('qty', p_qty));
  END IF;

  RETURN json_build_object('ok', true, 'coins', v_coins, 'boxes_gold', v_boxes_gold, 'bought', p_qty);
END;
$$;

-- ⚠️ SUPERSEDED (2026-07-17): supabase/farm-static-nft-odds.sql carries the
-- LIVE open_farm_goldbox — it removes the per-owned-NFT weight penalty (flat NFT
-- odds) and adds the farm_lootbox_opens logging call. RE-RUN
-- farm-static-nft-odds.sql after re-running this file. (buy_farm_goldbox /
-- open_farm_goldboxes here are unchanged and remain canonical.)
-- ── A3. RPC: open_farm_goldbox ───────────────────────────────────────────────
-- Copied verbatim from the LIVE open_farm_lootbox in nft-merge-fixes.sql
-- (minted_count-driven serials/supply/persona index — the fix for the serial-
-- collision + sold-out-reopen bugs), with exactly these changes:
--   1. v_draws = 5 (vs 3).
--   2. v_voucher_p = 0.15 (vs 0.07).
--   3. Consumes boxes_gold (not boxes); raises 'no_goldbox' if none held.
--   4. NFT weight decay base 2 (vs 3) in all three draw-weight expressions.
--      The voucher territory divisor stays base 3, unchanged.
--   5. Guaranteed rare+ floor: the first successful draw is forced to
--      rarity IN ('rare','epic','legendary') whenever any such card is still
--      drawable (v_rare_eligible computed once, before the loop).
--   6. The starter-guarantee block is removed entirely — gold boxes never
--      read/write starter_opens_left or guaranteed_voucher; the voucher roll
--      is a plain random() < v_eff_voucher_p.
--   7. Returns boxes_gold (not boxes).
-- All NFT minting logic (minted_count bump, serial assignment, persona name
-- via farm_nft_persona/farm_nft_pool, farm_nft_transfers 'mint' provenance
-- row, farm_collection increments for fungible cards) is preserved unchanged.
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

  -- Draw distinct cards; NFTs get a freshly minted serial. A sold-out edition that
  -- slips through (race) is excluded and we redraw (bounded attempts). The
  -- first successful draw is forced rare-or-better whenever v_rare_eligible > 0.
  WHILE v_got < v_target AND v_attempts < 40 LOOP
    v_attempts := v_attempts + 1;
    v_rare_only := (v_got = 0 AND v_rare_eligible > 0);

    SELECT sum(CASE WHEN d.edition_size IS NOT NULL
                    THEN d.draw_weight::numeric / power(2::numeric, v_owned_nfts)
                    ELSE d.draw_weight::numeric END)
      INTO v_total
      FROM public.farm_card_defs d
     WHERE d.is_active AND d.draw_weight > 0 AND d.species <> ALL(v_picked)
       AND (d.edition_size IS NULL OR d.minted_count < d.edition_size)
       AND (NOT v_rare_only OR d.rarity IN ('rare','epic','legendary'));
    EXIT WHEN v_total IS NULL OR v_total <= 0;

    v_roll := random() * v_total;
    SELECT species INTO v_species FROM (
      SELECT d.species,
             sum(CASE WHEN d.edition_size IS NOT NULL
                      THEN d.draw_weight::numeric / power(2::numeric, v_owned_nfts)
                      ELSE d.draw_weight::numeric END)
             OVER (ORDER BY d.species) AS cum
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
      v_owned_nfts := v_owned_nfts + 1; -- same box gets lower odds for another NFT draw
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

  RETURN json_build_object('ok', true, 'coins', v_coins, 'boxes_gold', v_boxes_gold,
    'tile_vouchers', v_vouchers, 'got_voucher', v_got_vch, 'cards', v_cards);
END;
$$;

-- ── A4. RPC: open_farm_goldboxes (bulk) ──────────────────────────────────────
-- Mirrors farm-bulk-lootbox.sql's open_farm_lootboxes: opens up to
-- FARM_GOLDBOX_BULK_OPEN_MAX (20, mirrored in index.html) sealed gold boxes in
-- ONE transaction by looping the canonical single-box open_farm_goldbox().
-- Wrapping (instead of duplicating the draw logic) keeps this correct no
-- matter which copy of open_farm_goldbox is live. All per-box rules apply
-- exactly as if the boxes were opened one by one (NFT/voucher odds shrink
-- between boxes of the same batch).
CREATE OR REPLACE FUNCTION public.open_farm_goldboxes(p_qty integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user           uuid := auth.uid();
  v_max            constant integer := 20;   -- keep in sync with FARM_GOLDBOX_BULK_OPEN_MAX in index.html
  v_boxes_gold     integer;
  v_res            jsonb;
  v_packs          jsonb := '[]'::jsonb;
  v_vch            boolean := false;
  v_total_cards    integer := 0;
  v_total_vouchers integer := 0;
  i                integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > v_max THEN RAISE EXCEPTION 'bad_qty'; END IF;

  -- Lock the state row so the whole batch is serialized per user and we can
  -- fail fast with a clean error instead of aborting mid-loop on box #k.
  SELECT boxes_gold INTO v_boxes_gold FROM public.farm_user_state
   WHERE user_id = v_user FOR UPDATE;
  IF COALESCE(v_boxes_gold, 0) < p_qty THEN RAISE EXCEPTION 'no_goldbox'; END IF;

  FOR i IN 1..p_qty LOOP
    v_res := public.open_farm_goldbox()::jsonb;
    v_packs := v_packs || jsonb_build_array(jsonb_build_object(
      'cards', COALESCE(v_res->'cards', '[]'::jsonb),
      'got_voucher', COALESCE((v_res->>'got_voucher')::boolean, false)));
    v_total_cards := v_total_cards + jsonb_array_length(COALESCE(v_res->'cards', '[]'::jsonb));
    IF COALESCE((v_res->>'got_voucher')::boolean, false) THEN
      v_vch := true;
      v_total_vouchers := v_total_vouchers + 1;
    END IF;
  END LOOP;

  -- Totals come from the LAST inner call (state after the whole batch).
  RETURN json_build_object(
    'ok', true, 'opened', p_qty,
    'boxes_gold', v_res->'boxes_gold',
    'tile_vouchers', v_res->'tile_vouchers',
    'got_voucher', v_vch,
    'total_cards', v_total_cards,
    'total_vouchers', v_total_vouchers,
    'packs', v_packs);
END;
$$;

-- ── A5. Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.buy_farm_goldbox(integer)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_farm_goldbox()            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_farm_goldboxes(integer)   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buy_farm_goldbox(integer)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_farm_goldbox()          TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_farm_goldboxes(integer) TO authenticated;
