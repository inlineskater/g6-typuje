-- Slots (Jednoreki Bandyta) support for Rynek Proroctw G6.
-- Run after supabase/schema.sql on an existing project.

CREATE TABLE IF NOT EXISTS public.slots_spins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  grid          jsonb NOT NULL,
  winning_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_won     integer NOT NULL DEFAULT 0 CHECK (total_won >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS slots_spins_user_time_idx
  ON public.slots_spins(user_id, created_at DESC);

ALTER TABLE public.slots_spins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "slots_spins_select_own" ON public.slots_spins;
CREATE POLICY "slots_spins_select_own" ON public.slots_spins
  FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.slots_spins FROM anon, authenticated;
GRANT SELECT ON public.slots_spins TO authenticated;

NOTIFY pgrst, 'reload schema';
