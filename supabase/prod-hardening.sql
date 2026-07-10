-- Production hardening for an existing Rynek Proroctw G6 database.
-- Safe to re-run after the base schema exists.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

UPDATE public.profiles
   SET is_admin = true
 WHERE nick = 'admin'
   AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE is_admin);

CREATE OR REPLACE FUNCTION public.is_admin(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user AND is_admin);
$$;

ALTER VIEW IF EXISTS public.positions SET (security_invoker = true);
ALTER VIEW IF EXISTS public.leaderboard SET (security_invoker = true);

DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT USING (true);

CREATE INDEX IF NOT EXISTS trades_market_time_idx
  ON public.trades(market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trades_user_market_side_idx
  ON public.trades(user_id, market_id, side);
CREATE INDEX IF NOT EXISTS markets_created_by_idx
  ON public.markets(created_by);
CREATE INDEX IF NOT EXISTS markets_resolved_created_at_idx
  ON public.markets(resolved, created_at DESC);
CREATE INDEX IF NOT EXISTS markets_resolved_by_idx
  ON public.markets(resolved_by);

-- Supabase grants broad table privileges by default. RLS blocks ordinary DML,
-- but the browser roles do not need these write privileges at all.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.profiles, public.markets, public.trades
  FROM PUBLIC, anon, authenticated;

REVOKE SELECT ON public.markets, public.trades, public.positions, public.leaderboard
  FROM anon;
REVOKE SELECT ON public.profiles FROM anon;
GRANT SELECT (nick) ON public.profiles TO anon;
GRANT SELECT ON public.profiles TO authenticated;
GRANT SELECT ON public.markets, public.trades, public.positions, public.leaderboard
  TO authenticated;

-- Repair legacy garden policies without making the garden feature mandatory
-- for a core-only installation.
DO $garden_hardening$
BEGIN
  IF to_regclass('public.gardens') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "gardens_update_own" ON public.gardens';
    EXECUTE 'DROP POLICY IF EXISTS "gardens_delete_own" ON public.gardens';
    EXECUTE 'DROP POLICY IF EXISTS "gardens_admin_update_own" ON public.gardens';
    EXECUTE 'DROP POLICY IF EXISTS "gardens_admin_delete_own" ON public.gardens';
    EXECUTE $policy$
      CREATE POLICY "gardens_admin_update_own" ON public.gardens
      FOR UPDATE TO authenticated
      USING (
        user_id = auth.uid()
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid() AND p.is_admin
        )
      )
      WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid() AND p.is_admin
        )
      )
    $policy$;
    EXECUTE $policy$
      CREATE POLICY "gardens_admin_delete_own" ON public.gardens
      FOR DELETE TO authenticated
      USING (
        user_id = auth.uid()
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid() AND p.is_admin
        )
      )
    $policy$;
    EXECUTE 'REVOKE ALL ON public.gardens FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT SELECT ON public.gardens TO anon, authenticated';
    EXECUTE 'GRANT UPDATE (stage, streak_days) ON public.gardens TO authenticated';
    EXECUTE 'GRANT DELETE ON public.gardens TO authenticated';
  END IF;

  IF to_regclass('public.garden_admires') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.garden_admires FROM PUBLIC, anon, authenticated';
  END IF;
END
$garden_hardening$;

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
