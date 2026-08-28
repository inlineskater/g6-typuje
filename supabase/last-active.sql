-- profiles.last_active_at — a maintained "when did this player last do anything"
-- stamp, for the „Biuro" list in the side rail.
--
-- WHY A COLUMN AND NOT THE RPC: the rail first shipped reading
-- player_activity_stats(), which UNIONs ~25 event tables, groups them and does a
-- gaps-and-islands streak pass, all to hand the rail one timestamp per player.
-- That is the right shape for the Statystyki card (which wants the streaks and
-- the per-area counts) and the wrong shape for a list that is on screen on every
-- tab: it forced a 5-minute refresh floor, so the column everyone reads was
-- usually stale. Stamping on write turns it into `select id,nick,last_active_at
-- from profiles` — one indexed read of eleven rows.
--
-- player_activity_stats() is NOT replaced or changed; it still owns the
-- Statystyki tab, and this file's backfill seeds itself from it.
--
-- Idempotent: safe to re-run. Re-run it after adding a new event table (add the
-- table to the list below), and after any file that recreates one of the listed
-- tables from scratch — a DROP TABLE takes its trigger with it. Nothing else in
-- the schema depends on this file, and dropping the triggers only makes the
-- stamp stop advancing.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_active_at timestamptz;

COMMENT ON COLUMN public.profiles.last_active_at IS
  'Newest event timestamp across the tables listed in supabase/last-active.sql, maintained by trg_touch_last_active. Advisory: a skipped stamp (see the SKIP LOCKED note) is not an error.';

-- ── The trigger ─────────────────────────────────────────────────────────────
-- One generic function for every table; the timestamp COLUMN NAME is the
-- trigger argument (seasonal scores use submitted_at, canvas_paint_log uses
-- painted_at, everything else created_at), read out of to_jsonb(NEW) so there is
-- one function instead of twenty-eight near-identical ones to keep in sync.
--
-- ⚠️ THE `FOR UPDATE SKIP LOCKED` IS THE WHOLE SAFETY ARGUMENT, not an
-- optimisation. This fires inside other people's transactions — every casino
-- spin, every trade, every coin ledger row — and several of those already hold
-- locks on more than one profiles row (a marketplace sale locks buyer AND
-- seller). An unconditional UPDATE here would add a second, differently-ordered
-- profiles lock to those transactions, which is exactly the shape that made the
-- farm award cron deadlock against the land-tax cron (see
-- farm-seasonal-award-reliability.sql). SKIP LOCKED cannot wait, so it cannot
-- deadlock: a row another transaction holds is simply left alone, and that
-- transaction is itself activity that will stamp it a moment later. Rows locked
-- by the CALLING transaction are not skipped, so the common case — an RPC that
-- did `SELECT … FOR UPDATE` on the player's own profile before inserting — still
-- stamps normally.
--
-- The EXCEPTION block costs a subtransaction per insert. That is deliberate: a
-- cosmetic activity stamp must never be the reason a payout rolls back.
CREATE OR REPLACE FUNCTION public.touch_last_active()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j      jsonb := to_jsonb(NEW);
  v_user uuid;
  v_ts   timestamptz;
BEGIN
  v_user := NULLIF(j->>'user_id', '')::uuid;
  IF v_user IS NULL THEN
    RETURN NULL;                      -- house/bot rows (filler seats, poker bots)
  END IF;
  v_ts := COALESCE(NULLIF(j->>TG_ARGV[0], '')::timestamptz, now());

  UPDATE public.profiles p
     SET last_active_at = v_ts
   WHERE p.id IN (
     SELECT q.id
       FROM public.profiles q
      WHERE q.id = v_user
        AND (q.last_active_at IS NULL OR q.last_active_at < v_ts)
      FOR UPDATE SKIP LOCKED
   );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- ── Install it on every event table ─────────────────────────────────────────
