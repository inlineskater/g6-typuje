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
// „Kulki G6" (bubble_breaker) — Bubble Breaker / SameGame, the Windows Mobile
// classic. 15×15 board of 5-colour balls; tap a group of touching same-colour
// balls to pop it; balls fall, empty columns slide left; a group of n scores
// n×(n−1) and clearing the board is +1000.
//
// PARITY CONTRACT: the BB_* constants and bbIdx / bbRng / bbInitState /
// bbGroupAt / bbGroupPush / bbGroupScore / bbSettle / bbHasMove / bbRemaining /
// bbPopAt below must stay byte-for-byte equivalent to the fenced PARITY BLOCK
// in games/bubble-breaker.js, verified by scripts/bb-parity.mjs.
//
// This game is the cheapest replay in the whole rotation: there is no tick
// clock and no per-tick input, so a round is fully described by (seed, list of
// tapped cell indices). The client sends that list, the server replays it, and
// every pop must be legal — a fabricated group, a tap on an empty cell, or a
// single-ball tap all abort the submission.
// ─────────────────────────────────────────────────────────────────────────────

// ── PARITY BLOCK START ──────────────────────────────────────────────────────
const BB_COLS = 15;
const BB_ROWS = 15;
const BB_COLORS = 5;
const BB_MIN_GROUP = 2;
const BB_CLEAR_BONUS = 1000;   // board emptied completely
// Score ceiling. Total score over a full board is exactly BALLS × (average
// group size − 1), so even the fantasy board where all 225 balls arrive
// pre-sorted into five solid 45-ball blobs scores 225×44 = 9900, +1000 for the
// clear = 10900. 12000 leaves head room without being meaningless. Mirrors the
// `bubble_breaker` cap in supabase/arcade.sql.
const BB_MAX_SCORE = 12000;

function bbIdx(col, row) { return row * BB_COLS + col; }

function bbRng(st) {
  st.rngState = (Math.imul(st.rngState, 1664525) + 1013904223) >>> 0;
  return st.rngState / 4294967296;
}

function bbInitState(seed) {
  const st = {
    rngState: (Number(seed) >>> 0) || 1,
    cells: new Array(BB_COLS * BB_ROWS).fill(-1),
    // Cosmetic-only, but derived from the same deterministic stream so a
    // replay produces identical ids: lets the renderer animate a ball from
    // where it was to where it landed instead of teleporting the board.
    ids: new Array(BB_COLS * BB_ROWS).fill(0),
    nextId: 1,
    score: 0,
    popped: 0,
    pops: 0,
    best: 0,       // largest group popped this round
    cleared: false,
    over: false,
  };
  for (let i = 0; i < st.cells.length; i += 1) {
    st.cells[i] = Math.floor(bbRng(st) * BB_COLORS);
    st.ids[i] = st.nextId;
    st.nextId += 1;
  }
  return st;
}

// Every ball 4-connected to `start` sharing its colour. Returns [] on an empty
// cell. Same-colour balls touching only at a corner are NOT connected.
function bbGroupAt(cells, start) {
  const color = cells[start];
  if (color < 0) return [];
  const seen = new Set([start]);
  const stack = [start];
  const out = [];
  while (stack.length) {
    const idx = stack.pop();
    out.push(idx);
    const col = idx % BB_COLS;
    const row = (idx - col) / BB_COLS;
    if (col > 0)            bbGroupPush(cells, seen, stack, bbIdx(col - 1, row), color);
    if (col < BB_COLS - 1)  bbGroupPush(cells, seen, stack, bbIdx(col + 1, row), color);
    if (row > 0)            bbGroupPush(cells, seen, stack, bbIdx(col, row - 1), color);
    if (row < BB_ROWS - 1)  bbGroupPush(cells, seen, stack, bbIdx(col, row + 1), color);
  }
  return out;
}

function bbGroupPush(cells, seen, stack, idx, color) {
  if (seen.has(idx) || cells[idx] !== color) return;
  seen.add(idx);
  stack.push(idx);
}

function bbGroupScore(n) { return n < BB_MIN_GROUP ? 0 : n * (n - 1); }

