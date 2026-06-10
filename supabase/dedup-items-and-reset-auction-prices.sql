-- Deactivate duplicate shop items (keep cheapest per game/effect)
-- and reset all open auction start prices to 1.
-- Paste into Supabase SQL Editor → Run.

-- 1. Deactivate duplicate items
UPDATE public.hero_item_defs
SET is_active = false
WHERE slug IN (
  'g6_magnet',          -- slots +2 (duplicate of luck_brooch +1)
  'fate_die',           -- roulette win_chance +1 (duplicate of lucky_trousers +1)
  'fortune_eye',        -- roulette win_chance +2 (stronger duplicate)
  'turbo_gloves',       -- whack_boss +2 (duplicate of reflex_gloves +1)
  'rocket_boots',       -- bug_jumper +2 (duplicate of jumper_boots +1)
  'bluff_vest',         -- poker buy_in +15 (duplicate of bluff_dagger +10)
  'golden_bluff_dagger' -- poker buy_in +25 (stronger duplicate)
);

-- 2. Reset all open auction start prices to 1
UPDATE public.hero_item_auctions
SET start_price = 1
WHERE status = 'open';
