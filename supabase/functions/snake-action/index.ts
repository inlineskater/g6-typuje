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

const GRID_SIZE = 20;
const TICK_MS = 120;
const MIN_TICK_MS = 80;
const SPEEDUP_EVERY_TICKS = 250;
const SPEEDUP_STEP_MS = 2;
const LEGACY_ROUND_DURATION_MS = 120_000;
const ROUND_EXPIRES_SECONDS = 7200;
const MAX_TICKS = 100_000;
const MAX_SCORE_PER_ROUND = 500;
const MAX_MOVES_PER_ROUND = 100_000;
const PRIZES = [100, 50, 25];
const DIRS = {
  U: { x: 0, y: -1 },
  D: { x: 0, y: 1 },
  L: { x: -1, y: 0 },
  R: { x: 1, y: 0 },
};

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

function opposite(a, b) {
  if (!DIRS[a] || !DIRS[b]) return false;
  return DIRS[a].x + DIRS[b].x === 0 && DIRS[a].y + DIRS[b].y === 0;
}

function tickDelayMs(tick) {
  const stage = Math.floor(Math.max(0, asInt(tick, 1) - 1) / SPEEDUP_EVERY_TICKS);
  return Math.max(MIN_TICK_MS, TICK_MS - stage * SPEEDUP_STEP_MS);
}

function tickCapForElapsed(elapsedMs) {
  let total = 0;
  let tick = 0;
  const budget = Math.max(0, asInt(elapsedMs, 0));
  while (tick < MAX_TICKS) {
    const nextDelay = tickDelayMs(tick + 1);
    if (total + nextDelay > budget) break;
    total += nextDelay;
    tick += 1;
  }
  return tick;
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function key(pos) {
  return `${pos.x},${pos.y}`;
}

function spawnFood(snake, rng) {
  const occupied = new Set(snake.map(key));
  const free = GRID_SIZE * GRID_SIZE - occupied.size;
  if (free <= 0) return null;
  let guard = 0;
  while (guard < 2000) {
    const pos = {
      x: Math.floor(rng() * GRID_SIZE),
      y: Math.floor(rng() * GRID_SIZE),
    };
    if (!occupied.has(key(pos))) return pos;
    guard += 1;
  }
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      const pos = { x, y };
      if (!occupied.has(key(pos))) return pos;
    }
  }
  return null;
}

function initialSnake() {
  const mid = Math.floor(GRID_SIZE / 2);
  return [
    { x: mid, y: mid },
    { x: mid - 1, y: mid },
    { x: mid - 2, y: mid },
  ];
}

function parseMoves(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu ruchów rundy.");
  if (value.length > MAX_MOVES_PER_ROUND) throw gameError("Za dużo ruchów w rundzie.");
  let previousTick = 0;
  return value.map((move) => {
    const tick = asInt(move?.tick, NaN);
    const dir = String(move?.dir ?? "");
    if (!Number.isFinite(tick) || tick < 1 || tick > MAX_TICKS) throw gameError("Nieprawidłowy ruch.");
    if (!DIRS[dir]) throw gameError("Nieprawidłowy kierunek ruchu.");
    if (tick <= previousTick) throw gameError("Ruchy nie są uporządkowane.");
    previousTick = tick;
    return { tick, dir };
  });
}

