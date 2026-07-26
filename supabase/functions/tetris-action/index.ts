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

// ─────────────────────────────────────────────────────────────────────────────
// „Tetris G6" (tetris) — the classic falling-block stacker in a 10×20 well.
//
// PARITY CONTRACT: the TT_* constants and the ttInitState / ttRng / ttDrawPiece /
// ttCollides / ttSpawn / ttLockPiece / ttTryMove / ttTryRotate / ttGrounded /
// ttTouchLock / ttApplyAction / ttAdvanceTick / ttReplay transition rules below
// must stay byte-for-byte equivalent to the TT_* block in games/tetris.js. The
// client plays this exact deterministic simulation (seeded LCG 7-bag) and logs
// only the actions it took per tick; the server replays seed + events to derive
// the trusted score, so a client cannot claim lines it never cleared.
// ─────────────────────────────────────────────────────────────────────────────
const TT_TICK_MS = 50;
const TT_W = 10;                   // well width in cells
const TT_H = 20;                   // well height in cells
const TT_SPAWN_X = 3;              // x of the 4×4 piece box at spawn
// The round ends on a TOP-OUT, the way Tetris always has — the difficulty curve
// is the timer. TT_MAX_TICKS is only a safety cap on replay cost. A fixed short
// round was tried (60 s, 2026-07-26) and reverted the same day: it turned the
// game into a hard-drop sprint with no room for the stack to develop.
const TT_MAX_TICKS = 12000;        // 10 min hard cap
const TT_MAX_EVENTS = 12000;       // max input events accepted per round
const TT_MAX_ACTIONS_PER_TICK = 6; // more than this inside one 50 ms tick is bot-grade spam
const TT_MAX_SCORE = 9999;         // anti-cheat ceiling
const TT_LOCK_TICKS = 10;          // 0.5 s lock delay once the piece is grounded
const TT_MAX_LOCK_RESETS = 12;     // a move/rotate can refresh the lock delay this often
const TT_LINES_PER_LEVEL = 10;     // Tetris Guideline cadence
const TT_MAX_LEVEL = 15;
// Small, line-only scoring on purpose: a hero score_bonus item is worth its raw
// effect_value here (TT_ITEM_SCORE_PER_POINT = 1), so +5 stays a real chunk of
// a run rather than rounding noise against three-digit line scores. Drop points
// are 0 for the same reason — at 2/cell a piece-spamming run would out-score
// every line cleared. Deliberately NOT multiplied by level: the level
// multiplier is what pushed the old scale into five digits.
const TT_LINE_SCORES = [0, 1, 3, 5, 8]; // flat — NOT multiplied by level
const TT_SOFT_DROP_POINTS = 0;     // per cell
const TT_HARD_DROP_POINTS = 0;     // per cell
const TT_KICKS = [0, -1, 1, -2, 2]; // horizontal wall-kick offsets tried on rotation

// Actions — the only thing the client logs.
const TT_A_LEFT = 0, TT_A_RIGHT = 1, TT_A_CW = 2, TT_A_CCW = 3, TT_A_SOFT = 4, TT_A_HARD = 5;

// Each piece is 4 rotation states as a 4×4 bitmask; bit 0x8000 is the top-left
// cell, reading left→right then top→bottom.
const TT_PIECES = [
  [0x0F00, 0x2222, 0x00F0, 0x4444], // I
  [0x8E00, 0x6440, 0x0E20, 0x44C0], // J
  [0x2E00, 0x4460, 0x0E80, 0xC440], // L
  [0x6600, 0x6600, 0x6600, 0x6600], // O
  [0x6C00, 0x4620, 0x06C0, 0x8C40], // S
  [0x4E00, 0x4640, 0x0E40, 0x4C40], // T
  [0xC600, 0x2640, 0x0C60, 0x4C80], // Z
];

// ~950 ms/row at level 1 down to 100 ms at level 10 — the classic Tetris
// Guideline curve, which is what makes the early stack feel controllable.
function ttGravityTicks(level) {
  return Math.max(2, 21 - level * 2);
}

function ttRng(st) {
  st.rngState = (Math.imul(st.rngState, 1664525) + 1013904223) >>> 0;
  return st.rngState / 4294967296;
}

