// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

// „Koło Fortuny G6" — SHARED-ROUNDS house casino game. There is ONE communal
// wheel with a SINGLE ordered set of 20 segments — no risk tiers, every
// player spins the same wheel, a bet is just a stake. A round opens the
// moment the first player bets, runs a 15 s betting window, then draws ONE
// segment_index server-side and pays every bet on that round by that one
// shared multiplier. Coin timing follows the ROULETTE convention (nothing
// deducted at bet time, only validated — coins move only at resolve).
// Resolution is lazy-on-read, crash-style: resolveDueRound runs on every
// `state`/`bet` call, so the client's 1 s poll on `state` is what actually
// fires a due spin. wheel_spins keeps writing one row per resolved bet,
// unchanged, so hazard/economy views need no changes.

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

// First bet on a fresh round opens this window; PARITY CONTRACT with
// WHEEL_BETTING_WINDOW_MS in index.html (used for the client-side countdown).
const WHEEL_BETTING_WINDOW_MS = 15_000;
// Fast-start: when EVERY bettor in the round has voted ready, spin_at is
// pulled in to now + this grace (never pushed out) — long enough for the
// other clients' poll/realtime to sync the accelerated countdown.
const WHEEL_READY_GRACE_MS = 3_000;
// How many resolved rounds `state` returns in `recentRounds`.
const RECENT_ROUNDS = 10;

// Keep byte-for-byte in sync with index.html (WHEEL_SEGMENTS) — this is the
// parity contract: this ordered 20-element array literally IS the wheel (one
// shared set — no risk tiers). Composition: 1× 10x (jackpot), 3× 2x,
// 2× 1x (zwrot stawki), 2× 0.5x (pół stawki wraca), 12× 0x. Sum = 19.0 ->
// RTP 95.0% before flooring/luck (×1.01 amulet lands it at 95.95%, still
// below 100%). Layout: no two prizes adjacent — the 10x stands alone at
// idx 0, the 2x at 3/7/12, 0.5x at 5/14, 1x at 9/16; zeros fill the gaps
// (longest run 3, at idx 17-19 leading into the jackpot).
const SEGMENTS = [10, 0, 0, 2, 0, 0.5, 0, 2, 0, 1, 0, 0, 2, 0, 0.5, 0, 1, 0, 0, 0];
const SEGMENT_COUNT = 20;
const WHEEL_RTP = 0.95;

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

// Timed COMMUNAL „Amulet Bezwstydnego Fartu" (casino-luck-item.sql): while ANY unexpired
// instance exists (any owner — the buyer pays for everyone), every payout is
// ×CASINO_LUCK_MULT. RTP is 95%, so 1.01 lands it at 95.95%, still below
// 100% — never raise this without recomputing WHEEL_RTP.
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

// Same eligibility as hasCasinoLuck, plus the aggregate MAX(expires_at) so
// the frontend can show "aktywny do {date}" without seeing any instance
// ownership details. Only used by stateResponse (display) — resolveOneRound
// keeps using the plain hasCasinoLuck boolean for the payout multiplier.
async function casinoLuckStatus(tx) {
  try {
    const rows = await tx`
      select max(i.expires_at) as until
      from public.hero_item_instances i
      join public.hero_item_defs d on d.id = i.item_def_id
      where d.is_active = true
        and d.effect_game = 'casino'
        and d.effect_type = 'casino_luck'
        and i.expires_at is not null
        and i.expires_at > now()
    `;
    const until = rows[0]?.until ?? null;
    return { active: !!until, until: until ? new Date(until).toISOString() : null };
  } catch (err) {
    console.warn("Casino luck status lookup unavailable:", err?.message ?? err);
    return { active: false, until: null };
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
    segmentIndex: Number(row.segment_index),
    multiplier: Number(row.multiplier || 0),
    totalWon: Number(row.total_won || 0),
    createdAt: row.created_at,
  };
}

async function historyRows(tx, userId, limit = 12) {
  const rows = await tx`
    select id, total_bet, segment_index, multiplier, total_won, created_at
    from public.wheel_spins
    where user_id = ${userId}
    order by created_at desc
    limit ${limit}`;
  return rows.map(spinOut);
}

function roundOut(round) {
  if (!round) return null;
  return {
    id: round.id,
    status: round.status,
    spinAt: round.spin_at,
    segmentIndex: round.segment_index != null ? Number(round.segment_index) : null,
    resolvedAt: round.resolved_at,
  };
}

function betOut(row) {
  return {
    userId: row.user_id,
    nick: row.nick_snapshot,
    bet: Number(row.total_bet),
    ready: !!row.ready,
    multiplier: row.multiplier != null ? Number(row.multiplier) : null,
    totalWon: row.total_won != null ? Number(row.total_won) : null,
    createdAt: row.created_at,
  };
}

