-- Texas Hold'em support for Rynek Proroctw G6.
-- Run after supabase/schema.sql on an existing project.

-- ── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.poker_tables (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text UNIQUE NOT NULL DEFAULT 'main',
  buy_in         integer NOT NULL DEFAULT 100 CHECK (buy_in > 0),
  small_blind    integer NOT NULL DEFAULT 1 CHECK (small_blind > 0),
  big_blind      integer NOT NULL DEFAULT 2 CHECK (big_blind > 0),
  action_seconds integer NOT NULL DEFAULT 30 CHECK (action_seconds BETWEEN 5 AND 300),
  max_seats      integer NOT NULL DEFAULT 6 CHECK (max_seats BETWEEN 2 AND 6),
  phase          text NOT NULL DEFAULT 'waiting'
                 CHECK (phase IN ('waiting','preflop','flop','turn','river','showdown')),
  hand_id        uuid,
  hand_no        integer NOT NULL DEFAULT 0,
  dealer_seat    integer CHECK (dealer_seat BETWEEN 0 AND 5),
  current_seat   integer CHECK (current_seat BETWEEN 0 AND 5),
  current_bet    integer NOT NULL DEFAULT 0 CHECK (current_bet >= 0),
  min_raise      integer NOT NULL DEFAULT 2 CHECK (min_raise >= 0),
  pot            integer NOT NULL DEFAULT 0 CHECK (pot >= 0),
  board          text[] NOT NULL DEFAULT '{}',
  action_deadline timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.poker_seats (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id      uuid NOT NULL REFERENCES public.poker_tables(id) ON DELETE CASCADE,
  seat_no       integer NOT NULL CHECK (seat_no BETWEEN 0 AND 5),
  user_id       uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  stack         integer NOT NULL DEFAULT 0 CHECK (stack >= 0),
  in_hand       boolean NOT NULL DEFAULT false,
  folded        boolean NOT NULL DEFAULT false,
  all_in        boolean NOT NULL DEFAULT false,
  round_bet     integer NOT NULL DEFAULT 0 CHECK (round_bet >= 0),
  hand_bet      integer NOT NULL DEFAULT 0 CHECK (hand_bet >= 0),
  acted         boolean NOT NULL DEFAULT false,
  last_action   text,
  is_bot        boolean NOT NULL DEFAULT false,
  bot_nick      text,
  seated_at     timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, seat_no),
  UNIQUE (table_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.poker_hands (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id      uuid NOT NULL REFERENCES public.poker_tables(id) ON DELETE CASCADE,
  hand_no       integer NOT NULL,
  dealer_seat   integer NOT NULL CHECK (dealer_seat BETWEEN 0 AND 5),
  deck          text[] NOT NULL,
  burn_cards    text[] NOT NULL DEFAULT '{}',
  active_seats  integer[] NOT NULL DEFAULT '{}',
  result        jsonb,
  started_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz
);

CREATE TABLE IF NOT EXISTS public.poker_player_cards (
  hand_id  uuid NOT NULL REFERENCES public.poker_hands(id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES public.poker_tables(id) ON DELETE CASCADE,
  seat_no  integer NOT NULL CHECK (seat_no BETWEEN 0 AND 5),
  user_id  uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  cards    text[] NOT NULL,
  revealed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (hand_id, seat_no)
);

CREATE TABLE IF NOT EXISTS public.poker_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_id   uuid NOT NULL REFERENCES public.poker_tables(id) ON DELETE CASCADE,
  hand_id    uuid REFERENCES public.poker_hands(id) ON DELETE SET NULL,
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS poker_seats_table_idx ON public.poker_seats(table_id, seat_no);
CREATE INDEX IF NOT EXISTS poker_seats_user_idx ON public.poker_seats(user_id);
CREATE INDEX IF NOT EXISTS poker_events_table_time_idx ON public.poker_events(table_id, created_at DESC);
CREATE INDEX IF NOT EXISTS poker_cards_user_idx ON public.poker_player_cards(user_id, hand_id);

INSERT INTO public.poker_tables (slug)
VALUES ('main')
ON CONFLICT (slug) DO NOTHING;

-- ── Leaderboard: include active poker stacks ───────────────────────────────

CREATE OR REPLACE VIEW public.leaderboard WITH (security_invoker = true) AS
SELECT p.id,
       p.nick,
       p.coins,
       p.coins + COALESCE((
         SELECT SUM(
           CASE WHEN t.side = 'YES'
                THEN t.shares * (m.no_shares  / (m.yes_shares + m.no_shares))
                ELSE t.shares * (m.yes_shares / (m.yes_shares + m.no_shares))
           END)
         FROM public.trades t
         JOIN public.markets m ON m.id = t.market_id
         WHERE t.user_id = p.id AND m.resolved = false
       ), 0) + COALESCE((
         SELECT SUM(ps.stack)
         FROM public.poker_seats ps
         WHERE ps.user_id = p.id
       ), 0) AS net_worth
FROM public.profiles p;

-- ── Row-Level Security ─────────────────────────────────────────────────────

ALTER TABLE public.poker_tables       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poker_seats        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poker_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poker_hands        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poker_player_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "poker_tables_select" ON public.poker_tables;
DROP POLICY IF EXISTS "poker_seats_select"  ON public.poker_seats;
DROP POLICY IF EXISTS "poker_events_select" ON public.poker_events;

CREATE POLICY "poker_tables_select" ON public.poker_tables
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "poker_seats_select" ON public.poker_seats
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "poker_events_select" ON public.poker_events
  FOR SELECT TO authenticated USING (true);

-- Browser clients can read only public table state and public event messages.
-- Hidden deck/hole-card tables are service-role only and are returned through
-- the poker Edge Function after per-user sanitization.
REVOKE ALL ON public.poker_tables, public.poker_seats, public.poker_events,
              public.poker_hands, public.poker_player_cards
  FROM anon, authenticated;

GRANT SELECT ON public.poker_tables, public.poker_seats, public.poker_events
  TO authenticated;

GRANT SELECT ON public.leaderboard TO anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'poker_tables'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.poker_tables;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'poker_seats'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.poker_seats;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'poker_events'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.poker_events;
    END IF;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
