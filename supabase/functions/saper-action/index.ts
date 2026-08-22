// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://inlineskater.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
const db = databaseUrl
  ? postgres(databaseUrl, { prepare: false, max: 4, idle_timeout: 20 })
  : null;

// „Saper Maraton" (saper) — Minesweeper as a 90-second arcade score chase.
//
// ⚠️ PARITY CONTRACT: everything between the PARITY BLOCK fences below must
// stay byte-for-byte equivalent to the same block in games/saper.js — the
// client plays this exact simulation and the server replays seed + the move
// log to derive the trusted score. Verified by `node scripts/saper-parity.mjs`.

// ── PARITY BLOCK START ──────────────────────────────────────────────────────
const SP_TICK_MS = 50;
const SP_ROUND_TICKS = 1800;          // 90 s
const SP_MINE_PENALTY_TICKS = 100;    // 5 s off the clock per detonation
const SP_MAX_MOVES = 6000;
// Ceiling on a submitted score, and the value mirrored by the arcade cap in
// supabase/arcade.sql. Measured, not guessed: scripts/saper-balance.mjs drives
// a deducing bot at a sustained 7 moves/second — well past what hands do — and
// tops out around 5000, while a good human run lands near 2200. 9999 leaves
// room for a genuinely exceptional round without being meaningless.
const SP_MAX_SCORE = 9999;

// Move kinds. The client logs one of these per accepted input, never per click
// — a click the simulation rejects is not a move and never reaches the log.
const SP_OPEN = 0;
const SP_FLAG = 1;
const SP_CHORD = 2;

// The difficulty ladder, indexed by BOARDS CLEARED (not boards dealt) — so a
// detonation costs you the board and the clock, never a promotion you did not
// earn. Density runs 13.9% → 15.6% → 17.2% → 17.3% → 19.8%: Windows beginner
// through a shade past intermediate, which is as far as anyone gets inside 90
// seconds.
const SP_LADDER = [
  { w: 6, h: 6, m: 5 },
  { w: 7, h: 7, m: 8 },
  { w: 8, h: 8, m: 11 },
  { w: 9, h: 9, m: 14 },
  { w: 9, h: 9, m: 16 },
];

const SP_CLEAR_BASE = 100;            // every cleared board
const SP_CLEAR_PER_RUNG = 40;         // ...plus this much per ladder rung
const SP_SPEED_BONUS_MAX = 60;        // ...plus a bonus that decays with time
const SP_SPEED_DECAY_TICKS = 6;       // 1 point per 6 ticks; gone after 18 s
const SP_STREAK_STEP = 25;            // ...plus this per consecutive clear
const SP_STREAK_CAP = 5;              // ...capped, so one long run can't run away

function spRung(st) {
  return Math.min(st.cleared, SP_LADDER.length - 1);
}

function spRng(st) {
  st.rng = (Math.imul(st.rng, 1664525) + 1013904223) >>> 0;
  return st.rng / 4294967296;
}

function spNeighbors(b, c) {
  const x = c % b.w;
  const y = (c - x) / b.w;
  const out = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= b.w || ny < 0 || ny >= b.h) continue;
      out.push(ny * b.w + nx);
    }
  }
  return out;
}

function spDeal(st) {
  const spec = SP_LADDER[spRung(st)];
  const n = spec.w * spec.h;
  st.board = {
    w: spec.w,
    h: spec.h,
    m: spec.m,
    mine: new Array(n).fill(0),
    adj: new Array(n).fill(0),
    open: new Array(n).fill(0),
    flag: new Array(n).fill(0),
    placed: false,
    opened: 0,
    flags: 0,
    boom: false,
    boomAt: -1,
    startTick: st.tick,
  };
  st.boardsDealt += 1;
}

function spInitState(seed) {
  const st = {
    rng: (Number(seed) >>> 0) || 1,
    tick: 0,
    penalty: 0,
    score: 0,
    cleared: 0,
    streak: 0,
    bestStreak: 0,
    booms: 0,
    opened: 0,
    boardsDealt: 0,
    board: null,
    over: false,
  };
  spDeal(st);
  return st;
}

