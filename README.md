# Rynek Proroctw G6

Company prediction market with virtual coins.

Production URL after GitHub Pages deploy:

```text
https://inlineskater.github.io/g6-typuje/
```

## Deployment

The app is a static single-page site. Pushes to `main` deploy through `.github/workflows/pages.yml` using GitHub Pages Actions.

For a new GitHub repo, make sure Pages is enabled with GitHub Actions as the source in repository settings if GitHub does not enable it automatically on the first workflow run.

## Supabase

The frontend uses the public anon key in `index.html`. This is expected for Supabase browser apps; the production safety boundary is RLS plus limited function grants.

Fresh database setup:

1. Create a Supabase project.
2. In SQL Editor, run `supabase/schema.sql`.
3. Authentication -> Providers -> Email: disable email confirmation for PIN-based signups.
4. Authentication -> URL Configuration: set the site URL to the GitHub Pages URL above.

Existing database hardening: paste and run `supabase/prod-hardening.sql` in Supabase SQL Editor.

## How It Works

- Auth: nick + 4-digit PIN. First login creates the account.
- Starting balance: 1000 virtual coins.
- Markets: authenticated users can create prediction markets.
- Betting: CPMM pricing; users can only add to one side per market.
- Resolution: market creator or `admin` nick can resolve a market.
- Leaderboard: cash plus open position value.

## Security Note

This uses weak PIN auth and virtual coins only. Do not use it for real money or sensitive data.
