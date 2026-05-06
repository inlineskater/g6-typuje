-- Production hardening for an existing getsix typuje database.
-- Safe to re-run after the base schema exists.

BEGIN;

ALTER VIEW IF EXISTS public.positions SET (security_invoker = true);
ALTER VIEW IF EXISTS public.leaderboard SET (security_invoker = true);

CREATE INDEX IF NOT EXISTS trades_market_time_idx
  ON public.trades(market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trades_user_market_side_idx
  ON public.trades(user_id, market_id, side);
CREATE INDEX IF NOT EXISTS markets_created_by_idx
  ON public.markets(created_by);
CREATE INDEX IF NOT EXISTS markets_resolved_created_at_idx
  ON public.markets(resolved, created_at DESC);

GRANT SELECT ON public.profiles, public.markets, public.trades, public.positions, public.leaderboard
  TO anon, authenticated;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_admin(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.place_bet(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_market(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_market(uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.place_bet(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_market(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_market(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
