# Bank G6 — investment products

The `🏦 Bank G6` tab (`#tab-bank`, rendered entirely by `tabs/bank.js`) is where
coins earn instead of sitting still. Four products plus one shop item, backed by
`supabase/bank.sql`.

Read this before touching any rate, cap, or price. The numbers were derived from
production data, and the derivation is the only reason they are defensible.

---

## The baseline everything was calibrated against

Measured on prod, 2026-08-23:

| | |
|---|---|
| non-admin players | 11 |
| coins in circulation | 360 776 |
| median balance | 10 353 (mean 32 798, max 157 072) |
| casino house net, 6 solo games | 88 544 / 30 days = **2 951/day** |
| farm turnover | `farm_crop_sale` +1.14M, `card_levelup` −1.06M per 30 days |

Two things follow. The farm dwarfs everything, so bank flows in the low hundreds
per day are a rounding error on the macro picture — but the *standing* supply is
only 360k, so an unbounded stream still dominates the leaderboard.

## The products

| Product | Lock | Yield | Limit | Mints? |
|---|---|---|---|---|
| 🐷 Skarbonka | none; <7 dni forfeits interest | 0,30%/dzień simple, max 90 dni | 3 000/player | yes |
| 🏦 Lokata 7 dni | hard | +2,5% total | 15 000/player | yes |
| 🏦 Lokata 14 dni | hard | +6% total | shared with above | yes |
| 🏦 Lokata 30 dni | hard | +14% total | shared with above | yes |
| 📜 Obligacja G6 | tradeable, 20 dni | 5 🪙/dzień on 1 000 face (+10%) | 25/weekly series | yes |
| 🎰 Udział w Kasynie | perpetual, tradeable | 3% of trailing-7d house net | 30 shares, 5/player primary | **no** |
| 💍 Sygnet Bankiera | perpetual | **2%/dzień, uncapped** | none | yes, unboundedly |

### ⚠️ Where the inflation actually is

Worst case, everyone maxing everything:

| source | coins/day |
|---|---|
| Lokata (11 × 15 000 at +14%/30d) | ~770 |
| Skarbonka (11 × 3 000 at 0,30%) | ~99 |
| Obligacje (~3 live series × 25 × 5) | ~375 |
| Udziały w kasynie | 0 net — redistributes an existing burn |
| **💍 Sygnet Bankiera (11 × 2% of all cash)** | **~7 215, and compounding** |

The four bank products together are ~1 250/day against a ~2 951/day casino
burn — comfortably sub-inflationary. **The Sygnet is ~85% of the total and is
the only unbounded term.** If the economy runs hot, that is the line to look at
first, and the four products above are not worth retuning again.

### 🏦 Lokata — the legible one

Fixed term, fixed total return, known before you commit. Breaking early returns
the **principal and nothing else** — interest is forfeited, never a fee. Nobody
should be able to end up with fewer coins than they put into the product sold as
"safe"; the lock has to bite without that.

The term structure is convex — 0,36 / 0,43 / 0,47 % per day — so locking longer
is genuinely better rather than merely longer.

`rate_bps` is stored **on the deposit row at open time**, so published rates can
be retuned without touching anybody's open deposit. Keep it that way.

### 🐷 Skarbonka — the on-ramp

500 minimum, 3 000 cap, no term. The one rule is the 7-day interest lock: break
it earlier and you get the principal back, no interest. It exists to teach the
lock concept at a scale where losing the interest costs ~60 coins.

Accrual is simple (not compounding) and stops at 90 days, so an abandoned piggy
bank is not an unbounded faucet.

### 📜 Obligacje — the tradeable one

Weekly series of 25, auto-opened by `bank_ensure_bond_series()` whenever
`bank_settle_due()` runs and no open series has stock left. The code is derived
from the ISO week (`E2026-34`), which makes the INSERT idempotent without a
lock — concurrent callers race to the same unique code and the loser's
`ON CONFLICT DO NOTHING` is a no-op. A series that sells out mid-week leaves no
bonds on sale until the next week; that is intended and the UI says so.

