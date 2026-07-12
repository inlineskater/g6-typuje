-- Hides six early, low-impact hero items from the Sklep purchase catalog
-- without touching anyone who already owns one — the effect keeps applying
-- (is_active stays true, only sale_type changes), it just can't be bought
-- fresh anymore. Mirrors the sale_type='hidden' path hero-items.sql already
-- uses for one-off cosmetics. Idempotent: safe to re-run.
--
-- loadHeroItemCatalog() in index.html filters .in('sale_type', ['shop','both']),
-- so 'hidden' drops a def out of renderHeroShopGrid() while my_hero_inventory
-- (owner_id-scoped, no sale_type filter) keeps showing it for existing owners.

UPDATE public.hero_item_defs
   SET sale_type = 'hidden'
 WHERE slug IN (
   'dealer_hat',      -- Kapelusz Krupiera
   'luck_brooch',     -- Broszka Farta
   'reflex_gloves',   -- Rękawice Refleksu
   'jumper_boots',    -- Buty Skoczka
   'bluff_dagger',    -- Sztylet Blefu
   'lucky_trousers'   -- Szczęśliwe Majtki
 )
   AND sale_type <> 'hidden';

NOTIFY pgrst, 'reload schema';
