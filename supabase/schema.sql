-- Rynek Proroctw G6 — core prediction-market schema
-- Run once in Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run)
-- Then run supabase/poker.sql to enable the Texas Hold'em tab.

-- ── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE public.profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  nick       text UNIQUE NOT NULL,
  is_admin   boolean NOT NULL DEFAULT false,
  coins      integer NOT NULL DEFAULT 1000,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.markets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  icon         text NOT NULL DEFAULT '🎲',
  title        text NOT NULL,
  deadline     text NOT NULL,
  yes_shares   numeric NOT NULL DEFAULT 500,
  no_shares    numeric NOT NULL DEFAULT 500,
  created_by   uuid REFERENCES public.profiles(id),
  created_at   timestamptz DEFAULT now(),
  resolved     boolean NOT NULL DEFAULT false,
  resolution   text
);

CREATE TABLE public.trades (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id     uuid NOT NULL REFERENCES public.markets(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.profiles(id),
  nick_snapshot text NOT NULL,
  side          text NOT NULL CHECK (side IN ('YES','NO')),
  amount        integer NOT NULL,
  shares        numeric NOT NULL,
  p_yes_after   numeric NOT NULL,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trades_market_time_idx ON public.trades(market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trades_user_market_side_idx ON public.trades(user_id, market_id, side);
CREATE INDEX IF NOT EXISTS markets_created_by_idx ON public.markets(created_by);
CREATE INDEX IF NOT EXISTS markets_resolved_created_at_idx ON public.markets(resolved, created_at DESC);

-- ── Views ──────────────────────────────────────────────────────────────────

CREATE VIEW public.positions WITH (security_invoker = true) AS
SELECT user_id, market_id, side,
       SUM(amount)::integer AS total_spent,
       SUM(shares)          AS total_shares
FROM public.trades
GROUP BY user_id, market_id, side;

CREATE VIEW public.leaderboard WITH (security_invoker = true) AS
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
       ), 0) AS net_worth,
       p.is_admin
FROM public.profiles p;

-- ── Trigger: create profile on signup ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, nick)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'nick');
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── RPC: place_bet (atomic) ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.place_bet(p_market uuid, p_side text, p_amount integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user   uuid := auth.uid();
  v_nick   text;
  v_coins  integer;
  v_y      numeric;
  v_n      numeric;
  v_d      numeric;
  v_shares numeric;
  v_y2     numeric;
  v_n2     numeric;
BEGIN
  IF v_user IS NULL    THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_amount < 1      THEN RAISE EXCEPTION 'bad_amount'; END IF;
  IF p_side NOT IN ('YES','NO') THEN RAISE EXCEPTION 'bad_side'; END IF;

  SELECT nick, coins INTO v_nick, v_coins
  FROM public.profiles WHERE id = v_user FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
  IF v_coins < p_amount THEN RAISE EXCEPTION 'insufficient_coins'; END IF;
  IF EXISTS (
    SELECT 1
    FROM public.trades
    WHERE market_id = p_market
      AND user_id = v_user
      AND side <> p_side
  ) THEN
    RAISE EXCEPTION 'side_locked';
  END IF;

  SELECT yes_shares, no_shares INTO v_y, v_n
  FROM public.markets WHERE id = p_market AND resolved = false FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'market_not_found'; END IF;

  IF p_side = 'YES' THEN
    v_d      := (v_y * p_amount) / (v_n + p_amount);
    v_shares := p_amount + v_d;
    v_y2 := v_y - v_d;
    v_n2 := v_n + p_amount;
  ELSE
    v_d      := (v_n * p_amount) / (v_y + p_amount);
    v_shares := p_amount + v_d;
    v_y2 := v_y + p_amount;
    v_n2 := v_n - v_d;
  END IF;

  UPDATE public.markets  SET yes_shares = v_y2, no_shares = v_n2 WHERE id = p_market;
  UPDATE public.profiles SET coins = coins - p_amount            WHERE id = v_user;

  INSERT INTO public.trades (market_id, user_id, nick_snapshot, side, amount, shares, p_yes_after)
  VALUES (p_market, v_user, v_nick, p_side, p_amount, v_shares, v_n2 / (v_y2 + v_n2));

  RETURN json_build_object(
    'shares',      v_shares,
    'p_yes_after', v_n2 / (v_y2 + v_n2),
    'coins_left',  v_coins - p_amount
  );
END;
$$;

-- ── RPC: create_market ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_market(p_icon text, p_title text, p_deadline text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  INSERT INTO public.markets (icon, title, deadline, created_by)
  VALUES (COALESCE(NULLIF(trim(p_icon),''), '🎲'), p_title, p_deadline, auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ── Row-Level Security ─────────────────────────────────────────────────────

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.markets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades   ENABLE ROW LEVEL SECURITY;

-- profiles: readable so the login screen can show the nick dropdown; nobody can
-- write directly (trigger + RPC only).
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT USING (true);

-- markets: anyone can read, nobody can INSERT/UPDATE/DELETE directly
CREATE POLICY "markets_select"  ON public.markets FOR SELECT USING (true);

-- trades: anyone can read, nobody can INSERT directly (RPC only)
CREATE POLICY "trades_select"   ON public.trades  FOR SELECT USING (true);

-- Data API privileges: expose only the read surface and authenticated RPCs.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.profiles, public.markets, public.trades
  FROM PUBLIC, anon, authenticated;
REVOKE SELECT ON public.profiles FROM anon;
GRANT SELECT (nick) ON public.profiles TO anon;
GRANT SELECT ON public.profiles TO authenticated;
GRANT SELECT ON public.markets, public.trades, public.positions, public.leaderboard
  TO authenticated;

-- ── Realtime: enable publications ─────────────────────────────────────────

ALTER PUBLICATION supabase_realtime ADD TABLE public.markets;
ALTER PUBLICATION supabase_realtime ADD TABLE public.trades;

-- ── Resolution support (run this block separately if schema already exists) ──

ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS resolved_at  timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by  uuid REFERENCES public.profiles(id);

CREATE INDEX IF NOT EXISTS markets_resolved_by_idx ON public.markets(resolved_by);

-- Returns true if the calling user has explicit admin privileges.
CREATE OR REPLACE FUNCTION public.is_admin(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user AND is_admin);
$$;

-- Resolve a market: creator or admin picks YES/NO; winners split the coin pot by shares
CREATE OR REPLACE FUNCTION public.resolve_market(p_market uuid, p_resolution text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user                 uuid := auth.uid();
  v_creator              uuid;
  v_already              boolean;
  v_total_pot            bigint := 0;
  v_losing_pot           bigint := 0;
  v_total_winning_shares numeric := 0;
  v_payout               bigint := 0;
BEGIN
  IF v_user IS NULL                   THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_resolution NOT IN ('YES','NO') THEN RAISE EXCEPTION 'bad_resolution';   END IF;

  SELECT created_by, resolved INTO v_creator, v_already
  FROM public.markets WHERE id = p_market FOR UPDATE;

  IF NOT FOUND   THEN RAISE EXCEPTION 'market_not_found'; END IF;
  IF v_already   THEN RAISE EXCEPTION 'already_resolved'; END IF;
  IF v_creator IS DISTINCT FROM v_user AND NOT public.is_admin(v_user)
                 THEN RAISE EXCEPTION 'not_authorized';   END IF;

  SELECT COALESCE(SUM(amount), 0)::bigint INTO v_total_pot
  FROM   public.trades
  WHERE  market_id = p_market;

  SELECT COALESCE(SUM(amount), 0)::bigint INTO v_losing_pot
  FROM   public.trades
  WHERE  market_id = p_market AND side <> p_resolution;

  SELECT COALESCE(SUM(shares), 0) INTO v_total_winning_shares
  FROM   public.trades
  WHERE  market_id = p_market AND side = p_resolution;

  -- Winners get their stake back; losing-side coins are split by winning shares.
  -- Remainder coins go to the largest fractional payouts for deterministic integer totals.
  IF v_total_pot > 0 AND v_total_winning_shares > 0 THEN
    WITH raw_payouts AS (
      SELECT user_id,
             SUM(amount)::numeric + v_losing_pot::numeric * SUM(shares) / v_total_winning_shares AS exact_payout
      FROM   public.trades
      WHERE  market_id = p_market AND side = p_resolution
      GROUP  BY user_id
    ), base_payouts AS (
      SELECT user_id,
             FLOOR(exact_payout)::integer AS base_payout,
             exact_payout - FLOOR(exact_payout) AS fractional_payout
      FROM   raw_payouts
    ), ranked_payouts AS (
      SELECT user_id,
             base_payout,
             ROW_NUMBER() OVER (ORDER BY fractional_payout DESC, user_id) AS fractional_rank,
             (v_total_pot - SUM(base_payout) OVER ())::integer AS remainder_coins
      FROM   base_payouts
    ), payouts AS (
      SELECT user_id,
             base_payout + CASE WHEN fractional_rank <= remainder_coins THEN 1 ELSE 0 END AS payout
      FROM   ranked_payouts
    ), credited AS (
      UPDATE public.profiles p
         SET coins = p.coins + payouts.payout
        FROM payouts
       WHERE p.id = payouts.user_id
      RETURNING payouts.payout
    )
    SELECT COALESCE(SUM(payout), 0)::bigint INTO v_payout
    FROM   credited;
  END IF;

  UPDATE public.markets
     SET resolved    = true,
         resolution  = p_resolution,
         resolved_at = now(),
         resolved_by = v_user
   WHERE id = p_market;

  RETURN json_build_object(
    'total_pot',    v_total_pot,
    'losing_pot',   v_losing_pot,
    'total_payout', v_payout,
    'resolution',   p_resolution
  );
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_admin(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.place_bet(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_market(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_market(uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.place_bet(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_market(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_market(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
