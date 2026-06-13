// @ts-nocheck
// "Najazd Faktur" (Invoice Horde) — server-authoritative seasonal arena-survivor.
// The browser submits a seed + compact input log; this function replays the
// deterministic integer simulation to derive the trusted score (kills).
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

// ── Simulation constants (must match the client in index.html) ──────────────
const ARENA = 360;
const TICK_MS = 80;
// Survival mode (Devil-Daggers style): no fixed round length — you play until a
// single invoice touches you. ROUND_DURATION_MS is just a hard safety cap for the
// replay bound; in practice the swarm overwhelms you long before it.
const ROUND_DURATION_MS = 60_000;
const ROUND_EXPIRES_SECONDS = 120;
const MAX_TICKS = Math.floor(ROUND_DURATION_MS / TICK_MS); // 750
const MAX_SCORE_PER_ROUND = 200; // anti-cheat ceiling
const MAX_MOVES_PER_ROUND = 2000;
const PRIZES = [100, 50, 25];

const PLAYER_START = { x: 180, y: 180 };
const PLAYER_SPEED = 9;
const PLAYER_RADIUS = 10;
const ENEMY_SPEED = 7; // slower than you, so kiting buys time; still catches campers
const ENEMY_RADIUS = 9;
const HIT_DIST2 = (PLAYER_RADIUS + ENEMY_RADIUS) * (PLAYER_RADIUS + ENEMY_RADIUS);
const FIRE_INTERVAL = 4; // ticks between auto-fires
const FIRE_RANGE = 66; // modest — a camper can't hold a full ring; you must kite
const FIRE_RANGE2 = FIRE_RANGE * FIRE_RANGE;
const START_HP = 1; // one hit = over
const ENEMY_CAP = 70; // bound the swarm (replay cost + difficulty ceiling)

