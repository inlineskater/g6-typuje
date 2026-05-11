-- Hazard stats and game transactions views for the Ranking page.
-- Run after poker-ledger.sql, roulette.sql, and slots.sql.

-- Aggregated P&L per user across all hazard games
CREATE OR REPLACE VIEW public.hazard_stats WITH (security_invoker = false) AS
SELECT
  p.id AS user_id,
  p.nick,
  COALESCE(r.pl, 0)::integer AS roulette_pl,
  COALESCE(s.pl, 0)::integer AS slots_pl,
  COALESCE(pk.pl, 0)::integer AS poker_pl,
  (COALESCE(r.pl, 0) + COALESCE(s.pl, 0) + COALESCE(pk.pl, 0))::integer AS total_pl
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
  SELECT user_id,
    SUM(CASE WHEN type = 'cashout' THEN amount ELSE -amount END)::integer AS pl
  FROM public.poker_ledger GROUP BY user_id
) pk ON pk.user_id = p.id
WHERE COALESCE(r.pl, 0) + COALESCE(s.pl, 0) + COALESCE(pk.pl, 0) <> 0;

-- Recent game transactions (roulette, slots, poker) for all players
CREATE OR REPLACE VIEW public.game_transactions WITH (security_invoker = false) AS
SELECT
  rs.id, rs.user_id, p.nick AS nick_snapshot, 'roulette' AS game,
  rs.total_bet AS bet, rs.total_won AS won, rs.created_at
FROM public.roulette_spins rs
JOIN public.profiles p ON p.id = rs.user_id
UNION ALL
SELECT
  ss.id, ss.user_id, p.nick AS nick_snapshot, 'slots' AS game,
  10 AS bet, ss.total_won AS won, ss.created_at
FROM public.slots_spins ss
JOIN public.profiles p ON p.id = ss.user_id
UNION ALL
SELECT
  pl.id, pl.user_id, pl.nick_snapshot, 'poker_' || pl.type AS game,
  pl.amount AS bet, pl.amount AS won, pl.created_at
FROM public.poker_ledger pl;

GRANT SELECT ON public.hazard_stats, public.game_transactions TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
