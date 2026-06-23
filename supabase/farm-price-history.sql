-- Farma: per-crop NPC price history for the „📈 Ceny" tab in Ogródek.
-- Run after farm.sql. Idempotent (CREATE ... IF NOT EXISTS / CREATE OR REPLACE).
--
-- Sources of points:
--   • backfill from past sales (coin_transactions.farm_crop_sale meta.cur_price)
--   • a trigger that logs every cur_price change (each future sale)
--   • a pg_cron snapshot every 6h that records the *effective* price (so the chart
--     also shows the slow mean-reversion recovery between sales)

CREATE TABLE IF NOT EXISTS public.farm_price_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  crop_type   text NOT NULL,
  price       numeric NOT NULL CHECK (price >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_price_history_crop_idx ON public.farm_price_history(crop_type, recorded_at);

-- ── RLS / grants ────────────────────────────────────────────────────────────
ALTER TABLE public.farm_price_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_price_history_select" ON public.farm_price_history;
CREATE POLICY "farm_price_history_select" ON public.farm_price_history
  FOR SELECT TO anon, authenticated USING (true);
REVOKE ALL ON public.farm_price_history FROM anon, authenticated;
GRANT SELECT ON public.farm_price_history TO anon, authenticated;

-- ── Trigger: log every cur_price change on farm_market ──────────────────────
CREATE OR REPLACE FUNCTION public.farm_price_history_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.cur_price IS DISTINCT FROM OLD.cur_price THEN
    INSERT INTO public.farm_price_history (crop_type, price, recorded_at)
    VALUES (NEW.crop_type, round(NEW.cur_price, 2), now());
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS farm_market_price_log ON public.farm_market;
CREATE TRIGGER farm_market_price_log
  AFTER UPDATE OF cur_price ON public.farm_market
  FOR EACH ROW EXECUTE FUNCTION public.farm_price_history_log();

-- ── Snapshot: record the effective (mean-reverting) price for every crop ────
-- Mirrors sell_crop_to_npc's reversion math so the chart shows recovery over time.
CREATE OR REPLACE FUNCTION public.snapshot_farm_prices()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.farm_price_history (crop_type, price, recorded_at)
  SELECT m.crop_type,
         round(GREATEST(
           m.base_price * 0.30,
           m.cur_price + (m.base_price - m.cur_price)
             * LEAST(1, (EXTRACT(EPOCH FROM (now() - m.last_decay_at)) / 3600.0) * 0.10)
         ), 2),
         now()
    FROM public.farm_market m;
$$;
REVOKE ALL ON FUNCTION public.snapshot_farm_prices() FROM PUBLIC, anon, authenticated;

-- ── Backfill real history from past sales (one point per sale) ──────────────
INSERT INTO public.farm_price_history (crop_type, price, recorded_at)
SELECT ct.meta->>'crop_type', (ct.meta->>'cur_price')::numeric, ct.created_at
  FROM public.coin_transactions ct
 WHERE ct.reason = 'farm_crop_sale'
   AND ct.meta ? 'crop_type' AND ct.meta ? 'cur_price'
   AND NOT EXISTS (
     SELECT 1 FROM public.farm_price_history h
      WHERE h.crop_type = ct.meta->>'crop_type' AND h.recorded_at = ct.created_at)
ON CONFLICT DO NOTHING;

-- Seed a "now" point per crop so brand-new crops still render a chart.
SELECT public.snapshot_farm_prices();

-- ── pg_cron: snapshot every 6h ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'farm_price_snapshot') THEN
      PERFORM cron.unschedule('farm_price_snapshot');
    END IF;
    PERFORM cron.schedule('farm_price_snapshot', '0 */6 * * *', $cron$SELECT public.snapshot_farm_prices();$cron$);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
