-- Roulette support for Rynek Proroctw G6.
-- Run after supabase/schema.sql on an existing project.

CREATE TABLE IF NOT EXISTS public.roulette_spins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bets          jsonb NOT NULL,
  result_number integer NOT NULL CHECK (result_number BETWEEN 0 AND 36),
  result_color  text NOT NULL CHECK (result_color IN ('red','black','green')),
  total_bet     integer NOT NULL CHECK (total_bet > 0),
  total_won     integer NOT NULL DEFAULT 0 CHECK (total_won >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS roulette_spins_user_time_idx
  ON public.roulette_spins(user_id, created_at DESC);

ALTER TABLE public.roulette_spins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "roulette_spins_select_own" ON public.roulette_spins;
CREATE POLICY "roulette_spins_select_own" ON public.roulette_spins
  FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.roulette_spins FROM anon, authenticated;
GRANT SELECT ON public.roulette_spins TO authenticated;

NOTIFY pgrst, 'reload schema';
