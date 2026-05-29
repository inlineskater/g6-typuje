# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Rynek Proroctw G6** — a company prediction market web app with virtual coins, a shared Texas Hold'em table, and small office games. Polish UI. Single static file (`index.html`) backed by a hosted Supabase project and Supabase Edge Functions for server-owned game actions.

Live URL: `https://inlineskater.github.io/rynek-proroctw-g6/`

## Deployment

There is no build step. Push to `main` → GitHub Actions copies `index.html` to GitHub Pages. That's the entire pipeline.

To apply database changes: paste the relevant SQL into the Supabase SQL Editor (Dashboard → SQL Editor → Run). There is no migration runner.

- `supabase/schema.sql` — core prediction-market schema, run once on a fresh project
- `supabase/poker.sql` — poker tables, RLS, realtime publication, and leaderboard stack accounting
- `supabase/functions/poker-action` — authenticated Edge Function that owns poker state transitions, hidden cards, and chip accounting
- `supabase/whack-boss.sql` — Whack-a-Boss rounds, weekly/all-time leaderboard views, and scheduled weekly prize payout
- `supabase/functions/whack-boss-action` — authenticated Edge Function that issues and validates 18-second Whack-a-Boss rounds
- `supabase/bug-jumper.sql` / `supabase/flappy-pants.sql` — seasonal arcade games (Bug Jumper, „3 Pary Spodni"); each adds `*_rounds`/`*_scores`/`*_weekly_awards` tables, three leaderboard views, an `award_*_week()` payout, realtime publication, and a Saturday-night `pg_cron` job
- `supabase/functions/bug-jumper-action` / `supabase/functions/flappy-pants-action` — authenticated Edge Functions that issue and validate seasonal-game rounds
- `supabase/prod-hardening.sql` — idempotent; adds indexes and tightens permissions; safe to re-run
- `supabase/reset-data.sql` — wipes all markets, trades, and poker state, resets every profile to 1000 coins

## Architecture

Everything lives in `index.html`: HTML structure, all CSS (CSS variables for theming), and all JavaScript in one `<script>` block. No bundler, no framework, no TypeScript.

**Supabase client** is loaded from CDN. The anon key is intentionally public — Supabase RLS and function grants are the security boundary.

### Key global state

| Variable | Contents |
|---|---|
| `me` | Logged-in user profile (`id`, `nick`, `coins`) |
| `markets[]` | All market rows from DB |
| `tradesByMarket{}` | All individual trade rows, keyed by `market_id` |
| `myPositionsByMarket{}` | Current user's aggregated positions (from `positions` view) |
| `pokerState` | Sanitized shared poker table state returned by the Edge Function |
| `whackBossRuntime` | Current local Whack-a-Boss round timing, clicks, and score |

### Data flow

1. `loadMarkets()` fetches markets, trades, and profiles in parallel then calls `renderMarkets()`.
2. `renderMarkets()` fetches the current user's positions (`positions` view), then calls `buildMarketCard()` for each market.
3. Realtime subscriptions on `markets` and `trades` tables update state and call targeted update helpers (`updateCardProb`, `updateCardChart`) instead of full re-renders where possible.

### Auth

Nick + 4-digit PIN. Implemented as Supabase email/password auth using the synthetic email `nick@typuje.local`. A Postgres trigger (`handle_new_user`) creates the `profiles` row on first signup. All writes go through RPCs — there are no direct table inserts from the frontend.

### CPMM pricing

`p(YES) = no_shares / (yes_shares + no_shares)`. Markets start at `yes_shares = no_shares = 500` (50%). Constant product `k = yes_shares × no_shares` is maintained by `place_bet`. Shares out for a NO bet of X coins:

```
dN = (N × X) / (Y + X)
sharesOut = X + dN
```

### Payout formula

Resolution distributes the total pot via the RPC `resolve_market`. The formula (mirrored in `estimatePayout()` for the live UI estimate):

```
payout = user_amount_bet + losing_side_pot × (user_shares / total_winning_shares)
```

Winners always get at least their bet back; the losing side's coins are split proportionally by share count. The estimate and the actual SQL resolution use identical math.

### DOM helper

`el(tag, attrs, ...children)` creates DOM nodes. **Children must be strings or Node objects — never arrays.** When you need to mix text and multiple element nodes outside of `el()`, use `node.append(str, node, str, ...)` instead.

### Permissions

All mutations require authentication and go through Supabase RPCs:
- `place_bet(market_uuid, side, amount)` — enforces coin balance, side-locking (can't bet both sides on the same market), and CPMM math atomically
- `create_market(icon, title, deadline)`
- `resolve_market(market_uuid, resolution)` — only market creator or nick `admin` can call this

Users can only add to one side per market (side-locked after first bet). `admin` nick can resolve any market.

### Poker

Poker is one shared authenticated Texas Hold'em table. Browser clients call `sb.functions.invoke('poker-action', ...)`; they do not write poker tables directly. The Edge Function verifies the user JWT, uses `SUPABASE_DB_URL` for a Postgres transaction, and stores hidden cards/deck in service-only tables. Public realtime updates on `poker_tables`, `poker_seats`, and `poker_events` only trigger a sanitized state reload.

Table defaults are 100 coin buy-in, 1/2 blinds, 6 seats, and a 30 second action timer. Sitting deducts the buy-in from `profiles.coins`; standing is allowed only between hands and returns the remaining stack. The leaderboard view includes active poker stacks so seated players keep their net worth while playing.

### Whack-a-Boss

Whack-a-Boss is an 18-second authenticated mini-game. The browser calls `sb.functions.invoke('whack-boss-action', ...)`; the Edge Function creates the round schedule, validates submitted click timing/positions, stores scores, and returns weekly/all-time leaderboards. Weekly awards are paid by `award_whack_boss_week()` through `pg_cron`: rank 1 gets 100 coins, rank 2 gets 50, rank 3 gets 25. Weekly leaderboards are date-filtered by ISO week in the Europe/Warsaw timezone; all-time records stay stored separately.

### Seasonal games

The seasonal tab hosts one rotating arcade game per Sunday-start week (Europe/Warsaw). `SEASONAL_SCHEDULE` in `index.html` maps `weekStart` → `gameType`/`displayName`; `getCurrentSeasonalEntry()` picks the active game and `loadSeasonalTab()` shows the matching `seasonal-game-*` panel. Current rotation: `whack_boss` → `bug_jumper` → `flappy_pants` („3 Pary Spodni", from 2026-05-31).

Each seasonal game mirrors the same stack:
- `<game>_rounds` / `<game>_scores` / `<game>_weekly_awards` tables, `<game>_current_week` / `_all_time` / `_recent_awards` views, an `award_<game>_week()` SECURITY DEFINER payout (100/50/25), realtime publication, and a `pg_cron` job at `'5 23 * * 6'` (Saturday 23:05) that pays the previous week's top 3.
- An Edge Function (`<game>-action`) with `state`/`start`/`submit` actions. The browser cannot write score tables (RLS grants SELECT only); the function owns inserts via `SUPABASE_DB_URL`, caps the per-round score, enforces the round expiry window, and applies the strongest equipped hero `score_bonus` for that `effect_game`.
- Frontend: a canvas runtime (`new<Game>Runtime`/`<g>Draw`/RAF loop) plus `invoke*`/`load*`/`render*` helpers, wired into `loadSeasonalTab()`, the realtime subscriptions, and the `loadSeasonHistory()` recent-awards aggregator.

„3 Pary Spodni" (Flappy Pants) is a Flappy Bird clone: you ARE a pair of trousers (Space/click/↑ to flap) with 3 lives (the "3 pary spodni"); each crash costs one pair with brief invincibility, and the round ends after the third. Score = obstacles passed; it persists across lives.
