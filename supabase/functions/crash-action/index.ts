// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

// „Rakieta" (Crash) — shared multiplayer house game. One rocket per round; the
// multiplier climbs from x1.00 and players tap CASH OUT to lock it before a hidden,
// server-owned crash point. All state transitions are LAZY (request-driven, no cron):
// every action locks the singleton crash_tables row FOR UPDATE and calls advance().

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://inlineskater.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const db = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 10, idle_timeout: 20 });

// ── Tunables ──────────────────────────────────────────────────────────────────
const BET_WINDOW_MS = 5000;     // betting window per round
const RESULT_PAUSE_MS = 3000;   // crashed → next betting round pause
const HOUSE_EDGE = 0.05;        // 5% — instant-bust probability == the edge
const MAX_MULT = 1000;          // hard cap on crash point
const CRASH_STAKES = [5, 10, 25, 50, 100, 250];
// PARITY CONTRACT: CRASH_GROWTH must equal the constant of the same name in
// index.html. Multiplier m(t) = exp(CRASH_GROWTH · elapsedMs); doubles every 7 s.
const CRASH_GROWTH = Math.log(2) / 7000;

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
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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

// Inert forward-compat hook: no item targets effect_game='crash' yet, so this
// returns null today. Wire a payout_bonus credit at cash_out when a crash item ships.
async function getStrongestHeroEffect(tx, userId, game) {
  try {
    const rows = await tx`
      select d.slug, d.name, d.emoji, d.effect_game, d.effect_type, d.effect_value
      from public.hero_equipment e
      join public.hero_item_instances i on i.id = e.item_instance_id
      join public.hero_item_defs d on d.id = i.item_def_id
      where e.user_id = ${userId}
        and i.owner_id = ${userId}
        and d.is_active = true
        and d.effect_game = ${game}
      order by d.effect_value desc, d.price desc, d.slug
      limit 1
    `;
    return rows[0] ?? null;
  } catch (err) {
    console.warn("Hero item effects unavailable:", err?.message ?? err);
    return null;
  }
}

// ── Round chain ────────────────────────────────────────────────────────────────
async function createNextRound(tx, table) {
  const nextNo = table.round_no + 1;
  const [round] = await tx`
    insert into public.crash_rounds (table_id, round_no, status, betting_ends_at)
    values (${table.id}, ${nextNo}, 'betting', now() + (${BET_WINDOW_MS} * interval '1 millisecond'))
    returning *`;
  await tx`update public.crash_tables
           set round_no = ${nextNo}, current_round_id = ${round.id}, updated_at = now()
           where id = ${table.id}`;
  table.round_no = nextNo;
  table.current_round_id = round.id;
  return round;
}

// Deduct stakes for everyone who can still cover; drop the rest. Returns kept count.
async function tryLaunch(tx, round) {
  const bets = await tx`select id, user_id, amount from public.crash_bets
                        where round_id = ${round.id} for update`;
  let kept = 0;
  for (const bet of bets) {
    const res = await tx`update public.profiles set coins = coins - ${bet.amount}
                         where id = ${bet.user_id} and coins >= ${bet.amount}`;
    if (res.count === 1) kept++;
    else await tx`delete from public.crash_bets where id = ${bet.id}`;
  }
  if (kept === 0) return 0;

  const cp = genCrashPoint();
  const [r] = await tx`update public.crash_rounds
                       set status = 'running', started_at = now()
                       where id = ${round.id} returning started_at`;
  const crashAt = new Date(new Date(r.started_at).getTime() + durationFor(cp));
  await tx`insert into public.crash_round_secrets (round_id, crash_point, crash_at)
           values (${round.id}, ${cp}, ${crashAt})`;
  await tx`update public.crash_rounds
           set total_bet = coalesce((select sum(amount) from public.crash_bets where round_id = ${round.id}), 0)
           where id = ${round.id}`;
  return kept;
}

async function resolveRound(tx, round, crashPoint) {
  await tx`update public.crash_bets set status = 'busted'
           where round_id = ${round.id} and status = 'active'`;
  const bets = await tx`select user_id, amount, cashed_multiplier, status
                        from public.crash_bets where round_id = ${round.id}`;
  let totalWon = 0;
  for (const b of bets) {
    const won = b.status === "cashed" ? Math.floor(Number(b.amount) * Number(b.cashed_multiplier)) : 0;
    totalWon += won;
    await tx`insert into public.crash_spins
             (user_id, round_id, total_bet, cashout_multiplier, total_won, crash_point)
             values (${b.user_id}, ${round.id}, ${b.amount},
                     ${b.status === "cashed" ? b.cashed_multiplier : null}, ${won}, ${crashPoint})`;
  }
  await tx`update public.crash_rounds
           set status = 'crashed', crash_point = ${crashPoint}, crashed_at = now(), total_won = ${totalWon}
           where id = ${round.id}`;
}