// Mines are placed on the FIRST OPEN of each board, never before, and never
// inside the 3×3 around that cell — so the opening click always breaks a hole
// open instead of ending the board on a coin flip. Deterministic given the
// stream position and the clicked cell, which is all the replay needs.
function spPlaceMines(st, safe) {
  const b = st.board;
  const n = b.w * b.h;
  const sx = safe % b.w;
  const sy = (safe - sx) / b.w;
  let cand = [];
  for (let i = 0; i < n; i += 1) {
    const x = i % b.w;
    const y = (i - x) / b.w;
    if (Math.abs(x - sx) <= 1 && Math.abs(y - sy) <= 1) continue;
    cand.push(i);
  }
  // A board too cramped to keep a whole 3×3 clear falls back to sparing only
  // the clicked cell. No rung on the ladder needs this; it exists so the
  // function is total for any future SP_LADDER edit.
  if (cand.length < b.m) {
    cand = [];
    for (let i = 0; i < n; i += 1) if (i !== safe) cand.push(i);
  }
  for (let k = 0; k < b.m; k += 1) {
    const j = k + Math.floor(spRng(st) * (cand.length - k));
    const t = cand[k];
    cand[k] = cand[j];
    cand[j] = t;
    b.mine[cand[k]] = 1;
  }
  for (let i = 0; i < n; i += 1) {
    if (b.mine[i]) { b.adj[i] = -1; continue; }
    let a = 0;
    const nbs = spNeighbors(b, i);
    for (let q = 0; q < nbs.length; q += 1) if (b.mine[nbs[q]]) a += 1;
    b.adj[i] = a;
  }
  b.placed = true;
}

// Reveal `start`, cascading through the zero region. Flagged cells are left
// alone by the cascade, exactly as every desktop Minesweeper does it. A mine
// can only ever be hit at `start` — the cascade only expands out of cells with
// no adjacent mines — so the outcome does not depend on stack order.
function spRevealFrom(st, start) {
  const b = st.board;
  const stack = [start];
  while (stack.length) {
    const c = stack.pop();
    if (b.open[c] || b.flag[c]) continue;
    b.open[c] = 1;
    b.opened += 1;
    st.opened += 1;
    if (b.mine[c]) { b.boom = true; b.boomAt = c; return; }
    if (b.adj[c] !== 0) continue;
    const nbs = spNeighbors(b, c);
    for (let q = 0; q < nbs.length; q += 1) {
      const nb = nbs[q];
      if (!b.open[nb] && !b.flag[nb]) stack.push(nb);
    }
  }
}

// Resolve whatever the last move did to the board: a detonation costs the
// board, the streak and five seconds; a full clear pays out and deals the next
// rung. Either way the player is handed a fresh board in the same instant.
function spSettle(st) {
  const b = st.board;
  if (b.boom) {
    st.booms += 1;
    st.streak = 0;
    st.penalty += SP_MINE_PENALTY_TICKS;
    if (st.tick + st.penalty >= SP_ROUND_TICKS) { st.over = true; return; }
    spDeal(st);
    return;
  }
  if (!b.placed || b.opened !== b.w * b.h - b.m) return;

  const rung = spRung(st);
  const spent = st.tick - b.startTick;
  const speed = Math.max(0, SP_SPEED_BONUS_MAX - Math.floor(spent / SP_SPEED_DECAY_TICKS));
  st.streak += 1;
  if (st.streak > st.bestStreak) st.bestStreak = st.streak;
  const streakBonus = Math.min(st.streak - 1, SP_STREAK_CAP) * SP_STREAK_STEP;
  st.score += SP_CLEAR_BASE + SP_CLEAR_PER_RUNG * rung + speed + streakBonus;
  st.cleared += 1;
  spDeal(st);
}

// One clock tick. Carries no input: the round's length is the server's to
// decide, so the clock advances on its own and moves are applied against it.
function spTick(st) {
  if (st.over) return;
  st.tick += 1;
  if (st.tick + st.penalty >= SP_ROUND_TICKS) st.over = true;
}

