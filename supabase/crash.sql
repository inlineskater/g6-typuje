-- „Rakieta" (Crash) — SOLO, server-owned house game for Rynek Proroctw G6.
-- Each player flies their OWN rocket: press Postaw → the multiplier climbs from x1.00 →
-- tap WYPŁAĆ to lock it before the rocket explodes at a hidden, server-owned crash point.
-- Mirrors the solo Miny/Plinko model: one round per player, no shared table, no realtime.
--
-- HOUSE game: coins move directly on profiles.coins (no coin_transactions ledger);
-- house P&L is reconstructed from crash_spins by economy_stats() (hazard_house_net).
-- All writes go through the crash-action Edge Function (service role) — clients SELECT only.
--
-- Run after supabase/schema.sql. Idempotent. NOTE: this DROPS the legacy shared-table
-- crash_tables/crash_bets and redefines crash_rounds for the solo model. Run it when nobody
-- is mid-flight (a legacy in-flight bet is forfeited — its coins were already deducted).
-- crash_spins history is PRESERVED (only its round_id link to old rounds is cleared).

-- ── Drop the shared-multiplayer machinery (crash state is ephemeral). CASCADE also
--    removes these tables from the realtime publication and drops dependent FKs. The
--    solo crash_rounds below is intentionally NOT published (no realtime needed). ──
DROP TABLE IF EXISTS public.crash_bets          CASCADE;
DROP TABLE IF EXISTS public.crash_round_secrets CASCADE;
DROP TABLE IF EXISTS public.crash_rounds        CASCADE;
DROP TABLE IF EXISTS public.crash_tables        CASCADE;

-- ── Per-player active round (one 'running' row per user, enforced below). ──
CREATE TABLE IF NOT EXISTS public.crash_rounds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bet         integer NOT NULL CHECK (bet > 0),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running','cashed','busted')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Service-only secret: hidden crash point + crash timestamp for the running round.
--    NEVER granted to clients — that is the entire fairness boundary. ──
CREATE TABLE IF NOT EXISTS public.crash_round_secrets (
  round_id    uuid PRIMARY KEY REFERENCES public.crash_rounds(id) ON DELETE CASCADE,
  crash_point numeric(12,2) NOT NULL CHECK (crash_point >= 1),
  crash_at    timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Immutable per-player history written at resolve (like slots_spins). SELECT own.
--    Pre-wired into economy_stats()/hazard_stats/coin-inflow via total_bet/total_won. ──
CREATE TABLE IF NOT EXISTS public.crash_spins (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  round_id          uuid,
  total_bet         integer NOT NULL CHECK (total_bet > 0),
  cashout_multiplier numeric(12,2) CHECK (cashout_multiplier IS NULL OR cashout_multiplier >= 1),
  total_won         integer NOT NULL DEFAULT 0 CHECK (total_won >= 0),
  crash_point       numeric(12,2) NOT NULL CHECK (crash_point >= 1),
  item_effect       jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Re-link crash_spins.round_id to the fresh crash_rounds (legacy ids now dangle → NULL).
UPDATE public.crash_spins
   SET round_id = NULL
 WHERE round_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.crash_rounds r WHERE r.id = public.crash_spins.round_id);
ALTER TABLE public.crash_spins DROP CONSTRAINT IF EXISTS crash_spins_round_id_fkey;
ALTER TABLE public.crash_spins
  ADD CONSTRAINT crash_spins_round_id_fkey
  FOREIGN KEY (round_id) REFERENCES public.crash_rounds(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS crash_spins_user_time_idx
  ON public.crash_spins(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crash_spins_round_idx
  ON public.crash_spins(round_id);
CREATE INDEX IF NOT EXISTS crash_rounds_user_time_idx
  ON public.crash_rounds(user_id, created_at DESC);
-- At most one live rocket per player (start rejects/resolves a prior live round first).
CREATE UNIQUE INDEX IF NOT EXISTS crash_rounds_one_live_per_user
  ON public.crash_rounds(user_id) WHERE status = 'running';

-- ── RLS ──
ALTER TABLE public.crash_rounds        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_round_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_spins         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crash_rounds_select"     ON public.crash_rounds;
DROP POLICY IF EXISTS "crash_rounds_select_own" ON public.crash_rounds;
CREATE POLICY "crash_rounds_select_own" ON public.crash_rounds
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "crash_spins_select_own" ON public.crash_spins;
CREATE POLICY "crash_spins_select_own" ON public.crash_spins
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- crash_round_secrets: no policy at all → no client can read the hidden crash point.

-- ── Grants: clients read their own rounds/spins only; secrets fully revoked. ──
REVOKE ALL ON public.crash_rounds, public.crash_round_secrets, public.crash_spins
  FROM anon, authenticated;

GRANT SELECT ON public.crash_rounds, public.crash_spins TO authenticated;
-- (crash_round_secrets is intentionally NOT granted.)

NOTIFY pgrst, 'reload schema';
