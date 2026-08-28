# Anti-inflation controls (2026-08-28)

Backing document for `supabase/anti-inflation.sql`. Read this before changing
any of its policy functions.

## The measurement that started it

Prod, 2026-08-28, 11 players, **406,848 coins** in circulation, total net worth
2,838,072 (81% of it farm assets).

Modelling every planted tile against the real yield/grow/price formulas:

| player | tiles | coins/day |
|---|---|---|
| Yurii | 5× grapes L14 + hybrid | 12,911 |
| Kornel | 4× grapes L16 + hybrid | 12,580 |
| Filip | 4× grapes L13 + hybrid | 9,839 |
| Maciek | 4× grapes L10 + hybrid | 6,711 |
| everyone else | | 14,294 |
| | **total** | **56,336** |

Measured actual sales over 14 days: **54,722/day** (766,103 / 14). The model and
reality agree to 3%.

**The farm reprints the entire money supply every 7.4 days.**

```
recurring faucets ~65,400/day        recurring sinks ~14,300/day
  crop sale       54,722               land tax       11,036
  contract         8,343               casino          3,313
  daily_interest   2,364 (rising)
```

## Why it was hidden

Box-buying and card level-ups looked like the balancing sink. They were a
**build-out phase**:

```
week          cropSale  contract     boxes   levelup      tax    farm NET
2026-08-03     271,469   108,240  -247,300  -555,600  -34,178   -457,369
2026-08-10     275,765   121,997  -150,800  -203,400  -78,753    -35,191
2026-08-17     409,667    69,805  -215,900  -166,650  -79,411    +17,511
2026-08-24     294,017    58,400   -77,600   -56,750  -55,094   +162,973
```

It is over, and it is not coming back, by construction: level-up costs `50·L²`
coins plus `2·L` dupes and returns a flat `+0.5 · base_yield · price` per tile.
Kornel's grapes L16→L17 needs 32 grape dupes at a 9.1% per-box rate ≈ 352 boxes
(35,200 coins) plus the 12,800 level cost, for **+474 coins/day** — a 101-day
payback. He shouldn't, and won't.

Meanwhile the only recurring sink is frozen: land tax is `1000 · excess²` on
**tiles**, all 40 are owned, fair_cap is 4, so it is exactly 11,000/day forever
regardless of what those tiles produce.

## Root cause: the farm was the one open loop

Every other coin system in the game has negative feedback — the casino's
RTP < 100%, the Bank's `health = TARGET/(TARGET+inflation)`, land tax's
`1000·excess²`. `roll_farm_prices()` was, in full:

```sql
r := random();
IF r < 0.45 THEN mult := 0.30 + random() * 0.20; ... END IF;
UPDATE farm_market SET anchor_price = base_price * mult, cur_price = base_price * mult;
```

`total_sold` was never read. Price was noise, re-rolled twice daily, and the
roll reset `cur_price` **up**, discarding any accumulated dip. The per-sale dip
did not help either: recovery is `LEAST(1, hours * 0.12)`, a lerp that completes
in **8h20m**, so harvesting once a day always sold at full anchor.

So quantity had no price consequence anywhere, while yield is
`base_yield · (1 + (L−1)·0.5)` — linear and **unbounded** in level, with grow
time floored at 24h, so past ~L14 every level is free output.

## The four changes

### 1. `bank_net_mint_per_day()` → trimmed mean

A raw 30-day mean let one 779,493-coin lottery payout (2026-08-03, a single
ledger row) own the Bank's health metric for 25 days. Daily nets over that
window range −63,750 … +299,709.

| statistic | value | infl | health | lokata | bonds |
|---|---|---|---|---|---|
| mean (old) | 10,837 | 2.87%/d | 0.26 | 2,000 | 4 |
| median | 4,652 | 1.32%/d | 0.43 | 3,000 | 7 |
| **trimmed 2+2 (new)** | **2,793** | **0.69%/d** | **0.59** | **5,000** | **11** |

Bucketing by Warsaw day and dropping the two highest and two lowest days is
robust to one-off events *by construction* — no reason allow-list to keep in
sync, so the next Loteria draw cannot do this again. It also defuses the
2026-09-03 cliff, where the raw mean would have stepped health 0.26 → 1.00
overnight when the lottery fell out of the window.

Empty days count as a genuine zero, so the array is always exactly 30 slots and
the divisor never drifts with activity.

### 2. `interest_cap` on every `daily_interest` item

`bank.sql` already carried the column, the CHECK, and every consumer that
honours it. It was simply NULL, which made 2%/day of the whole cash balance the
only unbounded, compounding term in the economy.

```
daily_interest paid  1,340/day (08-23)  →  2,364/day (08-28)
```

as three players bought in over five days. Mariusz holds 38.7% of all cash and
had not bought one; his payback would have been five days.

**20,000 → 400/day.** The 15,000 Sygnet still pays for itself in 37 days, but
the payout no longer grows with the balance it creates: exponential becomes
linear. At full 11-player adoption the item family costs 4,400/day instead of an
unbounded curve.

Uniform on purpose — the legacy Pierścień Bankiera gets the same cap. One rule
is easier to explain to eleven colleagues than "Filip's ring is better", and it
is bounded either way. To grandfather it, set that one row to a higher cap; the
code reads per-def.

### 3. Weekly contract premium, capped per player

`ensure_farm_seasonal_event()` derives

```
bonus_per_unit = ceil(target_daily · grow_days / base_yield − base_price · 0.57)
```

i.e. exactly the top-up bringing a **level-1** tile at fair_cap to
`farm_seasonal_target_daily_coins()` per day. It was then paid on every unit
sold, with no ceiling:

