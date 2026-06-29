-- Farma — Stardew/Happy-Farm + collectible plant-card economy (Phase 1)
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run).
-- Idempotent: CREATE ... IF NOT EXISTS / CREATE OR REPLACE / guarded blocks — safe to re-run.
--
-- A shared 10 x 4 grid with real per-tile OWNERSHIP layered on the
-- Ogródek tab (the old zen water_plant view is hidden but reused for plant tiles). Loop:
--   buy tile (BURN, escalating) → open lootbox (BURN 100) → collect plant CARDS
--   → level a card with duplicates + coins (BURN) → plant a card on an owned tile
--   → it grows over real time → harvest crops into inventory (crops minted, not coins)
--   → sell crops to the NPC at a dynamic supply/demand price (coins MINTED).
--
-- Grid bounds (13 x 4) are mirrored in index.html as FARM_W / FARM_H — keep in sync.
-- Grid is 13 wide x 4 tall (FARM_W x FARM_H in index.html). Existing Ogródek
-- plants occupy the first cells (acquired_via 'migration'); crops can't grow there.
-- Coin reasons added here (keep economy-stats.sql + leaderboard-net-worth-items.sql in sync):
--   BURN:  farm_tile_buy, farm_box_buy, card_levelup
--   MINT:  farm_crop_sale
-- Boxes are bought (farm_box_buy BURN) then opened from inventory; opening itself
-- moves no coins. Boxes can drop a free-tile voucher (claims a tile for 0 coins).

-- ── Tables ─────────────────────────────────────────────────────────────────

-- Card catalog (templates). Like hero_item_defs. edition_size NULL = uncapped
-- collectible (feeds the dupe-leveling loop); a non-NULL edition_size marks a
-- serialized NFT card (Phase 2): it drops from the normal lootbox until the
-- edition sells out, and each draw mints a row in farm_nft_instances.
CREATE TABLE IF NOT EXISTS public.farm_card_defs (
  species           text PRIMARY KEY CHECK (species ~ '^[a-z0-9_]+$'),
  name              text NOT NULL,
  emoji             text NOT NULL,
  rarity            text NOT NULL CHECK (rarity IN ('common','rare','epic','legendary')),
  draw_weight       integer NOT NULL DEFAULT 0 CHECK (draw_weight >= 0),
  base_grow_minutes integer NOT NULL CHECK (base_grow_minutes > 0),
  base_yield        integer NOT NULL CHECK (base_yield > 0),
  crop_type         text NOT NULL,
  edition_size      integer,              -- NULL = collectible (Phase 1)
  is_active         boolean NOT NULL DEFAULT true
);

-- Owned tiles (sparse — unowned tiles have no row, like canvas_pixels).
-- One crop per tile at a time; crop state lives on the tile row.
CREATE TABLE IF NOT EXISTS public.farm_tiles (
  x               integer NOT NULL,
  y               integer NOT NULL,
  owner_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  acquired_via    text NOT NULL DEFAULT 'purchase' CHECK (acquired_via IN ('migration','purchase','lootbox')),
  acquired_at     timestamptz NOT NULL DEFAULT now(),
  planted_species text,                   -- NULL = empty owned tile
  planted_level   integer,                -- card level snapshot at plant time
  planted_at      timestamptz,
  ready_at        timestamptz,
  PRIMARY KEY (x, y)
);
CREATE INDEX IF NOT EXISTS farm_tiles_owner_idx ON public.farm_tiles(owner_id);
-- Links a migration tile to the specific gardens row it displays (one tile per
-- plant, so owners with two Ogródek plants get two migration tiles).
ALTER TABLE public.farm_tiles ADD COLUMN IF NOT EXISTS zen_garden_id uuid;

-- Per-user plant-card pile: duplicate count + level per species.
CREATE TABLE IF NOT EXISTS public.farm_collection (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  species text NOT NULL REFERENCES public.farm_card_defs(species),
  count   integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  level   integer NOT NULL DEFAULT 1 CHECK (level >= 1),
  PRIMARY KEY (user_id, species)
);

-- Harvested crops, stored as per-harvest LOTS so each batch can ROT 5 days after
-- collection (expires_at). qty = units remaining in that lot; one crop_type can
-- have several live lots. (Older schema used PK (user_id,crop_type) with no
-- timestamp; the migration block after the seeds reshapes existing prod tables.)
CREATE TABLE IF NOT EXISTS public.farm_inventory (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  crop_type    text NOT NULL,
  qty          integer NOT NULL DEFAULT 0 CHECK (qty >= 0),
  harvested_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '5 days')
);