// One input. Returns false when the move is not legal against this board —
// the client only logs moves this accepted, so on replay a false means the two
// sides disagree and the run is not scoreable.
function spApplyMove(st, action, cell) {
  if (st.over) return false;
  const b = st.board;
  if (!b) return false;
  if (!Number.isInteger(cell) || cell < 0 || cell >= b.w * b.h) return false;

  if (action === SP_FLAG) {
    if (b.open[cell]) return false;
    if (b.flag[cell]) { b.flag[cell] = 0; b.flags -= 1; }
    else { b.flag[cell] = 1; b.flags += 1; }
    return true;
  }

  if (action === SP_OPEN) {
    if (b.flag[cell]) return false;   // a flag protects the cell under it
    if (b.open[cell]) return false;   // already open — that is what a chord is for
    if (!b.placed) spPlaceMines(st, cell);
    spRevealFrom(st, cell);
    spSettle(st);
    return true;
  }

  if (action === SP_CHORD) {
    if (!b.open[cell]) return false;
    const need = b.adj[cell];
    if (need <= 0) return false;
    const nbs = spNeighbors(b, cell);
    let flags = 0;
    const hidden = [];
    for (let q = 0; q < nbs.length; q += 1) {
      const nb = nbs[q];
      if (b.flag[nb]) flags += 1;
      else if (!b.open[nb]) hidden.push(nb);
    }
    if (flags !== need) return false;   // not satisfied — nothing to chord
    if (!hidden.length) return false;   // nothing left to open under it
    for (let q = 0; q < hidden.length; q += 1) {
      spRevealFrom(st, hidden[q]);
      if (b.boom) break;                // the rest of the neighbours never open
    }
    spSettle(st);
    return true;
  }

  return false;
}

// Drive the whole round from seed + move log. Both sides run this: the client
// only to sanity-check itself, the server to decide the score. Moves are
// grouped by tick, so several inputs inside one 50 ms tick replay in order.
function spReplay(seed, moves) {
  const st = spInitState(seed);
  let mi = 0;
  while (mi < moves.length && moves[mi].tick === 0) {
    if (!spApplyMove(st, moves[mi].a, moves[mi].c)) return { ok: false, atMove: mi };
    mi += 1;
  }
  for (let t = 1; t <= SP_ROUND_TICKS && !st.over; t += 1) {
    spTick(st);
    while (mi < moves.length && moves[mi].tick === t) {
      if (st.over) break;
      if (!spApplyMove(st, moves[mi].a, moves[mi].c)) return { ok: false, atMove: mi };
      mi += 1;
    }
  }
  // Moves left over claim a tick the round never reached.
  if (mi < moves.length) return { ok: false, atMove: mi };
  return {
    ok: true,
    score: Math.min(SP_MAX_SCORE, st.score),
    rawScore: st.score,
    ticks: st.tick,
    cleared: st.cleared,
    booms: st.booms,
    bestStreak: st.bestStreak,
    opened: st.opened,
    boardsDealt: st.boardsDealt,
    over: st.over,
  };
}
// ── PARITY BLOCK END ────────────────────────────────────────────────────────

// The biggest board any rung can deal. Derived rather than written down so a
// SP_LADDER edit can never leave this behind — spApplyMove still bounds every
// cell against the ACTUAL board; this only rejects obvious garbage up front.
const SP_MAX_CELLS = SP_LADDER.reduce((m, r) => Math.max(m, r.w * r.h), 0);

const ROUND_EXPIRES_SECONDS = 1800;
const PRIZES = [1000, 500, 200];

// THE anti-cheat guard. Minesweeper over a seed the client already holds is
// exactly what an offline solver is good at, so the defence is not a per-move
// minimum („Kulki G6"'s guard) but the clock itself: the round IS a tick
// counter, and a submitted round must have taken at least as much WALL CLOCK
// as the ticks it claims. Forging a full 1800-tick log therefore costs 90 real
// seconds — the same 90 seconds an honest player spends. Note this is measured
// against the ticks ACTUALLY SIMULATED, not against SP_ROUND_TICKS: mine
// penalties end a round early, and an honest run full of detonations must not
// be rejected for finishing at second 68.
const SP_TIME_GRACE_MS = 2500;

// Hero score_bonus items are worth this many Saper points each. A good round
// lands near 2200, so ×20 makes a +5 item worth 100 — a visible edge, nowhere
// near enough to decide the week on its own.
const SP_ITEM_SCORE_PER_POINT = 20;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function gameError(message) {
  const err = new Error(message);
  err.isGame = true;
  return err;
}

