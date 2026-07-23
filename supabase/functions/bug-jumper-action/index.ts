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

// Course is procedurally generated per round from a seed drawn at `start`
// (same deterministic-seed pattern as snake-action/invoice-horde-action/
// popup-panic-action): the browser derives the identical lane/wall layout
// locally via bjGenerateCourse(seed) in index.html to play in real time, and
// this function re-derives it from the round's stored seed to replay +
// validate submitted moves. makeRng/generateCourse/bugColAt/cellBlocked/
// cellOpen must stay byte-for-byte identical to their index.html
// counterparts (bjMakeRng/bjGenerateCourse/bjBugColAt/bjCellBlocked/
// bjCellOpen).
const COURSE_ID = "bug_jumper_dynamic_v1";
const COURSE_VERSION = 4;
const BJ_COLS = 10;
const BJ_ROWS = 32;
const BJ_LANE_COUNT = 30;
const BJ_SAFE_ROWS = [10, 20, 30];
const BJ_BAND_HALF = 3;
const ROUND_DURATION_MS = 25_000;
const INPUT_COOLDOWN_MS = 100;
const MAX_SCORE_PER_ROUND = 30;
const BJ_SHAPES = [
  [4, 4, 4], // straight
  [4, 4, 6], // L, turning right late
  [4, 4, 3], // L, turning left late
  [4, 6, 3], // S, right then left
  [4, 3, 6], // S, left then right
  [3, 6, 3], // zigzag
];
const ROUND_EXPIRES_SECONDS = 120;
const MAX_MOVES_PER_ROUND = 400;
const MOVE_TIME_TOLERANCE_MS = 12;
const PRIZES = [100, 50, 25];

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

function mod(n, m) {
  return ((n % m) + m) % m;
}

