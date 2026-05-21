-- Unified coin transaction log for Rynek Proroctw G6.
-- Captures coin movements that bypass game_transactions (garden watering,
-- accessory purchases). Run after garden.sql and garden-accessories.sql.
-- The frontend profile view reads this alongside game_transactions and trades.

CREATE TABLE IF NOT EXISTS public.coin_transactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  delta      integer NOT NULL,        -- positive = earned, negative = spent
  reason     text NOT NULL,           -- 'garden_water', 'garden_accessory', …
  meta       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coin_tx_user_time_idx
  ON public.coin_transactions(user_id, created_at DESC);

ALTER TABLE public.coin_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coin_tx_select" ON public.coin_transactions;
CREATE POLICY "coin_tx_select" ON public.coin_transactions
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.coin_transactions FROM anon, authenticated;
GRANT SELECT ON public.coin_transactions TO authenticated;

NOTIFY pgrst, 'reload schema';
