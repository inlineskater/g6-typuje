# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Rynek Proroctw G6** — a company prediction market web app with virtual coins, a shared Texas Hold'em table, and small office games. Polish UI. Single static file (`index.html`) backed by a hosted Supabase project and Supabase Edge Functions for server-owned game actions.

Live URL: `https://inlineskater.github.io/rynek-proroctw-g6/`

## Deployment

There is no build step. Push to `main` → GitHub Actions copies `index.html` to GitHub Pages. That's the entire pipeline.

To apply database changes: paste the relevant SQL into the Supabase SQL Editor (Dashboard → SQL Editor → Run). There is no migration runner.

- `supabase/schema.sql` — core prediction-market schema, run once on a fresh project
- `supabase/store.sql` — reward shop tables/RPCs used by the Sklep tab
- `supabase/marketplace.sql` — peer-to-peer marketplace ("Targowisko") tables/RPCs; any user can list IRL goods/services; winning/buy coins transfer from buyer to seller (not burned)
- `supabase/poker.sql` — poker tables, RLS, realtime publication, and leaderboard stack accounting
- `supabase/functions/poker-action` — authenticated Edge Function that owns poker state transitions, hidden cards, and chip accounting
- `supabase/whack-boss.sql` — Whack-a-Boss rounds, weekly/all-time leaderboard views, and scheduled weekly prize payout
- `supabase/functions/whack-boss-action` — authenticated Edge Function that issues and validates 18-second Whack-a-Boss rounds
- `supabase/bug-jumper.sql` / `supabase/flappy-pants.sql` / `supabase/snake.sql` / `supabase/invoice-horde.sql` — seasonal arcade games (Bug Jumper, „3 Pary Spodni", Snake, „Najazd Faktur"); each adds `*_rounds`/`*_scores`/`*_weekly_awards` tables, three leaderboard views, an `award_*_week()` payout, realtime publication, and a Monday `pg_cron` job after the week closes
- `supabase/functions/bug-jumper-action` / `supabase/functions/flappy-pants-action` / `supabase/functions/snake-action` / `supabase/functions/invoice-horde-action` — authenticated Edge Functions that issue and validate seasonal-game rounds
- `supabase/season-award-gating.sql` — idempotent; season-gates the weekly award cron jobs via `seasonal_game_for_week()`; must be kept in sync with the rotation constants in `index.html` and re-run when they change
- `supabase/fix-client-meta-double-encoding.sql` — idempotent; normalizes double-encoded `client_meta` on the four `*_scores` tables (one-time migration + BEFORE INSERT trigger), required for the leaderboard base/bonus score split
- `supabase/football.sql` — World Cup 2026 fixed-odds betting ("Mundial"); adds `football_matches`/`football_bets` tables (text event ids, SELECT-only for clients), extends the `leaderboard` view to count open bet stake, realtime publication, and an **every-6h** `pg_cron` job that `net.http_post`s the Edge Function to refresh odds and settle results. **Before running, replace the `__PROJECT_REF__`/`__FOOTBALL_CRON_SECRET__` placeholders in the cron block.**
- `supabase/functions/football-action` — Edge Function (`verify_jwt = false`) that owns all football writes: `state` (public read), `bet` (JWT-validated fixed-odds bet that locks server-side odds), and `cron` (`x-cron-secret`-gated sync+settle pulling events/odds/results from **The Odds API v4**)
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

### Marketplace (Targowisko)

The Sklep tab contains a peer-to-peer marketplace ("Targowisko 🛍️") where **any logged-in user** can list IRL goods or services for coins. Unlike the admin-only store rewards and hero-item auctions (where coins are burned), marketplace coins **transfer from buyer to seller**. Two listing formats are supported: fixed-price (`listing_type='fixed'`, instant buy) and timed auction (`listing_type='auction'`, bidding with escrow). The bidding engine mirrors `place_hero_item_bid`: coins are escrowed on each bid, the previous leader is auto-refunded when outbid, and the leading bidder only pays the incremental difference to top up their own bid. Settlement (`settle_marketplace_listing`) credits the escrowed winning amount to `seller_id`. Sellers (or admin) can settle their own auction; sellers can cancel an open listing with no bids. All RPCs are in `supabase/marketplace.sql`; the `marketplace_cards` view is used for card rendering.