// The round the client should be looking at: the current open (betting)
// round if one exists, otherwise the most recently resolved round (so the
// tab always shows a live result banner for a beat after landing). Returns
// its bets ordered by join time (oldest first — first-in reads top-down).
async function currentRoundWithBets(tx) {
  const [openRound] = await tx`
    select * from public.wheel_rounds
    where status = 'betting'
    order by created_at desc
    limit 1`;
  let round = openRound || null;
  if (!round) {
    const [lastResolved] = await tx`
      select * from public.wheel_rounds
      where status = 'resolved'
      order by resolved_at desc
      limit 1`;
    round = lastResolved || null;
  }
  if (!round) return { round: null, bets: [] };
  const bets = await tx`
    select user_id, nick_snapshot, total_bet, ready, multiplier, total_won, created_at
    from public.wheel_round_bets
    where round_id = ${round.id}
    order by created_at asc`;
  return { round, bets };
}

async function recentRounds(tx, limit = RECENT_ROUNDS) {
  const rows = await tx`
    select r.id, r.segment_index, r.resolved_at,
           w.nick_snapshot as winner_nick, w.total_won as winner_won
    from public.wheel_rounds r
    left join lateral (
      select nick_snapshot, total_won
      from public.wheel_round_bets
      where round_id = r.id
      order by total_won desc nulls last
      limit 1
    ) w on true
    where r.status = 'resolved'
    order by r.resolved_at desc
    limit ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    segmentIndex: Number(r.segment_index),
    resolvedAt: r.resolved_at,
    winnerNick: r.winner_nick || null,
    winnerWon: r.winner_won != null ? Number(r.winner_won) : null,
  }));
}

// Build the full snapshot the client renders. `extra` carries any one-shot
// outcome from the action that just ran.
async function stateResponse(tx, userId, extra = {}) {
  const [profile] = await tx`select coins, nick from public.profiles where id = ${userId}`;
  const luck = await casinoLuckStatus(tx);
  const { round, bets } = await currentRoundWithBets(tx);
  const [{ now: serverNow }] = await tx`select now() as now`;
  return {
    coins: profile?.coins ?? 0,
    nick: profile?.nick ?? "",
    stakes: STAKES,
    segments: SEGMENTS,
    rtp: WHEEL_RTP,
    casinoLuck: luck.active,
    casinoLuckUntil: luck.until,
    round: roundOut(round),
    bets: bets.map(betOut),
    recentRounds: await recentRounds(tx),
    history: await historyRows(tx, userId),
    serverNow: new Date(serverNow).toISOString(),
    ...extra,
  };
}

// Resolve exactly the rounds whose betting window has closed. FOR UPDATE
// SKIP LOCKED means a concurrent call never blocks on / double-resolves a
// round another request is already finishing. In steady state there is at
// most one due round at a time (only one round is ever 'betting').
async function resolveDueRound(tx) {
  const due = await tx`
    select id from public.wheel_rounds
    where status = 'betting' and spin_at <= now()
    for update skip locked`;
  for (const row of due) {
    await resolveOneRound(tx, row.id);
  }
}

// Draw the segment, pay every bet on the round by that one shared
// multiplier, mirror each payout into wheel_spins (unchanged shape —
// hazard/economy views keep working), then flip the round to 'resolved'.
// Lock ORDER: the round row is already locked (via resolveDueRound's FOR
// UPDATE) before we touch any profiles row here — same order `bet()` uses
// (round, then profile), so the two paths can never deadlock on each other.
async function resolveOneRound(tx, roundId) {
  const segmentIndex = randomSegmentIndex();
  const multiplier = SEGMENTS[segmentIndex];
  const luck = await hasCasinoLuck(tx);
  const bets = await tx`
    select id, user_id, total_bet
    from public.wheel_round_bets
    where round_id = ${roundId}
    order by created_at asc`;

  for (const bet of bets) {
    const [profile] = await tx`select coins from public.profiles where id = ${bet.user_id} for update`;
    if (!profile || Number(profile.coins) < Number(bet.total_bet)) {
      // The player spent their coins elsewhere between betting and the draw —
      // they dodge the charge, but also the payout: no money moves.
      await tx`update public.wheel_round_bets set multiplier = 0, total_won = 0 where id = ${bet.id}`;
      continue;
    }
    const totalWon = Math.floor(Number(bet.total_bet) * multiplier * (luck ? CASINO_LUCK_MULT : 1));
    const balance = Number(profile.coins) - Number(bet.total_bet) + totalWon;
    await tx`update public.profiles set coins = ${balance} where id = ${bet.user_id}`;
    await tx`update public.wheel_round_bets set multiplier = ${multiplier}, total_won = ${totalWon} where id = ${bet.id}`;
    await tx`
      insert into public.wheel_spins (user_id, total_bet, segment_index, multiplier, total_won)
      values (${bet.user_id}, ${bet.total_bet}, ${segmentIndex}, ${multiplier}, ${totalWon})`;
  }

  await tx`
    update public.wheel_rounds
    set status = 'resolved', segment_index = ${segmentIndex}, resolved_at = now()
    where id = ${roundId}`;
}

// Find the open betting round (FOR UPDATE — this lock is taken BEFORE any
// profile lock in `bet()`), or open a fresh one if none exists. The INSERT
// itself is effectively the lock for the "first bettor of a new round" race;
// wheel_rounds_single_betting_idx (a partial unique index) backstops the
// rare interleave where two concurrent bets both see no open round, turning
// the loser's insert into a 23505 that we recover from by re-selecting.
// The INSERT runs inside a SAVEPOINT: a failed statement poisons a plain
// Postgres transaction (every later query would die with 25P02), so without
// the savepoint the recovery SELECT could never actually run.
async function findOrCreateOpenRound(tx) {
  const [openRound] = await tx`
    select * from public.wheel_rounds
    where status = 'betting' and spin_at > now()
    order by created_at desc
    limit 1
    for update`;
  if (openRound) return openRound;
  try {
    return await tx.savepoint(async (sp) => {
      const [round] = await sp`
        insert into public.wheel_rounds (spin_at)
        values (now() + ${WHEEL_BETTING_WINDOW_MS} * interval '1 millisecond')
        returning *`;
      return round;
    });
  } catch (err) {
    if (String(err?.code) === "23505") {
      const [round] = await tx`
        select * from public.wheel_rounds
        where status = 'betting'
        order by created_at desc
        limit 1
        for update`;
      if (round) return round;
    }
    throw err;
  }
}

// state / history → resolve any due round, then return the snapshot.
async function getState(userId) {
  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    await resolveDueRound(tx);
    return await stateResponse(tx, userId);
  });
}

// bet → join the current (or a freshly-opened) round with one stake. Coins
// are only VALIDATED here, never deducted — they move for everyone at once
// when the round resolves (see resolveOneRound).
async function placeBet(userId, rawBet) {
  const bet = validateBet(rawBet);

  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    // Resolve anything already due first, so a bet never lands inside a
    // round whose window has technically already closed.
    await resolveDueRound(tx);

    // Lock ORDER: round row first, then the caller's profile row — mirrors
    // resolveOneRound so bet() can never deadlock against a concurrent
    // resolve of a DIFFERENT round.
    const round = await findOrCreateOpenRound(tx);

    const [profile] = await tx`select coins, nick from public.profiles where id = ${userId} for update`;
    if (!profile) throw gameError("Profil nie istnieje.");
    if (Number(profile.coins) < bet) throw gameError("Za mało coinów!");

    try {
      await tx`
        insert into public.wheel_round_bets (round_id, user_id, nick_snapshot, total_bet)
        values (${round.id}, ${userId}, ${String(profile.nick || "Gracz")}, ${bet})`;
    } catch (err) {
      if (String(err?.code) === "23505") throw gameError("Już postawiłeś w tej rundzie.");
      throw err;
    }

    return await stateResponse(tx, userId);
  });
}

// ready → fast-start vote. Marks the caller's bet ready; when EVERY bet in
// the open round is ready, spin_at is pulled in to now + WHEEL_READY_GRACE_MS
// (LEAST() — never pushed out, so voting near the natural deadline is a
// no-op). A bettor joining AFTER acceleration simply joins the short window;
// their un-ready flag does not revert spin_at. Lock ORDER: round row first
// (FOR UPDATE), profile never — same first lock as bet()/resolveOneRound.
async function markReady(userId) {
  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    await resolveDueRound(tx);

    const [round] = await tx`
      select * from public.wheel_rounds
      where status = 'betting' and spin_at > now()
      order by created_at desc
      limit 1
      for update`;
    // Window already closed (or nothing open): nothing to accelerate — the
    // snapshot below simply shows the caller whatever is current.
    if (round) {
      const updated = await tx`
        update public.wheel_round_bets
        set ready = true
        where round_id = ${round.id} and user_id = ${userId}
        returning id`;
      if (!updated.length) throw gameError("Najpierw postaw zakład.");
      const [{ waiting }] = await tx`
        select count(*)::int as waiting
        from public.wheel_round_bets
        where round_id = ${round.id} and ready = false`;
      if (waiting === 0) {
        await tx`
          update public.wheel_rounds
          set spin_at = least(spin_at, now() + ${WHEEL_READY_GRACE_MS} * interval '1 millisecond')
          where id = ${round.id}`;
      }
    }

    return await stateResponse(tx, userId);
  });
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
    else if (action === "bet") result = await placeBet(user.id, body.bet);
    else if (action === "ready") result = await markReady(user.id);
    else throw gameError("Nieznana akcja.");

    return json(req, { ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json(req, { ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
