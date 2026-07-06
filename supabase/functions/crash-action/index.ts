// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

// „Rakieta" (Crash) — SOLO house game. Each player flies their OWN rocket: the multiplier
// climbs from x1.00 and the player taps CASH OUT to lock it before a hidden, server-owned
// crash point. One round per player; no shared table, no realtime. The browser only ever
// animates a trusted server result — it never sees the crash point until the round resolves.

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://inlineskater.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const db = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 10, idle_timeout: 20 });

// ── Tunables ──────────────────────────────────────────────────────────────────
const HOUSE_EDGE = 0.05;        // 5% — instant-bust probability == the edge
const MAX_MULT = 1000;          // hard cap on crash point
// Forgive network latency: honor an in-time tap that ARRIVES this late. This is ALSO the
// bust-reveal delay: resolveDueRound() keeps a crashed round nominally 'running' (crash still
// hidden) until the grace has fully closed, so a routine 250 ms state poll can never race a
// legitimately-tapped cash_out to the row lock and void the forgiveness it deserved.
const CASHOUT_GRACE_MS = 450;
// The client's flight clock may run a hair AHEAD of the server clock (its rtt/2 anchor comp
// overshoots by ~half the auth/db processing time). When the rocket is still flying, trust the
// tapped button value up to this much display lead; mirrors the clamp in index.html.
const CLIENT_AHEAD_TOL_MS = 250;
const CRASH_STAKES = [1, 5, 10, 25, 50, 100, 250, 500]; // preset chips; any integer 1..MAX_BET is allowed
const MAX_BET = 10_000_000;     // ceiling for a custom stake (balance is still enforced separately)
// PARITY CONTRACT: CRASH_GROWTH must equal the constant of the same name in
// index.html. Multiplier m(t) = exp(CRASH_GROWTH · elapsedMs); doubles every 10 s.
const CRASH_GROWTH = Math.log(2) / 10000;

function multAt(ms) { return Math.exp(CRASH_GROWTH * Math.max(0, ms)); }
function durationFor(cp) { return Math.log(cp) / CRASH_GROWTH; } // ms; 0 for cp=1.00
function floor2(x) { return Math.floor(x * 100) / 100; }

function randFloat() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 4294967296; // [0,1)
}

// Server-only, hidden. Provably-fair-style heavy tail with a house edge.
function genCrashPoint() {
  const u = randFloat();
  if (u < HOUSE_EDGE) return 1.00; // instant bust
  let cp = Math.floor(((1 - HOUSE_EDGE) / (1 - u)) * 100) / 100;
  if (cp < 1.01) cp = 1.01;
  if (cp > MAX_MULT) cp = MAX_MULT;
  return cp;
}

function gameError(msg) { return Object.assign(new Error(msg), { isGame: true }); }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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
  const bet = Math.floor(Number(raw));
  if (!Number.isFinite(bet) || bet < 1) throw gameError("Nieprawidłowa stawka.");
  if (bet > MAX_BET) throw gameError("Stawka zbyt wysoka.");
  return bet;
}

function historyOut(row) {
  return {
    id: row.id,
    roundId: row.round_id,
    totalBet: Number(row.total_bet),
    cashoutMultiplier: row.cashout_multiplier != null ? Number(row.cashout_multiplier) : null,
    totalWon: Number(row.total_won || 0),
    crashPoint: Number(row.crash_point),
    createdAt: row.created_at,
  };
}

// Build the full player snapshot the client renders. `extra` carries the per-action
// outcome (started / cashedOut / busted / notice) that drives the one-shot animations.
async function stateResponse(tx, userId, extra = {}) {
  const [profile] = await tx`select coins, nick from public.profiles where id = ${userId}`;
  const [active] = await tx`
    select id, bet, status, extract(epoch from (now() - started_at)) * 1000 as elapsed_ms
    from public.crash_rounds
    where user_id = ${userId} and status = 'running'
    order by started_at desc
    limit 1`;
  const history = await tx`
    select id, round_id, total_bet, cashout_multiplier, total_won, crash_point, created_at
    from public.crash_spins
    where user_id = ${userId}
    order by created_at desc
    limit 12`;
  return {
    coins: profile?.coins ?? 0,
    nick: profile?.nick ?? "",
    activeRound: active
      ? { id: active.id, bet: Number(active.bet), status: active.status, elapsedMs: Math.max(0, Number(active.elapsed_ms)) }
      : null,
    history: history.map(historyOut),
    stakes: CRASH_STAKES,
    ...extra,
  };
}

