// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
const db = databaseUrl
  ? postgres(databaseUrl, { prepare: false, max: 4, idle_timeout: 20 })
  : null;

const COURSE = Object.freeze({
  id: "bug_jumper_hard_v2",
  version: 2,
  cols: 10,
  rows: 32,
  laneCount: 30,
  safeRows: Object.freeze([10, 20, 30]),
  durationMs: 20_000,
  inputCooldownMs: 240,
  maxScore: 30,
  lanes: Object.freeze([
    { dir:  1, intervalMs: 520, phaseMs: 120, bugs: [{ col: 1, len: 2 }, { col: 7, len: 2 }] },
    { dir: -1, intervalMs: 500, phaseMs: 260, bugs: [{ col: 0, len: 2 }, { col: 5, len: 2 }] },
    { dir:  1, intervalMs: 480, phaseMs:  80, bugs: [{ col: 3, len: 2 }, { col: 8, len: 2 }] },
    { dir: -1, intervalMs: 460, phaseMs: 210, bugs: [{ col: 1, len: 3 }, { col: 7, len: 2 }] },
    { dir:  1, intervalMs: 440, phaseMs: 330, bugs: [{ col: 0, len: 2 }, { col: 5, len: 3 }] },
    { dir: -1, intervalMs: 420, phaseMs: 150, bugs: [{ col: 2, len: 2 }, { col: 7, len: 2 }] },
    { dir:  1, intervalMs: 400, phaseMs: 290, bugs: [{ col: 1, len: 2 }, { col: 6, len: 3 }] },
    { dir: -1, intervalMs: 380, phaseMs:  60, bugs: [{ col: 0, len: 2 }, { col: 5, len: 2 }] },
    { dir:  1, intervalMs: 360, phaseMs: 240, bugs: [{ col: 2, len: 3 }, { col: 8, len: 2 }] },
    { safe: true, dir: 1, intervalMs: 1, phaseMs: 0, bugs: [] },
    { dir: -1, intervalMs: 340, phaseMs: 110, bugs: [{ col: 1, len: 2 }, { col: 6, len: 3 }] },
    { dir:  1, intervalMs: 320, phaseMs: 220, bugs: [{ col: 0, len: 2 }, { col: 5, len: 2 }] },
    { dir: -1, intervalMs: 300, phaseMs:  90, bugs: [{ col: 3, len: 2 }, { col: 8, len: 2 }] },
    { dir:  1, intervalMs: 290, phaseMs: 170, bugs: [{ col: 1, len: 2 }, { col: 6, len: 2 }] },
    { dir: -1, intervalMs: 280, phaseMs:  40, bugs: [{ col: 0, len: 3 }, { col: 7, len: 2 }] },
    { dir:  1, intervalMs: 270, phaseMs: 130, bugs: [{ col: 2, len: 2 }, { col: 8, len: 2 }] },
    { dir: -1, intervalMs: 260, phaseMs: 210, bugs: [{ col: 1, len: 2 }, { col: 5, len: 3 }] },
    { dir:  1, intervalMs: 250, phaseMs:  70, bugs: [{ col: 0, len: 2 }, { col: 6, len: 2 }] },
    { dir: -1, intervalMs: 240, phaseMs: 160, bugs: [{ col: 3, len: 3 }, { col: 8, len: 2 }] },
    { safe: true, dir: 1, intervalMs: 1, phaseMs: 0, bugs: [] },
    { dir:  1, intervalMs: 230, phaseMs:  20, bugs: [{ col: 1, len: 2 }, { col: 7, len: 3 }] },
    { dir: -1, intervalMs: 225, phaseMs: 120, bugs: [{ col: 0, len: 2 }, { col: 5, len: 2 }] },
    { dir:  1, intervalMs: 220, phaseMs:  80, bugs: [{ col: 2, len: 3 }, { col: 8, len: 2 }] },
    { dir: -1, intervalMs: 215, phaseMs: 170, bugs: [{ col: 1, len: 2 }, { col: 6, len: 3 }] },
    { dir:  1, intervalMs: 210, phaseMs:  50, bugs: [{ col: 0, len: 2 }, { col: 5, len: 2 }] },
    { dir: -1, intervalMs: 205, phaseMs: 130, bugs: [{ col: 3, len: 2 }, { col: 8, len: 2 }] },
    { dir:  1, intervalMs: 200, phaseMs:  90, bugs: [{ col: 1, len: 3 }, { col: 7, len: 2 }] },
    { dir: -1, intervalMs: 195, phaseMs: 150, bugs: [{ col: 0, len: 2 }, { col: 6, len: 3 }] },
    { dir:  1, intervalMs: 190, phaseMs:  30, bugs: [{ col: 2, len: 2 }, { col: 8, len: 2 }] },
    { safe: true, dir: 1, intervalMs: 1, phaseMs: 0, bugs: [] },
  ]),
});
const ROUND_DURATION_MS = COURSE.durationMs;
const ROUND_EXPIRES_SECONDS = 120;
const MAX_SCORE_PER_ROUND = COURSE.maxScore;
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

