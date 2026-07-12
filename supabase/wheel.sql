-- Koło Fortuny G6 support for Rynek Proroctw G6.
-- SHARED-ROUNDS house casino game: there is ONE communal wheel with a SINGLE
-- ordered set of 20 segments (no risk tiers — every player spins the same
-- wheel; a bet is just a stake). A round opens betting the moment the first
-- player bets, runs a 15 s betting window (WHEEL_BETTING_WINDOW_MS in
-- wheel-action), then draws ONE segment_index server-side and pays EVERY bet
-- on that round by that one shared multiplier. Coin timing follows the
-- ROULETTE convention: nothing is deducted at bet time, only validated —
-- coins move only at resolve. Resolution is lazy on read, crash-style
-- (resolveDueRound runs on every state/bet call, so the 1 s client poll on
-- `state` is what actually triggers a due spin).
--
-- Like slots/roulette/plinko/mines/crash this is a HOUSE game: coins move
-- directly on profiles.coins (no coin_transactions ledger); house P&L is
-- reconstructed from wheel_spins by hazard/economy views. wheel_spins keeps
-- its original per-player-result shape (minus the now-removed `risk` column)
-- — every resolved bet still writes exactly one wheel_spins row, so
-- hazard-views/coin-inflow-stats/economy-stats need no changes. All writes
-- go through wheel-action.
--
-- Run after supabase/schema.sql on an existing project. Idempotent.

CREATE TABLE IF NOT EXISTS public.wheel_spins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  total_bet      integer NOT NULL CHECK (total_bet > 0),
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

-- ════════════════════════════════════════════════════════════════════════════
--  Shared rounds — the communal wheel and its bets
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.wheel_rounds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status         text NOT NULL DEFAULT 'betting' CHECK (status IN ('betting', 'resolved')),
  spin_at        timestamptz NOT NULL,
  segment_index  integer CHECK (segment_index BETWEEN 0 AND 19), -- NULL until resolved
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Defensive belt-and-braces (not strictly required by the "insert IS the
-- lock" pattern in wheel-action, but cheap insurance against the rare
-- interleave where two concurrent `bet` calls both see no open round and
-- both try to create one): at most one row may ever be 'betting' at a time.
-- wheel-action retries its SELECT on a 23505 unique violation here.
CREATE UNIQUE INDEX IF NOT EXISTS wheel_rounds_single_betting_idx
  ON public.wheel_rounds (status) WHERE status = 'betting';

CREATE INDEX IF NOT EXISTS wheel_rounds_resolved_time_idx
  ON public.wheel_rounds (resolved_at DESC) WHERE status = 'resolved';

CREATE TABLE IF NOT EXISTS public.wheel_round_bets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id      uuid NOT NULL REFERENCES public.wheel_rounds(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  total_bet     integer NOT NULL CHECK (total_bet > 0),
  multiplier    numeric(12,2), -- NULL until the round resolves
  total_won     integer,       -- NULL until the round resolves
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, user_id) -- one bet per player per round
);

CREATE INDEX IF NOT EXISTS wheel_round_bets_round_idx
  ON public.wheel_round_bets(round_id, created_at);

CREATE INDEX IF NOT EXISTS wheel_round_bets_user_idx
  ON public.wheel_round_bets(user_id, created_at DESC);

ALTER TABLE public.wheel_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wheel_round_bets ENABLE ROW LEVEL SECURITY;

-- Communal, like roulette_rounds/roulette_bets: every authenticated player
-- can see the open round and every bet in it (that's the shared spectacle).
DROP POLICY IF EXISTS "wheel_rounds_select" ON public.wheel_rounds;
CREATE POLICY "wheel_rounds_select" ON public.wheel_rounds
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "wheel_round_bets_select" ON public.wheel_round_bets;
CREATE POLICY "wheel_round_bets_select" ON public.wheel_round_bets
  FOR SELECT TO authenticated USING (true);

-- No client writes anywhere — the Edge Function owns every round/bet mutation
-- via its service SUPABASE_DB_URL connection.
REVOKE ALL ON public.wheel_rounds, public.wheel_round_bets FROM anon, authenticated;
GRANT SELECT ON public.wheel_rounds, public.wheel_round_bets TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'wheel_rounds'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.wheel_rounds;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'wheel_round_bets'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.wheel_round_bets;
    END IF;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