### Poker

Poker is one shared authenticated Texas Hold'em table. Browser clients call `sb.functions.invoke('poker-action', ...)`; they do not write poker tables directly. The Edge Function verifies the user JWT, uses `SUPABASE_DB_URL` for a Postgres transaction, and stores hidden cards/deck in service-only tables. Public realtime updates on `poker_tables`, `poker_seats`, and `poker_events` only trigger a sanitized state reload.

Table defaults are 100 coin buy-in, 1/2 blinds, 6 seats, and a 30 second action timer. Sitting deducts the buy-in from `profiles.coins`; standing is allowed only between hands and returns the remaining stack. The leaderboard view includes active poker stacks so seated players keep their net worth while playing.

### Whack-a-Boss

Whack-a-Boss is an 18-second authenticated mini-game. The browser calls `sb.functions.invoke('whack-boss-action', ...)`; the Edge Function creates the round schedule, validates submitted click timing/positions, stores scores, and returns weekly/all-time leaderboards. Weekly awards are paid by `award_whack_boss_week()` through `pg_cron`: rank 1 gets 100 coins, rank 2 gets 50, rank 3 gets 25. Weekly leaderboards are date-filtered by ISO week in the Europe/Warsaw timezone; all-time records stay stored separately.

### Seasonal games

The seasonal tab hosts one rotating arcade game per Monday-start week (Europe/Warsaw). `SEASONAL_ANCHOR_WEEK_START` plus `SEASONAL_ROTATION` in `index.html` derive the active game for any future week; `SEASONAL_OVERRIDES` can replace a specific week; `getCurrentSeasonalEntry()` picks the active game and `loadSeasonalTab()` shows the matching `seasonal-game-*` panel. Current rotation: `whack_boss` → `bug_jumper` → `flappy_pants` („3 Pary Spodni") → `snake` → `invoice_horde` („Najazd Faktur"), with Snake also overriding the week starting 2026-06-15 and „Najazd Faktur" overriding the week starting 2026-06-22.

Each seasonal game mirrors the same stack:
- `<game>_rounds` / `<game>_scores` / `<game>_weekly_awards` tables, `<game>_current_week` / `_all_time` / `_recent_awards` views, an `award_<game>_week()` SECURITY DEFINER payout (100/50/25), realtime publication, and a `pg_cron` job at `'5 0 * * 1'` (Monday 00:05 UTC) that pays the previous week's top 3. The cron jobs are season-gated by `seasonal_game_for_week()` (`supabase/season-award-gating.sql`) so off-season rounds never trigger a payout — **that SQL function mirrors `SEASONAL_ANCHOR_WEEK_START`/`SEASONAL_ROTATION`/`SEASONAL_OVERRIDES` from `index.html` and must be updated and re-run whenever the rotation or overrides change**.
- An Edge Function (`<game>-action`) with `state`/`start`/`submit` actions. The browser cannot write score tables (RLS grants SELECT only); the function owns inserts via `SUPABASE_DB_URL`, caps the per-round score, enforces the round expiry window, and applies hero score bonuses only for games that support them.
- Frontend: a canvas runtime (`new<Game>Runtime`/`<g>Draw`/RAF loop) plus `invoke*`/`load*`/`render*` helpers, wired into `loadSeasonalTab()`, the realtime subscriptions, and the `loadSeasonHistory()` recent-awards aggregator.

Bug Jumper hard course v2 uses `course_id = 'bug_jumper_hard_v2'`: a fixed 10-column, 30-line course shared by every player, no per-round random lane setup, safe rest lines at 10/20/30, one point per line reached, server replay of the submitted movement log, `completion_ms` tie-breaks, and hard-course-only leaderboard/award views. Existing legacy rows remain stored as `legacy_random_v1`.

„3 Pary Spodni" (Flappy Pants) is a Flappy Bird clone: you ARE a pair of trousers (Space/click/↑ to flap) with 3 lives (the "3 pary spodni"); each crash costs one pair with brief invincibility, and the round ends after the third. Score = obstacles passed; it persists across lives.