// 7-bag: refill + Fisher-Yates shuffle off the shared rng, then pop.
function ttDrawPiece(st) {
  if (!st.bag.length) {
    st.bag = [0, 1, 2, 3, 4, 5, 6];
    for (let i = st.bag.length - 1; i > 0; i -= 1) {
      const j = Math.floor(ttRng(st) * (i + 1));
      const tmp = st.bag[i]; st.bag[i] = st.bag[j]; st.bag[j] = tmp;
    }
  }
  return st.bag.pop();
}

function ttCollides(st, piece, rot, px, py) {
  const mask = TT_PIECES[piece][rot & 3];
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      if (!(mask & (0x8000 >> (r * 4 + c)))) continue;
      const x = px + c;
      const y = py + r;
      if (x < 0 || x >= TT_W || y >= TT_H) return true;
      if (y >= 0 && st.board[y * TT_W + x]) return true;
    }
  }
  return false;
}

function ttSpawn(st) {
  st.piece = st.next;
  st.next = ttDrawPiece(st);
  st.rot = 0;
  st.px = TT_SPAWN_X;
  st.py = 0;
  st.gravity = 0;
  st.lockTimer = -1;
  st.lockResets = 0;
  st.pieces += 1;
  if (ttCollides(st, st.piece, st.rot, st.px, st.py)) st.dead = true;
}

function ttInitState(seed) {
  const st = {
    rngState: (Number(seed) >>> 0) || 1,
    tick: 0,
    board: new Array(TT_W * TT_H).fill(0), // 0 = empty, else piece index + 1
    bag: [],
    piece: 0, next: 0, rot: 0, px: TT_SPAWN_X, py: 0,
    gravity: 0,
    lockTimer: -1,  // -1 = airborne
    lockResets: 0,
    lines: 0, level: 1, score: 0, pieces: 0,
    dead: false,
  };
  st.next = ttDrawPiece(st);
  ttSpawn(st);
  return st;
}

function ttLockPiece(st, ev) {
  const mask = TT_PIECES[st.piece][st.rot & 3];
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      if (!(mask & (0x8000 >> (r * 4 + c)))) continue;
      const x = st.px + c;
      const y = st.py + r;
      if (y >= 0 && y < TT_H && x >= 0 && x < TT_W) st.board[y * TT_W + x] = st.piece + 1;
    }
  }
  let cleared = 0;
  for (let y = TT_H - 1; y >= 0; y -= 1) {
    let full = true;
    for (let x = 0; x < TT_W; x += 1) {
      if (!st.board[y * TT_W + x]) { full = false; break; }
    }
    if (!full) continue;
    for (let yy = y; yy > 0; yy -= 1) {
      for (let x = 0; x < TT_W; x += 1) st.board[yy * TT_W + x] = st.board[(yy - 1) * TT_W + x];
    }
    for (let x = 0; x < TT_W; x += 1) st.board[x] = 0;
    cleared += 1;
    y += 1; // rows shifted down — re-test this line
  }
  if (cleared > 0) {
    st.lines += cleared;
    st.score += TT_LINE_SCORES[cleared];
    st.level = Math.min(TT_MAX_LEVEL, 1 + Math.floor(st.lines / TT_LINES_PER_LEVEL));
  }
  if (ev) { ev.locks += 1; ev.cleared += cleared; }
  ttSpawn(st);
}

function ttTryMove(st, dx, dy) {
  if (ttCollides(st, st.piece, st.rot, st.px + dx, st.py + dy)) return false;
  st.px += dx;
  st.py += dy;
  return true;
}

function ttTryRotate(st, dir) {
  const nrot = (st.rot + (dir > 0 ? 1 : 3)) & 3;
  for (let i = 0; i < TT_KICKS.length; i += 1) {
    const nx = st.px + TT_KICKS[i];
    if (!ttCollides(st, st.piece, nrot, nx, st.py)) { st.rot = nrot; st.px = nx; return true; }
  }
  return false;
}

function ttGrounded(st) {
  return ttCollides(st, st.piece, st.rot, st.px, st.py + 1);
}

