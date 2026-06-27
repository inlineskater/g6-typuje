-- Plinko G6 support for Rynek Proroctw G6.
-- Solo house casino game: the Edge Function resolves each drop server-side,
-- then the frontend animates the trusted path/result.
--
-- Like slots/roulette/mines/crash this is a HOUSE game: coins move directly on
-- profiles.coins (no coin_transactions ledger); house P&L is reconstructed from
-- plinko_spins by hazard/economy views. All writes go through plinko-action.
--
-- Run after supabase/schema.sql on an existing project. Idempotent.

CREATE TABLE IF NOT EXISTS public.plinko_spins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bet         integer NOT NULL CHECK (bet > 0),
  rows        integer NOT NULL CHECK (rows IN (8, 12, 16)),
  risk        text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  path        jsonb NOT NULL DEFAULT '[]'::jsonb,
  bucket      integer NOT NULL CHECK (bucket >= 0),
  multiplier  numeric(12,2) NOT NULL CHECK (multiplier >= 0),
  total_won   integer NOT NULL DEFAULT 0 CHECK (total_won >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plinko_spins_user_time_idx
  ON public.plinko_spins(user_id, created_at DESC);

ALTER TABLE public.plinko_spins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "plinko_spins_select_own" ON public.plinko_spins;
CREATE POLICY "plinko_spins_select_own" ON public.plinko_spins
  FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.plinko_spins FROM anon, authenticated;
GRANT SELECT ON public.plinko_spins TO authenticated;

NOTIFY pgrst, 'reload schema';
