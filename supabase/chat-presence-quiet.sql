-- ── Czat G6: make the presence heartbeat quiet ─────────────────────────────
--
-- Run AFTER supabase/chat.sql (supersedes its chat_heartbeat() / chat_set_offline()
-- / chat_presence_sweep cron — re-run this file after re-running that one).
-- Idempotent.
--
-- THE PROBLEM
--
-- chat.sql's chat_heartbeat() did an UNCONDITIONAL
--     UPDATE chat_presence SET last_seen = now(), online = true
-- on every beat. The browser beats every CHAT_HEARTBEAT_MS (25s) per visible tab,
-- and chat_presence is in the `supabase_realtime` publication with the frontend
-- subscribed on `event: '*'`. So every beat became a WAL record, and every WAL
-- record was RLS-evaluated and fanned out to EVERY connected client:
--
--     N users  ->  N writes / 25s  ->  N²/25 realtime messages per second
--
-- all of it discarded on arrival, because chatOnPresence() early-returns when
-- `online` did not actually change. Measured on prod: the realtime WAL query was
-- running ~2×/s with essentially nobody playing. That is a permanent idle floor
-- that grows quadratically with the office.
--
-- THE FIX
--
-- Split the hot column out of the published table. `last_seen` moves to
-- chat_presence_beats, which is deliberately NOT published and has no client
-- grants; chat_presence keeps only the thing peers actually care about (`online`)
-- and is now written ONLY when that value truly flips. A steady stream of
-- heartbeats therefore produces ZERO WAL on the published table, and realtime
-- traffic drops to genuine join/leave events — which is exactly what the ICQ
-- „wszedł/wyszedł z sieci" notices are built from.
--
-- Nothing changes for the frontend: it reads `chat_presence(user_id, online)`
-- and subscribes to the same table. chat_heartbeat() still returns the
-- authoritative online list, so chatReconcileOnline() keeps working unchanged.
--
-- chat_presence.last_seen is intentionally KEPT (not dropped): it stays as the
-- fallback for any presence row that predates the beats table, and dropping a
-- column from a realtime-published table is not worth the churn.

-- ── Beats table (unpublished, server-only) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.chat_presence_beats (
  user_id   uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_seen timestamptz NOT NULL DEFAULT now()
);

-- Sweeps scan for stale beats.
CREATE INDEX IF NOT EXISTS chat_presence_beats_last_seen_idx
  ON public.chat_presence_beats(last_seen);

-- No client access at all — only the SECURITY DEFINER functions below touch it.
-- RLS on with zero policies means even a leaked grant reads nothing.
ALTER TABLE public.chat_presence_beats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_presence_beats FROM anon, authenticated;

-- Seed from whatever presence rows already exist, so the first sweep after this
-- migration has a beat for every user and nobody is wrongly swept offline.
INSERT INTO public.chat_presence_beats (user_id, last_seen)
SELECT user_id, last_seen FROM public.chat_presence
ON CONFLICT (user_id) DO NOTHING;

-- Guard against this table ever being published by a future copy/paste: it would
-- silently reintroduce exactly the fanout this migration exists to remove.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'chat_presence_beats'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.chat_presence_beats;
  END IF;
END $$;

-- ── RPC: chat_heartbeat (quiet) ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.chat_heartbeat()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_stale constant interval := interval '90 seconds';  -- CHAT_STALE (mirrors index.html)
  v_online uuid[];
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  -- (1) The beat itself. Unpublished table -> no realtime traffic, every 25s.
  INSERT INTO public.chat_presence_beats (user_id, last_seen)
  VALUES (v_user, now())
  ON CONFLICT (user_id) DO UPDATE SET last_seen = now();

  -- (2) Presence row. The ON CONFLICT ... WHERE makes the UPDATE conditional:
  -- when I am already online this writes NO row, so it emits no WAL and no
  -- realtime message. Only a real offline->online flip (or a first-ever INSERT)
  -- reaches subscribers.
  INSERT INTO public.chat_presence (user_id, last_seen, online)
  VALUES (v_user, now(), true)
  ON CONFLICT (user_id) DO UPDATE
     SET online = true, last_seen = now()
   WHERE public.chat_presence.online IS DISTINCT FROM true;

  -- (3) Sweep abandoned (closed-tab) sessions. COALESCE keeps any pre-migration
  -- row without a beat sweepable via its own last_seen.
  UPDATE public.chat_presence p
     SET online = false
   WHERE p.online = true
     AND COALESCE(
           (SELECT b.last_seen FROM public.chat_presence_beats b WHERE b.user_id = p.user_id),
           p.last_seen
         ) < now() - v_stale;

  SELECT COALESCE(array_agg(user_id), '{}') INTO v_online
    FROM public.chat_presence WHERE online = true;

  RETURN json_build_object('online', v_online);
END;
$$;

-- ── RPC: chat_set_offline (guarded) ────────────────────────────────────────
-- Same immediate-flip-on-logout contract as before, but guarded so a repeated
-- call (logout twice, or a logout while already swept offline) is a no-op
-- instead of another broadcast to every client.

CREATE OR REPLACE FUNCTION public.chat_set_offline()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RETURN; END IF;

  UPDATE public.chat_presence
     SET online = false
   WHERE user_id = v_user
     AND online IS DISTINCT FROM false;

  -- Age the beat out too, so a stale row can never re-read as fresh.
  UPDATE public.chat_presence_beats
     SET last_seen = now() - interval '1 day'
   WHERE user_id = v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_heartbeat()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_set_offline() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_heartbeat()   TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_set_offline() TO authenticated;

-- ── Presence sweep cron ────────────────────────────────────────────────────
-- Unchanged in purpose (the LAST user to leave has nobody to sweep them), but
-- repointed at the beats table. Still already-guarded by `online = true`, so it
-- writes — and therefore broadcasts — only when something really flips.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
      FROM cron.job WHERE jobname = 'chat_presence_sweep';
    PERFORM cron.schedule(
      'chat_presence_sweep',
      '* * * * *',
      $job$UPDATE public.chat_presence p
              SET online = false
            WHERE p.online = true
              AND COALESCE(
                    (SELECT b.last_seen FROM public.chat_presence_beats b WHERE b.user_id = p.user_id),
                    p.last_seen
                  ) < now() - interval '90 seconds'$job$
    );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
