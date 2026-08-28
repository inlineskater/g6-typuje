-- ════════════════════════════════════════════════════════════════════════════
--  „Drabina Kariery G6" — Hi-Lo card ladder (internal name: hilo)
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER: coin-transactions.sql. Idempotent.
--  Run order: hilo.sql, THEN re-run hazard-views.sql + coin-inflow-stats.sql
--             + economy-stats.sql (all three grew a hilo branch).
--
--  ── The game ───────────────────────────────────────────────────────────────
--  The server shows a card. You call WYŻEJ (next is higher or the same) or NIŻEJ
--  (lower or the same) with the TRUE probability printed on each button. Right,
--  and the pot multiplies by the fair inverse of that probability and the next
--  card flips. Wrong, and the pot is gone. Cash out whenever.
--
--  ── Why the odds can be shown honestly ─────────────────────────────────────
--  Ties win BOTH ways (the standard hilo formulation, and the forgiving one):
--     P(WYŻEJ)  = (14 - r) / 13        P(NIŻEJ) = r / 13        r in 1..13
--  which sum to 14/13, the extra 1/13 being the tie that pays either call.
--
--  ── The house edge is applied ONCE, not per step ───────────────────────────
--  Each step multiplies the pot by exactly 1/p, so E[pot after a step] =
--  p * (pot/p) = pot: the ladder is a MARTINGALE. The 5% is taken once, at
--  cash-out, which means:
--    • RTP is a flat 95% at every streak length — a 12-step run is not
--      quietly worse than a 1-step run, the way a per-step edge would make it;
--    • no strategy beats any other. Always calling the safe side, always
--      calling the long shot, skipping to hunt for aces — every line has the
--      same expected value. There is nothing to solve, so there is no wrong
--      way to play, only a variance preference.
--  ⚠️ Do NOT "fix" this by applying HOUSE_FACTOR per step. It would compound to
--  0.54 over 12 steps and quietly punish exactly the runs the game is about.
--
--  ── No secrets table, deliberately ─────────────────────────────────────────
--  mines_round_secrets and crash_round_secrets exist because those games hide
--  state the player is betting against BEFORE they act — the board is fixed
--  before the first click, the bust point must exist before the cash-out. Hi-Lo
--  has no such state: each card is drawn at the moment of the call, from
--  crypto RNG in the Edge Function, and is immediately public. There is nothing
--  a client could peek at, so there is nothing to hide.
-- ════════════════════════════════════════════════════════════════════════════

-- One active round per player at a time (partial unique index, not app logic).
CREATE TABLE IF NOT EXISTS public.hilo_rounds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bet          bigint NOT NULL CHECK (bet > 0),
  -- rank 1..13 == 2,3,…,10,J,Q,K,A   suit 0..3 == ♠ ♥ ♦ ♣
  card_rank    smallint NOT NULL CHECK (card_rank BETWEEN 1 AND 13),
  card_suit    smallint NOT NULL CHECK (card_suit BETWEEN 0 AND 3),
  streak       integer NOT NULL DEFAULT 0 CHECK (streak >= 0),
  draws        integer NOT NULL DEFAULT 0 CHECK (draws >= 0),
  multiplier   numeric NOT NULL DEFAULT 1 CHECK (multiplier > 0),
  house_factor numeric NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cashed','busted')),
  history      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS hilo_rounds_one_active_idx
  ON public.hilo_rounds (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS hilo_rounds_user_idx
  ON public.hilo_rounds (user_id, created_at DESC);

-- Completed rounds: history, Hazardista, coin-inflow and economy house-net.
CREATE TABLE IF NOT EXISTS public.hilo_spins (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  round_id   uuid REFERENCES public.hilo_rounds(id) ON DELETE SET NULL,
  bet        bigint NOT NULL,
  streak     integer NOT NULL,
  multiplier numeric NOT NULL,
  total_won  bigint NOT NULL DEFAULT 0,
  result     text NOT NULL CHECK (result IN ('cashed','busted')),
  item_effect text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hilo_spins_user_idx    ON public.hilo_spins (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hilo_spins_streak_idx  ON public.hilo_spins (streak DESC, created_at);
CREATE INDEX IF NOT EXISTS hilo_spins_created_idx ON public.hilo_spins (created_at DESC);

-- Clients read their own rounds only (the active card is theirs), but spins are
-- public: the live streak feed is most of why anyone plays a second round.
ALTER TABLE public.hilo_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hilo_spins  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hilo_rounds_own" ON public.hilo_rounds;
CREATE POLICY "hilo_rounds_own" ON public.hilo_rounds
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "hilo_spins_select" ON public.hilo_spins;
CREATE POLICY "hilo_spins_select" ON public.hilo_spins
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.hilo_rounds FROM anon, authenticated;
REVOKE ALL ON public.hilo_spins  FROM anon, authenticated;
GRANT SELECT ON public.hilo_rounds TO authenticated;
GRANT SELECT ON public.hilo_spins  TO authenticated;


-- ── Leaderboards ───────────────────────────────────────────────────────────
-- Ranked on STREAK, not on coins won: a long ladder is the brag, and ranking on
-- payout would just rank whoever bets biggest.
CREATE OR REPLACE VIEW public.hilo_week_streaks WITH (security_invoker = false) AS
SELECT DISTINCT ON (s.user_id)
  s.user_id, p.nick, s.streak, s.multiplier, s.total_won, s.result, s.created_at
FROM public.hilo_spins s
JOIN public.profiles p ON p.id = s.user_id AND NOT COALESCE(p.is_admin, false)
WHERE s.created_at >= date_trunc('week', now() AT TIME ZONE 'Europe/Warsaw')
                      AT TIME ZONE 'Europe/Warsaw'
ORDER BY s.user_id, s.streak DESC, s.created_at;

CREATE OR REPLACE VIEW public.hilo_all_time_streaks WITH (security_invoker = false) AS
SELECT DISTINCT ON (s.user_id)
  s.user_id, p.nick, s.streak, s.multiplier, s.total_won, s.result, s.created_at
FROM public.hilo_spins s
JOIN public.profiles p ON p.id = s.user_id AND NOT COALESCE(p.is_admin, false)
ORDER BY s.user_id, s.streak DESC, s.created_at;

-- Live feed: the social proof that makes a solo game feel like a room.
CREATE OR REPLACE VIEW public.hilo_recent WITH (security_invoker = false) AS
SELECT s.id, s.user_id, p.nick, s.bet, s.streak, s.multiplier, s.total_won,
       s.result, s.created_at
FROM public.hilo_spins s
JOIN public.profiles p ON p.id = s.user_id AND NOT COALESCE(p.is_admin, false)
ORDER BY s.created_at DESC
LIMIT 30;

REVOKE SELECT ON public.hilo_week_streaks, public.hilo_all_time_streaks, public.hilo_recent FROM anon;
GRANT  SELECT ON public.hilo_week_streaks, public.hilo_all_time_streaks, public.hilo_recent TO authenticated;

-- Realtime so the feed and other people's streaks move without polling.
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.hilo_spins; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

NOTIFY pgrst, 'reload schema';
