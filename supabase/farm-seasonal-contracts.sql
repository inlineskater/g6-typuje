-- Farma seasonal crop contracts.
-- Run AFTER farm.sql + farm-marketplace.sql + nft-leveling-rework.sql +
-- nft-merge-fixes.sql. Idempotent; safe to re-run.
--
-- First event starts Monday 2026-07-06 Europe/Warsaw with Marchewka.
-- The event row refreshes the live farm size until the first counted sale:
--   participants, fair cap, crop grow time/yield, bar target and sale premium.
--
-- Rewards:
--   • event crop sale premium: target ≈ 150 coins/tile/day
--   • rank 1: 2500 coins + random farm NFT (fallback: 10 boxes if sold out)
--   • rank 2: 1500 coins + 5 boxes
--   • rank 3: 1000 coins + 2 boxes
--   • completed bar: 5 boxes for every contributor with >= 1 eligible unit sold

-- ── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.farm_seasonal_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start            date NOT NULL UNIQUE,
  species               text NOT NULL REFERENCES public.farm_card_defs(species),
  crop_type             text NOT NULL,
  target_daily_coins    integer NOT NULL CHECK (target_daily_coins > 0),
  bonus_per_unit        integer NOT NULL CHECK (bonus_per_unit >= 0),
  participants_snapshot integer NOT NULL CHECK (participants_snapshot >= 1),
  fair_cap_snapshot     integer NOT NULL CHECK (fair_cap_snapshot >= 1),
  grow_days             numeric NOT NULL CHECK (grow_days >= 1),
  cycles_per_week       integer NOT NULL CHECK (cycles_per_week >= 1),
  units_per_tile_week   integer NOT NULL CHECK (units_per_tile_week >= 1),
  fair_cap_user_units   integer NOT NULL CHECK (fair_cap_user_units >= 1),
  bar_target_units      integer NOT NULL CHECK (bar_target_units >= 1),
  rank1_coins           integer NOT NULL DEFAULT 2500,
  rank2_coins           integer NOT NULL DEFAULT 1500,
  rank3_coins           integer NOT NULL DEFAULT 1000,
  rank2_boxes           integer NOT NULL DEFAULT 5,
  rank3_boxes           integer NOT NULL DEFAULT 2,
  rank1_fallback_boxes  integer NOT NULL DEFAULT 10,
  bar_boxes             integer NOT NULL DEFAULT 5,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_seasonal_events_week_idx
  ON public.farm_seasonal_events(week_start DESC);