The bond's real point is the **secondary market**: a bond is a `bank_holdings`
row, and any holding can carry an `ask_price` that anyone can hit instantly. A
bond with 3 days left is objectively worth less than a fresh one, and players
get to discover that. Deliberately **not** an auction with escrow — the
Targowisko engine already does auctions, and a bond's value is computable, so
bidding drama would add nothing.

⚠️ A **matured-but-unredeemed** bond cannot be bought (`bond_matured`). The
buyer would be paying for a payout the settler is about to hand the seller.

### 🎰 Udział w Kasynie — the one that costs nothing

30 shares, 4 000 each, max 5 per player on the primary sale (resale is uncapped:
those coins go to another player, so concentration there is a market outcome).
Each share pays **3% of the trailing-7-day average positive house net** across
the six solo casino games, excluding admin play. Poker is excluded because it is
player-vs-player — its "house net" is other players' money, not burned coins.

This product **mints nothing in real terms**. It redistributes coins gamblers
already burned, and pays exactly 0 through a week nobody gambles. That is the
risk it is sold on, and it is why its rate is the one dial that can be turned
*up* while fighting inflation.

**⚠️ Why a trailing average and not "yesterday".** The first implementation paid
a share of the previous day's net. Against real data that is unusable: the week
to 2026-08-23 was **25 998 on the 18th and ~0 every other day**. Gambling here
is bursty, so "yesterday" hands a shareholder one big day and six days of
nothing, which reads as a broken product rather than a variable one. The window
pays the same coins in total, smoothly. Negative days floor at 0 **per day, not
per window** — a day the players beat the house costs that day's income, never
last week's.

At the measured 2 951/day baseline: ~88/day per share → ~45-day payback.

### 💍 Sygnet Bankiera — Filip's ring, on Filip's terms

`banker_signet`, 15 000 🪙, a normal `hero_item_defs` row bought in the Sklep
(`🎒 Przedmioty specjalne`). **2%/day of the whole cash balance, uncapped** —
byte-for-byte the deal `interest_ring` has had since May 2026.

**Why there is no cap.** There was one (12 000, → 240/day) in the first cut, and
it was removed on request. The argument that carried it: selling everyone a
deliberately weaker copy of an item one player already owns is the unfair
version. The item is now identical and the price is the only thing that differs.

**What that costs, stated plainly.** An uncapped percentage of a balance is
unbounded and compounding. With all 11 players holding one against 360 776 coins
of circulating cash it mints ~7 215/day and doubles the money supply in ~35
days. That is a known, accepted trade, not an oversight — and it is why the
other four products were cut by roughly a third in the same change.

Payback at 15 000, ignoring compounding:

| balance | pays/day | payback |
|---|---|---|
| 5 000 | 100 | 150 days |
| 10 353 (median) | 207 | 73 days |
| 25 000 | 500 | 30 days |
| 68 719 (Filip) | 1 374 | 11 days |

Note the shape: an uncapped percentage pays a large balance back ~13× faster
than a small one, so the item is **regressive by construction**. That is
inherent to "same rate for everyone" and is the trade being made.

The only real brake is opportunity cost: interest is paid on **cash**, and cash
is the one asset in this game that does nothing else. Coins locked in a Lokata,
spent on lootboxes, or standing in a market position earn nothing here. The UI
says this in three places because it is the single most misunderstood rule.

**If it runs hot, the knobs, cheapest first — all data changes on one row, no
code deploy:**

1. `interest_cap` on the def. The column and every line of logic that honours it
   are still in place; it is simply `NULL`. Setting it to e.g. 12 000 caps
   payouts at 240/day/player without touching anyone's existing item.
2. `effect_value` 2 → 1. Halves every payout, including the legacy ring's.
3. `edition_size` + a `sale_type` flip, to make it scarce rather than capped.

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
`bank_dividends` still recorded all 48 as paid. Always aggregate first.

### Concurrency