function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// The client logs { tick, a, c } per ACCEPTED input. Ticks are non-decreasing
// rather than strictly increasing: one 50 ms tick can hold several inputs, and
// a fast player chording twice in the same frame is ordinary play, not a
// forgery signal.
function parseMoves(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu ruchów rundy.");
  if (value.length > SP_MAX_MOVES) throw gameError("Za dużo ruchów w rundzie.");
  let previousTick = 0;
  return value.map((move) => {
    const tick = asInt(move?.tick, NaN);
    const a = asInt(move?.a, NaN);
    const c = asInt(move?.c, NaN);
    if (!Number.isFinite(tick) || tick < 0 || tick > SP_ROUND_TICKS) throw gameError("Nieprawidłowy ruch.");
    if (tick < previousTick) throw gameError("Ruchy poza kolejnością.");
    previousTick = tick;
    if (a !== SP_OPEN && a !== SP_FLAG && a !== SP_CHORD) throw gameError("Nieznany rodzaj ruchu.");
    if (!Number.isFinite(c) || c < 0 || c >= SP_MAX_CELLS) throw gameError("Nieprawidłowe pole.");
    return { tick, a, c };
  });
}

async function requireUser(req) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) throw gameError("Musisz być zalogowany.");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) throw new Error("Missing Supabase environment.");

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) throw gameError("Sesja wygasła. Zaloguj się ponownie.");
  return data.user;
}

async function getStrongestHeroEffect(tx, userId, game) {
  try {
    const rows = await tx`
      select d.slug, d.name, d.emoji, d.effect_game, d.effect_type, d.effect_value
      from public.hero_item_instances i
      join public.hero_item_defs d on d.id = i.item_def_id
      where i.owner_id = ${userId}
        and d.is_active = true
        and (i.expires_at is null or i.expires_at > now())
        and (
          d.effect_game = ${game}
          or (
            ${game} in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz', 'popup_panic', 'tetris', 'bubble_breaker', 'saper')
            and d.effect_type = 'score_bonus'
            and d.effect_game in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz', 'popup_panic', 'tetris', 'bubble_breaker', 'saper')
          )
        )
      order by d.effect_value desc, d.price desc, d.slug
      limit 1
    `;
    return rows[0] ?? null;
  } catch (err) {
    console.warn("Hero item effects unavailable:", err?.message ?? err);
    return null;
  }
}

function mapRows(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    base_score: asInt(row.base_score, asInt(row.score)),
    item_bonus: asInt(row.item_bonus),
    boards_cleared: asInt(row.boards_cleared),
    boards_dealt: asInt(row.boards_dealt),
    booms: asInt(row.booms),
    best_streak: asInt(row.best_streak),
    cells_opened: asInt(row.cells_opened),
    moves: asInt(row.moves),
    duration_ms: asInt(row.duration_ms),
    rounds_played: asInt(row.rounds_played),
    accuracy: asNumber(row.accuracy),
  }));
}

function mapAwards(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    duration_ms: asInt(row.duration_ms),
    prize_coins: asInt(row.prize_coins),
  }));
}

async function loadState(userId) {
  if (!db) throw new Error("Database is not configured.");

  const [profile] = await db`
    select id, nick, coins
    from public.profiles
    where id = ${userId}
  `;
  if (!profile) throw gameError("Profil nie istnieje.");

  const [weekRow] = await db`select public.saper_week_start(now()) as week_start`;
  const weekly = await db`
    select *
    from public.saper_current_week
    order by rank
    limit 20
  `;
  const allTime = await db`
    select *
    from public.saper_all_time
    order by rank
    limit 20
  `;
  const awards = await db`
    select *
    from public.saper_recent_awards
    order by week_start desc, rank asc
    limit 12
  `;
  const [myWeekly] = await db`
    select *
    from public.saper_current_week
    where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select *
    from public.saper_all_time
    where user_id = ${userId}
  `;

  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    weekStart: weekRow?.week_start,
    prizes: PRIZES,
    weekly: mapRows(weekly),
    allTime: mapRows(allTime),
    awards: mapAwards(awards),
    myWeekly: myWeekly ? mapRows([myWeekly])[0] : null,
    myAllTime: myAllTime ? mapRows([myAllTime])[0] : null,
  };
}

