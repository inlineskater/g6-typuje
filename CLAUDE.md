# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Rynek Proroctw G6** — a company prediction market web app with virtual coins. Polish UI. Single static file (`index.html`) backed by a hosted Supabase project.

Live URL: `https://inlineskater.github.io/rynek-proroctw-g6/`

## Deployment

There is no build step. Push to `main` → GitHub Actions copies `index.html` to GitHub Pages. That's the entire pipeline.

To apply database changes: paste the relevant SQL into the Supabase SQL Editor (Dashboard → SQL Editor → Run). There is no migration runner.

- `supabase/schema.sql` — full schema, run once on a fresh project
- `supabase/prod-hardening.sql` — idempotent; adds indexes and tightens permissions; safe to re-run
- `supabase/reset-data.sql` — wipes all markets and trades, resets every profile to 1000 coins

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