// If the player's running round has reached its hidden crash time AND the cash-out grace
// window after it has fully closed, resolve it as BUSTED: record a 0-win spin and flip status.
// Returns the revealed outcome (or null). Locks the round row FOR UPDATE so concurrent polls /
// a racing cash_out resolve it exactly once. The grace delay is the fix for "tapped in time,
// still lost": without it, a state poll landing between crash_at and a latency-delayed tap
// busted the round first and the tap found no running round to be forgiven on. Delaying the
// reveal leaks nothing — while hidden, state reports only elapsed time (crash-independent),
// and the cash_out grace still demands a claimed multiplier BELOW the unknowable crash point.
async function resolveDueRound(tx, userId) {
  const [round] = await tx`
    select r.id, r.bet, s.crash_point,
           (now() >= s.crash_at + ${CASHOUT_GRACE_MS} * interval '1 millisecond') as due
    from public.crash_rounds r
    join public.crash_round_secrets s on s.round_id = r.id
    where r.user_id = ${userId} and r.status = 'running'
    for update of r`;
  if (!round || !round.due) return null;
  await tx`update public.crash_rounds set status = 'busted' where id = ${round.id}`;
  await tx`insert into public.crash_spins
           (user_id, round_id, total_bet, cashout_multiplier, total_won, crash_point)
           values (${userId}, ${round.id}, ${round.bet}, null, 0, ${round.crash_point})`;
  return { roundId: round.id, crashPoint: Number(round.crash_point) };
}

// state / history → resolve a due crash, then return the snapshot.
async function getState(userId) {
  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    const busted = await resolveDueRound(tx, userId);
    return await stateResponse(tx, userId, busted ? { busted } : {});
  });
}

// start → deduct the bet and launch a fresh rocket with a hidden crash point.
async function startRound(userId, rawBet) {
  const bet = validateBet(rawBet);
  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    // Lock order crash_rounds → profiles, IDENTICAL to cashOut(), so a start racing a cash-out
    // for the same user (e.g. two tabs) can never deadlock. resolveDueRound takes the running
    // round's FOR UPDATE lock (and busts it if it already crashed) BEFORE we touch profiles.
    await resolveDueRound(tx, userId);
    const [profile] = await tx`select coins from public.profiles where id = ${userId} for update`;
    if (!profile) throw gameError("Profil nie istnieje.");
    // Re-check after BOTH locks: a round still genuinely flying — or one a concurrent start just
    // committed — blocks a second launch with a clean message instead of a unique-index violation
    // (crash_rounds_one_live_per_user is the final backstop).
    const [live] = await tx`select 1 from public.crash_rounds where user_id = ${userId} and status = 'running'`;
    if (live) throw gameError("Rakieta już leci — najpierw wypłać! 🚀");

    if (Number(profile.coins) < bet) throw gameError("Za mało coinów!");

    const cp = genCrashPoint();
    await tx`update public.profiles set coins = coins - ${bet} where id = ${userId}`;
    const [round] = await tx`
      insert into public.crash_rounds (user_id, bet, status, started_at)
      values (${userId}, ${bet}, 'running', now())
      returning id, started_at`;
    const crashAt = new Date(new Date(round.started_at).getTime() + durationFor(cp));
    await tx`insert into public.crash_round_secrets (round_id, crash_point, crash_at)
             values (${round.id}, ${cp}, ${crashAt})`;

    return await stateResponse(tx, userId, { started: { id: round.id } });
  });
}

