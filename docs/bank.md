# Bank G6 — investment products

The `🏦 Bank G6` tab (`#tab-bank`, rendered entirely by `tabs/bank.js`) is where
coins earn instead of sitting still. Four products plus one shop item, all
backed by `supabase/bank.sql`.

Read this before touching any rate, cap, or price. The numbers are not taste —
they were derived from production data, and the derivation is the only reason
they are defensible.

---

## Why every rate is capped

The precedent is `interest_ring` („Pierścień Bankiera", `new-auction-items.sql`):
**2%/day of the entire balance, compounding, uncapped, forever**. It was won at
auction in May 2026 for **401 coins** and had minted its owner **38 235** by
2026-08-23 — more than **10% of the whole non-admin money supply**, from one
item, because a percentage of an unbounded balance has no finite fair price.

So the design rule for this whole feature: an income stream must be bounded by
a **principal cap**, a **maturity**, or — best — by being **funded out of coins
that were already burned**. Nothing here is a percentage of an unbounded number.

## The baseline it was calibrated against

Measured on prod, 2026-08-23:

| | |
|---|---|
| non-admin players | 11 |
| coins in circulation | 360 776 |
| median balance | 10 353 (mean 32 798, max 157 072) |
| casino house net, 6 solo games | 88 544 / 30 days = **2 951/day** |
| farm turnover (the real economy) | `farm_crop_sale` +1.14M, `card_levelup` −1.06M per 30 days |

Two things follow. The farm dwarfs everything, so bank flows in the low
thousands per day are a rounding error on the macro picture — but the *standing*
supply is only 360k, so an uncapped stream would still dominate the leaderboard.
Hence: generous-feeling rates, hard caps.

---

## The products

| Product | Lock | Yield | Cap | Mints? |
|---|---|---|---|---|
| 🐷 Skarbonka | none; <7 dni forfeits interest | 0,40%/dzień simple, max 90 dni | 5 000/player | yes |
| 🏦 Lokata 7 dni | hard | +3,5% total | 30 000/player | yes |
| 🏦 Lokata 14 dni | hard | +8% total | shared with above | yes |
| 🏦 Lokata 30 dni | hard | +19% total | shared with above | yes |
| 📜 Obligacja G6 | tradeable, 20 dni | 6 🪙/dzień on 1 000 face (+12%) | 40/weekly series | yes |
| 🎰 Udział w Kasynie | perpetual, tradeable | 2,5% of trailing-7d house net | 30 shares, 5/player primary | **no** |
| 💍 Sygnet Bankiera | perpetual | 2%/dzień on first 12 000 cash | 240/day hard ceiling | yes |

Worst-case office-wide mint if literally everyone maxed everything: ~7 900/day.
Realistically a small fraction of that, because every line is capital-gated and
the upfront burns (8 000 per Sygnet, 4 000 per share) come first.

### 🏦 Lokata — the legible one

Fixed term, fixed total return, known before you commit. Breaking early returns
the **principal and nothing else** — interest is forfeited, never a fee. Nobody
should be able to end up with fewer coins than they put into the product that is
sold as "safe"; the lock has to bite without that.

The term structure is deliberately convex — 0,50 / 0,57 / 0,63 % per day — so
locking longer is genuinely better rather than merely longer.

`rate_bps` is stored **on the deposit row at open time**, so the published rates
can be retuned later without touching anybody's open deposit. Do it that way.

### 🐷 Skarbonka — the on-ramp

500-coin minimum, 5 000 cap, no term. The one rule is the 7-day interest lock:
smash it earlier and you get the principal back, no interest. It exists to teach
the lock concept at a scale where losing the interest costs ~140 coins, not to
be an optimal parking spot.

Accrual is simple (not compounding) and stops at 90 days, so an abandoned piggy
bank is not an unbounded faucet.

### 📜 Obligacje — the tradeable one

Weekly series of 40, auto-opened by `bank_ensure_bond_series()` whenever
`bank_settle_due()` runs and no open series has stock left. Code is derived from
the ISO week (`E2026-34`), which makes the INSERT idempotent without a lock —
concurrent callers race to the same unique code and the loser's
`ON CONFLICT DO NOTHING` is a no-op.

The bond's actual point is the **secondary market**: a bond is a
`bank_holdings` row, and any holding can carry an `ask_price` that anyone can
hit instantly. A bond with 3 days left is objectively worth less than a fresh
one, and players get to discover that. Deliberately **not** an auction with
escrow — the Targowisko engine already does auctions, and a bond's value is
computable, so bidding drama would add nothing.

⚠️ A **matured-but-unredeemed** bond cannot be bought (`bond_matured`). The
buyer would be paying for a payout the settler is about to hand the seller.

### 🎰 Udział w Kasynie — the interesting one

30 shares, 4 000 each, max 5 per player on the primary sale (resale is
uncapped — those coins go to another player, so concentration there is a market
outcome). Each share pays **2,5% of the trailing-7-day average positive house
net** across the six solo casino games, excluding admin play. Poker is excluded
because it is player-vs-player: its "house net" is other players' money, not
burned coins.

This is the only product that **mints nothing in real terms**. It redistributes
coins gamblers already burned, and it pays exactly 0 through a week nobody
gambles. That is the risk it is sold on, and it is why it needs no cap beyond
the fixed float.

**⚠️ Why a trailing average and not "yesterday".** The first implementation paid
2,5% of the previous day's net. Measured against real data that is unusable:
the week to 2026-08-23 was **25 998 on the 18th and ~0 every other day**.
Gambling here is bursty, so "yesterday" would hand a shareholder one big day and
six days of nothing, which reads as a broken product rather than a variable one.
The window pays the same coins in total, smoothly. Negative days floor at 0
**per day, not per window** — a day the players beat the house costs that day's
income, never last week's.

At the measured 2 951/day baseline: ~74/day per share → ~54-day payback.

### 💍 Sygnet Bankiera — Filip's rate, sold to everyone

`banker_signet`, 8 000 🪙, a normal `hero_item_defs` row bought in the Sklep
(`🎒 Przedmioty specjalne`). +2%/day — the same headline rate as the legendary
ring — but only on the **first 12 000 coins of cash**, so 240/day maximum.

**The price derivation.** The cap is the design; the price follows from it:

| holder's cash | pays/day | payback on 8 000 |
|---|---|---|
| ≥ 12 000 (at cap) | 240 | **33 days** |
| 10 353 (median) | 207 | 39 days |
| 5 000 | 100 | 80 days |

Compressing rich-vs-median from a 15× wealth gap down to 33-vs-39 days is the
entire point: everyone can buy the same item and nobody's copy is worth six
times someone else's. Above 12 000 it stops scaling at all, which keeps the
office-wide worst case (11 × 240) at ~2 640/day against a ~2 951/day casino
burn.

The second brake is real opportunity cost: interest is paid on **cash**, and
12 000 idle coins is ~120 lootboxes. Coins locked in a Lokata do **not** count
toward the Sygnet's base — that is intentional and is stated in the UI.

Filip's ring stays **uncapped** and stays a 1-of-1 (`interest_cap` is explicitly
`NULL` for it, and the file re-asserts that on every run so a future default
cannot silently nerf an auction prize). At his balance it pays ~1 374/day, 5,7×
the Sygnet's ceiling. He won the auction; the prize is allowed to stay the best.

