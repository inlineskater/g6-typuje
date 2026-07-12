-- Farma — Stardew/Happy-Farm + collectible plant-card economy (Phase 1)
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run).
-- Idempotent: CREATE ... IF NOT EXISTS / CREATE OR REPLACE / guarded blocks — safe to re-run.
--
-- A shared 13 x 4 grid with real per-tile OWNERSHIP layered on the
-- Ogródek tab (the old zen water_plant view is hidden but reused for plant tiles). Loop:
--   buy tile (BURN, escalating) → buy/open lootbox (BURN at buy) → collect plant CARDS
--   → level a card with duplicates + coins (BURN) → plant a card on an owned tile
--   → it grows over real time → harvest crops into inventory (crops minted, not coins)
--   → sell crops to the NPC at a dynamic supply/demand price (coins MINTED).
--
-- Grid bounds (13 x 4) are mirrored in index.html as FARM_W / FARM_H — keep in sync.
-- Grid is 13 wide x 4 tall (FARM_W x FARM_H in index.html). Existing Ogródek
-- plants occupy the first cells (acquired_via 'migration'); crops can't grow there.
-- Coin reasons added here (keep economy-stats.sql + leaderboard-net-worth-items.sql in sync):
--   BURN:  farm_tile_buy, farm_box_buy, card_levelup, farm_land_tax_pay, farm_land_tax_autopay
--   MINT:  farm_crop_sale
-- Boxes are bought (farm_box_buy BURN) then opened from inventory; opening itself
-- moves no coins. Boxes can drop a free-tile voucher (claims a tile for 0 coins);
-- that natural voucher chance falls as the player owns more tiles/vouchers.

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
  acquired_via    text NOT NULL DEFAULT 'purchase' CHECK (acquired_via IN ('migration','purchase','lootbox','marketplace')),
  acquired_at     timestamptz NOT NULL DEFAULT now(),
  listed          boolean NOT NULL DEFAULT false,
  asset_value     integer NOT NULL DEFAULT 0 CHECK (asset_value >= 0),
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
ALTER TABLE public.farm_tiles ADD COLUMN IF NOT EXISTS listed boolean NOT NULL DEFAULT false;
ALTER TABLE public.farm_tiles ADD COLUMN IF NOT EXISTS asset_value integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE public.farm_tiles DROP CONSTRAINT IF EXISTS farm_tiles_acquired_via_check;
  ALTER TABLE public.farm_tiles
    ADD CONSTRAINT farm_tiles_acquired_via_check CHECK (acquired_via IN ('migration','purchase','lootbox','marketplace'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.farm_tiles
    ADD CONSTRAINT farm_tiles_asset_value_chk CHECK (asset_value >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.farm_tiles
    ADD CONSTRAINT farm_tiles_listed_empty_chk CHECK (NOT listed OR planted_species IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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
-- unique within each pool. Hawaiian pool (14) ≥ the banana edition (8).
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
  land_tax_debt  integer NOT NULL DEFAULT 0 CHECK (land_tax_debt >= 0),
  land_tax_last_assessed date, -- last completed Warsaw day charged
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
ALTER TABLE public.farm_user_state ADD COLUMN IF NOT EXISTS land_tax_debt integer NOT NULL DEFAULT 0;
ALTER TABLE public.farm_user_state ADD COLUMN IF NOT EXISTS land_tax_last_assessed date;
DO $$ BEGIN
  ALTER TABLE public.farm_user_state
    ADD CONSTRAINT farm_user_state_land_tax_debt_chk CHECK (land_tax_debt >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Audit trail for territory tax/debt events. Clients use farm_land_tax_quote()
-- for the current state; the table is own-row readable for profile/history views.
CREATE TABLE IF NOT EXISTS public.farm_land_tax_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event_type   text NOT NULL CHECK (event_type IN ('daily_tax','interest','manual_payment','autopay')),
  amount       integer NOT NULL CHECK (amount >= 0),
  debt_before  integer NOT NULL CHECK (debt_before >= 0),
  debt_after   integer NOT NULL CHECK (debt_after >= 0),
  fair_cap     integer,
  owned_tiles  integer,
  excess_tiles integer,
  meta         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_land_tax_events_user_time_idx
  ON public.farm_land_tax_events(user_id, created_at DESC);

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
  -- once reserved for Hawaiian royalty — smallest edition (8), highest yield/price,
  -- so it is the rarest, most expensive and most profitable NFT in the game.
  ('aeae_banana',      'Królewski Banan Ae Ae', '🍌', 'legendary', 1, 5760, 120, 'aeae_banana', 8)
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
ALTER TABLE public.farm_land_tax_events ENABLE ROW LEVEL SECURITY;

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

DROP POLICY IF EXISTS "farm_land_tax_events_select_own" ON public.farm_land_tax_events;
CREATE POLICY "farm_land_tax_events_select_own" ON public.farm_land_tax_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- No direct client writes — everything goes through the RPCs below.
REVOKE ALL ON public.farm_card_defs, public.farm_tiles, public.farm_collection,
              public.farm_inventory, public.farm_market, public.farm_nft_instances,
              public.farm_user_state, public.farm_land_tax_events FROM anon, authenticated;
GRANT SELECT ON public.farm_card_defs, public.farm_tiles, public.farm_market, public.farm_nft_instances TO anon, authenticated;
GRANT SELECT ON public.farm_collection, public.farm_inventory, public.farm_user_state, public.farm_land_tax_events TO authenticated;

-- ── Realtime ───────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['farm_tiles','farm_market','farm_collection','farm_inventory','farm_nft_instances','farm_user_state','farm_land_tax_events'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ── Territory fair-cap + tax helpers ───────────────────────────────────────
-- Tax is intentionally count-based, not value-based:
--   fair_cap  = ceil(normal farm capacity / active farm participants)
--   excess    = max(0, owned normal territories - fair_cap)
--   daily tax = 1000 * excess^2
-- Migration Ogródek plant tiles are ignored for tax and cap enforcement.
CREATE OR REPLACE FUNCTION public.farm_normal_tile_count(p_uid uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(count(*), 0)::integer
    FROM public.farm_tiles ft
   WHERE ft.owner_id = p_uid
     AND ft.acquired_via <> 'migration';
$$;

CREATE OR REPLACE FUNCTION public.farm_land_tax_participant_count()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT greatest(1, COALESCE(count(*), 0))::integer
    FROM public.profiles p
   WHERE NOT p.is_admin
     AND (
       EXISTS (SELECT 1 FROM public.farm_user_state fus WHERE fus.user_id = p.id)
       OR EXISTS (
         SELECT 1 FROM public.farm_tiles ft
          WHERE ft.owner_id = p.id AND ft.acquired_via <> 'migration'
       )
     );
$$;

CREATE OR REPLACE FUNCTION public.farm_normal_tile_capacity()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Purchasable cells only: data rows 1-3 (13×3) + the single row-0 tile (0,0)
  -- the frontend exposes (FARM_EXTRA_TILES in index.html). The rest of row 0 is
  -- hidden farmland reserved by the zen split (garden-zen-split.sql) and rejected
  -- by buy_farm_tile, so it must not inflate the land-tax fair share.
  SELECT 13 * 3 + 1;
$$;

CREATE OR REPLACE FUNCTION public.farm_fair_cap()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT greatest(1, ceil(
           public.farm_normal_tile_capacity()::numeric
           / greatest(public.farm_land_tax_participant_count(), 1)
         )::integer);
$$;

-- Leading farm-tile auction bids count as pending expansion, so one player
-- cannot reserve several auction wins above the cap. Dynamic SQL keeps farm.sql
-- runnable before marketplace item columns exist.
CREATE OR REPLACE FUNCTION public.farm_land_tax_pending_tiles(
  p_uid uuid,
  p_exclude_listing_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_ready boolean := false;
BEGIN
  IF to_regclass('public.marketplace_listings') IS NULL
     OR to_regclass('public.marketplace_bids') IS NULL THEN
    RETURN 0;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'marketplace_listings'
       AND column_name = 'item_kind'
  ) INTO v_ready;
  IF NOT v_ready THEN RETURN 0; END IF;

  EXECUTE $sql$
    SELECT COALESCE(count(DISTINCT l.id), 0)::integer
      FROM public.marketplace_bids b
      JOIN public.marketplace_listings l ON l.id = b.listing_id
     WHERE b.bidder_id = $1
       AND b.status = 'leading'
       AND l.status = 'open'
       AND l.item_kind = 'farm_tile'
       AND ($2::uuid IS NULL OR l.id <> $2)
  $sql$ USING p_uid, p_exclude_listing_id INTO v_count;

  RETURN COALESCE(v_count, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.farm_land_tax_quote_for(
  p_uid uuid,
  p_exclude_listing_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_capacity integer := public.farm_normal_tile_capacity();
  v_participants integer := public.farm_land_tax_participant_count();
  v_cap integer := public.farm_fair_cap();
  v_owned integer := public.farm_normal_tile_count(p_uid);
  v_pending integer := public.farm_land_tax_pending_tiles(p_uid, p_exclude_listing_id);
  v_debt integer := 0;
  v_excess integer := 0;
  v_daily integer := 0;
  v_interest integer := 0;
  v_first_tax_day date := DATE '2026-07-02';
  v_first_payment_day date := DATE '2026-07-03';
BEGIN
  SELECT COALESCE(land_tax_debt, 0) INTO v_debt
    FROM public.farm_user_state
   WHERE user_id = p_uid;
  v_debt := COALESCE(v_debt, 0);
  v_excess := greatest(0, v_owned - v_cap);
  v_daily := 1000 * v_excess * v_excess;
  v_interest := CASE WHEN v_debt > 0 THEN ceil(v_debt * 0.10)::integer ELSE 0 END;

  RETURN json_build_object(
    'normal_capacity', v_capacity,
    'participants', v_participants,
    'fair_cap', v_cap,
    'owned_tiles', v_owned,
    'pending_tiles', v_pending,
    'excess_tiles', v_excess,
    'tax_per_excess_sq', 1000,
    'daily_tax', v_daily,
    'debt', v_debt,
    'interest_next', v_interest,
    'first_tax_day', v_first_tax_day,
    'first_payment_day', v_first_payment_day,
    -- Soft cap: buying/planting past the fair share is allowed (excess is taxed
    -- daily); only an unpaid tax debt blocks expansion. Planting is never blocked.
    'blocked_expansion', (v_debt > 0),
    'blocked_planting', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.farm_land_tax_quote()
RETURNS json
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  INSERT INTO public.farm_user_state (user_id) VALUES (v_user)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN public.farm_land_tax_quote_for(v_user);
END;
$$;

CREATE OR REPLACE FUNCTION public.farm_assert_can_expand(
  p_uid uuid,
  p_exclude_listing_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q json := public.farm_land_tax_quote_for(p_uid, p_exclude_listing_id);
  v_debt integer := COALESCE((v_q->>'debt')::integer, 0);
BEGIN
  -- Soft cap: expansion past fair_cap is allowed (the excess is taxed daily).
  -- Only an outstanding tax debt blocks buying more land.
  IF v_debt > 0 THEN RAISE EXCEPTION 'land_tax_debt'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.farm_assert_can_plant(p_uid uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Planting is never blocked by land tax debt — only buying more tiles is
  -- (see farm_assert_can_expand). An unpaid debt still accrues daily interest
  -- and is still autopaid from crop/marketplace proceeds.
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.farm_apply_land_tax_autopay(
  p_uid uuid,
  p_gross integer,
  p_source text,
  p_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS json
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_debt_before integer := 0;
  v_tax_paid integer := 0;
  v_debt_after integer := 0;
BEGIN
  IF p_gross IS NULL OR p_gross < 0 THEN RAISE EXCEPTION 'bad_amount'; END IF;

  INSERT INTO public.farm_user_state (user_id) VALUES (p_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT land_tax_debt INTO v_debt_before
    FROM public.farm_user_state
   WHERE user_id = p_uid
   FOR UPDATE;
  v_debt_before := COALESCE(v_debt_before, 0);
  v_tax_paid := least(v_debt_before, p_gross);
  v_debt_after := v_debt_before - v_tax_paid;

  IF v_tax_paid > 0 THEN
    UPDATE public.farm_user_state
       SET land_tax_debt = v_debt_after
     WHERE user_id = p_uid;

    INSERT INTO public.farm_land_tax_events
      (user_id, event_type, amount, debt_before, debt_after, fair_cap, owned_tiles, excess_tiles, meta)
    VALUES (
      p_uid, 'autopay', v_tax_paid, v_debt_before, v_debt_after,
      public.farm_fair_cap(), public.farm_normal_tile_count(p_uid),
      greatest(0, public.farm_normal_tile_count(p_uid) - public.farm_fair_cap()),
      COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object('source', p_source, 'gross', p_gross)
    );

    IF to_regclass('public.coin_transactions') IS NOT NULL THEN
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES (
        p_uid, -v_tax_paid, 'farm_land_tax_autopay',
        COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object('source', p_source, 'gross', p_gross)
      );
    END IF;
  END IF;

  RETURN json_build_object(
    'gross', p_gross,
    'tax_paid', v_tax_paid,
    'net', p_gross - v_tax_paid,
    'debt', v_debt_after
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.pay_farm_land_tax(p_amount integer)
RETURNS json
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_debt_before integer := 0;
  v_pay integer := 0;
  v_debt_after integer := 0;
  v_coins integer := 0;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_amount IS NULL OR p_amount < 1 THEN RAISE EXCEPTION 'bad_amount'; END IF;

  INSERT INTO public.farm_user_state (user_id) VALUES (v_user)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT land_tax_debt INTO v_debt_before
    FROM public.farm_user_state
   WHERE user_id = v_user
   FOR UPDATE;
  v_debt_before := COALESCE(v_debt_before, 0);
  v_pay := least(p_amount, v_debt_before);

  IF v_pay <= 0 THEN
    SELECT coins INTO v_coins FROM public.profiles WHERE id = v_user;
    RETURN json_build_object('ok', true, 'paid', 0, 'debt', 0, 'coins', v_coins);
  END IF;

  UPDATE public.profiles
     SET coins = coins - v_pay
   WHERE id = v_user AND coins >= v_pay
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  v_debt_after := v_debt_before - v_pay;
  UPDATE public.farm_user_state
     SET land_tax_debt = v_debt_after
   WHERE user_id = v_user;

  INSERT INTO public.farm_land_tax_events
    (user_id, event_type, amount, debt_before, debt_after, fair_cap, owned_tiles, excess_tiles, meta)
  VALUES (
    v_user, 'manual_payment', v_pay, v_debt_before, v_debt_after,
    public.farm_fair_cap(), public.farm_normal_tile_count(v_user),
    greatest(0, public.farm_normal_tile_count(v_user) - public.farm_fair_cap()),
    jsonb_build_object('requested_amount', p_amount)
  );

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_pay, 'farm_land_tax_pay', jsonb_build_object('source', 'manual_payment'));
  END IF;

  RETURN json_build_object('ok', true, 'paid', v_pay, 'debt', v_debt_after, 'coins', v_coins);
END;
$$;

CREATE OR REPLACE FUNCTION public.assess_farm_land_tax()
RETURNS json
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_warsaw_now timestamp := now() AT TIME ZONE 'Europe/Warsaw';
  v_tax_day date := ((now() AT TIME ZONE 'Europe/Warsaw')::date - 1);
  v_first_tax_day date := DATE '2026-07-02';
  v_user uuid;
  v_debt_before integer;
  v_debt_after integer;
  v_daily_tax integer;
  v_interest integer;
  v_due integer;
  v_wallet integer;
  v_wallet_pay integer;
  v_q json;
  v_done integer := 0;
BEGIN
  IF EXTRACT(HOUR FROM v_warsaw_now)::integer <> 0 THEN
    RETURN json_build_object('ok', true, 'skipped', true, 'reason', 'not_midnight_warsaw', 'tax_day', v_tax_day, 'assessed', 0);
  END IF;
  IF v_tax_day < v_first_tax_day THEN
    RETURN json_build_object('ok', true, 'skipped', true, 'reason', 'tax_not_started', 'tax_day', v_tax_day, 'first_tax_day', v_first_tax_day, 'assessed', 0);
  END IF;

  INSERT INTO public.farm_user_state (user_id)
  SELECT p.id
    FROM public.profiles p
   WHERE NOT p.is_admin
     AND (
       EXISTS (SELECT 1 FROM public.farm_user_state fus WHERE fus.user_id = p.id)
       OR EXISTS (
         SELECT 1 FROM public.farm_tiles ft
          WHERE ft.owner_id = p.id AND ft.acquired_via <> 'migration'
       )
     )
  ON CONFLICT (user_id) DO NOTHING;

  FOR v_user IN
    SELECT fus.user_id
      FROM public.farm_user_state fus
      JOIN public.profiles p ON p.id = fus.user_id
     WHERE NOT p.is_admin
     ORDER BY fus.user_id
  LOOP
    SELECT land_tax_debt INTO v_debt_before
      FROM public.farm_user_state
     WHERE user_id = v_user
     FOR UPDATE;

    IF (SELECT land_tax_last_assessed FROM public.farm_user_state WHERE user_id = v_user) = v_tax_day THEN
      CONTINUE;
    END IF;

    v_q := public.farm_land_tax_quote_for(v_user);
    v_daily_tax := COALESCE((v_q->>'daily_tax')::integer, 0);
    v_interest := COALESCE((v_q->>'interest_next')::integer, 0);
    v_due := v_daily_tax + v_interest;
    v_wallet_pay := 0;
    v_debt_after := COALESCE(v_debt_before, 0);

    IF v_due > 0 THEN
      SELECT coins INTO v_wallet FROM public.profiles WHERE id = v_user FOR UPDATE;
      v_wallet_pay := least(COALESCE(v_wallet, 0), v_due);
      IF v_wallet_pay > 0 THEN
        UPDATE public.profiles SET coins = coins - v_wallet_pay WHERE id = v_user;
        IF to_regclass('public.coin_transactions') IS NOT NULL THEN
          INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
          VALUES (
            v_user, -v_wallet_pay, 'farm_land_tax_pay',
            jsonb_build_object('source', 'daily_assessment', 'tax_day', v_tax_day,
                               'daily_tax', v_daily_tax, 'interest', v_interest)
          );
        END IF;
      END IF;
      v_debt_after := v_debt_after + v_due - v_wallet_pay;
    END IF;

    UPDATE public.farm_user_state
       SET land_tax_debt = v_debt_after,
           land_tax_last_assessed = v_tax_day
     WHERE user_id = v_user;

    IF v_daily_tax > 0 THEN
      INSERT INTO public.farm_land_tax_events
        (user_id, event_type, amount, debt_before, debt_after, fair_cap, owned_tiles, excess_tiles, meta)
      VALUES (
        v_user, 'daily_tax', v_daily_tax, COALESCE(v_debt_before, 0), v_debt_after,
        COALESCE((v_q->>'fair_cap')::integer, public.farm_fair_cap()),
        COALESCE((v_q->>'owned_tiles')::integer, public.farm_normal_tile_count(v_user)),
        COALESCE((v_q->>'excess_tiles')::integer, 0),
        jsonb_build_object('tax_day', v_tax_day, 'wallet_paid', v_wallet_pay)
      );
    END IF;

    IF v_interest > 0 THEN
      INSERT INTO public.farm_land_tax_events
        (user_id, event_type, amount, debt_before, debt_after, fair_cap, owned_tiles, excess_tiles, meta)
      VALUES (
        v_user, 'interest', v_interest, COALESCE(v_debt_before, 0), v_debt_after,
        COALESCE((v_q->>'fair_cap')::integer, public.farm_fair_cap()),
        COALESCE((v_q->>'owned_tiles')::integer, public.farm_normal_tile_count(v_user)),
        COALESCE((v_q->>'excess_tiles')::integer, 0),
        jsonb_build_object('tax_day', v_tax_day, 'wallet_paid', v_wallet_pay)
      );
    END IF;

    v_done := v_done + 1;
  END LOOP;

  RETURN json_build_object('ok', true, 'tax_day', v_tax_day, 'assessed', v_done);
END;
$$;

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
  -- Row 0 is the legacy zen row, hidden by the frontend since the zen split —
  -- only (0,0) (FARM_EXTRA_TILES in index.html) is purchasable, so a crafted RPC
  -- call can't buy an invisible tile that still counts for pricing/tax.
  IF p_y = 0 AND p_x <> 0 THEN RAISE EXCEPTION 'bad_coords'; END IF;

  INSERT INTO public.farm_user_state (user_id) VALUES (v_user)
  ON CONFLICT (user_id) DO NOTHING;
  PERFORM public.farm_assert_can_expand(v_user);

  -- Exclude legacy zen 'migration' tiles: they were never bought, and the client
  -- price quote (farmTilePrice/farmOwnedTileCount in index.html) doesn't count
  -- them — counting them here would double the charged price vs the shown one.
  SELECT count(*) INTO v_tiles FROM public.farm_tiles
   WHERE owner_id = v_user AND acquired_via <> 'migration';
  v_price := least(50000::numeric, floor(350::numeric * power(2::numeric, v_tiles)))::integer;

  -- A free-tile voucher (dropped by a seed box) claims a tile for 0 coins.
  -- Consume one under a row lock; if none, fall back to the escalating coin price.
  UPDATE public.farm_user_state SET tile_vouchers = tile_vouchers - 1
   WHERE user_id = v_user AND tile_vouchers > 0
  RETURNING tile_vouchers INTO v_vouchers;
  IF FOUND THEN v_voucher := true; ELSE v_price := v_price; END IF;

  INSERT INTO public.farm_tiles (x, y, owner_id, acquired_via, asset_value)
  VALUES (p_x, p_y, v_user, CASE WHEN v_voucher THEN 'lootbox' ELSE 'purchase' END,
          CASE WHEN v_voucher THEN 0 ELSE v_price END)
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
-- ⚠️ SUPERSEDED twice: nft-leveling-rework.sql (no farm_collection row for NFT
--    draws) and then nft-merge-fixes.sql (serials/supply from minted_count).
--    After re-running this file, re-run BOTH, in that order.
-- Consume ONE sealed box, draw FARM_BOX_DRAWS (3) DISTINCT rarity-weighted cards.
-- Each draw excludes already-picked species so every box yields different cards
-- (the active pool is larger than the 3-card draw). Server-side
-- random() — the result isn't client-replayable so no anti-cheat is needed.
-- Free-tile voucher odds and NFT odds get anti-hoarding penalties:
-- every owned NFT divides future NFT weights by 3, and every owned tile/voucher
-- divides the natural voucher chance by 3. Starter guarantee only applies while
-- the player still has zero territory.
-- Returns { coins, boxes, tile_vouchers, cards:[ {species,...}|{voucher:true} ] }.
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

    INSERT INTO public.farm_collection (user_id, species, count, level)
    VALUES (v_user, v_species, 1, 1)
    ON CONFLICT (user_id, species) DO UPDATE SET count = farm_collection.count + 1
    RETURNING count INTO v_new_count;

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
-- ⚠️ SUPERSEDED by the 4-arg instance-aware version in nft-leveling-rework.sql;
--    nft-merge-fixes.sql then DROPs this 3-arg overload (a 3-named-arg PostgREST
--    call would be ambiguous). After re-running this file, re-run both.
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
  IF v_tile.listed THEN RAISE EXCEPTION 'tile_listed'; END IF;
  IF v_tile.planted_species IS NOT NULL THEN RAISE EXCEPTION 'tile_occupied'; END IF;
  PERFORM public.farm_assert_can_plant(v_user);

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
     SET planted_species = NULL, planted_level = NULL, planted_at = NULL, ready_at = NULL,
         planted_instance_id = NULL   -- free the NFT instance so it can merge/list/replant
   WHERE x = p_x AND y = p_y;

  RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'crop_type', v_def.crop_type,
    'harvested', v_yield, 'inventory_qty', v_qty, 'expires_at', v_exp);
END;
$$;

-- ── RPC: remove_crop ───────────────────────────────────────────────────────
-- Uproot: the tile owner discards a plant at any growth stage — no yield, no
-- refund, no coin movement (planting never consumed anything: fungible cards
-- are availability-checked, NFTs only locked via planted_instance_id). Clears
-- the same columns as harvest, so a planted NFT is freed too. Zen migration
-- tiles and listed tiles never have planted_species, so 'tile_empty' covers them.
CREATE OR REPLACE FUNCTION public.remove_crop(p_x integer, p_y integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_tile    public.farm_tiles%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_tile FROM public.farm_tiles WHERE x = p_x AND y = p_y FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tile_not_owned'; END IF;
  IF v_tile.owner_id <> v_user THEN RAISE EXCEPTION 'not_your_tile'; END IF;
  IF v_tile.planted_species IS NULL THEN RAISE EXCEPTION 'tile_empty'; END IF;

  UPDATE public.farm_tiles
     SET planted_species = NULL, planted_level = NULL, planted_at = NULL, ready_at = NULL,
         planted_instance_id = NULL
   WHERE x = p_x AND y = p_y;

  RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'species', v_tile.planted_species);
END;
$$;

-- ── RPC: sell_crop_to_npc ──────────────────────────────────────────────────
-- MINT coins at the fluctuating NPC price. The farm_market row is locked FOR
-- UPDATE (serializes all sells of that crop). Pricing (mirror in index.html
-- farmSellQuote):
--   1. RECOVER cur_price toward the day's anchor_price at 12%/hr since last sale.
--   2. DROP it once per transaction, scaled by size: dropFrac = min(0.40, 0.005×qty)
--      (0.5%/unit, capped 40%). The batch is charged the AVERAGE of pre/post price
--      (eats ~half its own impact after floor clamp); cur_price lands at the post-drop price.
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
  v_tax      json;
  v_tax_paid integer := 0;
  v_net_pay  integer := 0;
  v_debt     integer := 0;
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
  v_price    := greatest(v_floor, v_cur_eff * (1 - v_dropfrac));
  v_proceeds := p_qty * ((v_cur_eff + v_price) / 2.0);

  UPDATE public.farm_market
     SET cur_price = v_price, total_sold = total_sold + p_qty, last_decay_at = now()
   WHERE crop_type = p_crop_type;

  v_pay := round(v_proceeds)::integer;
  v_tax := public.farm_apply_land_tax_autopay(
    v_user, v_pay, 'farm_crop_sale',
    jsonb_build_object('crop_type', p_crop_type, 'qty', p_qty)
  );
  v_tax_paid := COALESCE((v_tax->>'tax_paid')::integer, 0);
  v_net_pay := COALESCE((v_tax->>'net')::integer, v_pay);
  v_debt := COALESCE((v_tax->>'debt')::integer, 0);

  UPDATE public.profiles SET coins = coins + v_net_pay WHERE id = v_user
  RETURNING coins INTO v_coins;

  -- remaining (non-expired) inventory of this crop
  SELECT COALESCE(sum(qty), 0) INTO v_inv FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now();

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, v_pay, 'farm_crop_sale',
            jsonb_build_object('crop_type', p_crop_type, 'qty', p_qty,
                               'cur_price', round(v_cur_eff, 2),
                               'unit_price', round(v_pay::numeric / p_qty, 2),
                               'tax_paid', v_tax_paid, 'net', v_net_pay));
  END IF;

  RETURN json_build_object('ok', true, 'coins', v_coins, 'crop_type', p_crop_type,
    'sold', p_qty, 'proceeds', v_pay, 'net', v_net_pay, 'tax_paid', v_tax_paid,
    'land_tax_debt', v_debt, 'cur_price', round(v_price, 2), 'last_decay_at', now(),
    'inventory_qty', v_inv);
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
REVOKE ALL ON FUNCTION public.remove_crop(integer, integer)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sell_crop_to_npc(text, integer)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_land_tax_quote()                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_farm_land_tax(integer)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assess_farm_land_tax()                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_normal_tile_count(uuid)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_land_tax_participant_count()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_normal_tile_capacity()            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_fair_cap()                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_land_tax_pending_tiles(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_land_tax_quote_for(uuid, uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_assert_can_expand(uuid, uuid)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_assert_can_plant(uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_apply_land_tax_autopay(uuid, integer, text, jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.buy_farm_tile(integer, integer)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_farm_starter()               TO authenticated;
GRANT EXECUTE ON FUNCTION public.buy_farm_lootbox(integer)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_farm_lootbox()                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.level_up_card(text)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.plant_crop(integer, integer, text)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.harvest_crop(integer, integer)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_crop(integer, integer)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.sell_crop_to_npc(text, integer)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.farm_land_tax_quote()               TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_farm_land_tax(integer)          TO authenticated;

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
    -- pg_cron is UTC/GMT. Try both UTC offsets used by Warsaw and execute
    -- only at local 00:00, so this remains correct across DST changes.
    PERFORM cron.schedule(
      'farm_rot_cleanup',
      '0 22,23 * * *',
      $cron$SELECT public.farm_rot_cleanup()
        WHERE EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer = 0;$cron$
    );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'farm_land_tax_daily') THEN
      PERFORM cron.unschedule('farm_land_tax_daily');
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'farm_land_tax_daily_summer') THEN
      PERFORM cron.unschedule('farm_land_tax_daily_summer');
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'farm_land_tax_daily_winter') THEN
      PERFORM cron.unschedule('farm_land_tax_daily_winter');
    END IF;
    -- Supabase pg_cron runs in UTC. These two attempts cover Warsaw summer
    -- (UTC+2) and winter (UTC+1); assess_farm_land_tax() only runs during
    -- Warsaw hour 00 and is idempotent by completed tax_day.
    PERFORM cron.schedule('farm_land_tax_daily_summer', '0 22 * * *', $cron$SELECT public.assess_farm_land_tax();$cron$);
    PERFORM cron.schedule('farm_land_tax_daily_winter', '0 23 * * *', $cron$SELECT public.assess_farm_land_tax();$cron$);
  END IF;
END $$;

-- ── Migration: place every existing Ogródek plant on one tile ──────────────
-- ⚠️ SUPERSEDED by supabase/garden-zen-split.sql. The zen garden is now rendered
-- as its own left-hand panel driven by the `gardens` table (🧘 Ogród Zen), NOT as
-- `acquired_via='migration'` tiles on the crop board. This block used to pack one
-- migration tile per gardens row into row 0; it is intentionally DISABLED so a
-- re-run of farm.sql won't recreate tiles that garden-zen-split.sql removes. Run
-- garden-zen-split.sql after this file. (Original body kept below, commented out.)
--
-- DO $$
-- DECLARE
--   rec  record;
--   v_i  integer := 0;
-- BEGIN
--   IF to_regclass('public.gardens') IS NULL THEN RETURN; END IF;
--   DELETE FROM public.farm_tiles WHERE acquired_via = 'migration';
--   FOR rec IN
--     SELECT g.id, g.user_id
--       FROM public.gardens g
--      ORDER BY g.created_at NULLS FIRST, g.id
--   LOOP
--     INSERT INTO public.farm_tiles (x, y, owner_id, acquired_via, zen_garden_id)
--     VALUES (v_i % 13, v_i / 13, rec.user_id, 'migration', rec.id)
--     ON CONFLICT (x, y) DO NOTHING;
--     v_i := v_i + 1;
--   END LOOP;
-- END $$;

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
