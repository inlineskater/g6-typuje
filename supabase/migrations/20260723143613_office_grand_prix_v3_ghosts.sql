-- Office Grand Prix V3: async ghosts replace the live lobby/coordinator
-- model. Every race is now its own solo session (start_race creates it
-- already 'racing', with the caller in slot 0 and 7 bots filling the rest),
-- so the single-shared-active-session constraint must go. The
-- coordinator/realtime-channel machinery is no longer used at all.
--
-- Run after office-grand-prix.sql. Idempotent.

DROP INDEX IF EXISTS public.office_grand_prix_one_active_session_idx;
DROP INDEX IF EXISTS public.office_grand_prix_sessions_coordinator_idx;

DROP POLICY IF EXISTS "office_grand_prix_realtime_receive" ON realtime.messages;
DROP POLICY IF EXISTS "office_grand_prix_realtime_send" ON realtime.messages;

NOTIFY pgrst, 'reload schema';
