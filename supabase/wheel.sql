-- Koło Fortuny G6 support for Rynek Proroctw G6.
-- Solo house casino game: the Edge Function draws the winning segment
-- server-side, then the frontend plays a decelerating spin animation that
-- lands exactly on the server's segment.
--
-- Like slots/roulette/plinko/mines/crash this is a HOUSE game: coins move
-- directly on profiles.coins (no coin_transactions ledger); house P&L is
-- reconstructed from wheel_spins by hazard/economy views. All writes go
-- through wheel-action.
--
-- Run after supabase/schema.sql on an existing project. Idempotent.

CREATE TABLE IF NOT EXISTS public.wheel_spins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  total_bet      integer NOT NULL CHECK (total_bet > 0),
  risk           text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  segment_index  integer NOT NULL CHECK (segment_index BETWEEN 0 AND 19),
  multiplier     numeric(12,2) NOT NULL,
  total_won      integer NOT NULL DEFAULT 0,
  created_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wheel_spins_user_time_idx
  ON public.wheel_spins(user_id, created_at DESC);

ALTER TABLE public.wheel_spins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wheel_spins_select_own" ON public.wheel_spins;
CREATE POLICY "wheel_spins_select_own" ON public.wheel_spins
  FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.wheel_spins FROM anon, authenticated;
GRANT SELECT ON public.wheel_spins TO authenticated;

NOTIFY pgrst, 'reload schema';