-- Fluctuating NPC price state, one row per crop_type. Server-owned.
-- base_price = catalog MAX/ceiling; anchor_price = the current "normal" set twice
-- daily by roll_farm_prices() (sales revert toward it); cur_price = the live price
-- (sales dip it, it recovers toward anchor_price). See farm-price-history.sql.
CREATE TABLE IF NOT EXISTS public.farm_market (
  crop_type     text PRIMARY KEY,
  base_price    numeric NOT NULL CHECK (base_price > 0),  -- catalog MAX / ceiling ("Cena maks.")
  anchor_price  numeric,                                  -- current rolled "normal" (≤ base); sales revert toward it
  cur_price     numeric NOT NULL,                         -- live price; sales dip it, recovers toward anchor_price
  total_sold    bigint NOT NULL DEFAULT 0,
  last_decay_at timestamptz NOT NULL DEFAULT now()
);

-- Serialized NFT card instances (Phase 2). Each row is a unique, numbered copy
-- of an edition-capped legendary card (farm_card_defs.edition_size IS NOT NULL).
-- The fungible farm_collection still tracks count/level for planting/leveling;
-- this table adds the per-instance serial number + provenance that gives scarcity
-- value. UNIQUE(species, serial_no) serializes minting under the def row lock.
CREATE TABLE IF NOT EXISTS public.farm_nft_instances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  species       text NOT NULL REFERENCES public.farm_card_defs(species),
  serial_no     integer NOT NULL CHECK (serial_no > 0),
  edition_size  integer NOT NULL CHECK (edition_size > 0),
  owner_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  acquired_from text NOT NULL DEFAULT 'lootbox',
  acquired_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (species, serial_no)
);
CREATE INDEX IF NOT EXISTS farm_nft_owner_idx   ON public.farm_nft_instances(owner_id);
CREATE INDEX IF NOT EXISTS farm_nft_species_idx ON public.farm_nft_instances(species);
-- Each serialized NFT gets a unique, funny person-name (assigned at mint from a
-- curated pool by global mint order; the pool is larger than the total edition
-- supply, so names never collide). Backfilled for instances minted before this.
ALTER TABLE public.farm_nft_instances ADD COLUMN IF NOT EXISTS nft_name text;

