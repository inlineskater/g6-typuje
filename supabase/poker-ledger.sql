-- Poker ledger for tracking buy-ins and cashouts.
-- Run after supabase/poker.sql on an existing project.

CREATE TABLE IF NOT EXISTS public.poker_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  type          text NOT NULL CHECK (type IN ('buy_in','cashout')),
  amount        integer NOT NULL CHECK (amount > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS poker_ledger_user_time_idx
  ON public.poker_ledger(user_id, created_at DESC);

ALTER TABLE public.poker_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "poker_ledger_select" ON public.poker_ledger;
CREATE POLICY "poker_ledger_select" ON public.poker_ledger
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.poker_ledger FROM anon, authenticated;
GRANT SELECT ON public.poker_ledger TO authenticated;

NOTIFY pgrst, 'reload schema';
