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

const ROUND_EXPIRES_SECONDS = 120;
const MIN_PLAY_MS = 1_500;
const MAX_SCORE_PER_ROUND = 200;
const MAX_LIVES = 3;
const MAX_FLAPS_PER_ROUND = 1000;
const REPLAY_TICK_MS = 16;
const FP_CS_W = 384;
const FP_CS_H = 384;
const FP_PLAYER_X = 112;
const FP_PLAYER_R = 16;
const FP_GRAVITY = 1350;
const FP_FLAP_V = -360;
const FP_PIPE_SPEED = 130;
const FP_PIPE_W = 54;
const FP_GAP = 124;
const FP_PIPE_SPACING = 210;
const PRIZES = [1000, 500, 200];

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

function nextGapY(rng) {
  const min = FP_GAP / 2 + 30;
  const max = FP_CS_H - FP_GAP / 2 - 30;
  return min + rng() * (max - min);
}

function parseFlapEvents(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu ruchów rundy.");
  if (value.length > MAX_FLAPS_PER_ROUND) throw gameError("Za dużo ruchów w rundzie.");
  let previous = -1;
  return value.map((event) => {
    const atMs = asNumber(event?.atMs, NaN);
    if (!Number.isFinite(atMs) || atMs < 0 || atMs > ROUND_EXPIRES_SECONDS * 1000) {
      throw gameError("Nieprawidłowy czas ruchu.");
    }
    if (atMs < previous) throw gameError("Ruchy nie są uporządkowane.");
    previous = atMs;
    return { atMs: Math.round(atMs) };
  });
}

function replayFlappy(seed, flapEvents, untilMs) {
  const rng = makeRng(seed);
  const obstacles = [];
  let flapIndex = 0;
  let elapsed = 0;
  let y = FP_CS_H / 2;
  let vy = 0;
  let lives = MAX_LIVES;
  let score = 0;
  let pipes = 0;
  let spawnHold = 0;
  let invincible = false;
  let invincEnd = 0;
  let diedAtMs = null;
  const cappedUntil = Math.max(0, Math.min(ROUND_EXPIRES_SECONDS * 1000, untilMs));

  while (elapsed < cappedUntil && lives > 0) {
    while (flapIndex < flapEvents.length && flapEvents[flapIndex].atMs <= elapsed + REPLAY_TICK_MS) {
      vy = FP_FLAP_V;
      flapIndex += 1;
    }

    const dt = Math.min(REPLAY_TICK_MS, cappedUntil - elapsed) / 1000;
    elapsed += dt * 1000;
    const elapsedSec = elapsed / 1000;
    const speedMult = Math.min(2.6, 1 + elapsedSec * 0.05);

    vy += FP_GRAVITY * dt;
    y += vy * dt;

    for (const obstacle of obstacles) obstacle.x -= FP_PIPE_SPEED * speedMult * dt;
    while (obstacles.length && obstacles[0].x + FP_PIPE_W <= -4) obstacles.shift();
    const last = obstacles[obstacles.length - 1];
    if ((!last || last.x <= FP_CS_W - FP_PIPE_SPACING) && elapsed >= spawnHold) {
      obstacles.push({ x: FP_CS_W, gapY: nextGapY(rng), scored: false });
    }

    if (invincible && elapsed >= invincEnd) invincible = false;

    for (const obstacle of obstacles) {
      if (!obstacle.scored && obstacle.x + FP_PIPE_W < FP_PLAYER_X) {
        obstacle.scored = true;
        pipes += 1;
        score = Math.min(MAX_SCORE_PER_ROUND, score + 1);
      }
    }

    let collision = y - FP_PLAYER_R < 0 || y + FP_PLAYER_R > FP_CS_H;
    if (!collision) {
      const left = FP_PLAYER_X - FP_PLAYER_R;
      const right = FP_PLAYER_X + FP_PLAYER_R;
      collision = obstacles.some((obstacle) => {
        if (obstacle.x + FP_PIPE_W < left || obstacle.x > right) return false;
        const gapTop = obstacle.gapY - FP_GAP / 2;
        const gapBottom = obstacle.gapY + FP_GAP / 2;
        return y - FP_PLAYER_R < gapTop || y + FP_PLAYER_R > gapBottom;
      });
    }

    if (!invincible && collision) {
      lives -= 1;
      if (lives <= 0) {
        diedAtMs = Math.round(elapsed);
        break;
      }
      invincible = true;
      invincEnd = elapsed + 1300;
      y = FP_CS_H / 2;
      vy = 0;
      obstacles.length = 0;
      spawnHold = elapsed + 900;
    }
  }

  return {
    score,
    pipes,
    livesUsed: MAX_LIVES - lives,
    durationMs: diedAtMs ?? Math.round(cappedUntil),
    died: diedAtMs != null,
    flapCount: flapEvents.length,
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
    pipes: asInt(row.pipes),
    lives_used: asInt(row.lives_used),
    rounds_played: asInt(row.rounds_played),
  }));
}