function replaySnake(seed, moves, untilTick) {
  const rng = makeRng(seed);
  const snake = initialSnake();
  let food = spawnFood(snake, rng);
  let dir = "R";
  let moveIndex = 0;
  let score = 0;
  let ate = 0;
  let diedAtTick = null;
  let completed = false;
  const cappedUntil = Math.max(0, Math.min(MAX_TICKS, untilTick));

  for (let tick = 1; tick <= cappedUntil; tick += 1) {
    if (moveIndex < moves.length && moves[moveIndex].tick === tick) {
      const nextDir = moves[moveIndex].dir;
      if (opposite(dir, nextDir)) throw gameError("Nieprawidłowy zawrót.");
      dir = nextDir;
      moveIndex += 1;
    }
    while (moveIndex < moves.length && moves[moveIndex].tick < tick) moveIndex += 1;

    const step = DIRS[dir];
    const head = snake[0];
    const next = { x: head.x + step.x, y: head.y + step.y };
    if (next.x < 0 || next.x >= GRID_SIZE || next.y < 0 || next.y >= GRID_SIZE) {
      diedAtTick = tick;
      break;
    }

    const eating = food && next.x === food.x && next.y === food.y;
    const bodyToCheck = eating ? snake : snake.slice(0, -1);
    if (bodyToCheck.some((part) => part.x === next.x && part.y === next.y)) {
      diedAtTick = tick;
      break;
    }

    snake.unshift(next);
    if (eating) {
      ate += 1;
      score = Math.min(MAX_SCORE_PER_ROUND, score + 1);
      food = spawnFood(snake, rng);
      if (!food) {
        completed = true;
        break;
      }
    } else {
      snake.pop();
    }
  }

  return {
    score,
    apples: ate,
    moves: moves.length,
    endTick: diedAtTick ?? cappedUntil,
    died: diedAtTick != null,
    completed,
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
            ${game} in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol')
            and d.effect_type = 'score_bonus'
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
    base_score: asInt(row.base_score, asInt(row.score)),
    item_bonus: asInt(row.item_bonus),
    apples: asInt(row.apples),
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

  const [weekRow] = await db`select public.snake_week_start(now()) as week_start`;
  const weekly = await db`
    select *
    from public.snake_current_week
    order by rank
    limit 20
  `;
  const allTime = await db`
    select *
    from public.snake_all_time
    order by rank
    limit 20
  `;
  const awards = await db`
    select *
    from public.snake_recent_awards
    order by week_start desc, rank asc
    limit 12
  `;
  const [myWeekly] = await db`
    select *
    from public.snake_current_week
    where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select *
    from public.snake_all_time
    where user_id = ${userId}
  `;

  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    weekStart: weekRow?.week_start,
    gridSize: GRID_SIZE,
    tickMs: TICK_MS,
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
    insert into public.snake_rounds
      (user_id, nick_snapshot, seed, duration_ms, expires_at)
    values
      (${userId}, ${profile.nick}, ${seed}, ${LEGACY_ROUND_DURATION_MS}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
    returning id, seed, duration_ms, started_at, expires_at
  `;

  return {
    ...(await loadState(userId)),
    round: {
      id: round.id,
      seed: asInt(round.seed),
      tickMs: TICK_MS,
      gridSize: GRID_SIZE,
      speedup: {
        minTickMs: MIN_TICK_MS,
        everyTicks: SPEEDUP_EVERY_TICKS,
        stepMs: SPEEDUP_STEP_MS,
      },
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
  if (requestedTick < 1 || requestedTick > MAX_TICKS) throw gameError("Nieprawidłowy koniec rundy.");

  const effect = await getStrongestHeroEffect(db, userId, "snake");

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.snake_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");

    const actualElapsed = Date.now() - new Date(round.started_at).getTime();
    const actualTickCap = tickCapForElapsed(actualElapsed + 1000);
    const endTick = requestedTick;
    if (moves.some((move) => move.tick > endTick)) throw gameError("Ruch po końcu rundy.");
    if (endTick > actualTickCap) throw gameError("Runda jeszcze trwa.");

    const replay = replaySnake(asInt(round.seed), moves, endTick);
    if (replay.endTick !== endTick) throw gameError("Runda zakończyła się wcześniej.");
    if (!replay.died && !replay.completed) throw gameError("Runda jeszcze trwa.");

    const baseScore = Math.max(0, Math.min(MAX_SCORE_PER_ROUND, replay.score));
    const bonus = effect?.effect_type === "score_bonus"
      ? Math.max(0, asInt(effect.effect_value, 0))
      : 0;
    const scoreValue = Math.min(MAX_SCORE_PER_ROUND, baseScore + bonus);
    const itemEffect = bonus > 0 && scoreValue > baseScore ? {
      slug: effect.slug,
      name: effect.name,
      type: effect.effect_type,
      value: Number(effect.effect_value),
      bonus: scoreValue - baseScore,
    } : null;
    const accuracy = Math.round((scoreValue / MAX_SCORE_PER_ROUND) * 10000) / 100;

    await tx`
      update public.snake_rounds
         set submitted_at = now()
       where id = ${round.id}
    `;

    const [inserted] = await tx`
      insert into public.snake_scores
        (round_id, user_id, nick_snapshot, week_start, score, apples, moves, duration_ms, accuracy, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.snake_week_start(now()),
          ${scoreValue},
          ${replay.apples},
          ${replay.moves},
          ${0},
          ${accuracy},
          ${JSON.stringify({
            seed: asInt(round.seed),
            tick_ms: TICK_MS,
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

    return { inserted, itemEffect };
  });

  return {
    ...(await loadState(userId)),
    score: {
      id: score.inserted.id,
      score: asInt(score.inserted.score),
      apples: asInt(score.inserted.apples),
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