function makeRng(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function generateCourse(seed) {
  const rng = makeRng(seed);
  // Shape comes from the seed itself (not an rng() draw) so a player's chosen
  // shape can be honored just by picking a seed with that remainder — see
  // startRound below.
  const shapeIndex = mod(Number(seed) >>> 0, BJ_SHAPES.length);
  const shape = BJ_SHAPES[shapeIndex];
  const lanes = [];
  for (let row = 1; row <= BJ_LANE_COUNT; row++) {
    if (BJ_SAFE_ROWS.includes(row)) {
      lanes.push({ safe: true, dir: 1, intervalMs: 1, phaseMs: 0, bugs: [], bandStart: 0, bandEnd: BJ_COLS - 1 });
      continue;
    }
    const segIdx = row <= 10 ? 0 : row <= 20 ? 1 : 2;
    const center = shape[segIdx];
    const bandStart = center - BJ_BAND_HALF;
    const bandEnd = center + BJ_BAND_HALF;
    const bandWidth = bandEnd - bandStart + 1;
    const rowProgress = (row - 1) / (BJ_LANE_COUNT - 1);
    const baseInterval = 700 - rowProgress * 300;
    const intervalMs = Math.max(260, Math.round(baseInterval + (rng() - 0.5) * 80));
    const phaseMs = Math.floor(rng() * 300);
    const dir = rng() < 0.5 ? 1 : -1;
    const bugCount = rng() < 0.25 ? 2 : 1;
    const bugs = [];
    for (let i = 0; i < bugCount; i += 1) {
      const len = 1 + (rng() < 0.15 ? 1 : 0);
      const col = bandStart + Math.floor(rng() * bandWidth);
      bugs.push({ col, len });
    }
    lanes.push({ safe: false, dir, intervalMs, phaseMs, bugs, bandStart, bandEnd });
  }
  return {
    id: COURSE_ID,
    version: COURSE_VERSION,
    seed: Number(seed) >>> 0,
    shapeIndex,
    cols: BJ_COLS,
    rows: BJ_ROWS,
    laneCount: BJ_LANE_COUNT,
    safeRows: BJ_SAFE_ROWS,
    durationMs: ROUND_DURATION_MS,
    inputCooldownMs: INPUT_COOLDOWN_MS,
    maxScore: MAX_SCORE_PER_ROUND,
    lanes,
  };
}

function publicCourseMeta() {
  return {
    id: COURSE_ID,
    version: COURSE_VERSION,
    cols: BJ_COLS,
    rows: BJ_ROWS,
    laneCount: BJ_LANE_COUNT,
    safeRows: BJ_SAFE_ROWS,
    durationMs: ROUND_DURATION_MS,
    inputCooldownMs: INPUT_COOLDOWN_MS,
    maxScore: MAX_SCORE_PER_ROUND,
  };
}

function bugColAt(lane, bug, elapsedMs) {
  const bandWidth = lane.bandEnd - lane.bandStart + 1;
  const interval = Math.max(1, asInt(lane.intervalMs, 1));
  const phase = Math.max(0, asInt(lane.phaseMs, 0));
  const steps = Math.floor((Math.max(0, elapsedMs) + phase) / interval);
  const rel = mod((asInt(bug.col, 0) - lane.bandStart) + steps * asInt(lane.dir, 1), bandWidth);
  return lane.bandStart + rel;
}

function cellBlocked(row, col, elapsedMs, course) {
  if (row < 1 || row > course.laneCount) return false;
  const lane = course.lanes[row - 1];
  if (!lane || lane.safe) return false;
  const bandWidth = lane.bandEnd - lane.bandStart + 1;
  return lane.bugs.some((bug) => {
    const head = bugColAt(lane, bug, elapsedMs);
    for (let i = 0; i < asInt(bug.len, 1); i += 1) {
      if (lane.bandStart + mod((head - lane.bandStart) + i, bandWidth) === col) return true;
    }
    return false;
  });
}

// Corridor/wall check — a cell outside the round's band is impassable.
function cellOpen(row, col, course) {
  if (row <= 0 || row >= course.rows - 1) return true;
  if (course.safeRows.includes(row)) return true;
  const lane = course.lanes[row - 1];
  if (!lane) return true;
  return col >= lane.bandStart && col <= lane.bandEnd;
}

function nextLaneStepAfter(lane, elapsedMs) {
  const interval = Math.max(1, asInt(lane.intervalMs, 1));
  const phase = Math.max(0, asInt(lane.phaseMs, 0));
  const step = Math.floor((Math.max(0, elapsedMs) + phase) / interval) + 1;
  return Math.max(0, step * interval - phase);
}

function firstCollisionBetween(state, fromMs, toMs, course) {
  if (state.row < 1 || state.row > course.laneCount) return null;
  const start = Math.max(0, fromMs);
  const end = Math.max(start, toMs);
  if (cellBlocked(state.row, state.col, start, course)) return start;
  const lane = course.lanes[state.row - 1];
  let t = nextLaneStepAfter(lane, start);
  let guard = 0;
  while (t <= end + MOVE_TIME_TOLERANCE_MS && guard < 100) {
    if (t >= start && cellBlocked(state.row, state.col, t, course)) return Math.min(end, Math.max(start, t));
    t += Math.max(1, asInt(lane.intervalMs, 1));
    guard += 1;
  }
  if (cellBlocked(state.row, state.col, end, course)) return end;
  return null;
}

function parseMoves(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu ruchów rundy.");
  if (value.length > MAX_MOVES_PER_ROUND) throw gameError("Za dużo ruchów w rundzie.");
  return value.map((move) => {
    const t = Math.round(asNumber(move?.t, NaN));
    const dr = asInt(move?.dr, 0);
    const dc = asInt(move?.dc, 0);
    if (!Number.isFinite(t) || t < 0 || t > ROUND_DURATION_MS + 1000) {
      throw gameError("Nieprawidłowy czas ruchu.");
    }
    const manhattan = Math.abs(dr) + Math.abs(dc);
    if (manhattan !== 1 || Math.abs(dr) > 1 || Math.abs(dc) > 1) {
      throw gameError("Nieprawidłowy ruch.");
    }
    return { t, dr, dc };
  });
}

function replayMoves(moves, course, untilMs = ROUND_DURATION_MS) {
  const state = {
    row: 0,
    col: Math.floor(BJ_COLS / 2),
    bestRow: 0,
    completed: false,
    completionMs: null,
    collisions: 0,
    lastMs: 0,
    nextInputAt: 0,
  };

  function resolveUntil(toMs) {
    if (state.completed) return;
    const hitAt = firstCollisionBetween(state, state.lastMs, toMs, course);
    if (hitAt != null) {
      state.collisions += 1;
      state.row = 0;
      state.col = Math.floor(BJ_COLS / 2);
      state.lastMs = hitAt;
    }
    state.lastMs = Math.max(state.lastMs, toMs);
  }

  let previousMoveAt = -1;
  for (const move of moves) {
    if (move.t + MOVE_TIME_TOLERANCE_MS < previousMoveAt) {
      throw gameError("Ruchy nie są uporządkowane.");
    }
    previousMoveAt = move.t;
    resolveUntil(move.t);
    if (state.completed) break;
    if (move.t + MOVE_TIME_TOLERANCE_MS < state.nextInputAt) {
      throw gameError("Ruchy są za szybkie.");
    }
    state.nextInputAt = move.t + INPUT_COOLDOWN_MS;

    if (move.dc !== 0) {
      const proposedCol = Math.max(0, Math.min(BJ_COLS - 1, state.col + move.dc));
      if (cellOpen(state.row, proposedCol, course)) state.col = proposedCol;
      resolveUntil(move.t);
      continue;
    }

    const newRow = state.row + move.dr;
    if (newRow < 0 || newRow > course.rows - 1) continue;
    if (!cellOpen(newRow, state.col, course)) continue;

    if (newRow >= course.rows - 1) {
      state.row = course.rows - 1;
      state.bestRow = BJ_LANE_COUNT;
      state.completed = true;
      state.completionMs = move.t;
      break;
    }

    state.row = newRow;
    if (move.dr > 0 && newRow >= 1 && newRow <= BJ_LANE_COUNT) {
      state.bestRow = Math.max(state.bestRow, newRow);
    }
    resolveUntil(move.t);
  }

  if (!state.completed) resolveUntil(Math.min(ROUND_DURATION_MS, Math.max(0, untilMs)));
  const lineScore = Math.min(MAX_SCORE_PER_ROUND, state.bestRow);
  return {
    lineScore,
    bestRow: Math.min(MAX_SCORE_PER_ROUND, state.bestRow),
    completed: state.completed,
    completionMs: state.completed ? Math.round(state.completionMs) : null,
    collisions: state.collisions,
    moveCount: moves.length,
  };
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
        and (
          d.effect_game = ${game}
          or (
            ${game} in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol')
            and
            d.effect_type = 'score_bonus'
            and d.effect_game in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol')
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
    hits: asInt(row.hits),
    misses: asInt(row.misses),
    max_combo: asInt(row.max_combo),
    rounds_played: asInt(row.rounds_played),
    accuracy: asNumber(row.accuracy),
    course_id: row.course_id ?? null,
    completion_ms: row.completion_ms == null ? null : asInt(row.completion_ms),
  }));
}