-- The list mirrors player_activity_stats()'s UNION, plus hilo_spins and
-- saper_scores, which shipped after that function was last touched and are
-- therefore missing from it (a real gap this file closes for the rail; fixing
-- the RPC itself is a separate change).
--
-- Tables that do not exist, or that lack user_id or the named timestamp, are
-- SKIPPED with a NOTICE rather than failing the migration — this file has to be
-- runnable on a project that is missing a game or two.
DO $$
DECLARE
  src   text[] := ARRAY[
    -- 🎰 Kasyno
    'roulette_spins:created_at',
    'slots_spins:created_at',
    'plinko_spins:created_at',
    'mines_spins:created_at',
    'crash_spins:created_at',
    'wheel_spins:created_at',
    'hilo_spins:created_at',
    'poker_ledger:created_at',
    -- NOT game_transactions: it is a VIEW over exactly these spin tables plus
    -- poker_ledger, and a view cannot carry a row-level trigger. The relkind
    -- guard below catches this class of mistake for the next person too.
    -- 🎮 Gry sezonowe + wolna arkada
    'whack_boss_scores:submitted_at',
    'bug_jumper_scores:submitted_at',
    'flappy_pants_scores:submitted_at',
    'snake_scores:submitted_at',
    'invoice_horde_scores:submitted_at',
    'var_patrol_scores:submitted_at',
    'egg_catch_scores:submitted_at',
    'super_mariusz_scores:submitted_at',
    'popup_panic_scores:submitted_at',
    'tetris_scores:submitted_at',
    'healer_dungeon_scores:submitted_at',
    'filler_scores:submitted_at',
    'bubble_breaker_scores:submitted_at',
    'saper_scores:submitted_at',
    'arcade_scores:created_at',
    -- 📊 Rynki / ⚽ Mundial / 🎨 Płótno
    'trades:created_at',
    'football_bets:created_at',
    'canvas_paint_log:painted_at',
    -- 🌱 Farma, 🛍️ Targowisko, 🏦 Bank, Sklep … — everything that moves coins
    -- leaves a row here, which is why one entry covers all of them.
    'coin_transactions:created_at'
  ];
  spec  text;
  t     text;
  c     text;
  n_ok  int := 0;
  n_skip int := 0;
BEGIN
  FOREACH spec IN ARRAY src LOOP
    t := split_part(spec, ':', 1);
    c := split_part(spec, ':', 2);

    IF to_regclass('public.' || quote_ident(t)) IS NULL THEN
      RAISE NOTICE 'last-active: skipping %, no such table', t;
      n_skip := n_skip + 1;
      CONTINUE;
    END IF;
    -- Views and matviews cannot carry row-level triggers; stamp their base
    -- tables instead.
    -- alias k, not c: c is the plpgsql column-name variable, and a pg_class
    -- alias of the same name would shadow it inside this subquery.
    IF (SELECT k.relkind FROM pg_class k WHERE k.oid = to_regclass('public.' || quote_ident(t)))
       NOT IN ('r', 'p') THEN
      RAISE NOTICE 'last-active: skipping %, not an ordinary table', t;
      n_skip := n_skip + 1;
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t AND column_name = 'user_id'
    ) OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t AND column_name = c
    ) THEN
      RAISE NOTICE 'last-active: skipping %, missing user_id or %', t, c;
      n_skip := n_skip + 1;
      CONTINUE;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_last_active ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_touch_last_active AFTER INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.touch_last_active(%L)', t, c);
    n_ok := n_ok + 1;
  END LOOP;

  RAISE NOTICE 'last-active: % triggers installed, % skipped', n_ok, n_skip;
END;
$$;

-- ── One-time backfill ───────────────────────────────────────────────────────
-- Seeded from player_activity_stats() itself, so the column starts out agreeing
-- exactly with the panel it is replacing rather than with a hand-rewritten
-- UNION. One row per user, so no aggregate-per-user trap. Guarded because a
-- fresh project may not have run activity-stats.sql yet; without it every player
-- simply starts at NULL („—" in the rail) and stamps forward from their next
-- action.
DO $$
BEGIN
  IF to_regprocedure('public.player_activity_stats()') IS NOT NULL THEN
    UPDATE public.profiles p
       SET last_active_at = s.last_active_at
      FROM public.player_activity_stats() s
     WHERE s.user_id = p.id
       AND s.last_active_at IS NOT NULL
       AND (p.last_active_at IS NULL OR p.last_active_at < s.last_active_at);
    RAISE NOTICE 'last-active: backfilled from player_activity_stats()';
  ELSE
    RAISE NOTICE 'last-active: player_activity_stats() absent, no backfill';
  END IF;
END;
$$;
