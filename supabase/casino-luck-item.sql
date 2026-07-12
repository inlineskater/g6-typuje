-- „Amulet Bezwstydnego Fartu" 🍀 (dawniej „Amulet Fortuny") — timed (7-day) COMMUNAL casino-luck shop item: while any
-- unexpired instance exists, EVERY player gets the luck boost (the buyer pays
-- for the whole office). Each purchase queues +7 days onto the shared window.
-- Run AFTER hero-items.sql and hero-items-always-active.sql (this file
-- supersedes their copies of purchase_hero_item, my_hero_inventory and
-- hero_score_bonus — re-run THIS file after re-running either of those).
-- Idempotent: safe to re-run.
--
-- Design (the effect itself lives in the Edge Functions — keep in sync):
--   * slots-action:    G6 symbol weight +2 (RTP 89.1% -> 97.2%)
--   * roulette-action: +1% on winning payouts (RTP 97.3% -> 98.3%; 2% would
--     make straight bets + lucky_trousers' stake-refund rescue stack +EV)
--   * plinko-action:   winning payout ×1.01 (worst config RTP 98.1% -> 99.1%)
--   * mines-action:    house factor 0.95 -> 0.98 (RTP 95% -> 98%)
--   * wheel-action:    winning payout ×1.01 (base tiers 96%/95%/95% -> 96.96%/95.95%/95.95%)
--   * crash-action:    EXCLUDED — the cash-out grace contract already lets a
--     perfectly-timed bot reach ≈98.1% RTP; any boost would tip Rakieta +EV.
--   * poker: excluded (player-vs-player; a boost would take coins from others).
-- Every boosted game stays below 100% RTP, so the item can never be used to
-- mint coins in expectation — the price is pure burn + entertainment.

-- ── Timed-item plumbing ─────────────────────────────────────────────────────
ALTER TABLE public.hero_item_defs
  ADD COLUMN IF NOT EXISTS duration_hours integer;

ALTER TABLE public.hero_item_defs DROP CONSTRAINT IF EXISTS hero_item_defs_duration_hours_check;
ALTER TABLE public.hero_item_defs ADD CONSTRAINT hero_item_defs_duration_hours_check
  CHECK (duration_hours IS NULL OR duration_hours > 0);

ALTER TABLE public.hero_item_instances
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- effect_game gains 'casino' (one item covering every solo house casino game).
ALTER TABLE public.hero_item_defs DROP CONSTRAINT IF EXISTS hero_item_defs_effect_game_check;
ALTER TABLE public.hero_item_defs ADD CONSTRAINT hero_item_defs_effect_game_check
  CHECK (effect_game IS NULL OR effect_game IN ('roulette','slots','whack_boss','bug_jumper','flappy_pants','snake','invoice_horde','var_patrol','egg_catch','poker','tavern','global','casino'));

-- ── The item ────────────────────────────────────────────────────────────────
INSERT INTO public.hero_item_defs
  (slug, name, emoji, slot, price, rarity, description, effect_game, effect_type, effect_value, sale_type, edition_size, visual_effect, is_active, duration_hours)
VALUES
  ('lucky_amulet', 'Amulet Bezwstydnego Fartu', '🍀', 'trinket', 10000, 'legendary',
   'Kupujesz dla całego biura! Ten bezwstydnie OP talizman sprawia, że przez 7 dni fortuna sprzyja WSZYSTKIM graczom w KAŻDEJ grze kasynowej — Sloty, Ruletka, Plinko, Miny, a nawet Rakieta. Kolejny zakup (kogokolwiek) przedłuża wspólny bonus o kolejne 7 dni.',
   'casino', 'casino_luck', 1, 'shop', null, null, true, 168)
ON CONFLICT (slug) DO UPDATE SET
  name           = EXCLUDED.name,
  emoji          = EXCLUDED.emoji,
  slot           = EXCLUDED.slot,
  price          = EXCLUDED.price,
  rarity         = EXCLUDED.rarity,
  description    = EXCLUDED.description,
  effect_game    = EXCLUDED.effect_game,
  effect_type    = EXCLUDED.effect_type,
  effect_value   = EXCLUDED.effect_value,
  sale_type      = EXCLUDED.sale_type,
  duration_hours = EXCLUDED.duration_hours,
  is_active      = EXCLUDED.is_active;

-- ── purchase_hero_item: timed defs queue onto the shared window ─────────────
-- Supersedes the copy in hero-items.sql. Permanent items behave exactly as
-- before. For defs with duration_hours the effect is COMMUNAL: the buyer's new
-- instance starts where the latest existing instance (anyone's) ends, so each
-- purchase adds exactly duration_hours to the shared buff window. The def row
-- is locked FOR UPDATE to serialize concurrent buys (two simultaneous buyers
-- must not both anchor on the same MAX(expires_at)).
CREATE OR REPLACE FUNCTION public.purchase_hero_item(p_item_slug text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_def public.hero_item_defs%ROWTYPE;
  v_instance public.hero_item_instances%ROWTYPE;
  v_coins_left integer;
  v_extended boolean := false;
  v_from timestamptz;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_def
    FROM public.hero_item_defs
   WHERE slug = p_item_slug
     AND is_active = true
     AND sale_type IN ('shop','both')
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;

  UPDATE public.profiles
     SET coins = coins - v_def.price
   WHERE id = v_user
     AND coins >= v_def.price
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  IF v_def.duration_hours IS NOT NULL THEN
    SELECT GREATEST(now(), COALESCE(MAX(expires_at), now())) INTO v_from
      FROM public.hero_item_instances
     WHERE item_def_id = v_def.id
       AND expires_at IS NOT NULL;
    v_extended := v_from > now();
    INSERT INTO public.hero_item_instances (item_def_id, owner_id, acquired_from, expires_at)
    VALUES (v_def.id, v_user, 'shop', v_from + make_interval(hours => v_def.duration_hours))
    RETURNING * INTO v_instance;
  ELSE
    INSERT INTO public.hero_item_instances (item_def_id, owner_id, acquired_from)
    VALUES (v_def.id, v_user, 'shop')
    RETURNING * INTO v_instance;
  END IF;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (
      v_user,
      -v_def.price,
      'hero_item_purchase',
      jsonb_build_object(
        'item_slug', v_def.slug,
        'item_name', v_def.name,
        'extended', v_extended,
        'expires_at', v_instance.expires_at
      )
    );
  END IF;

  RETURN json_build_object(
    'ok', true,
    'coins_left', v_coins_left,
    'instance_id', v_instance.id,
    'item_slug', v_def.slug,
    'extended', v_extended,
    'expires_at', v_instance.expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purchase_hero_item(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_hero_item(text) TO authenticated;

-- ── my_hero_inventory: expose expires_at, hide expired instances ────────────
-- Supersedes the copy in hero-items-always-active.sql (adds expires_at).
DROP VIEW IF EXISTS public.my_hero_inventory;
CREATE VIEW public.my_hero_inventory WITH (security_invoker = true) AS
SELECT
  i.id AS instance_id,
  i.owner_id,
  i.created_at,
  i.acquired_from,
  i.origin_label,
  i.serial_no,
  i.edition_size AS instance_edition_size,
  d.id AS item_def_id,
  d.slug,
  d.name,
  d.emoji,
  d.slot,
  d.price,
  d.rarity,
  d.description,
  d.effect_game,
  d.effect_type,
  d.effect_value,
  d.sale_type,
  d.visual_effect,
  d.duration_hours,
  i.expires_at
FROM public.hero_item_instances i
JOIN public.hero_item_defs d ON d.id = i.item_def_id
WHERE i.owner_id = auth.uid()
  AND (i.expires_at IS NULL OR i.expires_at > now());

GRANT SELECT ON public.my_hero_inventory TO authenticated;

-- ── hero_score_bonus: ignore expired timed items ────────────────────────────
-- Supersedes the copy in hero-items-always-active.sql. No timed item grants a
-- score_bonus today, but the view must stay correct if one ever does.
CREATE OR REPLACE VIEW public.hero_score_bonus AS
SELECT i.owner_id AS user_id, MAX(d.effect_value)::integer AS bonus
FROM public.hero_item_instances i
JOIN public.hero_item_defs d ON d.id = i.item_def_id
WHERE d.effect_type = 'score_bonus'
  AND d.is_active = true
  AND (i.expires_at IS NULL OR i.expires_at > now())
GROUP BY i.owner_id;

-- ── Roulette rescue rework (2026-07-12) ─────────────────────────────────────
-- roulette-action now pays win_chance_bonus rescues as a STAKE REFUND (capped
-- at the round's total stake, chance clamped to 1%) instead of full
-- multipliers, which made straight-number betting +32% EV. Sync the shop
-- descriptions here so prod picks them up without re-running hero-items.sql.
UPDATE public.hero_item_defs
   SET description = 'Dają małą szansę (1%) na zwrot całej stawki po przegranej w ruletce.'
 WHERE slug = 'lucky_trousers';
UPDATE public.hero_item_defs
   SET description = 'Daje szansę na zwrot stawki po przegranej w ruletce.'
 WHERE slug = 'fate_die';

-- ── Public shared-buff status ───────────────────────────────────────────────
-- hero_item_instances is own-row RLS, but the buff is communal, so everyone
-- needs to see when it ends. Definer view (no security_invoker) exposes ONLY
-- the aggregate end timestamp — no owner data leaks.
CREATE OR REPLACE VIEW public.casino_luck_status AS
SELECT MAX(i.expires_at) AS active_until
FROM public.hero_item_instances i
JOIN public.hero_item_defs d ON d.id = i.item_def_id
WHERE d.effect_type = 'casino_luck'
  AND d.is_active = true
  AND i.expires_at IS NOT NULL
  AND i.expires_at > now();

GRANT SELECT ON public.casino_luck_status TO anon, authenticated;

-- ── Daily purge of expired instances ────────────────────────────────────────
-- Removing the row is what makes net worth (user_assets_value counts owned
-- hero_item_instances at def price) stop counting a consumed buff; the Edge
-- Functions filter on expires_at directly, so the ≤24h gap is display-only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
      FROM cron.job WHERE jobname = 'hero_item_expiry_cleanup';
    PERFORM cron.schedule(
      'hero_item_expiry_cleanup',
      '20 3 * * *',
      $job$DELETE FROM public.hero_item_instances WHERE expires_at IS NOT NULL AND expires_at < now()$job$
    );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