// True if `round` is past its current-phase deadline and needs the lazy state machine
// to advance it (launch / crash / open next). Used by both the lock-free peek and the
// in-lock re-check so the herd's 2nd…Nth advancers can bail out without doing work.
async function transitionDue(tx, round) {
  if (!round) return true; // missing round → must create one
  const [{ now }] = await tx`select now() as now`;
  const nowMs = new Date(now).getTime();
  if (round.status === "betting") {
    return !!round.betting_ends_at && nowMs >= new Date(round.betting_ends_at).getTime();
  }
  if (round.status === "running") {
    const [sec] = await tx`select crash_at from public.crash_round_secrets where round_id = ${round.id}`;
    return !sec || nowMs >= new Date(sec.crash_at).getTime();
  }
  if (round.status === "crashed") {
    return !!round.crashed_at && nowMs >= new Date(round.crashed_at).getTime() + RESULT_PAUSE_MS;
  }
  return false;
}

// Lock-free read: current table + round with NO `FOR UPDATE`. Returns `due` so the
// caller can decide whether it must escalate to the locking loadGame().
async function peekGame(tx) {
  const [table] = await tx`select * from public.crash_tables where slug = 'main'`;
  if (!table) throw gameError("Stół nie istnieje.");
  const round = table.current_round_id
    ? (await tx`select * from public.crash_rounds where id = ${table.current_round_id}`)[0] ?? null
    : null;
  const due = await transitionDue(tx, round);
  return { table, round, due };
}

// Lock the singleton table, advance through any due phase transitions, return fresh state.
async function loadGame(tx) {
  // Fail fast under contention instead of hanging a pool slot indefinitely.
  await tx`set local lock_timeout = '900ms'`;
  await tx`set local statement_timeout = '4s'`;
  const [table] = await tx`select * from public.crash_tables where slug = 'main' for update`;
  if (!table) throw gameError("Stół nie istnieje.");

  for (let i = 0; i < 6; i++) {
    let round = table.current_round_id
      ? (await tx`select * from public.crash_rounds where id = ${table.current_round_id} for update`)[0]
      : null;
    if (!round) { await createNextRound(tx, table); continue; }

    const [{ now }] = await tx`select now() as now`;
    const nowMs = new Date(now).getTime();

    if (round.status === "betting") {
      if (round.betting_ends_at && nowMs >= new Date(round.betting_ends_at).getTime()) {
        // drop bets the user can no longer cover, then launch if any remain
        await tx`delete from public.crash_bets b using public.profiles p
                 where b.round_id = ${round.id} and b.user_id = p.id and p.coins < b.amount`;
        const [{ cnt }] = await tx`select count(*)::int as cnt from public.crash_bets where round_id = ${round.id}`;
        if (cnt > 0) {
          const kept = await tryLaunch(tx, round);
          if (kept > 0) continue;          // launched → loop (may instant-bust)
        }
        // nobody to launch → extend the betting window
        await tx`update public.crash_rounds
                 set betting_ends_at = now() + (${BET_WINDOW_MS} * interval '1 millisecond')
                 where id = ${round.id}`;
      }
      break;
    }

    if (round.status === "running") {
      const [sec] = await tx`select crash_point, crash_at from public.crash_round_secrets where round_id = ${round.id}`;
      if (!sec) { // defensive: missing secret, force a crash at x1.00
        await resolveRound(tx, round, 1.00);
        continue;
      }
      if (nowMs >= new Date(sec.crash_at).getTime()) {
        await resolveRound(tx, round, Number(sec.crash_point));
        continue;
      }
      break;
    }

    if (round.status === "crashed") {
      if (round.crashed_at && nowMs >= new Date(round.crashed_at).getTime() + RESULT_PAUSE_MS) {
        await createNextRound(tx, table);
        continue;
      }
      break;
    }
    break;
  }

  const [table2] = await tx`select * from public.crash_tables where slug = 'main'`;
  const [round2] = await tx`select * from public.crash_rounds where id = ${table2.current_round_id}`;
  return { table: table2, round: round2 };
}

