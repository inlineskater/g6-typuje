-- Loteria po Mundialu — THE DRAW (maszyna losująca + wypłata).
--
-- Run after supabase/lottery.sql + supabase/canvas-paint-log.sql +
-- supabase/lottery-fixes.sql (this file CALLS mundial_lottery_standings(), it
-- does not redefine it — so it never goes stale against those three).
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE only.
--
-- ── Why commit–reveal ───────────────────────────────────────────────────────
-- A raffle that pays real coins has to be checkable by the people who lose it,
-- and "the server rolled a random number, trust us" is not checkable. So the
-- draw is split in two, exactly like a provably-fair casino:
--
--   1. COMMIT (lottery_draw_commit)  — the server generates a secret seed, keeps
--      it in a no-grant table, and publishes ONLY sha256(seed) as `commit_hash`.
--      Everyone can see the seal before anyone knows anything about the outcome.
--   2. DRAW (lottery_draw_run)       — the operator supplies public entropy: a
--      free-text `public_seed` the office can agree on out loud, and `force`
--      (1..100, the "siła zakręcenia" of the machine on screen). Both are mixed
--      into the hash, so the operator visibly influences the result — while
--      being unable to steer it, because the seed they'd need is sealed. The
--      seed is then REVEALED, and anyone can replay the whole draw.
--
-- The roll for round k is:
--   sha256(server_seed || '|' || public_seed || '|' || force || '|' || k)
--   → first 48 bits, mod (tickets still in the machine)
-- walked against the cumulative ticket counts of `snapshot` in stored order.
-- Weighted, without replacement: more tickets = more chances, and nobody can
-- take two prizes. (48 bits vs a few hundred tickets ⇒ modulo bias ~1e-45.)
--
-- ⚠️ There is deliberately NO dry-run / preview mode. Revealing the seed once
-- and then letting the operator re-roll with different entropy is exactly the
-- attack commit–reveal exists to stop. One commit = one draw. To rehearse,
-- commit a throwaway draw and run it; the cancelled/spent seed is public.
--
-- ⚠️ PARITY CONTRACT: lottery_roll() below, the snapshot ordering
-- (tickets DESC, id ASC), and the tier percentages are mirrored in index.html
-- (`lotRollFromHex`/`lotVerifyDraw`/`LOTTERY_TIERS`) so the browser can verify
-- a finished draw with SubtleCrypto and show a red flag if anything disagrees.
-- Changing either side without the other silently breaks verification.
--
-- What the operator CAN still choose is WHEN to draw — and the ticket snapshot
-- is taken at that moment. That is unavoidable in any raffle and is stated in
-- the UI; what they cannot do is choose WHO wins.