```
2026-08-24  Yurii   6,930 units = 24.8× fair cap  →  21,621 coins
2026-08-24  Kornel  5,791 units = 20.7× fair cap  →  18,763 coins
2026-08-17  Yurii   7,268 units = 30.3× fair cap  →  30,235 coins
2026-08-17  Maciek     83 units =  0.3× fair cap  →     345 coins
```

Yurii's design target for that week was 840 coins. The community *bar* was made
self-calibrating on 2026-08-08; the per-unit premium never was.

`farm_seasonal_event_sales.premium_qty` splits "how much did you sell" from "how
much of it earned the premium", so the bar and the rank race keep measuring real
output and only the coin payout is bounded. **A capped seller loses no sale** —
the crop still sells at the normal NPC price.

Verified against live data in a rolled-back transaction:

```
Kornel  sells 1308 grapes  →  qty=1308  premium_qty=0  bonus=0  (was 4,238)
                              normal sale 11,845, unchanged
Mariusz sells   76 grapes  →  qty=76    premium_qty=76 bonus=233 (unchanged)
                              764 of allowance still left
```

### 4. The stalk market gets a demand side

```
budget   = max(floor_per_player · players, burn_share · measured_burn)
pressure = trailing 7d crop revenue per day / budget
demand   = clamp(1 / (1 + max(0, pressure − 1)), 0.20, 1.00)
anchor   = base_price · regime_mult · demand · crop_skew
```

Above `pressure = 1` the payout is `qty · base · regime · (budget/qty)` — revenue
is asymptotically **constant** in quantity. Card level stops driving coin
creation without touching a single card: a L16 grape still yields 298 units/day,
they are just worth less when the whole office dumps them.

**Why the budget tracks burn and not supply.** A supply-linked budget is a
positive feedback loop (mint more → supply up → budget up → mint more).
Burn-linked is self-balancing and legible: the NPC pays back 90% of what the
farm and the casino actually destroy, so the office's spending funds the office's
income. It cannot spiral either — the per-player floor (1,000/day/player,
8,000/day today) sits deliberately **below** the ~14,300/day of land tax plus
casino that burns unconditionally, so even at the floor the economy is
deflationary.

**The glide.** `demand` moves at most 0.15 per roll, so deployment day is
1.00 → 0.85 → 0.77 over three rolls rather than a cliff. It also damps the loop.

**The per-crop skew** (`farm_crop_skew_exponent`, 0.35, clamped ±25%) decides
*who* carries the global cut. Measured on the first live roll:

```
seasonal_bloom (32% of revenue)  →  27% of base   ← whale crop, hit hardest
pumpkin                          →  29%
grapes                           →  49%
crystal_lotus                    →  54%
aeae_banana (niche, one player)  →  79%           ← protected
```

That is what stops a small player's single NFT tile being punished for a grape
glut they had no part in. Set the exponent to 0 to disable it.

**The floor moves too.** `farm_market.floor_price` is written at roll time as
`base · 0.30 · demand · skew`. Without that, the old flat 30%-of-base floor would
swallow the throttle whole — at demand 0.59 and the 45%-likely low regime,
`base · 0.30 · 0.59` is already under it.

### Simulation, 180 days

At `burn_share = 0.90`, discretionary sink decaying 3%/day (which is what the
data shows):

| | supply | farm mint | net/day |
|---|---|---|---|
| d7 | 411,782 | 37,240 | +960 |
| d30 | 451,407 | 25,397 | +2,276 |
| d90 | 630,592 | 15,603 | +3,364 |
| d180 | 945,837 | 13,848 | +3,559 |

against **8.89M** and +52,777/day with no change at all.

## Knobs, cheapest first

All five are one-line `CREATE OR REPLACE` on an IMMUTABLE function:

| function | today | effect |
|---|---|---|
| `farm_npc_burn_share()` | 0.90 | the master dial. 1.0 = farm neutral, >1 = farm mints |
| `farm_seasonal_premium_cap_x()` | 3.0 | fair-share weeks of premium per player |
| `farm_npc_budget_floor_per_player()` | 1000 | coins/day/player the NPC always pays |
| `farm_crop_skew_exponent()` | 0.35 | 0 disables per-crop skew |
| `farm_demand_bounds()` | 0.20 / 1.00 / 0.15 | clamp lo, clamp hi, glide per roll |

`hero_item_defs.interest_cap` is a data change on two rows.

## Known limits

- Above `pressure = 5` the 0.20 demand clamp binds and revenue grows linearly
  again. At today's budget that is 251,890 coins/day, 4.6× current output; the
  burn (and so the budget) would have moved long before.
- Land tax is inside the measured burn and is paid *out of* crop income, so
  there is a mild self-reference. Loop gain ≈ 0.18, which converges; it raises
  the effective budget by ~10%.
- `farm_revenue_per_day()` uses a 7-day window and `farm_burn_per_day()` a
  21-day one. Deliberate — revenue must respond fast, the budget must be stable
  — but it means the throttle tightens over ~3 weeks as the burn window rolls
  past the build-out phase (pressure 1.30 on day one, ~1.7 once it catches up).

## Client mirrors that must stay in sync

- `farmMarketFloor()` ↔ `COALESCE(v_mkt.floor_price, v_mkt.base_price * 0.30)`
- `FARM_SEASONAL_PREMIUM_CAP_X` ↔ `farm_seasonal_premium_cap_x()`
- `farmSeasonalPremiumLeft()` ↔ the `v_event_cap` arithmetic in `sell_crop_to_npc`
- `farm_market` SELECTs must carry `floor_price` (three sites in `index.html`)
