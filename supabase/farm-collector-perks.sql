-- ════════════════════════════════════════════════════════════════════════════
--  Farma — passive NFT collector perk  (Lever 3)
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER: farm.sql, farm-seasonal-contracts.sql, farm-weekly-nft-series.sql,
--             farm-nft-breeding.sql.  Idempotent.
--
--  „Renoma Kolekcjonera" (Collector's Reputation) — a passive, ownership-only
--  perk in the „own it = it works" spirit of the hero items: the NPC pays you a
--  better price the more VARIED your NFT collection is. No equipping, no timer.
--    bonus = min(30%, 2% × distinct NFT species owned)   [weekly + legendary + hybrid]
--  Applied server-side to sell_crop_to_npc proceeds, so it flows through the
--  existing land-tax autopay, seasonal-contract bonus, and coin_transactions
--  logging untouched.  Net worth is unaffected (this only tops up farm sales).
--
--  ⚠️ This supersedes sell_crop_to_npc from farm-seasonal-contracts.sql — that
--  copy is now stale. Re-run THIS file after re-running farm-seasonal-contracts.sql.
--
--  ⚠️ ORDERING: sell_crop_to_npc below also calls farm_seasonal_bonus(), which is
--  defined in farm-achievements.sql (run right after this file). Being plpgsql,
--  it CREATEs fine either way — the call resolves at runtime — but a crop sold in
--  the gap between the two files would error, so apply both in one sitting.
--
--  Fast-follow hooks (not built here, per scope): set-completion bonus and a
--  „Kolekcjoner" leaderboard can read the same farm_collector_bonus()/status.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Collector bonus: fraction added to NPC sale proceeds ───────────────────
CREATE OR REPLACE FUNCTION public.farm_collector_bonus(p_user uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT LEAST(0.30, 0.02 * COALESCE((
    SELECT count(DISTINCT ni.species)
      FROM public.farm_nft_instances ni
     WHERE ni.owner_id = p_user
  ), 0))::numeric;
$$;
GRANT EXECUTE ON FUNCTION public.farm_collector_bonus(uuid) TO authenticated;

-- Public status read for the UI badge (distinct species + resulting %).
CREATE OR REPLACE FUNCTION public.farm_collector_status(p_user uuid DEFAULT auth.uid())
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT json_build_object(
    'distinct_species', COALESCE((
      SELECT count(DISTINCT ni.species) FROM public.farm_nft_instances ni
       WHERE ni.owner_id = p_user), 0),
    'nft_count', COALESCE((
      SELECT count(*) FROM public.farm_nft_instances ni
       WHERE ni.owner_id = p_user), 0),
    'bonus_pct', round(public.farm_collector_bonus(p_user) * 100)::integer,
    'bonus_max_pct', 30);
$$;
GRANT EXECUTE ON FUNCTION public.farm_collector_status(uuid) TO authenticated;

-- ── Supersede sell_crop_to_npc: inject the collector premium into proceeds ──
-- Verbatim copy of the farm-seasonal-contracts.sql version, with ONLY:
--   • a v_collector numeric declared + populated from farm_collector_bonus()
--   • v_proceeds multiplied by (1 + v_collector)
--   • collector_bonus_pct added to the return JSON
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

  v_anchor  := COALESCE(v_mkt.anchor_price, v_mkt.base_price);
  v_floor   := v_mkt.base_price * 0.30;
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

  IF v_has_event AND v_event_qty > 0 AND v_event.bonus_per_unit > 0 THEN
    -- „Sezonowy Łowca" (farm-achievements.sql) tops up the contract premium.
    v_event_bonus := round(v_event_qty * v_event.bonus_per_unit
                           * (1 + COALESCE(public.farm_seasonal_bonus(v_user), 0)))::integer;
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
    'land_tax_debt', v_debt, 'cur_price', round(v_price, 2), 'last_decay_at', now(),
    'inventory_qty', v_inv,
    'collector_bonus_pct', round(v_collector * 100)::integer,
    'seasonal_event_id', CASE WHEN v_has_event THEN v_event.id ELSE NULL END,
    'event_counted_qty', v_event_qty, 'event_bonus', v_event_bonus,
    'event_net', v_event_net, 'event_tax_paid', v_event_tax_paid);
END;
$$;
REVOKE ALL ON FUNCTION public.sell_crop_to_npc(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sell_crop_to_npc(text, integer) TO authenticated;
