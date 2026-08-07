-- Office chat (ICQ-style) — public room + private whispers + heartbeat presence
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run).
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE / guarded cron. Safe to re-run.
--
-- A left-rail chat present on every tab. One shared public room plus 1-on-1
-- whispers that also reach OFFLINE users (delivered when they next log in).
-- Online/offline is a last_seen heartbeat, exactly like roulette seats: the
-- browser pings chat_heartbeat() every CHAT_HEARTBEAT_MS (25s, in index.html)
-- while the app is visible; a user is "online" until their last_seen is older
-- than CHAT_STALE (90s below). The online→offline / offline→online flip on
-- chat_presence.online is the realtime signal the frontend turns into ICQ
-- "wszedł/wyszedł z sieci" notices.
--
-- No Edge Function: this uses the direct SECURITY DEFINER RPC pattern from
-- canvas.sql (place_pixel) — the browser has SELECT-only table access and every
-- write goes through an auth.uid()-scoped RPC.
--
-- Constants mirrored in index.html: CHAT_STALE (90s) ↔ CHAT_HEARTBEAT_MS (25s,
-- keep client ≤ ⅓ of stale), CHAT_MAX_LEN (1000), min send interval (1s).

-- ── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sender_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipient_id uuid     REFERENCES public.profiles(id) ON DELETE CASCADE,  -- NULL ⇒ public room
  sender_nick  text NOT NULL,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz
);

-- Public room, newest-first paging.
CREATE INDEX IF NOT EXISTS chat_messages_public_idx
  ON public.chat_messages(created_at DESC)
  WHERE recipient_id IS NULL;

-- Whisper thread lookup: both directions of a pair collapse onto one key.
CREATE INDEX IF NOT EXISTS chat_messages_pair_idx
  ON public.chat_messages(
    LEAST(sender_id, recipient_id),
    GREATEST(sender_id, recipient_id),
    created_at DESC)
  WHERE recipient_id IS NOT NULL;

-- Unread-badge lookup (whispers addressed to me, not yet read).
CREATE INDEX IF NOT EXISTS chat_messages_unread_idx
  ON public.chat_messages(recipient_id)
  WHERE recipient_id IS NOT NULL AND read_at IS NULL;

CREATE TABLE IF NOT EXISTS public.chat_presence (
  user_id   uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_seen timestamptz NOT NULL DEFAULT now(),
  online    boolean NOT NULL DEFAULT false
);

-- ── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_presence ENABLE ROW LEVEL SECURITY;

-- Public messages: everyone. Whispers: only the two parties. Realtime honors
-- this policy, so a whisper INSERT is delivered only to sender + recipient.
DROP POLICY IF EXISTS "chat_messages_select" ON public.chat_messages;
CREATE POLICY "chat_messages_select" ON public.chat_messages
  FOR SELECT TO authenticated
  USING (recipient_id IS NULL OR auth.uid() IN (sender_id, recipient_id));

-- Presence is public read (drives the roster + online count).
DROP POLICY IF EXISTS "chat_presence_select" ON public.chat_presence;
CREATE POLICY "chat_presence_select" ON public.chat_presence
  FOR SELECT TO authenticated USING (true);

-- No direct client writes — everything goes through the RPCs below.
REVOKE ALL ON public.chat_messages, public.chat_presence FROM anon, authenticated;
GRANT SELECT ON public.chat_messages TO authenticated;
GRANT SELECT ON public.chat_presence TO authenticated;

-- ── Realtime ───────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_presence'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_presence;
  END IF;
END;
$$;

-- ── RPC: chat_send ─────────────────────────────────────────────────────────
-- Sends a public (p_recipient NULL) or whisper message. Trims, caps length,
-- and rate-limits to ≥1s between sends per user (the only anti-spam throttle,
-- like record_arcade_score). Whispering an OFFLINE user is allowed — the row is
-- stored and shown when they return. Returns the inserted row.

