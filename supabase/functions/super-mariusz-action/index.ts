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

// PARITY CONTRACT: the SM_* constants, SM_COURSE, and the
// smParseCourse/smProgressScore/smInitState/smAdvanceTick/replaySuperMariusz
// functions below must stay byte-for-byte equivalent to the SM_* block in index.html — the
// client plays this exact deterministic simulation (a fixed shared course, no
// RNG) and the server replays the input log to derive the trusted result.
const SM_TICK_MS = 50;
const SM_MAX_TICKS = 6000;          // 5 min hard cap -> DNF
const SM_MAX_MOVES = 3000;
const SM_SUB = 256;                 // sub-units per tile
const SM_COURSE_ID = "super_mariusz_v2";

const SM_RUN_ACCEL = 14;
const SM_FRICTION = 14;
const SM_MAX_SPEED = 88;
const SM_GRAVITY = 18;
const SM_JUMP_VY = -180;
const SM_JUMP_CUT_VY = -60;
const SM_MAX_FALL = 200;
const SM_COYOTE_TICKS = 2;
const SM_JUMP_BUFFER_TICKS = 2;

const SM_PLAYER_W = 192;
const SM_PLAYER_H = 224;
const SM_ENEMY_SPEED = 32;
const SM_ENEMY_W = 208;
const SM_ENEMY_H = 192;
const SM_SPIKE_INSET = 48;

// Fixed shared course: '#' solid, '^' spike, 'E' enemy spawn, 'S' start,
// 'F' flag, '.' empty. S/E markers sit one row above the surface they stand
// on (see smParseCourse), so the surface row itself stays a plain '#'.
const SM_COURSE = [
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  ".......................................................................................................................................................................................................................###..........##...........###.........###...........###.........####...........####..................................................................................................................................................................",
  "................................................................................................................................................................................................................####..........###.........####..........##..........####..........##...........###...............................................................################################################...........................................................",
  "..S.......^.......^........^....................^^.^^..^^.^^..^^.^^..^^.^^..^^............................................................................................^.............................................................................................................................................E.......E...E......E.......E...E..................^^......^^........^^.......^^.............^...E...^^............E...^....^^....E.............F....",
  "################################...#####...#############################################################################....###.....###....###.....###....###.....###.....###################################................................................................................................###############...#######...#####....#######...#####################################################################.....#######################.....##########",
];

const ROUND_EXPIRES_SECONDS = 900;
const PRIZES = [1000, 500, 200];

// Progress can't be item-boosted (it would credit tiles the player never
// reached), so score_bonus items convert to a completion-time bonus instead:
// -400 ms off completion_ms per bonus point, FINISHED runs only
// (e.g. kaiser_helm +5 -> -2.0 s). DNFs are unaffected.
const SM_ITEM_TIME_BONUS_MS_PER_POINT = 400;

function json(body, status = 200, cors = corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
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

let _smParsed = null;
function smParseCourse() {
  if (_smParsed) return _smParsed;
  const rows = SM_COURSE;
  const height = rows.length;
  const width = rows[0].length;
  const solid = new Uint8Array(width * height);
  const spike = new Uint8Array(width * height);
  let startX = 2 * SM_SUB, startY = 0;
  let flagX = (width - 2) * SM_SUB;
  const enemySpawns = [];
  for (let r = 0; r < height; r += 1) {
    const row = rows[r];
    for (let c = 0; c < width; c += 1) {
      const ch = row[c];
      if (ch === "#") solid[r * width + c] = 1;
      else if (ch === "^") spike[r * width + c] = 1;
      else if (ch === "S") { startX = c * SM_SUB; startY = (r + 1) * SM_SUB - SM_PLAYER_H; }
      else if (ch === "F") { flagX = c * SM_SUB; }
      else if (ch === "E") { enemySpawns.push({ x: c * SM_SUB, row: r + 1 }); }
    }
  }
  _smParsed = { width, height, solid, spike, startX, startY, flagX, enemySpawns, courseBottom: height * SM_SUB };
  return _smParsed;
}

function smTileSolid(course, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= course.width || ty >= course.height) return ty >= course.height ? false : true;
  return course.solid[ty * course.width + tx] === 1;
}

function smTileSpike(course, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= course.width || ty >= course.height) return false;
  return course.spike[ty * course.width + tx] === 1;
}

function smAabbOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// Progress score: tile column reached by the player's center (peak x), capped
// at the flag column — every finisher scores exactly the cap, so the shared
// ORDER BY score DESC, completion_ms ASC NULLS LAST ranks distance first and
// decides by time only among finishers.
function smProgressScore(st) {
  const course = smParseCourse();
  const flagCol = Math.floor(course.flagX / SM_SUB);
  return Math.max(0, Math.min(flagCol, Math.floor((st.maxX + SM_PLAYER_W / 2) / SM_SUB)));
}

