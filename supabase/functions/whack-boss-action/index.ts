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

const ROUND_DURATION_MS = 18_000;
const ROUND_EXPIRES_SECONDS = 120;
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

function generateSchedule() {
  const targets = [];
  let cursor = 620;
  let i = 0;

  while (cursor < ROUND_DURATION_MS - 420) {
    const durationMs = Math.max(460, 880 - i * 15 + randInt(-35, 35));
    const gapMs = randInt(80, 175);
    targets.push({
      index: i,
      startMs: cursor,
      durationMs,
      x: randInt(12, 88),
      y: randInt(16, 84),
      radiusPct: 12,
      sizePct: 14,
    });
    cursor += durationMs + gapMs;
    i += 1;
  }

  return targets;
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

  const schedule = generateSchedule();
  const [round] = await db`
    insert into public.whack_boss_rounds
      (user_id, nick_snapshot, schedule, duration_ms, expires_at)
    values
      (${userId}, ${profile.nick}, ${JSON.stringify(schedule)}::jsonb, ${ROUND_DURATION_MS}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
    returning id, started_at, expires_at
  `;

  return {
    ...(await loadState(userId)),
    round: {
      id: round.id,
      durationMs: ROUND_DURATION_MS,
      startedAt: round.started_at,
      serverNow: new Date().toISOString(),
      expiresAt: round.expires_at,
      schedule,
    },
  };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function normalizeMisses(value) {
  const misses = asInt(value, 0);
  return Math.max(0, Math.min(999, misses));
}

async function submitRound(userId, body) {
  if (!db) throw new Error("Database is not configured.");
  const roundId = String(body.roundId ?? "");
  if (!roundId) throw gameError("Brak rundy do zapisania.");

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

    const schedule = parseJsonArray(round.schedule);
    const scheduleLen = schedule.length;
    const hits = Math.max(0, Math.min(scheduleLen, asInt(body.hits, 0)));
    const misses = normalizeMisses(body.misses);
    const maxCombo = Math.max(0, Math.min(hits, asInt(body.maxCombo, 0)));
    const scoreValue = hits;
    const accuracy = scheduleLen > 0 ? Math.round((hits / scheduleLen) * 10000) / 100 : 0;

    await tx`
      update public.whack_boss_rounds
         set submitted_at = now()
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
          ${JSON.stringify({ event_count: hits + misses, server_validated: false })}::jsonb
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
