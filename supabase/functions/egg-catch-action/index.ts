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

// PARITY CONTRACT: the EC_* constants and the ecInitState/ecAdvanceTick
// transition rules below must stay byte-for-byte equivalent to the EC_* block
// in index.html — the client plays this exact simulation and the server
// replays seed + moves to derive the trusted score.
const EC_TICK_MS = 100;
const EC_LANES = 4;              // 0 TL, 1 BL, 2 TR, 3 BR
const EC_STEPS = 5;              // egg slots 0..4; resolves stepping past 4
const EC_MAX_MISSES = 3;
const EC_MAX_TICKS = 6000;       // 10 min hard cap
const EC_MAX_SCORE = 300;        // anti-cheat ceiling
const EC_MAX_MOVES = 5000;
const EC_BEAT_START_TICKS = 8;   // 0.8 s per egg step at level 0
const EC_BEAT_MIN_TICKS = 3;
const EC_LEVEL_EVERY = 10;       // spawned eggs per speed level
const EC_SPAWN_GAP_START = 3;    // beats between spawns
const EC_SPAWN_GAP_MIN = 2;
const EC_SPAWN_GAP_DROP_LEVEL = 4;
const ROUND_EXPIRES_SECONDS = 900;
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

function ecLevel(spawned) {
  return Math.floor(spawned / EC_LEVEL_EVERY);
}

function ecBeatTicks(level) {
  return Math.max(EC_BEAT_MIN_TICKS, EC_BEAT_START_TICKS - level);
}

function ecSpawnGapBeats(level) {
  return level >= EC_SPAWN_GAP_DROP_LEVEL ? EC_SPAWN_GAP_MIN : EC_SPAWN_GAP_START;
}

function ecInitState(seed) {
  return {
    rngState: (Number(seed) >>> 0) || 1,
    wolfPos: 0,
    eggs: [],            // { lane, step }
    spawned: 0,
    caught: 0,
    misses: 0,
    beatCountdown: ecBeatTicks(0),
    spawnCountdown: 1,   // first egg on the first beat
    tick: 0,
  };
}

function ecRng(st) {
  st.rngState = (Math.imul(st.rngState, 1664525) + 1013904223) >>> 0;
  return st.rngState / 4294967296;
}

// One simulation tick. movePos (0..3 or null) is applied BEFORE the beat check.
// Returns cosmetic events (unused server-side, mirrored for client parity).
function ecAdvanceTick(st, movePos) {
  st.tick += 1;
  if (movePos != null) st.wolfPos = movePos;
  const ev = { beat: false, caught: [], broken: [], spawnedLane: null };
  st.beatCountdown -= 1;
  if (st.beatCountdown > 0) return ev;
  ev.beat = true;

  const kept = [];
  for (const egg of st.eggs) {
    egg.step += 1;
    if (egg.step >= EC_STEPS) {
      if (egg.lane === st.wolfPos) { st.caught += 1; ev.caught.push(egg.lane); }
      else { st.misses += 1; ev.broken.push(egg.lane); }
    } else {
      kept.push(egg);
    }
  }
  st.eggs = kept;
  if (st.misses >= EC_MAX_MISSES) return ev;

  st.spawnCountdown -= 1;
  if (st.spawnCountdown <= 0) {
    const first = Math.floor(ecRng(st) * EC_LANES);
    for (let i = 0; i < EC_LANES; i += 1) {
      const lane = (first + i) % EC_LANES;
      const blocked = st.eggs.some((e) => e.lane === lane && e.step <= 1);
      if (!blocked) {
        st.eggs.push({ lane, step: 0 });
        st.spawned += 1;
        ev.spawnedLane = lane;
        break;
      }
    }
    st.spawnCountdown = ecSpawnGapBeats(ecLevel(st.spawned));
  }
  st.beatCountdown = ecBeatTicks(ecLevel(st.spawned));
  return ev;
}

function parseMoves(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu ruchów rundy.");
  if (value.length > EC_MAX_MOVES) throw gameError("Za dużo ruchów w rundzie.");
  let previousTick = 0;
  return value.map((move) => {
    const tick = asInt(move?.tick, NaN);
    const pos = asInt(move?.pos, NaN);
    if (!Number.isFinite(tick) || tick < 1 || tick > EC_MAX_TICKS) throw gameError("Nieprawidłowy ruch.");
    if (!Number.isFinite(pos) || pos < 0 || pos >= EC_LANES) throw gameError("Nieprawidłowa pozycja wilka.");
    if (tick <= previousTick) throw gameError("Ruchy nie są uporządkowane.");
    previousTick = tick;
    return { tick, pos };
  });
}

