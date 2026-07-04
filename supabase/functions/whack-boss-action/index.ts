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

const ROUND_DURATION_MS = 18_000;
const ROUND_EXPIRES_SECONDS = 120;
const MAX_HITS_PER_ROUND = 60;
const TARGET_HIT_RADIUS = 12;
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

function randInt(min, max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] % (max - min + 1));
}

function whackDuration(difficulty) {
  return Math.max(320, Math.round(900 - difficulty * 25));
}

function whackGap(difficulty) {
  return Math.max(70, Math.round(130 - difficulty * 4));
}

function buildSchedule() {
  const schedule = [];
  let elapsed = 620;
  let difficulty = 0;
  while (elapsed + 250 < ROUND_DURATION_MS && schedule.length < MAX_HITS_PER_ROUND) {
    const durationMs = whackDuration(difficulty);
    schedule.push({
      index: schedule.length,
      startMs: Math.round(elapsed),
      durationMs,
      x: randInt(12, 88),
      y: randInt(16, 84),
    });
    difficulty += 0.75;
    elapsed += durationMs + whackGap(difficulty);
  }
  return schedule;
}

function parseHitEvents(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu kliknięć rundy.");
  if (value.length > MAX_HITS_PER_ROUND * 2) throw gameError("Za dużo kliknięć w rundzie.");
  return value.map((event) => ({
    targetIndex: asInt(event?.targetIndex, -1),
    atMs: asNumber(event?.atMs, NaN),
    x: asNumber(event?.x, NaN),
    y: asNumber(event?.y, NaN),
  }));
}

function parseMissEvents(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 999).map((event) => ({
    atMs: asNumber(event?.atMs, NaN),
    x: asNumber(event?.x, NaN),
    y: asNumber(event?.y, NaN),
  })).filter((event) =>
    Number.isFinite(event.atMs) &&
    event.atMs >= 0 &&
    event.atMs <= ROUND_DURATION_MS + 1000 &&
    Number.isFinite(event.x) &&
    Number.isFinite(event.y)
  );
}

function validateHits(schedule, hitEvents) {
  const byIndex = new Map(schedule.map((target) => [asInt(target.index), target]));
  const accepted = [];
  const hitIndexes = new Set();
  for (const event of hitEvents) {
    const target = byIndex.get(event.targetIndex);
    if (!target || hitIndexes.has(event.targetIndex)) continue;
    if (!Number.isFinite(event.atMs) || !Number.isFinite(event.x) || !Number.isFinite(event.y)) continue;
    const start = asNumber(target.startMs);
    const end = start + asNumber(target.durationMs);
    if (event.atMs < start - 120 || event.atMs > end + 120) continue;
    const dx = event.x - asNumber(target.x);
    const dy = event.y - asNumber(target.y);
    if (Math.sqrt(dx * dx + dy * dy) > TARGET_HIT_RADIUS) continue;
    hitIndexes.add(event.targetIndex);
    accepted.push({ ...event, target });
  }
  accepted.sort((a, b) => a.atMs - b.atMs || a.targetIndex - b.targetIndex);
  let combo = 0;
  let maxCombo = 0;
  let lastIndex = -2;
  for (const hit of accepted) {
    combo = hit.targetIndex === lastIndex + 1 ? combo + 1 : 1;
    maxCombo = Math.max(maxCombo, combo);
    lastIndex = hit.targetIndex;
  }
  return { accepted, hitIndexes, maxCombo };
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
    hits: asInt(row.hits),
    misses: asInt(row.misses),
    max_combo: asInt(row.max_combo),
    rounds_played: asInt(row.rounds_played),
    accuracy: asNumber(row.accuracy),
  }));
}

