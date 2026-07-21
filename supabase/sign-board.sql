-- „Tablica ogłoszeń" — a communal sign board hanging in the Ogródek (Farma) sky.
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run).
-- Idempotent (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE).
--
-- One shared board. Any logged-in user may rent the board for 100🪙 per day
-- (24h per day, 1–7 days at a time, coins BURNED). While a message is live
-- (expires_at > now()) the board is TAKEN — nobody else can buy until it
-- expires (one-owner-at-a-time). Published text is immutable.
-- The browser has SELECT-only access; all writes go through the RPCs below.
--
-- Constants mirrored in index.html: SIGN_BOARD_PRICE (100), SIGN_BOARD_MAX_DAYS
-- (7), SIGN_BOARD_MAX_LEN (80). Keep them in sync.

-- ── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sign_board_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  message       text NOT NULL,
  days          integer NOT NULL,
  coins_paid    integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sign_board_expires_idx
  ON public.sign_board_messages (expires_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.sign_board_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sign_board_select" ON public.sign_board_messages;
CREATE POLICY "sign_board_select" ON public.sign_board_messages
  FOR SELECT TO anon, authenticated USING (true);

-- No direct client writes — everything goes through the RPCs.
REVOKE ALL ON public.sign_board_messages FROM anon, authenticated;
GRANT SELECT ON public.sign_board_messages TO anon, authenticated;

-- ── Realtime ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'sign_board_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sign_board_messages;
  END IF;
END;
$$;

-- ── RPC: buy_sign_board ───────────────────────────────────────────────────────
-- Validates message + days, enforces the one-owner-at-a-time rule under an
-- advisory lock (so two concurrent buys can't both claim the board), burns
-- 100🪙 × days, and inserts the message. Returns the new balance + expiry.

CREATE OR REPLACE FUNCTION public.buy_sign_board(p_message text, p_days integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user       uuid := auth.uid();
  v_nick       text;
  v_msg        text;
  v_cost       integer;
  v_coins_left integer;
  v_expires    timestamptz;
  v_id         uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  v_msg := btrim(coalesce(p_message, ''));
  IF length(v_msg) = 0 THEN RAISE EXCEPTION 'empty_message'; END IF;
  IF length(v_msg) > 80 THEN RAISE EXCEPTION 'message_too_long'; END IF;
  -- collapse any newlines/tabs — the board is a single small line
  v_msg := regexp_replace(v_msg, '\s+', ' ', 'g');

  IF p_days IS NULL OR p_days < 1 OR p_days > 7 THEN RAISE EXCEPTION 'bad_days'; END IF;
  v_cost := 100 * p_days;

  -- Serialize board claims (arbitrary constant lock key for this feature).
  PERFORM pg_advisory_xact_lock(hashtext('sign_board'));

  IF EXISTS (SELECT 1 FROM public.sign_board_messages WHERE expires_at > now()) THEN
    RAISE EXCEPTION 'board_taken';
  END IF;

  SELECT nick INTO v_nick FROM public.profiles WHERE id = v_user;
  IF v_nick IS NULL THEN RAISE EXCEPTION 'no_profile'; END IF;

  UPDATE public.profiles
     SET coins = coins - v_cost
   WHERE id = v_user
     AND coins >= v_cost
  RETURNING coins INTO v_coins_left;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  v_expires := now() + (p_days * interval '24 hours');

  INSERT INTO public.sign_board_messages (user_id, nick_snapshot, message, days, coins_paid, expires_at)
  VALUES (v_user, v_nick, v_msg, p_days, v_cost, v_expires)
  RETURNING id INTO v_id;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_cost, 'sign_board_buy',
            jsonb_build_object('days', p_days, 'message', v_msg));
  END IF;

  RETURN json_build_object(
    'ok', true,
    'id', v_id,
    'coins_left', v_coins_left,
    'expires_at', v_expires
  );
END;
$$;

REVOKE ALL ON FUNCTION public.buy_sign_board(text, integer)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buy_sign_board(text, integer) TO authenticated;

-- Remove the legacy edit endpoint if an earlier version of this file created it.
-- The message is deliberately immutable for the full rental period.
DROP FUNCTION IF EXISTS public.update_sign_board(text);

NOTIFY pgrst, 'reload schema';
