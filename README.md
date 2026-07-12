# Rynek Proroctw G6

Company prediction market with virtual coins, a shared Texas Hold'em table, a casino, rotating arcade games, World Cup betting, a collaborative pixel canvas, and a farm/NFT economy. Polish UI, single static `index.html`.

Production URL:

```text
https://inlineskater.github.io/rynek-proroctw-g6/
```

## Deployment

There is no build step. Pushes to `main` deploy `index.html` through `.github/workflows/pages.yml` (GitHub Pages Actions). For a new repo, enable Pages with GitHub Actions as the source.

Database changes are applied by pasting the relevant `supabase/*.sql` file into the Supabase SQL Editor. Edge Functions are deployed with the Supabase CLI or from the dashboard. The general rollout pattern for any feature is:

1. Run its SQL file(s) in the SQL Editor.
2. Deploy its Edge Function (if it has one — see `supabase/functions/`).
3. Re-run the stats views (`supabase/hazard-views.sql`, `supabase/coin-inflow-stats.sql`, `supabase/economy-stats.sql`) if the feature moves coins.
4. Push `index.html`.

`CLAUDE.md` documents every SQL file, its purpose, and file-specific ordering constraints (e.g. the farm stack order: `farm.sql` → `farm-marketplace.sql` → `nft-leveling-rework.sql` → `nft-merge-fixes.sql`).

## Supabase

The public anon key in `index.html` is intentional for Supabase browser apps; the safety boundary is RLS plus limited function grants. Economy writes go through `SECURITY DEFINER` RPCs or authenticated Edge Functions. The only direct browser writes are admin-only, column-limited garden maintenance actions protected by RLS.

Fresh project setup:

1. Create a Supabase project.
2. In SQL Editor, run `supabase/schema.sql` (core prediction market), then the feature SQL files you want — arcade, poker, store, marketplace, garden, hero items (`hero-items.sql` → `hero-items-always-active.sql`; the cosmetic „Herosi" system itself is removed — also run `supabase/remove-heroes.sql` — surviving hero items are „Przedmioty specjalne"), casino games (`plinko`, `mines`, `roulette`, `crash`, `slots`), seasonal games (`whack-boss`, `bug-jumper`, `flappy-pants`, `snake`, `invoice-horde`, `var-patrol`, `egg-catch`, `super-mariusz` + `season-award-gating.sql`), `football.sql` (Mundial), `canvas.sql`, `documents.sql`, and the farm stack in the order above.
3. Run the stats views last: `hazard-views.sql`, `coin-inflow-stats.sql`, `economy-stats.sql`, `leaderboard-net-worth-items.sql`.
4. Deploy the Edge Functions in `supabase/functions/` (one per server-owned game: poker, roulette, crash, slots, plinko, mines, football, garden, and all eight seasonal `*-action` functions).
5. Run `supabase/prod-hardening.sql`.
6. Authentication → Providers → Email: disable email confirmation (PIN signups use synthetic emails).
7. Authentication → URL Configuration: set the site URL to the GitHub Pages URL.
8. Confirm the `pg_cron` jobs from the SQL files exist (weekly game awards, football odds sync, farm price rolls, farm rot cleanup, land-tax assessment).

Function secrets used by `football-action`: `ODDS_API_KEY`, `FOOTBALL_CRON_SECRET`, optional `ODDS_SPORT_KEY` / `ODDS_REGIONS` / `ODDS_BOOKMAKER`.

## How it works

- Auth: nick + 5-digit PIN (Supabase email/password under the hood). CAPTCHA is currently disabled by product decision; auth rate limits remain the brute-force control. Starting balance: 1000 coins.
- Markets: anyone can create prediction markets; CPMM pricing; one side per user per market; creator or admin resolves.
- Mundial: fixed-odds World Cup 2026 betting vs the house; odds come from The Odds API and are locked at bet time; one bet per match.
- Poker: one shared Hold'em table, 100 coin buy-in, server-owned state.
- Casino (house games): Plinko, Miny (5×5 mines), Ruletka (shared table), Rakieta (solo crash), and slots — all RNG and payouts are server-owned; the browser only animates trusted results.
- Seasonal games: one rotating arcade game per Monday-start week (Whack-a-Boss, Bug Jumper, „3 Pary Spodni", Snake, „Najazd Ticketów", VAR Patrol, „Łap Jajka", „Super Mariusz"); server-validated rounds with game-specific weekly prizes.
- Wspólne Płótno: shared 192×108 pixel canvas; one free pixel per 2 h, then 1 coin per pixel.
- Targowisko: peer-to-peer marketplace (fixed price or auction with escrow); coins transfer buyer → seller.
- Ogródek (Farma): shared 13×4 tile grid; buy tiles, open card lootboxes, plant, harvest, and sell crops at a fluctuating "stalk market" NPC price; serialized NFT cards with per-instance levels (merge two to level up); land tax on holdings above the fair share; P2P resale of cards/NFTs/tiles via Targowisko. Details in [docs/farma.md](docs/farma.md).
- Leaderboard: cash plus open bets, positions, escrow, and owned assets (net worth).

## Security note

PIN auth and virtual coins only. Keep Supabase auth rate limits hardened, revoke leaked tokens immediately, and do not use this for real money or sensitive data. If CAPTCHA is re-enabled, enable it in both the frontend and Supabase Auth together.