function smInitState() {
  const course = smParseCourse();
  const enemies = course.enemySpawns.map((e) => ({ x: e.x, y: e.row * SM_SUB - SM_ENEMY_H, dir: 1 }));
  return {
    tick: 0,
    x: course.startX,
    maxX: course.startX,
    y: course.startY,
    vx: 0,
    vy: 0,
    onGround: false,
    coyote: 0,
    jumpBuf: 0,
    prevJumpHeld: false,
    enemies,
    dead: false,
    finished: false,
  };
}

function smResolveAxis(course, px, py, w, h, dx, dy) {
  let x = px, y = py;
  if (dx !== 0) {
    x += dx;
    const dir = dx > 0 ? 1 : -1;
    const edgeX = dir > 0 ? x + w : x;
    const tx = Math.floor(edgeX / SM_SUB) - (dir > 0 ? 0 : 1);
    const topRow = Math.floor(y / SM_SUB);
    const botRow = Math.floor((y + h - 1) / SM_SUB);
    for (let ty = topRow; ty <= botRow; ty += 1) {
      if (smTileSolid(course, tx, ty)) {
        x = dir > 0 ? tx * SM_SUB - w : (tx + 1) * SM_SUB;
        break;
      }
    }
    return { x, y, landed: false };
  }
  if (dy !== 0) {
    y += dy;
    const dir = dy > 0 ? 1 : -1;
    let landed = false;
    const edgeY = dir > 0 ? y + h : y;
    const ty = Math.floor(edgeY / SM_SUB) - (dir > 0 ? 0 : 1);
    const leftCol = Math.floor(x / SM_SUB);
    const rightCol = Math.floor((x + w - 1) / SM_SUB);
    for (let tx = leftCol; tx <= rightCol; tx += 1) {
      if (smTileSolid(course, tx, ty)) {
        y = dir > 0 ? ty * SM_SUB - h : (ty + 1) * SM_SUB;
        if (dir > 0) landed = true;
        break;
      }
    }
    return { x, y, landed };
  }
  return { x, y, landed: false };
}