// A successful move/rotate refreshes the lock delay a limited number of times.
function ttTouchLock(st) {
  if (st.lockTimer >= 0 && st.lockResets < TT_MAX_LOCK_RESETS) {
    st.lockTimer = 0;
    st.lockResets += 1;
  }
}

function ttApplyAction(st, a, ev) {
  if (st.dead) return;
  if (a === TT_A_LEFT)  { if (ttTryMove(st, -1, 0)) ttTouchLock(st); return; }
  if (a === TT_A_RIGHT) { if (ttTryMove(st, 1, 0))  ttTouchLock(st); return; }
  if (a === TT_A_CW)    { if (ttTryRotate(st, 1))   ttTouchLock(st); return; }
  if (a === TT_A_CCW)   { if (ttTryRotate(st, -1))  ttTouchLock(st); return; }
  if (a === TT_A_SOFT) {
    if (ttTryMove(st, 0, 1)) { st.score += TT_SOFT_DROP_POINTS; st.gravity = 0; }
    return;
  }
  if (a === TT_A_HARD) {
    let dist = 0;
    while (ttTryMove(st, 0, 1)) dist += 1;
    st.score += dist * TT_HARD_DROP_POINTS;
    ttLockPiece(st, ev);
  }
}

// One simulation tick: the player's actions for THIS tick (in press order),
// then gravity, then the lock-delay countdown.
function ttAdvanceTick(st, actions) {
  st.tick += 1;
  const ev = { cleared: 0, locks: 0 };
  if (actions && actions.length) {
    for (let i = 0; i < actions.length; i += 1) {
      ttApplyAction(st, actions[i], ev);
      if (st.dead) return ev;
    }
  }
  st.gravity += 1;
  if (st.gravity >= ttGravityTicks(st.level)) {
    st.gravity = 0;
    ttTryMove(st, 0, 1);
  }
  if (ttGrounded(st)) {
    st.lockTimer = st.lockTimer < 0 ? 0 : st.lockTimer + 1;
    if (st.lockTimer >= TT_LOCK_TICKS) ttLockPiece(st, ev);
  } else {
    st.lockTimer = -1;
    st.lockResets = 0;
  }
  return ev;
}

