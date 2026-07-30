-- Arcade ("Wszystkie Gry") tables and RPCs.
-- Run after schema.sql and coin-transactions.sql.

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.arcade_scores (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  game_type  text NOT NULL,
  score      integer NOT NULL DEFAULT 0,
  coins_paid integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Small, game-owned, opt-in JSON tag on a score row — e.g. Uzdrowiciel's
  -- {cls, icon, name} so its leaderboards can show which class scored what.
  -- Generic on purpose: any arcade game may attach one via record_arcade_score
  -- without a schema change, but this path is client-callable, so the RPC
  -- below caps its byte size rather than trusting the shape.
  client_meta jsonb
);
ALTER TABLE public.arcade_scores ADD COLUMN IF NOT EXISTS client_meta jsonb;

CREATE INDEX IF NOT EXISTS arcade_scores_user_game_idx
  ON public.arcade_scores(user_id, game_type, created_at DESC);
CREATE INDEX IF NOT EXISTS arcade_scores_game_score_idx
  ON public.arcade_scores(game_type, score DESC);
CREATE INDEX IF NOT EXISTS arcade_scores_best_per_user_idx
  ON public.arcade_scores(game_type, user_id, score DESC, created_at ASC);

ALTER TABLE public.arcade_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "arcade_scores_insert" ON public.arcade_scores;
DROP POLICY IF EXISTS "arcade_scores_read" ON public.arcade_scores;
DROP POLICY IF EXISTS "arcade_scores_select" ON public.arcade_scores;
CREATE POLICY "arcade_scores_select" ON public.arcade_scores
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.arcade_scores FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.arcade_scores TO authenticated;
-- Server-validated games may write official archive results directly. Browser
-- roles still have read-only access and cannot bypass their game verifier.
GRANT SELECT, INSERT ON public.arcade_scores TO service_role;

-- ── Leaderboard view (best score per user per game) ─────────────────────────

CREATE OR REPLACE VIEW public.arcade_leaderboard WITH (security_invoker = true) AS
SELECT DISTINCT ON (game_type, user_id)
  s.id,
  s.game_type,
  s.score,
  s.coins_paid,
  s.created_at,
  s.user_id,
  s.client_meta,
  p.nick
FROM public.arcade_scores s
JOIN public.profiles p ON p.id = s.user_id
ORDER BY game_type, user_id, score DESC, created_at ASC;

REVOKE ALL ON public.arcade_leaderboard FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.arcade_leaderboard TO authenticated;

-- ── pay_arcade_entry — validate entry and return the caller's balance ───────
-- 2026-07: Wszystkie Gry is free forever — no coin is deducted anymore and no
-- coin_transactions row is written. The RPC is kept (same name/signature) so
-- the frontend's per-game call sites don't need to change; it still checks
-- auth + game_type before a round starts.

CREATE OR REPLACE FUNCTION public.pay_arcade_entry(p_game_type text DEFAULT 'unknown')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_coins integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_game_type NOT IN (
    'whack_boss', 'bug_jumper', 'flappy_pants', 'snake',
    'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz', 'popup_panic',
    'tetris', 'healer_dungeon'
  ) THEN
    RAISE EXCEPTION 'invalid_game_type';
  END IF;

  SELECT coins INTO v_coins FROM profiles WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;

  RETURN v_coins;
END;
$$;

REVOKE ALL ON FUNCTION public.pay_arcade_entry(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pay_arcade_entry(text) TO authenticated;

-- ── record_arcade_score — insert a score row (called by JS after game ends) ──
-- 2026-07: entry is free, so the old "must have an unspent paid entry" gate
-- (which doubled as the only anti-spam throttle on this client-callable RPC)
-- is gone too. Replaced with a flat per-user-per-game cooldown — 5s is well
-- under every arcade game's real round length (shortest is ~15s), so it
-- never affects a genuine player clicking "Zagraj ponownie", but it stops a
-- script from calling this RPC in a tight loop to flood the table.
--
-- 2026-07-30: gained a 3rd argument, p_meta, so a game can tag its own score
-- row with a small opt-in JSON blob (Uzdrowiciel uses {cls,icon,name} so the
-- leaderboard can show which class played it). The 2-arg overload is DROPped
-- rather than left alongside a 3-arg default-NULL version — Postgres resolves
-- a 2-arg call to an EXACT 2-arg overload over a defaulted 3-arg one, so the
-- two would silently coexist with the new one dead for every existing caller.

DROP FUNCTION IF EXISTS public.record_arcade_score(text, integer);

CREATE OR REPLACE FUNCTION public.record_arcade_score(p_game_type text, p_score integer, p_meta jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_score_cap integer;
  v_last_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  -- p_meta is client-supplied on a client-callable RPC — cap its size rather
  -- than trust its shape. 2000 bytes is generous for a flavor tag like
  -- {cls,icon,name} and nowhere near enough to matter as storage abuse.
  IF p_meta IS NOT NULL AND pg_column_size(p_meta) > 2000 THEN
    RAISE EXCEPTION 'meta_too_large';
  END IF;

  v_score_cap := CASE p_game_type
    WHEN 'whack_boss'    THEN 60
    WHEN 'bug_jumper'    THEN 30
    WHEN 'flappy_pants'  THEN 200
    WHEN 'snake'         THEN 500
    WHEN 'invoice_horde' THEN 200
    WHEN 'var_patrol'    THEN 100
    WHEN 'egg_catch'     THEN 1000
    WHEN 'super_mariusz' THEN 455
    WHEN 'popup_panic'   THEN 2000
    WHEN 'tetris'        THEN 9999
    -- „Uzdrowiciel G6": the score is POINTS, not pulls (2026-07-29) — pull
    -- depth (bosses ×2) + effective healing scaled by precision + a flawless
    -- bonus per death-free pull (2026-07-30) + a tempo bonus for pulling
    -- quickly after a rest. Deliberately DOZENS, not thousands: a good run
    -- measures 30-60 and the deepest plausible one is still well under 200,
    -- so a one-pull difference is visible on the board. Arcade scores are
    -- client-reported, so this cap is the only guard on this path.
    -- ⚠️ Rows written before 2026-07-29 hold PULLS CLEARED (1-20) and are not
    -- comparable with anything above; delete them if the board looks odd.
    WHEN 'healer_dungeon' THEN 999
    ELSE NULL
  END;
  IF v_score_cap IS NULL THEN RAISE EXCEPTION 'invalid_game_type'; END IF;
  IF p_score IS NULL OR p_score < 0 OR p_score > v_score_cap THEN
    RAISE EXCEPTION 'invalid_score';
  END IF;

  -- Serialize submissions per user so two concurrent RPC calls can't both
  -- pass the cooldown check for the same round.
  PERFORM 1 FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;

  SELECT MAX(created_at) INTO v_last_at FROM public.arcade_scores
   WHERE user_id = v_uid AND game_type = p_game_type;

  IF v_last_at IS NOT NULL AND now() - v_last_at < interval '5 seconds' THEN
    RAISE EXCEPTION 'submitting too fast';
  END IF;

  INSERT INTO arcade_scores(user_id, game_type, score, coins_paid, client_meta)
  VALUES (v_uid, p_game_type, p_score, 0, p_meta);
END;
$$;

REVOKE ALL ON FUNCTION public.record_arcade_score(text, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_arcade_score(text, integer, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
