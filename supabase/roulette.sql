-- Roulette support for Rynek Proroctw G6.
-- Run after supabase/schema.sql on an existing project.

CREATE TABLE IF NOT EXISTS public.roulette_tables (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text UNIQUE NOT NULL DEFAULT 'main',
  max_seats        integer NOT NULL DEFAULT 6 CHECK (max_seats BETWEEN 1 AND 6),
  round_no         integer NOT NULL DEFAULT 0 CHECK (round_no >= 0),
  current_round_id uuid,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.roulette_rounds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id      uuid NOT NULL REFERENCES public.roulette_tables(id) ON DELETE CASCADE,
  round_no      integer NOT NULL CHECK (round_no > 0),
  status        text NOT NULL DEFAULT 'betting' CHECK (status IN ('betting','resolved')),
  result_number integer CHECK (result_number BETWEEN 0 AND 36),
  result_color  text CHECK (result_color IN ('red','black','green')),
  total_bet     integer NOT NULL DEFAULT 0 CHECK (total_bet >= 0),
  total_won     integer NOT NULL DEFAULT 0 CHECK (total_won >= 0),
  spun_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  UNIQUE (table_id, round_no)
);

CREATE TABLE IF NOT EXISTS public.roulette_seats (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id          uuid NOT NULL REFERENCES public.roulette_tables(id) ON DELETE CASCADE,
  seat_no           integer NOT NULL CHECK (seat_no BETWEEN 0 AND 5),
  user_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot     text NOT NULL,
  ready             boolean NOT NULL DEFAULT false,
  session_total_bet integer NOT NULL DEFAULT 0 CHECK (session_total_bet >= 0),
  session_total_won integer NOT NULL DEFAULT 0 CHECK (session_total_won >= 0),
  seated_at         timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, seat_no),
  UNIQUE (table_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.roulette_bets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id   uuid NOT NULL REFERENCES public.roulette_rounds(id) ON DELETE CASCADE,
  table_id   uuid NOT NULL REFERENCES public.roulette_tables(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  seat_no    integer NOT NULL CHECK (seat_no BETWEEN 0 AND 5),
  type       text NOT NULL CHECK (type IN ('straight','red','black','odd','even','high','low','dozen','column')),
  value      integer,
  amount     integer NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

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

ALTER TABLE public.roulette_spins
  ADD COLUMN IF NOT EXISTS table_id uuid REFERENCES public.roulette_tables(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS round_id uuid REFERENCES public.roulette_rounds(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS seat_no integer CHECK (seat_no BETWEEN 0 AND 5),
  ADD COLUMN IF NOT EXISTS item_effect jsonb;

CREATE INDEX IF NOT EXISTS roulette_spins_user_time_idx
  ON public.roulette_spins(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS roulette_spins_round_idx
  ON public.roulette_spins(round_id);

CREATE INDEX IF NOT EXISTS roulette_rounds_table_time_idx
  ON public.roulette_rounds(table_id, created_at DESC);

CREATE INDEX IF NOT EXISTS roulette_seats_table_idx
  ON public.roulette_seats(table_id, seat_no);

CREATE INDEX IF NOT EXISTS roulette_bets_round_idx
  ON public.roulette_bets(round_id, seat_no, created_at);

CREATE INDEX IF NOT EXISTS roulette_bets_user_idx
  ON public.roulette_bets(user_id, created_at DESC);

INSERT INTO public.roulette_tables (slug)
VALUES ('main')
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE public.roulette_spins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roulette_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roulette_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roulette_seats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roulette_bets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "roulette_spins_select_own" ON public.roulette_spins;
CREATE POLICY "roulette_spins_select_own" ON public.roulette_spins
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "roulette_tables_select" ON public.roulette_tables;
CREATE POLICY "roulette_tables_select" ON public.roulette_tables
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "roulette_rounds_select" ON public.roulette_rounds;
CREATE POLICY "roulette_rounds_select" ON public.roulette_rounds
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "roulette_seats_select" ON public.roulette_seats;
CREATE POLICY "roulette_seats_select" ON public.roulette_seats
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "roulette_bets_select" ON public.roulette_bets;
CREATE POLICY "roulette_bets_select" ON public.roulette_bets
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.roulette_spins, public.roulette_tables, public.roulette_rounds,
              public.roulette_seats, public.roulette_bets
  FROM anon, authenticated;

GRANT SELECT ON public.roulette_spins, public.roulette_tables, public.roulette_rounds,
                public.roulette_seats, public.roulette_bets
  TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'roulette_tables'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.roulette_tables;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'roulette_rounds'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.roulette_rounds;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'roulette_seats'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.roulette_seats;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'roulette_bets'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.roulette_bets;
    END IF;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
