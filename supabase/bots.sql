-- Run once in Supabase SQL Editor to enable bot seats.
-- Safe to re-run (all statements are idempotent).

-- Allow NULL user_id on seats (bot seats have no real user).
ALTER TABLE public.poker_seats
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS is_bot  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bot_nick TEXT;

-- Allow NULL user_id on hole-card records (bot cards have no real user).
ALTER TABLE public.poker_player_cards
  ALTER COLUMN user_id DROP NOT NULL;