---

## Implementation notes worth not rediscovering

### Settlement is lazy-on-read; the cron is a backstop

`bank_settle_due()` is idempotent and **date-driven** — accrual rows are keyed
`(pay_date, holding_id)` and only rows actually INSERTed get credited, so
calling it twice in the same second is a no-op. `bank_state()` calls it on every
read (the crash/wheel `resolveDueRound` pattern) and an hourly cron calls it
too, at **minute 35** — clear of the farm land-tax job (minute 10) and the farm
seasonal catch-up (minute 25).

Nothing depends on running "on time": a 14-day lookback plus the redemption
backstop (bond redemption pays out any coupon day the accrual missed) means a
cron outage **delays** payouts rather than losing them. That is a direct
response to `farm-seasonal-award-reliability.sql`, where a single scheduled shot
with no catch-up silently paid nobody for two separate weeks.

### ⚠️ The `UPDATE ... FROM` multiple-match trap

Every `profiles` update in `bank_settle_due()` goes through a **per-user SUM**
first. This looks obviously right and is wrong:

```sql
UPDATE profiles p SET coins = p.coins + x.amount FROM cte x WHERE p.id = x.user_id
```

When the CTE holds several rows for one profile — five casino shares paying on
the same day, two bonds maturing in the same run — Postgres updates that row
**once** against an arbitrary match and silently drops the rest. It cost 24 of
48 coupon coins in the very first smoke test of this file, while
`bank_dividends` still recorded all 48 as paid. Always aggregate before the
update.

