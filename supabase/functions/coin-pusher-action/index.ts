// @ts-nocheck
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import {
  COIN_PUSHER_BASE_DURATION_MS,
  COIN_PUSHER_BET,
  COIN_PUSHER_LANES,
  COIN_PUSHER_PHYSICS_VERSION,
  COIN_PUSHER_PUSHER_CYCLE_MS,
  coinPusherConservation,
  simulateCoinPusherDrop,
} from "../_shared/coin-pusher-physics.mjs";
import {
  COIN_PUSHER_QUEUE_LIMIT,
  coinPusherQueueAdmission,
  coinPusherScheduleStartMs,
} from "../_shared/coin-pusher-queue.mjs";

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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) throw gameError("Sesja wygasła.");
  return data.user;
}

function validateLane(raw) {
  const lane = Math.trunc(Number(raw));
  if (!Number.isInteger(lane) || lane < 0 || lane >= COIN_PUSHER_LANES) {
    throw gameError("Wybierz jeden z pięciu wrzutów.");
  }
  return lane;
}

function validateRequestId(raw) {
  const requestId = String(raw || "");
  if (!UUID_RE.test(requestId)) throw gameError("Nieprawidłowy identyfikator wrzutu.");
  return requestId;
}

function spinOut(row, options = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    requestId: row.request_id,
    userId: row.user_id,
    nick: row.nick_snapshot,
    lane: Number(row.lane),
    bet: Number(row.bet),
    physicsVersion: Number(row.physics_version || 0),
    startedAt: row.started_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
  };
  if (options.includeOutcome !== false) {
    out.coinsWon = Number(row.coins_won || 0);
    out.sideLost = Number(row.side_lost || 0);
    out.maintenanceAdded = Number(row.maintenance_added || 0);
    out.totalWon = Number(row.total_won || 0);
  }
  if (options.includeReplay) out.replay = row.replay;
  if (Number.isInteger(options.position)) out.queuePosition = options.position;
  if (options.userId) out.isMine = row.user_id === options.userId;
  return out;
}

async function stateResponse(tx, userId, extra = {}) {
  const [profile] = await tx`select coins, nick from public.profiles where id = ${userId}`;
  const [machine] = await tx`
    select id, state, revision, physics_version, busy_until, updated_at
    from public.coin_pusher_machine where id = 'main'`;
  const scheduled = await tx`
    select * from public.coin_pusher_spins
    where ends_at > now()
    order by started_at asc, created_at asc
    limit ${COIN_PUSHER_QUEUE_LIMIT}`;
  const recent = await tx`
    select id, request_id, user_id, nick_snapshot, lane, bet, coins_won,
           side_lost, maintenance_added, total_won, physics_version,
           started_at, ends_at, created_at
    from public.coin_pusher_spins
    where ends_at <= now()
    order by ends_at desc
    limit 12`;
  const active = scheduled[0] || null;
  const machineState = scheduled.length ? null : machine?.state;
  return {
    serverNow: new Date().toISOString(),
    coins: Number(profile?.coins || 0),
    nick: profile?.nick || "",
    fixedBet: COIN_PUSHER_BET,
    laneCount: COIN_PUSHER_LANES,
    baseDurationMs: COIN_PUSHER_BASE_DURATION_MS,
    queueLimit: COIN_PUSHER_QUEUE_LIMIT,
    machine: machine ? {
      revision: Number(machine.revision || 0),
      physicsVersion: Number(machine.physics_version || 0),
      state: machineState,
      stockCount: Array.isArray(machine.state?.coins) ? machine.state.coins.length : 0,
      busyUntil: machine.busy_until,
      updatedAt: machine.updated_at,
    } : null,
    activeDrop: spinOut(active, { includeReplay: true, position: active ? 1 : undefined, userId }),
    queue: scheduled.map((row, index) => spinOut(row, { includeOutcome: index === 0, position: index + 1, userId })),
    recentDrops: recent.map((row) => spinOut(row, { userId })),
    ...extra,
  };
}

async function getState(userId) {
  return await db.begin((tx) => stateResponse(tx, userId));
}

function randomSeed() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return Number(values[0]);
}

async function findQueuePosition(tx, spinId) {
  const rows = await tx`
    select id from public.coin_pusher_spins
    where ends_at > now()
    order by started_at asc, created_at asc
    limit ${COIN_PUSHER_QUEUE_LIMIT}`;
  const index = rows.findIndex((row) => row.id === spinId);
  return index >= 0 ? index + 1 : null;
}

async function responseForExisting(tx, userId, existing) {
  const position = await findQueuePosition(tx, existing.id);
  return await stateResponse(tx, userId, {
    drop: spinOut(existing, { includeReplay: position === 1 || position == null, includeOutcome: position === 1 || position == null, position: position ?? undefined, userId }),
    replayed: true,
  });
}

