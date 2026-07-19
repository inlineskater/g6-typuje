// @ts-nocheck
// „Ogródek" watering gate. Anti-automation chokepoint for water_plant: a cron
// script could POST /rest/v1/rpc/water_plant directly with a stolen-from-console
// refresh token and farm the daily reward headless. The direct RPC is now REVOKEd
// (see supabase/garden-water-gate.sql); the ONLY watering path is this function.
//
//   arm   → issue a single-use, ~120s nonce to the live JWT-authenticated client.
//   water → consume the nonce (atomic, single-use) then run water_plant_core over
//           the service connection. Cooldown / daily-cap / streak rules unchanged.
//
// This breaks the current direct-RPC script. A determined scripter can replay
// arm→water; if that happens, tighten here (min nonce age, presence heartbeat,
// rate-limit) without touching the SQL.
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const ALLOWED_ORIGINS = new Set([
  "https://inlineskater.github.io",
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(req) {
  const origin = req?.headers?.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin) ? origin : "https://inlineskater.github.io",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const db = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 4, idle_timeout: 20 });

const NONCE_TTL_SECONDS = 120;    // how long an armed nonce stays valid
const PRESENCE_WINDOW_SECONDS = 90; // watering requires a heartbeat this recent
                                    // (client pings every ~30s — keep window ≥ 3×)

function gameError(message) {
  return Object.assign(new Error(message), { isGame: true });
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

async function requireUser(req) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) throw gameError("not_authenticated");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authClient = createClient(supabaseUrl!, anonKey!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) throw gameError("not_authenticated");
  return data.user;
}

function validateSlot(raw) {
  const slot = Math.trunc(Number(raw ?? 1));
  if (slot !== 1 && slot !== 2) throw gameError("bad_slot");
  return slot;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Issue a fresh single-use nonce. Drops this user's stale/used nonces and any
// prior un-used one so only one nonce is live at a time.
async function arm(userId) {
  const [row] = await db.begin(async (tx) => {
    await tx`delete from public.garden_water_nonces
             where user_id = ${userId} and (used_at is not null or expires_at < now())`;
    await tx`delete from public.garden_water_nonces
             where user_id = ${userId} and used_at is null`;
    return await tx`
      insert into public.garden_water_nonces (user_id, expires_at)
      values (${userId}, now() + (${NONCE_TTL_SECONDS} * interval '1 second'))
      returning nonce, expires_at`;
  });
  return { ok: true, nonce: row.nonce, ttlMs: NONCE_TTL_SECONDS * 1000 };
}

// Heartbeat: the live tab pings this every ~30s. Refreshes presence so watering
// is allowed. A headless cron never calls it, so it can never satisfy `water`.
async function ping(userId) {
  await db`
    insert into public.garden_presence (user_id, last_seen)
    values (${userId}, now())
    on conflict (user_id) do update set last_seen = now()`;
  return { ok: true };
}

// Consume the nonce and water — both in one transaction, so if watering fails
// (cooldown / daily cap / not present) the nonce consume rolls back and the nonce
// stays usable. Requires a recent heartbeat: the browser tab must be open & active.
async function water(userId, rawSlot, rawNonce) {
  const slot = validateSlot(rawSlot);
  const nonce = String(rawNonce ?? "");
  if (!UUID_RE.test(nonce)) throw gameError("stale_nonce");

  return await db.begin(async (tx) => {
    // Presence gate: a fresh heartbeat must exist. Note `water` does NOT refresh
    // it — only the independent background ping does — so a single bare call can't
    // self-certify as "present".
    const present = await tx`
      select 1 from public.garden_presence
       where user_id = ${userId}
         and last_seen > now() - (${PRESENCE_WINDOW_SECONDS} * interval '1 second')`;
    if (present.count !== 1) throw gameError("inactive");

    const consumed = await tx`
      update public.garden_water_nonces
         set used_at = now()
       where nonce = ${nonce}
         and user_id = ${userId}
         and used_at is null
         and expires_at > now()
      returning nonce`;
    if (consumed.count !== 1) throw gameError("stale_nonce");

    const [res] = await tx`select public.water_plant_core(${userId}, ${slot}) as result`;
    return { ok: true, ...(res.result ?? {}) };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "method_not_allowed" }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    let result;
    if (action === "ping") result = await ping(user.id);
    else if (action === "arm") result = await arm(user.id);
    else if (action === "water") result = await water(user.id, body.slot, body.nonce);
    else throw gameError("unknown_action");

    return json(req, result);
  } catch (err) {
    // water_plant_core RAISEs known codes (cooldown / daily_limit / no_garden);
    // surface them verbatim so the frontend's Polish map renders them.
    const code = err?.isGame ? err.message : (err?.message ?? "gate");
    const known = ["not_authenticated", "no_garden", "cooldown", "daily_limit", "bad_slot",
                   "stale_nonce", "inactive", "unknown_action"];
    const out = known.find((k) => String(code).includes(k)) ?? "gate";
    console.error("garden-action error:", code);
    return json(req, { ok: false, error: out });
  }
});
