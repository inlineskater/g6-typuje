-- ════════════════════════════════════════════════════════════════════════════
--  „Wspólny Cel Biura" — communal coin burn that unlocks something for everyone
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER: farm.sql, garden-zen-split.sql (owns buy_farm_tile's row-0 guard),
--             anti-inflation.sql. Idempotent.
--  ⚠️ Re-run this after re-running garden-zen-split.sql (it owns buy_farm_tile)
--     or anti-inflation.sql (it owns farm_burn_per_day).
--
--  ── Why ────────────────────────────────────────────────────────────────────
--  The 2026-08-28 audit found 407,000 coins chasing four purchasable things, and
--  the two mechanisms built for exactly this dead: hero-item auctions have run
--  FOUR times ever (winning bids 24-502; the Pierścień Bankiera, now printing
--  1,480/day, sold for 401) and the sign board has been rented ONCE, for one day.
--
--  A communal goal is the sink that fits an eleven-person office: contributions
--  are public, the reward is shared, and the social pressure does the work a
--  price tag cannot. It also composes with the burn-linked NPC budget from
--  anti-inflation.sql — `office_goal_contribution` is in farm_burn_per_day()'s
--  reason list, so funding the goal literally raises everyone's crop prices.
--  Spending stops being a loss and becomes an investment in the office.
--
--  ── Shape ──────────────────────────────────────────────────────────────────
--  A SERIES, not a one-off: office_goals holds many, one open at a time (a real
--  partial unique index, not app logic), each with a reward_code that some other
--  part of the game checks. Adding the next goal is one INSERT.
--
--  The first goal unlocks five more farm plots — the board is full (40 of 40
--  owned), and under the demand-throttled market more tiles no longer mean
--  proportionally more minting, so selling land for coins that get destroyed is
--  now safe in a way it was not two days ago.
--
--  No per-player contribution cap on purpose. If one player wants to buy the
--  office five plots, that is a 150,000-coin burn and a fantastic outcome; the
--  contributor board is what makes it worth their while.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.office_goals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text UNIQUE NOT NULL,
  title         text NOT NULL,
  subtitle      text,
  reward_text   text NOT NULL,
  -- What completing this goal switches on. Consumed by whatever feature the
  -- goal unlocks; unknown codes are simply inert.
  reward_code   text NOT NULL,
  target_coins  bigint NOT NULL CHECK (target_coins > 0),
  raised_coins  bigint NOT NULL DEFAULT 0 CHECK (raised_coins >= 0),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

-- One open goal at a time, enforced by the database rather than by app logic.
CREATE UNIQUE INDEX IF NOT EXISTS office_goals_single_open_idx
  ON public.office_goals ((status)) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS public.office_goal_contributions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id    uuid NOT NULL REFERENCES public.office_goals(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount     bigint NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS office_goal_contrib_goal_idx
  ON public.office_goal_contributions (goal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS office_goal_contrib_user_idx
  ON public.office_goal_contributions (goal_id, user_id);

-- Public read, no client write: every coin movement goes through the RPC.
ALTER TABLE public.office_goals              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_goal_contributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "office_goals_select" ON public.office_goals;
CREATE POLICY "office_goals_select" ON public.office_goals
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "office_goal_contrib_select" ON public.office_goal_contributions;
CREATE POLICY "office_goal_contrib_select" ON public.office_goal_contributions
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.office_goals              FROM anon, authenticated;
REVOKE ALL ON public.office_goal_contributions FROM anon, authenticated;
GRANT SELECT ON public.office_goals              TO authenticated;
GRANT SELECT ON public.office_goal_contributions TO authenticated;


-- ── The first goal ─────────────────────────────────────────────────────────
-- 150,000 is ~37% of the money supply measured on 2026-08-28 and about four
-- days of the whole office's post-throttle farm income: a real collective
-- effort, reachable in a week or two of broad participation, or in one gesture
-- by somebody who wants the credit.
INSERT INTO public.office_goals (code, title, subtitle, reward_text, reward_code, target_coins)
VALUES (
  'farm_row_5',
  'Nowa grządka dla biura',
  'Farma jest pełna — wszystkie 40 działek mają właścicieli. Zrzućmy się na dokupienie ziemi.',
  '5 nowych działek na farmie, dostępnych dla wszystkich do kupienia.',
  'farm_row_5',
  150000
)
ON CONFLICT (code) DO NOTHING;


-- ── Has a reward been unlocked? ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.office_goal_reward_active(p_code text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.office_goals
     WHERE reward_code = p_code AND status = 'completed'
  );
$fn$;

GRANT EXECUTE ON FUNCTION public.office_goal_reward_active(text) TO authenticated;


-- ── How many row-0 cells are real, purchasable farmland ────────────────────
-- The DB grid is 13×4 but only rows 1-3 are farmland; row 0 is the freed legacy
-- zen row, of which exactly ONE cell (0,0) was exposed as FARM_EXTRA_TILES to
-- square the display off at 40. Completing the goal exposes five more, which
-- the board renders as a 9th column on the right.
--
-- ⚠️ This is the single source of truth for the row-0 boundary. buy_farm_tile's
-- guard, farm_normal_tile_capacity() (and therefore the land-tax fair share)
-- and the frontend's FARM_EXTRA_TILES all derive from it.
CREATE OR REPLACE FUNCTION public.farm_extra_tiles_unlocked()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT 1 + CASE WHEN public.office_goal_reward_active('farm_row_5') THEN 5 ELSE 0 END;
$fn$;

GRANT EXECUTE ON FUNCTION public.farm_extra_tiles_unlocked() TO authenticated;


-- Land-tax fair share must grow with the board, or unlocking plots would tax
-- everyone for owning the same tiles they already own.
CREATE OR REPLACE FUNCTION public.farm_normal_tile_capacity()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  -- Purchasable cells only: farmland rows 1-3 (13×3) plus the row-0 cells the
  -- frontend exposes (FARM_EXTRA_TILES in index.html), which grows when the
  -- office completes a goal that unlocks land.
  SELECT 13 * 3 + public.farm_extra_tiles_unlocked();
$fn$;


-- ── buy_farm_tile: the row-0 guard now follows the unlocked count ──────────
-- Verbatim copy of garden-zen-split.sql's version with ONLY the guard changed.
CREATE OR REPLACE FUNCTION public.buy_farm_tile(p_x integer, p_y integer)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user     uuid := auth.uid();
  v_tiles    integer;
  v_price    integer;
  v_claimed  uuid;
  v_coins    integer;
  v_voucher  boolean := false;
  v_vouchers integer := 0;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_x < 0 OR p_x >= 13 OR p_y < 0 OR p_y >= 4 THEN RAISE EXCEPTION 'bad_coords'; END IF;
  -- Row 0 is the legacy zen row, hidden by the frontend since the zen split.
  -- Only the first farm_extra_tiles_unlocked() cells of it are real, purchasable
  -- farmland (FARM_EXTRA_TILES in index.html) — that count starts at 1 and grows
  -- when the office completes a „Wspólny Cel" that unlocks land. Anything past it
  -- is invisible in the UI but would still count for pricing/tax, so a crafted
  -- RPC call must not be able to claim it.
  IF p_y = 0 AND p_x >= public.farm_extra_tiles_unlocked() THEN RAISE EXCEPTION 'bad_coords'; END IF;

  INSERT INTO public.farm_user_state (user_id) VALUES (v_user)
  ON CONFLICT (user_id) DO NOTHING;
  PERFORM public.farm_assert_can_expand(v_user);

  -- Exclude legacy zen 'migration' tiles: they were never bought, and the client
  -- price quote (farmTilePrice/farmOwnedTileCount in index.html) doesn't count
  -- them — counting them here would double the charged price vs the shown one.
  SELECT count(*) INTO v_tiles FROM public.farm_tiles
   WHERE owner_id = v_user AND acquired_via <> 'migration';
  v_price := least(50000::numeric, floor(350::numeric * power(2::numeric, v_tiles)))::integer;

  -- A free-tile voucher (dropped by a seed box) claims a tile for 0 coins.
  -- Consume one under a row lock; if none, fall back to the escalating coin price.
  UPDATE public.farm_user_state SET tile_vouchers = tile_vouchers - 1
   WHERE user_id = v_user AND tile_vouchers > 0
  RETURNING tile_vouchers INTO v_vouchers;
  IF FOUND THEN v_voucher := true; ELSE v_price := v_price; END IF;

  INSERT INTO public.farm_tiles (x, y, owner_id, acquired_via, asset_value)
  VALUES (p_x, p_y, v_user, CASE WHEN v_voucher THEN 'lootbox' ELSE 'purchase' END,
          CASE WHEN v_voucher THEN 0 ELSE v_price END)
  ON CONFLICT (x, y) DO NOTHING
  RETURNING owner_id INTO v_claimed;
  IF v_claimed IS NULL THEN RAISE EXCEPTION 'tile_taken'; END IF;

  IF v_voucher THEN
    -- free claim via voucher: no coin movement, no ledger row
    SELECT coins INTO v_coins FROM public.profiles WHERE id = v_user;
    RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'price', 0,
                             'coins', v_coins, 'via', 'voucher', 'tile_vouchers', v_vouchers);
  END IF;

  UPDATE public.profiles SET coins = coins - v_price
   WHERE id = v_user AND coins >= v_price
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_price, 'farm_tile_buy', jsonb_build_object('x', p_x, 'y', p_y, 'price', v_price));
  END IF;

  RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'price', v_price,
                           'coins', v_coins, 'via', 'coins');