- **Bond series**: `SELECT … FOR UPDATE` on the series row serializes correctly.
- **Share primary sale**: needs `pg_advisory_xact_lock('bank_share_primary_sale')`.
  A row lock on the *buyer's* profile does not work — two different buyers lock
  two different rows, both read the same `sold`, and the 30-share float quietly
  becomes 31.
- **Redemption / maturity**: the `redeemed_at IS NULL` / `closed_at IS NULL`
  guard must be on the **UPDATE**, not only in the CTE that selected the rows.
  In READ COMMITTED the second transaction re-evaluates only its own WHERE after
  the first commits; a condition already materialised in a CTE is not re-checked,
  and the payout runs twice.

### Anti-stacking

`award_daily_interest()` was rewritten here. It no longer hardcodes
`slug='interest_ring'` and a literal `0.02`; it pays any def with
`effect_type='daily_interest'` at that def's own `effect_value`, honours
`interest_cap` (NULL = uncapped, which both interest items are today), and pays
only the **best single item per user** (`DISTINCT ON (user_id) … ORDER BY amount
DESC`). Owning both the ring and the Sygnet must not stack into 4%/day.

That `DISTINCT ON` is also what keeps the `UPDATE … FROM` in that function safe:
at most one row per user.

`bank_state()` returns `signet.better` — the name of another interest item the
caller already holds that pays at least as much — scored **at the caller's
actual balance**, the same way the award function scores it. With the Sygnet
uncapped it ties exactly with the ring, so a cap comparison would not have
caught it, and Filip would have been sold a 15 000-coin no-op.

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
only once past the 7-day lock), so a nearly-matured 30-day lokata is not shown on
the leaderboard at bare principal. Note this is a *valuation*, not a withdrawable
amount — breaking early still pays principal only, and the UI says so rather than
claiming the mark is "what you'd get today".

---

## The interface

Deliberately **not** the app's rounded-card-grid house style. A bank statement is
a reference document you read a column of numbers off, so the tab is built as
one: a navy statement header with a KPI strip, a sub-tab bar
(`Przegląd · Lokaty · Skarbonka · Obligacje · Udziały · Rynek wtórny ·
Tabela oprocentowania · Regulamin`), and dense `table.bk-t` tables with tabular
figures, hairline rules and right-aligned money columns.

Conventions if you extend it:

- **Every product page opens with a `bankTermsBlock()`** — the four-cell
  "Warunki produktu" strip — then the order form, then the positions table. Keep
  that order; it is the shape people already know from real banking UIs. The
  block assumes **exactly four** entries (the CSS uses fixed 2/4 tracks so a
  fifth would strand an empty bordered cell).
- **`Tabela oprocentowania` is a published rate card**, including the Sygnet, so
  every product can be compared on one screen. It reads its caps from
  `bankState.caps` rather than the client constants, so a server-side retune
  shows up without a frontend deploy.
- **`Regulamin` carries the prose** — accrual timing, the day-of-purchase rule,
  early closure, why the limits exist, and where the money comes from. Rules
  belong there, not sprinkled through the product pages.
- `.bk-link` is the in-table jump link. Do **not** reuse `.bk-tab` for it: that
  class is also the selector the sub-nav is built and queried by.
- Global `input[type=number]` carries `min-height:44px` and `margin-bottom:12px`
  for the app's touch forms; `.bk-field` unsets both, or an input stands 10px
  taller than the select beside it and their labels stop lining up.

The `BANK_*` constants in `tabs/bank.js` mirror the SQL but exist **only to
preview** a number before you commit. The server is authoritative for everything
that moves a coin.

## Files

- `supabase/bank.sql` — everything backend. Idempotent. Run after the casino
  files and `hero-items-always-active.sql`; run **before** re-running
  `leaderboard-net-worth-items.sql` / `economy-stats.sql` / `coin-inflow-stats.sql`.
- `tabs/bank.js` — the whole tab (lazy module; `index.html` holds only the
  shell, the nav button, the `.bk-*` CSS, and the `stopBankTimer()` stub).
