-- „Wspólne Płótno" — make every pixel free (no more cooldown / 1-coin paid tier).
-- Run in Supabase SQL Editor after supabase/canvas.sql. Idempotent (CREATE OR REPLACE).
--
-- Supersedes canvas.sql's place_pixel(): drops the 2h-free / pay-1-coin split
-- entirely — every placed pixel is now free for every user, always. The
-- canvas_cooldowns table is left in place (harmless, just unused) to avoid a
-- destructive DDL change; last_free_at is simply no longer read or written.
--
-- ⚠️ This file's place_pixel() copy is superseded by supabase/canvas-paint-log.sql
-- (adds a canvas_paint_log insert for Loteria ticket history). Re-run that file
-- after re-running this one.

CREATE OR REPLACE FUNCTION public.place_pixel(p_x integer, p_y integer, p_color text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_nick text;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  -- Bounds (mirrors CANVAS_W=192 / CANVAS_H=108 in index.html)
  IF p_x < 0 OR p_x >= 192 OR p_y < 0 OR p_y >= 108 THEN RAISE EXCEPTION 'bad_coords'; END IF;
  IF p_color !~ '^#[0-9A-Fa-f]{6}$' THEN RAISE EXCEPTION 'bad_color'; END IF;

  SELECT nick INTO v_nick FROM public.profiles WHERE id = v_user;
  IF v_nick IS NULL THEN RAISE EXCEPTION 'no_profile'; END IF;

  INSERT INTO public.canvas_pixels (x, y, color, last_user_id, last_nick, updated_at)
  VALUES (p_x, p_y, p_color, v_user, v_nick, now())
  ON CONFLICT (x, y) DO UPDATE
    SET color = EXCLUDED.color,
        last_user_id = EXCLUDED.last_user_id,
        last_nick = EXCLUDED.last_nick,
        updated_at = EXCLUDED.updated_at;

  RETURN json_build_object(
    'paid', false,
    'pixel', json_build_object('x', p_x, 'y', p_y, 'color', p_color)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.place_pixel(integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_pixel(integer, integer, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
