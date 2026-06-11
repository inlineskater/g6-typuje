# Auth hardening — manual setup

Background: a user brute-forced 4-digit PINs (including `admin`) with a browser
script hitting the auth endpoint directly. The code changes (5-digit PIN +
Turnstile widgets + migration form) are in `index.html`, but two controls are
**dashboard settings** and one optional step is SQL. Do these to actually close
the hole — a script that bypasses the page is only stopped by server-side checks.

## 1. Cloudflare Turnstile CAPTCHA (required for the captcha to do anything)

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

## 2. Lower the auth rate limits (defense-in-depth)

Supabase Dashboard → **Authentication → Rate Limits** → lower the sign-in /
token rate (e.g. ~10 per hour per IP). No code change.

## 3. Rotate the leaked access token

The `sbp_…` personal access token shared during this work should be revoked:
Supabase → **Account → Access Tokens** → revoke / regenerate.

## 4. (Optional) Decouple admin from the `admin` nick

Admin power currently keys off `nick = 'admin'` — a known, single-account target.
To make admin independent of any guessable login, switch to an explicit flag:

```sql
-- Run in Supabase SQL Editor.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

-- Promote the real admin account (replace with the actual nick):
UPDATE public.profiles SET is_admin = true WHERE nick = 'admin';

-- Make the server-side check read the flag instead of the nick:
CREATE OR REPLACE FUNCTION public.is_admin(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user AND is_admin);
$$;

NOTIFY pgrst, 'reload schema';
```

If you do this, also update the inline `nick = 'admin'` checks
(`garden-accessories.sql:55`, `second-garden-slot.sql:248,438`,
`functions/poker-action/index.ts:745`) and the client-side `me.nick === 'admin'`
reads in `index.html` to use the flag. Note this is **defense-in-depth** — with
the captcha in place the admin login is already protected.

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