### Serialization

- **Bond series**: `SELECT … FOR UPDATE` on the series row serializes correctly.
- **Share primary sale**: needs `pg_advisory_xact_lock('bank_share_primary_sale')`.
  A row lock on the *buyer's* profile does not work — two different buyers lock
  two different rows, both read the same `sold`, and the 30-share float quietly
  becomes 31.

### Anti-stacking

`award_daily_interest()` was rewritten here. It no longer hardcodes
`slug='interest_ring'` and a literal `0.02`; it pays any def with
`effect_type='daily_interest'` at that def's own `effect_value`, honours
`interest_cap` (NULL = uncapped), and pays only the **best single item per
user** (`DISTINCT ON (user_id) … ORDER BY amount DESC`). Owning both the ring
and the Sygnet must not stack into 4%/day, or the caps mean nothing.

That `DISTINCT ON` is also what keeps the `UPDATE … FROM` in that function safe:
at most one row per user.

### Accounting

| ledger reason | classification |
|---|---|
| `bank_deposit_interest`, `bank_bond_coupon`, `bank_share_dividend` | **minted** (`economy-stats.sql`, and the `passive` bucket in `coin-inflow-stats.sql`) |
| `bank_share_buy` | **burned** — mirrors `hero_item_purchase`; the share is then valued in `bank_assets` |
| `bank_deposit_open`, `bank_bond_buy` | **neither** — escrow, like `marketplace_bid_reserved`. The principal comes back, so counting it as burn would invent supply at every maturity |
| `bank_deposit_close`, `bank_bond_redeem` | **neither** — principal return |
| `bank_resale_purchase` / `bank_resale_sale` | **neither** — P2P transfer |

`bank_user_assets()` / `bank_total_assets()` are called from
`leaderboard-net-worth-items.sql` and `economy-stats.sql`. Those two files
**require `bank.sql` to have been run first** — the helpers live here. Keeping
the term as a function call rather than transcribing the query into both files
is deliberate: re-transcribing large net-worth functions is exactly how
`economy_stats` silently reverted a hybrid-valuation fix on 2026-08-05.

Open deposits are marked **to now** (lokata pro-rata over the term, skarbonka
only once past the 7-day lock — which is exactly what breaking it would pay), so
a nearly-matured 30-day lokata is not shown on the leaderboard at bare
principal.

---

## Tuning knobs

Turn these down first if the bank starts outrunning the economy. All of them are
in `supabase/bank.sql`, and all are mirrored as `BANK_*` consts in
`tabs/bank.js` **for previews only** — the server is authoritative, the client
predicts.

1. `bank_open_deposit`'s `v_cap` (30 000 lokata / 5 000 skarbonka) — the single
   biggest lever, and it changes nothing for existing deposits.
2. The lokata `rate_bps` CASE (350/800/1900). Open deposits keep their stored
   rate, so this is safe to change at any time.
3. `banker_signet.interest_cap` (12 000) and `price` (8 000) — re-derive the
   payback table above if you move either.
4. `bank_bond_series` row: `edition_size` (40) throttles issuance directly.
5. The share `v_bps` (250) and the `bank_house_net_avg` window (7 days).
   Raising `v_bps` cannot mint — it only redirects more of an existing burn.

## Files

- `supabase/bank.sql` — everything backend. Idempotent. Run after the casino
  files and `hero-items-always-active.sql`; run **before** re-running
  `leaderboard-net-worth-items.sql` / `economy-stats.sql` / `coin-inflow-stats.sql`.
- `tabs/bank.js` — the whole tab (lazy module; `index.html` holds only the
  shell, the nav button, ~70 lines of CSS, and the `stopBankTimer()` stub).