-- ── Tables ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lottery_draws (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status         text NOT NULL DEFAULT 'committed'
                   CHECK (status IN ('committed','drawn','cancelled')),
  label          text,
  commit_hash    text NOT NULL,          -- sha256(server_seed), published at commit
  server_seed    text,                   -- NULL until drawn/cancelled, then public
  public_seed    text,                   -- office entropy, chosen at spin time
  force          smallint,               -- 1..100 wheel force, part of the hash
  pool           bigint  NOT NULL DEFAULT 0,
  total_tickets  bigint  NOT NULL DEFAULT 0,
  player_count   integer NOT NULL DEFAULT 0,
  snapshot       jsonb,                  -- the exact ticket table the draw used
  winners        jsonb,                  -- [{place,id,nick,tickets,pct,prize,roll,pool_tickets}]
  dividend_total bigint  NOT NULL DEFAULT 0,
  dividend_each  bigint  NOT NULL DEFAULT 0,
  paid_total     bigint  NOT NULL DEFAULT 0,
  committed_at   timestamptz NOT NULL DEFAULT now(),
  drawn_at       timestamptz,
  committed_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  drawn_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- The sealed seed lives here with NO client grants at all. lottery_draw_run
-- copies it onto lottery_draws.server_seed when it reveals.
CREATE TABLE IF NOT EXISTS public.lottery_draw_secrets (
  draw_id     uuid PRIMARY KEY REFERENCES public.lottery_draws(id) ON DELETE CASCADE,
  server_seed text NOT NULL
);

CREATE INDEX IF NOT EXISTS lottery_draws_time_idx
  ON public.lottery_draws (committed_at DESC);

-- At most one open (sealed, not yet drawn) draw at a time — the frontend's
-- "one machine on screen" assumption, enforced in the schema.
CREATE UNIQUE INDEX IF NOT EXISTS lottery_draws_single_open_idx
  ON public.lottery_draws (status) WHERE status = 'committed';

ALTER TABLE public.lottery_draws        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lottery_draw_secrets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lottery_draws_select" ON public.lottery_draws;
CREATE POLICY "lottery_draws_select" ON public.lottery_draws
  FOR SELECT TO anon, authenticated USING (true);

REVOKE ALL ON public.lottery_draws        FROM anon, authenticated;
REVOKE ALL ON public.lottery_draw_secrets FROM anon, authenticated;
GRANT SELECT ON public.lottery_draws TO anon, authenticated;

-- Realtime so a spectator's page flips to the result the moment it lands.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
       AND tablename = 'lottery_draws'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lottery_draws;
  END IF;
END $$;

-- ── The roll ───────────────────────────────────────────────────────────────
-- Mirrored byte-for-byte by lotRollFromHex() in index.html. sha256() and
-- gen_random_uuid() are both core Postgres (11+/13+), so this needs no
-- extensions — which also means the browser can reproduce it with SubtleCrypto.
CREATE OR REPLACE FUNCTION public.lottery_roll(
  p_seed text, p_public text, p_force integer, p_round integer, p_modulus bigint
)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_modulus <= 0 THEN 0::bigint ELSE
    (('x' || substr(encode(sha256(convert_to(
        p_seed || '|' || p_public || '|' || p_force::text || '|' || p_round::text,
        'utf8')), 'hex'), 1, 12))::bit(48)::bigint) % p_modulus
  END;
$$;

-- ── 1. Seal a draw ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lottery_draw_commit(p_label text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_seed text;
  v_id   uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid AND is_admin) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;
  IF EXISTS (SELECT 1 FROM public.lottery_draws WHERE status = 'committed') THEN
    RAISE EXCEPTION 'draw_already_open';
  END IF;

  -- 128 hex chars of gen_random_uuid() entropy (strong RNG, no pgcrypto needed).
  v_seed := replace(gen_random_uuid()::text, '-', '')
         || replace(gen_random_uuid()::text, '-', '')
         || replace(gen_random_uuid()::text, '-', '')
         || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.lottery_draws (status, label, commit_hash, committed_by)
  VALUES ('committed',
          nullif(btrim(coalesce(p_label, '')), ''),
          encode(sha256(convert_to(v_seed, 'utf8')), 'hex'),
          v_uid)
  RETURNING id INTO v_id;

  INSERT INTO public.lottery_draw_secrets (draw_id, server_seed) VALUES (v_id, v_seed);

  RETURN jsonb_build_object('ok', true, 'draw_id', v_id,
    'commit_hash', (SELECT commit_hash FROM public.lottery_draws WHERE id = v_id));
END;
$$;

-- ── 2. Spin it ─────────────────────────────────────────────────────────────
-- Snapshots the tickets, reveals the seed, picks the winners weighted-without-
-- replacement, and PAYS — prizes to the six drawn places, dividend to every
-- ticket holder — all in one transaction. Not reversible; admin only.
CREATE OR REPLACE FUNCTION public.lottery_draw_run(
  p_draw_id     uuid,
  p_public_seed text    DEFAULT NULL,
  p_force       integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_status    text;
  v_seed      text;
  v_force     integer;
  v_pub       text;
  v_stand     jsonb;
  v_snap      jsonb;
  v_remaining jsonb;
  v_winners   jsonb := '[]'::jsonb;
  v_tiers     numeric[] := ARRAY[0.30, 0.20, 0.14, 0.10, 0.08, 0.06];  -- LOTTERY_TIERS
  v_div_pct   numeric := 0.12;                                          -- LOTTERY_DIVIDEND_PCT
  v_pool      bigint;
  v_total     bigint;
  v_pc        integer;
  v_k         integer;
  v_rem_total bigint;
  v_roll      bigint;
  v_cum       bigint;
  v_idx       integer;
  v_pick      jsonb;
  v_prize     bigint;
  v_div_total bigint;
  v_div_each  bigint;
  v_paid      bigint := 0;
  v_el        jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid AND is_admin) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  SELECT status INTO v_status FROM public.lottery_draws WHERE id = p_draw_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_draw'; END IF;
  IF v_status <> 'committed' THEN RAISE EXCEPTION 'draw_already_done'; END IF;

  SELECT server_seed INTO v_seed FROM public.lottery_draw_secrets WHERE draw_id = p_draw_id;
  IF v_seed IS NULL THEN RAISE EXCEPTION 'no_seed'; END IF;

  v_force := GREATEST(1, LEAST(100, COALESCE(p_force, 50)));
  v_pub   := btrim(COALESCE(p_public_seed, ''));
  IF v_pub = '' THEN v_pub := replace(gen_random_uuid()::text, '-', ''); END IF;
  v_pub := substr(v_pub, 1, 120);

  -- Snapshot: the live standings, frozen in a deterministic order. This array
  -- IS the machine — the balls, and what a verifier replays against.
  v_stand := public.mundial_lottery_standings();
  v_pool  := GREATEST(0, COALESCE((v_stand->>'prize_pool')::bigint, 0));

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object('id', e->>'id', 'nick', e->>'nick',
                              'tickets', (e->>'tickets')::int)
           ORDER BY (e->>'tickets')::int DESC, e->>'id'), '[]'::jsonb)
    INTO v_snap
  FROM jsonb_array_elements(COALESCE(v_stand->'players', '[]'::jsonb)) e
  WHERE COALESCE((e->>'tickets')::int, 0) > 0;

  v_pc := jsonb_array_length(v_snap);
  IF v_pc = 0 THEN RAISE EXCEPTION 'no_participants'; END IF;
  SELECT COALESCE(SUM((e->>'tickets')::bigint), 0) INTO v_total
    FROM jsonb_array_elements(v_snap) e;

  -- Weighted, without replacement.
  v_remaining := v_snap;
  FOR v_k IN 1 .. array_length(v_tiers, 1) LOOP
    EXIT WHEN jsonb_array_length(v_remaining) = 0;
    SELECT COALESCE(SUM((e->>'tickets')::bigint), 0) INTO v_rem_total
      FROM jsonb_array_elements(v_remaining) e;
    EXIT WHEN v_rem_total <= 0;

    v_roll := public.lottery_roll(v_seed, v_pub, v_force, v_k, v_rem_total);
    v_cum := 0; v_idx := -1;
    FOR i IN 0 .. jsonb_array_length(v_remaining) - 1 LOOP
      v_cum := v_cum + (v_remaining->i->>'tickets')::bigint;
      IF v_roll < v_cum THEN v_idx := i; EXIT; END IF;
    END LOOP;
    IF v_idx < 0 THEN v_idx := jsonb_array_length(v_remaining) - 1; END IF;

    v_pick  := v_remaining->v_idx;
    v_prize := floor(v_pool * v_tiers[v_k])::bigint;
    v_winners := v_winners || jsonb_build_array(jsonb_build_object(
      'place',        v_k,
      'id',           v_pick->>'id',
      'nick',         v_pick->>'nick',
      'tickets',      (v_pick->>'tickets')::int,
      'pct',          v_tiers[v_k],
      'prize',        v_prize,
      'roll',         v_roll,
      'pool_tickets', v_rem_total));
    v_remaining := v_remaining - v_idx;   -- jsonb array minus index
  END LOOP;

  v_div_total := floor(v_pool * v_div_pct)::bigint;
  v_div_each  := CASE WHEN v_pc > 0 THEN floor(v_div_total::numeric / v_pc)::bigint ELSE 0 END;

  -- Prizes.
  FOR v_el IN SELECT e FROM jsonb_array_elements(v_winners) e LOOP
    IF (v_el->>'prize')::bigint > 0 THEN
      UPDATE public.profiles SET coins = coins + (v_el->>'prize')::bigint
       WHERE id = (v_el->>'id')::uuid;
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES ((v_el->>'id')::uuid, (v_el->>'prize')::int, 'lottery_prize',
              jsonb_build_object('draw_id', p_draw_id,
                                 'place',   (v_el->>'place')::int,
                                 'tickets', (v_el->>'tickets')::int));
      v_paid := v_paid + (v_el->>'prize')::bigint;
    END IF;
  END LOOP;

  -- Dividend — guaranteed, to everyone holding at least one ticket.
  IF v_div_each > 0 THEN
    FOR v_el IN SELECT e FROM jsonb_array_elements(v_snap) e LOOP
      UPDATE public.profiles SET coins = coins + v_div_each WHERE id = (v_el->>'id')::uuid;
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES ((v_el->>'id')::uuid, v_div_each::int, 'lottery_dividend',
              jsonb_build_object('draw_id', p_draw_id,
                                 'tickets', (v_el->>'tickets')::int));
      v_paid := v_paid + v_div_each;
    END LOOP;
  END IF;

  UPDATE public.lottery_draws SET
    status         = 'drawn',
    server_seed    = v_seed,          -- the reveal
    public_seed    = v_pub,
    force          = v_force,
    pool           = v_pool,
    total_tickets  = v_total,
    player_count   = v_pc,
    snapshot       = v_snap,
    winners        = v_winners,
    dividend_total = v_div_total,
    dividend_each  = v_div_each,
    paid_total     = v_paid,
    drawn_at       = now(),
    drawn_by       = v_uid
  WHERE id = p_draw_id;

  RETURN jsonb_build_object('ok', true,
    'draw', (SELECT to_jsonb(d) FROM public.lottery_draws d WHERE d.id = p_draw_id));