async function drop(userId, rawLane, rawRequestId) {
  const lane = validateLane(rawLane);
  const requestId = validateRequestId(rawRequestId);

  return await db.begin(async (tx) => {
    const [existing] = await tx`
      select * from public.coin_pusher_spins
      where user_id = ${userId} and request_id = ${requestId}
      limit 1`;
    if (existing) return await responseForExisting(tx, userId, existing);

    const [machine] = await tx`
      select id, state, revision, physics_version, busy_until
      from public.coin_pusher_machine
      where id = 'main'
      for update`;
    if (!machine) throw new Error("Coin Pusher machine row is missing.");

    const [existingAfterLock] = await tx`
      select * from public.coin_pusher_spins
      where user_id = ${userId} and request_id = ${requestId}
      limit 1`;
    if (existingAfterLock) return await responseForExisting(tx, userId, existingAfterLock);

    const scheduled = await tx`
      select id, user_id, started_at, ends_at
      from public.coin_pusher_spins
      where ends_at > now()
      order by started_at asc, created_at asc
      for update`;
    const admission = coinPusherQueueAdmission(scheduled, userId);
    if (admission.reason === "full") {
      throw gameError("Kolejka jest pełna. Poczekaj na wolne miejsce.");
    }
    if (admission.reason === "already_queued") {
      throw gameError("Masz już monetę w maszynie lub kolejce.");
    }

    const [profile] = await tx`
      select coins, nick from public.profiles where id = ${userId} for update`;
    if (!profile) throw gameError("Profil nie istnieje.");
    if (Number(profile.coins || 0) < COIN_PUSHER_BET) throw gameError("Potrzebujesz 100 coinów.");

    const nowMs = Date.now();
    const tailMs = machine.busy_until ? new Date(machine.busy_until).getTime() : 0;
    const startedAtMs = coinPusherScheduleStartMs({ nowMs, busyUntilMs: tailMs });
    const startedAt = new Date(startedAtMs);
    const phaseMs = startedAtMs % COIN_PUSHER_PUSHER_CYCLE_MS;
    const seed = randomSeed();
    const result = simulateCoinPusherDrop({
      state: machine.state,
      lane,
      seed,
      revision: Number(machine.revision || 0),
      phaseMs,
    });
    if (coinPusherConservation(result.beforeCount, result) !== 0) {
      throw new Error("Coin pusher conservation check failed.");
    }

    const endsAt = new Date(startedAtMs + Number(result.replay.durationMs || COIN_PUSHER_BASE_DURATION_MS));
    const totalWon = result.coinsWon * COIN_PUSHER_BET;
    const nextBalance = Number(profile.coins) - COIN_PUSHER_BET + totalWon;
    await tx`update public.profiles set coins = ${nextBalance} where id = ${userId}`;

    const [spin] = await tx`
      insert into public.coin_pusher_spins (
        request_id, user_id, nick_snapshot, lane, bet, coins_won, side_lost,
        maintenance_added, total_won, seed, phase_ms, physics_version, replay,
        started_at, ends_at
      ) values (
        ${requestId}, ${userId}, ${profile.nick || "Gracz"}, ${lane}, ${COIN_PUSHER_BET},
        ${result.coinsWon}, ${result.sideLost}, ${result.maintenanceAdded}, ${totalWon},
        ${seed}, ${phaseMs}, ${COIN_PUSHER_PHYSICS_VERSION}, ${tx.json(result.replay)},
        ${startedAt.toISOString()}, ${endsAt.toISOString()}
      )
      returning *`;

    await tx`
      update public.coin_pusher_machine
      set state = ${tx.json(result.state)},
          revision = revision + 1,
          physics_version = ${COIN_PUSHER_PHYSICS_VERSION},
          busy_until = ${endsAt.toISOString()},
          updated_at = now()
      where id = 'main'`;

    const queuePosition = admission.position;
    return await stateResponse(tx, userId, {
      drop: spinOut(spin, { includeReplay: queuePosition === 1, includeOutcome: queuePosition === 1, position: queuePosition, userId }),
      replayed: false,
    });
  });
}

async function broadcastChanged() {
  try {
    await db`select realtime.send('{}'::jsonb, 'changed', 'coin-pusher', false)`;
  } catch (error) {
    console.warn("Coin Pusher broadcast unavailable; polling remains active.", error?.message || error);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "state");
    let result;
    if (action === "state") result = await getState(user.id);
    else if (action === "drop") {
      result = await drop(user.id, body.lane, body.requestId);
      await broadcastChanged();
    } else throw gameError("Nieznana akcja.");
    return json(req, { ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json(req, { ok: false, error: err?.isGame ? err.message : "Błąd serwera Coin Pusher." });
  }
});
