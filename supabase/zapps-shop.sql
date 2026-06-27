-- Buy Zappsy with coins ("Kup Zappsy") for Rynek Proroctw G6.
-- Reverses the old coin top-up: a player spends in-game coins to claim real-life
-- "Zappsy" at a fixed 1:1 rate (1 coin = 1 zapps). There is a single shared,
-- limited prize pool of ZAPPS_POOL_TOTAL (1500) Zappsy across the whole office.
-- The player files a request ("kup mi X zappsów"); an admin reviews pending
-- requests and either APPROVES (the player's coins are BURNED and the Zappsy
-- count is reserved from the pool, to be handed over off-platform) or REJECTS.
-- Run after supabase/schema.sql (needs public.is_admin) and ideally after
-- supabase/coin-transactions.sql. Idempotent.
--
-- The pool total (1500) is duplicated as ZAPPS_POOL_TOTAL in index.html — keep
-- the two in sync. The burn reason 'zapps_purchase' must stay listed in the
-- shop-burn bucket of supabase/economy-stats.sql.

CREATE TABLE IF NOT EXISTS public.zapps_purchase_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  amount        integer NOT NULL CHECK (amount BETWEEN 1 AND 1000000),  -- = zappsy = coins
  contact       text NOT NULL DEFAULT '',     -- Zappsy nick / how the admin reaches them
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   text
);

CREATE INDEX IF NOT EXISTS zapps_purchase_pending_idx
  ON public.zapps_purchase_requests(status, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS zapps_purchase_user_idx
  ON public.zapps_purchase_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS zapps_purchase_approved_idx
  ON public.zapps_purchase_requests(status)
  WHERE status = 'approved';

-- ── RLS: player sees their own requests; admin sees everything ────────────────
ALTER TABLE public.zapps_purchase_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "zapps_purchase_select" ON public.zapps_purchase_requests;
CREATE POLICY "zapps_purchase_select" ON public.zapps_purchase_requests
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));

REVOKE ALL ON public.zapps_purchase_requests FROM anon, authenticated;
GRANT SELECT ON public.zapps_purchase_requests TO authenticated;

-- ── Public pool status (aggregate, no PII): how many of the 1500 are left ─────
DROP FUNCTION IF EXISTS public.zapps_pool_status();
CREATE OR REPLACE FUNCTION public.zapps_pool_status()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_total   integer := 1500;   -- ZAPPS_POOL_TOTAL (mirror index.html)
  v_claimed integer;
BEGIN
  SELECT COALESCE(sum(amount), 0)::integer INTO v_claimed
  FROM public.zapps_purchase_requests
  WHERE status = 'approved';

  RETURN json_build_object(
    'total',     v_total,
    'claimed',   v_claimed,
    'remaining', GREATEST(v_total - v_claimed, 0)
  );
END;
$$;

-- ── Player files a purchase request ──────────────────────────────────────────
DROP FUNCTION IF EXISTS public.request_zapps_purchase(integer, text);
CREATE OR REPLACE FUNCTION public.request_zapps_purchase(p_amount integer, p_contact text DEFAULT '')
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_nick      text;
  v_coins     integer;
  v_pending   integer;
  v_total     integer := 1500;   -- ZAPPS_POOL_TOTAL (mirror index.html)
  v_claimed   integer;
  v_remaining integer;
  v_id        uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_amount IS NULL OR p_amount < 1 THEN RAISE EXCEPTION 'bad_amount'; END IF;
  IF p_amount > 1000000 THEN RAISE EXCEPTION 'amount_too_big'; END IF;

  SELECT nick, coins INTO v_nick, v_coins FROM public.profiles WHERE id = v_user;
  IF v_nick IS NULL THEN RAISE EXCEPTION 'no_profile'; END IF;

  -- Need enough coins now (final balance is re-checked at approval, since coins
  -- are only burned then).
  IF v_coins < p_amount THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  -- Pool must still have room (hard-enforced again at approval).
  SELECT COALESCE(sum(amount), 0)::integer INTO v_claimed
  FROM public.zapps_purchase_requests
  WHERE status = 'approved';
  v_remaining := v_total - v_claimed;
  IF v_remaining <= 0 THEN RAISE EXCEPTION 'pool_exhausted'; END IF;
  IF p_amount > v_remaining THEN RAISE EXCEPTION 'exceeds_pool'; END IF;

  -- Anti-spam: at most 5 open requests at a time.
  SELECT count(*) INTO v_pending
  FROM public.zapps_purchase_requests
  WHERE user_id = v_user AND status = 'pending';
  IF v_pending >= 5 THEN RAISE EXCEPTION 'too_many_pending'; END IF;

  INSERT INTO public.zapps_purchase_requests (user_id, nick_snapshot, amount, contact)
  VALUES (v_user, v_nick, p_amount, left(trim(COALESCE(p_contact, '')), 200))
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'request_id', v_id);
END;
$$;

-- ── Admin approves (burns coins + reserves Zappsy) or rejects a request ───────
DROP FUNCTION IF EXISTS public.resolve_zapps_purchase(uuid, boolean, text);
CREATE OR REPLACE FUNCTION public.resolve_zapps_purchase(p_id uuid, p_approve boolean, p_note text DEFAULT '')
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin      uuid := auth.uid();
  v_admin_nick text;
  v_req        public.zapps_purchase_requests%ROWTYPE;
  v_total      integer := 1500;   -- ZAPPS_POOL_TOTAL (mirror index.html)
  v_claimed    integer;
  v_coins      integer;
BEGIN
  IF v_admin IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'not_authorized'; END IF;

  SELECT nick INTO v_admin_nick FROM public.profiles WHERE id = v_admin;

  SELECT * INTO v_req FROM public.zapps_purchase_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'already_resolved'; END IF;

  IF p_approve THEN
    -- Serialize approvals so the 1500 pool can't be oversold by concurrent admins.
    PERFORM pg_advisory_xact_lock(hashtext('zapps_pool'));

    SELECT COALESCE(sum(amount), 0)::integer INTO v_claimed
    FROM public.zapps_purchase_requests
    WHERE status = 'approved';
    IF v_claimed + v_req.amount > v_total THEN RAISE EXCEPTION 'pool_exhausted'; END IF;

    -- Burn the coins (balance re-checked atomically; can't go negative).
    UPDATE public.profiles SET coins = coins - v_req.amount
     WHERE id = v_req.user_id AND coins >= v_req.amount
    RETURNING coins INTO v_coins;
    IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

    IF to_regclass('public.coin_transactions') IS NOT NULL THEN
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES (v_req.user_id, -v_req.amount, 'zapps_purchase',
              jsonb_build_object('request_id', p_id, 'admin', v_admin_nick));
    END IF;
  END IF;

  UPDATE public.zapps_purchase_requests
     SET status      = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         admin_note  = left(trim(COALESCE(p_note, '')), 300),
         resolved_at = now(),
         resolved_by = v_admin_nick
   WHERE id = p_id;

  RETURN json_build_object('ok', true, 'approved', p_approve, 'coins_left', v_coins);
END;
$$;

REVOKE ALL ON FUNCTION public.zapps_pool_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_zapps_purchase(integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_zapps_purchase(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zapps_pool_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_zapps_purchase(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_zapps_purchase(uuid, boolean, text) TO authenticated;

-- ── Realtime so the player's status + the admin console + pool count update ───
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'zapps_purchase_requests'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.zapps_purchase_requests;
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