// Build the sanitized client payload from an ALREADY-LOADED {table, round}. Does no
// locking and no advancing — callers decide how they obtained the state (loadGame under
// the lock, or peekGame lock-free).
async function buildState(tx, userId, table, round, extra = {}) {
  const [profile] = await tx`select coins, nick from public.profiles where id = ${userId}`;
  const [{ now }] = await tx`select now() as now`;
  const nowMs = new Date(now).getTime();

  const bets = await tx`
    select user_id, nick_snapshot, amount, cashed_multiplier, status
    from public.crash_bets where round_id = ${round.id} order by created_at`;
  const myBet = bets.find((b) => b.user_id === userId) ?? null;

  const history = await tx`
    select round_no, crash_point from public.crash_rounds
    where table_id = ${table.id} and status = 'crashed' order by round_no desc limit 20`;

  const myResults = await tx`
    select round_id, total_bet, cashout_multiplier, total_won, crash_point, created_at
    from public.crash_spins where user_id = ${userId} order by created_at desc limit 10`;

  // Sanitized round — never expose crash_point / timing of a RUNNING round.
  const roundOut = { id: round.id, round_no: round.round_no, status: round.status };
  if (round.status === "betting") {
    roundOut.msLeft = Math.max(0, new Date(round.betting_ends_at).getTime() - nowMs);
  } else if (round.status === "running") {
    roundOut.elapsedMs = Math.max(0, nowMs - new Date(round.started_at).getTime());
  } else if (round.status === "crashed") {
    roundOut.crash_point = Number(round.crash_point);
    roundOut.nextInMs = Math.max(0, new Date(round.crashed_at).getTime() + RESULT_PAUSE_MS - nowMs);
  }

  return {
    round: roundOut,
    coins: profile?.coins ?? 0,
    nick: profile?.nick ?? "",
    bets: bets.map((b) => ({
      nick: b.nick_snapshot,
      amount: b.amount,
      cashed_multiplier: b.cashed_multiplier !== null ? Number(b.cashed_multiplier) : null,
      status: b.status,
      isMe: b.user_id === userId,
    })),
    myBet: myBet ? { amount: myBet.amount, status: myBet.status,
      cashed_multiplier: myBet.cashed_multiplier !== null ? Number(myBet.cashed_multiplier) : null } : null,
    canBet: round.status === "betting",
    canCashout: round.status === "running" && !!myBet && myBet.status === "active",
    history: history.map((h) => ({ round_no: h.round_no, crash_point: Number(h.crash_point) })),
    myResults: myResults.map((r) => ({
      round_id: r.round_id, total_bet: r.total_bet,
      cashout_multiplier: r.cashout_multiplier !== null ? Number(r.cashout_multiplier) : null,
      total_won: r.total_won, crash_point: Number(r.crash_point), created_at: r.created_at,
    })),
    stakes: CRASH_STAKES,
    ...extra,
  };
}

// Advance under the lock, then build the payload. Used by every mutating action.
async function stateResponse(tx, userId, extra = {}) {
  const { table, round } = await loadGame(tx);
  return await buildState(tx, userId, table, round, extra);
}

// Transient DB contention (lock timeout / serialization / deadlock / dropped
// connection) — safe to retry or to soft-fall-back to a lock-free read.
function isTransientDbError(err) {
  const code = err?.code;
  const msg = String(err?.message ?? "");
  return code === "55P03" || code === "40001" || code === "40P01" ||
    code === "57014" || // statement_timeout cancellation
    code === "CONNECTION_CLOSED" || code === "CONNECTION_DESTROYED" || code === "CONNECT_TIMEOUT" ||
    /lock timeout|statement timeout|deadlock|connection .*closed|connection .*destroyed|connect timeout/i.test(msg);
}

async function withTransientRetry(fn, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err?.isGame || !isTransientDbError(err) || attempt === attempts - 1) throw err;
      await sleep(70 * (attempt + 1));
    }
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────
// Read path: lock-free when nothing is due (the overwhelming majority of polls), only
// escalating to the locking advancer at a real phase boundary. On transient contention
// it retries once, then soft-falls-back to the lock-free snapshot so a momentary lock
// blip never surfaces to the user as "Błąd serwera.".
async function getState(userId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.begin(async (tx) => {
        const { table, round, due } = await peekGame(tx);
        if (!due && round) return await buildState(tx, userId, table, round);
        return await stateResponse(tx, userId); // a transition is due → advance under the lock
      });
    } catch (err) {
      if (err?.isGame) throw err;
      if (!isTransientDbError(err)) throw err;
      if (attempt === 0) continue; // retry once
      // Still contended → serve the lock-free snapshot; the next tick reconciles.
      return await db.begin((tx) => peekGame(tx).then(({ table, round }) =>
        round ? buildState(tx, userId, table, round) : stateResponse(tx, userId)));
    }
  }
}