// One simulation tick. keys is a bitmask: bit0 LEFT, bit1 RIGHT, bit2 JUMP.
function smAdvanceTick(st, keys) {
  const course = smParseCourse();
  st.tick += 1;
  const left = (keys & 1) !== 0;
  const right = (keys & 2) !== 0;
  const jump = (keys & 4) !== 0;
  const jumpPressed = jump && !st.prevJumpHeld;
  st.prevJumpHeld = jump;

  if (jumpPressed) st.jumpBuf = SM_JUMP_BUFFER_TICKS;
  else if (st.jumpBuf > 0) st.jumpBuf -= 1;

  // 1) horizontal accel/friction
  if (left && !right) st.vx = Math.max(-SM_MAX_SPEED, st.vx - SM_RUN_ACCEL);
  else if (right && !left) st.vx = Math.min(SM_MAX_SPEED, st.vx + SM_RUN_ACCEL);
  else {
    if (st.vx > 0) st.vx = Math.max(0, st.vx - SM_FRICTION);
    else if (st.vx < 0) st.vx = Math.min(0, st.vx + SM_FRICTION);
  }

  // 2) jump (buffered press + coyote time), jump-cut for variable height
  const canJump = st.onGround || st.coyote > 0;
  if (st.jumpBuf > 0 && canJump) {
    st.vy = SM_JUMP_VY;
    st.onGround = false;
    st.coyote = 0;
    st.jumpBuf = 0;
  } else if (!jump && st.vy < SM_JUMP_CUT_VY) {
    st.vy = SM_JUMP_CUT_VY;
  }

  // 3) gravity
  st.vy = Math.min(SM_MAX_FALL, st.vy + SM_GRAVITY);

  // 4) move X then Y, resolving tile collisions
  const rx = smResolveAxis(course, st.x, st.y, SM_PLAYER_W, SM_PLAYER_H, st.vx, 0);
  if (rx.x !== st.x + st.vx) st.vx = 0;
  st.x = rx.x;
  if (st.x > st.maxX) st.maxX = st.x;

  const ry = smResolveAxis(course, st.x, st.y, SM_PLAYER_W, SM_PLAYER_H, 0, st.vy);
  if (ry.landed) {
    st.onGround = true;
    st.coyote = SM_COYOTE_TICKS;
    st.vy = 0;
  } else {
    if (st.onGround) st.coyote = SM_COYOTE_TICKS;
    else if (st.coyote > 0) st.coyote -= 1;
    st.onGround = false;
  }
  st.y = ry.y;

  // 5) enemies advance / reverse deterministically
  for (const en of st.enemies) {
    const nx = en.x + en.dir * SM_ENEMY_SPEED;
    const dir = en.dir;
    const leadX = dir > 0 ? nx + SM_ENEMY_W : nx;
    const tx = Math.floor(leadX / SM_SUB) - (dir > 0 ? 0 : 1);
    const ty = Math.floor((en.y + SM_ENEMY_H - 1) / SM_SUB);
    const wallAhead = smTileSolid(course, dir > 0 ? tx + 1 : tx - 1, Math.floor(en.y / SM_SUB));
    const floorAhead = smTileSolid(course, tx, ty + 1);
    if (wallAhead || !floorAhead) en.dir = -en.dir;
    else en.x = nx;
  }

  // 6) death checks: spike (inset hitbox), enemy contact, fell off the course
  const feetRow = Math.floor((st.y + SM_PLAYER_H - 1) / SM_SUB);
  const headRow = Math.floor(st.y / SM_SUB);
  const leftCol = Math.floor((st.x + SM_SPIKE_INSET) / SM_SUB);
  const rightCol = Math.floor((st.x + SM_PLAYER_W - 1 - SM_SPIKE_INSET) / SM_SUB);
  let spiked = false;
  for (let ty = headRow; ty <= feetRow && !spiked; ty += 1) {
    for (let tx = leftCol; tx <= rightCol; tx += 1) {
      if (smTileSpike(course, tx, ty)) { spiked = true; break; }
    }
  }
  let enemyHit = false;
  for (const en of st.enemies) {
    if (smAabbOverlap(st.x + SM_SPIKE_INSET, st.y, SM_PLAYER_W - 2 * SM_SPIKE_INSET, SM_PLAYER_H, en.x, en.y, SM_ENEMY_W, SM_ENEMY_H)) {
      enemyHit = true;
      break;
    }
  }
  const fell = st.y > course.courseBottom;
  if (spiked || enemyHit || fell) st.dead = true;

  // 7) finish check
  if (!st.dead && st.x + SM_PLAYER_W / 2 >= course.flagX) st.finished = true;

  return { died: st.dead, finished: st.finished };
}

function replaySuperMariusz(moves, untilTick) {
  const st = smInitState();
  const capped = Math.max(0, Math.min(SM_MAX_TICKS, untilTick));
  let moveIndex = 0;
  let keys = 0;
  let endTick = capped;
  let died = false;
  let finished = false;
  while (st.tick < capped) {
    const nextTick = st.tick + 1;
    while (moveIndex < moves.length && moves[moveIndex].tick === nextTick) {
      keys = moves[moveIndex].keys;
      moveIndex += 1;
    }
    const ev = smAdvanceTick(st, keys);
    if (ev.died) { died = true; endTick = st.tick; break; }
    if (ev.finished) { finished = true; endTick = st.tick; break; }
  }
  const completionMs = finished ? endTick * SM_TICK_MS : null;
  const score = smProgressScore(st);
  return { finished, died, endTick, completionMs, score };
}

function parseMoves(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu ruchów rundy.");
  if (value.length > SM_MAX_MOVES) throw gameError("Za dużo ruchów w rundzie.");
  let previousTick = 0;
  return value.map((move) => {
    const tick = asInt(move?.tick, NaN);
    const keys = asInt(move?.keys, NaN);
    if (!Number.isFinite(tick) || tick < 1 || tick > SM_MAX_TICKS) throw gameError("Nieprawidłowy ruch.");
    if (!Number.isFinite(keys) || keys < 0 || keys > 7) throw gameError("Nieprawidłowy stan klawiszy.");
    if (tick <= previousTick) throw gameError("Ruchy nie są uporządkowane.");
    previousTick = tick;
    return { tick, keys };
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
            ${game} in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz')
            and d.effect_type = 'score_bonus'
            and d.effect_game in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz')
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
    completion_ms: row.completion_ms == null ? null : asInt(row.completion_ms),
    completed: !!row.completed,
    moves: asInt(row.moves),
    duration_ms: asInt(row.duration_ms),
    rounds_played: asInt(row.rounds_played),
  }));
}