function mapAwards(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
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

  const [weekRow] = await db`select public.flappy_pants_week_start(now()) as week_start`;
  const weekly = await db`
    select *
    from public.flappy_pants_current_week
    order by rank
    limit 20
  `;
  const allTime = await db`
    select *
    from public.flappy_pants_all_time
    order by rank
    limit 20
  `;
  const awards = await db`
    select *
    from public.flappy_pants_recent_awards
    order by week_start desc, rank asc
    limit 12
  `;
  const [myWeekly] = await db`
    select *
    from public.flappy_pants_current_week
    where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select *
    from public.flappy_pants_all_time
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
    insert into public.flappy_pants_rounds
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
  const flapEvents = parseFlapEvents(body.flapEvents);
  const effect = await getStrongestHeroEffect(db, userId, "flappy_pants");

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.flappy_pants_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");
    const actualElapsed = Date.now() - new Date(round.started_at).getTime();
    const requestedElapsed = Math.max(0, Math.min(ROUND_EXPIRES_SECONDS * 1000, asInt(body.elapsedMs, actualElapsed)));
    if (requestedElapsed > actualElapsed + 1000) throw gameError("Runda jeszcze trwa.");
    if (Date.now() < new Date(round.started_at).getTime() + MIN_PLAY_MS) {
      throw gameError("Runda jeszcze trwa.");
    }

    const replay = replayFlappy(asInt(round.seed, 1), flapEvents, requestedElapsed);
    const pipes = Math.max(0, Math.min(MAX_SCORE_PER_ROUND, replay.pipes));
    const baseScore = Math.max(0, Math.min(MAX_SCORE_PER_ROUND, replay.score));
    const livesUsed = Math.max(0, Math.min(MAX_LIVES, replay.livesUsed));
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

    await tx`
      update public.flappy_pants_rounds
         set submitted_at = now(),
             input_events = ${JSON.stringify({
               flapEvents,
               requestedElapsed,
               client_score: asInt(body.score, 0),
               client_pipes: asInt(body.pipes, 0),
               replay,
             })}::jsonb
       where id = ${round.id}
    `;

    const [inserted] = await tx`
      insert into public.flappy_pants_scores
        (round_id, user_id, nick_snapshot, week_start, score, pipes, lives_used, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.flappy_pants_week_start(now()),
          ${scoreValue},
          ${pipes},
          ${livesUsed},
          ${JSON.stringify({
            seed: asInt(round.seed, 1),
            flap_count: replay.flapCount,
            duration_ms: replay.durationMs,
            client_score: asInt(body.score, 0),
            client_pipes: asInt(body.pipes, 0),
            server_validated: true,
            base_score: baseScore,
            item_effect: itemEffect,
          })}::jsonb
        )
      returning *
    `;

    return inserted;
  });

  return {
    ...(await loadState(userId)),
    score: {
      id: score.id,
      score: asInt(score.score),
      pipes: asInt(score.pipes),
      lives_used: asInt(score.lives_used),
      submitted_at: score.submitted_at,
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