function mapAwards(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    prize_coins: asInt(row.prize_coins),
    accuracy: asNumber(row.accuracy),
    course_id: row.course_id ?? null,
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

  const [weekRow] = await db`select public.bug_jumper_week_start(now()) as week_start`;
  const weekly = await db`
    select *
    from public.bug_jumper_current_week
    order by rank
    limit 20
  `;
  const allTime = await db`
    select *
    from public.bug_jumper_all_time
    order by rank
    limit 20
  `;
  const awards = await db`
    select *
    from public.bug_jumper_recent_awards
    order by week_start desc, rank asc
    limit 12
  `;
  const [myWeekly] = await db`
    select *
    from public.bug_jumper_current_week
    where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select *
    from public.bug_jumper_all_time
    where user_id = ${userId}
  `;

  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    weekStart: weekRow?.week_start,
    courseId: COURSE_ID,
    courseVersion: COURSE_VERSION,
    course: publicCourseMeta(),
    maxScore: MAX_SCORE_PER_ROUND,
    roundDurationMs: ROUND_DURATION_MS,
    prizes: PRIZES,
    weekly: mapRows(weekly),
    allTime: mapRows(allTime),
    awards: mapAwards(awards),
    myWeekly: myWeekly ? mapRows([myWeekly])[0] : null,
    myAllTime: myAllTime ? mapRows([myAllTime])[0] : null,
  };
}