function mapAwards(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    completion_ms: row.completion_ms == null ? null : asInt(row.completion_ms),
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

  const [weekRow] = await db`select public.super_mariusz_week_start(now()) as week_start`;
  const weekly = await db`
    select * from public.super_mariusz_current_week order by rank limit 20
  `;
  const allTime = await db`
    select * from public.super_mariusz_all_time order by rank limit 20
  `;
  const awards = await db`
    select * from public.super_mariusz_recent_awards order by week_start desc, rank asc limit 12
  `;
  const [myWeekly] = await db`
    select * from public.super_mariusz_current_week where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select * from public.super_mariusz_all_time where user_id = ${userId}
  `;

  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    weekStart: weekRow?.week_start,
    tickMs: SM_TICK_MS,
    courseId: SM_COURSE_ID,
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
    select id, nick, coins from public.profiles where id = ${userId}
  `;
  if (!profile) throw gameError("Profil nie istnieje.");

  const [round] = await db`
    insert into public.super_mariusz_rounds
      (user_id, nick_snapshot, seed, course_id, expires_at)
    values
      (${userId}, ${profile.nick}, 1, ${SM_COURSE_ID}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
    returning id, started_at, expires_at
  `;

  return {
    ...(await loadState(userId)),
    round: {
      id: round.id,
      courseId: SM_COURSE_ID,
      tickMs: SM_TICK_MS,
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
  const requestedTick = asInt(body.elapsedTicks, 0);
  if (requestedTick < 1 || requestedTick > SM_MAX_TICKS) throw gameError("Nieprawidłowy koniec rundy.");

  const effect = await getStrongestHeroEffect(db, userId, "super_mariusz");

  const result = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.super_mariusz_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");

    const actualElapsed = Date.now() - new Date(round.started_at).getTime();
    const actualTickCap = Math.floor((actualElapsed + 1500) / SM_TICK_MS);
    const endTick = requestedTick;
    if (moves.some((move) => move.tick > endTick)) throw gameError("Ruch po końcu rundy.");
    if (endTick > actualTickCap) throw gameError("Runda jeszcze trwa.");

    const replay = replaySuperMariusz(moves, endTick);
    if (replay.endTick !== endTick) throw gameError("Runda zakończyła się wcześniej.");
    if (!replay.died && !replay.finished && endTick < SM_MAX_TICKS) throw gameError("Runda jeszcze trwa.");

    const bonusPoints = effect?.effect_type === "score_bonus"
      ? Math.max(0, asInt(effect.effect_value, 0))
      : 0;
    const bonusMs = replay.finished && replay.completionMs != null
      ? Math.min(replay.completionMs, bonusPoints * SM_ITEM_TIME_BONUS_MS_PER_POINT)
      : 0;
    const completionMs = replay.completionMs == null ? null : replay.completionMs - bonusMs;
    const itemEffect = bonusMs > 0 ? {
      slug: effect.slug,
      name: effect.name,
      type: effect.effect_type,
      value: Number(effect.effect_value),
      bonus_ms: bonusMs,
      base_completion_ms: replay.completionMs,
    } : null;

    await tx`
      update public.super_mariusz_rounds
         set submitted_at = now()
       where id = ${round.id}
    `;

    const [row] = await tx`
      insert into public.super_mariusz_scores
        (round_id, user_id, nick_snapshot, week_start, course_id, score, completion_ms, completed, moves, duration_ms, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.super_mariusz_week_start(now()),
          ${SM_COURSE_ID},
          ${replay.score},
          ${completionMs},
          ${replay.finished},
          ${moves.length},
          ${replay.endTick * SM_TICK_MS},
          ${JSON.stringify({
            course_id: SM_COURSE_ID,
            tick_ms: SM_TICK_MS,
            elapsed_ticks: replay.endTick,
            client_score: asInt(body.score, 0),
            server_validated: true,
            died: replay.died,
            completed: replay.finished,
            base_score: replay.score,
            item_effect: itemEffect,
          })}::jsonb
        )
      returning *
    `;

    return { row, itemEffect };
  });

  return {
    ...(await loadState(userId)),
    score: {
      id: result.row.id,
      score: asInt(result.row.score),
      completion_ms: result.row.completion_ms == null ? null : asInt(result.row.completion_ms),
      completed: !!result.row.completed,
      moves: asInt(result.row.moves),
      submitted_at: result.row.submitted_at,
      itemEffect: result.itemEffect,
    },
  };
}

Deno.serve(async (req) => {
  const cors = corsHeaders;
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405, cors);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "state");

    let result;
    if (action === "state") result = await loadState(user.id);
    else if (action === "start") result = await startRound(user.id);
    else if (action === "submit") result = await submitRound(user.id, body);
    else throw gameError("Nieznana akcja.");

    return json({ ok: true, ...result }, 200, cors);
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." }, 200, cors);
  }
});