function replayEggCatch(seed, moves, untilTick) {
  const st = ecInitState(seed);
  const capped = Math.max(0, Math.min(EC_MAX_TICKS, untilTick));
  let moveIndex = 0;
  let diedAtTick = null;

  while (st.tick < capped) {
    const nextTick = st.tick + 1;
    let movePos = null;
    while (moveIndex < moves.length && moves[moveIndex].tick === nextTick) {
      movePos = moves[moveIndex].pos;
      moveIndex += 1;
    }
    ecAdvanceTick(st, movePos);
    if (st.misses >= EC_MAX_MISSES) {
      diedAtTick = st.tick;
      break;
    }
  }

  return {
    score: Math.min(EC_MAX_SCORE, st.caught),
    caught: st.caught,
    misses: st.misses,
    spawned: st.spawned,
    moves: moves.length,
    endTick: diedAtTick ?? capped,
    died: diedAtTick != null,
    completed: diedAtTick == null && capped >= EC_MAX_TICKS,
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
            ${game} in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch')
            and d.effect_type = 'score_bonus'
            and d.effect_game in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch')
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
    eggs: asInt(row.eggs),
    misses: asInt(row.misses),
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

  const [weekRow] = await db`select public.egg_catch_week_start(now()) as week_start`;
  const weekly = await db`
    select *
    from public.egg_catch_current_week
    order by rank
    limit 20
  `;
  const allTime = await db`
    select *
    from public.egg_catch_all_time
    order by rank
    limit 20
  `;
  const awards = await db`
    select *
    from public.egg_catch_recent_awards
    order by week_start desc, rank asc
    limit 12
  `;
  const [myWeekly] = await db`
    select *
    from public.egg_catch_current_week
    where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select *
    from public.egg_catch_all_time
    where user_id = ${userId}
  `;

  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    weekStart: weekRow?.week_start,
    tickMs: EC_TICK_MS,
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
    insert into public.egg_catch_rounds
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
      tickMs: EC_TICK_MS,
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
  if (requestedTick < 1 || requestedTick > EC_MAX_TICKS) throw gameError("Nieprawidłowy koniec rundy.");

  const effect = await getStrongestHeroEffect(db, userId, "egg_catch");

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.egg_catch_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");

    const actualElapsed = Date.now() - new Date(round.started_at).getTime();
    const actualTickCap = Math.floor((actualElapsed + 1500) / EC_TICK_MS);
    const endTick = requestedTick;
    if (moves.some((move) => move.tick > endTick)) throw gameError("Ruch po końcu rundy.");
    if (endTick > actualTickCap) throw gameError("Runda jeszcze trwa.");

    const replay = replayEggCatch(asInt(round.seed), moves, endTick);
    if (replay.endTick !== endTick) throw gameError("Runda zakończyła się wcześniej.");
    if (!replay.died && !replay.completed) throw gameError("Runda jeszcze trwa.");

    const baseScore = Math.max(0, Math.min(EC_MAX_SCORE, replay.score));
    const bonus = effect?.effect_type === "score_bonus"
      ? Math.max(0, asInt(effect.effect_value, 0))
      : 0;
    const scoreValue = Math.min(EC_MAX_SCORE, baseScore + bonus);
    const itemEffect = bonus > 0 && scoreValue > baseScore ? {
      slug: effect.slug,
      name: effect.name,
      type: effect.effect_type,
      value: Number(effect.effect_value),
      bonus: scoreValue - baseScore,
    } : null;
    const accuracy = Math.round((scoreValue / EC_MAX_SCORE) * 10000) / 100;

    await tx`
      update public.egg_catch_rounds
         set submitted_at = now()
       where id = ${round.id}
    `;

    const [inserted] = await tx`
      insert into public.egg_catch_scores
        (round_id, user_id, nick_snapshot, week_start, score, eggs, misses, moves, duration_ms, accuracy, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.egg_catch_week_start(now()),
          ${scoreValue},
          ${replay.caught},
          ${replay.misses},
          ${replay.moves},
          ${replay.endTick * EC_TICK_MS},
          ${accuracy},
          ${JSON.stringify({
            seed: asInt(round.seed),
            tick_ms: EC_TICK_MS,
            elapsed_ticks: replay.endTick,
            client_score: asInt(body.score, 0),
            server_validated: true,
            died: replay.died,
            completed: replay.completed,
            spawned: replay.spawned,
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
      eggs: asInt(score.inserted.eggs),
      misses: asInt(score.inserted.misses),
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
