-- „Wspólne Płótno" — per-paint history log for accurate Loteria ticket counting.
-- Run after canvas.sql + canvas-free-for-all.sql + lottery.sql. Idempotent.
--
-- Why: the Loteria's "days painted" ticket count previously read canvas_pixels,
-- but that table is last-write-wins (place_pixel does ON CONFLICT (x,y) DO
-- UPDATE) — it only reflects each pixel's CURRENT painter, so a player's
-- earlier painting days vanish the moment someone else paints over that pixel.
-- This under-counts real activity with no way to reconstruct the lost days.
--
-- canvas_paint_log fixes this going forward by recording every place_pixel
-- call as its own row, independent of what happens to that pixel afterwards.
-- It is written only by place_pixel() and read only by
-- mundial_lottery_standings() (both SECURITY DEFINER) — no client grants.

CREATE TABLE IF NOT EXISTS public.canvas_paint_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES public.profiles(id),
  painted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canvas_paint_log_user_idx ON public.canvas_paint_log(user_id);

ALTER TABLE public.canvas_paint_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.canvas_paint_log FROM PUBLIC, anon, authenticated;

-- ── RPC: place_pixel — supersedes canvas.sql / canvas-free-for-all.sql's copy ──
-- (adds one canvas_paint_log insert; everything else unchanged)

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

  INSERT INTO public.canvas_paint_log (user_id, painted_at) VALUES (v_user, now());

  RETURN json_build_object(
    'paid', false,
    'pixel', json_build_object('x', p_x, 'y', p_y, 'color', p_color)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.place_pixel(integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_pixel(integer, integer, text) TO authenticated;

-- ── RPC: mundial_lottery_standings — supersedes lottery.sql's copy ──────────
-- (only the `canvas` CTE changes: union canvas_pixels' current-owner days
-- with canvas_paint_log's logged days, so no one's existing tally regresses
-- and every day painted from here on counts correctly)

CREATE OR REPLACE FUNCTION public.mundial_lottery_standings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH mundial AS (
  SELECT user_id, LEAST(15, count(*)) t
  FROM football_bets WHERE status IN ('won','lost') GROUP BY user_id),
markets AS (
  SELECT user_id, LEAST(10, count(*)) t FROM trades GROUP BY user_id),
casino AS (
  SELECT user_id, LEAST(10, count(DISTINCT d)) t FROM (
    SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date d FROM plinko_spins
    UNION ALL SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date FROM mines_spins
    UNION ALL SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date FROM crash_spins
    UNION ALL SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date FROM wheel_spins
    UNION ALL SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date FROM roulette_spins
    UNION ALL SELECT user_id, (created_at AT TIME ZONE 'Europe/Warsaw')::date FROM slots_spins
  ) s GROUP BY user_id),
seasonal AS (
  SELECT user_id, LEAST(8, count(DISTINCT wk)) t FROM (
    SELECT user_id, week_start wk FROM whack_boss_scores
    UNION ALL SELECT user_id, week_start FROM bug_jumper_scores
    UNION ALL SELECT user_id, week_start FROM flappy_pants_scores
    UNION ALL SELECT user_id, week_start FROM snake_scores
    UNION ALL SELECT user_id, week_start FROM invoice_horde_scores
    UNION ALL SELECT user_id, week_start FROM var_patrol_scores
    UNION ALL SELECT user_id, week_start FROM egg_catch_scores
    UNION ALL SELECT user_id, week_start FROM super_mariusz_scores
  ) s GROUP BY user_id),
farm AS (
  SELECT user_id, LEAST(8, count(DISTINCT d)) t FROM (
    SELECT user_id, (sold_at AT TIME ZONE 'Europe/Warsaw')::date d FROM farm_seasonal_event_sales
    UNION ALL SELECT user_id, (harvested_at AT TIME ZONE 'Europe/Warsaw')::date FROM farm_inventory
  ) s GROUP BY user_id),
market_p AS (
  SELECT uid user_id, LEAST(6, count(*)) t FROM (
    SELECT seller_id uid FROM marketplace_listings WHERE settled_at IS NOT NULL
    UNION ALL SELECT buyer_id FROM marketplace_listings WHERE settled_at IS NOT NULL AND buyer_id IS NOT NULL
  ) s GROUP BY uid),
canvas AS (
  SELECT user_id, LEAST(6, count(DISTINCT d)) t FROM (
    SELECT last_user_id user_id, (updated_at AT TIME ZONE 'Europe/Warsaw')::date d
    FROM canvas_pixels WHERE last_user_id IS NOT NULL
    UNION
    SELECT user_id, (painted_at AT TIME ZONE 'Europe/Warsaw')::date d
    FROM canvas_paint_log
  ) s GROUP BY user_id),
garden AS (
  SELECT user_id,
    LEAST(5, (CASE WHEN count(*) >= 1 THEN 2 ELSE 0 END) + (CASE WHEN count(*) >= 2 THEN 3 ELSE 0 END)) t_ogrod,
    LEAST(4, count(*) FILTER (WHERE COALESCE(equipped, '{}'::jsonb) <> '{}'::jsonb) * 2) t_ozdoby
  FROM gardens GROUP BY user_id),
tiles AS (
  SELECT owner_id user_id,
    LEAST(12, count(*) FILTER (WHERE acquired_via IS DISTINCT FROM 'migration') * 2) t_dzialki
  FROM farm_tiles WHERE owner_id IS NOT NULL GROUP BY owner_id),
per_user AS (
  SELECT p.id, p.nick,
    COALESCE(mundial.t,0) mundial, COALESCE(markets.t,0) rynek, COALESCE(casino.t,0) kasyno,
    COALESCE(seasonal.t,0) sezonowe, COALESCE(farm.t,0) farma, COALESCE(market_p.t,0) targ,
    COALESCE(canvas.t,0) plotno,
    COALESCE(garden.t_ogrod,0) ogrod, COALESCE(garden.t_ozdoby,0) ozdoby, COALESCE(tiles.t_dzialki,0) dzialki
  FROM profiles p
  LEFT JOIN mundial  ON mundial.user_id  = p.id
  LEFT JOIN markets  ON markets.user_id  = p.id
  LEFT JOIN casino   ON casino.user_id   = p.id
  LEFT JOIN seasonal ON seasonal.user_id = p.id
  LEFT JOIN farm     ON farm.user_id     = p.id
  LEFT JOIN market_p ON market_p.user_id = p.id
  LEFT JOIN canvas   ON canvas.user_id   = p.id
  LEFT JOIN garden   ON garden.user_id   = p.id
  LEFT JOIN tiles    ON tiles.user_id    = p.id
  WHERE p.is_admin IS NOT TRUE),
final AS (
  SELECT id, nick, mundial, rynek, kasyno, sezonowe, farma, targ, plotno, ogrod, ozdoby, dzialki,
    ( (mundial>0)::int + (rynek>0)::int + (kasyno>0)::int + (sezonowe>0)::int
      + (farma>0)::int + (targ>0)::int + (plotno>0)::int ) * 2 AS breadth,
    1 + mundial + rynek + kasyno + sezonowe + farma + targ + plotno + ogrod + ozdoby + dzialki
      + ( (mundial>0)::int + (rynek>0)::int + (kasyno>0)::int + (sezonowe>0)::int
          + (farma>0)::int + (targ>0)::int + (plotno>0)::int ) * 2 AS tickets
  FROM per_user),
bank AS (
  SELECT COALESCE(SUM(CASE WHEN status='won'  THEN stake - potential_payout
                           WHEN status='lost' THEN stake
                           ELSE 0 END), 0)::bigint net
  FROM football_bets)
SELECT jsonb_build_object(
  'bank_net',      (SELECT net FROM bank),
  'multiplier',    10,
  'prize_pool',    GREATEST(0, (SELECT net FROM bank)) * 10,
  'cutoff',        '2026-07-31T23:59:59+02:00',
  'draw_at',       '2026-08-01T12:00:00+02:00',
  'total_tickets', (SELECT COALESCE(SUM(tickets),0)::bigint FROM final),
  'player_count',  (SELECT count(*) FROM final),
  'players', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id, 'nick', nick,
      'mundial', mundial, 'rynek', rynek, 'kasyno', kasyno, 'sezonowe', sezonowe,
      'farma', farma, 'targ', targ, 'plotno', plotno,
      'ogrod', ogrod, 'ozdoby', ozdoby, 'dzialki', dzialki, 'breadth', breadth,
      'tickets', tickets) ORDER BY tickets DESC, nick), '[]'::jsonb)
    FROM final)
);
$$;

REVOKE ALL ON FUNCTION public.mundial_lottery_standings() FROM public;
GRANT EXECUTE ON FUNCTION public.mundial_lottery_standings() TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
