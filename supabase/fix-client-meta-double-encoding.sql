-- Fix double-encoded client_meta on seasonal game score tables.
--
-- Problem: the Edge Functions insert client_meta as
-- `${JSON.stringify(meta)}::jsonb`. postgres.js serializes the JS string
-- parameter into a jsonb *string scalar* (the ::jsonb cast is then a no-op),
-- so client_meta is stored as `"{\"base_score\":23,...}"` instead of an
-- object. Every `client_meta ->> 'base_score'` in the leaderboard views
-- returns NULL on a scalar, which silently kills the "score+bonus" split
-- (lbScoreCell, *_current_week.base_score / item_bonus) — item bonuses are
-- applied to scores but never shown.
--
-- Fix: normalize existing rows, and add a BEFORE INSERT trigger so rows from
-- the currently deployed Edge Functions are normalized on write. The trigger
-- is harmless once the functions are fixed to insert real objects.
--
-- Idempotent; paste into the Supabase SQL Editor → Run.

CREATE OR REPLACE FUNCTION public.normalize_client_meta()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF jsonb_typeof(NEW.client_meta) = 'string' THEN
    BEGIN
      NEW.client_meta := (NEW.client_meta #>> '{}')::jsonb;
    EXCEPTION WHEN others THEN
      NULL; -- not valid JSON inside the string: keep the original value
    END;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['whack_boss_scores','bug_jumper_scores','flappy_pants_scores','snake_scores','invoice_horde_scores','var_patrol_scores','egg_catch_scores','super_mariusz_scores']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS normalize_client_meta ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER normalize_client_meta BEFORE INSERT OR UPDATE OF client_meta ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.normalize_client_meta()', t);
    EXECUTE format(
      'UPDATE public.%I SET client_meta = (client_meta #>> ''{}'')::jsonb
        WHERE jsonb_typeof(client_meta) = ''string''', t);
  END LOOP;
END;
$$;
