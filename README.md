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
4. In SQL Editor, run the optional game/shop/garden SQL files you need, including `supabase/whack-boss.sql` for Whack-a-Boss.
5. Deploy the Edge Functions in `supabase/functions/poker-action` and `supabase/functions/whack-boss-action`.
6. Authentication -> Providers -> Email: disable email confirmation for PIN-based signups.
7. Authentication -> URL Configuration: set the site URL to the GitHub Pages URL above.

Existing database hardening: paste and run `supabase/prod-hardening.sql` in Supabase SQL Editor.

Existing project poker rollout:

1. Paste and run `supabase/poker.sql` in Supabase SQL Editor.
2. Deploy `supabase/functions/poker-action` with Supabase CLI or from the Supabase dashboard.

Existing project Whack-a-Boss rollout:

1. Paste and run `supabase/whack-boss.sql` in Supabase SQL Editor.
2. Deploy `supabase/functions/whack-boss-action` with Supabase CLI or from the Supabase dashboard.
3. Confirm the `pg_cron` schedule exists if weekly prizes should pay automatically every Monday.

## How It Works

- Auth: nick + 4-digit PIN. First login creates the account.
- Starting balance: 1000 virtual coins.
- Markets: authenticated users can create prediction markets.
- Betting: CPMM pricing; users can only add to one side per market.
- Resolution: market creator or `admin` nick can resolve a market.
- Poker: authenticated users can sit at one shared Texas Hold'em table for a 100 coin buy-in.
- Whack-a-Boss: authenticated users play 18-second rounds; weekly top 3 receive 100/50/25 coins and all-time records stay visible.
- Leaderboard: cash plus open position value.

## Security Note

This uses weak PIN auth and virtual coins only. Do not use it for real money or sensitive data.