async function placeBet(userId, rawAmount) {
  const amount = Math.trunc(Number(rawAmount));
  if (!CRASH_STAKES.includes(amount)) throw gameError("Nieprawidłowa stawka.");
  return await withTransientRetry(() => db.begin(async (tx) => {
    const { round } = await loadGame(tx);
    if (round.status !== "betting") throw gameError("Zakłady zamknięte — rakieta już leci.");
    const [profile] = await tx`select coins, nick from public.profiles where id = ${userId}`;
    if (!profile) throw gameError("Profil nie istnieje.");
    if (profile.coins < amount) throw gameError("Za mało coinów!");
    await tx`
      insert into public.crash_bets (round_id, table_id, user_id, nick_snapshot, amount)
      values (${round.id}, ${round.table_id}, ${userId}, ${profile.nick}, ${amount})
      on conflict (round_id, user_id) do update set amount = excluded.amount, created_at = now()`;
    return await stateResponse(tx, userId);
  }));
}

async function clearBet(userId) {
  return await withTransientRetry(() => db.begin(async (tx) => {
    await tx`set local lock_timeout = '900ms'`;
    await tx`set local statement_timeout = '4s'`;
    // Delete the bet BEFORE advancing so canceling at the window boundary can never
    // accidentally launch the round with this bet (loadGame in stateResponse advances).
    const [table] = await tx`select * from public.crash_tables where slug = 'main' for update`;
    if (table?.current_round_id) {
      const [round] = await tx`select status from public.crash_rounds where id = ${table.current_round_id}`;
      if (round && round.status === "betting") {
        await tx`delete from public.crash_bets where round_id = ${table.current_round_id} and user_id = ${userId}`;
      }
    }
    return await stateResponse(tx, userId);
  }));
}

async function cashOut(userId, clientMultiplier) {
  return await withTransientRetry(() => db.begin(async (tx) => {
    const { round } = await loadGame(tx);
    if (round.status !== "running") {
      return await stateResponse(tx, userId, { notice: "Rakieta nie leci." });
    }
    const [bet] = await tx`select * from public.crash_bets
                           where round_id = ${round.id} and user_id = ${userId} for update`;
    if (bet?.status === "cashed") {
      const mult = Number(bet.cashed_multiplier || 1);
      return await stateResponse(tx, userId, { notice: `Już wypłacono x${mult.toFixed(2)}.` });
    }
    if (!bet || bet.status !== "active") {
      return await stateResponse(tx, userId, { notice: "Nie masz aktywnego zakładu." });
    }
    const [sec] = await tx`select crash_point from public.crash_round_secrets where round_id = ${round.id}`;
    const [{ ms }] = await tx`select extract(epoch from (now() - ${round.started_at}::timestamptz)) * 1000 as ms`;
    const serverM = multAt(Number(ms));
    if (!sec || serverM >= Number(sec.crash_point)) {
      // loadGame would normally have already crashed it; guard against rounding races
      return await stateResponse(tx, userId, { notice: "Za późno! 💥" });
    }
    // Pay what the player SAW on the button (client multiplier), capped at the server's
    // authoritative value so the display matches the payout but nobody can over-claim.
    let mult = floor2(serverM);
    const clientM = Number(clientMultiplier);
    if (Number.isFinite(clientM) && clientM >= 1) mult = Math.max(1, Math.min(mult, floor2(clientM)));
    // Hero payout_bonus hook would apply here for an effect_game='crash' item (none exist yet).
    const won = Math.floor(Number(bet.amount) * mult);
    await tx`update public.profiles set coins = coins + ${won} where id = ${userId}`;
    await tx`update public.crash_bets set status = 'cashed', cashed_multiplier = ${mult} where id = ${bet.id}`;
    return await stateResponse(tx, userId, { cashedOut: { multiplier: mult, won } });
  }));
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
    else if (action === "place_bet") result = await placeBet(user.id, body.amount);
    else if (action === "clear_bet") result = await clearBet(user.id);
    else if (action === "cash_out") result = await cashOut(user.id, body.atMultiplier);
    else throw gameError("Nieznana akcja.");

    return json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    if (err?.isGame) return json({ ok: false, error: err.message });
    if (isTransientDbError(err)) return json({ ok: false, error: "Rakieta jest chwilowo zajęta. Spróbuj ponownie." });
    return json({ ok: false, error: "Błąd serwera." });
  }
});