async function startRound(userId) {
  if (!db) throw new Error("Database is not configured.");

  const [profile] = await db`
    select id, nick, coins
    from public.profiles
    where id = ${userId}
  `;
  if (!profile) throw gameError("Profil nie istnieje.");

  const seed = Math.floor(Math.random() * 2147483647) + 1;
  const [round] = await db`
    insert into public.saper_rounds
      (user_id, nick_snapshot, seed, expires_at)
    values
      (${userId}, ${profile.nick}, ${seed}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
    returning id, seed, started_at, expires_at
  `;

  return {
    ...(await loadState(userId)),
    round: {
      id: round.id,
      seed: asInt(round.seed),
      startedAt: round.started_at,
      serverNow: new Date().toISOString(),
      expiresAt: round.expires_at,
    },
  };
}

async function submitRound(userId, body) {
  if (!db) throw new Error("Database is not configured.");
  const roundId = String(body.roundId ?? "");
  if (!roundId) throw gameError("Brak rundy do zapisania.");
  const moves = parseMoves(body.moves);

  const effect = await getStrongestHeroEffect(db, userId, "saper");

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.saper_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");

    const replay = spReplay(asInt(round.seed), moves);
    if (!replay.ok) throw gameError("Niepoprawny ruch w zapisie rundy.");
    // The clock is the round. A log that stops before the 90 seconds ran out
    // is a round still in progress, not a result — otherwise the best strategy
    // would be to bail out the moment the score peaks.
    if (!replay.over) throw gameError("Runda jeszcze trwa.");

    const elapsedMs = Date.now() - new Date(round.started_at).getTime();
    if (elapsedMs + SP_TIME_GRACE_MS < replay.ticks * SP_TICK_MS) {
      throw gameError("Runda rozegrana za szybko.");
    }

    const baseScore = Math.max(0, Math.min(SP_MAX_SCORE, replay.score));
    const bonus = effect?.effect_type === "score_bonus"
      ? Math.max(0, asInt(effect.effect_value, 0)) * SP_ITEM_SCORE_PER_POINT
      : 0;
    const scoreValue = Math.min(SP_MAX_SCORE, baseScore + bonus);
    const itemEffect = bonus > 0 && scoreValue > baseScore ? {
      slug: effect.slug,
      name: effect.name,
      type: effect.effect_type,
      value: Number(effect.effect_value),
      bonus: scoreValue - baseScore,
    } : null;
    // "accuracy" carries the share of dealt boards actually disarmed. Every
    // seasonal scores table has that column and index.html tiebreaks the live
    // podium on it, so the name is fixed even though the quantity is
    // game-specific.
    const resolved = replay.cleared + replay.booms;
    const clearRate = resolved > 0
      ? Math.min(100, Math.round((replay.cleared / resolved) * 10000) / 100)
      : 0;

    await tx`
      update public.saper_rounds
         set submitted_at = now()
       where id = ${round.id}
    `;

    const [inserted] = await tx`
      insert into public.saper_scores
        (round_id, user_id, nick_snapshot, week_start, score, boards_cleared, boards_dealt, booms, best_streak, cells_opened, moves, duration_ms, accuracy, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.saper_week_start(now()),
          ${scoreValue},
          ${replay.cleared},
          ${replay.boardsDealt},
          ${replay.booms},
          ${replay.bestStreak},
          ${replay.opened},
          ${moves.length},
          ${Math.max(0, Math.min(2147483647, elapsedMs))},
          ${clearRate},
          ${JSON.stringify({
            seed: asInt(round.seed),
            client_score: asInt(body.score, 0),
            server_validated: true,
            ticks: replay.ticks,
            base_score: baseScore,
            item_effect: itemEffect,
          })}::jsonb
        )
      returning *
    `;

    return { inserted, itemEffect, replay };
  });

  return {
    ...(await loadState(userId)),
    score: {
      id: score.inserted.id,
      score: asInt(score.inserted.score),
      boards_cleared: asInt(score.inserted.boards_cleared),
      boards_dealt: asInt(score.inserted.boards_dealt),
      booms: asInt(score.inserted.booms),
      best_streak: asInt(score.inserted.best_streak),
      moves: asInt(score.inserted.moves),
      submitted_at: score.inserted.submitted_at,
      itemEffect: score.itemEffect,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "state");

    let result;
    if (action === "state") result = await loadState(user.id);
    else if (action === "start") result = await startRound(user.id);
    else if (action === "submit") result = await submitRound(user.id, body);
    else throw gameError("Nieznana akcja.");

    return json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
