-- ═══════════════════════════════════════════════════════════════════
-- Three new legendary auction items — auctions close 2026-05-27 12:00 Warsaw (10:00 UTC)
-- Run this in the Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════

-- ── 0. Loosen effect_game constraint to allow 'global' ──────────────

ALTER TABLE public.hero_item_defs ALTER COLUMN effect_game DROP NOT NULL;

ALTER TABLE public.hero_item_defs DROP CONSTRAINT IF EXISTS hero_item_defs_effect_game_check;
ALTER TABLE public.hero_item_defs ADD CONSTRAINT hero_item_defs_effect_game_check
  CHECK (effect_game IS NULL OR effect_game IN ('roulette','slots','whack_boss','bug_jumper','poker','tavern','global'));


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
  ('interest_ring', 300),
  ('kaiser_helm',   400),
  ('poker_glasses', 500)
) AS v(slug, start_price)
JOIN public.hero_item_defs hid ON hid.slug = v.slug
CROSS JOIN (SELECT id FROM public.profiles WHERE nick = 'admin' LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM public.hero_item_auctions a
  WHERE a.item_def_id = hid.id AND a.status = 'active'
);


-- ── 3. Daily interest cron ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.award_daily_interest()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.profiles p
  SET coins = p.coins + GREATEST(1, FLOOR(p.coins * 0.02)::integer)
  FROM public.hero_equipment he
  JOIN public.hero_item_instances hii ON hii.id = he.item_instance_id
  JOIN public.hero_item_defs hid       ON hid.id = hii.item_def_id
  WHERE hid.slug   = 'interest_ring'
    AND hii.owner_id = p.id
    AND he.user_id   = p.id;
END;
$$;

-- Runs every day at 08:00 UTC. Idempotent — safe to re-run.
SELECT cron.unschedule('daily-interest') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'daily-interest'
);
SELECT cron.schedule('daily-interest', '0 8 * * *', 'SELECT public.award_daily_interest()');