function mapAwards(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    prize_coins: asInt(row.prize_coins),
    accuracy: asNumber(row.accuracy),
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

  const [weekRow] = await db`select public.whack_boss_week_start(now()) as week_start`;
  const weekly = await db`
    select *
    from public.whack_boss_current_week
    order by rank
    limit 20
  `;
  const allTime = await db`
    select *
    from public.whack_boss_all_time
    order by rank
    limit 20
  `;
  const awards = await db`
    select *
    from public.whack_boss_recent_awards
    order by week_start desc, rank asc
    limit 12
  `;
  const [myWeekly] = await db`
    select *
    from public.whack_boss_current_week
    where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select *
    from public.whack_boss_all_time
    where user_id = ${userId}
  `;

  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    weekStart: weekRow?.week_start,
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
    insert into public.whack_boss_rounds
      (user_id, nick_snapshot, schedule, duration_ms, expires_at)
    values
      (${userId}, ${profile.nick}, ${JSON.stringify(buildSchedule())}::jsonb, ${ROUND_DURATION_MS}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
    returning id, schedule, started_at, expires_at
  `;

  return {
    ...(await loadState(userId)),
    round: {
      id: round.id,
      durationMs: ROUND_DURATION_MS,
      schedule: round.schedule,
      startedAt: round.started_at,
      serverNow: new Date().toISOString(),
      expiresAt: round.expires_at,
    },
  };
}

function normalizeMisses(value) {
  const misses = asInt(value, 0);
  return Math.max(0, Math.min(999, misses));
}

async function submitRound(userId, body) {
  if (!db) throw new Error("Database is not configured.");
  const roundId = String(body.roundId ?? "");
  if (!roundId) throw gameError("Brak rundy do zapisania.");
  const effect = await getStrongestHeroEffect(db, userId, "whack_boss");

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.whack_boss_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");
    const minSubmitAt = new Date(round.started_at).getTime() + asInt(round.duration_ms, ROUND_DURATION_MS) - 750;
    if (Date.now() < minSubmitAt) throw gameError("Runda jeszcze trwa.");

    const schedule = Array.isArray(round.schedule) ? round.schedule : [];
    const hitEvents = parseHitEvents(body.hitEvents);
    const missEvents = parseMissEvents(body.missEvents);
    const validated = validateHits(schedule, hitEvents);
    const hits = Math.max(0, Math.min(MAX_HITS_PER_ROUND, validated.accepted.length));
    const missedTargets = schedule.filter((target) => !validated.hitIndexes.has(asInt(target.index))).length;
    const misses = normalizeMisses(missedTargets + missEvents.length);
    const maxCombo = Math.max(0, Math.min(hits, validated.maxCombo));
    const bonus = effect?.effect_type === "score_bonus"
      ? Math.max(0, asInt(effect.effect_value, 0))
      : 0;
    const scoreValue = Math.min(MAX_HITS_PER_ROUND, hits + bonus);
    const itemEffect = bonus > 0 && scoreValue > hits ? {
      slug: effect.slug,
      name: effect.name,
      type: effect.effect_type,
      value: Number(effect.effect_value),
      bonus: scoreValue - hits,
    } : null;
    const attempts = hits + misses;
    const accuracy = attempts > 0 ? Math.round((hits / attempts) * 10000) / 100 : 0;

    await tx`
      update public.whack_boss_rounds
         set submitted_at = now(),
             hit_events = ${JSON.stringify({ hitEvents, missEvents, accepted: validated.accepted.map((event) => ({
               targetIndex: event.targetIndex,
               atMs: Math.round(event.atMs),
               x: Math.round(event.x * 100) / 100,
               y: Math.round(event.y * 100) / 100,
             })) })}::jsonb
       where id = ${round.id}
    `;

    const [inserted] = await tx`
      insert into public.whack_boss_scores
        (round_id, user_id, nick_snapshot, week_start, score, hits, misses, accuracy, max_combo, duration_ms, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.whack_boss_week_start(now()),
          ${scoreValue},
          ${hits},
          ${misses},
          ${accuracy},
          ${maxCombo},
          ${asInt(round.duration_ms, ROUND_DURATION_MS)},
          ${JSON.stringify({
            event_count: hits + misses,
            submitted_hit_count: hitEvents.length,
            accepted_hit_count: hits,
            server_validated: true,
            base_score: hits,
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
      hits: asInt(score.hits),
      misses: asInt(score.misses),
      accuracy: asNumber(score.accuracy),
      max_combo: asInt(score.max_combo),
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
