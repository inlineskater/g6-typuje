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
- `supabase/bug-jumper.sql` / `supabase/flappy-pants.sql` / `supabase/snake.sql` / `supabase/invoice-horde.sql` — seasonal arcade games (Bug Jumper, „3 Pary Spodni", Snake, „Najazd Ticketów" — internal gameType `invoice_horde`); each adds `*_rounds`/`*_scores`/`*_weekly_awards` tables, three leaderboard views, an `award_*_week()` payout, realtime publication, and a Monday `pg_cron` job after the week closes
- `supabase/functions/bug-jumper-action` / `supabase/functions/flappy-pants-action` / `supabase/functions/snake-action` / `supabase/functions/invoice-horde-action` — authenticated Edge Functions that issue and validate seasonal-game rounds
- `supabase/season-award-gating.sql` — idempotent; season-gates the weekly award cron jobs via `seasonal_game_for_week()`; must be kept in sync with the rotation constants in `index.html` and re-run when they change
- `supabase/fix-client-meta-double-encoding.sql` — idempotent; normalizes double-encoded `client_meta` on the four `*_scores` tables (one-time migration + BEFORE INSERT trigger), required for the leaderboard base/bonus score split
- `supabase/football.sql` — World Cup 2026 fixed-odds betting ("Mundial"); adds `football_matches`/`football_bets` tables (text event ids, SELECT-only for clients), extends the `leaderboard` view to count open bet stake, realtime publication, and an **every-6h** `pg_cron` job that `net.http_post`s the Edge Function to refresh odds and settle results. **Before running, replace the `__PROJECT_REF__`/`__FOOTBALL_CRON_SECRET__` placeholders in the cron block.**
- `supabase/functions/football-action` — Edge Function (`verify_jwt = false`) that owns all football writes: `state` (public read), `bet` (JWT-validated fixed-odds bet that locks server-side odds), and `cron` (`x-cron-secret`-gated sync+settle pulling events/odds/results from **The Odds API v4**)
- `supabase/economy-stats.sql` — idempotent; adds `economy_stats()` SECURITY DEFINER aggregate RPC that returns server-wide coin supply breakdown (cash, market positions, football/poker/auction escrow, hero items, accessories) plus per-player `holdings` array and `richest` for the **Skarbiec G6** panel on the Statystyki tab
- `supabase/canvas.sql` — „Wspólne Płótno" collaborative pixel canvas; adds `canvas_pixels` (one shared 192×108 board, public SELECT) + `canvas_cooldowns` (own-row SELECT) tables, realtime publication on `canvas_pixels`, and the `place_pixel(x,y,color)` SECURITY DEFINER RPC that enforces the per-user cooldown server-side. Idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE`); the bounds (192×108) and the `interval '2 hours'` cooldown live in the RPC and mirror `CANVAS_W`/`CANVAS_H` in `index.html`
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
- `resolve_market(market_uuid, resolution)` — only market creator or a profile with `is_admin = true` can call this

Users can only add to one side per market (side-locked after first bet). Profiles with `is_admin = true` can resolve any market.

### Marketplace (Targowisko)

The Sklep tab contains a peer-to-peer marketplace ("Targowisko 🛍️") where **any logged-in user** can list IRL goods or services for coins. Unlike the admin-only store rewards and hero-item auctions (where coins are burned), marketplace coins **transfer from buyer to seller**. Two listing formats are supported: fixed-price (`listing_type='fixed'`, instant buy) and timed auction (`listing_type='auction'`, bidding with escrow). The bidding engine mirrors `place_hero_item_bid`: coins are escrowed on each bid, the previous leader is auto-refunded when outbid, and the leading bidder only pays the incremental difference to top up their own bid. Settlement (`settle_marketplace_listing`) credits the escrowed winning amount to `seller_id`. Sellers (or admin) can settle their own auction; sellers can cancel an open listing with no bids. All RPCs are in `supabase/marketplace.sql`; the `marketplace_cards` view is used for card rendering.