// cash_out → pay the player out if the rocket is still flying on the server clock.
async function cashOut(userId, clientMultiplier) {
  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    const [round] = await tx`
      select id, bet, started_at from public.crash_rounds
      where user_id = ${userId} and status = 'running' for update`;
    if (!round) {
      // A state poll may have just revealed the bust (post-grace, so this tap was genuinely
      // too late) — give the tap an honest verdict instead of a confusing "no active flight".
      const [last] = await tx`
        select crash_point from public.crash_spins
        where user_id = ${userId} and total_won = 0 and cashout_multiplier is null
          and created_at > now() - interval '5 seconds'
        order by created_at desc limit 1`;
      return await stateResponse(tx, userId, {
        notice: last
          ? `Za późno! 💥 Rakieta wybuchła przy x${Number(last.crash_point).toFixed(2)}.`
          : "Nie masz aktywnego lotu.",
      });
    }

    const [sec] = await tx`select crash_point, crash_at from public.crash_round_secrets where round_id = ${round.id}`;
    if (!sec) return await stateResponse(tx, userId, { notice: "Brak danych lotu." });

    // Authoritative elapsed + lateness in ONE round-trip, decided by Postgres now()
    // (no isolate↔DB clock skew). `crashed` flips true the instant now() reaches crash_at.
    const [{ ms, crashed }] = await tx`
      select extract(epoch from (now() - ${round.started_at}::timestamptz)) * 1000 as ms,
             (now() >= ${sec.crash_at}::timestamptz) as crashed`;
    const serverM = multAt(Number(ms));
    const cp = Number(sec.crash_point);
    const clientM = Number(clientMultiplier);
    const hasClient = Number.isFinite(clientM) && clientM >= 1;
    const clientFloor = hasClient ? floor2(clientM) : 0;

    let mult = null;
    if (!crashed && serverM < cp) {
      // Still flying on the server clock → pay EXACTLY what the WYPŁAĆ button showed. The
      // display may legitimately lead the server clock a little (anchor comp overshoot), so
      // trust the claim up to CLIENT_AHEAD_TOL_MS of lead — but never at/above the crash
      // point, and a tampered over-claim stays capped by the server's own clock.
      const cap = Math.min(floor2(multAt(Number(ms) + CLIENT_AHEAD_TOL_MS)),
                           Math.round((cp - 0.01) * 100) / 100);
      mult = hasClient ? Math.max(1, Math.min(clientFloor, cap)) : floor2(serverM);
    } else {
      // The request crossed the hidden crash IN FLIGHT. Forgive bounded network latency: if
      // the player committed (clientFloor) strictly BELOW the crash point they tapped in time
      // even though the packet only ARRIVED a hop late → honor exactly what they saw.
      const lateMs = Number(ms) - durationFor(cp);
      if (hasClient && clientFloor < cp && lateMs <= CASHOUT_GRACE_MS) mult = clientFloor;
    }

    if (mult == null) {
      // Too late → bust the round and record the loss so the client shows the explosion.
      // Say WHERE it blew and, when the tapped value was already past it, make clear the
      // click happened after the explosion (the reveal just hadn't reached the screen yet).
      const lateNotice = hasClient && clientFloor >= cp
        ? `💥 Rakieta wybuchła przy x${cp.toFixed(2)} — klik przy x${clientFloor.toFixed(2)} był już po wybuchu.`
        : `Za późno! 💥 Rakieta wybuchła przy x${cp.toFixed(2)}.`;
      await tx`update public.crash_rounds set status = 'busted' where id = ${round.id}`;
      await tx`insert into public.crash_spins
               (user_id, round_id, total_bet, cashout_multiplier, total_won, crash_point)
               values (${userId}, ${round.id}, ${round.bet}, null, 0, ${cp})`;
      return await stateResponse(tx, userId, { notice: lateNotice, busted: { roundId: round.id, crashPoint: cp } });
    }

    const won = Math.floor(Number(round.bet) * mult);
    await tx`update public.profiles set coins = coins + ${won} where id = ${userId}`;
    await tx`update public.crash_rounds set status = 'cashed' where id = ${round.id}`;
    await tx`insert into public.crash_spins
             (user_id, round_id, total_bet, cashout_multiplier, total_won, crash_point)
             values (${userId}, ${round.id}, ${round.bet}, ${mult}, ${won}, ${cp})`;
    return await stateResponse(tx, userId, { cashedOut: { multiplier: mult, won } });
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "state");

    let result;
    if (action === "state" || action === "history") result = await getState(user.id);
    else if (action === "start") result = await startRound(user.id, body.bet ?? body.amount);
    else if (action === "cash_out" || action === "cashout") result = await cashOut(user.id, body.atMultiplier ?? body.multiplier);
    else throw gameError("Nieznana akcja.");

    return json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
