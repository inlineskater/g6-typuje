-- Reset game state while keeping user accounts/profiles.
-- Run in Supabase SQL Editor with database-owner privileges.

BEGIN;

TRUNCATE TABLE public.trades, public.markets RESTART IDENTITY CASCADE;

DO $$
BEGIN
  IF to_regclass('public.poker_tables') IS NOT NULL THEN
    TRUNCATE TABLE public.poker_events,
                   public.poker_player_cards,
                   public.poker_hands,
                   public.poker_seats,
                   public.poker_tables
      RESTART IDENTITY CASCADE;

    INSERT INTO public.poker_tables (slug)
    VALUES ('main')
    ON CONFLICT (slug) DO NOTHING;
  END IF;
END;
$$;

UPDATE public.profiles
SET coins = 1000;

COMMIT;