Snake is a 20x20 seeded-grid seasonal game prompted by Filip with `do snake, make no mistakes`. The browser submits direction changes, and `snake-action` replays them server-side to determine apples eaten before wall/self collision or the 120-second cap. Weekly ranking uses score descending, then shorter `duration_ms`, then earlier submission.

„Najazd Faktur" (`invoice_horde`) is an original accounting-themed arena-survivor (inspired by the Vampire-Survivors genre, written from scratch — not copied). You run an accountant (8-way WASD/arrows/swipe) dodging waves of „faktury" that home in from the edges; an auto-firing „ZAKSIĘGOWANO" stamp hitscans the nearest invoice in range (+1 „zaksięgowane"). 5× „Cierpliwość" HP; each invoice that reaches you costs one, and the 60-second round ends on death or timeout. Like Snake it is a **deterministic integer simulation on a 100 ms tick** (seeded LCG enemy spawns, `isqrt`-based homing, no floats that desync) — the browser logs only input-direction changes `{tick,dir}`, and `invoice-horde-action` replays `seed + moves` to derive the trusted kill count (anti-cheat ceiling `MAX_SCORE_PER_ROUND = 80`; spawn schedule tuned so a strong run tops out ~30–50). The client renders at 60 fps by interpolating between sim ticks. Weekly ranking matches Snake: score descending, then shorter `duration_ms`, then earlier submission.

### World Cup betting (Mundial)

The `⚽ Mundial` tab is **fixed-odds betting vs the house** on FIFA World Cup 2026 matches — unlike the peer-pooled CPMM markets, it mints/burns coins like slots/roulette. A player picks a match outcome (1 = home / X = draw / 2 = away); the real bookmaker decimal odds are **locked at bet time** and a winning bet pays `floor(stake × locked_odds)`. Losing stakes are burned. The displayed "szansa" per outcome is the **de-vigged implied probability** (`(1/odd_i) / Σ(1/odd_j)`).

All events, odds, and final results come from **The Odds API v4** (`api.the-odds-api.com/v4`, sport key `soccer_fifa_world_cup`) and are written **only** by the `football-action` Edge Function over its service `postgres` connection — the browser has SELECT-only access and **never sends odds** (the `bet` action reads the trusted odds already stored in `football_matches`). Match ids are the API's hex event ids (text). The function is `verify_jwt = false` so it can serve the public `state` read and the cron path; the `bet` action validates the user JWT manually via `requireUser()`.

An **every-6h** `pg_cron` job (`football_hourly_sync`) `net.http_post`s the function with `{action:'cron'}` and the `x-cron-secret` header. The `cron` action: (1) **syncs events+odds** in one `/sports/{sport}/odds?regions=eu&markets=h2h&oddsFormat=decimal` call (the odds response carries fixtures, so no separate fixtures call) — picks a usable bookmaker per event, de-vigs the 1X2 prices, and upserts; (2) **settles** finished matches via `/sports/{sport}/scores?daysFrom=3` (only spent when a started match is still unsettled), deriving `1/X/2` from the scores and crediting winners' `potential_payout`; (3) **voids+refunds** stale matches (`voidStale`) — any match still `open` with no result **>12h past kickoff** (cancelled/abandoned/walkover/API gap) is marked `CANC`/`settled` and its open bets are refunded their stake and set to `void`. Void runs *after* settle so a genuine result always wins, and it costs **0 API calls**. An admin-only **`void`** action (`nick = 'admin'`, JWT-validated) does the same immediately for a specific `matchId` as a safety valve. **The Odds API free tier is 500 req/month, so the cron runs every 6h (≤3 req/run ≈ 360/month) — hourly is impossible.**

Config lives in Edge Function secrets: `ODDS_API_KEY` (the-odds-api.com key), `FOOTBALL_CRON_SECRET` (shared with the cron block in `supabase/football.sql`), and optional `ODDS_SPORT_KEY` (default `soccer_fifa_world_cup`), `ODDS_REGIONS` (default `eu`), `ODDS_BOOKMAKER` (preferred bookmaker key, else first usable). Frontend: `invokeFootball`/`loadFootball`/`renderFootball`/`buildMatchCard` plus a dedicated `#fb-overlay` bet modal, wired into `switchTab('football')` and the `football_matches`/`football_bets` realtime subscriptions.