END;
$$;

-- ── 3. Void a sealed draw ──────────────────────────────────────────────────
-- Reveals the seed on the way out, so a cancelled seal can never be quietly
-- reused for a later spin.
CREATE OR REPLACE FUNCTION public.lottery_draw_cancel(p_draw_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid AND is_admin) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  SELECT status INTO v_status FROM public.lottery_draws WHERE id = p_draw_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_draw'; END IF;
  IF v_status <> 'committed' THEN RAISE EXCEPTION 'draw_already_done'; END IF;

  UPDATE public.lottery_draws d SET
    status      = 'cancelled',
    server_seed = (SELECT server_seed FROM public.lottery_draw_secrets s WHERE s.draw_id = d.id)
  WHERE d.id = p_draw_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.lottery_draw_commit(text)              FROM public;
REVOKE ALL ON FUNCTION public.lottery_draw_run(uuid, text, integer)  FROM public;
REVOKE ALL ON FUNCTION public.lottery_draw_cancel(uuid)              FROM public;
REVOKE ALL ON FUNCTION public.lottery_roll(text, text, integer, integer, bigint) FROM public;
GRANT EXECUTE ON FUNCTION public.lottery_draw_commit(text)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_draw_run(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_draw_cancel(uuid)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.lottery_roll(text, text, integer, integer, bigint) TO anon, authenticated;

-- ── economy_stats(): count the payout as minted supply ──────────────────────
-- 'lottery_prize'/'lottery_dividend' mint coins, so they belong in
-- economy_stats()'s ledger_minted reason list. That function is ~12 KB and
-- deployed copies drift from supabase/economy-stats.sql, so patch the LIVE
-- definition in place rather than re-transcribing it (same technique as
-- farm-hybrid-income-parity.sql). Guarded + idempotent; RAISEs loudly if the
-- reason list has been reworded, instead of silently doing nothing.
-- (coin-inflow-stats.sql needs no change — its "other" bucket is a NOT IN
-- catch-all, so both reasons land there automatically.)
DO $$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'economy_stats'
   LIMIT 1;

  IF v_def IS NULL THEN
    RAISE NOTICE 'economy_stats() not installed — skipping mint-reason patch (run economy-stats.sql, then re-run this file).';
    RETURN;
  END IF;
  IF position('lottery_prize' IN v_def) > 0 THEN
    RAISE NOTICE 'economy_stats() already counts the lottery payout — nothing to patch.';
    RETURN;
  END IF;

  v_new := replace(v_def,
    '''farm_seasonal_rank_award'')',
    '''farm_seasonal_rank_award'',' || E'\n' ||
    '                             ''lottery_prize'',''lottery_dividend'')');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'economy_stats(): mint-reason list not found — add ''lottery_prize''/''lottery_dividend'' to it by hand (see supabase/lottery-draw.sql).';
  END IF;
  EXECUTE v_new;
  RAISE NOTICE 'economy_stats(): lottery payout added to ledger_minted.';
END $$;

NOTIFY pgrst, 'reload schema';
