-- ════════════════════════════════════════════════════════════════════════════
--  Anti-inflation controls  (2026-08-28)
-- ════════════════════════════════════════════════════════════════════════════
--  Run LAST, after every farm file and after bank.sql. Idempotent.
--  ⚠️ RE-RUN THIS after re-running any of:
--       supabase/farm-collector-perks.sql   (owns sell_crop_to_npc)
--       supabase/farm-price-history.sql     (owns roll_farm_prices / snapshot)
--       supabase/bank.sql                   (owns bank_net_mint_per_day, the
--                                            Sygnet seed row)
--
--  ── Why ────────────────────────────────────────────────────────────────────
--  Measured on prod 2026-08-28, 11 players, 406,848 coins in circulation:
--
--    farm crop sales          54,722 /day   (14d actual; the model over every
--                                            planted tile agrees at 56,336)
--    seasonal contract premium 8,343 /day
--    daily_interest            2,364 /day   and compounding
--    ---------------------------------------------------------------
--    recurring faucets       ~65,400 /day
--    recurring sinks         ~14,300 /day   (land tax 11,036 + casino 3,313)
--
--  The farm reprints the entire money supply every ~7 days. Box buying and card
--  level-ups looked like the balancing sink but were a BUILD-OUT PHASE, and it
--  is over: -802,900 in the week of 2026-08-03, -134,350 in the week of
--  2026-08-24, while crop revenue held at ~300k. Levelling stops paying at high
--  level by construction (cost 50*L^2, return a flat +0.5*base_yield*price), so
--  it is not coming back.
--
--  The root cause is that the farm is the one OPEN LOOP in the game. Every other
--  system has negative feedback -- the casino's RTP < 100%, the Bank's
--  health = TARGET/(TARGET+inflation), land tax's 1000*excess^2. But
--  roll_farm_prices() never read total_sold: price was pure noise, re-rolled
--  twice a day, and the per-sale dip fully recovered in 8h20m
--  (LEAST(1, hours*0.12)). Quantity had no price consequence, while yield is
--  base_yield * (1 + (L-1)*0.5) -- linear and UNBOUNDED in level, with grow time
--  floored at 24h so past ~L14 every level is free output.
--
--  ── What this file does ────────────────────────────────────────────────────
--   1. bank_net_mint_per_day()  -> TRIMMED MEAN of daily nets. A single 779,493
--      lottery payout (2026-08-03) owned the Bank's health metric for 25 days
--      and throttled it to a 4-bond edition on a false 2.87%/day reading.
--   2. interest_cap on every daily_interest item. The Sygnet was the only
--      unbounded, compounding term in the economy.
--   3. sell_crop_to_npc() -> the weekly contract premium is capped per player.
--      bonus_per_unit is derived for a LEVEL-1 farmer at fair_cap and was then
--      paid on unlimited units: Yurii collected 21,621 in the week of 08-24
--      against a design target of 840. Ranks and the community bar still count
--      the FULL quantity -- only the premium is capped.
--   4. The stalk market gets a demand side: an NPC payout budget funded by what
--      the farm and casino actually burn, and an anchor-price multiplier that
--      falls as the office sells past it. Above pressure 1 total crop revenue is
--      asymptotically CONSTANT, so card level stops driving coin creation.
--
--  Nobody's cards are nerfed. A L16 grape still yields 298 units/day; the office
--  just cannot dump all of them at full price.
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
--  POLICY CONSTANTS -- the only hand-set numbers in this file
-- ════════════════════════════════════════════════════════════════════════════
--  Kept as functions, not literals, so they can be retuned with a one-line
--  CREATE OR REPLACE instead of re-transcribing sell_crop_to_npc.

-- How many times a fair-share LEVEL-1 week's output still earns the weekly
-- contract premium. 1.0 would be the literal design intent; 3 is deliberately
-- generous, and still cuts the week of 2026-08-24 from 58,400 to ~7,600.
CREATE OR REPLACE FUNCTION public.farm_seasonal_premium_cap_x()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 3.0::numeric $fn$;

-- Share of measured burn the NPC is allowed to pay back out. Below 1.0 the
-- farm is a net sink; at 1.0 it is neutral; above 1.0 it mints. 0.90 was chosen
-- from a 180-day simulation: supply flat in week 1, 1.55x at day 90, 2.32x at
-- day 180 -- gentle growth instead of an exponential.
CREATE OR REPLACE FUNCTION public.farm_npc_burn_share()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.90::numeric $fn$;

-- Floor under the budget so the farm can never be starved to nothing (and so a
-- quiet week cannot spiral). Per active player per day. 8 players * 1,000 =
-- 8,000/day, deliberately BELOW the ~14,300/day of land tax + casino that burns
-- unconditionally -- at the floor the economy is still deflationary.
CREATE OR REPLACE FUNCTION public.farm_npc_budget_floor_per_player()
RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 1000 $fn$;