END;
$fn$
;

REVOKE ALL ON FUNCTION public.buy_farm_tile(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buy_farm_tile(integer, integer) TO authenticated;


-- ── Contribute ─────────────────────────────────────────────────────────────
-- Coins are BURNED, not escrowed: there is no refund and no "goal failed" path,
-- which is what makes it a sink rather than a savings account. Completion is
-- detected inside the same transaction that pushes the counter over the line,
-- under an advisory lock, so two simultaneous final contributions cannot both
-- claim to have completed it (and the reward cannot be granted twice).
CREATE OR REPLACE FUNCTION public.office_goal_contribute(p_amount bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user      uuid := auth.uid();
  v_goal      public.office_goals%ROWTYPE;
  v_coins     bigint;
  v_completed boolean := false;
  v_my        bigint;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_amount IS NULL OR p_amount < 1 THEN RAISE EXCEPTION 'bad_amount'; END IF;

  -- One writer at a time on the shared counter. Taken BEFORE the profile lock,
  -- and it is the only lock order in this file, so nothing here can deadlock.
  PERFORM pg_advisory_xact_lock(hashtext('office_goal_contribute'));

  SELECT * INTO v_goal FROM public.office_goals WHERE status = 'open' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_open_goal'; END IF;

  -- Never take more than the goal still needs: overpaying into a finished goal
  -- is a burn with nothing bought, and players would rightly read it as a bug.
  p_amount := LEAST(p_amount, v_goal.target_coins - v_goal.raised_coins);
  IF p_amount < 1 THEN RAISE EXCEPTION 'goal_already_funded'; END IF;

  UPDATE public.profiles SET coins = coins - p_amount
   WHERE id = v_user AND coins >= p_amount
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  INSERT INTO public.office_goal_contributions (goal_id, user_id, amount)
  VALUES (v_goal.id, v_user, p_amount);

  UPDATE public.office_goals
     SET raised_coins = raised_coins + p_amount,
         status       = CASE WHEN raised_coins + p_amount >= target_coins THEN 'completed' ELSE status END,
         completed_at = CASE WHEN raised_coins + p_amount >= target_coins THEN now() ELSE completed_at END
   WHERE id = v_goal.id
  RETURNING (status = 'completed') INTO v_completed;

  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, -p_amount, 'office_goal_contribution',
          jsonb_build_object('goal_id', v_goal.id, 'goal_code', v_goal.code,
                             'title', v_goal.title, 'completed', v_completed));

  SELECT COALESCE(sum(amount), 0) INTO v_my
    FROM public.office_goal_contributions
   WHERE goal_id = v_goal.id AND user_id = v_user;

  RETURN json_build_object('ok', true, 'contributed', p_amount, 'coins', v_coins,
                           'my_total', v_my, 'completed', v_completed,
                           'raised', v_goal.raised_coins + p_amount,
                           'target', v_goal.target_coins);
END;
$fn$;

REVOKE ALL ON FUNCTION public.office_goal_contribute(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_goal_contribute(bigint) TO authenticated;


-- ── Read model ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.office_goal_state()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH g AS (
    SELECT * FROM public.office_goals
     ORDER BY (status = 'open') DESC, COALESCE(completed_at, opened_at) DESC
     LIMIT 1
  )
  SELECT json_build_object(
    'goal', (SELECT row_to_json(x) FROM (
       SELECT g.id, g.code, g.title, g.subtitle, g.reward_text, g.reward_code,
              g.target_coins, g.raised_coins, g.status, g.completed_at
         FROM g) x),
    'my_total', COALESCE((SELECT sum(c.amount) FROM public.office_goal_contributions c, g
                           WHERE c.goal_id = g.id AND c.user_id = auth.uid()), 0),
    'contributors', COALESCE((SELECT json_agg(row_to_json(t)) FROM (
        SELECT p.nick, sum(c.amount)::bigint AS amount, max(c.created_at) AS last_at
          FROM public.office_goal_contributions c
          JOIN g ON g.id = c.goal_id
          JOIN public.profiles p ON p.id = c.user_id
         GROUP BY p.nick
         ORDER BY sum(c.amount) DESC, max(c.created_at)) t), '[]'::json),
    'recent', COALESCE((SELECT json_agg(row_to_json(t)) FROM (
        SELECT p.nick, c.amount, c.created_at
          FROM public.office_goal_contributions c
          JOIN g ON g.id = c.goal_id
          JOIN public.profiles p ON p.id = c.user_id
         ORDER BY c.created_at DESC LIMIT 12) t), '[]'::json),
    'extra_tiles', public.farm_extra_tiles_unlocked()
  );
$fn$;

REVOKE ALL ON FUNCTION public.office_goal_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_goal_state() TO authenticated;


-- ── Realtime: the counter is the whole point, so it must move live ─────────
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.office_goals; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.office_goal_contributions; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;


-- ── Wire the burn into the NPC price budget ────────────────────────────────
-- Funding the goal now raises everyone's crop prices, which is the whole reason
-- the budget tracks burn instead of supply. Verbatim copy of the body in
-- anti-inflation.sql with 'office_goal_contribution' added to the reason list.
CREATE OR REPLACE FUNCTION public.farm_burn_per_day()
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c_days constant integer := 21;
  c_trim constant integer := 2;
  v_day  bigint[] := array_fill(0::bigint, ARRAY[c_days]);
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_out  bigint;
  rec    record;
BEGIN
  FOR rec IN
    SELECT (v_today - (ct.created_at AT TIME ZONE 'Europe/Warsaw')::date) AS off,
           (-sum(ct.delta))::bigint AS v
      FROM public.coin_transactions ct
     WHERE ct.created_at > now() - make_interval(days => c_days)
       AND ct.delta < 0
       AND ct.reason IN ('farm_box_buy','farm_goldbox_buy','card_levelup','nft_breed',
                         'farm_tile_buy','farm_land_tax_pay','farm_land_tax_autopay',
                         'office_goal_contribution')
     GROUP BY 1
  LOOP
    IF rec.off BETWEEN 0 AND c_days - 1 THEN
      v_day[rec.off + 1] := v_day[rec.off + 1] + rec.v;
    END IF;
  END LOOP;

  IF to_regclass('public.game_transactions') IS NOT NULL THEN
    FOR rec IN
      SELECT (v_today - (g.created_at AT TIME ZONE 'Europe/Warsaw')::date) AS off,
             sum(g.bet - g.won)::bigint AS v
        FROM public.game_transactions g
       WHERE g.created_at > now() - make_interval(days => c_days)
         AND NOT COALESCE(g.is_admin, false)
       GROUP BY 1
    LOOP
      IF rec.off BETWEEN 0 AND c_days - 1 THEN
        v_day[rec.off + 1] := v_day[rec.off + 1] + rec.v;
      END IF;
    END LOOP;
  END IF;

  SELECT COALESCE(round(avg(x)), 0)::bigint INTO v_out
    FROM (SELECT x FROM unnest(v_day) AS x ORDER BY x
           OFFSET c_trim LIMIT c_days - 2 * c_trim) t;

  RETURN GREATEST(0, v_out);
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_burn_per_day() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_burn_per_day() TO authenticated;
