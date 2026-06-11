-- World Cup 2026 fixed-odds betting ("Mundial") for Rynek Proroctw G6.
-- Run after supabase/schema.sql on an existing project.
--
-- Model: fixed-odds vs the house. Real bookmaker decimal odds (API-Football)
-- are locked at bet time; a winning bet pays floor(stake * locked_odds).
-- Losing stakes are burned, winnings are minted by the house — same coin
-- economy as slots/roulette. Fixtures, odds and final results all come from
-- API-Football and are written ONLY by the `football-action` Edge Function
-- (service connection). Clients get SELECT-only access.

-- ── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.football_matches (
  id              bigint PRIMARY KEY,                  -- API-Football fixture id
  league_id       integer NOT NULL,
  season          integer NOT NULL,
  kickoff         timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'NS',          -- NS/1H/HT/2H/ET/P/FT/AET/PEN/PST/CANC/ABD/AWD/WO
  home_team       text NOT NULL,
  away_team       text NOT NULL,
  home_logo       text,
  away_logo       text,
  home_goals      integer,
  away_goals      integer,
  result          text CHECK (result IN ('1','X','2')),
  odds_home       numeric(8,3),
  odds_draw       numeric(8,3),
  odds_away       numeric(8,3),
  prob_home       numeric(6,4),                        -- de-vigged implied probability
  prob_draw       numeric(6,4),
  prob_away       numeric(6,4),
  bookmaker       text,                                -- which book the stored odds came from
  odds_updated_at timestamptz,
  settled         boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.football_bets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot    text NOT NULL,
  match_id         bigint NOT NULL REFERENCES public.football_matches(id) ON DELETE CASCADE,
  pick             text NOT NULL CHECK (pick IN ('1','X','2')),
  stake            integer NOT NULL CHECK (stake >= 1),
  locked_odds      numeric(8,3) NOT NULL CHECK (locked_odds >= 1),
  potential_payout integer NOT NULL CHECK (potential_payout >= 0),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','void')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  settled_at       timestamptz
);

CREATE INDEX IF NOT EXISTS football_matches_kickoff_idx
  ON public.football_matches(kickoff);
CREATE INDEX IF NOT EXISTS football_matches_open_idx
  ON public.football_matches(status, kickoff)
  WHERE settled = false;
CREATE INDEX IF NOT EXISTS football_bets_match_idx
  ON public.football_bets(match_id);
CREATE INDEX IF NOT EXISTS football_bets_user_idx
  ON public.football_bets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS football_bets_open_idx
  ON public.football_bets(status)
  WHERE status = 'open';

-- ── Row level security (SELECT only for clients; writes via Edge Function) ────

ALTER TABLE public.football_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_bets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "football_matches_select" ON public.football_matches;
CREATE POLICY "football_matches_select" ON public.football_matches
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "football_bets_select" ON public.football_bets;
CREATE POLICY "football_bets_select" ON public.football_bets
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.football_matches, public.football_bets FROM anon, authenticated;
GRANT SELECT ON public.football_matches TO anon, authenticated;
GRANT SELECT ON public.football_bets TO authenticated;

-- ── Leaderboard parity ────────────────────────────────────────────────────────
-- Open bets escrow coins (already deducted from profiles.coins). Add the open
-- stake back into net worth so a pending bet doesn't tank a player's ranking,
-- mirroring how active poker stacks are counted. Columns/order unchanged so
-- this is a safe CREATE OR REPLACE over schema.sql's definition.

CREATE OR REPLACE VIEW public.leaderboard WITH (security_invoker = true) AS
SELECT p.id,
       p.nick,
       p.coins,
       p.coins
         + COALESCE((
             SELECT SUM(
               CASE WHEN t.side = 'YES'
                    THEN t.shares * (m.no_shares  / (m.yes_shares + m.no_shares))
                    ELSE t.shares * (m.yes_shares / (m.yes_shares + m.no_shares))
               END)
             FROM public.trades t
             JOIN public.markets m ON m.id = t.market_id
             WHERE t.user_id = p.id AND m.resolved = false
           ), 0)
         + COALESCE((
             SELECT SUM(b.stake)
             FROM public.football_bets b
             WHERE b.user_id = p.id AND b.status = 'open'
           ), 0) AS net_worth
FROM public.profiles p;

-- ── Realtime ───────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'football_matches'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.football_matches;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'football_bets'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.football_bets;
  END IF;
END;
$$;

-- ── Hourly cron: refresh odds + auto-settle finished matches ───────────────────
-- Calls the football-action Edge Function with the shared cron secret. The
-- function fetches fixtures/odds/results from API-Football and settles bets.
--
-- BEFORE RUNNING: replace __PROJECT_REF__ with your Supabase project ref and
-- __FOOTBALL_CRON_SECRET__ with the same value set as the FOOTBALL_CRON_SECRET
-- function secret. Requires the pg_cron and pg_net extensions.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = 'football_hourly_sync';

    PERFORM cron.schedule(
      'football_hourly_sync',
      '0 * * * *',
      $cron$
        SELECT net.http_post(
          url     := 'https://__PROJECT_REF__.supabase.co/functions/v1/football-action',
          headers := jsonb_build_object(
                       'Content-Type', 'application/json',
                       'x-cron-secret', '__FOOTBALL_CRON_SECRET__'
                     ),
          body    := jsonb_build_object('action', 'cron')
        );
      $cron$
    );
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
