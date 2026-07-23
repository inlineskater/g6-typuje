-- Office Grand Prix V4: update engine_version constraint to allow v3 and v4.
-- Idempotent.

ALTER TABLE public.office_grand_prix_sessions
  ALTER COLUMN engine_version SET DEFAULT 'office_grand_prix_v4';

ALTER TABLE public.office_grand_prix_sessions
  DROP CONSTRAINT IF EXISTS office_grand_prix_sessions_engine_version_check;

ALTER TABLE public.office_grand_prix_sessions
  ADD CONSTRAINT office_grand_prix_sessions_engine_version_check
  CHECK (engine_version IN (
    'office_grand_prix_v1',
    'office_grand_prix_v2',
    'office_grand_prix_v3',
    'office_grand_prix_v4'
  ));

NOTIFY pgrst, 'reload schema';
