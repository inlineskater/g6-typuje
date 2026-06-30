-- documents.sql — in-game "document signing" archive
--
-- Records that a user has read + signed a company document (e.g. the Ogródek
-- land reform „ustawa"). The document text itself lives in index.html (the
-- DOCUMENTS constant); this table only stores the signature (a drawn PNG
-- data-URL), so „Moje Dokumenty" can show signed status + the saved signature.
--
-- One row per (user, document). Mirrors the own-row state pattern used by
-- farm_user_state + claim_farm_starter in farm.sql. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.document_signatures (
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  doc_id      text NOT NULL,
  doc_version integer NOT NULL DEFAULT 1,
  signature   text NOT NULL,                 -- drawn signature, PNG data-URL
  signed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, doc_id)
);

ALTER TABLE public.document_signatures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_signatures_select_own" ON public.document_signatures;
CREATE POLICY "document_signatures_select_own" ON public.document_signatures
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- No direct client writes — signing goes through sign_document() below.
REVOKE ALL ON public.document_signatures FROM anon, authenticated;
GRANT SELECT ON public.document_signatures TO authenticated;

-- ── RPC: sign a document ─────────────────────────────────────────────────────
-- Idempotent: re-signing the same doc (e.g. after a version bump) overwrites the
-- prior signature + timestamp. Modeled on claim_farm_starter (farm.sql).
CREATE OR REPLACE FUNCTION public.sign_document(
  p_doc_id    text,
  p_version   integer,
  p_signature text
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_doc_id IS NULL OR length(p_doc_id) = 0 OR length(p_doc_id) > 80 THEN
    RAISE EXCEPTION 'bad_doc_id';
  END IF;
  -- Drawn signature must be a reasonably-sized image data-URL.
  IF p_signature IS NULL
     OR left(p_signature, 11) <> 'data:image/'
     OR length(p_signature) > 300000 THEN
    RAISE EXCEPTION 'bad_signature';
  END IF;

  INSERT INTO public.document_signatures (user_id, doc_id, doc_version, signature, signed_at)
  VALUES (v_user, p_doc_id, COALESCE(p_version, 1), p_signature, now())
  ON CONFLICT (user_id, doc_id) DO UPDATE
    SET doc_version = EXCLUDED.doc_version,
        signature   = EXCLUDED.signature,
        signed_at   = now();

  RETURN json_build_object(
    'ok', true,
    'doc_id', p_doc_id,
    'doc_version', COALESCE(p_version, 1),
    'signed_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.sign_document(text, integer, text) TO authenticated;
