-- ═══════════════════════════════════════════════════════════════════════════
-- Farma: one-time backfill of HISTORICAL lootbox opens into farm_lootbox_opens
-- ═══════════════════════════════════════════════════════════════════════════
-- Run AFTER farm-static-nft-odds.sql (which creates farm_lootbox_opens). The
-- open log only records opens made AFTER it shipped; box OPENS were never
-- logged before (only box BUYS were). This reconstructs each player's past opens
-- from durable ledgers so the „📊 Statystyki skrzynek i fart" table reflects
-- history too.
--
-- Reconstruction (per player):
--   • standard opens ≈ (Σ farm_box_buy qty) + (3 starter boxes if starter_granted)
--                       − currently sealed `boxes`
--   • gold opens     ≈ (Σ farm_goldbox_buy qty) − currently sealed `boxes_gold`
--   • NFT hits       = count of farm_nft_transfers `mint` rows whose to_owner is
--                      the player (from_owner IS NULL ⇒ the original opener)
--
-- These are ESTIMATES, not an exact ledger:
--   • Opens are inferred from buys − sealed (opens themselves were never stored).
--   • `mint` rows count NFTs, not boxes-with-an-NFT, so a box that dropped 2 NFTs
--     (rare, gold box) counts as 2 got_nft rows — a slight over-count of
--     "boxes with ≥1 NFT". Negligible at current volumes (34 mints total).
--   • got_nft is assigned to gold rows first, then standard. This does NOT affect
--     the luck calc: expected is Σ per-box P by box-type COUNT, and observed is
--     the total got_nft COUNT — both independent of which rows carry the flag.
--
-- Idempotent: a `backfilled` flag marks these synthetic rows so a re-run wipes
-- and rebuilds only them, never touching real logged opens (backfilled = false).

-- Distinguish synthetic backfill rows from real logged opens.
ALTER TABLE public.farm_lootbox_opens
  ADD COLUMN IF NOT EXISTS backfilled boolean NOT NULL DEFAULT false;

-- Per-open EXPECTED P(≥1 NFT), so the luck factor is era-correct. These
-- historical opens happened under the OLD odds (roughly 2× today's rate, with a
-- per-owned-NFT decay), so scoring them against today's flat rate would make
-- everyone look unlucky. `nft_p` stores each open's expected NFT probability;
-- the stats view sums it for "expected". Real opens logged going forward leave
-- it NULL and the client falls back to the current static per-box rate.
ALTER TABLE public.farm_lootbox_opens
  ADD COLUMN IF NOT EXISTS nft_p numeric;

-- Clear any previous backfill so a re-run is idempotent (real opens untouched).
DELETE FROM public.farm_lootbox_opens WHERE backfilled;

WITH buys AS (
  SELECT user_id,
    COALESCE(sum((meta->>'qty')::int) FILTER (WHERE reason = 'farm_box_buy'), 0)     AS std_bought,
    COALESCE(sum((meta->>'qty')::int) FILTER (WHERE reason = 'farm_goldbox_buy'), 0) AS gold_bought
  FROM public.coin_transactions
  WHERE reason IN ('farm_box_buy', 'farm_goldbox_buy')
  GROUP BY user_id
),
mints AS (
  SELECT to_owner AS user_id, count(*) AS nfts
  FROM public.farm_nft_transfers
  WHERE kind = 'mint'
  GROUP BY to_owner
),
recon AS (
  SELECT p.id AS user_id, p.nick,
    greatest(0, COALESCE(b.std_bought, 0)
                + (CASE WHEN us.starter_granted THEN 3 ELSE 0 END)
                - COALESCE(us.boxes, 0))        AS std_opens,
    greatest(0, COALESCE(b.gold_bought, 0)
                - COALESCE(us.boxes_gold, 0))    AS gold_opens,
    COALESCE(m.nfts, 0)                          AS nft_hits
  FROM public.profiles p
  LEFT JOIN public.farm_user_state us ON us.user_id = p.id
  LEFT JOIN buys  b ON b.user_id = p.id
  LEFT JOIN mints m ON m.user_id = p.id
),
-- Per-player old-era expected NFTs, ÷ opens = per-open expected probability
-- (from a simulation of the OLD decaying odds over each player's actual
-- std/gold open counts; see the session notes). Uniform across a player's opens
-- — only the SUM matters for the luck factor. Players not listed fall back to a
-- rough old-era average by box type in the COALESCE below.
oldp(nick, p) AS (
  VALUES
    ('Ilo', 0.012109), ('Maciek', 0.018043), ('Yurii', 0.016317), ('Adam', 0.019327),
    ('admin', 0.037915), ('Seb', 0.043857), ('Kornel', 0.046726), ('Filip', 0.064989),
    ('Mariusz', 0.074468), ('dupa_szefa', 0.116278), ('De', 0.122500)
),
expanded AS (
  -- gold rows first (ord = 1..gold_opens) so NFT hits land on them first
  SELECT r.user_id, r.nick, 'gold'::text AS box_type, 5 AS card_count, r.nft_hits,
         gs AS ord
  FROM recon r, generate_series(1, r.gold_opens) gs
  UNION ALL
  -- standard rows after (ord offset past the gold rows)
  SELECT r.user_id, r.nick, 'standard'::text, 3, r.nft_hits,
         r.gold_opens + gs AS ord
  FROM recon r, generate_series(1, r.std_opens) gs
)
INSERT INTO public.farm_lootbox_opens
  (user_id, nick_snapshot, box_type, card_count, got_nft, got_voucher, backfilled, created_at, nft_p)
SELECT e.user_id, e.nick, e.box_type, e.card_count,
       (e.ord <= e.nft_hits) AS got_nft,   -- mark the first nft_hits rows per player
       false, true, now(),
       COALESCE(op.p, CASE WHEN e.box_type = 'gold' THEN 0.2967 ELSE 0.1319 END) AS nft_p
FROM expanded e
LEFT JOIN oldp op ON op.nick = e.nick;

-- Report what landed (opens + NFT hits + expected + luck per player).
SELECT nick_snapshot AS nick,
       count(*) FILTER (WHERE box_type = 'standard') AS std_opens,
       count(*) FILTER (WHERE box_type = 'gold')     AS gold_opens,
       count(*) FILTER (WHERE got_nft)               AS nft_hits,
       round(sum(nft_p), 2)                          AS expected,
       round(count(*) FILTER (WHERE got_nft) / NULLIF(sum(nft_p), 0), 2) AS luck
FROM public.farm_lootbox_opens
WHERE backfilled
GROUP BY nick_snapshot
ORDER BY count(*) DESC;