-- Hard bounds on the price multiplier, and how far it may move in one 12h roll.
-- The glide is what stops deployment day (or any sharp swing) from being a
-- cliff: 1.00 -> 0.59 takes three days, not one roll.
CREATE OR REPLACE FUNCTION public.farm_demand_bounds()
RETURNS TABLE (lo numeric, hi numeric, glide numeric)
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.20::numeric, 1.00::numeric, 0.15::numeric $fn$;

-- Per-crop skew exponent. 0 disables the skew entirely (one global multiplier).
-- 0.35 with a +-25% clamp nudges the crop the office is dumping down and the
-- niche crops up, which is what protects a small player's single NFT tile from
-- a grape glut they had no part in.
CREATE OR REPLACE FUNCTION public.farm_crop_skew_exponent()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.35::numeric $fn$;


-- ════════════════════════════════════════════════════════════════════════════
--  1. bank_net_mint_per_day() -- trimmed mean, not a raw 30-day mean
-- ════════════════════════════════════════════════════════════════════════════
--  The old body summed 30 days of ledger, subtracted 30 days of casino, and
--  divided by 30. Daily nets over that window range from -63,750 to +299,709,
--  so ONE event decides the answer:
--
--     mean            10,837  -> infl 2.87%/d  health 0.26  lokata 2,000  bonds  4
--     median           4,652  -> infl 1.32%/d  health 0.43  lokata 3,000  bonds  7
--     trimmed (2+2)    2,793  -> infl 0.79%/d  health 0.56  lokata 4,000  bonds  9
--
--  Bucketing by Warsaw day and dropping the two highest and two lowest days is
--  robust to one-off events BY CONSTRUCTION -- no reason allow-list to keep in
--  sync, so the next Loteria draw (or a big auction) cannot do this again. It
--  also defuses the cliff on 2026-09-03, when the lottery falls out of the
--  window and the raw mean would have stepped health 0.26 -> 1.00 overnight.
--
--  Empty days count as a genuine zero: the array is always exactly 30 slots, so
--  the divisor does not drift with activity. Same casino table spec and same
--  to_regclass guards as before.

CREATE OR REPLACE FUNCTION public.bank_net_mint_per_day()
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c_days  constant integer := 30;
  c_trim  constant integer := 2;   -- dropped from EACH end
  v_spec text[][] := ARRAY[
    ['roulette_spins','total_bet'], ['slots_spins','10'], ['plinko_spins','bet'],
    ['mines_spins','bet'], ['crash_spins','total_bet'], ['wheel_spins','total_bet']
  ];
  v_day   bigint[] := array_fill(0::bigint, ARRAY[c_days]);
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_out   bigint;
  i       integer;
  rec     record;
BEGIN
  -- Ledger: mints positive, burns negative.
  FOR rec IN
    SELECT (v_today - (ct.created_at AT TIME ZONE 'Europe/Warsaw')::date) AS off,
           sum(ct.delta)::bigint AS v
      FROM public.coin_transactions ct
     WHERE ct.created_at > now() - make_interval(days => c_days)
     GROUP BY 1
  LOOP
    IF rec.off BETWEEN 0 AND c_days - 1 THEN
      v_day[rec.off + 1] := v_day[rec.off + 1] + rec.v;
    END IF;
  END LOOP;

  -- Casino house net is a BURN, so it subtracts from creation.
  FOR i IN 1 .. array_length(v_spec, 1) LOOP
    IF to_regclass('public.' || v_spec[i][1]) IS NULL THEN CONTINUE; END IF;
    FOR rec IN EXECUTE format(
      'SELECT (%L::date - ((created_at AT TIME ZONE ''Europe/Warsaw'')::date)) AS off,
              COALESCE(sum(%s - total_won), 0)::bigint AS v
         FROM public.%I
        WHERE created_at > now() - interval ''%s days''
        GROUP BY 1',
      v_today, v_spec[i][2], v_spec[i][1], c_days
    ) LOOP
      IF rec.off BETWEEN 0 AND c_days - 1 THEN
        v_day[rec.off + 1] := v_day[rec.off + 1] - rec.v;
      END IF;
    END LOOP;
  END LOOP;

  SELECT COALESCE(round(avg(x)), 0)::bigint INTO v_out
    FROM (SELECT x FROM unnest(v_day) AS x ORDER BY x
           OFFSET c_trim LIMIT c_days - 2 * c_trim) t;

  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION public.bank_net_mint_per_day() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_net_mint_per_day() TO authenticated;

