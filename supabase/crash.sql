-- „Rakieta" (Crash) support for Rynek Proroctw G6.
-- A shared multiplayer house game: one rocket per round, the multiplier climbs from
-- x1.00, every player bets the same round and taps CASH OUT to lock their multiplier
-- before the rocket explodes at a hidden, server-owned crash point.
--
-- Like slots/roulette this is a HOUSE game: coins move directly on profiles.coins
-- (no coin_transactions ledger); house P&L is reconstructed from crash_spins by
-- economy_stats() (hazard_house_net). All writes go through the crash-action Edge
-- Function (service role) — clients have SELECT only.
--
-- Run after supabase/schema.sql on an existing project. Idempotent.

-- ── Singleton table (the FOR UPDATE concurrency lock row + round chain pointer) ──
CREATE TABLE IF NOT EXISTS public.crash_tables (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text UNIQUE NOT NULL DEFAULT 'main',
  round_no         integer NOT NULL DEFAULT 0 CHECK (round_no >= 0),
  current_round_id uuid,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ── Public rounds (world-readable lobby). crash_point stays NULL until 'crashed'. ──
CREATE TABLE IF NOT EXISTS public.crash_rounds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id        uuid NOT NULL REFERENCES public.crash_tables(id) ON DELETE CASCADE,
  round_no        integer NOT NULL CHECK (round_no > 0),
  status          text NOT NULL DEFAULT 'betting' CHECK (status IN ('betting','running','crashed')),
  betting_ends_at timestamptz,
  started_at      timestamptz,
  crash_point     numeric(12,2) CHECK (crash_point IS NULL OR crash_point >= 1),
  crashed_at      timestamptz,
  total_bet       integer NOT NULL DEFAULT 0 CHECK (total_bet >= 0),
  total_won       integer NOT NULL DEFAULT 0 CHECK (total_won >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, round_no)
);

-- ── Service-only secret: hidden crash point + crash timestamp for a running round.
--    NEVER granted to clients — that is the entire fairness boundary. ──
CREATE TABLE IF NOT EXISTS public.crash_round_secrets (
  round_id    uuid PRIMARY KEY REFERENCES public.crash_rounds(id) ON DELETE CASCADE,
  crash_point numeric(12,2) NOT NULL CHECK (crash_point >= 1),
  crash_at    timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Live bets for the current round (one per user per round). World-readable. ──
CREATE TABLE IF NOT EXISTS public.crash_bets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id         uuid NOT NULL REFERENCES public.crash_rounds(id) ON DELETE CASCADE,
  table_id         uuid NOT NULL REFERENCES public.crash_tables(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot    text NOT NULL,
  amount           integer NOT NULL CHECK (amount > 0),
  cashed_multiplier numeric(12,2) CHECK (cashed_multiplier IS NULL OR cashed_multiplier >= 1),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cashed','busted')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, user_id)
);

-- ── Immutable per-player history written at resolve (like slots_spins). SELECT own. ──
CREATE TABLE IF NOT EXISTS public.crash_spins (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  round_id          uuid REFERENCES public.crash_rounds(id) ON DELETE SET NULL,
  total_bet         integer NOT NULL CHECK (total_bet > 0),
  cashout_multiplier numeric(12,2) CHECK (cashout_multiplier IS NULL OR cashout_multiplier >= 1),
  total_won         integer NOT NULL DEFAULT 0 CHECK (total_won >= 0),
  crash_point       numeric(12,2) NOT NULL CHECK (crash_point >= 1),
  item_effect       jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crash_spins_user_time_idx
  ON public.crash_spins(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crash_spins_round_idx
  ON public.crash_spins(round_id);
CREATE INDEX IF NOT EXISTS crash_rounds_table_time_idx
  ON public.crash_rounds(table_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crash_rounds_status_idx
  ON public.crash_rounds(status);
CREATE INDEX IF NOT EXISTS crash_bets_round_idx
  ON public.crash_bets(round_id, created_at);
CREATE INDEX IF NOT EXISTS crash_bets_user_idx
  ON public.crash_bets(user_id, created_at DESC);

INSERT INTO public.crash_tables (slug)
VALUES ('main')
ON CONFLICT (slug) DO NOTHING;

-- ── RLS ──
ALTER TABLE public.crash_tables        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_rounds        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_round_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_bets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_spins         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crash_tables_select" ON public.crash_tables;
CREATE POLICY "crash_tables_select" ON public.crash_tables
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "crash_rounds_select" ON public.crash_rounds;
CREATE POLICY "crash_rounds_select" ON public.crash_rounds
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "crash_bets_select" ON public.crash_bets;
CREATE POLICY "crash_bets_select" ON public.crash_bets
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "crash_spins_select_own" ON public.crash_spins;
CREATE POLICY "crash_spins_select_own" ON public.crash_spins
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- crash_round_secrets: no policy at all → no client can read the hidden crash point.

-- ── Grants: clients read public tables only; secrets fully revoked. ──
REVOKE ALL ON public.crash_tables, public.crash_rounds, public.crash_round_secrets,
              public.crash_bets, public.crash_spins
  FROM anon, authenticated;

GRANT SELECT ON public.crash_tables, public.crash_rounds, public.crash_bets, public.crash_spins
  TO authenticated;
-- (crash_round_secrets is intentionally NOT granted.)

-- ── Realtime publication: public lobby tables only (never secrets / private spins). ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'crash_tables'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.crash_tables;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'crash_rounds'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.crash_rounds;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'crash_bets'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.crash_bets;
    END IF;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
