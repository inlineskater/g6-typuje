-- Shared Coin Pusher G6 support for Rynek Proroctw G6.
-- One communal persistent cabinet with a three-drop FIFO queue. Every accepted
-- drop adds one physical 100-coin disc; only front-edge exits are paid. Side
-- gutters pay nothing. The Edge Function is the only read/write interface.
--
-- Run after supabase/schema.sql. Re-run hazard-views.sql,
-- coin-inflow-stats.sql, and economy-stats.sql afterwards.

CREATE TABLE IF NOT EXISTS public.coin_pusher_machine (
  id               text PRIMARY KEY CHECK (id = 'main'),
  state            jsonb NOT NULL,
  revision         bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  physics_version  integer NOT NULL DEFAULT 2 CHECK (physics_version > 0),
  busy_until       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(state) = 'object')
);

INSERT INTO public.coin_pusher_machine (id, state, revision, physics_version)
SELECT
  'main',
  jsonb_build_object(
    'version', 2,
    'coins', jsonb_agg(jsonb_build_object(
      'id', 'seed2_' || (n + 1)::text,
      'x', 190 + (n % 9) * 76 + CASE WHEN ((n / 9)::integer % 2) = 1 THEN 24 ELSE 0 END,
      'y', 432 + (n / 9)::integer * 48
    ) ORDER BY n)
  ),
  0,
  2
FROM generate_series(0, 39) AS n
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.coin_pusher_spins (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id         uuid NOT NULL,
  user_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot      text NOT NULL,
  lane               integer NOT NULL CHECK (lane BETWEEN 0 AND 4),
  bet                integer NOT NULL DEFAULT 100 CHECK (bet = 100),
  coins_won          integer NOT NULL DEFAULT 0 CHECK (coins_won >= 0),
  side_lost          integer NOT NULL DEFAULT 0 CHECK (side_lost >= 0),
  maintenance_added  integer NOT NULL DEFAULT 0 CHECK (maintenance_added >= 0),
  total_won          integer NOT NULL DEFAULT 0 CHECK (total_won >= 0),
  seed               bigint NOT NULL CHECK (seed >= 0),
  phase_ms           integer NOT NULL CHECK (phase_ms >= 0),
  physics_version    integer NOT NULL DEFAULT 2 CHECK (physics_version > 0),
  replay             jsonb NOT NULL,
  started_at         timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, request_id),
  CHECK (total_won = coins_won * 100),
  CHECK (ends_at > started_at),
  CHECK (jsonb_typeof(replay) = 'object')
);

ALTER TABLE public.coin_pusher_machine
  ALTER COLUMN physics_version SET DEFAULT 2;
ALTER TABLE public.coin_pusher_spins
  ALTER COLUMN physics_version SET DEFAULT 2;

-- A v1 cabinet uses different geometry. Refuse to reset it in the middle of a
-- replay; deployment should be retried after the machine becomes idle.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.coin_pusher_machine
    WHERE id = 'main' AND physics_version < 2 AND busy_until > now()
  ) THEN
    RAISE EXCEPTION 'Coin Pusher v1 is active; wait until busy_until before upgrading to v2.';
  END IF;
END;
$$;

WITH v2_seed AS (
  SELECT jsonb_build_object(
    'version', 2,
    'coins', jsonb_agg(jsonb_build_object(
      'id', 'seed2_' || (n + 1)::text,
      'x', 190 + (n % 9) * 76 + CASE WHEN ((n / 9)::integer % 2) = 1 THEN 24 ELSE 0 END,
      'y', 432 + (n / 9)::integer * 48
    ) ORDER BY n)
  ) AS state
  FROM generate_series(0, 39) AS n
)
UPDATE public.coin_pusher_machine AS machine
SET state = v2_seed.state,
    physics_version = 2,
    revision = machine.revision + 1,
    busy_until = NULL,
    updated_at = now()
FROM v2_seed
WHERE machine.id = 'main' AND machine.physics_version < 2;

CREATE INDEX IF NOT EXISTS coin_pusher_spins_time_idx
  ON public.coin_pusher_spins(created_at DESC);
CREATE INDEX IF NOT EXISTS coin_pusher_spins_user_time_idx
  ON public.coin_pusher_spins(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS coin_pusher_spins_schedule_idx
  ON public.coin_pusher_spins(ends_at, started_at);

ALTER TABLE public.coin_pusher_machine ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coin_pusher_spins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coin_pusher_machine_select" ON public.coin_pusher_machine;
DROP POLICY IF EXISTS "coin_pusher_spins_select" ON public.coin_pusher_spins;
REVOKE ALL ON public.coin_pusher_machine, public.coin_pusher_spins FROM anon, authenticated;

-- Queue results and future machine state must not be visible through the Data
-- API or postgres_changes. The action function returns sanitized state and a
-- public no-payload broadcast only nudges clients to refresh it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'coin_pusher_spins'
    )
  THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.coin_pusher_spins';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
