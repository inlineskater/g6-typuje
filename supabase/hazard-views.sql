-- Hazard stats and game transactions views for the Ranking page.
-- Run after poker-ledger.sql, roulette.sql, slots.sql, plinko.sql, mines.sql, crash.sql, wheel.sql, and hilo.sql.

DROP VIEW IF EXISTS public.game_transactions;
DROP VIEW IF EXISTS public.hazard_stats;

-- Aggregated P&L per user across all hazard games
CREATE OR REPLACE VIEW public.hazard_stats WITH (security_invoker = false) AS
SELECT
  p.id AS user_id,
  p.nick,
  COALESCE(r.pl, 0)::integer AS roulette_pl,
  COALESCE(s.pl, 0)::integer AS slots_pl,
  COALESCE(pln.pl, 0)::integer AS plinko_pl,
  COALESCE(mn.pl, 0)::integer AS mines_pl,
  COALESCE(cr.pl, 0)::integer AS crash_pl,
  COALESCE(wh.pl, 0)::integer AS wheel_pl,
  COALESCE(hl.pl, 0)::integer AS hilo_pl,
  COALESCE(pk.pl, 0)::integer AS poker_pl,
  (COALESCE(r.pl, 0) + COALESCE(s.pl, 0) + COALESCE(pln.pl, 0) + COALESCE(mn.pl, 0) + COALESCE(cr.pl, 0) + COALESCE(wh.pl, 0) + COALESCE(hl.pl, 0) + COALESCE(pk.pl, 0))::integer AS total_pl,
  p.is_admin
FROM public.profiles p
LEFT JOIN (
  SELECT user_id, SUM(total_won - total_bet)::integer AS pl
  FROM public.roulette_spins GROUP BY user_id
) r ON r.user_id = p.id
LEFT JOIN (
  SELECT user_id, SUM(total_won - 10)::integer AS pl
  FROM public.slots_spins GROUP BY user_id
) s ON s.user_id = p.id
LEFT JOIN (
  SELECT user_id, SUM(total_won - bet)::integer AS pl
  FROM public.plinko_spins GROUP BY user_id
) pln ON pln.user_id = p.id
LEFT JOIN (
  SELECT user_id, SUM(total_won - bet)::integer AS pl
  FROM public.mines_spins GROUP BY user_id
) mn ON mn.user_id = p.id
LEFT JOIN (
  SELECT user_id, SUM(total_won - total_bet)::integer AS pl
  FROM public.crash_spins GROUP BY user_id
) cr ON cr.user_id = p.id
LEFT JOIN (
  SELECT user_id, SUM(total_won - total_bet)::integer AS pl
  FROM public.wheel_spins GROUP BY user_id
) wh ON wh.user_id = p.id
LEFT JOIN (
  SELECT user_id, SUM(total_won - bet)::integer AS pl
  FROM public.hilo_spins GROUP BY user_id
) hl ON hl.user_id = p.id
LEFT JOIN (
  SELECT user_id,
    SUM(CASE WHEN type = 'cashout' THEN amount ELSE -amount END)::integer AS pl
  FROM public.poker_ledger GROUP BY user_id
) pk ON pk.user_id = p.id
WHERE COALESCE(r.pl, 0) + COALESCE(s.pl, 0) + COALESCE(pln.pl, 0) + COALESCE(mn.pl, 0) + COALESCE(cr.pl, 0) + COALESCE(wh.pl, 0) + COALESCE(pk.pl, 0) <> 0;

-- Recent game transactions (roulette, slots, plinko, mines, crash, poker) for all players
CREATE OR REPLACE VIEW public.game_transactions WITH (security_invoker = false) AS
SELECT
  rs.id, rs.user_id, p.nick AS nick_snapshot, 'roulette' AS game,
  rs.total_bet AS bet, rs.total_won AS won, rs.created_at, p.is_admin
FROM public.roulette_spins rs
JOIN public.profiles p ON p.id = rs.user_id
UNION ALL
SELECT
  ss.id, ss.user_id, p.nick AS nick_snapshot, 'slots' AS game,
  10 AS bet, ss.total_won AS won, ss.created_at, p.is_admin
FROM public.slots_spins ss
JOIN public.profiles p ON p.id = ss.user_id
UNION ALL
SELECT
  ps.id, ps.user_id, p.nick AS nick_snapshot, 'plinko' AS game,
  ps.bet AS bet, ps.total_won AS won, ps.created_at, p.is_admin
FROM public.plinko_spins ps
JOIN public.profiles p ON p.id = ps.user_id
UNION ALL
SELECT
  ms.id, ms.user_id, p.nick AS nick_snapshot, 'mines' AS game,
  ms.bet AS bet, ms.total_won AS won, ms.created_at, p.is_admin
FROM public.mines_spins ms
JOIN public.profiles p ON p.id = ms.user_id
UNION ALL
SELECT
  cs.id, cs.user_id, p.nick AS nick_snapshot, 'crash' AS game,
  cs.total_bet AS bet, cs.total_won AS won, cs.created_at, p.is_admin
FROM public.crash_spins cs
JOIN public.profiles p ON p.id = cs.user_id
UNION ALL
SELECT
  ws.id, ws.user_id, p.nick AS nick_snapshot, 'wheel' AS game,
  ws.total_bet AS bet, ws.total_won AS won, ws.created_at, p.is_admin
FROM public.wheel_spins ws
JOIN public.profiles p ON p.id = ws.user_id
UNION ALL
SELECT
  hs.id, hs.user_id, p.nick AS nick_snapshot, 'hilo' AS game,
  hs.bet AS bet, hs.total_won AS won, hs.created_at, p.is_admin
FROM public.hilo_spins hs
JOIN public.profiles p ON p.id = hs.user_id
UNION ALL
SELECT
  pl.id, pl.user_id, pl.nick_snapshot, 'poker_' || pl.type AS game,
  pl.amount AS bet, pl.amount AS won, pl.created_at, p.is_admin
FROM public.poker_ledger pl
JOIN public.profiles p ON p.id = pl.user_id;

REVOKE SELECT ON public.hazard_stats, public.game_transactions FROM anon;
GRANT SELECT ON public.hazard_stats, public.game_transactions TO authenticated;

NOTIFY pgrst, 'reload schema';
