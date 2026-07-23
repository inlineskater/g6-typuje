-- Office Grand Prix V5: update engine_version constraint to allow v5.
-- Physics-only tuning pass (steering ramp softened, top speed/accel raised,
-- road grip loosened for more visible drift) -- track geometry/hash unchanged
-- (still office_loop_v4), so only the engine_version allowlist moves.
-- Idempotent.

ALTER TABLE public.office_grand_prix_sessions
  ALTER COLUMN engine_version SET DEFAULT 'office_grand_prix_v5';

ALTER TABLE public.office_grand_prix_sessions
  DROP CONSTRAINT IF EXISTS office_grand_prix_sessions_engine_version_check;

ALTER TABLE public.office_grand_prix_sessions
  ADD CONSTRAINT office_grand_prix_sessions_engine_version_check
  CHECK (engine_version IN (
    'office_grand_prix_v1',
    'office_grand_prix_v2',
    'office_grand_prix_v3',
    'office_grand_prix_v4',
    'office_grand_prix_v5'
  ));

NOTIFY pgrst, 'reload schema';