-- Today's bank_limits row was frozen from the OLD measurement. Drop it so the
-- next bank_state()/cron read recomputes it; the PK makes that a no-op after.
DELETE FROM public.bank_limits
 WHERE effective_date = (now() AT TIME ZONE 'Europe/Warsaw')::date;


-- ════════════════════════════════════════════════════════════════════════════
--  2. interest_cap -- the Sygnet stops compounding
-- ════════════════════════════════════════════════════════════════════════════
--  bank.sql already carries the column, the CHECK, and every consumer that
--  honours it (award_daily_interest, bank_interest_draw, bank_state's `signet`
--  block). It was simply left NULL, which made 2%/day of the WHOLE cash balance
--  the only unbounded, compounding term in the economy:
--
--    daily_interest paid   1,340/day (2026-08-23)  ->  2,364/day (2026-08-28)
--
--  as three players bought in over five days. Mariusz holds 38.7% of all cash
--  and has not bought one yet; his payback would be five days, and at full
--  adoption the item alone mints 2% of the money supply per day, compounding --
--  cash x1.8 in 30 days, x5.9 in 90, from this one row.
--
--  20,000 -> 400/day, so the 15,000 Sygnet pays for itself in 37 days and stays
--  a genuinely good deal, but the payout no longer grows with the balance it
--  creates. Exponential becomes linear. At full 11-player adoption the whole
--  item family costs 4,400/day instead of an unbounded curve.
--
--  UNIFORM on purpose: the legacy Pierścień Bankiera gets the same cap as the
--  Sygnet. One rule is easier to explain to eleven colleagues than "Filip's ring
--  is better", and it is bounded either way. To grandfather the legacy ring
--  instead, set its own row to a higher cap -- the code already reads per-def.

UPDATE public.hero_item_defs
   SET interest_cap = 20000
 WHERE effect_type = 'daily_interest';

-- The Sygnet's shop copy promised "bez limitu i bez górnej granicy" (no limit,
-- no ceiling). It has a ceiling now, so the description has to say so.
UPDATE public.hero_item_defs
   SET description = 'Ta sama umowa co legendarny Pierścień Bankiera: +2% dziennie od salda gotówki, naliczane od pierwszych 20 000 monet (maks. 400 🪙 dziennie). Odsetki liczą się wyłącznie od gotówki — monety zamrożone w lokacie, wydane na skrzynki albo stojące w pozycji rynkowej nie pracują. Wypłata codziennie rano, automatycznie.'
 WHERE slug = 'banker_signet';


-- ════════════════════════════════════════════════════════════════════════════
--  3. Weekly contract premium -- capped per player
-- ════════════════════════════════════════════════════════════════════════════
--  ensure_farm_seasonal_event() derives
--     bonus_per_unit = ceil(target_daily * grow_days / base_yield
--                           - base_price * 0.57)
--  i.e. exactly the top-up that brings a LEVEL-1 tile at fair_cap to
--  farm_seasonal_target_daily_coins() per day. It was then paid on every unit
--  sold, with no ceiling. Measured:
--
--    2026-08-24  Yurii   6,930 units = 24.8x fair cap  ->  21,621 coins
--    2026-08-24  Kornel  5,791 units = 20.7x fair cap  ->  18,763 coins
--    2026-08-17  Yurii   7,268 units = 30.3x fair cap  ->  30,235 coins
--    2026-08-17  Maciek     83 units =  0.3x fair cap  ->     345 coins
--
--  The design target for Yurii's week was 840 coins. The bar itself was already
--  made self-calibrating (2026-08-08); the per-unit premium never was.
--
--  premium_qty splits "how much did you sell" from "how much of it earned the
--  premium", so the community bar and the rank race keep measuring real output
--  and only the coin payout is bounded. A capped seller loses no sale — the crop
--  still sells at the normal NPC price, they just stop collecting the top-up.

ALTER TABLE public.farm_seasonal_event_sales
  ADD COLUMN IF NOT EXISTS premium_qty integer;

-- Everything before this migration was paid in full, so premium_qty = qty.
UPDATE public.farm_seasonal_event_sales SET premium_qty = qty WHERE premium_qty IS NULL;