CREATE TABLE IF NOT EXISTS public.farm_seasonal_event_sales (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES public.farm_seasonal_events(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  crop_type      text NOT NULL,
  qty            integer NOT NULL CHECK (qty > 0),
  event_bonus    integer NOT NULL DEFAULT 0 CHECK (event_bonus >= 0),
  tax_paid       integer NOT NULL DEFAULT 0 CHECK (tax_paid >= 0),
  net_bonus      integer NOT NULL DEFAULT 0 CHECK (net_bonus >= 0),
  sold_at        timestamptz NOT NULL DEFAULT now(),
  meta           jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS farm_seasonal_sales_event_user_idx
  ON public.farm_seasonal_event_sales(event_id, user_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS farm_seasonal_sales_event_qty_idx
  ON public.farm_seasonal_event_sales(event_id, qty DESC);

CREATE TABLE IF NOT EXISTS public.farm_seasonal_weekly_awards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES public.farm_seasonal_events(id) ON DELETE CASCADE,
  week_start      date NOT NULL,
  user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot   text NOT NULL,
  rank            integer NOT NULL CHECK (rank BETWEEN 1 AND 3),
  qty             integer NOT NULL CHECK (qty > 0),
  prize_coins     integer NOT NULL DEFAULT 0 CHECK (prize_coins >= 0),
  prize_boxes     integer NOT NULL DEFAULT 0 CHECK (prize_boxes >= 0),
  nft_instance_id uuid REFERENCES public.farm_nft_instances(id) ON DELETE SET NULL,
  nft_species     text,
  nft_serial_no   integer,
  nft_name        text,
  awarded_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, rank),
  UNIQUE (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS farm_seasonal_awards_week_rank_idx
  ON public.farm_seasonal_weekly_awards(week_start DESC, rank ASC);

CREATE TABLE IF NOT EXISTS public.farm_seasonal_bar_awards (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES public.farm_seasonal_events(id) ON DELETE CASCADE,
  week_start     date NOT NULL,
  user_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot  text NOT NULL,
  qty            integer NOT NULL CHECK (qty > 0),
  boxes_awarded  integer NOT NULL CHECK (boxes_awarded > 0),
  awarded_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS farm_seasonal_bar_awards_week_idx
  ON public.farm_seasonal_bar_awards(week_start DESC, awarded_at DESC);

ALTER TABLE public.farm_seasonal_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_seasonal_event_sales   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_seasonal_weekly_awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_seasonal_bar_awards    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farm_seasonal_events_select" ON public.farm_seasonal_events;
CREATE POLICY "farm_seasonal_events_select" ON public.farm_seasonal_events
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "farm_seasonal_sales_select" ON public.farm_seasonal_event_sales;
CREATE POLICY "farm_seasonal_sales_select" ON public.farm_seasonal_event_sales
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "farm_seasonal_awards_select" ON public.farm_seasonal_weekly_awards;
CREATE POLICY "farm_seasonal_awards_select" ON public.farm_seasonal_weekly_awards
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "farm_seasonal_bar_awards_select" ON public.farm_seasonal_bar_awards;
CREATE POLICY "farm_seasonal_bar_awards_select" ON public.farm_seasonal_bar_awards
  FOR SELECT TO anon, authenticated USING (true);

REVOKE ALL ON public.farm_seasonal_events, public.farm_seasonal_event_sales,
              public.farm_seasonal_weekly_awards, public.farm_seasonal_bar_awards
  FROM anon, authenticated;
GRANT SELECT ON public.farm_seasonal_events, public.farm_seasonal_event_sales,
                public.farm_seasonal_weekly_awards, public.farm_seasonal_bar_awards
  TO anon, authenticated;

-- ── Helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.farm_seasonal_week_start(p_ts timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT date_trunc('week', timezone('Europe/Warsaw', COALESCE(p_ts, now())))::date;
$$;

CREATE OR REPLACE FUNCTION public.farm_seasonal_species_for_week(p_week_start date)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_week_start < DATE '2026-07-06' THEN NULL
    ELSE (ARRAY[
      'carrot',
      'potato',
      'tomato',
      'corn',
      'chili',
      'strawberry',
      'pumpkin',
      'grapes',
      'pineapple'
    ])[
      (((p_week_start - DATE '2026-07-06') / 7) % 9) + 1
    ]
  END;
$$;

CREATE OR REPLACE FUNCTION public.farm_seasonal_target_daily_coins()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (ceil((max(d.base_yield * m.base_price * 0.57
      / greatest(1, d.base_grow_minutes / 1440.0)) * 1.25) / 10.0) * 10)::integer,
    150
  )
  FROM public.farm_card_defs d
  JOIN public.farm_market m ON m.crop_type = d.crop_type
  WHERE d.is_active
    AND d.edition_size IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.ensure_farm_seasonal_event(
  p_week_start date DEFAULT public.farm_seasonal_week_start(now()),
  p_species text DEFAULT NULL
)
RETURNS public.farm_seasonal_events
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event        public.farm_seasonal_events%ROWTYPE;
  v_def          public.farm_card_defs%ROWTYPE;
  v_species      text := COALESCE(p_species, public.farm_seasonal_species_for_week(p_week_start));
  v_participants integer;
  v_fair_cap     integer;
  v_grow_days    numeric;
  v_cycles       integer;
  v_units        integer;
  v_target_daily integer;
  v_bonus        integer;
  v_bar_target   integer;
BEGIN
  IF p_week_start IS NULL OR p_week_start < DATE '2026-07-06' THEN
    RAISE EXCEPTION 'seasonal_event_not_started';
  END IF;
  IF v_species IS NULL THEN
    RAISE EXCEPTION 'seasonal_event_no_species';
  END IF;

  SELECT * INTO v_event
    FROM public.farm_seasonal_events
   WHERE week_start = p_week_start;
  IF FOUND AND EXISTS (SELECT 1 FROM public.farm_seasonal_event_sales s WHERE s.event_id = v_event.id) THEN
    RETURN v_event;
  END IF;

  SELECT * INTO v_def
    FROM public.farm_card_defs
   WHERE species = v_species
     AND is_active
     AND edition_size IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bad_species';
  END IF;

  v_participants := public.farm_land_tax_participant_count();
  v_fair_cap := public.farm_fair_cap();
  v_grow_days := greatest(1, v_def.base_grow_minutes / 1440.0);
  v_cycles := greatest(1, floor(7 / v_grow_days)::integer);
  v_units := greatest(1, v_cycles * v_def.base_yield);
  v_target_daily := public.farm_seasonal_target_daily_coins();
  v_bonus := greatest(0, ceil(
    v_target_daily * v_grow_days / v_def.base_yield
    - (SELECT m.base_price FROM public.farm_market m WHERE m.crop_type = v_def.crop_type) * 0.57
  )::integer);
  v_bar_target := greatest(25, (ceil((v_participants * v_fair_cap * v_units * 0.35) / 25.0) * 25)::integer);

  INSERT INTO public.farm_seasonal_events (
    week_start, species, crop_type, target_daily_coins, bonus_per_unit,
    participants_snapshot, fair_cap_snapshot, grow_days, cycles_per_week,
    units_per_tile_week, fair_cap_user_units, bar_target_units
  )
  VALUES (
    p_week_start, v_def.species, v_def.crop_type, v_target_daily, v_bonus,
    v_participants, v_fair_cap, v_grow_days, v_cycles,
    v_units, v_fair_cap * v_units, v_bar_target
  )
  ON CONFLICT (week_start) DO UPDATE SET
    species = EXCLUDED.species,
    crop_type = EXCLUDED.crop_type,
    target_daily_coins = EXCLUDED.target_daily_coins,
    bonus_per_unit = EXCLUDED.bonus_per_unit,
    participants_snapshot = EXCLUDED.participants_snapshot,
    fair_cap_snapshot = EXCLUDED.fair_cap_snapshot,
    grow_days = EXCLUDED.grow_days,
    cycles_per_week = EXCLUDED.cycles_per_week,
    units_per_tile_week = EXCLUDED.units_per_tile_week,
    fair_cap_user_units = EXCLUDED.fair_cap_user_units,
    bar_target_units = EXCLUDED.bar_target_units
  WHERE NOT EXISTS (
    SELECT 1
      FROM public.farm_seasonal_event_sales s
     WHERE s.event_id = public.farm_seasonal_events.id
  );

  SELECT * INTO v_event
    FROM public.farm_seasonal_events
   WHERE week_start = p_week_start;
  RETURN v_event;
END;
$$;

CREATE OR REPLACE FUNCTION public.farm_ensure_seasonal_display_event()
RETURNS json
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_week date := public.farm_seasonal_week_start(now());
  v_event public.farm_seasonal_events%ROWTYPE;
BEGIN
  IF v_week < DATE '2026-07-06' THEN
    v_week := DATE '2026-07-06';
  END IF;

  v_event := public.ensure_farm_seasonal_event(v_week);
  RETURN json_build_object('ok', true, 'event_id', v_event.id, 'week_start', v_event.week_start);
END;
$$;

-- ── Views ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.farm_seasonal_event_rollup WITH (security_invoker = true) AS
WITH totals AS (
  SELECT s.event_id,
         COALESCE(sum(s.qty), 0)::integer AS total_units,
         count(DISTINCT s.user_id)::integer AS contributor_count
    FROM public.farm_seasonal_event_sales s
    JOIN public.profiles p ON p.id = s.user_id
   WHERE NOT p.is_admin
   GROUP BY event_id
),
current_week AS (
  SELECT public.farm_seasonal_week_start(now()) AS week_start
)
SELECT
  e.id AS event_id,
  e.week_start,
  (e.week_start::timestamp AT TIME ZONE 'Europe/Warsaw') AS starts_at,
  ((e.week_start + 7)::timestamp AT TIME ZONE 'Europe/Warsaw') AS ends_at,
  CASE
    WHEN cw.week_start < e.week_start THEN 'upcoming'
    WHEN cw.week_start = e.week_start THEN 'active'
    ELSE 'closed'
  END AS status,
  (cw.week_start = e.week_start) AS is_active,
  e.species,
  e.crop_type,
  d.name,
  d.emoji,
  e.target_daily_coins,
  e.bonus_per_unit,
  e.participants_snapshot,
  e.fair_cap_snapshot,
  e.grow_days,
  e.cycles_per_week,
  e.units_per_tile_week,
  e.fair_cap_user_units,
  e.bar_target_units,
  COALESCE(t.total_units, 0)::integer AS total_units,
  COALESCE(t.contributor_count, 0)::integer AS contributor_count,
  (COALESCE(t.total_units, 0) >= e.bar_target_units) AS bar_filled,
  e.rank1_coins,
  e.rank2_coins,
  e.rank3_coins,
  e.rank2_boxes,
  e.rank3_boxes,
  e.rank1_fallback_boxes,
  e.bar_boxes,
  EXISTS (SELECT 1 FROM public.farm_seasonal_weekly_awards a WHERE a.event_id = e.id) AS rank_awarded,
  EXISTS (SELECT 1 FROM public.farm_seasonal_bar_awards b WHERE b.event_id = e.id) AS bar_awarded
FROM public.farm_seasonal_events e
JOIN public.farm_card_defs d ON d.species = e.species
CROSS JOIN current_week cw
LEFT JOIN totals t ON t.event_id = e.id;

CREATE OR REPLACE VIEW public.farm_seasonal_display_event WITH (security_invoker = true) AS
SELECT r.*
  FROM public.farm_seasonal_event_rollup r
 WHERE r.week_start = (
   CASE
     WHEN public.farm_seasonal_week_start(now()) < DATE '2026-07-06'
       THEN DATE '2026-07-06'
     ELSE public.farm_seasonal_week_start(now())
   END
 )
 ORDER BY r.week_start
 LIMIT 1;

CREATE OR REPLACE VIEW public.farm_seasonal_leaderboard WITH (security_invoker = true) AS
WITH agg AS (
  SELECT
    s.event_id,
    s.user_id,
    sum(s.qty)::integer AS qty,
    sum(s.event_bonus)::integer AS event_bonus,
    min(s.sold_at) AS first_sale_at,
    max(s.sold_at) AS last_sale_at
  FROM public.farm_seasonal_event_sales s
  GROUP BY s.event_id, s.user_id
),
ranked AS (
  SELECT
    a.*,
    row_number() OVER (
      PARTITION BY a.event_id
      ORDER BY a.qty DESC, a.last_sale_at ASC, a.user_id
    )::integer AS rank
  FROM agg a
  JOIN public.profiles p ON p.id = a.user_id
  WHERE NOT p.is_admin
)
SELECT
  r.event_id,
  e.week_start,
  r.user_id,
  p.nick,
  r.qty,
  r.event_bonus,
  r.first_sale_at,
  r.last_sale_at,
  r.rank
FROM ranked r
JOIN public.farm_seasonal_events e ON e.id = r.event_id
JOIN public.profiles p ON p.id = r.user_id;

CREATE OR REPLACE VIEW public.farm_seasonal_recent_awards WITH (security_invoker = true) AS
SELECT
  a.event_id,
  a.week_start,
  a.rank,
  a.user_id,
  a.nick_snapshot AS nick,
  a.qty,
  a.prize_coins,
  a.prize_boxes,
  a.nft_species,
  a.nft_serial_no,
  a.nft_name,
  a.awarded_at
FROM public.farm_seasonal_weekly_awards a
ORDER BY a.week_start DESC, a.rank ASC;

GRANT SELECT ON public.farm_seasonal_event_rollup, public.farm_seasonal_display_event,
                public.farm_seasonal_leaderboard, public.farm_seasonal_recent_awards
  TO anon, authenticated;

-- ── Random NFT mint for rank 1 ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.farm_mint_random_event_nft(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempts integer := 0;
  v_total    numeric;
  v_roll     numeric;
  v_species  text;
  v_def      public.farm_card_defs%ROWTYPE;
  v_serial   integer;
  v_nft_idx  integer;
  v_name     text;
  v_id       uuid;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  WHILE v_attempts < 20 LOOP
    v_attempts := v_attempts + 1;

    SELECT sum(draw_weight)::numeric INTO v_total
      FROM public.farm_card_defs
     WHERE is_active
       AND edition_size IS NOT NULL
       AND draw_weight > 0
       AND minted_count < edition_size;
    IF v_total IS NULL OR v_total <= 0 THEN
      RETURN NULL;
    END IF;

    v_roll := random() * v_total;
    SELECT species INTO v_species
      FROM (
        SELECT species, sum(draw_weight) OVER (ORDER BY species) AS cum
          FROM public.farm_card_defs
         WHERE is_active
           AND edition_size IS NOT NULL
           AND draw_weight > 0
           AND minted_count < edition_size
      ) q
     WHERE q.cum > v_roll
     ORDER BY q.cum
     LIMIT 1;

    SELECT * INTO v_def
      FROM public.farm_card_defs
     WHERE species = v_species
     FOR UPDATE;
    IF NOT FOUND OR v_def.minted_count >= v_def.edition_size THEN
      CONTINUE;
    END IF;

    v_serial := v_def.minted_count + 1;
    SELECT COALESCE(sum(d2.minted_count), 0) INTO v_nft_idx
      FROM public.farm_card_defs d2
     WHERE d2.edition_size IS NOT NULL
       AND public.farm_nft_pool(d2.species) = public.farm_nft_pool(v_species);
    v_name := public.farm_nft_persona(v_species, v_nft_idx);

    INSERT INTO public.farm_nft_instances
      (species, serial_no, edition_size, owner_id, acquired_from, nft_name)
    VALUES
      (v_species, v_serial, v_def.edition_size, p_user, 'seasonal_reward', v_name)
    RETURNING id INTO v_id;

    UPDATE public.farm_card_defs
       SET minted_count = minted_count + 1
     WHERE species = v_species;

    IF to_regclass('public.farm_nft_transfers') IS NOT NULL THEN
      INSERT INTO public.farm_nft_transfers
        (instance_id, species, serial_no, from_owner, to_owner, price, kind)
      VALUES
        (v_id, v_species, v_serial, NULL, p_user, NULL, 'mint');
    END IF;

    RETURN jsonb_build_object(
      'id', v_id,
      'species', v_species,
      'serial_no', v_serial,
      'edition_size', v_def.edition_size,
      'nft_name', v_name
    );
  END LOOP;

  RETURN NULL;
END;
$$;

-- ── sell_crop_to_npc override: normal sale + seasonal premium ───────────────

CREATE OR REPLACE FUNCTION public.sell_crop_to_npc(p_crop_type text, p_qty integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_mkt       public.farm_market%ROWTYPE;
  v_event     public.farm_seasonal_events%ROWTYPE;
  v_has_event boolean := false;
  v_event_from timestamptz;
  v_event_to   timestamptz;
  v_event_qty  integer := 0;
  v_event_bonus integer := 0;
  v_event_net   integer := 0;
  v_event_tax_paid integer := 0;
  v_avail     integer;
  v_inv       integer;
  v_remain    integer;
  v_take      integer;
  v_floor     numeric;
  v_anchor    numeric;
  v_cur_eff   numeric;
  v_dropfrac  numeric;
  v_price     numeric;
  v_proceeds  numeric;
  v_hours     numeric;
  v_coins     integer;
  v_pay       integer;
  v_tax       json;
  v_tax_paid  integer := 0;
  v_net_pay   integer := 0;
  v_debt      integer := 0;
  v_lot       record;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'bad_qty'; END IF;

  SELECT * INTO v_mkt FROM public.farm_market WHERE crop_type = p_crop_type FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_market'; END IF;

  IF public.farm_seasonal_week_start(now()) >= DATE '2026-07-06'
     AND public.farm_seasonal_species_for_week(public.farm_seasonal_week_start(now())) IS NOT NULL THEN
    v_event := public.ensure_farm_seasonal_event(public.farm_seasonal_week_start(now()));
    IF v_event.crop_type = p_crop_type THEN
      v_has_event := true;
      v_event_from := v_event.week_start::timestamp AT TIME ZONE 'Europe/Warsaw';
      v_event_to := (v_event.week_start + 7)::timestamp AT TIME ZONE 'Europe/Warsaw';
    END IF;
  END IF;

  SELECT COALESCE(sum(qty), 0) INTO v_avail FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now();
  IF v_avail < p_qty THEN RAISE EXCEPTION 'not_enough_crops'; END IF;

  v_remain := p_qty;
  FOR v_lot IN
    SELECT id, qty, harvested_at FROM public.farm_inventory
     WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now()
     ORDER BY expires_at, id
     FOR UPDATE
  LOOP
    EXIT WHEN v_remain <= 0;
    v_take := least(v_remain, v_lot.qty);

    IF v_has_event
       AND v_lot.harvested_at >= v_event_from
       AND v_lot.harvested_at < v_event_to THEN
      v_event_qty := v_event_qty + v_take;
    END IF;

    IF v_take >= v_lot.qty THEN
      DELETE FROM public.farm_inventory WHERE id = v_lot.id;
    ELSE
      UPDATE public.farm_inventory SET qty = qty - v_take WHERE id = v_lot.id;
    END IF;
    v_remain := v_remain - v_take;
  END LOOP;

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
  v_tax := public.farm_apply_land_tax_autopay(
    v_user, v_pay, 'farm_crop_sale',
    jsonb_build_object('crop_type', p_crop_type, 'qty', p_qty)
  );
  v_tax_paid := COALESCE((v_tax->>'tax_paid')::integer, 0);
  v_net_pay := COALESCE((v_tax->>'net')::integer, v_pay);
  v_debt := COALESCE((v_tax->>'debt')::integer, 0);

  UPDATE public.profiles SET coins = coins + v_net_pay WHERE id = v_user
  RETURNING coins INTO v_coins;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, v_pay, 'farm_crop_sale',
            jsonb_build_object('crop_type', p_crop_type, 'qty', p_qty,
                               'cur_price', round(v_cur_eff, 2),
                               'unit_price', round(v_pay::numeric / p_qty, 2),
                               'tax_paid', v_tax_paid, 'net', v_net_pay));
  END IF;

  IF v_has_event AND v_event_qty > 0 AND v_event.bonus_per_unit > 0 THEN
    v_event_bonus := v_event_qty * v_event.bonus_per_unit;
    v_tax := public.farm_apply_land_tax_autopay(
      v_user, v_event_bonus, 'farm_seasonal_contract_bonus',
      jsonb_build_object('event_id', v_event.id, 'week_start', v_event.week_start,
                         'crop_type', p_crop_type, 'qty', v_event_qty,
                         'bonus_per_unit', v_event.bonus_per_unit)
    );
    v_event_tax_paid := COALESCE((v_tax->>'tax_paid')::integer, 0);
    v_event_net := COALESCE((v_tax->>'net')::integer, v_event_bonus);
    v_debt := COALESCE((v_tax->>'debt')::integer, v_debt);

    UPDATE public.profiles SET coins = coins + v_event_net WHERE id = v_user
    RETURNING coins INTO v_coins;

    INSERT INTO public.farm_seasonal_event_sales
      (event_id, user_id, crop_type, qty, event_bonus, tax_paid, net_bonus, meta)
    VALUES
      (v_event.id, v_user, p_crop_type, v_event_qty, v_event_bonus,
       v_event_tax_paid, v_event_net,
       jsonb_build_object('bonus_per_unit', v_event.bonus_per_unit,
                          'normal_sale_qty', p_qty,
                          'normal_sale_coins', v_pay));

    IF to_regclass('public.coin_transactions') IS NOT NULL THEN
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES (v_user, v_event_bonus, 'farm_seasonal_contract_bonus',
              jsonb_build_object('event_id', v_event.id, 'week_start', v_event.week_start,
                                 'crop_type', p_crop_type, 'qty', v_event_qty,
                                 'bonus_per_unit', v_event.bonus_per_unit,
                                 'tax_paid', v_event_tax_paid, 'net', v_event_net));
    END IF;
  END IF;

  SELECT COALESCE(sum(qty), 0) INTO v_inv FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now();

  RETURN json_build_object('ok', true, 'coins', v_coins, 'crop_type', p_crop_type,
    'sold', p_qty, 'proceeds', v_pay, 'net', v_net_pay, 'tax_paid', v_tax_paid,
    'land_tax_debt', v_debt, 'cur_price', round(v_price, 2), 'inventory_qty', v_inv,
    'seasonal_event_id', CASE WHEN v_has_event THEN v_event.id ELSE NULL END,
    'event_counted_qty', v_event_qty, 'event_bonus', v_event_bonus,
    'event_net', v_event_net, 'event_tax_paid', v_event_tax_paid);
END;
$$;

-- ── Weekly award payout ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.award_farm_seasonal_week(
  p_week_start date DEFAULT public.farm_seasonal_week_start(now() - interval '7 days')
)
RETURNS json
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_week date := public.farm_seasonal_week_start(now());
  v_event public.farm_seasonal_events%ROWTYPE;
  v_award_id uuid;
  v_bar_id uuid;
  v_rank_awards integer := 0;
  v_bar_awards integer := 0;
  v_coin_total integer := 0;
  v_box_total integer := 0;
  v_total_units integer := 0;
  v_prize_coins integer;
  v_prize_boxes integer;
  v_nft jsonb;
  v_nft_id uuid;
  v_nft_species text;
  v_nft_serial integer;
  v_nft_name text;
  v_winner record;
  v_contrib record;
  v_awards json;
BEGIN
  IF p_week_start IS NULL OR p_week_start < DATE '2026-07-06' THEN
    RETURN json_build_object('ok', true, 'skipped', 'before_first_event', 'week_start', p_week_start);
  END IF;
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  v_event := public.ensure_farm_seasonal_event(p_week_start);
  SELECT * INTO v_event
    FROM public.farm_seasonal_events
   WHERE id = v_event.id
   FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.farm_seasonal_weekly_awards WHERE event_id = v_event.id) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, qty, prize_coins, prize_boxes,
             nft_species, nft_serial_no, nft_name
      FROM public.farm_seasonal_weekly_awards
      WHERE event_id = v_event.id
      ORDER BY rank
    ) a;
    RETURN json_build_object('ok', true, 'already_awarded', true,
      'week_start', p_week_start, 'awards', v_awards);
  END IF;

  FOR v_winner IN
    SELECT *
    FROM public.farm_seasonal_leaderboard
    WHERE event_id = v_event.id
      AND rank <= 3
      AND qty > 0
    ORDER BY rank
  LOOP
    v_prize_coins := CASE v_winner.rank
      WHEN 1 THEN v_event.rank1_coins
      WHEN 2 THEN v_event.rank2_coins
      WHEN 3 THEN v_event.rank3_coins
      ELSE 0 END;
    v_prize_boxes := CASE v_winner.rank
      WHEN 2 THEN v_event.rank2_boxes
      WHEN 3 THEN v_event.rank3_boxes
      ELSE 0 END;
    v_nft := NULL;
    v_nft_id := NULL;
    v_nft_species := NULL;
    v_nft_serial := NULL;
    v_nft_name := NULL;
    v_award_id := NULL;

    IF v_winner.rank = 1 THEN
      v_nft := public.farm_mint_random_event_nft(v_winner.user_id);
      IF v_nft IS NULL THEN
        v_prize_boxes := v_event.rank1_fallback_boxes;
      ELSE
        v_nft_id := (v_nft->>'id')::uuid;
        v_nft_species := v_nft->>'species';
        v_nft_serial := (v_nft->>'serial_no')::integer;
        v_nft_name := v_nft->>'nft_name';
      END IF;
    END IF;

    INSERT INTO public.farm_seasonal_weekly_awards
      (event_id, week_start, user_id, nick_snapshot, rank, qty, prize_coins,
       prize_boxes, nft_instance_id, nft_species, nft_serial_no, nft_name)
    VALUES
      (v_event.id, v_event.week_start, v_winner.user_id, v_winner.nick,
       v_winner.rank, v_winner.qty, v_prize_coins, v_prize_boxes,
       v_nft_id, v_nft_species, v_nft_serial, v_nft_name)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_award_id;

    IF v_award_id IS NOT NULL THEN
      v_rank_awards := v_rank_awards + 1;
      v_coin_total := v_coin_total + v_prize_coins;
      v_box_total := v_box_total + v_prize_boxes;

      IF v_prize_coins > 0 THEN
        UPDATE public.profiles
           SET coins = coins + v_prize_coins
         WHERE id = v_winner.user_id;

        IF to_regclass('public.coin_transactions') IS NOT NULL THEN
          INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
          VALUES (
            v_winner.user_id, v_prize_coins, 'farm_seasonal_rank_award',
            jsonb_build_object('event_id', v_event.id, 'week_start', v_event.week_start,
                               'rank', v_winner.rank, 'qty', v_winner.qty,
                               'prize_boxes', v_prize_boxes,
                               'nft_instance_id', v_nft_id,
                               'nft_species', v_nft_species,
                               'nft_serial_no', v_nft_serial)
          );
        END IF;
      END IF;

      IF v_prize_boxes > 0 THEN
        INSERT INTO public.farm_user_state (user_id, boxes)
        VALUES (v_winner.user_id, v_prize_boxes)
        ON CONFLICT (user_id) DO UPDATE
          SET boxes = public.farm_user_state.boxes + EXCLUDED.boxes;
      END IF;
    END IF;
  END LOOP;

  SELECT COALESCE(sum(s.qty), 0)::integer INTO v_total_units
    FROM public.farm_seasonal_event_sales s
    JOIN public.profiles p ON p.id = s.user_id
   WHERE s.event_id = v_event.id
     AND NOT p.is_admin;

  IF v_total_units >= v_event.bar_target_units THEN
    FOR v_contrib IN
      SELECT l.user_id, l.nick, l.qty
        FROM public.farm_seasonal_leaderboard l
       WHERE l.event_id = v_event.id
         AND l.qty > 0
       ORDER BY l.qty DESC, l.last_sale_at ASC
    LOOP
      v_bar_id := NULL;
      INSERT INTO public.farm_seasonal_bar_awards
        (event_id, week_start, user_id, nick_snapshot, qty, boxes_awarded)
      VALUES
        (v_event.id, v_event.week_start, v_contrib.user_id, v_contrib.nick,
         v_contrib.qty, v_event.bar_boxes)
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_bar_id;

      IF v_bar_id IS NOT NULL THEN
        v_bar_awards := v_bar_awards + 1;
        v_box_total := v_box_total + v_event.bar_boxes;
        INSERT INTO public.farm_user_state (user_id, boxes)
        VALUES (v_contrib.user_id, v_event.bar_boxes)
        ON CONFLICT (user_id) DO UPDATE
          SET boxes = public.farm_user_state.boxes + EXCLUDED.boxes;
      END IF;
    END LOOP;
  END IF;

  SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
    INTO v_awards
  FROM (
    SELECT rank, nick_snapshot AS nick, qty, prize_coins, prize_boxes,
           nft_species, nft_serial_no, nft_name
    FROM public.farm_seasonal_weekly_awards
    WHERE event_id = v_event.id
    ORDER BY rank
  ) a;

  RETURN json_build_object(
    'ok', true,
    'already_awarded', false,
    'week_start', p_week_start,
    'rank_awards_created', v_rank_awards,
    'bar_awards_created', v_bar_awards,
    'coins_awarded', v_coin_total,
    'boxes_awarded', v_box_total,
    'bar_filled', v_total_units >= v_event.bar_target_units,
    'awards', v_awards
  );
END;
$$;

-- ── Grants / realtime / cron ───────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.farm_seasonal_week_start(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_seasonal_species_for_week(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_seasonal_target_daily_coins() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_farm_seasonal_event(date, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_ensure_seasonal_display_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_mint_random_event_nft(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sell_crop_to_npc(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_farm_seasonal_week(date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.farm_seasonal_week_start(timestamptz) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.farm_ensure_seasonal_display_event() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sell_crop_to_npc(text, integer) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='farm_seasonal_event_sales') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_seasonal_event_sales;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='farm_seasonal_weekly_awards') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_seasonal_weekly_awards;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='farm_seasonal_bar_awards') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_seasonal_bar_awards;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'farm_seasonal_weekly_awards') THEN
      PERFORM cron.unschedule('farm_seasonal_weekly_awards');
    END IF;
    PERFORM cron.schedule(
      'farm_seasonal_weekly_awards',
      '5 0 * * 1',
      $cron$SELECT public.award_farm_seasonal_week(public.farm_seasonal_week_start(now() - interval '7 days'));$cron$
    );
  END IF;
EXCEPTION WHEN undefined_schema OR undefined_function THEN
  NULL;
END $$;

-- Seed the first visible event: next Monday from the requested implementation date.
SELECT public.ensure_farm_seasonal_event(DATE '2026-07-06', 'carrot');

NOTIFY pgrst, 'reload schema';