const DIRS = {
  U:  { x: 0,  y: -1 },
  D:  { x: 0,  y: 1 },
  L:  { x: -1, y: 0 },
  R:  { x: 1,  y: 0 },
  UL: { x: -1, y: -1 },
  UR: { x: 1,  y: -1 },
  DL: { x: -1, y: 1 },
  DR: { x: 1,  y: 1 },
  S:  { x: 0,  y: 0 },
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

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Deterministic integer square root (no Math.sqrt → identical client/server).
function isqrt(n) {
  if (n <= 0) return 0;
  let x = n;
  let y = (x + 1) >> 1;
  while (y < x) {
    x = y;
    y = (x + Math.trunc(n / x)) >> 1;
  }
  return x;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function spawnInterval(tick) {
  // Ramps up relentlessly: sparse at first (learnable), then the spawn rate
  // crosses the stamp's clear rate so a stationary player gets surrounded.
  // Mirrored in index.html (ihSpawnInterval).
  return tick < 60 ? 6 : tick < 140 ? 4 : tick < 240 ? 3 : 2;
}

function spawnEnemy(rng) {
  const edge = Math.floor(rng() * 4);
  const t = Math.floor(rng() * (ARENA + 1));
  if (edge === 0) return { x: t, y: 0 };
  if (edge === 1) return { x: t, y: ARENA };
  if (edge === 2) return { x: 0, y: t };
  return { x: ARENA, y: t };
}

function parseMoves(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu ruchów rundy.");
  if (value.length > MAX_MOVES_PER_ROUND) throw gameError("Za dużo ruchów w rundzie.");
  let previousTick = 0;
  return value.map((move) => {
    const tick = asInt(move?.tick, NaN);
    const dir = String(move?.dir ?? "");
    if (!Number.isFinite(tick) || tick < 1 || tick > MAX_TICKS) {
      throw gameError("Nieprawidłowy czas ruchu.");
    }
    if (!DIRS[dir]) throw gameError("Nieprawidłowy kierunek ruchu.");
    if (tick <= previousTick) throw gameError("Ruchy nie są uporządkowane.");
    previousTick = tick;
    return { tick, dir };
  });
}

// Deterministic replay: seed + per-tick input changes → trusted kill count.
function replayInvoiceHorde(seed, moves, untilTick) {
  const rng = makeRng(seed);
  const player = { x: PLAYER_START.x, y: PLAYER_START.y };
  let dir = "S";
  let enemies = [];
  let moveIndex = 0;
  let kills = 0;
  let hp = START_HP;
  let diedAtTick = null;
  const cappedUntil = Math.max(0, Math.min(MAX_TICKS, untilTick));

  for (let tick = 1; tick <= cappedUntil; tick += 1) {
    // 1. apply queued input change(s) scheduled for this tick
    while (moveIndex < moves.length && moves[moveIndex].tick < tick) moveIndex += 1;
    if (moveIndex < moves.length && moves[moveIndex].tick === tick) {
      dir = moves[moveIndex].dir;
      moveIndex += 1;
    }

    // 2. move player
    const pv = DIRS[dir];
    player.x = clamp(player.x + pv.x * PLAYER_SPEED, 0, ARENA);
    player.y = clamp(player.y + pv.y * PLAYER_SPEED, 0, ARENA);

    // 3. spawn (capped — rng is only consumed when a spawn actually happens)
    if (tick % spawnInterval(tick) === 0 && enemies.length < ENEMY_CAP) {
      enemies.push(spawnEnemy(rng));
    }

    // 4. move enemies toward player
    for (const e of enemies) {
      const dx = player.x - e.x;
      const dy = player.y - e.y;
      const d = isqrt(dx * dx + dy * dy);
      if (d > 0) {
        e.x += Math.trunc((dx * ENEMY_SPEED) / d);
        e.y += Math.trunc((dy * ENEMY_SPEED) / d);
      }
    }

    // 5. contact damage (overlapping enemies are kamikaze: 1 dmg, removed)
    const survivors = [];
    for (const e of enemies) {
      const dx = player.x - e.x;
      const dy = player.y - e.y;
      if (dx * dx + dy * dy <= HIT_DIST2) {
        hp -= 1;
        if (hp <= 0) { diedAtTick = tick; break; }
      } else {
        survivors.push(e);
      }
    }
    enemies = survivors;
    if (diedAtTick != null) break;

    // 6. auto-fire: nearest enemy in range is booked (+1)
    if (tick % FIRE_INTERVAL === 0 && enemies.length) {
      let bestIdx = -1;
      let bestD2 = FIRE_RANGE2 + 1;
      for (let i = 0; i < enemies.length; i += 1) {
        const dx = player.x - enemies[i].x;
        const dy = player.y - enemies[i].y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= FIRE_RANGE2 && d2 < bestD2) { bestD2 = d2; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        enemies.splice(bestIdx, 1);
        kills = Math.min(MAX_SCORE_PER_ROUND, kills + 1);
      }
    }
  }

  const endTick = diedAtTick ?? cappedUntil;
  return {
    score: kills,
    kills,
    moves: moves.length,
    endTick,
    died: diedAtTick != null,
    completed: cappedUntil >= MAX_TICKS,
    durationMs: endTick * TICK_MS,
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

function mapRows(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    base_score: asInt(row.base_score, asInt(row.score)),
    item_bonus: asInt(row.item_bonus),
    kills: asInt(row.kills),
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

  const [weekRow] = await db`select public.invoice_horde_week_start(now()) as week_start`;
  const weekly = await db`
    select *
    from public.invoice_horde_current_week
    order by rank
    limit 20
  `;
  const allTime = await db`
    select *
    from public.invoice_horde_all_time
    order by rank
    limit 20
  `;
  const awards = await db`
    select *
    from public.invoice_horde_recent_awards
    order by week_start desc, rank asc
    limit 12
  `;
  const [myWeekly] = await db`
    select *
    from public.invoice_horde_current_week
    where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select *
    from public.invoice_horde_all_time
    where user_id = ${userId}
  `;

  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    weekStart: weekRow?.week_start,
    arena: ARENA,
    tickMs: TICK_MS,
    roundDurationMs: ROUND_DURATION_MS,
    startHp: START_HP,
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
    insert into public.invoice_horde_rounds
      (user_id, nick_snapshot, seed, duration_ms, expires_at)
    values
      (${userId}, ${profile.nick}, ${seed}, ${ROUND_DURATION_MS}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
    returning id, seed, duration_ms, started_at, expires_at
  `;

  return {
    ...(await loadState(userId)),
    round: {
      id: round.id,
      seed: asInt(round.seed),
      durationMs: asInt(round.duration_ms, ROUND_DURATION_MS),
      tickMs: TICK_MS,
      arena: ARENA,
      startHp: START_HP,
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

  const effect = await getStrongestHeroEffect(db, userId, "invoice_horde");

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.invoice_horde_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");

    const actualElapsed = Date.now() - new Date(round.started_at).getTime();
    const actualTickCap = Math.min(MAX_TICKS, Math.max(0, Math.ceil((actualElapsed + 1000) / TICK_MS)));
    const endTick = Math.max(0, Math.min(MAX_TICKS, requestedTick || actualTickCap));
    if (endTick > actualTickCap) throw gameError("Runda jeszcze trwa.");

    const replay = replayInvoiceHorde(asInt(round.seed), moves, endTick);
    const minSubmitAt = new Date(round.started_at).getTime() + asInt(round.duration_ms, ROUND_DURATION_MS) - 750;
    if (!replay.died && replay.endTick < MAX_TICKS && Date.now() < minSubmitAt) {
      throw gameError("Runda jeszcze trwa.");
    }
    if (replay.died && replay.durationMs > actualElapsed + 1000) {
      throw gameError("Runda jeszcze trwa.");
    }

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
      update public.invoice_horde_rounds
         set submitted_at = now()
       where id = ${round.id}
    `;

    const [inserted] = await tx`
      insert into public.invoice_horde_scores
        (round_id, user_id, nick_snapshot, week_start, score, kills, moves, duration_ms, accuracy, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.invoice_horde_week_start(now()),
          ${scoreValue},
          ${replay.kills},
          ${replay.moves},
          ${replay.durationMs},
          ${accuracy},
          ${JSON.stringify({
            seed: asInt(round.seed),
            tick_ms: TICK_MS,
            elapsed_ticks: replay.endTick,
            client_score: asInt(body.score, 0),
            server_validated: true,
            died: replay.died,
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
      kills: asInt(score.inserted.kills),
      moves: asInt(score.inserted.moves),
      duration_ms: asInt(score.inserted.duration_ms),
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