ALTER TABLE public.farm_seasonal_event_sales
  ALTER COLUMN premium_qty SET DEFAULT 0;

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
  -- anti-inflation.sql: the premium is capped per player per week; v_event_qty
  -- stays the FULL eligible quantity (ranks + community bar), v_event_paid_qty
  -- is the slice that actually earns bonus_per_unit.
  v_event_paid_qty integer := 0;
  v_event_prev_qty integer := 0;
  v_event_cap  integer := 0;
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
  v_collector numeric := 0;   -- Lever 3: collector's-reputation NPC premium
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

  -- ── Weekly contract premium: cap the PAID slice ──────────────────────────
  -- bonus_per_unit is derived so a fair-share LEVEL-1 farmer nets
  -- farm_seasonal_target_daily_coins() per tile per day, then was paid on
  -- unlimited units. Real output runs 20-30x fair_cap_user_units, so the top
  -- two players collected ~25x the designed premium every week while everyone
  -- under the cap was unaffected. Sales still count in full toward the bar and
  -- the rank race — only the coin premium is bounded.
  IF v_has_event AND v_event_qty > 0 THEN
    SELECT COALESCE(sum(s.premium_qty), 0)::integer INTO v_event_prev_qty
      FROM public.farm_seasonal_event_sales s
     WHERE s.event_id = v_event.id AND s.user_id = v_user;
    v_event_cap := GREATEST(0, floor(v_event.fair_cap_user_units
                                     * public.farm_seasonal_premium_cap_x())::integer
                               - v_event_prev_qty);
    v_event_paid_qty := LEAST(v_event_qty, v_event_cap);
  END IF;

  v_anchor  := COALESCE(v_mkt.anchor_price, v_mkt.base_price);
  -- anti-inflation.sql: the floor moves with the demand multiplier, otherwise
  -- a saturated market would just bottom out at the old flat 30%-of-base and
  -- the throttle would do nothing. NULL = a market row that predates the
  -- migration, so fall back to the original constant.
  v_floor   := COALESCE(v_mkt.floor_price, v_mkt.base_price * 0.30);
  v_hours   := EXTRACT(EPOCH FROM (now() - v_mkt.last_decay_at)) / 3600.0;
  v_cur_eff := v_mkt.cur_price + (v_anchor - v_mkt.cur_price) * least(1, v_hours * 0.12);
  IF v_cur_eff < v_floor THEN v_cur_eff := v_floor; END IF;

  v_dropfrac := least(0.40, 0.005 * p_qty);
  v_price    := greatest(v_floor, v_cur_eff * (1 - v_dropfrac));

  -- Lever 3: better NPC price the more varied the seller's NFT collection is.
  v_collector := public.farm_collector_bonus(v_user);
  v_proceeds := p_qty * ((v_cur_eff + v_price) / 2.0) * (1 + v_collector);

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
                               'collector_bonus', round(v_collector, 4),
                               'tax_paid', v_tax_paid, 'net', v_net_pay));
  END IF;

  -- Enter on v_event_qty (not the paid slice) so a seller past their premium
  -- cap still shows up in the rank race and still pushes the community bar.
  IF v_has_event AND v_event_qty > 0 THEN
    IF v_event_paid_qty > 0 AND v_event.bonus_per_unit > 0 THEN
      -- „Sezonowy Łowca" (farm-achievements.sql) tops up the contract premium.
      v_event_bonus := round(v_event_paid_qty * v_event.bonus_per_unit
                             * (1 + COALESCE(public.farm_seasonal_bonus(v_user), 0)))::integer;
      v_tax := public.farm_apply_land_tax_autopay(
        v_user, v_event_bonus, 'farm_seasonal_contract_bonus',
        jsonb_build_object('event_id', v_event.id, 'week_start', v_event.week_start,
                           'crop_type', p_crop_type, 'qty', v_event_paid_qty,
                           'bonus_per_unit', v_event.bonus_per_unit)
      );
      v_event_tax_paid := COALESCE((v_tax->>'tax_paid')::integer, 0);
      v_event_net := COALESCE((v_tax->>'net')::integer, v_event_bonus);
      v_debt := COALESCE((v_tax->>'debt')::integer, v_debt);

      UPDATE public.profiles SET coins = coins + v_event_net WHERE id = v_user
      RETURNING coins INTO v_coins;
    END IF;

    INSERT INTO public.farm_seasonal_event_sales
      (event_id, user_id, crop_type, qty, premium_qty, event_bonus, tax_paid, net_bonus, meta)
    VALUES
      (v_event.id, v_user, p_crop_type, v_event_qty, v_event_paid_qty, v_event_bonus,
       v_event_tax_paid, v_event_net,
       jsonb_build_object('bonus_per_unit', v_event.bonus_per_unit,
                          'premium_cap_x', public.farm_seasonal_premium_cap_x(),
                          'premium_capped', (v_event_paid_qty < v_event_qty),
                          'normal_sale_qty', p_qty,
                          'normal_sale_coins', v_pay));

    IF v_event_bonus > 0 AND to_regclass('public.coin_transactions') IS NOT NULL THEN
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES (v_user, v_event_bonus, 'farm_seasonal_contract_bonus',
              jsonb_build_object('event_id', v_event.id, 'week_start', v_event.week_start,
                                 'crop_type', p_crop_type, 'qty', v_event_paid_qty,
                                 'eligible_qty', v_event_qty,
                                 'bonus_per_unit', v_event.bonus_per_unit,
                                 'tax_paid', v_event_tax_paid, 'net', v_event_net));
    END IF;
  END IF;

  SELECT COALESCE(sum(qty), 0) INTO v_inv FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now();

  RETURN json_build_object('ok', true, 'coins', v_coins, 'crop_type', p_crop_type,
    'sold', p_qty, 'proceeds', v_pay, 'net', v_net_pay, 'tax_paid', v_tax_paid,
    'land_tax_debt', v_debt, 'cur_price', round(v_price, 2), 'last_decay_at', now(),
    'inventory_qty', v_inv,
    'collector_bonus_pct', round(v_collector * 100)::integer,
    'seasonal_event_id', CASE WHEN v_has_event THEN v_event.id ELSE NULL END,
    'event_counted_qty', v_event_qty, 'event_paid_qty', v_event_paid_qty,
    'event_premium_cap_left', GREATEST(0, v_event_cap - v_event_paid_qty),
    'event_bonus', v_event_bonus,
    'event_net', v_event_net, 'event_tax_paid', v_event_tax_paid);
