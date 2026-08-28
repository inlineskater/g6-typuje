# „Drabina Kariery G6" (`hilo`) — Hi-Lo card ladder

`supabase/hilo.sql` · `supabase/functions/hilo-action` · `tabs/hilo.js`

The server shows a card. You call **WYŻEJ** (next is higher *or the same*) or
**NIŻEJ** (lower or the same), with the true probability printed on the button.
Right, and the pot multiplies by the fair inverse of that probability and the
next card flips. Wrong, and it's gone. Cash out whenever.

## Why the odds can be printed on the buttons

Ties win **both** calls — the standard hilo formulation, and the forgiving one:

```
P(WYŻEJ) = (14 − r)/13     P(NIŻEJ) = r/13     r ∈ 1..13
```

They sum to 14/13; the extra 1/13 is the tie, which pays either call. The full
table, which is also what the UI renders:

| karta | P(WYŻEJ) | × | P(NIŻEJ) | × |
|---|---|---|---|---|
| 2 | 100.0% | ×1.00 | 7.7% | ×13.00 |
| 5 | 76.9% | ×1.30 | 30.8% | ×3.25 |
| 8 | 53.8% | ×1.86 | 53.8% | ×1.86 |
| J | 30.8% | ×3.25 | 76.9% | ×1.30 |
| A | 7.7% | ×13.00 | 100.0% | ×1.00 |

## ⚠️ The house edge is applied ONCE, at cash-out — never per step

Each step multiplies the pot by exactly `1/p`, so
`E[pot after step] = p · (pot/p) = pot`: the ladder is a **martingale**, and by
the optional stopping theorem every strategy has the same expected value.
Consequences worth protecting:

- **RTP is a flat 95% at every streak length.** A 12-step run is not quietly
  worse than a 1-step run.
- **No strategy beats another.** Always the safe side, always the long shot,
  skipping to hunt for aces — identical EV. There is nothing to solve, so there
  is no wrong way to play, only a variance preference.

`scripts/` has no parity harness here because there is no client-side sim to
keep in sync — but the property is checked exactly (not by sampling) over all
13 ranks × 2 calls: stated `p` equals true `p`, and `E[pot after step] == pot`
to within 1e-12.

**Do not "fix" this by applying `HOUSE_FACTOR` per step.** It compounds to 0.54
over 12 steps and punishes exactly the runs the game exists for. A Monte Carlo
will *look* like it disagrees for long-shot strategies (measured 179% and 0% on
400k rounds at stop@5 and stop@10) — that is heavy-tail variance, not bias:
`always WYŻEJ` ratchets the rank upward until `p → 1/13`, so survivors are rare
and enormous. Verify this analytically, not by sampling.

## No secrets table, deliberately

`mines_round_secrets` and `crash_round_secrets` exist because those games hide
state the player bets against **before** they act — the board is fixed before the
first click, the bust point must exist before the cash-out. Hi-Lo has no such
state: each card is drawn from crypto RNG at the moment of the call and is
immediately public. There is nothing a client could peek at.

## Caps

The ceiling that matters is in **coins**, not multiplier: a multiplier cap alone
is meaningless for a 10-coin stake and ruinous for a 10,000-coin one.

```
MAX_PAYOUT = 150,000    (~a third of the 2026-08-28 money supply)
MAX_MULT   = 100,000    (only stops a trivial stake climbing forever)
MAX_DRAWS  = 250        (skips count — an idle player can't hold a round open)
```

⚠️ A cap **truncates the fair value of the ladder**, so it is the one thing that
can make the published odds a lie. `capMultiplier(bet, houseFactor)` computes the
effective ceiling for the chosen stake and the UI shows it (`Sufit przy tej
stawce: ×N`). The original `MAX_MULT = 5000` was rejected because it bound after
3 long-shot calls at a 50-coin stake — measured RTP fell to 40%.

## Skip

`⟳ Inna karta` redraws without betting. EV-neutral by construction (the pot does
not move, the new card is uniform), so it is free and unlimited — it exists so a
player dealt a 2 or an ace is not forced into a ×1.00 call. It consumes a draw,
which is what `MAX_DRAWS` really bounds.

## Integration

- Casino-luck amulet: house factor 0.95 → 0.98, same as Mines.
- `hilo_spins` is the record every consumer reads — `hazard_stats.hilo_pl`, the
  `game_transactions` view, `coin-inflow-stats`, `economy_stats.hazard_house_net`.
  `hilo_rounds` is working state and is never aggregated.
- Because `farm_burn_per_day()` (anti-inflation.sql) reads `game_transactions`,
  Hi-Lo losses raise everyone's crop prices automatically.
- Ranked on **streak**, not coins won: a long ladder is the brag, and ranking on
  payout would just rank whoever bets biggest.

## Deploy

```
supabase db query --linked "$(cat supabase/hilo.sql)"
# then re-run hazard-views.sql + coin-inflow-stats.sql + economy-stats.sql
supabase functions deploy hilo-action
```
