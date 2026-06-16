# Rynek Proroctw G6

Company prediction market, shared Texas Hold'em table, and small office games with virtual coins.

Production URL after GitHub Pages deploy:

```text
https://inlineskater.github.io/rynek-proroctw-g6/
```

## Deployment

The app is a static single-page site. Pushes to `main` deploy through `.github/workflows/pages.yml` using GitHub Pages Actions.

For a new GitHub repo, make sure Pages is enabled with GitHub Actions as the source in repository settings if GitHub does not enable it automatically on the first workflow run.

## Supabase

The frontend uses the public anon key in `index.html`. This is expected for Supabase browser apps; the production safety boundary is RLS plus limited function grants.

Fresh database setup:

1. Create a Supabase project.
2. In SQL Editor, run `supabase/schema.sql`.
3. In SQL Editor, run `supabase/poker.sql`.
4. In SQL Editor, run the optional game/shop/garden/hero SQL files you need, including `supabase/store.sql` for the reward shop, `supabase/whack-boss.sql` for Whack-a-Boss, and `supabase/hero-items.sql` for equipable hero items. For the rotating seasonal games also run `supabase/bug-jumper.sql` (Bug Jumper), `supabase/flappy-pants.sql` („3 Pary Spodni"), and `supabase/snake.sql` (Snake). Run `supabase/coin-inflow-stats.sql` after the economy/game SQL files to enable the gross coin inflow card on the Statistics page.
5. Deploy the Edge Functions in `supabase/functions/poker-action`, `supabase/functions/whack-boss-action`, `supabase/functions/bug-jumper-action`, `supabase/functions/flappy-pants-action`, and `supabase/functions/snake-action`.
6. Authentication -> Providers -> Email: disable email confirmation for PIN-based signups.
7. Authentication -> URL Configuration: set the site URL to the GitHub Pages URL above.

Existing database hardening: paste and run `supabase/prod-hardening.sql` in Supabase SQL Editor. Then re-run the installed ranking view SQL (`supabase/hazard-views.sql` and, if hero items are installed, `supabase/leaderboard-net-worth-items.sql`) so admin/test accounts can be filtered via `is_admin`. After the Whack-a-Boss / 3 Pary Spodni server-validation changes, also re-run `supabase/whack-boss.sql` and `supabase/flappy-pants.sql` before deploying the updated Edge Functions.

Existing project poker rollout:

1. Paste and run `supabase/poker.sql` in Supabase SQL Editor.
2. Deploy `supabase/functions/poker-action` with Supabase CLI or from the Supabase dashboard.

Existing project Whack-a-Boss rollout:

1. Paste and run `supabase/whack-boss.sql` in Supabase SQL Editor.
2. Deploy `supabase/functions/whack-boss-action` with Supabase CLI or from the Supabase dashboard.
3. Confirm the `pg_cron` schedule exists if weekly prizes should pay automatically after the week closes.

Existing project seasonal games rollout (Bug Jumper, „3 Pary Spodni", Snake):

1. Paste and run `supabase/bug-jumper.sql`, `supabase/flappy-pants.sql`, and `supabase/snake.sql` in Supabase SQL Editor.
2. Deploy `supabase/functions/bug-jumper-action`, `supabase/functions/flappy-pants-action`, and `supabase/functions/snake-action` with Supabase CLI or from the Supabase dashboard.
3. Confirm each game's `pg_cron` weekly-award job exists (`bug_jumper_weekly_awards`, `flappy_pants_weekly_awards`, `snake_weekly_awards`) so the weekly top 3 are paid automatically.

Existing project Bug Jumper hard-course rollout:

1. Paste and run `supabase/bug-jumper-hard-v2.sql` in Supabase SQL Editor.
2. Deploy the updated `supabase/functions/bug-jumper-action`.
3. Publish the updated `index.html` so the June 8, 2026 season override and fixed hard course are live together.

## How It Works

- Auth: nick + 5-digit PIN, with a forced migration path for legacy 4-digit PIN accounts.
- Starting balance: 1000 virtual coins.
- Markets: authenticated users can create prediction markets.
- Betting: CPMM pricing; users can only add to one side per market.
- Resolution: market creator or an `is_admin` profile can resolve a market.
- Poker: authenticated users can sit at one shared Texas Hold'em table for a 100 coin buy-in.
- Whack-a-Boss: authenticated users play 18-second rounds; weekly top 3 receive 100/50/25 coins and all-time records stay visible.
- Seasonal games: one rotating arcade game per week in the seasonal tab (Whack-a-Boss, Bug Jumper, „3 Pary Spodni" — a Flappy Bird clone with 3 lives, and Snake). Bug Jumper's hard-course season uses the same fixed 10-column, 30-line course for everyone, with safe rest lines at 10, 20, and 30. Snake's June 15, 2026 season was prompted by Filip with `do snake, make no mistakes`. Each pays the weekly top 3 100/50/25 coins.
- Leaderboard: cash plus open position value.

## Security Note

This uses PIN auth and virtual coins only. Keep Supabase CAPTCHA/rate limits enabled, revoke leaked personal access tokens immediately, enable leaked-password protection after moving to a Supabase Pro plan, and do not use it for real money or sensitive data.
