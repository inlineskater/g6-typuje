-- ═══════════════════════════════════════════════════════════════════
-- Reset test bids, stagger auction end times, lower min increment,
-- and add top-3 bidders to the auction cards view.
-- Paste into Supabase SQL Editor → Run.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Refund all leading bids and wipe bid history ─────────────────

UPDATE public.profiles p
SET coins = coins + b.amount
FROM public.hero_item_auction_bids b
WHERE b.bidder_id = p.id AND b.status = 'leading';

DELETE FROM public.hero_item_auction_bids;


-- ── 2. Stagger end times (Warsaw CEST = UTC+2) and set min_increment = 1 ──
-- interest_ring  → środa 10:00 CEST = 08:00 UTC
-- kaiser_helm    → środa 12:00 CEST = 10:00 UTC
-- poker_glasses  → środa 14:00 CEST = 12:00 UTC

UPDATE public.hero_item_auctions a
SET ends_at       = v.new_end,
    min_increment = 1
FROM (VALUES
  ('interest_ring', '2026-05-27T08:00:00Z'::timestamptz),
  ('kaiser_helm',   '2026-05-27T10:00:00Z'::timestamptz),
  ('poker_glasses', '2026-05-27T12:00:00Z'::timestamptz)
) AS v(slug, new_end)
JOIN public.hero_item_defs d ON d.slug = v.slug
WHERE a.item_def_id = d.id AND a.status = 'open';


-- ── 3. Rebuild auction_cards view with top-3 bidders ───────────────

CREATE OR REPLACE VIEW public.hero_item_auction_cards AS
SELECT
  a.id,
  a.item_def_id,
  d.slug,
  d.name,
  d.emoji,
  d.slot,
  d.rarity,
  d.description,
  d.effect_game,
  d.effect_type,
  d.effect_value,
  d.edition_size,
  d.visual_effect,
  a.start_price,
  a.min_increment,
  a.starts_at,
  a.ends_at,
  a.status,
  a.winner_id,
  wp.nick AS winner_nick,
  a.winning_bid,
  a.item_instance_id,
  a.created_at,
  COALESCE(a.winning_bid, hb.amount) AS current_bid,
  COALESCE(a.winner_id, hb.bidder_id) AS current_bidder_id,
  bp.nick AS current_bidder_nick,
  CASE
    WHEN a.status = 'open' AND hb.amount IS NOT NULL THEN hb.amount + a.min_increment
    WHEN a.status = 'open' THEN a.start_price
    ELSE NULL
  END AS next_min_bid,
  tb.top_bidders
FROM public.hero_item_auctions a
JOIN public.hero_item_defs d ON d.id = a.item_def_id
LEFT JOIN LATERAL (
  SELECT b.bidder_id, b.amount
    FROM public.hero_item_auction_bids b
   WHERE b.auction_id = a.id
     AND b.status IN ('leading','won')
   ORDER BY b.amount DESC, b.created_at ASC
   LIMIT 1
) hb ON true
LEFT JOIN public.profiles bp ON bp.id = hb.bidder_id
LEFT JOIN public.profiles wp ON wp.id = a.winner_id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object('nick', p.nick, 'amount', top.max_amount)
    ORDER BY top.max_amount DESC
  ) AS top_bidders
  FROM (
    SELECT b.bidder_id, MAX(b.amount) AS max_amount
    FROM public.hero_item_auction_bids b
    WHERE b.auction_id = a.id
    GROUP BY b.bidder_id
    ORDER BY max_amount DESC
    LIMIT 3
  ) top
  JOIN public.profiles p ON p.id = top.bidder_id
) tb ON true
WHERE a.status = 'open'
   OR a.created_at > now() - interval '14 days';

GRANT SELECT ON public.hero_item_auction_cards TO anon, authenticated;