function publicCourse() {
  return {
    id: COURSE.id,
    version: COURSE.version,
    cols: COURSE.cols,
    rows: COURSE.rows,
    laneCount: COURSE.laneCount,
    safeRows: COURSE.safeRows,
    durationMs: COURSE.durationMs,
    inputCooldownMs: COURSE.inputCooldownMs,
    maxScore: COURSE.maxScore,
    lanes: COURSE.lanes,
  };
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

function bugColAt(lane, bug, elapsedMs) {
  const interval = Math.max(1, asInt(lane.intervalMs, 1));
  const phase = Math.max(0, asInt(lane.phaseMs, 0));
  const steps = Math.floor((Math.max(0, elapsedMs) + phase) / interval);
  return mod(asInt(bug.col, 0) + steps * asInt(lane.dir, 1), COURSE.cols);
}

function cellBlocked(row, col, elapsedMs) {
  if (row < 1 || row > COURSE.laneCount) return false;
  const lane = COURSE.lanes[row - 1];
  if (!lane || lane.safe) return false;
  return lane.bugs.some((bug) => {
    const head = bugColAt(lane, bug, elapsedMs);
    for (let i = 0; i < asInt(bug.len, 1); i += 1) {
      if (mod(head + i, COURSE.cols) === col) return true;
    }
    return false;
  });
}

function nextLaneStepAfter(lane, elapsedMs) {
  const interval = Math.max(1, asInt(lane.intervalMs, 1));
  const phase = Math.max(0, asInt(lane.phaseMs, 0));
  const step = Math.floor((Math.max(0, elapsedMs) + phase) / interval) + 1;
  return Math.max(0, step * interval - phase);
}

function firstCollisionBetween(state, fromMs, toMs) {
  if (state.row < 1 || state.row > COURSE.laneCount) return null;
  const start = Math.max(0, fromMs);
  const end = Math.max(start, toMs);
  if (cellBlocked(state.row, state.col, start)) return start;
  const lane = COURSE.lanes[state.row - 1];
  let t = nextLaneStepAfter(lane, start);
  let guard = 0;
  while (t <= end + MOVE_TIME_TOLERANCE_MS && guard < 100) {
    if (t >= start && cellBlocked(state.row, state.col, t)) return Math.min(end, Math.max(start, t));
    t += Math.max(1, asInt(lane.intervalMs, 1));
    guard += 1;
  }
  if (cellBlocked(state.row, state.col, end)) return end;
  return null;
}

function parseMoves(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu ruchów rundy.");
  if (value.length > MAX_MOVES_PER_ROUND) throw gameError("Za dużo ruchów w rundzie.");
  return value.map((move) => {
    const t = Math.round(asNumber(move?.t, NaN));
    const dr = asInt(move?.dr, 0);
    const dc = asInt(move?.dc, 0);
    if (!Number.isFinite(t) || t < 0 || t > COURSE.durationMs + 1000) {
      throw gameError("Nieprawidłowy czas ruchu.");
    }
    const manhattan = Math.abs(dr) + Math.abs(dc);
    if (manhattan !== 1 || Math.abs(dr) > 1 || Math.abs(dc) > 1) {
      throw gameError("Nieprawidłowy ruch.");
    }
    return { t, dr, dc };
  });
}

function replayMoves(moves, untilMs = COURSE.durationMs) {
  const state = {
    row: 0,
    col: Math.floor(COURSE.cols / 2),
    bestRow: 0,
    completed: false,
    completionMs: null,
    collisions: 0,
    lastMs: 0,
    nextInputAt: 0,
  };

  function resolveUntil(toMs) {
    if (state.completed) return;
    const hitAt = firstCollisionBetween(state, state.lastMs, toMs);
    if (hitAt != null) {
      state.collisions += 1;
      state.row = 0;
      state.col = Math.floor(COURSE.cols / 2);
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
    state.nextInputAt = move.t + COURSE.inputCooldownMs;

    const newRow = state.row + move.dr;
    const newCol = Math.max(0, Math.min(COURSE.cols - 1, state.col + move.dc));
    state.col = newCol;
    if (newRow < 0 || newRow > COURSE.rows - 1) continue;

    if (newRow >= COURSE.rows - 1) {
      state.row = COURSE.rows - 1;
      state.bestRow = COURSE.laneCount;
      state.completed = true;
      state.completionMs = move.t;
      break;
    }

    state.row = newRow;
    if (move.dr > 0 && newRow >= 1 && newRow <= COURSE.laneCount) {
      state.bestRow = Math.max(state.bestRow, newRow);
    }
    resolveUntil(move.t);
  }

  if (!state.completed) resolveUntil(Math.min(COURSE.durationMs, Math.max(0, untilMs)));
  const lineScore = Math.min(COURSE.laneCount, state.bestRow);
  return {
    lineScore,
    bestRow: Math.min(COURSE.laneCount, state.bestRow),
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
      from public.hero_equipment e
      join public.hero_item_instances i on i.id = e.item_instance_id
      join public.hero_item_defs d on d.id = i.item_def_id
      where e.user_id = ${userId}
        and i.owner_id = ${userId}
        and d.is_active = true
        and (
          d.effect_game = ${game}
          or (
            d.effect_type = 'score_bonus'
            and d.effect_game in ('whack_boss', 'bug_jumper', 'flappy_pants')
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
    courseId: COURSE.id,
    courseVersion: COURSE.version,
    course: publicCourse(),
    maxScore: COURSE.maxScore,
    roundDurationMs: ROUND_DURATION_MS,
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

  const [round] = await db`
    insert into public.bug_jumper_rounds
      (user_id, nick_snapshot, duration_ms, expires_at)
    values
      (${userId}, ${profile.nick}, ${ROUND_DURATION_MS}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
    returning id, started_at, expires_at
  `;

  return {
    ...(await loadState(userId)),
    round: {
      id: round.id,
      courseId: COURSE.id,
      courseVersion: COURSE.version,
      course: publicCourse(),
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
  if (courseId !== COURSE.id) throw gameError("Nieprawidłowa wersja planszy.");
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
    const actualElapsed = Date.now() - new Date(round.started_at).getTime();
    const replay = replayMoves(moves, Math.min(asInt(round.duration_ms, ROUND_DURATION_MS), Math.max(0, actualElapsed)));
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
          ${COURSE.id},
          ${lineScore},
          ${hits},
          ${misses},
          ${accuracy},
          ${maxCombo},
          ${asInt(round.duration_ms, ROUND_DURATION_MS)},
          ${replay.completionMs},
          ${JSON.stringify({
            course_id: COURSE.id,
            course_version: COURSE.version,
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
    else if (action === "start") result = await startRound(user.id);
    else if (action === "submit") result = await submitRound(user.id, body);
    else throw gameError("Nieznana akcja.");

    return json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