### Poker

Poker is one shared authenticated Texas Hold'em table. Browser clients call `sb.functions.invoke('poker-action', ...)`; they do not write poker tables directly. The Edge Function verifies the user JWT, uses `SUPABASE_DB_URL` for a Postgres transaction, and stores hidden cards/deck in service-only tables. Public realtime updates on `poker_tables`, `poker_seats`, and `poker_events` only trigger a sanitized state reload.

Table defaults are 100 coin buy-in, 1/2 blinds, 6 seats, and a 30 second action timer. Sitting deducts the buy-in from `profiles.coins`; standing is allowed only between hands and returns the remaining stack. The leaderboard view includes active poker stacks so seated players keep their net worth while playing.

### Whack-a-Boss

Whack-a-Boss is an 18-second authenticated mini-game. The browser calls `sb.functions.invoke('whack-boss-action', ...)`; the Edge Function creates the round schedule, validates submitted click timing/positions, stores scores, and returns weekly/all-time leaderboards. Weekly awards are paid by `award_whack_boss_week()` through `pg_cron`: rank 1 gets 100 coins, rank 2 gets 50, rank 3 gets 25. Weekly leaderboards are date-filtered by ISO week in the Europe/Warsaw timezone; all-time records stay stored separately.

### Seasonal games

The seasonal tab hosts one rotating arcade game per Monday-start week (Europe/Warsaw). `SEASONAL_ANCHOR_WEEK_START` plus `SEASONAL_ROTATION` in `index.html` derive the active game for any future week; `SEASONAL_OVERRIDES` can replace a specific week; `getCurrentSeasonalEntry()` picks the active game and `loadSeasonalTab()` shows the matching `seasonal-game-*` panel. Current rotation: `whack_boss` → `bug_jumper` → `flappy_pants` („3 Pary Spodni") → `snake` → `invoice_horde` („Najazd Ticketów"), with Snake also overriding the week starting 2026-06-15 and „Najazd Ticketów" overriding the week starting 2026-06-22.

Each seasonal game mirrors the same stack:
- `<game>_rounds` / `<game>_scores` / `<game>_weekly_awards` tables, `<game>_current_week` / `_all_time` / `_recent_awards` views, an `award_<game>_week()` SECURITY DEFINER payout (100/50/25), realtime publication, and a `pg_cron` job at `'5 0 * * 1'` (Monday 00:05 UTC) that pays the previous week's top 3. The cron jobs are season-gated by `seasonal_game_for_week()` (`supabase/season-award-gating.sql`) so off-season rounds never trigger a payout — **that SQL function mirrors `SEASONAL_ANCHOR_WEEK_START`/`SEASONAL_ROTATION`/`SEASONAL_OVERRIDES` from `index.html` and must be updated and re-run whenever the rotation or overrides change**.
- An Edge Function (`<game>-action`) with `state`/`start`/`submit` actions. The browser cannot write score tables (RLS grants SELECT only); the function owns inserts via `SUPABASE_DB_URL`, caps the per-round score, enforces the round expiry window, and applies hero score bonuses only for games that support them.
- Frontend: a canvas runtime (`new<Game>Runtime`/`<g>Draw`/RAF loop) plus `invoke*`/`load*`/`render*` helpers, wired into `loadSeasonalTab()`, the realtime subscriptions, and the `loadSeasonHistory()` recent-awards aggregator.

Bug Jumper hard course v2 uses `course_id = 'bug_jumper_hard_v2'`: a fixed 10-column, 30-line course shared by every player, no per-round random lane setup, safe rest lines at 10/20/30, one point per line reached, server replay of the submitted movement log, `completion_ms` tie-breaks, and hard-course-only leaderboard/award views. Existing legacy rows remain stored as `legacy_random_v1`.