// Balls drop to the bottom of their column, then non-empty columns slide left —
// the original's compaction, which is what keeps distant colours meeting.
function bbSettle(st) {
  const cells = st.cells, ids = st.ids;
  for (let col = 0; col < BB_COLS; col += 1) {
    let write = BB_ROWS - 1;
    for (let row = BB_ROWS - 1; row >= 0; row -= 1) {
      const from = bbIdx(col, row);
      if (cells[from] < 0) continue;
      const to = bbIdx(col, write);
      if (to !== from) {
        cells[to] = cells[from]; ids[to] = ids[from];
        cells[from] = -1; ids[from] = 0;
      }
      write -= 1;
    }
  }
  let writeCol = 0;
  for (let col = 0; col < BB_COLS; col += 1) {
    if (cells[bbIdx(col, BB_ROWS - 1)] < 0) continue;   // empty column: skip
    if (writeCol !== col) {
      for (let row = 0; row < BB_ROWS; row += 1) {
        const from = bbIdx(col, row), to = bbIdx(writeCol, row);
        cells[to] = cells[from]; ids[to] = ids[from];
        cells[from] = -1; ids[from] = 0;
      }
    }
    writeCol += 1;
  }
}

function bbHasMove(cells) {
  for (let idx = 0; idx < cells.length; idx += 1) {
    const color = cells[idx];
    if (color < 0) continue;
    const col = idx % BB_COLS;
    const row = (idx - col) / BB_COLS;
    if (col < BB_COLS - 1 && cells[bbIdx(col + 1, row)] === color) return true;
    if (row < BB_ROWS - 1 && cells[bbIdx(col, row + 1)] === color) return true;
  }
  return false;
}

function bbRemaining(cells) {
  let n = 0;
  for (let i = 0; i < cells.length; i += 1) if (cells[i] >= 0) n += 1;
  return n;
}

// The one state transition. Returns null when the tap is not a legal pop.
function bbPopAt(st, start) {
  if (st.over) return null;
  const group = bbGroupAt(st.cells, start);
  if (group.length < BB_MIN_GROUP) return null;

  const before = new Map();
  for (let i = 0; i < st.cells.length; i += 1) if (st.cells[i] >= 0) before.set(st.ids[i], i);

  const gained = bbGroupScore(group.length);
  group.forEach(idx => { st.cells[idx] = -1; st.ids[idx] = 0; });
  bbSettle(st);

  st.score += gained;
  st.popped += group.length;
  st.pops += 1;
  if (group.length > st.best) st.best = group.length;

  const left = bbRemaining(st.cells);
  if (left === 0) {
    st.cleared = true;
    st.score += BB_CLEAR_BONUS;
  }
  if (!bbHasMove(st.cells)) st.over = true;

  const moved = [];
  for (let i = 0; i < st.cells.length; i += 1) {
    if (st.cells[i] < 0) continue;
    const from = before.get(st.ids[i]);
    if (from != null && from !== i) moved.push({ to: i, from });
  }
  return { group, gained, moved, remaining: left };
}
// ── PARITY BLOCK END ────────────────────────────────────────────────────────

// A board of 225 balls popped two at a time is 112 groups; nothing legal can
// exceed that, so anything longer is a malformed payload rather than a run.
const BB_MAX_MOVES = Math.ceil((BB_COLS * BB_ROWS) / BB_MIN_GROUP);

// Unlike every other seasonal game, Bubble Breaker has NO clock in its rules —
// the sim would happily accept 60 optimal pops submitted in the same
// millisecond. That makes it the one game in the rotation where an offline
// solver over the server-issued seed is cheap, so wall-clock is the guard: a
// submitted round must have taken at least this long per pop. 150 ms is 6.7
// pops/second, comfortably above what a human can click even with the mouse
// hover-select path, while an instant scripted submit fails outright.
const BB_MIN_MS_PER_MOVE = 150;
// Clock skew / a slow round-trip shouldn't fail an honest short run.
const BB_TIME_GRACE_MS = 1500;