function ttReplay(seed, events, untilTick) {
  const st = ttInitState(seed);
  const capped = Math.max(0, Math.min(TT_MAX_TICKS, untilTick));
  let ei = 0;
  let diedAtTick = null;
  while (st.tick < capped) {
    const nextTick = st.tick + 1;
    const acts = [];
    while (ei < events.length && events[ei].tick === nextTick) { acts.push(events[ei].a); ei += 1; }
    ttAdvanceTick(st, acts);
    if (st.dead) { diedAtTick = st.tick; break; }
  }
  return {
    score: Math.min(TT_MAX_SCORE, st.score),
    lines: st.lines,
    level: st.level,
    pieces: st.pieces,
    endTick: diedAtTick ?? capped,
    died: diedAtTick != null,
    completed: diedAtTick == null && capped >= TT_MAX_TICKS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const ROUND_EXPIRES_SECONDS = 1800;
const PRIZES = [1000, 500, 200];
// Hero score_bonus items are worth this many Tetris points each. Line scoring is
// deliberately small (a quad is 8, a strong 60 s run lands ~20-40), so the raw
// +N of the other seasonal games is exactly the right scale here: a +5 item is
// worth more than a whole tetris.
const TT_ITEM_SCORE_PER_POINT = 1;

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

function parseEvents(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu ruchów rundy.");
  if (value.length > TT_MAX_EVENTS) throw gameError("Za dużo ruchów w rundzie.");
  let previousTick = 0;
  let sameTickCount = 0;
  return value.map((entry) => {
    const tick = asInt(entry?.tick, NaN);
    const a = asInt(entry?.a, NaN);
    if (!Number.isFinite(tick) || tick < 1 || tick > TT_MAX_TICKS) throw gameError("Nieprawidłowy ruch.");
    if (!Number.isFinite(a) || a < TT_A_LEFT || a > TT_A_HARD) throw gameError("Nieznany ruch.");
    if (tick < previousTick) throw gameError("Ruchy nie są uporządkowane.");
    sameTickCount = tick === previousTick ? sameTickCount + 1 : 1;
    if (sameTickCount > TT_MAX_ACTIONS_PER_TICK) throw gameError("Za dużo ruchów naraz.");
    previousTick = tick;
    return { tick, a };
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
            ${game} in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz', 'popup_panic', 'tetris')
            and d.effect_type = 'score_bonus'
            and d.effect_game in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz', 'popup_panic', 'tetris')
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
    lines: asInt(row.lines),
    level: asInt(row.level),
    pieces: asInt(row.pieces),
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

  const [weekRow] = await db`select public.tetris_week_start(now()) as week_start`;
  const weekly = await db`
    select *
    from public.tetris_current_week
    order by rank
    limit 20
  `;
  const allTime = await db`
    select *
    from public.tetris_all_time
    order by rank
    limit 20
  `;
  const awards = await db`
    select *
    from public.tetris_recent_awards
    order by week_start desc, rank asc
    limit 12
  `;
  const [myWeekly] = await db`
    select *
    from public.tetris_current_week
    where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select *
    from public.tetris_all_time
    where user_id = ${userId}
  `;

  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    weekStart: weekRow?.week_start,
    tickMs: TT_TICK_MS,
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
    insert into public.tetris_rounds
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
      tickMs: TT_TICK_MS,
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
  const events = parseEvents(body.events);
  const requestedTick = asInt(body.elapsedTicks, 0);
  if (requestedTick < 1 || requestedTick > TT_MAX_TICKS) throw gameError("Nieprawidłowy koniec rundy.");

  const effect = await getStrongestHeroEffect(db, userId, "tetris");

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.tetris_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");

    const actualElapsed = Date.now() - new Date(round.started_at).getTime();
    const actualTickCap = Math.floor((actualElapsed + 1500) / TT_TICK_MS);
    const endTick = requestedTick;
    if (events.some((entry) => entry.tick > endTick)) throw gameError("Ruch po końcu rundy.");
    if (endTick > actualTickCap) throw gameError("Runda jeszcze trwa.");

    const replay = ttReplay(asInt(round.seed), events, endTick);
    if (replay.endTick !== endTick) throw gameError("Runda zakończyła się wcześniej.");
    if (!replay.died && !replay.completed) throw gameError("Runda jeszcze trwa.");

    const baseScore = Math.max(0, Math.min(TT_MAX_SCORE, replay.score));
    const bonus = effect?.effect_type === "score_bonus"
      ? Math.max(0, asInt(effect.effect_value, 0)) * TT_ITEM_SCORE_PER_POINT
      : 0;
    const scoreValue = Math.min(TT_MAX_SCORE, baseScore + bonus);
    const itemEffect = bonus > 0 && scoreValue > baseScore ? {
      slug: effect.slug,
      name: effect.name,
      type: effect.effect_type,
      value: Number(effect.effect_value),
      bonus: scoreValue - baseScore,
    } : null;
    // "accuracy" carries stacking efficiency: cleared lines per piece placed.
    const efficiency = replay.pieces > 0
      ? Math.min(100, Math.round((replay.lines / replay.pieces) * 10000) / 100)
      : 0;

    await tx`
      update public.tetris_rounds
         set submitted_at = now()
       where id = ${round.id}
    `;

    const [inserted] = await tx`
      insert into public.tetris_scores
        (round_id, user_id, nick_snapshot, week_start, score, lines, level, pieces, moves, duration_ms, accuracy, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.tetris_week_start(now()),
          ${scoreValue},
          ${replay.lines},
          ${replay.level},
          ${replay.pieces},
          ${events.length},
          ${replay.endTick * TT_TICK_MS},
          ${efficiency},
          ${JSON.stringify({
            seed: asInt(round.seed),
            tick_ms: TT_TICK_MS,
            elapsed_ticks: replay.endTick,
            client_score: asInt(body.score, 0),
            server_validated: true,
            died: replay.died,
            completed: replay.completed,
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
      lines: asInt(score.inserted.lines),
      level: asInt(score.inserted.level),
      pieces: asInt(score.inserted.pieces),
      moves: asInt(score.inserted.moves),
      died: score.replay.died,
      completed: score.replay.completed,
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
