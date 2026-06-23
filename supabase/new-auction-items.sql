-- ═══════════════════════════════════════════════════════════════════
-- Three new legendary auction items — auctions close 2026-05-27 12:00 Warsaw (10:00 UTC)
-- Run this in the Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════

-- ── 0. Loosen effect_game constraint to allow 'global' ──────────────

ALTER TABLE public.hero_item_defs ALTER COLUMN effect_game DROP NOT NULL;

ALTER TABLE public.hero_item_defs DROP CONSTRAINT IF EXISTS hero_item_defs_effect_game_check;
ALTER TABLE public.hero_item_defs ADD CONSTRAINT hero_item_defs_effect_game_check
  CHECK (effect_game IS NULL OR effect_game IN ('roulette','slots','whack_boss','bug_jumper','flappy_pants','snake','invoice_horde','var_patrol','poker','tavern','global'));


-- ── 1. Item definitions ─────────────────────────────────────────────

INSERT INTO public.hero_item_defs
  (slug, name, emoji, slot, price, rarity, description, effect_game, effect_type, effect_value, sale_type, edition_size, visual_effect)
VALUES
  -- Banker's Ring: 2% daily interest on coin balance while equipped
  ('interest_ring', 'Pierścień Bankiera', '💍', 'trinket', 0, 'legendary',
   'Twoje monety pracują na Ciebie. +2% dziennie od aktualnego salda, dopóki pierścień jest założony.',
   null, 'daily_interest', 2, 'auction', 1, null),

  -- Kaiser's Golden Helmet: +5 Whack-a-Boss score + dramatic gold aura visible to all
  ('kaiser_helm', 'Złoty Hełm Kaisera', '🪖', 'head', 0, 'legendary',
   'Pruski szczyt inżynierii militarnej z litego złota. Zlatuje na głowie i świeci jak słońce w całej karczmie.',
   'whack_boss', 'score_bonus', 5, 'auction', 1, 'kaiser_glow'),

  -- Analyst's Glasses: shows live win-% in poker (same Monte Carlo the admin sees)
  ('poker_glasses', 'Okulary Analityka', '🕶️', 'head', 0, 'legendary',
   'Zaawansowana optyka hazardzisty. Pokazuje matematyczną szansę wygranej przy każdym rozdaniu — tak jak widzi to admin.',
   'poker', 'odds_view', 1, 'auction', 1, null)

ON CONFLICT (slug) DO UPDATE SET
  name          = EXCLUDED.name,
  emoji         = EXCLUDED.emoji,
  description   = EXCLUDED.description,
  effect_game   = EXCLUDED.effect_game,
  effect_type   = EXCLUDED.effect_type,
  effect_value  = EXCLUDED.effect_value,
  sale_type     = EXCLUDED.sale_type,
  edition_size  = EXCLUDED.edition_size,
  visual_effect = EXCLUDED.visual_effect;


-- ── 2. Auctions — ends Wednesday 2026-05-27 12:00 Warsaw = 10:00 UTC ──

INSERT INTO public.hero_item_auctions
  (item_def_id, created_by, start_price, min_increment, starts_at, ends_at)
SELECT
  hid.id,
  p.id,
  start_price,
  50,
  now(),
  '2026-05-27T10:00:00Z'
FROM (VALUES
  ('interest_ring', 1),
  ('kaiser_helm',   1),
  ('poker_glasses', 1)
) AS v(slug, start_price)
JOIN public.hero_item_defs hid ON hid.slug = v.slug
CROSS JOIN (SELECT id FROM public.profiles WHERE is_admin LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM public.hero_item_auctions a
  WHERE a.item_def_id = hid.id AND a.status = 'open'
)
  AND now() < '2026-05-27T10:00:00Z'::timestamptz;


-- ── 3. Daily interest cron ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.hero_daily_interest_awards (
  award_date       date NOT NULL,
  user_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_instance_id uuid NOT NULL REFERENCES public.hero_item_instances(id) ON DELETE CASCADE,
  amount           integer NOT NULL CHECK (amount > 0),
  awarded_at       timestamptz NOT NULL DEFAULT now(),
  logged_at        timestamptz,
  PRIMARY KEY (award_date, item_instance_id)
);

ALTER TABLE public.hero_daily_interest_awards
  ADD COLUMN IF NOT EXISTS logged_at timestamptz;

ALTER TABLE public.hero_daily_interest_awards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hero_daily_interest_awards_select" ON public.hero_daily_interest_awards;
CREATE POLICY "hero_daily_interest_awards_select" ON public.hero_daily_interest_awards
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.hero_daily_interest_awards FROM anon, authenticated;
GRANT SELECT ON public.hero_daily_interest_awards TO authenticated;

DROP FUNCTION IF EXISTS public.award_daily_interest();

CREATE OR REPLACE FUNCTION public.award_daily_interest()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_award_date date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_count integer := 0;
  v_total integer := 0;
BEGIN
  WITH eligible AS (
    SELECT
      p.id AS user_id,
      hii.id AS item_instance_id,
      GREATEST(1, FLOOR(p.coins * 0.02)::integer) AS amount
    FROM public.profiles p
    JOIN public.hero_equipment he ON he.user_id = p.id
    JOIN public.hero_item_instances hii ON hii.id = he.item_instance_id AND hii.owner_id = p.id
    JOIN public.hero_item_defs hid ON hid.id = hii.item_def_id
    WHERE hid.slug = 'interest_ring'
      AND hid.is_active = true
  ),
  inserted AS (
    INSERT INTO public.hero_daily_interest_awards (award_date, user_id, item_instance_id, amount)
    SELECT v_award_date, user_id, item_instance_id, amount
    FROM eligible
    ON CONFLICT DO NOTHING
    RETURNING user_id, item_instance_id, amount
  ),
  credited AS (
    UPDATE public.profiles p
       SET coins = p.coins + i.amount
      FROM inserted i
     WHERE p.id = i.user_id
     RETURNING i.user_id, i.item_instance_id, i.amount
  )
  SELECT COUNT(*)::integer, COALESCE(SUM(amount), 0)::integer
    INTO v_count, v_total
  FROM credited;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    SELECT
      a.user_id,
      a.amount,
      'daily_interest',
      jsonb_build_object('item_instance_id', a.item_instance_id, 'award_date', v_award_date)
    FROM public.hero_daily_interest_awards a
    WHERE a.award_date = v_award_date
      AND a.logged_at IS NULL;

    UPDATE public.hero_daily_interest_awards
       SET logged_at = now()
     WHERE award_date = v_award_date
       AND logged_at IS NULL;
  END IF;

  RETURN json_build_object('ok', true, 'award_date', v_award_date, 'awards_created', v_count, 'coins_awarded', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.award_daily_interest() FROM PUBLIC, anon, authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Runs every day at 08:00 UTC. Idempotent — safe to re-run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule(jobname)
    FROM cron.job
    WHERE jobname = 'daily-interest';

    PERFORM cron.schedule(
      'daily-interest',
      '0 8 * * *',
      $cron$SELECT public.award_daily_interest();$cron$
    );
  END IF;
END;
$$;