function bbReplay(seed, moves) {
  const st = bbInitState(seed);
  for (let i = 0; i < moves.length; i += 1) {
    const res = bbPopAt(st, moves[i]);
    // An illegal tap means the client's board and ours disagree — either a
    // parity break or a forged move list. Either way the run is not scoreable.
    if (!res) return { ok: false, atMove: i };
  }
  return {
    ok: true,
    score: Math.min(BB_MAX_SCORE, st.score),
    rawScore: st.score,
    popped: st.popped,
    pops: st.pops,
    best: st.best,
    cleared: st.cleared,
    remaining: bbRemaining(st.cells),
    over: st.over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const ROUND_EXPIRES_SECONDS = 1800;
const PRIZES = [1000, 500, 200];
// Hero score_bonus items are worth this many Kulki points each. Unlike Tetris
// (where a run scores in the dozens and 1:1 is right), a decent Kulki round
// lands in the 400-900 range, so a raw +5 would be invisible; ×10 makes a
// +5 item worth 50 points — a real edge, still far short of deciding the week.
const BB_ITEM_SCORE_PER_POINT = 10;

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

// The client logs one plain integer per pop: the index of the cell it tapped.
function parseMoves(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu ruchów rundy.");
  if (!value.length) throw gameError("Runda bez żadnego ruchu.");
  if (value.length > BB_MAX_MOVES) throw gameError("Za dużo ruchów w rundzie.");
  return value.map((entry) => {
    const idx = asInt(entry, NaN);
    if (!Number.isFinite(idx) || idx < 0 || idx >= BB_COLS * BB_ROWS) {
      throw gameError("Nieprawidłowy ruch.");
    }
    return idx;
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
            ${game} in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz', 'popup_panic', 'tetris', 'bubble_breaker')
            and d.effect_type = 'score_bonus'
            and d.effect_game in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz', 'popup_panic', 'tetris', 'bubble_breaker')
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
    popped: asInt(row.popped),
    pops: asInt(row.pops),
    best_group: asInt(row.best_group),
    remaining: asInt(row.remaining),
    cleared: !!row.cleared,
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

  const [weekRow] = await db`select public.bubble_breaker_week_start(now()) as week_start`;
  const weekly = await db`
    select *
    from public.bubble_breaker_current_week
    order by rank
    limit 20
  `;
  const allTime = await db`
    select *
    from public.bubble_breaker_all_time
    order by rank
    limit 20
  `;
  const awards = await db`
    select *
    from public.bubble_breaker_recent_awards
    order by week_start desc, rank asc
    limit 12
  `;
  const [myWeekly] = await db`
    select *
    from public.bubble_breaker_current_week
    where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select *
    from public.bubble_breaker_all_time
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
    insert into public.bubble_breaker_rounds
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

  const effect = await getStrongestHeroEffect(db, userId, "bubble_breaker");

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.bubble_breaker_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");

    const elapsedMs = Date.now() - new Date(round.started_at).getTime();
    if (elapsedMs + BB_TIME_GRACE_MS < moves.length * BB_MIN_MS_PER_MOVE) {
      throw gameError("Runda rozegrana za szybko.");
    }

    const replay = bbReplay(asInt(round.seed), moves);
    if (!replay.ok) throw gameError("Niepoprawny ruch w zapisie rundy.");
    // The round genuinely ends only when no pair is left on the board. Bailing
    // out early is allowed (just don't submit) but is not a scoreable result —
    // otherwise the best strategy would be to stop the moment the score peaks.
    if (!replay.over) throw gameError("Runda jeszcze trwa.");

    const baseScore = Math.max(0, Math.min(BB_MAX_SCORE, replay.score));
    const bonus = effect?.effect_type === "score_bonus"
      ? Math.max(0, asInt(effect.effect_value, 0)) * BB_ITEM_SCORE_PER_POINT
      : 0;
    const scoreValue = Math.min(BB_MAX_SCORE, baseScore + bonus);
    const itemEffect = bonus > 0 && scoreValue > baseScore ? {
      slug: effect.slug,
      name: effect.name,
      type: effect.effect_type,
      value: Number(effect.effect_value),
      bonus: scoreValue - baseScore,
    } : null;
    // "accuracy" carries the share of the board actually cleared.
    const clearedPct = Math.min(100, Math.round((replay.popped / (BB_COLS * BB_ROWS)) * 10000) / 100);

    await tx`
      update public.bubble_breaker_rounds
         set submitted_at = now()
       where id = ${round.id}
    `;

    const [inserted] = await tx`
      insert into public.bubble_breaker_scores
        (round_id, user_id, nick_snapshot, week_start, score, popped, pops, best_group, cleared, remaining, moves, duration_ms, accuracy, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.bubble_breaker_week_start(now()),
          ${scoreValue},
          ${replay.popped},
          ${replay.pops},
          ${replay.best},
          ${replay.cleared},
          ${replay.remaining},
          ${moves.length},
          ${Math.max(0, Math.min(2147483647, elapsedMs))},
          ${clearedPct},
          ${JSON.stringify({
            seed: asInt(round.seed),
            client_score: asInt(body.score, 0),
            server_validated: true,
            cleared: replay.cleared,
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
      popped: asInt(score.inserted.popped),
      pops: asInt(score.inserted.pops),
      best_group: asInt(score.inserted.best_group),
      cleared: !!score.inserted.cleared,
      remaining: asInt(score.inserted.remaining),
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
