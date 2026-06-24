-- Farma: per-crop NPC price history for the „📈 Ceny" tab in Ogródek.
-- Run after farm.sql. Idempotent (CREATE ... IF NOT EXISTS / CREATE OR REPLACE).
--
-- Pricing model (Animal-Crossing "stalk market" style):
--   • base_price   = catalog MAX / ceiling (fixed; "Cena maks.")
--   • anchor_price = the current "normal", rolled TWICE DAILY (00:00 & 12:00
--     Europe/Warsaw) to 30–100% of base via roll_farm_prices()
--   • cur_price    = the live price; sales dip it, it recovers toward anchor_price
--
-- Sources of history points:
--   • backfill from past sales (coin_transactions.farm_crop_sale meta.cur_price)
--   • a trigger that logs every cur_price change (each roll AND each sale)
--   • a pg_cron snapshot that records the recovering price between sales (so the
--     chart shows the recovery curve toward the day's anchor)

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

-- ── Roll: set the twice-daily "normal" (anchor) price for every crop ────────
-- Draws a regime per crop (Balanced tuning, band 30–100% of base, E[mult]≈0.57),
-- sets anchor_price + resets cur_price to it. The regime bands are server-only
-- (random() is server-owned); the client never re-derives them — it just reads
-- cur_price and previews the per-sale drop/recovery (see index.html farmSellQuote).
CREATE OR REPLACE FUNCTION public.roll_farm_prices()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m     public.farm_market%ROWTYPE;
  r     numeric;
  mult  numeric;
BEGIN
  FOR m IN SELECT * FROM public.farm_market FOR UPDATE LOOP
    r := random();
    -- regime → multiplier of base_price
    IF    r < 0.45 THEN mult := 0.30 + random() * 0.20;   -- low   45%: 0.30–0.50
    ELSIF r < 0.78 THEN mult := 0.50 + random() * 0.22;   -- mid   33%: 0.50–0.72
    ELSIF r < 0.95 THEN mult := 0.72 + random() * 0.18;   -- high  17%: 0.72–0.90
    ELSE                mult := 0.90 + random() * 0.10;    -- spike  5%: 0.90–1.00
    END IF;
    UPDATE public.farm_market
       SET anchor_price = round(base_price * mult, 2),
           cur_price    = round(base_price * mult, 2),
           last_decay_at = now()
     WHERE crop_type = m.crop_type;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.roll_farm_prices() FROM PUBLIC, anon, authenticated;

-- Gate so an hourly cron only rolls at 00:00 & 12:00 Europe/Warsaw (DST-safe).
CREATE OR REPLACE FUNCTION public.maybe_roll_farm_prices()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::int IN (0, 12) THEN
    PERFORM public.roll_farm_prices();
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.maybe_roll_farm_prices() FROM PUBLIC, anon, authenticated;

-- ── Snapshot: record the recovering price for every crop ────────────────────
-- Mirrors sell_crop_to_npc's reversion math (toward the day's anchor_price at
-- ~12%/hr) so the chart shows the recovery curve between sales.
CREATE OR REPLACE FUNCTION public.snapshot_farm_prices()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.farm_price_history (crop_type, price, recorded_at)
  SELECT m.crop_type,
         round(GREATEST(
           m.base_price * 0.30,
           m.cur_price + (COALESCE(m.anchor_price, m.base_price) - m.cur_price)
             * LEAST(1, (EXTRACT(EPOCH FROM (now() - m.last_decay_at)) / 3600.0) * 0.12)
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

-- Seed a first roll + a "now" point per crop so brand-new crops render a chart.
SELECT public.roll_farm_prices();
SELECT public.snapshot_farm_prices();

-- ── pg_cron: roll twice daily (hourly job, Warsaw-hour gated) + recovery snapshot ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- twice-daily anchor roll at 00:00 & 12:00 Europe/Warsaw (hourly + internal gate)
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'farm_price_roll') THEN
      PERFORM cron.unschedule('farm_price_roll');
    END IF;
    PERFORM cron.schedule('farm_price_roll', '0 * * * *', $cron$SELECT public.maybe_roll_farm_prices();$cron$);

    -- recovery snapshot every 2h so the chart shows cur_price climbing back to anchor
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'farm_price_snapshot') THEN
      PERFORM cron.unschedule('farm_price_snapshot');
    END IF;
    PERFORM cron.schedule('farm_price_snapshot', '0 */2 * * *', $cron$SELECT public.snapshot_farm_prices();$cron$);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
