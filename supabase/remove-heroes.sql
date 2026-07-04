-- Remove the heroes cosmetic system (user_heroes + save_hero + tavern).
-- Hero ITEMS stay fully functional: hero_item_defs / hero_item_instances /
-- hero_equipment / hero_item_auctions / hero_item_auction_bids, all item RPCs,
-- the my_hero_inventory / public_hero_equipment / hero_item_auction_cards views,
-- the hero_score_bonus view, and the Edge Function effect queries are untouched.
-- The equip UI moves to the Ogródek hub (🎒 Mój Majątek) in index.html.
--
-- Idempotent. Run in the Supabase SQL Editor AFTER the frontend deploy that
-- removes the ⚔️ Herosi tab (the old frontend reads user_heroes).

-- 1) Drop user_heroes from the realtime publication (if present)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'user_heroes'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.user_heroes;
  END IF;
END $$;

-- 2) Drop the appearance RPC
DROP FUNCTION IF EXISTS public.save_hero(text,text,text,text,text,text,text,text,text);

-- 3) Drop the heroes table (policies and indexes go with it)
DROP TABLE IF EXISTS public.user_heroes;

-- 4) Tavern-only cosmetic items (gold aura, cloak, disco, coin sparkle,
--    fire trail, loud speech) lose their venue with the tavern gone.
--    Owners keep them, they stay auctionable and net-worth-valued,
--    but they are no longer sold in the shop.
UPDATE public.hero_item_defs
   SET sale_type = 'auction'
 WHERE effect_game = 'tavern'
   AND sale_type IN ('shop','both');

-- Note: the historical coin_transactions reason 'hero_appearance_change'
-- stays valid — economy-stats.sql keeps counting it among burn reasons.

NOTIFY pgrst, 'reload schema';
