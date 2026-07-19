// @ts-nocheck
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

const STAKES = [1, 5, 10, 25, 50, 100, 250, 500]; // preset chips; any integer 1..MAX_BET is allowed
const MAX_BET = 10_000_000;                  // ceiling for a custom stake (balance enforced separately)
const DEFAULT_BET = 10;
const DEFAULT_ROWS = 12;
const DEFAULT_RISK = "medium";
const MAX_BATCH_DROPS = 100;

// Keep in sync with index.html (PLINKO_PAYOUTS). Expected returns sit around
// 95-98% before integer payout flooring, depending on row/risk selection.
const PAYOUTS = {
  8: {
    low:    [5.2, 2, 1.1, 1, 0.5, 1, 1.1, 2, 5.2],
    medium: [12, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 12],
    high:   [28, 4, 1.4, 0.3, 0.2, 0.3, 1.4, 4, 28],
  },
  12: {
    low:    [7, 3, 1.6, 1.4, 1.2, 0.8, 0.6, 0.8, 1.2, 1.4, 1.6, 3, 7],
    medium: [34, 11, 4, 1.8, 1, 0.6, 0.4, 0.6, 1, 1.8, 4, 11, 34],
    high:   [150, 24, 8, 2, 0.7, 0.2, 0.1, 0.2, 0.7, 2, 8, 24, 150],
  },
  16: {
    low:    [16, 9, 4.4, 2.4, 1.8, 1.2, 1, 0.8, 0.6, 0.8, 1, 1.2, 1.8, 2.4, 4.4, 9, 16],
    medium: [120, 40, 16, 7, 3, 1.4, 0.8, 0.45, 0.25, 0.45, 0.8, 1.4, 3, 7, 16, 40, 120],
    high:   [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  },
};

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

// Timed COMMUNAL „Amulet Fortuny" (casino-luck-item.sql): while ANY unexpired
// instance exists (any owner — the buyer pays for everyone), every payout is
// ×CASINO_LUCK_MULT. The richest config (8 rows / medium) is already 98.13%
// RTP, so 1.01 lands it at 99.1% — never raise this without recomputing every
// config's RTP.
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

function validateRows(raw) {
  const rows = Math.trunc(Number(raw ?? DEFAULT_ROWS));
  if (!PAYOUTS[rows]) throw gameError("Nieprawidłowa liczba rzędów.");
  return rows;
}

function validateRisk(raw) {
  const risk = String(raw ?? DEFAULT_RISK);
  if (!["low", "medium", "high"].includes(risk)) throw gameError("Nieprawidłowe ryzyko.");
  return risk;
}

function validateCount(raw) {
  const count = Math.trunc(Number(raw ?? 1));
  if (!Number.isFinite(count) || count < 1 || count > MAX_BATCH_DROPS) {
    throw gameError(`Możesz wrzucić naraz od 1 do ${MAX_BATCH_DROPS} znaczników.`);
  }
  return count;
}

function randomBit() {
  const buf = new Uint8Array(1);
  crypto.getRandomValues(buf);
  return buf[0] & 1;
}

function generatePath(rows) {
  const path = [];
  let bucket = 0;
  for (let i = 0; i < rows; i += 1) {
    const step = randomBit();
    path.push(step);
    bucket += step;
  }
  return { path, bucket };
}

function spinOut(row) {
  if (!row) return null;
  return {
    id: row.id,
    bet: Number(row.bet),
    rows: Number(row.rows),
    risk: row.risk,
    path: Array.isArray(row.path) ? row.path : JSON.parse(row.path || "[]"),
    bucket: Number(row.bucket),
    multiplier: Number(row.multiplier || 0),
    totalWon: Number(row.total_won || 0),
    createdAt: row.created_at,
  };
}

async function historyRows(tx, userId, limit = 12) {
  const rows = await tx`
    select id, bet, rows, risk, path, bucket, multiplier, total_won, created_at
    from public.plinko_spins
    where user_id = ${userId}
    order by created_at desc
    limit ${limit}`;
  return rows.map(spinOut);
}

async function stateResponse(tx, userId, extra = {}) {
  const [profile] = await tx`select coins, nick from public.profiles where id = ${userId}`;
  return {
    coins: profile?.coins ?? 0,
    nick: profile?.nick ?? "",
    stakes: STAKES,
    rowsOptions: Object.keys(PAYOUTS).map(Number),
    risks: ["low", "medium", "high"],
    payouts: PAYOUTS,
    history: await historyRows(tx, userId),
    ...extra,
  };
}

async function dropBatch(userId, rawBet, rawRows, rawRisk, rawCount = 1) {
  const bet = validateBet(rawBet);
  const rows = validateRows(rawRows);
  const risk = validateRisk(rawRisk);
  const count = validateCount(rawCount);

  return await db.begin(async (tx) => {
    const [profile] = await tx`select coins from public.profiles where id = ${userId} for update`;
    if (!profile) throw gameError("Profil nie istnieje.");
    if (profile.coins < bet) throw gameError("Za mało coinów!");

    const luck = await hasCasinoLuck(tx);
    let balance = Number(profile.coins || 0);
    const spins = [];

    for (let i = 0; i < count; i += 1) {
      if (balance < bet) break;

      const { path, bucket } = generatePath(rows);
      const multiplier = PAYOUTS[rows][risk][bucket];
      const totalWon = Math.floor(bet * multiplier * (luck ? CASINO_LUCK_MULT : 1));
      balance = balance - bet + totalWon;

      const [spin] = await tx`
        insert into public.plinko_spins (user_id, bet, rows, risk, path, bucket, multiplier, total_won)
        values (${userId}, ${bet}, ${rows}, ${risk}, ${JSON.stringify(path)}, ${bucket}, ${multiplier}, ${totalWon})
        returning id, bet, rows, risk, path, bucket, multiplier, total_won, created_at`;
      spins.push(spinOut(spin));
    }

    await tx`update public.profiles set coins = ${balance} where id = ${userId}`;

    const skipped = count - spins.length;
    return await stateResponse(tx, userId, {
      drop: spins[spins.length - 1] ?? null,
      drops: spins,
      casinoLuck: luck,
      skipped,
      warning: skipped > 0 ? `Zabrakło coinów na ${skipped} dropów.` : "",
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
    else if (action === "drop") result = await dropBatch(user.id, body.bet, body.rows, body.risk, 1);
    else if (action === "drop_batch" || action === "dropBatch") result = await dropBatch(user.id, body.bet, body.rows, body.risk, body.count);
    else throw gameError("Nieznana akcja.");

    return json(req, { ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json(req, { ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
