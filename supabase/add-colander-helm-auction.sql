-- ═══════════════════════════════════════════════════════════════════
-- Bojowy Durszlak — epic head item, +4 score in every seasonal game
-- (same cross-game score_bonus mechanism as kaiser_helm).
-- Auction closes 2026-06-11 15:00 Warsaw (13:00 UTC).
-- Paste into the Supabase SQL Editor → Run.
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO public.hero_item_defs
  (slug, name, emoji, slot, price, rarity, description, effect_game, effect_type, effect_value, sale_type, edition_size, visual_effect)
VALUES
  ('combat_colander', 'Bojowy Durszlak', '🍝', 'head', 0, 'epic',
   'Kuchenny weteran tysiąca obiadów. Odcedza porażki i zostawia same punkty — +4 do wyniku w każdej grze sezonowej. Makaron niewliczony w cenę.',
   'whack_boss', 'score_bonus', 4, 'auction', 1, null)
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

INSERT INTO public.hero_item_auctions
  (item_def_id, created_by, start_price, min_increment, starts_at, ends_at)
SELECT
  hid.id,
  p.id,
  1,
  1,
  now(),
  '2026-06-11T13:00:00Z'
FROM public.hero_item_defs hid
CROSS JOIN (SELECT id FROM public.profiles WHERE is_admin LIMIT 1) p
WHERE hid.slug = 'combat_colander'
  AND NOT EXISTS (
    SELECT 1 FROM public.hero_item_auctions a
    WHERE a.item_def_id = hid.id AND a.status = 'open'
  )
  AND now() < '2026-06-11T13:00:00Z'::timestamptz;
