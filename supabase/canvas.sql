-- Wspólne Płótno (Collaborative Canvas) — shared r/place-style pixel art board
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run)
--
-- One shared 192x108 (16:9) grid. Every authenticated user may place one FREE
-- pixel per cooldown window (default 2h). While on cooldown they may keep
-- painting by paying 1 coin per pixel (coins burned). The server owns the
-- cooldown / free-vs-paid decision; the browser has SELECT-only access and all
-- writes go through the place_pixel() RPC.
--
-- Grid bounds (192 x 108) are mirrored in index.html as CANVAS_W / CANVAS_H —
-- keep them in sync. Cooldown is the single `interval '2 hours'` constant below.

-- ── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.canvas_pixels (
  x            integer NOT NULL,
  y            integer NOT NULL,
  color        text NOT NULL,
  last_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  last_nick    text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (x, y)
);

CREATE TABLE IF NOT EXISTS public.canvas_cooldowns (
  user_id      uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_free_at timestamptz
);

-- ── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.canvas_pixels    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canvas_cooldowns ENABLE ROW LEVEL SECURITY;

-- Board is public read; cooldown row is readable only by its owner.
DROP POLICY IF EXISTS "canvas_pixels_select" ON public.canvas_pixels;
CREATE POLICY "canvas_pixels_select" ON public.canvas_pixels
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "canvas_cooldowns_select_own" ON public.canvas_cooldowns;
CREATE POLICY "canvas_cooldowns_select_own" ON public.canvas_cooldowns
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- No direct client writes — everything goes through place_pixel().
REVOKE ALL ON public.canvas_pixels, public.canvas_cooldowns FROM anon, authenticated;
GRANT SELECT ON public.canvas_pixels TO anon, authenticated;
GRANT SELECT ON public.canvas_cooldowns TO authenticated;

-- ── Realtime ───────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'canvas_pixels'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.canvas_pixels;
  END IF;
END;
$$;

-- ── RPC: place_pixel ───────────────────────────────────────────────────────
-- Validates bounds + color, enforces the cooldown server-side, and upserts the
-- pixel last-write-wins (ON CONFLICT) so simultaneous clicks resolve to one
-- final color. Returns whether the pixel was paid, the caller's coin balance,
-- and the timestamp of the next free pixel.

CREATE OR REPLACE FUNCTION public.place_pixel(p_x integer, p_y integer, p_color text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user     uuid := auth.uid();
  v_cooldown constant interval := interval '2 hours';
  v_last     timestamptz;
  v_paid     boolean := false;
  v_coins    integer;
  v_nick     text;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  -- Bounds (mirrors CANVAS_W=192 / CANVAS_H=108 in index.html)
  IF p_x < 0 OR p_x >= 192 OR p_y < 0 OR p_y >= 108 THEN RAISE EXCEPTION 'bad_coords'; END IF;
  IF p_color !~ '^#[0-9A-Fa-f]{6}$' THEN RAISE EXCEPTION 'bad_color'; END IF;

  SELECT nick INTO v_nick FROM public.profiles WHERE id = v_user;
  IF v_nick IS NULL THEN RAISE EXCEPTION 'no_profile'; END IF;

  -- Lock (or create) the caller's cooldown row.
  INSERT INTO public.canvas_cooldowns (user_id, last_free_at)
  VALUES (v_user, NULL)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT last_free_at INTO v_last
    FROM public.canvas_cooldowns WHERE user_id = v_user FOR UPDATE;

  IF v_last IS NULL OR v_last + v_cooldown <= now() THEN
    -- Free pixel: resets the cooldown timer.
    v_paid := false;
    v_last := now();
    UPDATE public.canvas_cooldowns SET last_free_at = v_last WHERE user_id = v_user;
  ELSE
    -- On cooldown: pay 1 coin, leave last_free_at untouched so the free pixel
    -- still arrives on its original schedule.
    v_paid := true;
    SELECT coins INTO v_coins FROM public.profiles WHERE id = v_user FOR UPDATE;
    IF v_coins < 1 THEN RAISE EXCEPTION 'insufficient_coins'; END IF;
    UPDATE public.profiles SET coins = coins - 1 WHERE id = v_user;
    IF to_regclass('public.coin_transactions') IS NOT NULL THEN
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES (
        v_user,
        -1,
        'canvas_pixel',
        jsonb_build_object('x', p_x, 'y', p_y, 'color', p_color)
      );
    END IF;
  END IF;

  INSERT INTO public.canvas_pixels (x, y, color, last_user_id, last_nick, updated_at)
  VALUES (p_x, p_y, p_color, v_user, v_nick, now())
  ON CONFLICT (x, y) DO UPDATE
    SET color = EXCLUDED.color,
        last_user_id = EXCLUDED.last_user_id,
        last_nick = EXCLUDED.last_nick,
        updated_at = EXCLUDED.updated_at;

  SELECT coins INTO v_coins FROM public.profiles WHERE id = v_user;

  RETURN json_build_object(
    'paid',         v_paid,
    'coins',        v_coins,
    'next_free_at', v_last + v_cooldown,
    'pixel', json_build_object('x', p_x, 'y', p_y, 'color', p_color)
  );
END;
$$;

-- ── Grants ─────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.place_pixel(integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_pixel(integer, integer, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
