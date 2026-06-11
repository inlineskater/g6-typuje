// Admin PIN-reset fallback for Rynek Proroctw G6.
//
// Resets one account (or every account) to a temporary 5-digit PIN using the
// Supabase Admin API. Use this for users who can't migrate themselves with the
// in-app "Ustaw nowy 5-cyfrowy PIN" form, or if an account gets locked out.
//
// SECURITY: needs the SERVICE-ROLE key (full admin). Never commit it, never put
// it in index.html. Pass it via env only.
//
// Setup:
//   npm i @supabase/supabase-js
//   # PowerShell:
//   $env:SUPABASE_URL = 'https://rjovhmepanwbdgdkvylr.supabase.co'
//   $env:SUPABASE_SERVICE_ROLE_KEY = '<service-role key from Supabase → Project Settings → API>'
//
// Usage:
//   node scripts/reset-pins.mjs <nick> <newPin>     # reset one account
//   node scripts/reset-pins.mjs --all <tempPin>     # reset EVERY @typuje.local account
//
// After running, tell the affected user(s) their temporary 5-digit PIN and have
// them change it via the in-app migration form (old PIN -> new PIN).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first.');
  process.exit(1);
}

const [arg1, arg2] = process.argv.slice(2);
if (!arg1 || !arg2) {
  console.error('Usage:\n  node scripts/reset-pins.mjs <nick> <newPin>\n  node scripts/reset-pins.mjs --all <tempPin>');
  process.exit(1);
}

// Same email derivation as index.html (doLogin/doRegister).
const nickToEmail = (nick) =>
  nick.toLowerCase().replace(/[^a-z0-9_.-]/g, '_') + '@typuje.local';

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function listAllUsers() {
  const users = [];
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 1000) break;
    page += 1;
  }
  return users;
}

async function resetByEmail(email, pin, allUsers) {
  const user = allUsers.find((u) => (u.email || '').toLowerCase() === email);
  if (!user) { console.warn(`  ! no account for ${email}`); return false; }
  const { error } = await admin.auth.admin.updateUserById(user.id, { password: 'pin-' + pin });
  if (error) { console.error(`  ! ${email}: ${error.message}`); return false; }
  console.log(`  ✓ ${email} -> PIN ${pin}`);
  return true;
}

const newPin = arg2;
if (!/^\d{5}$/.test(newPin)) {
  console.error('PIN must be exactly 5 digits.');
  process.exit(1);
}

const allUsers = await listAllUsers();

if (arg1 === '--all') {
  const targets = allUsers.filter((u) => (u.email || '').endsWith('@typuje.local'));
  console.log(`Resetting ${targets.length} account(s) to temp PIN ${newPin}…`);
  for (const u of targets) await resetByEmail((u.email || '').toLowerCase(), newPin, allUsers);
} else {
  const email = nickToEmail(arg1);
  console.log(`Resetting ${arg1} (${email})…`);
  await resetByEmail(email, newPin, allUsers);
}

console.log('Done.');
