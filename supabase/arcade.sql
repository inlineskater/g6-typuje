-- Arcade ("Wszystkie Gry") tables and RPCs.
-- Run after schema.sql and coin-transactions.sql.

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.arcade_scores (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  game_type  text NOT NULL,
  score      integer NOT NULL DEFAULT 0,
  coins_paid integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS arcade_scores_user_game_idx
  ON public.arcade_scores(user_id, game_type, created_at DESC);
CREATE INDEX IF NOT EXISTS arcade_scores_game_score_idx
  ON public.arcade_scores(game_type, score DESC);

ALTER TABLE public.arcade_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "arcade_scores_select" ON public.arcade_scores;
CREATE POLICY "arcade_scores_select" ON public.arcade_scores
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.arcade_scores FROM anon, authenticated;
GRANT SELECT ON public.arcade_scores TO authenticated;

-- ── Leaderboard view (best score per user per game) ─────────────────────────

CREATE OR REPLACE VIEW public.arcade_leaderboard AS
SELECT DISTINCT ON (game_type, user_id)
  s.game_type,
  s.user_id,
  p.nick,
  s.score,
  s.coins_paid,
  s.created_at
FROM public.arcade_scores s
JOIN public.profiles p ON p.id = s.user_id
ORDER BY game_type, user_id, score DESC, created_at ASC;

GRANT SELECT ON public.arcade_leaderboard TO authenticated;

-- ── pay_arcade_entry — deduct 1 coin and log the transaction ────────────────
-- p_game_type is stored in coin_transactions.meta so Portfel can show it.

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

  UPDATE profiles
  SET coins = coins - 1
  WHERE id = v_uid AND coins >= 1
  RETURNING coins INTO v_coins;

  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient coins'; END IF;

  INSERT INTO coin_transactions(user_id, delta, reason, meta)
  VALUES (v_uid, -1, 'arcade_entry', jsonb_build_object('game_type', p_game_type));

  RETURN v_coins;
END;
$$;

REVOKE ALL ON FUNCTION public.pay_arcade_entry(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pay_arcade_entry(text) TO authenticated;

-- ── record_arcade_score — insert a score row (called by JS after game ends) ──

CREATE OR REPLACE FUNCTION public.record_arcade_score(p_game_type text, p_score integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  INSERT INTO arcade_scores(user_id, game_type, score, coins_paid)
  VALUES (v_uid, p_game_type, p_score, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.record_arcade_score(text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_arcade_score(text, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