END;
$$;

REVOKE ALL ON FUNCTION public.sell_crop_to_npc(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sell_crop_to_npc(text, integer) TO authenticated;

-- The leaderboard is what the client reads to preview its own remaining premium
-- allowance, so it has to carry premium_qty. Rank order is unchanged: real
-- output (qty) still decides the race.
CREATE OR REPLACE VIEW public.farm_seasonal_leaderboard WITH (security_invoker = true) AS
 WITH agg AS (
         SELECT s.event_id,
            s.user_id,
            sum(s.qty)::integer AS qty,
            sum(COALESCE(s.premium_qty, s.qty))::integer AS premium_qty,
            sum(s.event_bonus)::integer AS event_bonus,
            min(s.sold_at) AS first_sale_at,
            max(s.sold_at) AS last_sale_at
           FROM farm_seasonal_event_sales s
          GROUP BY s.event_id, s.user_id
        ), ranked AS (
         SELECT a.event_id,
            a.user_id,
            a.qty,
            a.premium_qty,
            a.event_bonus,
            a.first_sale_at,
            a.last_sale_at,
            row_number() OVER (PARTITION BY a.event_id ORDER BY a.qty DESC, a.last_sale_at, a.user_id)::integer AS rank
           FROM agg a
             JOIN profiles p_1 ON p_1.id = a.user_id
          WHERE NOT p_1.is_admin
        )
 SELECT r.event_id,
    e.week_start,
    r.user_id,
    p.nick,
    r.qty,
    r.event_bonus,
    r.first_sale_at,
    r.last_sale_at,
    r.rank,
    -- appended LAST on purpose: CREATE OR REPLACE VIEW cannot insert a column
    -- in the middle of an existing view's column list.
    r.premium_qty
   FROM ranked r
     JOIN farm_seasonal_events e ON e.id = r.event_id
     JOIN profiles p ON p.id = r.user_id;

GRANT SELECT ON public.farm_seasonal_leaderboard TO authenticated;


-- ════════════════════════════════════════════════════════════════════════════
--  4. The stalk market gets a demand side
-- ════════════════════════════════════════════════════════════════════════════
--  What roll_farm_prices() used to be, in full:
--
--      r := random();
--      IF r < 0.45 THEN mult := 0.30 + random() * 0.20; ... END IF;
--      UPDATE farm_market SET anchor_price = base_price * mult, ...
--
--  total_sold was never read. Twice a day the price was re-rolled from noise,
--  and cur_price was reset UP to the new anchor, discarding any accumulated dip.
--  The per-sale dip did not help either: recovery is LEAST(1, hours * 0.12), a
--  lerp that completes in 8h20m, so harvesting once a day always sold at full
--  anchor. Quantity had no price consequence anywhere in the system.
--
--  ── The loop ───────────────────────────────────────────────────────────────
--      budget   = max(floor_per_player * players, burn_share * measured_burn)
--      pressure = trailing 7d crop revenue per day / budget
--      demand   = clamp(1 / (1 + max(0, pressure - 1)), 0.20, 1.00)
--      anchor   = base_price * regime_mult * demand * crop_skew
--
--  Above pressure 1 the payout is qty * base * regime * (budget/qty), i.e.
--  revenue is asymptotically CONSTANT in quantity. Card level stops driving coin
--  creation, without touching a single card: a L16 grape still yields 298
--  units/day, they are just worth less when the whole office dumps them.
--
--  ── Why the budget tracks BURN and not supply ─────────────────────────────
--  A supply-linked budget is a positive feedback loop (mint more -> supply up ->
--  budget up -> mint more). Burn-linked is self-balancing and legible: the NPC
--  pays back 90% of what the farm and the casino actually destroy, so the
--  office's spending funds the office's income. Buying boxes, levelling cards,
--  paying land tax and gambling all raise everyone's crop prices. It also cannot
--  spiral: the per-player floor is deliberately set BELOW the ~14,300/day of
--  land tax + casino that burns unconditionally.
--
--  Simulated over 180 days at burn_share 0.90 (supply, farm mint, net/day):
--      d7    411,782   37,240    +960     d90   630,592  15,603  +3,364
--      d30   451,407   25,397  +2,276     d180  945,837  13,848  +3,559
--  against 8.89M and +52,777/day with no change at all.

-- ── Measured burn: what the farm and the casino actually destroy ────────────
-- Deliberately NOT every negative ledger row. Escrow (bank_deposit_open,
-- bank_bond_buy, marketplace/auction bids) returns to the player, and one-off
-- item purchases are lumpy enough that a single 15,000 Sygnet would visibly move
-- crop prices. This is the recurring core, and it is a short list that stays
-- explainable to a player: "boxes, levelling, breeding, land, tax, casino".
CREATE OR REPLACE FUNCTION public.farm_burn_per_day()
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c_days constant integer := 21;
  c_trim constant integer := 2;
  v_day  bigint[] := array_fill(0::bigint, ARRAY[c_days]);
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_out  bigint;
  rec    record;
BEGIN
  FOR rec IN
    SELECT (v_today - (ct.created_at AT TIME ZONE 'Europe/Warsaw')::date) AS off,
           (-sum(ct.delta))::bigint AS v
      FROM public.coin_transactions ct
     WHERE ct.created_at > now() - make_interval(days => c_days)
       AND ct.delta < 0
       AND ct.reason IN ('farm_box_buy','farm_goldbox_buy','card_levelup','nft_breed',
                         'farm_tile_buy','farm_land_tax_pay','farm_land_tax_autopay')
     GROUP BY 1
  LOOP
    IF rec.off BETWEEN 0 AND c_days - 1 THEN
      v_day[rec.off + 1] := v_day[rec.off + 1] + rec.v;
    END IF;
  END LOOP;

  IF to_regclass('public.game_transactions') IS NOT NULL THEN
    FOR rec IN
      SELECT (v_today - (g.created_at AT TIME ZONE 'Europe/Warsaw')::date) AS off,
             sum(g.bet - g.won)::bigint AS v
        FROM public.game_transactions g
       WHERE g.created_at > now() - make_interval(days => c_days)
         AND NOT COALESCE(g.is_admin, false)
       GROUP BY 1
    LOOP
      IF rec.off BETWEEN 0 AND c_days - 1 THEN
        v_day[rec.off + 1] := v_day[rec.off + 1] + rec.v;
      END IF;
    END LOOP;
  END IF;

  -- Trimmed the same way as bank_net_mint_per_day(): one 555,600-coin levelling
  -- spree should not buy the office a week of high prices.
  SELECT COALESCE(round(avg(x)), 0)::bigint INTO v_out
    FROM (SELECT x FROM unnest(v_day) AS x ORDER BY x
           OFFSET c_trim LIMIT c_days - 2 * c_trim) t;

  RETURN GREATEST(0, v_out);
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_burn_per_day() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_burn_per_day() TO authenticated;


-- ── What the NPC is allowed to pay out per day, all crops together ──────────
CREATE OR REPLACE FUNCTION public.farm_npc_budget()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT GREATEST(
    public.farm_npc_budget_floor_per_player()::bigint * GREATEST(1, (
      SELECT count(DISTINCT ct.user_id)
        FROM public.coin_transactions ct
        JOIN public.profiles p ON p.id = ct.user_id AND NOT COALESCE(p.is_admin, false)
       WHERE ct.created_at > now() - interval '14 days'
    )),
    round(public.farm_npc_burn_share() * public.farm_burn_per_day())::bigint
  );
$fn$;

REVOKE ALL ON FUNCTION public.farm_npc_budget() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_npc_budget() TO authenticated;


-- ── Trailing crop revenue per day, gross (the ledger row is pre-land-tax) ───
CREATE OR REPLACE FUNCTION public.farm_revenue_per_day()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(round(sum(ct.delta) / 7.0), 0)::bigint
    FROM public.coin_transactions ct
   WHERE ct.created_at > now() - interval '7 days'
     AND ct.delta > 0
     AND ct.reason IN ('farm_crop_sale','farm_seasonal_contract_bonus');
$fn$;

REVOKE ALL ON FUNCTION public.farm_revenue_per_day() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_revenue_per_day() TO authenticated;


-- ── History table: every roll's inputs, frozen and public ──────────────────
-- Same principle as bank_limits: a price that moved for a reason nobody can see
-- is indistinguishable from an arbitrary one, so the whole derivation is stored
-- and readable by clients.
CREATE TABLE IF NOT EXISTS public.farm_market_pressure (
  rolled_at       timestamptz PRIMARY KEY DEFAULT now(),
  burn_per_day    bigint  NOT NULL,
  budget_per_day  bigint  NOT NULL,
  revenue_per_day bigint  NOT NULL,
  participants    integer NOT NULL,
  pressure_bps    integer NOT NULL,   -- revenue / budget, 10000 = exactly on budget
  demand_bps      integer NOT NULL,   -- the multiplier actually applied, 10000 = 1.00
  target_bps      integer NOT NULL    -- what it would have been without the glide
);

CREATE INDEX IF NOT EXISTS farm_market_pressure_recent_idx
  ON public.farm_market_pressure (rolled_at DESC);

ALTER TABLE public.farm_market_pressure ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_market_pressure_select" ON public.farm_market_pressure;
CREATE POLICY "farm_market_pressure_select" ON public.farm_market_pressure
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_market_pressure FROM anon, authenticated;
GRANT SELECT ON public.farm_market_pressure TO authenticated;

-- The demand-adjusted floor has to live on the row: sell_crop_to_npc runs on
-- every sale and must not recompute the whole measurement. Without this the
-- flat base_price * 0.30 floor would swallow the throttle whole — at demand
-- 0.59 and the 45%-likely low regime, base * 0.30 * 0.59 is already under it.
ALTER TABLE public.farm_market
  ADD COLUMN IF NOT EXISTS floor_price numeric;

UPDATE public.farm_market
   SET floor_price = round(base_price * 0.30, 2)
 WHERE floor_price IS NULL;


-- ── The roll ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.roll_farm_prices()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  m          public.farm_market%ROWTYPE;
  r          numeric;
  mult       numeric;
  v_lo       numeric;
  v_hi       numeric;
  v_glide    numeric;
  v_burn     bigint;
  v_budget   bigint;
  v_revenue  bigint;
  v_players  integer;
  v_pressure numeric;
  v_target   numeric;
  v_demand   numeric;
  v_prev     numeric;
  v_total    numeric;
  v_crops    integer;
  v_share    numeric;
  v_fair     numeric;
  v_skew     numeric;
  v_exp      numeric := public.farm_crop_skew_exponent();
BEGIN
  SELECT lo, hi, glide INTO v_lo, v_hi, v_glide FROM public.farm_demand_bounds();

  v_burn    := public.farm_burn_per_day();
  v_budget  := GREATEST(1, public.farm_npc_budget());
  v_revenue := public.farm_revenue_per_day();

  SELECT GREATEST(1, count(DISTINCT ct.user_id))::integer INTO v_players
    FROM public.coin_transactions ct
    JOIN public.profiles p ON p.id = ct.user_id AND NOT COALESCE(p.is_admin, false)
   WHERE ct.created_at > now() - interval '14 days';

  v_pressure := v_revenue::numeric / v_budget;
  v_target   := LEAST(v_hi, GREATEST(v_lo, 1.0 / (1.0 + GREATEST(0, v_pressure - 1))));

  -- Glide: at most `glide` of movement per roll, so a swing (deployment day
  -- included) takes days rather than landing as a cliff. Also damps the loop.
  SELECT demand_bps / 10000.0 INTO v_prev
    FROM public.farm_market_pressure ORDER BY rolled_at DESC LIMIT 1;
  v_prev := COALESCE(v_prev, v_hi);
  v_demand := LEAST(v_prev + v_glide, GREATEST(v_prev - v_glide, v_target));
  v_demand := LEAST(v_hi, GREATEST(v_lo, v_demand));

  -- now() is transaction time, so a manual double-roll (or the hourly gate
  -- firing twice inside one hour) would otherwise abort on the PK. One row per
  -- roll INSTANT is the intent, and the last write is the one whose prices the
  -- market actually ended up with.
  INSERT INTO public.farm_market_pressure
    (rolled_at, burn_per_day, budget_per_day, revenue_per_day, participants,
     pressure_bps, demand_bps, target_bps)
  VALUES (now(), v_burn, v_budget, v_revenue, v_players,
          round(v_pressure * 10000)::integer,
          round(v_demand * 10000)::integer,
          round(v_target * 10000)::integer)
  ON CONFLICT (rolled_at) DO UPDATE SET
    burn_per_day    = EXCLUDED.burn_per_day,
    budget_per_day  = EXCLUDED.budget_per_day,
    revenue_per_day = EXCLUDED.revenue_per_day,
    participants    = EXCLUDED.participants,
    pressure_bps    = EXCLUDED.pressure_bps,
    demand_bps      = EXCLUDED.demand_bps,
    target_bps      = EXCLUDED.target_bps;

  -- Per-crop skew, centred on an equal share of the budget. The global demand
  -- term does the work; this only decides WHO carries it, so that a small
  -- player's single crystal_lotus tile is not punished for a grape glut they
  -- had no part in. Set farm_crop_skew_exponent() to 0 to switch it off.
  SELECT COALESCE(sum(x.v), 0), GREATEST(1, count(*))
    INTO v_total, v_crops
    FROM (SELECT (ct.meta->>'crop_type') AS c, sum(ct.delta)::numeric AS v
            FROM public.coin_transactions ct
           WHERE ct.created_at > now() - interval '7 days'
             AND ct.reason = 'farm_crop_sale' AND ct.delta > 0
             AND ct.meta ? 'crop_type'
           GROUP BY 1) x;
  v_fair := 1.0 / v_crops;

  FOR m IN SELECT * FROM public.farm_market FOR UPDATE LOOP
    r := random();
    -- regime → multiplier of base_price
    IF    r < 0.45 THEN mult := 0.30 + random() * 0.20;   -- low   45%: 0.30–0.50
    ELSIF r < 0.78 THEN mult := 0.50 + random() * 0.22;   -- mid   33%: 0.50–0.72
    ELSIF r < 0.95 THEN mult := 0.72 + random() * 0.18;   -- high  17%: 0.72–0.90
    ELSE                mult := 0.90 + random() * 0.10;   -- spike  5%: 0.90–1.00
    END IF;

    v_skew := 1.0;
    IF v_exp > 0 AND v_total > 0 THEN
      SELECT COALESCE(sum(ct.delta), 0)::numeric / v_total INTO v_share
        FROM public.coin_transactions ct
       WHERE ct.created_at > now() - interval '7 days'
         AND ct.reason = 'farm_crop_sale' AND ct.delta > 0
         AND ct.meta->>'crop_type' = m.crop_type;
      IF v_share > 0 THEN
        v_skew := LEAST(1.25, GREATEST(0.75, power(v_fair / v_share, v_exp)));
      END IF;
    END IF;

    UPDATE public.farm_market
       SET anchor_price  = round(base_price * mult * v_demand * v_skew, 2),
           cur_price     = round(base_price * mult * v_demand * v_skew, 2),
           floor_price   = round(base_price * 0.30 * v_demand * v_skew, 2),
           last_decay_at = now()
     WHERE crop_type = m.crop_type;
  END LOOP;
END;
$fn$;

REVOKE ALL ON FUNCTION public.roll_farm_prices() FROM PUBLIC, anon, authenticated;


-- The 📈 Ceny chart mirrors the sale math, so it needs the same floor.
CREATE OR REPLACE FUNCTION public.snapshot_farm_prices()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  INSERT INTO public.farm_price_history (crop_type, price, recorded_at)
  SELECT m.crop_type,
         round(GREATEST(
           COALESCE(m.floor_price, m.base_price * 0.30),
           m.cur_price + (COALESCE(m.anchor_price, m.base_price) - m.cur_price)
             * LEAST(1, (EXTRACT(EPOCH FROM (now() - m.last_decay_at)) / 3600.0) * 0.12)
         ), 2),
         now()
    FROM public.farm_market m;
$fn$;

REVOKE ALL ON FUNCTION public.snapshot_farm_prices() FROM PUBLIC, anon, authenticated;


-- ── Read model for the UI ──────────────────────────────────────────────────
-- So the Ogródek can say "🌍 Rynek nasycony — skup płaci 74%" instead of the
-- office concluding the prices are broken.
CREATE OR REPLACE FUNCTION public.farm_market_state()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT json_build_object(
    'current', (SELECT row_to_json(t) FROM (
        SELECT rolled_at, burn_per_day, budget_per_day, revenue_per_day,
               participants, pressure_bps, demand_bps, target_bps
          FROM public.farm_market_pressure ORDER BY rolled_at DESC LIMIT 1) t),
    'history', COALESCE((SELECT json_agg(row_to_json(h)) FROM (
        SELECT rolled_at, budget_per_day, revenue_per_day, demand_bps
          FROM public.farm_market_pressure
         WHERE rolled_at > now() - interval '14 days'
         ORDER BY rolled_at DESC) h), '[]'::json),
    'burn_share',   public.farm_npc_burn_share(),
    'floor_per_player', public.farm_npc_budget_floor_per_player(),
    'premium_cap_x',  public.farm_seasonal_premium_cap_x()
  );
$fn$;

REVOKE ALL ON FUNCTION public.farm_market_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_market_state() TO authenticated;
