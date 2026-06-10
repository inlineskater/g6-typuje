-- Adds the "Żappsy z aplikacji Żappka" reward to the Sklep (store).
-- Run once in the Supabase SQL Editor (Dashboard → SQL Editor → Run).
--
-- 100 coins each, two available (max_slots = 2). The store grid is ordered by
-- created_at DESC, so we stamp created_at one second before the McDonald's item
-- to place this card right after it. Falls back to now() if that item is gone.

INSERT INTO public.store_items (title, description, price, max_slots, created_by, created_at)
SELECT
  '🐸 Żappsy z aplikacji Żappka',
  'Żappsy z aplikacji Żappka o wartości 100 coinów. Po zakupie admin zrobi Ci przelew Żappsów na Twój numer telefonu.',
  100,
  2,
  (SELECT id FROM public.profiles WHERE nick = 'admin' LIMIT 1),
  COALESCE(
    (SELECT created_at - interval '1 second'
       FROM public.store_items
      WHERE title = '🍟 Moja Nagroda z McDonald''s'
      ORDER BY created_at DESC
      LIMIT 1),
    now()
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.store_items WHERE title = '🐸 Żappsy z aplikacji Żappka'
);