„3 Pary Spodni" (Flappy Pants) is a Flappy Bird clone: you ARE a pair of trousers (Space/click/↑ to flap) with 3 lives (the "3 pary spodni"); each crash costs one pair with brief invincibility, and the round ends after the third. Score = obstacles passed; it persists across lives.

Snake is a 20x20 seeded-grid seasonal game prompted by Filip with `do snake, make no mistakes`. The browser submits direction changes, and `snake-action` replays them server-side to determine apples eaten before wall/self collision or the 120-second cap. Weekly ranking uses score descending, then shorter `duration_ms`, then earlier submission.

„Najazd Ticketów" (internal gameType `invoice_horde`) is an original IT-helpdesk arena-survivor (inspired by the Vampire-Survivors / Devil-Daggers genre, written from scratch — not copied). You run an IT guy 🧑‍💻 (8-way WASD/arrows/swipe) dodging an endless swarm of support tickets 🎫 that home in from the edges; an auto-firing „ROZWIĄZANE" script hitscans the nearest ticket in range (+1 resolved). Every ~125 ticks (~10 s) a **„CF" mini-boss** spawns — an oversized, slower (`BOSS_SPEED = 4`), bigger-hitbox ticket that soaks `BOSS_HP = 5` script hits before dying for `BOSS_SCORE = 5`; it lives in the same `enemies` array flagged `boss:true`, so focusing it lets the swarm pile up (risk/reward). Its 👔/"CF"/HP-bar rendering is client-only cosmetic; its constants are part of the byte-for-byte parity contract. **Survival mode, one life:** a single touch ends the run — there is no countdown, the spawn rate ramps until it outpaces the script so standing still gets you surrounded (you must kite the swarm into a trailing line). `ROUND_DURATION_MS` (60 s) is only a hard replay/safety cap; the swarm is capped at `ENEMY_CAP = 70`. Like Snake it is a **deterministic integer simulation on an 80 ms tick** (seeded LCG enemy spawns, `isqrt`-based homing, no floats that desync) — the browser logs only input-direction changes `{tick,dir}`, and `invoice-horde-action` replays `seed + moves` to derive the trusted kill count (anti-cheat ceiling `MAX_SCORE_PER_ROUND = 200`). The client renders at 60 fps by interpolating between sim ticks, with canvas particle/`+1`/death-shake effects that are purely cosmetic (never read by the sim or submitted). Weekly ranking: score (tickets resolved) descending, then **longer** `duration_ms` (survival time), then earlier submission. The constant block in `index.html` (IH_*) and `invoice-horde-action` must stay byte-for-byte equivalent — there is a headless parity harness pattern (client tick-sim vs server replay) used to verify 0 mismatches whenever they change.

### World Cup betting (Mundial)

The `⚽ Mundial` tab is **fixed-odds betting vs the house** on FIFA World Cup 2026 matches — unlike the peer-pooled CPMM markets, it mints/burns coins like slots/roulette. A player picks a match outcome (1 = home / X = draw / 2 = away); the real bookmaker decimal odds are **locked at bet time** and a winning bet pays `floor(stake × locked_odds)`. Losing stakes are burned. The displayed "szansa" per outcome is the **de-vigged implied probability** (`(1/odd_i) / Σ(1/odd_j)`).

Each user may place **at most one bet per match** (no top-ups, no opposite outcomes on the same fixture). The server enforces this inside the `placeBet` transaction; the frontend disables odds buttons once a bet exists for that match.

All events, odds, and final results come from **The Odds API v4** (`api.the-odds-api.com/v4`, sport key `soccer_fifa_world_cup`) and are written **only** by the `football-action` Edge Function over its service `postgres` connection — the browser has SELECT-only access and **never sends odds** (the `bet` action reads the trusted odds already stored in `football_matches`). Match ids are the API's hex event ids (text). The function is `verify_jwt = false` so it can serve the public `state` read and the cron path; the `bet` action validates the user JWT manually via `requireUser()`.

