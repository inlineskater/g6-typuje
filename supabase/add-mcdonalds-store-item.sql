-- Adds the "Moja Nagroda z McDonald's" reward to the Sklep (store).
-- Run once in the Supabase SQL Editor (Dashboard → SQL Editor → Run).
--
-- The store grid is ordered by created_at DESC (newest first). To place this
-- card right next to the Pizza Friday Ticket, we stamp created_at one second
-- before the pizza item so the new card renders immediately after it.
-- If no pizza item exists, it falls back to now() (top of the grid).

INSERT INTO public.store_items (title, description, price, max_slots, created_by, created_at)
SELECT
  '🍟 Moja Nagroda z McDonald''s',
  'Nagroda z aplikacji McDonald''s o wartości 250 coinów — np. sos Big Mac lub sos śmietanowy. Admin poda Ci kod, gdy będziesz na miejscu w McDonald''s.',
  250,
  1,
  (SELECT id FROM public.profiles WHERE is_admin LIMIT 1),
  COALESCE(
    (SELECT created_at - interval '1 second'
       FROM public.store_items
      WHERE title ILIKE '%pizza%'
      ORDER BY created_at DESC
      LIMIT 1),
    now()
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.store_items WHERE title = '🍟 Moja Nagroda z McDonald''s'
);
