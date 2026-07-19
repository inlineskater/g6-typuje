-- Security fixes — 2026-07-18 audit
-- Paste into Supabase SQL Editor (Dashboard → SQL Editor → New query → Run).
-- Idempotent + transactional (all-or-nothing). Safe to re-run.
--
-- Fix 1 — Market betting deadline is now ENFORCED. `markets` gets an optional
--         `closes_at timestamptz`; once it passes, place_bet rejects new bets
--         (was: freeform text deadline, bets allowed until manual resolution —
--         a window to bet on an already-known outcome).
-- Fix 2 — profiles.coins widened int4 → bigint. A large casino win
--         (stake × multiplier) could exceed int4 (2.15B) and error+roll back the
--         transaction. bigint removes that ceiling. The `leaderboard` view is the
--         only object that selects profiles.coins, so it is dropped/recreated
--         around the ALTER (its definition is kept in sync with
--         leaderboard-net-worth-items.sql — ⚠️ update both if that file changes).
--
-- NOTE: many other RPCs still declare `integer` coin locals (v_coins integer …).
--       They only overflow once a SINGLE account's balance exceeds ~2.15B, which
--       no account is near. Widen them (→ bigint) in a follow-up if the economy
--       ever approaches that; place_bet (the hot path) is already widened below.

BEGIN;

-- ── Fix 1: markets.closes_at + create_market accepts it ─────────────────────
ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS closes_at timestamptz;

-- create_market gains an optional close time. Drop the old 3-arg signature so
-- PostgREST resolves the named-arg call unambiguously to the new function.
DROP FUNCTION IF EXISTS public.create_market(text, text, text);
CREATE OR REPLACE FUNCTION public.create_market(
  p_icon text, p_title text, p_deadline text, p_closes_at timestamptz DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  INSERT INTO public.markets (icon, title, deadline, created_by, closes_at)
  VALUES (COALESCE(NULLIF(trim(p_icon),''), '🎲'), p_title, p_deadline, auth.uid(), p_closes_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_market(text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_market(text, text, text, timestamptz) TO authenticated;

-- ── Fix 1 + Fix 2: place_bet enforces closes_at, and reads coins as bigint ──
CREATE OR REPLACE FUNCTION public.place_bet(p_market uuid, p_side text, p_amount integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user   uuid := auth.uid();
  v_nick   text;
  v_coins  bigint;          -- Fix 2: was integer
  v_closes timestamptz;     -- Fix 1: per-market betting cutoff
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

  SELECT yes_shares, no_shares, closes_at INTO v_y, v_n, v_closes
  FROM public.markets WHERE id = p_market AND resolved = false FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'market_not_found'; END IF;
  -- Fix 1: no bets once the market's betting window has closed.
  IF v_closes IS NOT NULL AND now() >= v_closes THEN RAISE EXCEPTION 'market_closed'; END IF;

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

-- ── Fix 2: widen profiles.coins int4 → bigint ───────────────────────────────
-- The leaderboard view directly selects p.coins, so it must be dropped before
-- the type change and recreated after. ⚠️ Definition mirrors
-- supabase/leaderboard-net-worth-items.sql — keep the two in sync.
DROP VIEW IF EXISTS public.leaderboard;

ALTER TABLE public.profiles ALTER COLUMN coins TYPE bigint;

CREATE VIEW public.leaderboard WITH (security_invoker = true) AS
SELECT p.id,
       p.nick,
       p.coins,
       p.coins::numeric
         + COALESCE((
             SELECT sum(
               CASE WHEN t.side = 'YES'
                    THEN t.shares * (m.no_shares  / (m.yes_shares + m.no_shares))
                    ELSE t.shares * (m.yes_shares / (m.yes_shares + m.no_shares))
               END)
             FROM public.trades t
             JOIN public.markets m ON m.id = t.market_id
             WHERE t.user_id = p.id AND m.resolved = false
           ), 0::numeric)
         + COALESCE((
             SELECT sum(b.stake)
             FROM public.football_bets b
             WHERE b.user_id = p.id AND b.status = 'open'
           ), 0::bigint)::numeric
         + COALESCE((
             SELECT sum(ps.stack)
             FROM public.poker_seats ps
             WHERE ps.user_id = p.id
           ), 0::bigint)::numeric
         + public.user_assets_value(p.id) AS net_worth,
       p.is_admin
FROM public.profiles p;

GRANT SELECT ON public.leaderboard TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
