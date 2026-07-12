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
// Forgive network latency: honor an in-time tap that ARRIVES this late. The forgiveness
// works even on a round a routine state poll already flipped to 'busted' — cashOut() converts
// the fresh bust back into a cash-out (so busts can be revealed IMMEDIATELY; the display no
// longer has to keep climbing past the real crash while the reveal delay ran out).
const CASHOUT_GRACE_MS = 450;
// Rounds are created with started_at this far in the FUTURE: the client receives the start
// response while the multiplier is still pinned at x1.00, so countdown → ignition → liftoff is
// synchronized and the rocket never has a head start the player couldn't see.
const LAUNCH_HOLD_MS = 1000;
// The client's flight clock may run a hair AHEAD of the server clock (its rtt/2 anchor comp
// overshoots by ~half the auth/db processing time). When the rocket is still flying, trust the
// tapped button value up to this much display lead; mirrors the clamp in index.html.
const CLIENT_AHEAD_TOL_MS = 250;
const CRASH_STAKES = [1, 5, 10, 25, 50, 100, 250, 500]; // preset chips; any integer 1..MAX_BET is allowed
const MAX_BET = 10_000_000;     // ceiling for a custom stake (balance is still enforced separately)
// PARITY CONTRACT: CRASH_GROWTH must equal the constant of the same name in
// index.html. Multiplier m(t) = exp(CRASH_GROWTH · elapsedMs); doubles every 15 s.
const CRASH_GROWTH = Math.log(2) / 15000;
// „Amulet Bezwstydnego Fartu" (communal casino_luck buff): while any unexpired instance
// exists, every player's crash cash-out win is multiplied by this factor. Deliberately
// makes Rakieta +EV — the item is meant to be OVERPOWERED and cover every casino game.
const CASINO_LUCK_CRASH_FACTOR = 1.03;

// True while any unexpired communal casino-luck amulet exists (any owner). Fails soft (false)
// so a lookup hiccup never blocks a legit cash-out.
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
      limit 1`;
    return rows.length > 0;
  } catch (err) {
    console.warn("Casino luck lookup unavailable:", err?.message ?? err);
    return false;
  }
}

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

// After start commits, keep the worker alive until the hidden crash time and then nudge the
// player's browser over a Realtime broadcast (topic `crash_<roundId>`, event `bust`). The
// client reacts by pulling `state`, which resolves + reveals the bust — so the explosion
// reaches the screen in ~150 ms instead of a full poll cycle. Pure accelerator: the payload
// carries nothing (no secrets on the wire) and the 250 ms poll remains the fallback if the
// worker is evicted mid-flight or the broadcast is lost.
function scheduleBustNudge(roundId, crashAtMs) {
  const fireInMs = Math.max(0, crashAtMs - Date.now() + 120); // +cushion so state sees now() ≥ crash_at
  const nudge = (async () => {
    await new Promise((resolve) => setTimeout(resolve, fireInMs));
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    await fetch(`${Deno.env.get("SUPABASE_URL")}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ messages: [{ topic: `crash_${roundId}`, event: "bust", payload: {} }] }),
    });
  })().catch((err) => console.error("bust nudge failed", err));
  try { EdgeRuntime.waitUntil(nudge); } catch { /* runtime without waitUntil: best effort */ }
}

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
    // elapsedMs may be NEGATIVE during the launch hold (started_at is in the future) — the
    // client pins the display at x1.00 until it crosses zero, keeping liftoff synchronized.
    activeRound: active
      ? { id: active.id, bet: Number(active.bet), status: active.status, elapsedMs: Number(active.elapsed_ms) }
      : null,
    history: history.map(historyOut),
    stakes: CRASH_STAKES,
    ...extra,
  };
}

