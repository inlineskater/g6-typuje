-- ═══════════════════════════════════════════════════════════════════════════
--  Farma: „♻️ Kompostownik" — a sink for surplus low-tier plant cards.
--  Run AFTER farm.sql + farm-goldbox.sql (it hands out ⭐ gold boxes) and after
--  farm-card-bulk-listing.sql (it mirrors that file's planted/listed reservation
--  rule). Idempotent — nothing here is superseded by another file, and this file
--  supersedes nothing, so re-running any farm file does NOT revert it.
--
--  WHY: duplicates were a one-way pile. level_up_card costs 2×L cards but
--  50×L² coins, so the coin term outruns the card term almost immediately and
--  cards stop being the binding constraint around level 6-8. Measured 2026-08-30
--  on prod: 25 619 fungible cards held office-wide (16 891 common / 7 166 rare /
--  1 562 epic) against players sitting on 59–46 000 coins — i.e. everybody had
--  hundreds of commons they could never spend, and the pile only grows with
--  every box. It was also 930 420 🪙 of net worth in cards nobody can use
--  (a common duplicate is valued at a flat 20 🪙 forever, unbounded).
--
--  WHAT: a same-species trade-up ladder, no coin cost (the players holding the
--  biggest piles are the coin-poorest — a fee would price out exactly the people
--  the sink exists for):
--      15 × one common  → 1 random RARE card
--      10 × one rare    → 1 random EPIC card
--      10 × one epic    → 1 ⭐ Złota Skrzynia (the withdrawn-from-sale premium box)
--
--  The rates are deliberately far worse than a lootbox's natural rarity mix
--  (a box draws ≈64% common / 26% rare / 9% epic, so the "fair" common→rare rate
--  would be ≈2.4:1). This is a junk sink, not a second economy: every rung burns
--  net worth (15 commons = 300 🪙 → one rare = 50 🪙) and strictly reduces the
--  number of cards in the game. It cannot mint coins — no branch of this file
--  touches profiles.coins — so it is neutral for docs/anti-inflation.md.
--
--  The output card is drawn at random inside the target rarity, weighted by
--  draw_weight like a lootbox, so a big pile can't be aimed straight at the one
--  species a player wants to level.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Policy knobs (one-line IMMUTABLE functions, per the anti-inflation.sql
--    convention: a number the balance depends on gets a name and one home) ────
CREATE OR REPLACE FUNCTION public.farm_compost_cost(p_rarity text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_rarity WHEN 'common' THEN 15 WHEN 'rare' THEN 10 WHEN 'epic' THEN 10 END;
$$;

-- What one conversion yields. NULL = that rarity cannot be composted.
CREATE OR REPLACE FUNCTION public.farm_compost_yield(p_rarity text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_rarity WHEN 'common' THEN 'rare' WHEN 'rare' THEN 'epic' WHEN 'epic' THEN 'goldbox' END;
$$;

-- Max conversions per call (one transaction, one animation).
CREATE OR REPLACE FUNCTION public.farm_compost_max_batch()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 25; $$;

-- ── Net-worth valuation: usable copies at face value, surplus at scrap ─────
-- A duplicate used to be worth a flat 20/50/150 🪙 of net worth with NO cap, so
-- the pile the composter exists to drain was ALSO inflating the leaderboard:
-- 930 420 🪙 of it on 2026-08-30, and the four biggest holders were the four
-- coin-poorest players. A card you cannot use is not worth a card you can.
--
-- „Usable" = the copies a player can actually spend on the next level-up,
-- 2×level + 1 (the level-up cost plus the blueprint that always stays). Anything
-- past that is priced at exactly what the composter will give for it, so the two
-- halves of this file can never disagree: surplus value = value of what one
-- conversion yields ÷ its cost.
CREATE OR REPLACE FUNCTION public.farm_card_full_value(p_rarity text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_rarity WHEN 'epic' THEN 150 WHEN 'rare' THEN 50 ELSE 20 END;
$$;

-- Scrap value of one surplus copy = what the composter pays per card burned.
-- A rarity with no compost path keeps its face value (nothing to discount to).
-- The 500 mirrors the sealed ⭐ gold box valuation in the three net-worth
-- functions; keep them together if that number ever moves.
CREATE OR REPLACE FUNCTION public.farm_card_surplus_value(p_rarity text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    CASE
      WHEN public.farm_compost_yield(p_rarity) IS NULL THEN NULL   -- no ladder → no discount
      WHEN public.farm_compost_yield(p_rarity) = 'goldbox'
        THEN 500 / public.farm_compost_cost(p_rarity)
      ELSE public.farm_card_full_value(public.farm_compost_yield(p_rarity))
           / public.farm_compost_cost(p_rarity)
    END,
    public.farm_card_full_value(p_rarity));
$$;

-- Value of one farm_collection row. ⚠️ The three net-worth functions
-- (user_assets_value / user_net_worth_breakdown / economy_stats) all call THIS —
-- do not re-inline the old flat CASE into any of them.
CREATE OR REPLACE FUNCTION public.farm_card_stack_value(p_count integer, p_level integer, p_rarity text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT LEAST(GREATEST(COALESCE(p_count, 0), 0), 2 * GREATEST(COALESCE(p_level, 1), 1) + 1)
         * public.farm_card_full_value(p_rarity)
       + GREATEST(COALESCE(p_count, 0) - (2 * GREATEST(COALESCE(p_level, 1), 1) + 1), 0)
         * public.farm_card_surplus_value(p_rarity);
$$;

-- ── Log (own-row SELECT; powers the modal's history + any later stats) ──────
CREATE TABLE IF NOT EXISTS public.farm_compost_log (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  from_species text NOT NULL,
  from_rarity  text NOT NULL,
  burned      integer NOT NULL,
  got_species text,                       -- NULL when the yield was a gold box
  got_gold_boxes integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS farm_compost_log_user_idx
  ON public.farm_compost_log (user_id, created_at DESC);

ALTER TABLE public.farm_compost_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS farm_compost_log_own ON public.farm_compost_log;
CREATE POLICY farm_compost_log_own ON public.farm_compost_log
  FOR SELECT USING (auth.uid() = user_id);
REVOKE ALL ON public.farm_compost_log FROM anon, authenticated;
GRANT SELECT ON public.farm_compost_log TO authenticated;

-- ── RPC: compost_cards ─────────────────────────────────────────────────────
-- Burn p_times × cost duplicates of ONE species; get p_times cards of the next
-- rarity (or gold boxes, at the top of the ladder).
--
-- ⚠️ Two copies are never burnable, mirroring create_farm_card_listing:
--    (a) one copy per tile currently planted with this species — those back a
--        growing crop and cannot be sold out from under it;
--    (b) the last remaining copy — the card is a permanent blueprint, and
--        composting your only Marchewka would silently delete the ability to
--        plant it at all. Composting must never cost a player a species.
--    Copies already reserved by an open Targowisko listing are ALREADY
--    subtracted from farm_collection.count by that file, so they need no guard.
CREATE OR REPLACE FUNCTION public.compost_cards(p_species text, p_times integer DEFAULT 1)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user     uuid := auth.uid();
  v_def      public.farm_card_defs%ROWTYPE;
  v_row      public.farm_collection%ROWTYPE;
  v_yield    text;
  v_cost     integer;
  v_times    integer;
  v_planted  integer;
  v_free     integer;
  v_burn     integer;
  v_gold     integer := 0;
  v_total    numeric;
  v_roll     numeric;
  v_species  text;
  v_out      public.farm_card_defs%ROWTYPE;
  v_new      integer;
  v_results  jsonb := '[]'::jsonb;
  i          integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = p_species;
  IF NOT FOUND THEN RAISE EXCEPTION 'bad_species'; END IF;
  IF v_def.edition_size IS NOT NULL THEN RAISE EXCEPTION 'nft_not_compostable'; END IF;

  v_yield := public.farm_compost_yield(v_def.rarity);
  v_cost  := public.farm_compost_cost(v_def.rarity);
  IF v_yield IS NULL OR v_cost IS NULL THEN RAISE EXCEPTION 'rarity_not_compostable'; END IF;

  v_times := LEAST(GREATEST(COALESCE(p_times, 1), 1), public.farm_compost_max_batch());

  SELECT * INTO v_row FROM public.farm_collection
   WHERE user_id = v_user AND species = p_species FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_card'; END IF;

  SELECT count(*) INTO v_planted
    FROM public.farm_tiles
   WHERE owner_id = v_user AND planted_species = p_species;

  -- keep the blueprint + one copy per planted tile
  v_free := v_row.count - GREATEST(v_planted, 1);
  IF v_free < v_cost THEN RAISE EXCEPTION 'not_enough_cards'; END IF;

  v_times := LEAST(v_times, v_free / v_cost);
  v_burn  := v_times * v_cost;

  UPDATE public.farm_collection SET count = count - v_burn
   WHERE user_id = v_user AND species = p_species
     AND count - v_burn >= GREATEST(v_planted, 1)
  RETURNING count INTO v_row.count;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_enough_cards'; END IF;   -- lost a race

  IF v_yield = 'goldbox' THEN
    v_gold := v_times;
    INSERT INTO public.farm_user_state (user_id) VALUES (v_user) ON CONFLICT (user_id) DO NOTHING;
    UPDATE public.farm_user_state SET boxes_gold = boxes_gold + v_gold WHERE user_id = v_user;
    INSERT INTO public.farm_compost_log (user_id, from_species, from_rarity, burned, got_gold_boxes)
    VALUES (v_user, p_species, v_def.rarity, v_burn, v_gold);
    v_results := v_results || jsonb_build_object('gold_box', true, 'qty', v_gold);
  ELSE
    FOR i IN 1..v_times LOOP
      -- weighted draw inside the target rarity, lootbox-style; NFT editions are
      -- excluded (edition_size IS NOT NULL) so this can never mint a serial.
      SELECT sum(d.draw_weight::numeric) INTO v_total
        FROM public.farm_card_defs d
       WHERE d.is_active AND d.draw_weight > 0 AND d.rarity = v_yield AND d.edition_size IS NULL;
      IF v_total IS NULL OR v_total <= 0 THEN RAISE EXCEPTION 'pool_empty'; END IF;

      v_roll := random() * v_total;
      SELECT species INTO v_species FROM (
        SELECT d.species, sum(d.draw_weight::numeric) OVER (ORDER BY d.species) AS cum
          FROM public.farm_card_defs d
         WHERE d.is_active AND d.draw_weight > 0 AND d.rarity = v_yield AND d.edition_size IS NULL
      ) q WHERE q.cum > v_roll ORDER BY q.cum LIMIT 1;
      IF v_species IS NULL THEN RAISE EXCEPTION 'pool_empty'; END IF;

      SELECT * INTO v_out FROM public.farm_card_defs WHERE species = v_species;

      INSERT INTO public.farm_collection (user_id, species, count, level)
      VALUES (v_user, v_species, 1, 1)
      ON CONFLICT (user_id, species) DO UPDATE SET count = farm_collection.count + 1
      RETURNING count INTO v_new;

      INSERT INTO public.farm_compost_log (user_id, from_species, from_rarity, burned, got_species)
      VALUES (v_user, p_species, v_def.rarity, v_cost, v_species);

      v_results := v_results || jsonb_build_object(
        'species', v_species, 'name', v_out.name, 'emoji', v_out.emoji,
        'rarity', v_out.rarity, 'new_count', v_new);
    END LOOP;
  END IF;

  RETURN json_build_object('ok', true, 'species', p_species, 'rarity', v_def.rarity,
    'times', v_times, 'burned', v_burn, 'count', v_row.count,
    'gold_boxes', v_gold, 'results', v_results);
END;
$$;

REVOKE ALL ON FUNCTION public.compost_cards(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compost_cards(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.farm_compost_cost(text)      TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.farm_compost_yield(text)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.farm_compost_max_batch()     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.farm_card_full_value(text)                       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.farm_card_surplus_value(text)                    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.farm_card_stack_value(integer, integer, text)    TO anon, authenticated;

COMMIT;