-- Whether an NFT species is grammatically feminine, so its persona name matches
-- (e.g. „Róża" → a woman's name). Extend this set if feminine NFT species are added.
CREATE OR REPLACE FUNCTION public.farm_nft_is_female(p_species text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_species IN ('diamond_rose');
$$;

-- Curated, gendered pools of single-word Old Slavic / Old Polish persona names.
-- Female pool (30) ≥ the largest feminine edition (Róża 25); male pool (35) ≥ the
-- male editions (15+10). Assigned by a PER-GENDER mint index, so each is unique.
-- NOTE: most species name through farm_nft_persona() below, which routes some
-- species to their own regional pool (e.g. the 'Ae Ae banana → Hawaiian names);
-- this Slavic function is the fallback for everything else.
CREATE OR REPLACE FUNCTION public.farm_nft_name(p_idx integer, p_female boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_female THEN (ARRAY[
    'Dobrawa','Świętosława','Bogna','Bożena','Mirosława','Wisława',
    'Ludmiła','Bolesława','Sławomira','Dobromiła','Radosława','Wszemiła',
    'Gościsława','Tomisława','Bogusława','Dziewanna','Lubomira','Miłosława',
    'Przybysława','Sędzimira','Witosława','Zdzisława','Żelisława','Bronisława',
    'Jarosława','Niegosława','Unisława','Wojsława','Domosława','Wielisława'
  ])[ (abs(p_idx) % 30) + 1 ]
  ELSE (ARRAY[
    'Bożydar','Mścisław','Dobrosław','Świętosław','Bolesław','Mieszko',
    'Ziemowit','Siemowit','Sławomir','Bogusław','Radosław','Włodzimierz',
    'Wszebor','Gniewomir','Jaromir','Lubomir','Przemysław','Dobromir',
    'Bronisław','Czcibor','Świętopełk','Chwalimir','Sędzimir','Tomisław',
    'Witosław','Budzisław','Dalebor','Jarogniew','Niegosław','Racibor',
    'Stojgniew','Unisław','Wojsław','Zbigniew','Żelisław'
  ])[ (abs(p_idx) % 35) + 1 ] END;
$$;

-- Which persona pool an NFT species draws from. Hawaiian for the 'Ae Ae banana
-- (named after people of Hawaii, where it grows); Slavic male/female otherwise.
CREATE OR REPLACE FUNCTION public.farm_nft_pool(p_species text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_species = 'aeae_banana' THEN 'hawaii'
    WHEN public.farm_nft_is_female(p_species) THEN 'female'
    ELSE 'male' END;
$$;

-- Persona name for an NFT instance: Hawaiian pool for the 'Ae Ae banana, else the
-- existing gendered Slavic pools. Indexed by a PER-POOL mint order so names stay
-- unique within each pool. Hawaiian pool (14) ≥ the banana edition (5).
CREATE OR REPLACE FUNCTION public.farm_nft_persona(p_species text, p_idx integer)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE public.farm_nft_pool(p_species)
    WHEN 'hawaii' THEN (ARRAY[
      'Kai','Leilani','Keanu','Nalani','Koa','Mahina','Kawika',
      'Noelani','Kainoa','Makoa','Kekoa','Iolana','Alaula','Pualani'
    ])[ (abs(p_idx) % 14) + 1 ]
    ELSE public.farm_nft_name(p_idx, public.farm_nft_is_female(p_species))
  END;
$$;

-- Per-user owned consumables: sealed (unopened) seed boxes + free-tile vouchers.
-- Boxes are bought first (buy_farm_lootbox, BURN) then opened later
-- (open_farm_lootbox decrements one). Tile vouchers drop from boxes and let the
-- holder claim one empty tile for free (buy_farm_tile consumes one if present).
CREATE TABLE IF NOT EXISTS public.farm_user_state (
  user_id        uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  boxes          integer NOT NULL DEFAULT 0 CHECK (boxes >= 0),
  tile_vouchers  integer NOT NULL DEFAULT 0 CHECK (tile_vouchers >= 0),
  -- One-time welcome gift: 3 sealed boxes, with a tile voucher guaranteed to drop
  -- within those first 3 openings (claim_farm_starter sets the window below).
  starter_granted     boolean NOT NULL DEFAULT false,
  starter_opens_left  integer NOT NULL DEFAULT 0 CHECK (starter_opens_left >= 0),
  guaranteed_voucher  boolean NOT NULL DEFAULT false
);
-- Backfill columns onto an existing table from before the starter gift shipped.
ALTER TABLE public.farm_user_state ADD COLUMN IF NOT EXISTS starter_granted    boolean NOT NULL DEFAULT false;
ALTER TABLE public.farm_user_state ADD COLUMN IF NOT EXISTS starter_opens_left integer NOT NULL DEFAULT 0;
ALTER TABLE public.farm_user_state ADD COLUMN IF NOT EXISTS guaranteed_voucher boolean NOT NULL DEFAULT false;

-- ── Seed card defs (collectibles) ──────────────────────────────────────────
-- crop_type == species for Phase 1. Tunable later via an admin RPC (Phase 4).
-- base_grow_minutes are in MINUTES: commons = 1 day (1440), rares = 2 days,
-- epics = 3-4 days. plant_crop floors the actual grow time at 24h (GROW_FLOOR_MIN),
-- so leveling can speed harvests up but NEVER below once-a-day.
INSERT INTO public.farm_card_defs (species, name, emoji, rarity, draw_weight, base_grow_minutes, base_yield, crop_type) VALUES
  ('carrot',     'Marchewka',  '🥕', 'common', 30, 1440,  4,  'carrot'),
  ('potato',     'Ziemniak',   '🥔', 'common', 28, 1440,  5,  'potato'),
  ('tomato',     'Pomidor',    '🍅', 'common', 24, 1440,  6,  'tomato'),
  ('corn',       'Kukurydza',  '🌽', 'rare',   13, 2880, 12,  'corn'),
  ('chili',      'Papryczka',  '🌶️', 'rare',   12, 2880, 11,  'chili'),
  ('strawberry', 'Truskawka',  '🍓', 'rare',    9, 2880, 15,  'strawberry'),
  ('pumpkin',    'Dynia',      '🎃', 'epic',    5, 4320, 30,  'pumpkin'),
  ('grapes',     'Winogrona',  '🍇', 'epic',    4, 4320, 35,  'grapes'),
  ('pineapple',  'Ananas',     '🍍', 'epic',    3, 5760, 45,  'pineapple')
ON CONFLICT (species) DO UPDATE SET
  name = EXCLUDED.name, emoji = EXCLUDED.emoji, rarity = EXCLUDED.rarity,
  draw_weight = EXCLUDED.draw_weight, base_grow_minutes = EXCLUDED.base_grow_minutes,
  base_yield = EXCLUDED.base_yield, crop_type = EXCLUDED.crop_type;

-- ── Seed legendary NFT cards (edition-capped, serialized) ──────────────────
-- These have edition_size set, so open_farm_lootbox mints a unique serial number
-- on draw and stops dropping them once the edition is sold out. They drop from the
-- normal box (low draw_weight) and are plantable like any card (strong stats).
INSERT INTO public.farm_card_defs (species, name, emoji, rarity, draw_weight, base_grow_minutes, base_yield, crop_type, edition_size) VALUES
  ('diamond_rose',     'Diamentowa Róża',   '🌹', 'legendary', 2, 4320,  60, 'diamond_rose',     25),
  ('golden_sunflower', 'Złoty Słonecznik',  '🌻', 'legendary', 1, 5760,  80, 'golden_sunflower', 15),
  ('crystal_lotus',    'Kryształowy Lotos', '🪷', 'legendary', 1, 5760, 100, 'crystal_lotus',    10),
  -- Apex card: the variegated Hawaiian „Ae Ae" banana (Musa × paradisiaca 'Ae Ae'),
  -- once reserved for Hawaiian royalty — smallest edition (5), highest yield/price,
  -- so it is the rarest, most expensive and most profitable NFT in the game.
  ('aeae_banana',      'Królewski Banan Ae Ae', '🍌', 'legendary', 1, 5760, 120, 'aeae_banana', 5)
ON CONFLICT (species) DO UPDATE SET
  name = EXCLUDED.name, emoji = EXCLUDED.emoji, rarity = EXCLUDED.rarity,
  draw_weight = EXCLUDED.draw_weight, base_grow_minutes = EXCLUDED.base_grow_minutes,
  base_yield = EXCLUDED.base_yield, crop_type = EXCLUDED.crop_type,
  edition_size = EXCLUDED.edition_size;

-- ── Seed market rows (one per crop_type) ───────────────────────────────────
-- Crop base prices tuned so commons clearly beat free zen-garden watering and the
-- ladder smooths up: commons ≈48–54🪙/day, rares ≈94–98, epics ≈200 (≈Zysk/doba at
-- level 1 = yield × price ÷ grow-days). NFT prices are prestige-tier and left high.
-- DO UPDATE (not DO NOTHING) so re-running re-applies tuning to existing rows; note
-- that also resets cur_price back to base (wipes live supply/demand state).
INSERT INTO public.farm_market (crop_type, base_price, anchor_price, cur_price) VALUES
  ('carrot',     12, 12, 12),
  ('potato',     10, 10, 10),
  ('tomato',      9,  9,  9),
  ('corn',       16, 16, 16),
  ('chili',      17, 17, 17),
  ('strawberry', 13, 13, 13),
  ('pumpkin',    20, 20, 20),
  ('grapes',     18, 18, 18),
  ('pineapple',  18, 18, 18),
  ('diamond_rose',     40, 40, 40),
  ('golden_sunflower', 55, 55, 55),
  ('crystal_lotus',    80, 80, 80),
  ('aeae_banana',     120,120,120)
ON CONFLICT (crop_type) DO UPDATE SET
  base_price   = EXCLUDED.base_price,
  anchor_price = EXCLUDED.base_price,
  cur_price    = EXCLUDED.base_price;

-- Migration for prod rows created before anchor_price existed: backfill it.
ALTER TABLE public.farm_market ADD COLUMN IF NOT EXISTS anchor_price numeric;
UPDATE public.farm_market SET anchor_price = base_price WHERE anchor_price IS NULL;

-- ── Migration: reshape farm_inventory into per-harvest lots (rot support) ───
-- Older schema: PK (user_id, crop_type), no timestamps. New: id PK + harvested_at
-- + expires_at so each harvest rots 5 days later. The table is sparse/empty in
-- prod (crops are sold quickly), so when the old PK is present we just DROP and
-- recreate with the lot schema; the RLS/grants/realtime blocks below re-apply to
-- the fresh table. (CREATE TABLE IF NOT EXISTS above is a no-op once it exists,
-- so the reshape must happen here.)
DO $$
BEGIN
  IF to_regclass('public.farm_inventory') IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.farm_inventory'::regclass AND contype = 'p'
       AND pg_get_constraintdef(oid) LIKE '%(user_id, crop_type)%'
  ) THEN
    DROP TABLE public.farm_inventory;
    CREATE TABLE public.farm_inventory (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      crop_type    text NOT NULL,
      qty          integer NOT NULL DEFAULT 0 CHECK (qty >= 0),
      harvested_at timestamptz NOT NULL DEFAULT now(),
      expires_at   timestamptz NOT NULL DEFAULT (now() + interval '5 days')
    );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS farm_inventory_lot_idx ON public.farm_inventory(user_id, crop_type, expires_at);

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.farm_card_defs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_tiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_collection    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_inventory     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_market        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_nft_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_user_state     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farm_card_defs_select" ON public.farm_card_defs;
CREATE POLICY "farm_card_defs_select" ON public.farm_card_defs
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "farm_tiles_select" ON public.farm_tiles;
CREATE POLICY "farm_tiles_select" ON public.farm_tiles
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "farm_market_select" ON public.farm_market;
CREATE POLICY "farm_market_select" ON public.farm_market
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "farm_collection_select_own" ON public.farm_collection;
CREATE POLICY "farm_collection_select_own" ON public.farm_collection
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "farm_inventory_select_own" ON public.farm_inventory;
CREATE POLICY "farm_inventory_select_own" ON public.farm_inventory
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- NFT instances are publicly readable (serial #N/edition is a public showcase).
DROP POLICY IF EXISTS "farm_nft_select" ON public.farm_nft_instances;
CREATE POLICY "farm_nft_select" ON public.farm_nft_instances
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "farm_user_state_select_own" ON public.farm_user_state;
CREATE POLICY "farm_user_state_select_own" ON public.farm_user_state
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- No direct client writes — everything goes through the RPCs below.
REVOKE ALL ON public.farm_card_defs, public.farm_tiles, public.farm_collection,
              public.farm_inventory, public.farm_market, public.farm_nft_instances,
              public.farm_user_state FROM anon, authenticated;
GRANT SELECT ON public.farm_card_defs, public.farm_tiles, public.farm_market, public.farm_nft_instances TO anon, authenticated;
GRANT SELECT ON public.farm_collection, public.farm_inventory, public.farm_user_state TO authenticated;

-- ── Realtime ───────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['farm_tiles','farm_market','farm_collection','farm_inventory','farm_nft_instances','farm_user_state'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ── RPC: buy_farm_tile ─────────────────────────────────────────────────────
-- Claim an unowned tile for an escalating coin price (BURN). The PK uniqueness
-- is the serialization point: INSERT ... ON CONFLICT DO NOTHING means two
-- concurrent claims resolve to exactly one winner. Claim FIRST, then charge —
-- if coins are insufficient the RAISE rolls back the claim (single txn).
CREATE OR REPLACE FUNCTION public.buy_farm_tile(p_x integer, p_y integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user     uuid := auth.uid();
  v_tiles    integer;
  v_price    integer;
  v_claimed  uuid;
  v_coins    integer;
  v_voucher  boolean := false;
  v_vouchers integer := 0;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_x < 0 OR p_x >= 13 OR p_y < 0 OR p_y >= 4 THEN RAISE EXCEPTION 'bad_coords'; END IF;

  SELECT count(*) INTO v_tiles FROM public.farm_tiles WHERE owner_id = v_user;
  v_price := floor(350 * (1 + v_tiles * 0.25))::integer;  -- anti-monopoly escalation (base 350)

  -- A free-tile voucher (dropped by a seed box) claims a tile for 0 coins.
  -- Consume one under a row lock; if none, fall back to the escalating coin price.
  UPDATE public.farm_user_state SET tile_vouchers = tile_vouchers - 1
   WHERE user_id = v_user AND tile_vouchers > 0
  RETURNING tile_vouchers INTO v_vouchers;
  IF FOUND THEN v_voucher := true; ELSE v_price := v_price; END IF;

  INSERT INTO public.farm_tiles (x, y, owner_id, acquired_via)
  VALUES (p_x, p_y, v_user, CASE WHEN v_voucher THEN 'lootbox' ELSE 'purchase' END)
  ON CONFLICT (x, y) DO NOTHING
  RETURNING owner_id INTO v_claimed;
  IF v_claimed IS NULL THEN RAISE EXCEPTION 'tile_taken'; END IF;

  IF v_voucher THEN
    -- free claim via voucher: no coin movement, no ledger row
    SELECT coins INTO v_coins FROM public.profiles WHERE id = v_user;
    RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'price', 0,
                             'coins', v_coins, 'via', 'voucher', 'tile_vouchers', v_vouchers);
  END IF;

  UPDATE public.profiles SET coins = coins - v_price
   WHERE id = v_user AND coins >= v_price
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_price, 'farm_tile_buy', jsonb_build_object('x', p_x, 'y', p_y, 'price', v_price));
  END IF;

  RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'price', v_price,
                           'coins', v_coins, 'via', 'coins');
END;
$$;

-- ── RPC: claim_farm_starter ────────────────────────────────────────────────
-- One-time welcome gift: grant 3 free sealed boxes and arm a guaranteed tile
-- voucher within those first 3 openings, so every new (and existing) player can
-- claim their first Ogródek tile for free. Idempotent via starter_granted — the
-- frontend may call it on every farm load; only the first call grants anything.
CREATE OR REPLACE FUNCTION public.claim_farm_starter()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_granted boolean;
  v_boxes   integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  INSERT INTO public.farm_user_state (user_id) VALUES (v_user)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT starter_granted INTO v_granted FROM public.farm_user_state
   WHERE user_id = v_user FOR UPDATE;

  IF v_granted THEN
    SELECT boxes INTO v_boxes FROM public.farm_user_state WHERE user_id = v_user;
    RETURN json_build_object('ok', true, 'granted', false, 'boxes', v_boxes);
  END IF;

  UPDATE public.farm_user_state
     SET boxes = boxes + 3, starter_granted = true,
         starter_opens_left = 3, guaranteed_voucher = true
   WHERE user_id = v_user
  RETURNING boxes INTO v_boxes;

  RETURN json_build_object('ok', true, 'granted', true, 'boxes', v_boxes, 'gift_boxes', 3);
END;
$$;

-- ── RPC: buy_farm_lootbox ──────────────────────────────────────────────────
-- BURN 100 per box and add sealed (unopened) boxes to the buyer's inventory.
-- Boxes are opened later via open_farm_lootbox (two-step: buy in the Sklep,
-- open from the Ekwipunek). Reason 'farm_box_buy' (keep economy SQL in sync).
CREATE OR REPLACE FUNCTION public.buy_farm_lootbox(p_qty integer DEFAULT 1)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_cost  integer;
  v_coins integer;
  v_boxes integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > 50 THEN RAISE EXCEPTION 'bad_qty'; END IF;
  v_cost := 100 * p_qty;

  UPDATE public.profiles SET coins = coins - v_cost
   WHERE id = v_user AND coins >= v_cost
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  INSERT INTO public.farm_user_state (user_id, boxes)
  VALUES (v_user, p_qty)
  ON CONFLICT (user_id) DO UPDATE SET boxes = farm_user_state.boxes + EXCLUDED.boxes
  RETURNING boxes INTO v_boxes;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_cost, 'farm_box_buy', jsonb_build_object('qty', p_qty));
  END IF;

  RETURN json_build_object('ok', true, 'coins', v_coins, 'boxes', v_boxes, 'bought', p_qty);
END;
$$;

-- ── RPC: open_farm_lootbox ─────────────────────────────────────────────────
-- Consume ONE sealed box, draw FARM_BOX_DRAWS (3) DISTINCT rarity-weighted cards.
-- Each draw excludes already-picked species so every box yields different cards
-- (the pool has 9 species, so 3 distinct is always possible). Server-side
-- random() — the result isn't client-replayable so no anti-cheat is needed.
-- Also ~7% of boxes drop a free-tile voucher (a {voucher:true} card entry).
-- Returns { coins, boxes, tile_vouchers, cards:[ {species,...}|{voucher:true} ] }.
CREATE OR REPLACE FUNCTION public.open_farm_lootbox()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_draws     constant integer := 3;       -- cards per box (keep in sync with index.html)
  v_voucher_p constant numeric := 0.07;    -- chance a box also drops a free-tile voucher
  v_coins     integer;
  v_boxes     integer;
  v_vouchers  integer := 0;
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

    SELECT sum(d.draw_weight) INTO v_total
      FROM public.farm_card_defs d
     WHERE d.is_active AND d.draw_weight > 0 AND d.species <> ALL(v_picked)
       AND (d.edition_size IS NULL
            OR (SELECT count(*) FROM public.farm_nft_instances ni WHERE ni.species = d.species) < d.edition_size);
    EXIT WHEN v_total IS NULL OR v_total <= 0;

    v_roll := random() * v_total;
    SELECT species INTO v_species FROM (
      SELECT d.species, sum(d.draw_weight) OVER (ORDER BY d.species) AS cum
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
    END IF;

    INSERT INTO public.farm_collection (user_id, species, count, level)
    VALUES (v_user, v_species, 1, 1)
    ON CONFLICT (user_id, species) DO UPDATE SET count = farm_collection.count + 1
    RETURNING count INTO v_new_count;

    v_card := jsonb_build_object(
      'species', v_species, 'name', v_def.name, 'emoji', v_def.emoji,
      'rarity', v_def.rarity, 'new_count', v_new_count);
    IF v_def.edition_size IS NOT NULL THEN
      v_card := v_card || jsonb_build_object('nft', true, 'serial_no', v_serial, 'edition_size', v_def.edition_size, 'nft_name', v_nft_name);
    END IF;
    v_cards := v_cards || v_card;
    v_got := v_got + 1;
  END LOOP;

  -- Free-tile voucher: ~7% natural drop, BUT within the 3-box starter window a
  -- voucher is guaranteed — if it hasn't dropped by the last starter box, force it.
  IF v_starter > 0 THEN v_starter := v_starter - 1; END IF;
  v_drop_vch := (random() < v_voucher_p) OR (v_guar AND v_starter = 0);
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

-- ── RPC: level_up_card ─────────────────────────────────────────────────────
-- Consume duplicate cards + coins (BURN) to raise a species' level. Escalating
-- costs → effectively infinite upgrades → constant lootbox demand.
CREATE OR REPLACE FUNCTION public.level_up_card(p_species text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user         uuid := auth.uid();
  v_row          public.farm_collection%ROWTYPE;
  v_dupes_needed integer;
  v_coin_cost    integer;
  v_coins        integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

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

-- ── RPC: plant_crop ────────────────────────────────────────────────────────
-- Plant an owned card species on an owned empty tile. Planting does NOT consume
-- a card (the card is a permanent blueprint). Growth time scales down with level.
CREATE OR REPLACE FUNCTION public.plant_crop(p_x integer, p_y integer, p_species text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user         uuid := auth.uid();
  v_tile         public.farm_tiles%ROWTYPE;
  v_def          public.farm_card_defs%ROWTYPE;
  v_level        integer;
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

  SELECT level INTO v_level FROM public.farm_collection
   WHERE user_id = v_user AND species = p_species;
  IF v_level IS NULL THEN RAISE EXCEPTION 'no_card'; END IF;

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
$$;

-- ── RPC: harvest_crop ──────────────────────────────────────────────────────
-- Mint crop units into inventory (not coins). Yield scales up with card level.
-- Each harvest is its own LOT that ROTS 5 days later (expires_at); inventory_qty
-- returned is the crop's total across all of the player's non-expired lots.
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

  -- one new lot per harvest (rots independently)
  INSERT INTO public.farm_inventory (user_id, crop_type, qty, harvested_at, expires_at)
  VALUES (v_user, v_def.crop_type, v_yield, now(), v_exp);

  SELECT COALESCE(sum(qty), 0) INTO v_qty FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = v_def.crop_type AND expires_at > now();

  UPDATE public.farm_tiles
     SET planted_species = NULL, planted_level = NULL, planted_at = NULL, ready_at = NULL
   WHERE x = p_x AND y = p_y;

  RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'crop_type', v_def.crop_type,
    'harvested', v_yield, 'inventory_qty', v_qty, 'expires_at', v_exp);
END;
$$;

-- ── RPC: sell_crop_to_npc ──────────────────────────────────────────────────
-- MINT coins at the fluctuating NPC price. The farm_market row is locked FOR
-- UPDATE (serializes all sells of that crop). Pricing (mirror in index.html
-- farmSellQuote):
--   1. RECOVER cur_price toward the day's anchor_price at 12%/hr since last sale.
--   2. DROP it once per transaction, scaled by size: dropFrac = min(0.40, 0.005×qty)
--      (0.5%/unit, capped 40%). The batch is charged the AVERAGE of pre/post price
--      (eats ~half its own impact); cur_price lands at the post-drop price.
--   Floor = 30% of base throughout.
-- Crops are consumed FIFO from the soonest-to-ROT non-expired lots.
CREATE OR REPLACE FUNCTION public.sell_crop_to_npc(p_crop_type text, p_qty integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user     uuid := auth.uid();
  v_mkt      public.farm_market%ROWTYPE;
  v_avail    integer;
  v_inv      integer;
  v_remain   integer;
  v_take     integer;
  v_floor    numeric;
  v_anchor   numeric;
  v_cur_eff  numeric;
  v_dropfrac numeric;
  v_price    numeric;
  v_proceeds numeric;
  v_hours    numeric;
  v_coins    integer;
  v_pay      integer;
  v_lot      record;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'bad_qty'; END IF;

  SELECT * INTO v_mkt FROM public.farm_market WHERE crop_type = p_crop_type FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_market'; END IF;

  -- availability across non-expired lots
  SELECT COALESCE(sum(qty), 0) INTO v_avail FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now();
  IF v_avail < p_qty THEN RAISE EXCEPTION 'not_enough_crops'; END IF;

  -- consume FIFO: soonest-to-rot lots first
  v_remain := p_qty;
  FOR v_lot IN
    SELECT id, qty FROM public.farm_inventory
     WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now()
     ORDER BY expires_at, id
     FOR UPDATE
  LOOP
    EXIT WHEN v_remain <= 0;
    v_take := least(v_remain, v_lot.qty);
    IF v_take >= v_lot.qty THEN
      DELETE FROM public.farm_inventory WHERE id = v_lot.id;
    ELSE
      UPDATE public.farm_inventory SET qty = qty - v_take WHERE id = v_lot.id;
    END IF;
    v_remain := v_remain - v_take;
  END LOOP;

  -- price math (see header)
  v_anchor  := COALESCE(v_mkt.anchor_price, v_mkt.base_price);
  v_floor   := v_mkt.base_price * 0.30;
  v_hours   := EXTRACT(EPOCH FROM (now() - v_mkt.last_decay_at)) / 3600.0;
  v_cur_eff := v_mkt.cur_price + (v_anchor - v_mkt.cur_price) * least(1, v_hours * 0.12);
  IF v_cur_eff < v_floor THEN v_cur_eff := v_floor; END IF;

  v_dropfrac := least(0.40, 0.005 * p_qty);
  v_proceeds := p_qty * v_cur_eff * (1 - v_dropfrac / 2.0);
  v_price    := greatest(v_floor, v_cur_eff * (1 - v_dropfrac));

  UPDATE public.farm_market
     SET cur_price = v_price, total_sold = total_sold + p_qty, last_decay_at = now()
   WHERE crop_type = p_crop_type;

  v_pay := round(v_proceeds)::integer;
  UPDATE public.profiles SET coins = coins + v_pay WHERE id = v_user
  RETURNING coins INTO v_coins;

  -- remaining (non-expired) inventory of this crop
  SELECT COALESCE(sum(qty), 0) INTO v_inv FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now();

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, v_pay, 'farm_crop_sale',
            jsonb_build_object('crop_type', p_crop_type, 'qty', p_qty,
                               'cur_price', round(v_cur_eff, 2), 'unit_price', round(v_pay::numeric / p_qty, 2)));
  END IF;

  RETURN json_build_object('ok', true, 'coins', v_coins, 'crop_type', p_crop_type,
    'sold', p_qty, 'proceeds', v_pay, 'cur_price', round(v_price, 2), 'inventory_qty', v_inv);
END;
$$;

-- ── Grants ─────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.buy_farm_tile(integer, integer)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_farm_starter()                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.buy_farm_lootbox(integer)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_farm_lootbox()                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.level_up_card(text)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plant_crop(integer, integer, text)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.harvest_crop(integer, integer)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sell_crop_to_npc(text, integer)        FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.buy_farm_tile(integer, integer)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_farm_starter()               TO authenticated;
GRANT EXECUTE ON FUNCTION public.buy_farm_lootbox(integer)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_farm_lootbox()                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.level_up_card(text)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.plant_crop(integer, integer, text)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.harvest_crop(integer, integer)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.sell_crop_to_npc(text, integer)     TO authenticated;

-- ── Rot cleanup: delete expired crop lots daily (also filtered everywhere live) ──
CREATE OR REPLACE FUNCTION public.farm_rot_cleanup()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.farm_inventory WHERE expires_at <= now();
$$;
REVOKE ALL ON FUNCTION public.farm_rot_cleanup() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'farm_rot_cleanup') THEN
      PERFORM cron.unschedule('farm_rot_cleanup');
    END IF;
    PERFORM cron.schedule('farm_rot_cleanup', '20 0 * * *', $cron$SELECT public.farm_rot_cleanup();$cron$);
  END IF;
END $$;

-- ── Migration: place every existing Ogródek plant on one tile ──────────────
-- One tile per gardens row (all slots), packed into the first cells in reading
-- order (13 per row). The tile (acquired_via='migration') displays that plant
-- and is plant-only (no crops). Delete+recreate is deterministic so re-running
-- is idempotent. Purchased tiles (acquired_via='purchase'/'lootbox') untouched.
DO $$
DECLARE
  rec  record;
  v_i  integer := 0;
BEGIN
  IF to_regclass('public.gardens') IS NULL THEN RETURN; END IF;
  DELETE FROM public.farm_tiles WHERE acquired_via = 'migration';
  FOR rec IN
    SELECT g.id, g.user_id
      FROM public.gardens g
     ORDER BY g.created_at NULLS FIRST, g.id
  LOOP
    INSERT INTO public.farm_tiles (x, y, owner_id, acquired_via, zen_garden_id)
    VALUES (v_i % 13, v_i / 13, rec.user_id, 'migration', rec.id)
    ON CONFLICT (x, y) DO NOTHING;
    v_i := v_i + 1;
  END LOOP;
END $$;

-- ── Backfill: (re)name every NFT instance from its persona pool, by per-pool order ──
-- Overwrites existing names so any older (wrong-pool) names are corrected.
-- Deterministic per-pool index keeps names aligned with future count()-based mints.
-- The male/female partitions are unchanged, so existing Slavic names stay stable;
-- the 'Ae Ae banana indexes independently in its own Hawaiian pool.
DO $$
BEGIN
  IF to_regclass('public.farm_nft_instances') IS NULL THEN RETURN; END IF;
  WITH ordered AS (
    SELECT id, species,
           (row_number() OVER (PARTITION BY public.farm_nft_pool(species)
                               ORDER BY acquired_at, id) - 1) AS rn
      FROM public.farm_nft_instances
  )
  UPDATE public.farm_nft_instances n
     SET nft_name = public.farm_nft_persona(o.species, o.rn::integer)
    FROM ordered o
   WHERE o.id = n.id;
END $$;

NOTIFY pgrst, 'reload schema';
