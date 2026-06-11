-- Coin top-up requests ("Doładowanie") for Rynek Proroctw G6.
-- A player exchanges real-life "Zappsy" for in-game coins at a fixed 1:1 rate
-- (1 zapps = 1 coin). The exchange itself happens off-platform; here the player
-- only files a request ("doładuj mi konto o X coinów"). An admin reviews pending
-- requests in the admin console and either APPROVES (coins are minted to the
-- player, like a reward) or REJECTS. Run after supabase/schema.sql (needs
-- public.is_admin) and ideally after supabase/coin-transactions.sql.

CREATE TABLE IF NOT EXISTS public.coin_topup_requests (
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

CREATE INDEX IF NOT EXISTS coin_topup_pending_idx
  ON public.coin_topup_requests(status, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS coin_topup_user_idx
  ON public.coin_topup_requests(user_id, created_at DESC);

-- ── RLS: player sees their own requests; admin sees everything ────────────────
ALTER TABLE public.coin_topup_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coin_topup_select" ON public.coin_topup_requests;
CREATE POLICY "coin_topup_select" ON public.coin_topup_requests
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));

REVOKE ALL ON public.coin_topup_requests FROM anon, authenticated;
GRANT SELECT ON public.coin_topup_requests TO authenticated;

-- ── Player files a top-up request ────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.request_coin_topup(integer, text);
CREATE OR REPLACE FUNCTION public.request_coin_topup(p_amount integer, p_contact text DEFAULT '')
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_nick    text;
  v_pending integer;
  v_id      uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_amount IS NULL OR p_amount < 1 THEN RAISE EXCEPTION 'bad_amount'; END IF;
  IF p_amount > 1000000 THEN RAISE EXCEPTION 'amount_too_big'; END IF;

  SELECT nick INTO v_nick FROM public.profiles WHERE id = v_user;
  IF v_nick IS NULL THEN RAISE EXCEPTION 'no_profile'; END IF;

  -- Anti-spam: at most 5 open requests at a time.
  SELECT count(*) INTO v_pending
  FROM public.coin_topup_requests
  WHERE user_id = v_user AND status = 'pending';
  IF v_pending >= 5 THEN RAISE EXCEPTION 'too_many_pending'; END IF;

  INSERT INTO public.coin_topup_requests (user_id, nick_snapshot, amount, contact)
  VALUES (v_user, v_nick, p_amount, left(trim(COALESCE(p_contact, '')), 200))
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'request_id', v_id);
END;
$$;

-- ── Admin approves (mints coins) or rejects a request ────────────────────────
DROP FUNCTION IF EXISTS public.resolve_coin_topup(uuid, boolean, text);
CREATE OR REPLACE FUNCTION public.resolve_coin_topup(p_id uuid, p_approve boolean, p_note text DEFAULT '')
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin      uuid := auth.uid();
  v_admin_nick text;
  v_req        public.coin_topup_requests%ROWTYPE;
  v_coins      integer;
BEGIN
  IF v_admin IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'not_authorized'; END IF;

  SELECT nick INTO v_admin_nick FROM public.profiles WHERE id = v_admin;

  SELECT * INTO v_req FROM public.coin_topup_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'already_resolved'; END IF;

  IF p_approve THEN
    UPDATE public.profiles SET coins = coins + v_req.amount
     WHERE id = v_req.user_id
    RETURNING coins INTO v_coins;

    IF to_regclass('public.coin_transactions') IS NOT NULL THEN
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES (v_req.user_id, v_req.amount, 'zapps_topup',
              jsonb_build_object('request_id', p_id, 'admin', v_admin_nick));
    END IF;
  END IF;

  UPDATE public.coin_topup_requests
     SET status      = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         admin_note  = left(trim(COALESCE(p_note, '')), 300),
         resolved_at = now(),
         resolved_by = v_admin_nick
   WHERE id = p_id;

  RETURN json_build_object('ok', true, 'approved', p_approve, 'coins_left', v_coins);
END;
$$;

REVOKE ALL ON FUNCTION public.request_coin_topup(integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_coin_topup(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_coin_topup(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_coin_topup(uuid, boolean, text) TO authenticated;

-- ── Realtime so the player's status + the admin console update live ──────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'coin_topup_requests'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.coin_topup_requests;
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