An **every-6h** `pg_cron` job (`football_hourly_sync`) `net.http_post`s the function with `{action:'cron'}` and the `x-cron-secret` header. The `cron` action: (1) **syncs events+odds** in one `/sports/{sport}/odds?regions=eu&markets=h2h&oddsFormat=decimal` call (the odds response carries fixtures, so no separate fixtures call) — picks a usable bookmaker per event, de-vigs the 1X2 prices, and upserts; (2) **settles** finished matches via `/sports/{sport}/scores?daysFrom=3` (only spent when a started match is still unsettled), deriving `1/X/2` from the scores and crediting winners' `potential_payout`; (3) **voids+refunds** stale matches (`voidStale`) — any match still `open` with no result **>12h past kickoff** (cancelled/abandoned/walkover/API gap) is marked `CANC`/`settled` and its open bets are refunded their stake and set to `void`. Void runs *after* settle so a genuine result always wins, and it costs **0 API calls**. An admin-only **`void`** action (`is_admin = true`, JWT-validated) does the same immediately for a specific `matchId` as a safety valve. **The Odds API free tier is 500 req/month, so the cron runs every 6h (≤3 req/run ≈ 360/month) — hourly is impossible.**

Config lives in Edge Function secrets: `ODDS_API_KEY` (the-odds-api.com key), `FOOTBALL_CRON_SECRET` (shared with the cron block in `supabase/football.sql`), and optional `ODDS_SPORT_KEY` (default `soccer_fifa_world_cup`), `ODDS_REGIONS` (default `eu`), `ODDS_BOOKMAKER` (preferred bookmaker key, else first usable). Frontend: `invokeFootball`/`loadFootball`/`renderFootball`/`buildMatchCard` plus a dedicated `#fb-overlay` bet modal, wired into `switchTab('football')` and the `football_matches`/`football_bets` realtime subscriptions.

### Collaborative canvas (Wspólne Płótno)

The `🎨 Wspólne Płótno` tab is a shared **r/place-style pixel board** — one common **192×108** (16:9) grid that the whole office paints together, rendered near-fullscreen with a thin instructions/toolbar bar on top. Unlike a game, there is no score; it is gated purely by a per-user **time cooldown**: each user gets **one free pixel every 2 hours**, and while on cooldown may keep painting by **paying 1 coin per pixel** (coins burned). A fixed ~16-color palette keeps the canvas coherent.

Unlike Mundial/poker, the write path is a **direct `SECURITY DEFINER` RPC** (`place_pixel(p_x, p_y, p_color)`), not an Edge Function — it mirrors the garden `water_plant()` cooldown pattern. The browser has SELECT-only access to `canvas_pixels`/`canvas_cooldowns` and calls `sb.rpc('place_pixel', …)`; the RPC validates bounds + hex color, locks the caller's `canvas_cooldowns` row `FOR UPDATE`, decides **free** (cooldown elapsed → reset `last_free_at`) vs **paid** (still on cooldown → deduct 1 coin, leave the timer so the free pixel still arrives on schedule), then upserts the pixel `ON CONFLICT (x,y) DO UPDATE` (last-write-wins, so simultaneous clicks resolve to one final color). The client timer is **display-only** — the server is the source of truth and returns `next_free_at`.

The **grid bounds (192×108) and the `interval '2 hours'` cooldown are duplicated** between `supabase/canvas.sql` (the RPC) and `index.html` (`CANVAS_W`/`CANVAS_H`, `CANVAS_COOLDOWN_MS`) — keep them in sync. Frontend: `loadCanvas`/`drawCanvas`/`placePixelRpc`/`onCanvasTap` + `cvSetup` pan/zoom pointer handling (`cv*` helpers) and a 1s `updateCanvasStatus` countdown, wired into `switchTab('canvas')` and a `canvas_pixels` realtime subscription (`applyCanvasPixelChange`) that patches single cells without a full reload.
