-- ═══════════════════════════════════════════════════════════════════════════
-- „Bank G6" — investment products: Lokata, Skarbonka, Obligacje, Udziały w
-- Kasynie. Plus the shop-buyable interest item („Sygnet Bankiera").
--
-- Run AFTER: schema.sql, coin-transactions.sql, hero-items.sql,
--            hero-items-always-active.sql, casino-luck-item.sql,
--            and every casino file (slots/roulette/plinko/mines/crash/wheel).
-- Run BEFORE re-running: leaderboard-net-worth-items.sql, economy-stats.sql,
--            coin-inflow-stats.sql — those three now call bank_user_assets()
--            / bank_total_assets() defined here and will fail without them.
-- Idempotent: safe to re-run.
--
-- ── Why every LIMIT here is DERIVED, not chosen ────────────────────────────
-- The precedent in this codebase is `interest_ring` (new-auction-items.sql):
-- 2%/day of the whole balance, compounding, uncapped, forever. It was won at
-- auction for 401 coins in May 2026 and had minted its owner 38,235 by
-- 2026-08-23 — more than 10% of the entire non-admin money supply, from one
-- item. Every product below is therefore bounded by a maturity, by being
-- funded out of coins that were already burned, or by a per-player cap that
-- bank_ensure_limits() RECOMPUTES DAILY from the measured state of the economy
-- (see the DYNAMIC LIMITS block below). The Sygnet Bankiera shipped as the
-- deliberate exception — uncapped, at parity with the legendary ring — and that
-- was reversed on 2026-08-28: both interest items now carry interest_cap 20,000
-- (400/day), because an uncapped rate on a balance the interest itself grows was
-- the only unbounded compounding term in the whole game.
--
-- Measured baseline the rates were calibrated against (prod, 2026-08-23):
--   11 non-admin players · 360,776 coins in circulation · median balance 10,353
--   casino house net (6 solo games): 88,544 / 30 days  ==  ~2,951 coins/day
--
-- ── The products ───────────────────────────────────────────────────────────
--  🐷 Skarbonka  — no term, 0.40%/day simple, principal cap 5,000/player.
--                  Breaking it before day 7 forfeits ALL accrued interest.
--  🏦 Lokata     — hard term deposit. 7d/+3.5%, 14d/+8%, 30d/+19% (TOTAL, not
--                  annualized). Cap 30,000/player across all open lokaty.
--                  Breaking early returns the principal, no interest.
--  📜 Obligacja  — 1,000 face, 1,000 price, 6/day coupon, 20-day term (+12%).
--                  Issued in weekly series of 40, auto-opened by bank_settle_due().
--                  TRADEABLE: set an ask price, anyone can buy it outright.
--  🎰 Udział w Kasynie — 30 shares, 4,000 each, max 5 per player on primary
--                  sale. Each share pays 2.5% of the PREVIOUS Warsaw day's
--                  positive casino house net. This is the only product that
--                  mints nothing in real terms: it redistributes coins that
--                  gamblers already burned, and pays exactly 0 on a day the
--                  players beat the house. Also tradeable.
--  💍 Sygnet Bankiera — hero-item, 8,000, +2%/day (Filip's rate) but only on
--                  the FIRST 12,000 coins of cash → max 240/day. See the
--                  award_daily_interest() rewrite at the bottom.
--
-- ── Settlement is LAZY-ON-READ (crash/wheel pattern), cron is a backstop ────
-- bank_settle_due() is idempotent and date-driven: accrual rows are keyed
-- (pay_date, holding_id) and only rows actually INSERTed get credited, so
-- running it twice in the same second is a no-op. bank_state() calls it, and
-- an hourly cron calls it too. On top of that, bond redemption pays out any
-- coupon days the accrual somehow missed — so a holder cannot be shorted even
-- if the cron is down for a month. That is deliberate: the farm's weekly
-- payout silently paid nobody for two separate weeks (see
-- farm-seasonal-award-reliability.sql) precisely because it had a single
-- scheduled shot with no catch-up.
--
-- ⚠️ Constants below are mirrored in tabs/bank.js (BANK_* consts) for the
-- previews the UI shows before you commit. The server is authoritative; the
-- client only predicts. Keep them in sync.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Tables ─────────────────────────────────────────────────────────────────

-- Lokata + Skarbonka. One row per deposit (you may hold many of each).
CREATE TABLE IF NOT EXISTS public.bank_deposits (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  product    text NOT NULL CHECK (product IN ('lokata','skarbonka')),
  principal  bigint NOT NULL CHECK (principal > 0),
  -- lokata: TOTAL return over the whole term. skarbonka: per-day simple rate.
  rate_bps   integer NOT NULL CHECK (rate_bps >= 0),
  term_days  integer CHECK (term_days IS NULL OR term_days > 0),
  opened_at  timestamptz NOT NULL DEFAULT now(),
  matures_at timestamptz NOT NULL,
  closed_at  timestamptz,
  payout     bigint,
  interest   bigint,
  broke_early boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS bank_deposits_user_idx
  ON public.bank_deposits(user_id, closed_at, matures_at);

-- Bond series (weekly issues). Auto-opened by bank_settle_due().
CREATE TABLE IF NOT EXISTS public.bank_bond_series (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text UNIQUE NOT NULL,
  face_value     bigint NOT NULL CHECK (face_value > 0),
  price          bigint NOT NULL CHECK (price > 0),
  coupon_per_day bigint NOT NULL CHECK (coupon_per_day >= 0),
  term_days      integer NOT NULL CHECK (term_days > 0),
  edition_size   integer NOT NULL CHECK (edition_size > 0),
  sold           integer NOT NULL DEFAULT 0 CHECK (sold >= 0),
  opens_at       timestamptz NOT NULL DEFAULT now(),
  closes_at      timestamptz NOT NULL,
  CHECK (sold <= edition_size)
);

-- Bonds AND casino shares share one table: both are owned, income-bearing,
-- and resellable, and both accrue through bank_dividends. Per-kind columns are
-- nullable rather than split across two near-identical tables.
CREATE TABLE IF NOT EXISTS public.bank_holdings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('bond','share')),
  owner_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  serial_no      integer,
  -- bond only
  series_id      uuid REFERENCES public.bank_bond_series(id) ON DELETE RESTRICT,
  face_value     bigint,
  coupon_per_day bigint,
  matures_at     timestamptz,
  -- share only: this holding's cut of daily house net, in basis points
  share_bps      integer CHECK (share_bps IS NULL OR share_bps > 0),
  -- both
  purchase_price bigint NOT NULL CHECK (purchase_price >= 0),
  -- 'treasury' = bought from the bank at the fixed price, 'resale' = bought off
  -- another player. The per-user share cap counts treasury buys only.
  acquired_from  text NOT NULL DEFAULT 'treasury'
                 CHECK (acquired_from IN ('treasury','resale')),
  ask_price      bigint CHECK (ask_price IS NULL OR ask_price > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  redeemed_at    timestamptz,
  CHECK (kind <> 'bond'  OR (series_id IS NOT NULL AND face_value IS NOT NULL
                             AND coupon_per_day IS NOT NULL AND matures_at IS NOT NULL)),
  CHECK (kind <> 'share' OR share_bps IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS bank_holdings_owner_idx
  ON public.bank_holdings(owner_id, kind, redeemed_at);
CREATE INDEX IF NOT EXISTS bank_holdings_market_idx
  ON public.bank_holdings(ask_price) WHERE ask_price IS NOT NULL AND redeemed_at IS NULL;

-- One row per (day, holding). The PK is the idempotency guarantee that lets
-- bank_settle_due() run as often as anything cares to call it.
CREATE TABLE IF NOT EXISTS public.bank_dividends (
  pay_date   date NOT NULL,
  holding_id uuid NOT NULL REFERENCES public.bank_holdings(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('bond','share')),
  amount     bigint NOT NULL CHECK (amount >= 0),
  paid_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pay_date, holding_id)
);

CREATE INDEX IF NOT EXISTS bank_dividends_user_idx
  ON public.bank_dividends(user_id, pay_date DESC);


-- ── hero_item_defs.interest_cap ─────────────────────────────────────────────
-- Declared up here rather than beside the Sygnet at the bottom of the file:
-- bank_interest_draw() is LANGUAGE sql, so its body is parsed at CREATE time
-- and cannot reference a column that does not exist yet.
-- NULL = uncapped, which is what both interest items are today. The column and
-- every line of logic honouring it are the primary anti-inflation knob for
-- interest items — see the Sygnet section below.
ALTER TABLE public.hero_item_defs
  ADD COLUMN IF NOT EXISTS interest_cap bigint;

COMMENT ON COLUMN public.hero_item_defs.interest_cap IS
  'daily_interest items: pay interest on at most this many coins of balance. NULL = uncapped. Both interest_ring and banker_signet are capped at 20,000 since 2026-08-28 (supabase/anti-inflation.sql) — uncapped, the Sygnet compounded 2%/day of the whole money supply. Primary anti-inflation knob for interest items.';

ALTER TABLE public.hero_item_defs DROP CONSTRAINT IF EXISTS hero_item_defs_interest_cap_check;
ALTER TABLE public.hero_item_defs ADD CONSTRAINT hero_item_defs_interest_cap_check
  CHECK (interest_cap IS NULL OR interest_cap > 0);


-- ── RLS: read-only for clients, every write goes through a SECURITY DEFINER RPC
ALTER TABLE public.bank_deposits    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_bond_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_holdings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_dividends   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bank_deposits_select" ON public.bank_deposits;
CREATE POLICY "bank_deposits_select" ON public.bank_deposits
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "bank_bond_series_select" ON public.bank_bond_series;
CREATE POLICY "bank_bond_series_select" ON public.bank_bond_series
  FOR SELECT TO authenticated USING (true);

-- Holdings are public: the resale market needs to show other people's asks,
-- and "who owns a casino share" is deliberately a visible status thing.
DROP POLICY IF EXISTS "bank_holdings_select" ON public.bank_holdings;
CREATE POLICY "bank_holdings_select" ON public.bank_holdings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "bank_dividends_select" ON public.bank_dividends;
CREATE POLICY "bank_dividends_select" ON public.bank_dividends
  FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.bank_deposits, public.bank_bond_series,
              public.bank_holdings, public.bank_dividends FROM anon, authenticated;
GRANT SELECT ON public.bank_deposits, public.bank_bond_series,
                public.bank_holdings, public.bank_dividends TO authenticated;


-- ── Helper: casino house net for one Warsaw calendar day ───────────────────
-- Sums (bet - won) over the six SOLO house games for that day, excluding admin
-- play so the admin account cannot manufacture a dividend. Poker is excluded
-- on purpose: it is player-vs-player, so its "house net" is other players'
-- money, not burned coins.
CREATE OR REPLACE FUNCTION public.bank_house_net_for_day(p_day date)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_spec   text[][] := ARRAY[
    ['roulette_spins', 'total_bet'],
    ['slots_spins',    '10'],
    ['plinko_spins',   'bet'],
    ['mines_spins',    'bet'],
    ['crash_spins',    'total_bet'],
    ['wheel_spins',    'total_bet']
  ];
  v_total bigint := 0;
  v_part  bigint;
  i       integer;
BEGIN
  FOR i IN 1 .. array_length(v_spec, 1) LOOP
    IF to_regclass('public.' || v_spec[i][1]) IS NULL THEN CONTINUE; END IF;
    -- Half-open timestamp range rather than
    -- `(created_at AT TIME ZONE 'Europe/Warsaw')::date = p_day`: the latter is
    -- not sargable, so it seq-scans every spins table, 7 times per settled day,
    -- once per game.
    EXECUTE format(
      'SELECT COALESCE(sum(%s - s.total_won), 0)::bigint
         FROM public.%I s
         JOIN public.profiles p ON p.id = s.user_id
        WHERE NOT COALESCE(p.is_admin, false)
          AND s.created_at >= $1 AND s.created_at < $2',
      v_spec[i][2], v_spec[i][1]
    ) INTO v_part
      USING (p_day::timestamp AT TIME ZONE 'Europe/Warsaw'),
            ((p_day + 1)::timestamp AT TIME ZONE 'Europe/Warsaw');
    v_total := v_total + COALESCE(v_part, 0);
  END LOOP;
  RETURN v_total;
END;
$fn$;

REVOKE ALL ON FUNCTION public.bank_house_net_for_day(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_house_net_for_day(date) TO authenticated;


-- ── Helper: TRAILING-AVERAGE house net ─────────────────────────────────────
-- What a casino share actually pays on. Measured on prod, daily house net is
-- violently bursty: the week to 2026-08-23 was 25,998 on the 18th and ~0 on
-- every other day. Paying "2.5% of yesterday" off that series would hand a
-- shareholder one big day and six days of nothing, which reads as a broken
-- product rather than a variable one. Averaging over the trailing window pays
-- the same coins in total, smoothly — and still pays exactly 0 through a week
-- nobody gambles, which is the risk the share is sold on.
-- Negative days floor at 0 per-day (not per-window): a day the players beat
-- the house costs the shareholder that day's income, never last week's.
CREATE OR REPLACE FUNCTION public.bank_house_net_avg(p_day date, p_window integer DEFAULT 7)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(floor(avg(GREATEST(0, public.bank_house_net_for_day(d::date))))::bigint, 0)
    FROM generate_series(p_day - (p_window - 1), p_day, interval '1 day') d;
$fn$;

REVOKE ALL ON FUNCTION public.bank_house_net_avg(date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_house_net_avg(date, integer) TO authenticated;


-- Skarbonka interest: simple, per-day, bounded at 90 days so an abandoned
-- piggy bank is not an unbounded coin faucet.
CREATE OR REPLACE FUNCTION public.bank_piggy_interest(
  p_principal bigint, p_rate_bps integer, p_opened_at timestamptz
)
RETURNS bigint
LANGUAGE sql
STABLE
AS $fn$
  SELECT floor(
    p_principal * (p_rate_bps / 10000.0) *
    LEAST(90, floor(EXTRACT(epoch FROM (now() - p_opened_at)) / 86400.0))
  )::bigint;
$fn$;


-- ── Helper: what one open deposit is worth if you closed it RIGHT NOW ───────
-- Lokata accrues its total return pro-rata over the term (so a 29-day-old
-- 30-day lokata is not marked at bare principal on the leaderboard), but the
-- pro-rata part is unrealized — bank_close_deposit() still pays 0 interest
-- before maturity. Skarbonka shows real accrual only once past the 7-day lock,
-- because that is exactly what breaking it would pay.
CREATE OR REPLACE FUNCTION public.bank_deposit_mark(p_dep public.bank_deposits)
RETURNS bigint
LANGUAGE sql
STABLE
AS $fn$
  SELECT CASE
    WHEN p_dep.product = 'lokata' THEN
      p_dep.principal + floor(
        p_dep.principal * (p_dep.rate_bps / 10000.0) *
        LEAST(1.0, GREATEST(0.0,
          EXTRACT(epoch FROM (now() - p_dep.opened_at))
          / NULLIF(EXTRACT(epoch FROM (p_dep.matures_at - p_dep.opened_at)), 0)))
      )::bigint
    WHEN now() >= p_dep.matures_at THEN
      p_dep.principal + public.bank_piggy_interest(p_dep.principal, p_dep.rate_bps, p_dep.opened_at)
    ELSE p_dep.principal
  END;
$fn$;


-- ── Unpaid coupon backstop ─────────────────────────────────────────────────
-- How many coupon-days a bond has earned but not yet been credited for. The
-- daily accrual normally keeps this at 0; redemption pays whatever is left, so
-- a cron outage delays a holder's coupons but can never cost them any.
CREATE OR REPLACE FUNCTION public.bank_bond_unpaid_coupons(p_h public.bank_holdings)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT GREATEST(0,
    LEAST(
      -- coupon-days elapsed so far, never beyond the term
      floor(EXTRACT(epoch FROM (LEAST(now(), p_h.matures_at) - p_h.created_at)) / 86400.0)::bigint,
      floor(EXTRACT(epoch FROM (p_h.matures_at - p_h.created_at)) / 86400.0)::bigint
    ) * p_h.coupon_per_day
    - COALESCE((SELECT sum(amount) FROM public.bank_dividends
                 WHERE holding_id = p_h.id AND kind = 'bond'), 0)
  );
$fn$;


-- ── Net-worth helpers (called by leaderboard-net-worth-items.sql / economy-stats.sql)
-- Open deposits at mark-to-now, bonds at face + unpaid accrued coupons, shares
-- at what was paid for them (same convention hero items use).
CREATE OR REPLACE FUNCTION public.bank_user_assets(p_uid uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE((
           SELECT sum(public.bank_deposit_mark(d))
             FROM public.bank_deposits d
            WHERE d.user_id = p_uid AND d.closed_at IS NULL
         ), 0)::numeric
       + COALESCE((
           SELECT sum(h.face_value + public.bank_bond_unpaid_coupons(h))
             FROM public.bank_holdings h
            WHERE h.owner_id = p_uid AND h.kind = 'bond' AND h.redeemed_at IS NULL
         ), 0)::numeric
       + COALESCE((
           SELECT sum(h.purchase_price)
             FROM public.bank_holdings h
            WHERE h.owner_id = p_uid AND h.kind = 'share' AND h.redeemed_at IS NULL
         ), 0)::numeric;
$fn$;

REVOKE ALL ON FUNCTION public.bank_user_assets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bank_user_assets(uuid) TO anon, authenticated;

-- Server-wide total, non-admin only (the Skarbiec supply bucket).
CREATE OR REPLACE FUNCTION public.bank_total_assets()
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(sum(public.bank_user_assets(p.id)), 0)::numeric
    FROM public.profiles p
   WHERE NOT COALESCE(p.is_admin, false);
$fn$;

REVOKE ALL ON FUNCTION public.bank_total_assets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bank_total_assets() TO anon, authenticated;


-- ── Weekly bond series, opened on demand ───────────────────────────────────
-- Called from bank_settle_due(), so a series exists whenever anyone looks.
-- The code is derived from the ISO week, which makes the INSERT idempotent
-- without a lock: two concurrent callers race to the same unique code and the
-- loser's ON CONFLICT DO NOTHING is a no-op.
CREATE OR REPLACE FUNCTION public.bank_ensure_bond_series()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_now  timestamptz := now();
  v_code text := 'E' || to_char(v_now AT TIME ZONE 'Europe/Warsaw', 'IYYY"-"IW');
  v_size integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bank_bond_series
     WHERE closes_at > v_now AND sold < edition_size
  ) THEN
    RETURN;
  END IF;

  -- Edition size is whatever today's budget affords. Once a series is created
  -- its size is fixed for its whole life — the limit governs new issues, never
  -- one already on sale.
  v_size := COALESCE((public.bank_ensure_limits()).bond_edition, 25);

  INSERT INTO public.bank_bond_series
    (code, face_value, price, coupon_per_day, term_days, edition_size, opens_at, closes_at)
  VALUES
    (v_code, 1000, 1000, 8, 20, v_size, v_now, v_now + interval '7 days')
  ON CONFLICT (code) DO NOTHING;
END;
$fn$;

REVOKE ALL ON FUNCTION public.bank_ensure_bond_series() FROM PUBLIC, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- DYNAMIC LIMITS — the Bank lends what the economy can absorb
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every per-player limit here is recomputed once a Warsaw day from three
-- measured inputs and frozen for that day in bank_limits. Nothing is a magic
-- constant any more; the constants that remain describe a POLICY (what share
-- of the money supply the Bank is willing to create) rather than an amount.
--
--   1. cash_supply     — non-admin coins in circulation
--   2. net_mint_day    — the whole economy's mint minus burn over 30 days,
--                        per day, casino included
--   3. participants    — non-admin players with any ledger activity in 14 days
--
-- ── The formula ────────────────────────────────────────────────────────────
--
--   base    = BANK_BUDGET_BPS × cash_supply          (0.30%/day of the supply)
--   infl    = net_mint_day / cash_supply             (how fast money is growing)
--   health  = TARGET / (TARGET + max(0, infl))       (TARGET = 1%/day = neutral)
--   budget  = base × clamp(health, 0.15, 1.00)
--
-- health is the whole point: it is 1.0 when the economy is flat or shrinking
-- and falls away smoothly as inflation rises, so the Bank throttles ITSELF
-- when coins are already being created too fast, and opens back up when they
-- are not. Nobody has to remember to retune anything.
--
-- The budget is then split 55% lokata / 10% skarbonka / 35% obligacje, divided
-- among active players, and converted back into a principal cap by each
-- product's own daily yield. Results are rounded to 500 and clamped so a
-- product can never silently become pointless or unbounded.
--
-- ── Calibration, measured on prod 2026-08-23 ───────────────────────────────
--   cash_supply 360,776 · net_mint 9,685/day (+2.68%/day — from the farm and
--   the lottery; the Bank is not the cause) · 8 active players
--
--     health 0.27  ->  budget ~294/day  ->  lokata 4,500 · skarbonka 1,000 · 7 bonds
--
--   Those are today's tight numbers, and they are correct: a Bank promising
--   more while the money supply doubles every 26 days would just be pouring
--   petrol on it. As that inflation cools toward zero the same formula opens
--   up on its own to:
--
--     health 1.00  ->  budget ~1,082/day ->  lokata 16,000 · skarbonka 4,500 · 25 bonds
--
--   which is deliberately where the old hand-tuned constants sat. The policy
--   shares were fitted so that "what a healthy economy allows" reproduces them.
--
-- ⚠️ The Sygnet Bankiera is measured (`signet_draw`) but NOT deducted from the
-- budget. Deducting it would be defensible — it is by far the largest single
-- source of new coins — but it would also mean one player buying a Sygnet
-- shrinks everybody else's lokata limit, which is a griefing mechanic. It is
-- reported next to the budget instead, so the cost stays visible. Making it
-- deduct is a one-line change below: subtract v_signet from v_budget.

CREATE TABLE IF NOT EXISTS public.bank_limits (
  effective_date date PRIMARY KEY,
  cash_supply    bigint NOT NULL,
  net_mint_day   bigint NOT NULL,     -- may be negative (economy shrinking)
  inflation_bps  integer NOT NULL,    -- net_mint_day / cash_supply, in bps
  health_bps     integer NOT NULL,    -- 0..10000, the throttle
  participants   integer NOT NULL,
  budget_day     bigint NOT NULL,
  signet_draw    bigint NOT NULL,     -- informational; see note above
  lokata_cap     bigint NOT NULL,
  piggy_cap      bigint NOT NULL,
  bond_edition   integer NOT NULL,
  computed_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bank_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bank_limits_select" ON public.bank_limits;
CREATE POLICY "bank_limits_select" ON public.bank_limits
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.bank_limits FROM anon, authenticated;
GRANT SELECT ON public.bank_limits TO authenticated;


-- What every interest item in the game will mint tomorrow, scored exactly the
-- way award_daily_interest() scores it (best single item per user, honouring
-- interest_cap). Informational input to the limits row.
CREATE OR REPLACE FUNCTION public.bank_interest_draw()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH base AS (
    -- Same base as award_daily_interest(): cash + Bank deposit principal.
    SELECT p.id AS user_id,
           p.coins + COALESCE((
             SELECT sum(dd.principal) FROM public.bank_deposits dd
              WHERE dd.user_id = p.id AND dd.closed_at IS NULL
           ), 0) AS interest_base
      FROM public.profiles p
     WHERE NOT COALESCE(p.is_admin, false)
  ), candidates AS (
    SELECT b.user_id,
           FLOOR(LEAST(b.interest_base, COALESCE(d.interest_cap, b.interest_base)) * (d.effect_value / 100.0))::bigint AS amount
      FROM base b
      JOIN public.hero_item_instances i ON i.owner_id = b.user_id
      JOIN public.hero_item_defs d ON d.id = i.item_def_id
     WHERE d.effect_type = 'daily_interest' AND d.is_active
       AND (i.expires_at IS NULL OR i.expires_at > now())
  ), best AS (
    SELECT DISTINCT ON (user_id) amount FROM candidates ORDER BY user_id, amount DESC
  )
  SELECT COALESCE(sum(amount), 0)::bigint FROM best;
$fn$;

REVOKE ALL ON FUNCTION public.bank_interest_draw() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_interest_draw() TO authenticated;


-- The whole economy's net coin creation per day over a 30-day window: the coin
-- ledger plus the casino, which settles outside coin_transactions.
CREATE OR REPLACE FUNCTION public.bank_net_mint_per_day()
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_spec text[][] := ARRAY[
    ['roulette_spins','total_bet'], ['slots_spins','10'], ['plinko_spins','bet'],
    ['mines_spins','bet'], ['crash_spins','total_bet'], ['wheel_spins','total_bet']
  ];
  v_ledger bigint;
  v_casino bigint := 0;
  v_part   bigint;
  i        integer;
BEGIN
  SELECT COALESCE(sum(delta), 0)::bigint INTO v_ledger
    FROM public.coin_transactions
   WHERE created_at > now() - interval '30 days';

  -- Casino house net is a BURN, so it subtracts from net creation.
  FOR i IN 1 .. array_length(v_spec, 1) LOOP
    IF to_regclass('public.' || v_spec[i][1]) IS NULL THEN CONTINUE; END IF;
    EXECUTE format(
      'SELECT COALESCE(sum(%s - total_won), 0)::bigint FROM public.%I
        WHERE created_at > now() - interval ''30 days''',
      v_spec[i][2], v_spec[i][1]
    ) INTO v_part;
    v_casino := v_casino + COALESCE(v_part, 0);
  END LOOP;

  RETURN ((v_ledger - v_casino) / 30.0)::bigint;
END;
$fn$;

REVOKE ALL ON FUNCTION public.bank_net_mint_per_day() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_net_mint_per_day() TO authenticated;


-- Compute (or fetch) today's limits. Called from bank_settle_due(), so it runs
-- on every read and hourly from cron; the PK on effective_date makes it a
-- no-op for the rest of the day, which is what freezes the numbers. Freezing
-- matters: a limit that drifted between the moment you read it and the moment
-- you pressed the button would be indefensible in something calling itself a
-- bank.
CREATE OR REPLACE FUNCTION public.bank_ensure_limits()
RETURNS public.bank_limits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  -- POLICY constants. The only hand-set numbers left, and they are SHARES, not
  -- amounts, so they do not go stale as the economy grows.
  c_budget_bps   constant numeric := 30;    -- Bank may create 0.30%/day of supply
  c_target_bps   constant numeric := 100;   -- 1.00%/day inflation = neutral
  c_min_health   constant numeric := 0.15;
  c_lokata_share constant numeric := 0.55;
  c_piggy_share  constant numeric := 0.10;
  c_bond_share   constant numeric := 0.35;
  c_live_series  constant numeric := 3;     -- a 20-day bond, issued weekly
  -- Each product's daily yield, used to turn a coins/day budget back into a
  -- principal cap. Must match the rates in bank_open_deposit / the series row.
  c_lokata_daily constant numeric := 3000.0 / 30 / 10000;   -- 30-day lokata
  c_piggy_daily  constant numeric := 60.0 / 10000;
  c_bond_coupon  constant numeric := 8;

  v_row     public.bank_limits;
  v_today   date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_supply  bigint;
  v_net     bigint;
  v_infl    numeric;
  v_health  numeric;
  v_budget  numeric;
  v_players integer;
  v_signet  bigint;
BEGIN
  SELECT * INTO v_row FROM public.bank_limits WHERE effective_date = v_today;
  IF FOUND THEN RETURN v_row; END IF;

  SELECT COALESCE(sum(coins), 0)::bigint INTO v_supply
    FROM public.profiles WHERE NOT COALESCE(is_admin, false);
  v_supply := GREATEST(v_supply, 1);

  v_net := public.bank_net_mint_per_day();
  v_signet := public.bank_interest_draw();

  SELECT GREATEST(1, count(DISTINCT user_id))::integer INTO v_players
    FROM public.coin_transactions
   WHERE created_at > now() - interval '14 days'
     AND user_id IN (SELECT id FROM public.profiles WHERE NOT COALESCE(is_admin, false));

  v_infl := GREATEST(0, v_net::numeric / v_supply) * 10000;    -- bps
  v_health := LEAST(1.0, GREATEST(c_min_health, c_target_bps / (c_target_bps + v_infl)));
  v_budget := (c_budget_bps / 10000) * v_supply * v_health;

  INSERT INTO public.bank_limits (
    effective_date, cash_supply, net_mint_day, inflation_bps, health_bps,
    participants, budget_day, signet_draw, lokata_cap, piggy_cap, bond_edition
  ) VALUES (
    v_today, v_supply, v_net,
    round(v_infl)::integer, round(v_health * 10000)::integer,
    v_players, round(v_budget)::bigint, v_signet,
    -- rounded to 500, then clamped: a product must never become pointless
    -- (floor) or unbounded (ceiling), whatever the measurement says.
    LEAST(40000, GREATEST(1000,
      round(v_budget * c_lokata_share / v_players / c_lokata_daily / 500) * 500))::bigint,
    LEAST(8000, GREATEST(500,
      round(v_budget * c_piggy_share / v_players / c_piggy_daily / 500) * 500))::bigint,
    LEAST(40, GREATEST(3,
      round(v_budget * c_bond_share / c_bond_coupon / c_live_series)))::integer
  )
  ON CONFLICT (effective_date) DO NOTHING;

  SELECT * INTO v_row FROM public.bank_limits WHERE effective_date = v_today;
  RETURN v_row;
END;
$fn$;

REVOKE ALL ON FUNCTION public.bank_ensure_limits() FROM PUBLIC, anon, authenticated;


-- ── The settler ────────────────────────────────────────────────────────────
-- Idempotent and date-driven, so it is safe to call from anywhere, as often as
-- anything likes: bank_state() calls it on every read (crash/wheel-style lazy
-- resolve), an hourly cron calls it too. Nothing here depends on having run
-- "on time" — a 14-day lookback plus the redemption backstop means a cron
-- outage delays payouts rather than losing them.
--
-- ⚠️ Every profiles UPDATE here goes through a per-user SUM first. `UPDATE
-- profiles p SET coins = p.coins + x.amount FROM cte x WHERE p.id = x.user_id`
-- looks obviously right and is wrong: when the CTE holds several rows for one
-- profile (five casino shares paying on the same day, two bonds maturing in
-- the same run) Postgres updates that row ONCE against an arbitrary match and
-- silently drops the rest. It cost 24 of 48 coupon coins in the very first
-- smoke test of this file, while bank_dividends still recorded all 48 as paid.
CREATE OR REPLACE FUNCTION public.bank_settle_due()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_today   date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_day     date;
  v_avg     bigint;
  v_divs    bigint := 0;
  v_coupons bigint := 0;
  v_bonds   integer := 0;
  v_deps    integer := 0;
  v_n       bigint;
BEGIN
  -- Freeze today's limits before anything reads them (and before a new bond
  -- series sizes itself off bond_edition).
  PERFORM public.bank_ensure_limits();
  PERFORM public.bank_ensure_bond_series();

  -- 1. Casino shares: each share takes share_bps of the trailing-7-day average
  --    house net. Funded entirely out of coins gamblers already burned.
  FOR v_day IN
    SELECT d::date FROM generate_series(v_today - 14, v_today - 1, interval '1 day') d
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.bank_holdings
                    WHERE kind = 'share' AND redeemed_at IS NULL
                      AND (created_at AT TIME ZONE 'Europe/Warsaw')::date < v_day) THEN
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM public.bank_dividends WHERE pay_date = v_day AND kind = 'share') THEN
      CONTINUE;   -- already settled; the PK would no-op anyway, this skips the work
    END IF;

    v_avg := public.bank_house_net_avg(v_day, 7);

    WITH ins AS (
      INSERT INTO public.bank_dividends (pay_date, holding_id, user_id, kind, amount)
      SELECT v_day, h.id, h.owner_id, 'share',
             floor(v_avg * (h.share_bps / 10000.0))::bigint
        FROM public.bank_holdings h
       WHERE h.kind = 'share' AND h.redeemed_at IS NULL
         AND (h.created_at AT TIME ZONE 'Europe/Warsaw')::date < v_day
      ON CONFLICT DO NOTHING
      RETURNING user_id, amount
    ), agg AS (
      SELECT user_id, sum(amount) AS amount FROM ins GROUP BY user_id HAVING sum(amount) > 0
    ), paid AS (
      UPDATE public.profiles p SET coins = p.coins + a.amount
        FROM agg a WHERE p.id = a.user_id
       RETURNING a.user_id, a.amount
    ), logged AS (
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      SELECT user_id, amount, 'bank_share_dividend',
             jsonb_build_object('pay_date', v_day, 'house_net_avg', v_avg)
        FROM paid
       RETURNING delta
    )
    SELECT COALESCE(sum(delta), 0) INTO v_n FROM logged;
    v_divs := v_divs + COALESCE(v_n, 0);
  END LOOP;

  -- 2. Bond coupons: a flat per-day amount for every day the bond was held
  --    inside its term. bank_state() calls this whole function on every tab
  --    open, so skip the 14 round trips when there is nothing to accrue.
  IF EXISTS (SELECT 1 FROM public.bank_holdings WHERE kind = 'bond' AND redeemed_at IS NULL) THEN
  FOR v_day IN
    SELECT d::date FROM generate_series(v_today - 14, v_today - 1, interval '1 day') d
  LOOP
    WITH ins AS (
      INSERT INTO public.bank_dividends (pay_date, holding_id, user_id, kind, amount)
      SELECT v_day, h.id, h.owner_id, 'bond', h.coupon_per_day
        FROM public.bank_holdings h
       WHERE h.kind = 'bond' AND h.redeemed_at IS NULL
         AND (h.created_at AT TIME ZONE 'Europe/Warsaw')::date < v_day
         AND v_day <= (h.matures_at AT TIME ZONE 'Europe/Warsaw')::date
      ON CONFLICT DO NOTHING
      RETURNING user_id, amount
    ), agg AS (
      SELECT user_id, sum(amount) AS amount FROM ins GROUP BY user_id HAVING sum(amount) > 0
    ), paid AS (
      UPDATE public.profiles p SET coins = p.coins + a.amount
        FROM agg a WHERE p.id = a.user_id
       RETURNING a.user_id, a.amount
    ), logged AS (
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      SELECT user_id, amount, 'bank_bond_coupon', jsonb_build_object('pay_date', v_day)
        FROM paid
       RETURNING delta
    )
    SELECT COALESCE(sum(delta), 0) INTO v_n FROM logged;
    v_coupons := v_coupons + COALESCE(v_n, 0);
  END LOOP;
  END IF;

  -- 3. Redeem matured bonds. The coupon top-up here is what makes a missed
  --    accrual day recoverable rather than lost.
  WITH due AS (
    SELECT h.id, h.owner_id, h.face_value,
           public.bank_bond_unpaid_coupons(h) AS rest
      FROM public.bank_holdings h
     WHERE h.kind = 'bond' AND h.redeemed_at IS NULL AND h.matures_at <= now()
  ), closed AS (
    UPDATE public.bank_holdings h
       SET redeemed_at = now(), ask_price = NULL
      FROM due WHERE h.id = due.id AND h.redeemed_at IS NULL
     RETURNING due.id, due.owner_id, due.face_value, due.rest
  ), agg AS (
    SELECT owner_id, sum(face_value + rest) AS total FROM closed GROUP BY owner_id
  ), paid AS (
    UPDATE public.profiles p SET coins = p.coins + a.total
      FROM agg a WHERE p.id = a.owner_id
     RETURNING a.owner_id
  ), log_face AS (
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    SELECT owner_id, face_value, 'bank_bond_redeem', jsonb_build_object('holding_id', id)
      FROM closed RETURNING 1
  ), log_rest AS (
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    SELECT owner_id, rest, 'bank_bond_coupon',
           jsonb_build_object('holding_id', id, 'final', true)
      FROM closed WHERE rest > 0 RETURNING 1
  )
  SELECT count(*)::integer INTO v_bonds FROM log_face;

  -- 4. Auto-close matured lokaty. Skarbonka is deliberately NOT auto-closed:
  --    it has no term, only a 7-day interest lock, and it keeps accruing.
  WITH due AS (
    SELECT d.id, d.user_id, d.principal,
           floor(d.principal * (d.rate_bps / 10000.0))::bigint AS interest
      FROM public.bank_deposits d
     WHERE d.product = 'lokata' AND d.closed_at IS NULL AND d.matures_at <= now()
  ), closed AS (
    UPDATE public.bank_deposits d
       SET closed_at = now(), payout = due.principal + due.interest, interest = due.interest
      FROM due WHERE d.id = due.id AND d.closed_at IS NULL
     RETURNING due.id, due.user_id, due.principal, due.interest
  ), agg AS (
    SELECT user_id, sum(principal + interest) AS total FROM closed GROUP BY user_id
  ), paid AS (
    UPDATE public.profiles p SET coins = p.coins + a.total
      FROM agg a WHERE p.id = a.user_id
     RETURNING a.user_id
  ), log_principal AS (
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    SELECT user_id, principal, 'bank_deposit_close', jsonb_build_object('deposit_id', id)
      FROM closed RETURNING 1
  ), log_interest AS (
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    SELECT user_id, interest, 'bank_deposit_interest', jsonb_build_object('deposit_id', id)
      FROM closed WHERE interest > 0 RETURNING 1
  )
  SELECT count(*)::integer INTO v_deps FROM log_principal;

  RETURN json_build_object(
    'ok', true, 'day', v_today,
    'share_dividends', v_divs, 'bond_coupons', v_coupons,
    'bonds_redeemed', v_bonds, 'deposits_matured', v_deps
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.bank_settle_due() FROM PUBLIC, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- RPCs. Every one of them is the only write path for its product; clients hold
-- SELECT and nothing else.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Lokata / Skarbonka: open ───────────────────────────────────────────────
-- p_term_days is required for 'lokata' (7 | 14 | 30) and ignored for
-- 'skarbonka'. The per-product principal caps are what keep a whale from
-- turning the interest line into an unbounded faucet; they are checked against
-- the sum of OPEN deposits, so closing one frees the headroom again.
CREATE OR REPLACE FUNCTION public.bank_open_deposit(
  p_product text, p_amount bigint, p_term_days integer DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user      uuid := auth.uid();
  v_rate      integer;
  v_matures   timestamptz;
  v_open      bigint;
  v_cap       bigint;
  v_coins     bigint;
  v_dep       public.bank_deposits%ROWTYPE;
  v_limits    public.bank_limits%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_product NOT IN ('lokata','skarbonka') THEN RAISE EXCEPTION 'bad_product'; END IF;
  IF p_amount IS NULL OR p_amount < 500 THEN RAISE EXCEPTION 'amount_too_small'; END IF;

  -- Caps come from today's frozen bank_limits row, not from a constant — see
  -- bank_ensure_limits(). Rates stay fixed and are stored on the deposit row,
  -- so a limit change never touches an open deposit.
  v_limits := public.bank_ensure_limits();

  IF p_product = 'lokata' THEN
    v_rate := CASE p_term_days WHEN 7 THEN 500 WHEN 14 THEN 1200 WHEN 30 THEN 3000 END;
    IF v_rate IS NULL THEN RAISE EXCEPTION 'bad_term'; END IF;
    v_matures := now() + make_interval(days => p_term_days);
    v_cap := v_limits.lokata_cap;
  ELSE
    v_rate := 60;                                  -- 0.60%/day, simple
    p_term_days := NULL;
    v_matures := now() + interval '7 days';        -- interest unlock, not a term
    v_cap := v_limits.piggy_cap;
  END IF;

  SELECT COALESCE(sum(principal), 0) INTO v_open
    FROM public.bank_deposits
   WHERE user_id = v_user AND product = p_product AND closed_at IS NULL;
  IF v_open + p_amount > v_cap THEN RAISE EXCEPTION 'over_cap'; END IF;

  UPDATE public.profiles SET coins = coins - p_amount
   WHERE id = v_user AND coins >= p_amount
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  INSERT INTO public.bank_deposits (user_id, product, principal, rate_bps, term_days, matures_at)
  VALUES (v_user, p_product, p_amount, v_rate, p_term_days, v_matures)
  RETURNING * INTO v_dep;

  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, -p_amount, 'bank_deposit_open',
          jsonb_build_object('deposit_id', v_dep.id, 'product', p_product,
                             'term_days', p_term_days, 'rate_bps', v_rate));

  RETURN json_build_object('ok', true, 'deposit_id', v_dep.id,
                           'matures_at', v_dep.matures_at, 'coins_left', v_coins);
END;
$fn$;


-- ── Lokata / Skarbonka: close ──────────────────────────────────────────────
-- Lokata before maturity and Skarbonka before day 7 both return the principal
-- and nothing else. Forfeiting interest (rather than charging a fee) is what
-- makes the lock real without ever letting a player end up worse off in coins
-- than they started — nobody should be able to lose money in the "safe" product.
CREATE OR REPLACE FUNCTION public.bank_close_deposit(p_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user     uuid := auth.uid();
  v_dep      public.bank_deposits%ROWTYPE;
  v_interest bigint := 0;
  v_early    boolean := false;
  v_coins    bigint;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_dep FROM public.bank_deposits
   WHERE id = p_id AND user_id = v_user AND closed_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deposit_not_found'; END IF;

  IF now() >= v_dep.matures_at THEN
    v_interest := CASE
      WHEN v_dep.product = 'lokata'
        THEN floor(v_dep.principal * (v_dep.rate_bps / 10000.0))::bigint
      ELSE public.bank_piggy_interest(v_dep.principal, v_dep.rate_bps, v_dep.opened_at)
    END;
  ELSE
    v_early := true;
  END IF;

  UPDATE public.bank_deposits
     SET closed_at = now(), payout = v_dep.principal + v_interest,
         interest = v_interest, broke_early = v_early
   WHERE id = v_dep.id;

  UPDATE public.profiles SET coins = coins + v_dep.principal + v_interest
   WHERE id = v_user RETURNING coins INTO v_coins;

  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, v_dep.principal, 'bank_deposit_close',
          jsonb_build_object('deposit_id', v_dep.id, 'early', v_early));
  IF v_interest > 0 THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, v_interest, 'bank_deposit_interest',
            jsonb_build_object('deposit_id', v_dep.id));
  END IF;

  RETURN json_build_object('ok', true, 'principal', v_dep.principal,
                           'interest', v_interest, 'early', v_early,
                           'coins_left', v_coins);
END;
$fn$;


-- ── Obligacje: buy from the open series ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bank_buy_bond(p_qty integer DEFAULT 1)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user   uuid := auth.uid();
  v_ser    public.bank_bond_series%ROWTYPE;
  v_cost   bigint;
  v_coins  bigint;
  v_i      integer;
  v_ids    uuid[] := ARRAY[]::uuid[];
  v_id     uuid;
  v_fair   integer;
  v_mine   integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > 10 THEN RAISE EXCEPTION 'bad_qty'; END IF;

  PERFORM public.bank_ensure_bond_series();

  SELECT * INTO v_ser FROM public.bank_bond_series
   WHERE closes_at > now() AND sold < edition_size
   ORDER BY opens_at DESC LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_open_series'; END IF;
  IF v_ser.sold + p_qty > v_ser.edition_size THEN RAISE EXCEPTION 'sold_out'; END IF;

  -- ── Per-player fair share ─────────────────────────────────────────────────
  -- Bonds were the one product with no per-player limit, which did not matter
  -- much at 25 units but is indefensible at 4: whoever opened the tab first on
  -- Monday took the entire weekly issue in one click and everybody else got
  -- nothing, every week. Same fair-share shape the farm land tax already uses,
  -- ceil(capacity / active participants).
  v_fair := GREATEST(1, CEIL(
    v_ser.edition_size::numeric / GREATEST(1, COALESCE((public.bank_ensure_limits()).participants, 1))
  ))::integer;

  -- Lifted for the last two days of the issue. A fair share that leaves stock
  -- unsold at expiry is not fair to anyone, so once everyone has had their
  -- window the remainder is open to whoever still wants it.
  IF now() >= v_ser.closes_at - interval '2 days' THEN
    v_fair := v_ser.edition_size;
  END IF;

  SELECT count(*) INTO v_mine FROM public.bank_holdings
   WHERE kind = 'bond' AND owner_id = v_user
     AND series_id = v_ser.id AND acquired_from = 'treasury';
  IF v_mine + p_qty > v_fair THEN RAISE EXCEPTION 'bond_user_limit'; END IF;

  v_cost := v_ser.price * p_qty;
  UPDATE public.profiles SET coins = coins - v_cost
   WHERE id = v_user AND coins >= v_cost
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  FOR v_i IN 1 .. p_qty LOOP
    INSERT INTO public.bank_holdings
      (kind, owner_id, serial_no, series_id, face_value, coupon_per_day,
       matures_at, purchase_price)
    VALUES
      ('bond', v_user, v_ser.sold + v_i, v_ser.id, v_ser.face_value,
       v_ser.coupon_per_day, now() + make_interval(days => v_ser.term_days), v_ser.price)
    RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
  END LOOP;

  UPDATE public.bank_bond_series SET sold = sold + p_qty WHERE id = v_ser.id;

  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, -v_cost, 'bank_bond_buy',
          jsonb_build_object('series', v_ser.code, 'qty', p_qty));

  RETURN json_build_object('ok', true, 'qty', p_qty, 'series', v_ser.code,
                           'ids', to_json(v_ids), 'coins_left', v_coins);
END;
$fn$;


-- ── Udziały w Kasynie: buy from the treasury ───────────────────────────────
-- 30 shares exist, ever; 5 per player on the primary sale so the first person
-- with 20,000 spare coins cannot take the whole float. Resale is uncapped —
-- those coins go to another player rather than out of the economy, so
-- concentration there is a market outcome, not a design failure.
CREATE OR REPLACE FUNCTION public.bank_buy_share(p_qty integer DEFAULT 1)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user  uuid := auth.uid();
  v_price bigint := 4000;
  v_supply integer := 30;
  v_bps   integer := 300;
  v_max   integer := 5;
  v_sold  integer;
  v_mine  integer;
  v_cost  bigint;
  v_coins bigint;
  v_i     integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > v_max THEN RAISE EXCEPTION 'bad_qty'; END IF;

  -- Serialize primary sales across ALL callers. A row lock on the buyer's own
  -- profile would not do it: two different buyers lock two different rows, both
  -- read the same `sold`, and the 30-share float quietly becomes 31.
  PERFORM pg_advisory_xact_lock(hashtext('bank_share_primary_sale'));

  SELECT count(*) INTO v_sold FROM public.bank_holdings WHERE kind = 'share';
  IF v_sold + p_qty > v_supply THEN RAISE EXCEPTION 'sold_out'; END IF;

  SELECT count(*) INTO v_mine FROM public.bank_holdings
   WHERE kind = 'share' AND owner_id = v_user AND acquired_from = 'treasury';
  IF v_mine + p_qty > v_max THEN RAISE EXCEPTION 'per_user_limit'; END IF;

  v_cost := v_price * p_qty;
  UPDATE public.profiles SET coins = coins - v_cost
   WHERE id = v_user AND coins >= v_cost
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  FOR v_i IN 1 .. p_qty LOOP
    INSERT INTO public.bank_holdings
      (kind, owner_id, serial_no, share_bps, purchase_price)
    VALUES ('share', v_user, v_sold + v_i, v_bps, v_price);
  END LOOP;

  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, -v_cost, 'bank_share_buy', jsonb_build_object('qty', p_qty));

  RETURN json_build_object('ok', true, 'qty', p_qty, 'coins_left', v_coins);
END;
$fn$;


-- ── Secondary market: one ask price per holding, instant buyout ────────────
-- Deliberately not an auction with escrow (the Targowisko engine already does
-- that): a bond has an objectively computable value, so the interesting part
-- is whether someone will pay a premium for the time left on it, not bidding
-- drama. Coins move buyer → seller; nothing is minted or burned.
CREATE OR REPLACE FUNCTION public.bank_list_holding(p_id uuid, p_price bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_price IS NULL OR p_price < 1 OR p_price > 10000000 THEN RAISE EXCEPTION 'bad_price'; END IF;

  UPDATE public.bank_holdings SET ask_price = p_price
   WHERE id = p_id AND owner_id = v_user AND redeemed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'holding_not_found'; END IF;

  RETURN json_build_object('ok', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.bank_unlist_holding(p_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  UPDATE public.bank_holdings SET ask_price = NULL
   WHERE id = p_id AND owner_id = v_user AND redeemed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'holding_not_found'; END IF;
  RETURN json_build_object('ok', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.bank_buy_holding(p_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user  uuid := auth.uid();
  v_h     public.bank_holdings%ROWTYPE;
  v_coins bigint;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_h FROM public.bank_holdings
   WHERE id = p_id AND redeemed_at IS NULL AND ask_price IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_for_sale'; END IF;
  IF v_h.owner_id = v_user THEN RAISE EXCEPTION 'own_listing'; END IF;
  -- A matured-but-unredeemed bond must not change hands: the redeemer would be
  -- buying a payout the settler is about to hand the seller.
  IF v_h.kind = 'bond' AND v_h.matures_at <= now() THEN RAISE EXCEPTION 'bond_matured'; END IF;

  UPDATE public.profiles SET coins = coins - v_h.ask_price
   WHERE id = v_user AND coins >= v_h.ask_price
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  UPDATE public.profiles SET coins = coins + v_h.ask_price WHERE id = v_h.owner_id;

  UPDATE public.bank_holdings
     SET owner_id = v_user, ask_price = NULL,
         purchase_price = v_h.ask_price, acquired_from = 'resale'
   WHERE id = v_h.id;

  INSERT INTO public.coin_transactions (user_id, delta, reason, meta) VALUES
    (v_user, -v_h.ask_price, 'bank_resale_purchase',
     jsonb_build_object('holding_id', v_h.id, 'kind', v_h.kind, 'seller', v_h.owner_id)),
    (v_h.owner_id, v_h.ask_price, 'bank_resale_sale',
     jsonb_build_object('holding_id', v_h.id, 'kind', v_h.kind, 'buyer', v_user));

  RETURN json_build_object('ok', true, 'kind', v_h.kind,
                           'price', v_h.ask_price, 'coins_left', v_coins);
END;
$fn$;


-- ── One read for the whole tab ─────────────────────────────────────────────
-- Settles first (lazy resolve), then returns every panel's data in one round
-- trip. VOLATILE because of that settle — it is not a pure read.
CREATE OR REPLACE FUNCTION public.bank_state()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  PERFORM public.bank_settle_due();

  RETURN json_build_object(
    'ok', true,
    'coins', (SELECT coins FROM public.profiles WHERE id = v_user),

    'deposits', COALESCE((
      SELECT json_agg(row_to_json(x) ORDER BY x.opened_at DESC) FROM (
        SELECT d.id, d.product, d.principal, d.rate_bps, d.term_days,
               d.opened_at, d.matures_at, d.closed_at, d.payout, d.interest,
               d.broke_early,
               public.bank_deposit_mark(d) AS mark,
               CASE WHEN d.product = 'lokata'
                    THEN floor(d.principal * (d.rate_bps / 10000.0))::bigint
                    ELSE public.bank_piggy_interest(d.principal, d.rate_bps, d.opened_at)
               END AS interest_if_held
          FROM public.bank_deposits d
         WHERE d.user_id = v_user
           AND (d.closed_at IS NULL OR d.closed_at > now() - interval '14 days')
      ) x
    ), '[]'::json),

    'series', (
      SELECT row_to_json(s) FROM (
        SELECT bs.code, bs.face_value, bs.price, bs.coupon_per_day, bs.term_days,
               bs.edition_size, bs.sold, bs.closes_at,
               -- fair share per player, and whether the final-days lift is on
               CASE WHEN now() >= bs.closes_at - interval '2 days' THEN bs.edition_size
                    ELSE GREATEST(1, CEIL(bs.edition_size::numeric
                           / GREATEST(1, COALESCE((SELECT participants FROM public.bank_limits
                                                    WHERE effective_date = v_today), 1))))::integer
               END AS per_user,
               (now() >= bs.closes_at - interval '2 days') AS open_to_all,
               COALESCE((SELECT count(*) FROM public.bank_holdings h
                          WHERE h.kind = 'bond' AND h.owner_id = v_user
                            AND h.series_id = bs.id AND h.acquired_from = 'treasury'), 0) AS mine
          FROM public.bank_bond_series bs
         WHERE bs.closes_at > now() AND bs.sold < bs.edition_size
         ORDER BY bs.opens_at DESC LIMIT 1
      ) s
    ),

    'holdings', COALESCE((
      SELECT json_agg(row_to_json(x) ORDER BY x.created_at DESC) FROM (
        SELECT h.id, h.kind, h.serial_no, h.face_value, h.coupon_per_day,
               h.matures_at, h.share_bps, h.purchase_price, h.ask_price,
               h.created_at,
               CASE WHEN h.kind = 'bond' THEN public.bank_bond_unpaid_coupons(h) ELSE 0 END AS accrued,
               COALESCE((SELECT sum(amount) FROM public.bank_dividends bd
                          WHERE bd.holding_id = h.id AND bd.user_id = v_user), 0) AS earned,
               (SELECT bs.code FROM public.bank_bond_series bs WHERE bs.id = h.series_id) AS series_code
          FROM public.bank_holdings h
         WHERE h.owner_id = v_user AND h.redeemed_at IS NULL
      ) x
    ), '[]'::json),

    'market', COALESCE((
      SELECT json_agg(row_to_json(x) ORDER BY x.ask_price ASC) FROM (
        SELECT h.id, h.kind, h.serial_no, h.face_value, h.coupon_per_day,
               h.matures_at, h.share_bps, h.ask_price, h.owner_id,
               p.nick AS owner_nick, h.owner_id = v_user AS mine,
               CASE WHEN h.kind = 'bond' THEN public.bank_bond_unpaid_coupons(h) ELSE 0 END AS accrued
          FROM public.bank_holdings h
          JOIN public.profiles p ON p.id = h.owner_id
         WHERE h.ask_price IS NOT NULL AND h.redeemed_at IS NULL
           AND (h.kind <> 'bond' OR h.matures_at > now())
      ) x
    ), '[]'::json),

    'shares', json_build_object(
      'price', 4000, 'supply', 30, 'share_bps', 300, 'max_per_user', 5,
      'sold', (SELECT count(*) FROM public.bank_holdings WHERE kind = 'share'),
      'mine_treasury', (SELECT count(*) FROM public.bank_holdings
                         WHERE kind = 'share' AND owner_id = v_user
                           AND acquired_from = 'treasury'),
      -- The same trailing-7-day average the next payout will actually be
      -- computed from, so the indicative yield the UI prints is not a
      -- different number from the one that lands. Indicative, not promised.
      'house_net_avg', public.bank_house_net_avg(v_today - 1, 7),
      'house_net_avg_30', public.bank_house_net_avg(v_today - 1, 30),
      'last_day', (SELECT max(pay_date) FROM public.bank_dividends WHERE kind = 'share')
    ),

    'dividends', COALESCE((
      SELECT json_agg(row_to_json(x) ORDER BY x.pay_date DESC) FROM (
        SELECT bd.pay_date, bd.kind, sum(bd.amount) AS amount
          FROM public.bank_dividends bd
         WHERE bd.user_id = v_user AND bd.pay_date > v_today - 30
         GROUP BY bd.pay_date, bd.kind
      ) x
    ), '[]'::json),

    -- `owned` is the Sygnet specifically; `better` is any OTHER interest item
    -- that already beats it (today: only the uncapped legendary ring). They are
    -- separate because award_daily_interest() pays the best item and only the
    -- best, so someone holding the ring must be told the Sygnet would add
    -- nothing — before they spend 8,000 on it.
    -- `owned` is the Sygnet specifically. `better` names any OTHER interest
    -- item the caller holds that already pays them at least as much. Both
    -- interest items now share the same 20,000 cap, so above that balance they
    -- are an exact tie; it is scored the same way award_daily_interest() scores
    -- it (at the caller's actual balance) rather than compared on caps. Buying
    -- a second interest item adds nothing: only the best one pays.
    'signet', json_build_object(
      -- The cap and the rate come from the def row, never from a client
      -- constant: interest_cap moved from NULL to 20,000 on 2026-08-28
      -- (anti-inflation.sql) and the rate card must follow it automatically.
      'pct',   (SELECT d.effect_value FROM public.hero_item_defs d WHERE d.slug = 'banker_signet'),
      'cap',   (SELECT d.interest_cap FROM public.hero_item_defs d WHERE d.slug = 'banker_signet'),
      'price', (SELECT d.price        FROM public.hero_item_defs d WHERE d.slug = 'banker_signet'),
      'owned', EXISTS (SELECT 1 FROM public.hero_item_instances i
                        JOIN public.hero_item_defs d ON d.id = i.item_def_id
                       WHERE i.owner_id = v_user AND d.slug = 'banker_signet'),
      'better', (
        WITH bal AS (SELECT coins FROM public.profiles WHERE id = v_user),
        scored AS (
          SELECT d.slug, d.name,
                 FLOOR(LEAST(b.coins, COALESCE(d.interest_cap, b.coins))
                       * (d.effect_value / 100.0)) AS pays
            FROM public.hero_item_instances i
            JOIN public.hero_item_defs d ON d.id = i.item_def_id
            CROSS JOIN bal b
           WHERE i.owner_id = v_user AND d.effect_type = 'daily_interest' AND d.is_active
             AND (i.expires_at IS NULL OR i.expires_at > now())
        )
        SELECT name FROM scored
         WHERE slug <> 'banker_signet'
           AND pays >= COALESCE((SELECT pays FROM scored WHERE slug = 'banker_signet'), 0)
         ORDER BY pays DESC LIMIT 1
      ),
      'paid_total', COALESCE((SELECT sum(amount) FROM public.hero_daily_interest_awards
                               WHERE user_id = v_user), 0)
    ),

    -- Today's frozen limits, plus the inputs they were derived from and a week
    -- of history — the UI shows all of it, because a limit nobody can explain
    -- is indistinguishable from an arbitrary one.
    'limits', (SELECT row_to_json(l) FROM public.bank_limits l
                WHERE l.effective_date = v_today),
    'limits_history', COALESCE((
      SELECT json_agg(row_to_json(l) ORDER BY l.effective_date DESC)
        FROM (SELECT * FROM public.bank_limits
               ORDER BY effective_date DESC LIMIT 8) l
    ), '[]'::json),

    'caps', json_build_object(
      'lokata_max', (SELECT lokata_cap FROM public.bank_limits WHERE effective_date = v_today),
      'lokata_min', 500,
      'piggy_max', (SELECT piggy_cap FROM public.bank_limits WHERE effective_date = v_today),
      'lokata_open', COALESCE((SELECT sum(principal) FROM public.bank_deposits
                                WHERE user_id = v_user AND product = 'lokata'
                                  AND closed_at IS NULL), 0),
      'piggy_open', COALESCE((SELECT sum(principal) FROM public.bank_deposits
                               WHERE user_id = v_user AND product = 'skarbonka'
                                 AND closed_at IS NULL), 0)
    )
  );
END;
$fn$;


REVOKE ALL ON FUNCTION public.bank_state() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_open_deposit(text, bigint, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_close_deposit(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_buy_bond(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_buy_share(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_list_holding(uuid, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_unlist_holding(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_buy_holding(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.bank_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_open_deposit(text, bigint, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_close_deposit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_buy_bond(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_buy_share(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_list_holding(uuid, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_unlist_holding(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_buy_holding(uuid) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 💍 „Sygnet Bankiera" — Filip's ring, on exactly Filip's terms, for everyone
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 2%/day of your cash balance, on the FIRST 20,000 coins of base — at most
-- 400/day. `interest_ring`, the legendary 1-of-1, carries the same cap.
--
-- It shipped uncapped ("no cap, no ceiling, no asterisk", at parity with the
-- ring, because selling anyone a weaker copy of an item somebody else already
-- owns is the unfair version) and that was the mistake. The paragraph below is
-- the original warning, and it is exactly what happened.
--
-- ⚠️ READ THIS BEFORE RETUNING ANYTHING ELSE IN THIS FILE. An uncapped
-- percentage of a balance is UNBOUNDED and COMPOUNDING, so it is not merely
-- the largest line in the bank — at office scale it is roughly the whole
-- thing. With all 11 players holding one against 2026-08-23's 360,776 coins of
-- circulating cash it mints ~7,215/day and doubles the money supply in ~35
-- days, against ~1,400/day from all four bank products put together and a
-- ~2,951/day casino burn. That is the deliberate, known cost of parity.
--
-- Price 15,000. Payback, ignoring compounding:
--
--     balance 10,353 (median)   207/day   ~72 days
--     balance 30,000            600/day   ~25 days
--     balance 68,719 (Filip)  1,374/day   ~11 days
--
-- Note the shape: an uncapped percentage pays a big balance back ~6.5× faster
-- than a median one, so the item is regressive by construction. That is
-- inherent to "same rate for everyone" and is the trade being made. The
-- 15,000 price is what stops it being a trivial pickup — it is ~4% of the
-- entire money supply, and 11 copies burn 165,000 up front, which covers the
-- first ~23 days of what they then mint.
--
-- ── If it does run hot, the knobs, cheapest first ──────────────────────────
--   1. `interest_cap` on this def (the column and all the logic that honours
--      it are still here — it is simply NULL). Setting it to e.g. 12,000 caps
--      payouts at 240/day/player without touching anyone's existing item.
--   2. `effect_value` 2 → 1. Halves every payout, including the legacy ring's.
--   3. `edition_size` + a sale_type flip, to make it scarce instead of capped.
-- All three are data changes on one row; none needs a code deploy.
--
-- The other brake is real but modest: interest is paid on CASH, and cash is
-- the one asset in this game that does nothing else. Coins locked in a Lokata,
-- spent on lootboxes, or sitting in a market position earn nothing here.

INSERT INTO public.hero_item_defs
  (slug, name, emoji, slot, price, rarity, description, effect_game, effect_type,
   effect_value, sale_type, edition_size, visual_effect, is_active, interest_cap)
VALUES
  ('banker_signet', 'Sygnet Bankiera', '💍', 'trinket', 15000, 'legendary',
   'Ta sama umowa co legendarny Pierścień Bankiera: +2% dziennie od salda gotówki, naliczane od pierwszych 20 000 monet (maks. 400 🪙 dziennie). Odsetki liczą się wyłącznie od gotówki — monety zamrożone w lokacie, wydane na skrzynki albo stojące w pozycji rynkowej nie pracują. Wypłata codziennie rano, automatycznie.',
   -- ⚠️ interest_cap 20,000 (anti-inflation.sql, 2026-08-28). It was NULL and
   -- that made this row the only unbounded compounding term in the economy.
   -- Do not put it back to NULL without reading that file's section 2.
   NULL, 'daily_interest', 2, 'shop', NULL, NULL, true, 20000)
ON CONFLICT (slug) DO UPDATE SET
  name         = EXCLUDED.name,
  emoji        = EXCLUDED.emoji,
  slot         = EXCLUDED.slot,
  price        = EXCLUDED.price,
  rarity       = EXCLUDED.rarity,
  description  = EXCLUDED.description,
  effect_type  = EXCLUDED.effect_type,
  effect_value = EXCLUDED.effect_value,
  sale_type    = EXCLUDED.sale_type,
  is_active    = EXCLUDED.is_active,
  interest_cap = EXCLUDED.interest_cap;

-- ⚠️ This line used to force `interest_cap = NULL` on the legendary ring, so
-- that "a future default can never silently nerf an item somebody won at
-- auction". After 2026-08-28 that inverted: re-running this file silently
-- UN-capped the ring and restored the one unbounded compounding term in the
-- economy. Prod survived only because the documented run order puts
-- anti-inflation.sql after this file, and its UPDATE covers both rows.
-- The cap is uniform across both interest items on purpose — see
-- supabase/anti-inflation.sql §2 and docs/bank.md.
UPDATE public.hero_item_defs SET interest_cap = 20000 WHERE slug = 'interest_ring';


-- ── award_daily_interest(), rewritten ──────────────────────────────────────
-- Supersedes the copies in new-auction-items.sql and
-- hero-items-always-active.sql (re-run THIS file after re-running either).
-- Three changes from those:
--   1. it is no longer hardcoded to slug='interest_ring' + a literal 0.02 —
--      it pays any def with effect_type='daily_interest', at that def's own
--      effect_value, so adding another interest item is a data change;
--   2. it honours interest_cap (NULL = uncapped, i.e. the legacy ring);
--   3. it pays only the BEST item per user. Owning both the ring and the
--      Sygnet must not stack into 4%/day — the caps would mean nothing if
--      you could just buy a second rate on top.
-- Expired timed instances are excluded (no daily_interest item is timed today,
-- but casino-luck-item.sql put expires_at on the shared instances table).
CREATE OR REPLACE FUNCTION public.award_daily_interest()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_award_date date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_count integer := 0;
  v_total bigint := 0;
BEGIN
  WITH base AS (
    -- ⚠️ The interest base is cash PLUS principal held in Bank deposits.
    -- Paying on bare cash made the Bank a trap for anyone holding an interest
    -- item: locking 4,500 in a 30-day lokata earned +630 but silently cost
    -- 2,700 of forgone 2%/day, so using the Bank was a 2,070-coin mistake and
    -- the rational play was to touch nothing. Counting deposits makes every
    -- product purely ADDITIVE — you keep the 2% and earn the deposit rate on
    -- top — which is the only version where the products have a reason to
    -- exist. Deposit principal is itself bounded by the dynamic caps, so this
    -- cannot become an unbounded new base.
    SELECT p.id AS user_id,
           p.coins + COALESCE((
             SELECT sum(d.principal) FROM public.bank_deposits d
              WHERE d.user_id = p.id AND d.closed_at IS NULL
           ), 0) AS interest_base
      FROM public.profiles p
  ),
  candidates AS (
    SELECT
      b.user_id,
      hii.id AS item_instance_id,
      GREATEST(1, FLOOR(
        LEAST(b.interest_base, COALESCE(hid.interest_cap, b.interest_base))
        * (hid.effect_value / 100.0)
      ))::bigint AS amount
    FROM base b
    JOIN public.hero_item_instances hii ON hii.owner_id = b.user_id
    JOIN public.hero_item_defs hid ON hid.id = hii.item_def_id
    WHERE hid.effect_type = 'daily_interest'
      AND hid.is_active = true
      AND (hii.expires_at IS NULL OR hii.expires_at > now())
  ),
  eligible AS (
    SELECT DISTINCT ON (user_id) user_id, item_instance_id, amount
      FROM candidates
     ORDER BY user_id, amount DESC, item_instance_id
  ),
  inserted AS (
    INSERT INTO public.hero_daily_interest_awards (award_date, user_id, item_instance_id, amount)
    SELECT v_award_date, user_id, item_instance_id, amount FROM eligible
    ON CONFLICT DO NOTHING
    RETURNING user_id, item_instance_id, amount
  ),
  credited AS (
    UPDATE public.profiles p
       SET coins = p.coins + i.amount
      FROM inserted i
     WHERE p.id = i.user_id
     RETURNING i.user_id, i.item_instance_id, i.amount
  )
  SELECT COUNT(*)::integer, COALESCE(SUM(amount), 0)::bigint
    INTO v_count, v_total
  FROM credited;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    SELECT a.user_id, a.amount, 'daily_interest',
           jsonb_build_object('item_instance_id', a.item_instance_id, 'award_date', v_award_date)
      FROM public.hero_daily_interest_awards a
     WHERE a.award_date = v_award_date AND a.logged_at IS NULL;

    UPDATE public.hero_daily_interest_awards
       SET logged_at = now()
     WHERE award_date = v_award_date AND logged_at IS NULL;
  END IF;

  RETURN json_build_object('ok', true, 'award_date', v_award_date,
                           'awards_created', v_count, 'coins_awarded', v_total);
END;
$fn$;

REVOKE ALL ON FUNCTION public.award_daily_interest() FROM PUBLIC, anon, authenticated;


-- ── Cron ───────────────────────────────────────────────────────────────────
-- Hourly, with no hour gate and no DST games, because bank_settle_due() is
-- idempotent and works out for itself which days are unpaid. Minute 35 keeps
-- it clear of the farm land-tax job (minute 10) and the farm seasonal catch-up
-- (minute 25) — those two writing public.profiles in a different row order at
-- the same second is exactly what cost the farm two weeks of payouts.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = 'bank_settle_due';
    PERFORM cron.schedule('bank_settle_due', '35 * * * *',
      $cron$SELECT public.bank_settle_due();$cron$);
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
