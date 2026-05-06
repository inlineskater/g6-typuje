-- Reset game state while keeping user accounts/profiles.
-- Run in Supabase SQL Editor with database-owner privileges.

BEGIN;

TRUNCATE TABLE public.trades, public.markets RESTART IDENTITY CASCADE;

UPDATE public.profiles
SET coins = 1000;

COMMIT;
