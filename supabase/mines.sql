-- „Miny G6" support for Rynek Proroctw G6.
-- A single-player house game inspired by the common casino Mines mechanic:
-- pick a stake + mine count, reveal safe tiles, then cash out before hitting a mine.
--
-- Like slots/roulette this is a HOUSE game: coins move directly on profiles.coins
-- (no coin_transactions ledger); house P&L is reconstructed from mines_spins.
-- All writes go through the mines-action Edge Function (service role).
--
-- Run after supabase/schema.sql on an existing project. Idempotent.

CREATE TABLE IF NOT EXISTS public.mines_rounds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bet                integer NOT NULL CHECK (bet > 0),
  mine_count         integer NOT NULL CHECK (mine_count BETWEEN 1 AND 24),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cashed','busted')),
  revealed_tiles     jsonb NOT NULL DEFAULT '[]'::jsonb,
  safe_revealed      integer NOT NULL DEFAULT 0 CHECK (safe_revealed BETWEEN 0 AND 24),
  current_multiplier numeric(12,2) NOT NULL DEFAULT 1 CHECK (current_multiplier >= 0),
  total_won          integer NOT NULL DEFAULT 0 CHECK (total_won >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);

CREATE TABLE IF NOT EXISTS public.mines_round_secrets (
  round_id   uuid PRIMARY KEY REFERENCES public.mines_rounds(id) ON DELETE CASCADE,
  mine_tiles jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mines_spins (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  round_id           uuid REFERENCES public.mines_rounds(id) ON DELETE SET NULL,
  bet                integer NOT NULL CHECK (bet > 0),
  mine_count         integer NOT NULL CHECK (mine_count BETWEEN 1 AND 24),
  safe_revealed      integer NOT NULL DEFAULT 0 CHECK (safe_revealed BETWEEN 0 AND 24),
  final_multiplier   numeric(12,2) NOT NULL DEFAULT 0 CHECK (final_multiplier >= 0),
  total_won          integer NOT NULL DEFAULT 0 CHECK (total_won >= 0),
  result             text NOT NULL CHECK (result IN ('cashout','auto_cashout','bust')),
  revealed_tiles     jsonb NOT NULL DEFAULT '[]'::jsonb,
  mine_tiles         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mines_rounds_one_active_per_user_idx
  ON public.mines_rounds(user_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS mines_rounds_user_time_idx
  ON public.mines_rounds(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mines_spins_user_time_idx
  ON public.mines_spins(user_id, created_at DESC);

ALTER TABLE public.mines_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mines_round_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mines_spins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mines_rounds_select_own" ON public.mines_rounds;
CREATE POLICY "mines_rounds_select_own" ON public.mines_rounds
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "mines_spins_select_own" ON public.mines_spins;
CREATE POLICY "mines_spins_select_own" ON public.mines_spins
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- mines_round_secrets: no policy at all; clients never see active mine positions.

REVOKE ALL ON public.mines_rounds, public.mines_round_secrets, public.mines_spins
  FROM anon, authenticated;

GRANT SELECT ON public.mines_rounds, public.mines_spins TO authenticated;

NOTIFY pgrst, 'reload schema';