// If the player's running round has reached its hidden crash time, resolve it as BUSTED
// IMMEDIATELY: record a 0-win spin and flip status. Returns the revealed outcome (or null).
// Locks the round row FOR UPDATE so concurrent polls / a racing cash_out resolve it exactly
// once. Revealing at once is safe for the "tapped in time, still lost" race because cashOut()
// forgives a latency-delayed tap even on a round that was JUST flipped to 'busted' (within
// CASHOUT_GRACE_MS, claimed multiplier strictly below the crash point) — and the sooner the
// client learns about the bust, the less the display overshoots the real crash point.
async function resolveDueRound(tx, userId) {
  const [round] = await tx`
    select r.id, r.bet, s.crash_point,
           (now() >= s.crash_at) as due
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
    // started_at sits LAUNCH_HOLD_MS in the future: the start response reaches the client
    // while the multiplier is still pinned at x1.00, so liftoff is synchronized on screen.
    const [round] = await tx`
      insert into public.crash_rounds (user_id, bet, status, started_at)
      values (${userId}, ${bet}, 'running', now() + ${LAUNCH_HOLD_MS} * interval '1 millisecond')
      returning id, started_at`;
    const crashAt = new Date(new Date(round.started_at).getTime() + durationFor(cp));
    await tx`insert into public.crash_round_secrets (round_id, crash_point, crash_at)
             values (${round.id}, ${cp}, ${crashAt})`;

    const result = await stateResponse(tx, userId, { started: { id: round.id } });
    scheduleBustNudge(round.id, crashAt.getTime());
    return result;
  });
}

// cash_out → pay the player out if the rocket is still flying on the server clock, OR if the
// tap arrived within the grace window after the crash — even when a racing state poll already
// flipped the round to 'busted' (the bust is then converted back into a cash-out). That keeps
// the "tapped in time, still lost" fix while letting busts be revealed immediately.
async function cashOut(userId, clientMultiplier) {
  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    const [round] = await tx`
      select id, bet, status, started_at from public.crash_rounds
      where user_id = ${userId}
        and (status = 'running'
             or (status = 'busted' and started_at > now() - interval '10 minutes'))
      order by started_at desc limit 1
      for update`;
    if (!round) return await stateResponse(tx, userId, { notice: "Nie masz aktywnego lotu." });

    const [sec] = await tx`select crash_point, crash_at from public.crash_round_secrets where round_id = ${round.id}`;
    if (!sec) return await stateResponse(tx, userId, { notice: "Brak danych lotu." });

    // Authoritative elapsed + lateness in ONE round-trip, decided by Postgres now()
    // (no isolate↔DB clock skew). late_ms > 0 the instant now() passes crash_at.
    const [{ ms, late_ms }] = await tx`
      select extract(epoch from (now() - ${round.started_at}::timestamptz)) * 1000 as ms,
             extract(epoch from (now() - ${sec.crash_at}::timestamptz)) * 1000 as late_ms`;
    const cp = Number(sec.crash_point);
    const lateMs = Number(late_ms);
    const clientM = Number(clientMultiplier);
    const hasClient = Number.isFinite(clientM) && clientM >= 1;
    const clientFloor = hasClient ? floor2(clientM) : 0;

    // WYSIWYG payout: the number on the WYPŁAĆ button is a CONTRACT — a click on a shown
    // green value is paid even when it lands a phantom cent or two ABOVE the hidden crash
    // point (the display can only learn about the bust one reveal-latency later, and players
    // shouldn't eat that physics). Two bounds keep it house-safe: the tap must ARRIVE within
    // CASHOUT_GRACE_MS of the crash, and the claim is capped at what an honest display could
    // have shown at tap time (server clock + CLIENT_AHEAD_TOL_MS of legitimate lead). Worst
    // case — a bot claiming the cap every round — still loses ≈2%/round:
    // (1-HOUSE_EDGE)·exp(CRASH_GROWTH·(GRACE+TOL)) ≈ 0.95·1.033 ≈ 0.981 < 1.
    let mult = null;
    if (lateMs <= CASHOUT_GRACE_MS) {
      const cap = floor2(multAt(Number(ms) + CLIENT_AHEAD_TOL_MS));
      if (hasClient) mult = Math.max(1, Math.min(clientFloor, cap));
      // No committed claim (old/odd client): pay the server-clock multiplier while genuinely
      // flying; a claimless tap that arrives after the crash has nothing shown to honor.
      else if (lateMs < 0) mult = floor2(multAt(Number(ms)));
    }

    if (mult == null) {
      // The click ARRIVED more than the grace window after the crash (dead/frozen connection,
      // or a tap long after the explosion) → honest verdict with the delay spelled out.
      const lateNotice = hasClient
        ? `💥 Rakieta wybuchła przy x${cp.toFixed(2)} — klik przy x${clientFloor.toFixed(2)} dotarł ${(lateMs / 1000).toFixed(1)}s po wybuchu.`
        : `Za późno! 💥 Rakieta wybuchła przy x${cp.toFixed(2)}.`;
      if (round.status === 'running') {
        await tx`update public.crash_rounds set status = 'busted' where id = ${round.id}`;
        await tx`insert into public.crash_spins
                 (user_id, round_id, total_bet, cashout_multiplier, total_won, crash_point)
                 values (${userId}, ${round.id}, ${round.bet}, null, 0, ${cp})`;
      }
      return await stateResponse(tx, userId, { notice: lateNotice, busted: { roundId: round.id, crashPoint: cp } });
    }

    const luckFactor = (await hasCasinoLuck(tx)) ? CASINO_LUCK_CRASH_FACTOR : 1;
    const won = Math.floor(Number(round.bet) * mult * luckFactor);
    await tx`update public.profiles set coins = coins + ${won} where id = ${userId}`;
    await tx`update public.crash_rounds set status = 'cashed' where id = ${round.id}`;
    if (round.status === 'busted') {
      // A state poll recorded the bust moments ago — convert that 0-win spin into the win.
      await tx`update public.crash_spins
               set cashout_multiplier = ${mult}, total_won = ${won}
               where round_id = ${round.id} and user_id = ${userId}
                 and total_won = 0 and cashout_multiplier is null`;
    } else {
      await tx`insert into public.crash_spins
               (user_id, round_id, total_bet, cashout_multiplier, total_won, crash_point)
               values (${userId}, ${round.id}, ${round.bet}, ${mult}, ${won}, ${cp})`;
    }
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