async function startRound(userId, body) {
  if (!db) throw new Error("Database is not configured.");

  const [profile] = await db`
    select id, nick, coins
    from public.profiles
    where id = ${userId}
  `;
  if (!profile) throw gameError("Profil nie istnieje.");

  let seed = Math.floor(Math.random() * 2147483647) + 1;
  // Player picked a specific shape (0..BJ_SHAPES.length-1) in the pre-round
  // picker: nudge the drawn seed to that remainder so generateCourse(seed)
  // lands on the requested shape. Lane randomization (everything after the
  // shape pick) is untouched — still fully random.
  const requestedShape = body?.shapeIndex == null ? -1 : asInt(body.shapeIndex, -1);
  if (requestedShape >= 0 && requestedShape < BJ_SHAPES.length) {
    seed = seed - mod(seed, BJ_SHAPES.length) + requestedShape;
    if (seed < 1) seed += BJ_SHAPES.length;
  }

  const [round] = await db`
    insert into public.bug_jumper_rounds
      (user_id, nick_snapshot, duration_ms, seed, expires_at)
    values
      (${userId}, ${profile.nick}, ${ROUND_DURATION_MS}, ${seed}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
    returning id, seed, started_at, expires_at
  `;

  return {
    ...(await loadState(userId)),
    round: {
      id: round.id,
      seed: asInt(round.seed),
      courseId: COURSE_ID,
      courseVersion: COURSE_VERSION,
      durationMs: ROUND_DURATION_MS,
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
  const courseId = String(body.courseId ?? "");
  if (courseId !== COURSE_ID) throw gameError("Nieprawidłowa wersja planszy.");
  const moves = parseMoves(body.moves);

  const effect = await getStrongestHeroEffect(db, userId, "bug_jumper");

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.bug_jumper_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");
    const course = generateCourse(round.seed);
    const actualElapsed = Date.now() - new Date(round.started_at).getTime();
    const replay = replayMoves(moves, course, Math.min(asInt(round.duration_ms, ROUND_DURATION_MS), Math.max(0, actualElapsed)));
    const minSubmitAt = new Date(round.started_at).getTime() + asInt(round.duration_ms, ROUND_DURATION_MS) - 750;
    if (!replay.completed && Date.now() < minSubmitAt) throw gameError("Runda jeszcze trwa.");
    if (replay.completed && replay.completionMs > actualElapsed + 1000) throw gameError("Runda jeszcze trwa.");

    const baseScore = Math.max(0, Math.min(MAX_SCORE_PER_ROUND, replay.lineScore));
    const bonus = effect?.effect_type === "score_bonus"
      ? Math.max(0, asInt(effect.effect_value, 0))
      : 0;
    const lineScore = Math.min(MAX_SCORE_PER_ROUND, baseScore + bonus);
    const itemEffect = bonus > 0 && lineScore > baseScore ? {
      slug: effect.slug,
      name: effect.name,
      type: effect.effect_type,
      value: Number(effect.effect_value),
      bonus: lineScore - baseScore,
    } : null;
    const hits = Math.max(0, Math.min(MAX_SCORE_PER_ROUND, replay.bestRow));
    const misses = Math.max(0, Math.min(999, replay.collisions));
    const maxCombo = replay.completed ? 1 : 0;
    const accuracy = Math.round((lineScore / MAX_SCORE_PER_ROUND) * 10000) / 100;

    await tx`
      update public.bug_jumper_rounds
         set submitted_at = now()
       where id = ${round.id}
    `;

    const [inserted] = await tx`
      insert into public.bug_jumper_scores
        (
          round_id,
          user_id,
          nick_snapshot,
          week_start,
          course_id,
          score,
          hits,
          misses,
          accuracy,
          max_combo,
          duration_ms,
          completion_ms,
          client_meta
        )
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.bug_jumper_week_start(now()),
          ${COURSE_ID},
          ${lineScore},
          ${hits},
          ${misses},
          ${accuracy},
          ${maxCombo},
          ${asInt(round.duration_ms, ROUND_DURATION_MS)},
          ${replay.completionMs},
          ${JSON.stringify({
            course_id: COURSE_ID,
            course_version: COURSE_VERSION,
            seed: asInt(round.seed),
            shape_index: course.shapeIndex,
            move_count: replay.moveCount,
            client_score: asInt(body.score, 0),
            server_validated: true,
            completed: replay.completed,
            completion_ms: replay.completionMs,
            best_row: replay.bestRow,
            collisions: replay.collisions,
            base_score: baseScore,
            item_effect: itemEffect,
          })}::jsonb
        )
      returning *
    `;

    return { inserted, itemEffect };
  });

  return {
    ...(await loadState(userId)),
    score: {
      id: score.inserted.id,
      score: asInt(score.inserted.score),
      hits: asInt(score.inserted.hits),
      misses: asInt(score.inserted.misses),
      accuracy: asNumber(score.inserted.accuracy),
      max_combo: asInt(score.inserted.max_combo),
      course_id: score.inserted.course_id,
      completion_ms: score.inserted.completion_ms == null ? null : asInt(score.inserted.completion_ms),
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
    else if (action === "start") result = await startRound(user.id, body);
    else if (action === "submit") result = await submitRound(user.id, body);
    else throw gameError("Nieznana akcja.");

    return json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