CREATE OR REPLACE FUNCTION public.chat_send(p_recipient uuid, p_body text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_nick text;
  v_body text;
  v_last timestamptz;
  v_row  public.chat_messages;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  v_body := btrim(p_body);
  IF v_body = '' OR v_body IS NULL THEN RAISE EXCEPTION 'empty_message'; END IF;
  IF length(v_body) > 1000 THEN RAISE EXCEPTION 'message_too_long'; END IF;  -- CHAT_MAX_LEN

  SELECT nick INTO v_nick FROM public.profiles WHERE id = v_user;
  IF v_nick IS NULL THEN RAISE EXCEPTION 'no_profile'; END IF;

  IF p_recipient IS NOT NULL THEN
    IF p_recipient = v_user THEN RAISE EXCEPTION 'no_self_whisper'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_recipient) THEN
      RAISE EXCEPTION 'no_such_recipient';
    END IF;
  END IF;

  -- Rate-limit: ≥1s since this user's previous message.
  SELECT created_at INTO v_last
    FROM public.chat_messages
    WHERE sender_id = v_user
    ORDER BY created_at DESC
    LIMIT 1;
  IF v_last IS NOT NULL AND now() - v_last < interval '1 second' THEN
    RAISE EXCEPTION 'too_fast';
  END IF;

  INSERT INTO public.chat_messages (sender_id, recipient_id, sender_nick, body)
  VALUES (v_user, p_recipient, v_nick, v_body)
  RETURNING * INTO v_row;

  RETURN json_build_object(
    'id',           v_row.id,
    'sender_id',    v_row.sender_id,
    'recipient_id', v_row.recipient_id,
    'sender_nick',  v_row.sender_nick,
    'body',         v_row.body,
    'created_at',   v_row.created_at
  );
END;
$$;

-- ── RPC: chat_heartbeat ────────────────────────────────────────────────────
-- Marks the caller online (flip emits the "wszedł do sieci" realtime signal),
-- then sweeps everyone whose last_seen is stale to offline (each flip emits a
-- "wyszedł z sieci" signal) — the presence analog of roulette's evictStaleSeats.
-- Returns the current online user-id list.

CREATE OR REPLACE FUNCTION public.chat_heartbeat()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_stale constant interval := interval '90 seconds';  -- CHAT_STALE
  v_online uuid[];
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  -- Upsert my presence; coming back from stale/offline flips online=true.
  INSERT INTO public.chat_presence (user_id, last_seen, online)
  VALUES (v_user, now(), true)
  ON CONFLICT (user_id) DO UPDATE
    SET last_seen = now(),
        online = true;

  -- Sweep abandoned (closed-tab) sessions to offline.
  UPDATE public.chat_presence
     SET online = false
   WHERE online = true
     AND last_seen < now() - v_stale;

  SELECT COALESCE(array_agg(user_id), '{}') INTO v_online
    FROM public.chat_presence WHERE online = true;

  RETURN json_build_object('online', v_online);
END;
$$;

-- ── RPC: chat_set_offline ──────────────────────────────────────────────────
-- Immediate offline flip on logout, so peers see "wyszedł z sieci" at once
-- instead of after the stale window. Closed tabs still rely on the sweep.

CREATE OR REPLACE FUNCTION public.chat_set_offline()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RETURN; END IF;
  UPDATE public.chat_presence SET online = false WHERE user_id = v_user;
END;
$$;

-- ── RPC: chat_mark_read ────────────────────────────────────────────────────
-- Clears the unread badge for a whisper thread: marks every unread message
-- FROM p_peer TO me as read.

CREATE OR REPLACE FUNCTION public.chat_mark_read(p_peer uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  UPDATE public.chat_messages
     SET read_at = now()
   WHERE recipient_id = v_user
     AND sender_id = p_peer
     AND read_at IS NULL;
END;
$$;

-- ── Grants ─────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.chat_send(uuid, text)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_heartbeat()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_set_offline()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_mark_read(uuid)      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_send(uuid, text)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_heartbeat()       TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_set_offline()     TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_mark_read(uuid)   TO authenticated;

-- ── Presence sweep cron ────────────────────────────────────────────────────
-- The heartbeat sweeps stale sessions, but the LAST user to leave has no one to
-- sweep them — their row would read online=true forever. A minute cron closes
-- that gap so the roster / online count self-heal even when the app is empty.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
      FROM cron.job WHERE jobname = 'chat_presence_sweep';
    PERFORM cron.schedule(
      'chat_presence_sweep',
      '* * * * *',
      $job$UPDATE public.chat_presence SET online = false
             WHERE online = true AND last_seen < now() - interval '90 seconds'$job$
    );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
