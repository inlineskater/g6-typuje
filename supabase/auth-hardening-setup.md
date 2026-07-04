# Auth hardening

Background: a user brute-forced 4-digit PINs (including `admin`) with a browser
script hitting the auth endpoint directly. The code changes (5-digit PIN +
Turnstile widgets + migration form) are in `index.html`. A script that bypasses
the page is only stopped by server-side checks, so Supabase Auth settings matter.

Production status after the June 14, 2026 hardening pass:

- Turnstile CAPTCHA is enabled in Supabase Auth, and `index.html` has a real
  Turnstile site key.
- Auth URL configuration points at `https://inlineskater.github.io/rynek-proroctw-g6/`.
- Auth rate limits for anonymous users, token requests, verify, and OTP are set
  to `10`.
- Password minimum length is `9`, matching `pin-` plus a 5-digit PIN.
- Leaked-password protection is still disabled because Supabase rejected that
  setting on the current plan; it requires Pro or higher.

**2026-07-03 update: CAPTCHA disabled per product decision.** `index.html`
hardcodes `CAPTCHA_ON = false` (see the constant's comment) — the Turnstile
widget no longer renders and no token is sent on login/register/migrate.
**Supabase Dashboard → Authentication → Attack Protection / Bot and Abuse
Protection → CAPTCHA protection must also be turned off**, or every login
(including production) will fail, since the server enforces the captcha
independently of the frontend flag. The rate limits and 5-digit PIN length
above are unaffected and still stand as the remaining anti-brute-force
controls. Re-enabling captcha later requires reversing both sides together.

## 1. Cloudflare Turnstile CAPTCHA

1. Cloudflare dashboard → **Turnstile** → add a widget for the site domain
   (`inlineskater.github.io`). Copy the **Site key** and **Secret key**.
2. In `index.html`, set `TURNSTILE_SITE_KEY` (near the top of the `<script>`
   block) to the **site key**. Until this is set, the captcha is skipped.
3. Supabase Dashboard → **Authentication → Attack Protection / Bot and Abuse
   Protection** → enable **CAPTCHA protection**, provider **Turnstile**, paste
   the **Secret key**, save.

After this, Supabase rejects any `signInWithPassword` / `signUp` that arrives
without a valid captcha token — including a bypass script that calls the auth
API directly. This is the control that actually stops the brute force.

## 2. Auth rate limits

Supabase Dashboard → **Authentication → Rate Limits** should show the hardened
limits above. If a future reset raises them, lower the sign-in/token/verify/OTP
limits again.

Leaked-password protection should be enabled after upgrading the Supabase
project to Pro or higher.

## 3. Rotate the leaked access token

The `sbp_…` personal access token shared during this work is compromised and
must not be used again:
Supabase → **Account → Access Tokens** → revoke / regenerate.

## 4. Apply database hardening SQL

Run `supabase/prod-hardening.sql`. It adds `profiles.is_admin`, preserves the
current `admin` account only if no admin flag exists yet, and makes
`public.is_admin()` read the flag instead of the nick.

If you need to promote a different account manually:

```sql
UPDATE public.profiles SET is_admin = true WHERE nick = '<real admin nick>';
NOTIFY pgrst, 'reload schema';
```

Also re-run `supabase/hazard-views.sql` and the installed leaderboard view SQL
(usually `supabase/leaderboard-net-worth-items.sql`), then re-run
`supabase/whack-boss.sql` and `supabase/flappy-pants.sql`. Deploy
`whack-boss-action` and `flappy-pants-action` after those SQL changes so only
server-validated seasonal scores are competitive.

## Migrating existing users to 5-digit PINs

This is **forced automatically** — no coordination needed:

- 5-digit accounts are tagged with a `pin5: true` flag in Supabase **user
  metadata** (set on registration, migration, and the forced change). Legacy
  4-digit accounts lack it.
- When a legacy user logs in with their old 4-digit PIN (the login field still
  accepts it), or when a restored session lacks `pin5`, they're routed to a
  mandatory **"Ustaw nowy 5-cyfrowy PIN"** screen and cannot reach the app until
  they set one. This survives page reloads (the flag lives server-side in
  metadata).
- A voluntary self-service form is also available via the **"Masz stary
  4-cyfrowy PIN?"** link on the login screen (old PIN + new 5-digit PIN).
- For lockouts, use `scripts/reset-pins.mjs` (needs the service-role key in an
  env var) to set a temporary 5-digit PIN; that account then logs in and is
  forced to pick its own.
- Once everyone has `pin5`, you can optionally remove the forced-PIN /
  migration UI from `index.html` and delete `scripts/reset-pins.mjs`.

Note: every existing account (including `admin`) will hit the forced screen on
its next login, since none have the `pin5` flag yet. That's intended.
