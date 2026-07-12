// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const ALLOWED_ORIGINS = new Set([
  "https://inlineskater.github.io",
  "http://127.0.0.1:8000",
  "http://localhost:8000",
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch (_) {
    return false;
  }
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

const STAKES = [1, 5, 10, 25, 50, 100, 250, 500]; // preset chips; any integer 1..MAX_BET is allowed
const MAX_BET = 10_000_000;                  // ceiling for a custom stake (balance enforced separately)
const DEFAULT_BET = 10;
const DEFAULT_RISK = "medium";

// Keep byte-for-byte in sync with index.html (WHEEL_SEGMENTS) — this is the
// parity contract: the ordered multiplier array per risk tier IS the wheel.
// Segment count is fixed at 20 per tier. RTP before flooring/luck:
//   low    -> 96.0%  (16x 1.2, 4x 0)
//   medium -> 95.0%  (11x 0, 4x 1.5, 2x 2, 3x 3)
//   high   -> 95.0%  (16x 0, 2x 2, 1x 5, 1x 10)
const SEGMENTS = {
  low:    [0, 1.2, 1.2, 1.2, 1.2, 0, 1.2, 1.2, 1.2, 1.2, 0, 1.2, 1.2, 1.2, 1.2, 0, 1.2, 1.2, 1.2, 1.2],
  medium: [0, 1.5, 0, 2, 0, 0, 3, 0, 1.5, 0, 3, 0, 0, 2, 0, 1.5, 0, 3, 0, 1.5],
  high:   [10, 0, 0, 0, 0, 2, 0, 0, 0, 0, 5, 0, 0, 0, 0, 2, 0, 0, 0, 0],
};
const SEGMENT_COUNT = 20;

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
  if (!authHeader.startsWith("Bearer ")) throw gameError("Musisz być zalogowany.");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authClient = createClient(supabaseUrl!, anonKey!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) throw gameError("Sesja wygasła.");
  return data.user;
}

function validateBet(raw) {
  const bet = Math.trunc(Number(raw ?? DEFAULT_BET));
  if (!Number.isInteger(bet) || bet < 1 || bet > MAX_BET) throw gameError("Nieprawidłowa stawka.");
  return bet;
}

function validateRisk(raw) {
  const risk = String(raw ?? DEFAULT_RISK);
  if (!SEGMENTS[risk]) throw gameError("Nieprawidłowe ryzyko.");
  return risk;
}

// Timed COMMUNAL „Amulet Bezwstydnego Fartu" (casino-luck-item.sql): while ANY unexpired
// instance exists (any owner — the buyer pays for everyone), every payout is
// ×CASINO_LUCK_MULT. The lowest tier RTP is 95%, so 1.01 lands it at 95.95%,
// still below 100% — never raise this without recomputing every tier's RTP.
const CASINO_LUCK_MULT = 1.01;

async function hasCasinoLuck(tx) {
  try {
    const rows = await tx`
      select 1
      from public.hero_item_instances i
      join public.hero_item_defs d on d.id = i.item_def_id
      where d.is_active = true
        and d.effect_game = 'casino'
        and d.effect_type = 'casino_luck'
        and i.expires_at is not null
        and i.expires_at > now()
      limit 1
    `;
    return rows.length > 0;
  } catch (err) {
    console.warn("Casino luck lookup unavailable:", err?.message ?? err);
    return false;
  }
}

function randomByte() {
  const buf = new Uint8Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

// Uniform 0..19 via rejection sampling (avoids modulo bias).
function randomSegmentIndex() {
  const limit = 256 - (256 % SEGMENT_COUNT); // 240
  let b = randomByte();
  while (b >= limit) b = randomByte();
  return b % SEGMENT_COUNT;
}

function spinOut(row) {
  if (!row) return null;
  return {
    id: row.id,
    bet: Number(row.total_bet),
    risk: row.risk,
    segmentIndex: Number(row.segment_index),
    multiplier: Number(row.multiplier || 0),
    totalWon: Number(row.total_won || 0),
    createdAt: row.created_at,
  };
}

async function historyRows(tx, userId, limit = 12) {
  const rows = await tx`
    select id, total_bet, risk, segment_index, multiplier, total_won, created_at
    from public.wheel_spins
    where user_id = ${userId}
    order by created_at desc
    limit ${limit}`;
  return rows.map(spinOut);
}

async function stateResponse(tx, userId, extra = {}) {
  const [profile] = await tx`select coins, nick from public.profiles where id = ${userId}`;
  const luck = await hasCasinoLuck(tx);
  return {
    coins: profile?.coins ?? 0,
    nick: profile?.nick ?? "",
    stakes: STAKES,
    risks: ["low", "medium", "high"],
    segments: SEGMENTS,
    casinoLuck: luck,
    history: await historyRows(tx, userId),
    ...extra,
  };
}

async function spin(userId, rawBet, rawRisk) {
  const bet = validateBet(rawBet);
  const risk = validateRisk(rawRisk);

  return await db.begin(async (tx) => {
    const [profile] = await tx`select coins from public.profiles where id = ${userId} for update`;
    if (!profile) throw gameError("Profil nie istnieje.");
    if (profile.coins < bet) throw gameError("Za mało coinów!");

    const luck = await hasCasinoLuck(tx);
    const segmentIndex = randomSegmentIndex();
    const multiplier = SEGMENTS[risk][segmentIndex];
    const totalWon = Math.floor(bet * multiplier * (luck ? CASINO_LUCK_MULT : 1));
    const balance = Number(profile.coins || 0) - bet + totalWon;

    const [row] = await tx`
      insert into public.wheel_spins (user_id, total_bet, risk, segment_index, multiplier, total_won)
      values (${userId}, ${bet}, ${risk}, ${segmentIndex}, ${multiplier}, ${totalWon})
      returning id, total_bet, risk, segment_index, multiplier, total_won, created_at`;

    await tx`update public.profiles set coins = ${balance} where id = ${userId}`;

    return await stateResponse(tx, userId, {
      spin: spinOut(row),
      coins: balance,
      casinoLuck: luck,
    });
  });
}

async function getState(userId) {
  return await db.begin((tx) => stateResponse(tx, userId));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "state");

    let result;
    if (action === "state" || action === "history") result = await getState(user.id);
    else if (action === "spin") result = await spin(user.id, body.bet, body.risk);
    else throw gameError("Nieznana akcja.");

    return json(req, { ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json(req, { ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
