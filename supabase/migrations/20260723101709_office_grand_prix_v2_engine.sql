-- Office Grand Prix V2 is additive: historical/test sessions remain pinned to
-- the original replay engine while every future session is explicitly V2.
ALTER TABLE public.office_grand_prix_sessions
  ADD COLUMN IF NOT EXISTS engine_version text;

UPDATE public.office_grand_prix_sessions
SET engine_version = 'office_grand_prix_v1'
WHERE engine_version IS NULL;

ALTER TABLE public.office_grand_prix_sessions
  ALTER COLUMN engine_version SET DEFAULT 'office_grand_prix_v2',
  ALTER COLUMN engine_version SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.office_grand_prix_sessions'::regclass
      AND conname = 'office_grand_prix_sessions_engine_version_check'
  ) THEN
    ALTER TABLE public.office_grand_prix_sessions
      ADD CONSTRAINT office_grand_prix_sessions_engine_version_check
      CHECK (engine_version IN (
        'office_grand_prix_v1',
        'office_grand_prix_v2'
      )) NOT VALID;
  END IF;
END;
$$;

ALTER TABLE public.office_grand_prix_sessions
  VALIDATE CONSTRAINT office_grand_prix_sessions_engine_version_check;
