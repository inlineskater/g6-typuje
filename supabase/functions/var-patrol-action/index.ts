// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

// VAR Patrol — offside-only football-officiating judgement/reaction seasonal game.
// Mirrors whack-boss-action: the server issues a round schedule of scenarios and
// validates submitted answer timing + correctness on submit. Anti-cheat is the
// reaction-time floor + total round clock + score cap (the displayed scene
// encodes the correct verdict, exactly like Whack-a-Boss's visible target).

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://inlineskater.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
const db = databaseUrl
  ? postgres(databaseUrl, { prepare: false, max: 4, idle_timeout: 20 })
  : null;

const VAR_MAX_SCENARIOS = 120;
const VAR_MAX_SCORE = 100;
const VAR_ROUND_MS = 20_000;
const VAR_REACTION_FLOOR_MS = 120;
const VAR_REACTION_TOL_MS = 220;
const ROUND_EXPIRES_SECONDS = 600;
const PRIZES = [100, 50, 25];

// Scenario verdict labels (Polish). Correct answer index (0/1) is stored server-side.
const VERDICTS = {
  offside: ["SPALONY", "GRA"],
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

function randInt(min, max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] % (max - min + 1));
}

function randChance(percent) {
  return randInt(1, 100) <= percent;
}

// Cosmetic per-scenario pace hint for the client; the authoritative limit is VAR_ROUND_MS.
function varWindow(index) {
  return Math.max(1500, 2800 - index * 8);
}

// Build one scenario. The scene encodes the correct verdict (the player reads it);
// `correct` is the authoritative answer index validated on submit.
function makeScenario(index, difficulty) {
  const type = "offside";
  const tight = index > 2 ? randChance(72) : randChance(38);
  const gap = tight
    ? randInt(2, Math.max(4, 9 - Math.round(difficulty / 9)))
    : randInt(10, Math.max(12, 20 - Math.round(difficulty / 5)));
  const offside = randChance(50);
  const defenderX = randInt(42, 66);
  const attackerX = offside ? defenderX + gap : defenderX - gap;
  const attackerY = randInt(32, 70);
  const defenderY = Math.max(26, Math.min(76, attackerY + randInt(-10, 10)));
  const defenders = [
    { x: defenderX, y: defenderY, label: "D", main: true },
  ];
  const attackers = [
    { x: attackerX, y: attackerY, label: "A", main: true },
  ];

  const defenderCount = randInt(3, 5);
  for (let i = 0; i < defenderCount; i++) {
    defenders.push({
      x: Math.max(18, defenderX - randInt(5, 28)),
      y: randInt(28, 76),
      label: String((i % 4) + 2),
    });
  }

  const attackerCount = randInt(2, 4);
  for (let i = 0; i < attackerCount; i++) {
    attackers.push({
      x: Math.max(18, Math.min(82, defenderX + randInt(-22, 14))),
      y: randInt(28, 76),
      label: String((i % 3) + 7),
    });
  }

  const scene = {
    attackerX,
    defenderX,
    attackerY,
    defenderY,
    attackDirection: "right",
    tight,
    passer: { x: randInt(15, 24), y: randInt(58, 78) },
    defenders,
    attackers,
  };
  const correct = attackerX > defenderX ? 0 : 1; // beyond last defender = SPALONY
  return {
    index,
    type,
    verdicts: VERDICTS[type],
    windowMs: varWindow(index),
    scene,
    correct,
  };
}

function buildSchedule() {
  const schedule = [];
  for (let i = 0; i < VAR_MAX_SCENARIOS; i++) {
    schedule.push(makeScenario(i, i * 0.08));
  }
  return schedule;
}

// Strip the authoritative answer before sending the schedule to the client.
function clientSchedule(schedule) {
  return (schedule || []).map((s) => ({
    index: asInt(s.index),
    type: s.type,
    verdicts: s.verdicts,
    windowMs: asInt(s.windowMs),
    scene: s.scene,
  }));
}

function parseAnswers(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu decyzji rundy.");
  if (value.length > VAR_MAX_SCENARIOS + 5) throw gameError("Za dużo decyzji w rundzie.");
  return value.map((a) => ({
    index: asInt(a?.index, -1),
    answer: asInt(a?.answer, -1),
    reactionMs: asNumber(a?.reactionMs, NaN),
    elapsedMs: asNumber(a?.elapsedMs ?? a?.atMs, NaN),
  }));
}

// Replay answers against the schedule in order. The round is a fixed-time sprint:
// wrong answers only hurt accuracy/combo, they no longer end the run.
function scoreAnswers(schedule, answers, submittedDurationMs) {
  const byIndex = new Map(schedule.map((s) => [asInt(s.index), s]));
  const sorted = answers
    .filter((a) => byIndex.has(a.index))
    .sort((a, b) => a.index - b.index);
  let correct = 0;
  let wrong = 0;
  let combo = 0;
  let maxCombo = 0;
  let durationMs = 0;
  let expected = 0;
  for (const a of sorted) {
    if (a.index !== expected) break; // must be sequential, no skipping
    const scenario = byIndex.get(a.index);
    const reaction = Number.isFinite(a.reactionMs) ? a.reactionMs : NaN;
    const elapsed = Number.isFinite(a.elapsedMs)
      ? Math.max(0, a.elapsedMs)
      : durationMs + (Number.isFinite(reaction) ? Math.max(0, reaction) : 0);
    if (elapsed > VAR_ROUND_MS + VAR_REACTION_TOL_MS) break;
    expected += 1;
    durationMs = Math.max(durationMs, Math.min(VAR_ROUND_MS, elapsed));
    const inWindow = reaction >= VAR_REACTION_FLOOR_MS;
    const isCorrect = inWindow && a.answer === asInt(scenario.correct);
    if (isCorrect) {
      correct += 1;
      combo += 1;
      maxCombo = Math.max(maxCombo, combo);
    } else {
      wrong += 1;
      combo = 0;
    }
  }
  if (Number.isFinite(submittedDurationMs)) {
    durationMs = Math.max(durationMs, Math.min(VAR_ROUND_MS, Math.max(0, submittedDurationMs)));
  }
  return { correct, wrong, maxCombo, durationMs: Math.round(durationMs) };
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

  const [weekRow] = await db`select public.var_patrol_week_start(now()) as week_start`;
  const weekly = await db`
    select *
    from public.var_patrol_current_week
    order by rank
    limit 20
  `;
  const allTime = await db`
    select *
    from public.var_patrol_all_time
    order by rank
    limit 20
  `;
  const awards = await db`
    select *
    from public.var_patrol_recent_awards
    order by week_start desc, rank asc
    limit 12
  `;
  const [myWeekly] = await db`
    select *
    from public.var_patrol_current_week
    where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select *
    from public.var_patrol_all_time
    where user_id = ${userId}
  `;

  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    weekStart: weekRow?.week_start,
    roundMs: VAR_ROUND_MS,
    maxScore: VAR_MAX_SCORE,
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

  const schedule = buildSchedule();
  const [round] = await db`
    insert into public.var_patrol_rounds
      (user_id, nick_snapshot, schedule, expires_at)
    values
      (${userId}, ${profile.nick}, ${JSON.stringify(schedule)}::jsonb, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
    returning id, started_at, expires_at
  `;

  return {
    ...(await loadState(userId)),
    round: {
      id: round.id,
      roundMs: VAR_ROUND_MS,
      schedule: clientSchedule(schedule),
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
  const effect = await getStrongestHeroEffect(db, userId, "var_patrol");

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.var_patrol_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");

    const schedule = Array.isArray(round.schedule) ? round.schedule : [];
    const answers = parseAnswers(body.answers);
    const submittedDurationMs = asNumber(body.roundDurationMs, NaN);
    const result = scoreAnswers(schedule, answers, submittedDurationMs);
    const correct = Math.max(0, Math.min(VAR_MAX_SCORE, result.correct));
    const misses = Math.max(0, result.wrong);
    const maxCombo = Math.max(0, Math.min(correct, result.maxCombo));
    const bonus = effect?.effect_type === "score_bonus"
      ? Math.max(0, asInt(effect.effect_value, 0))
      : 0;
    const scoreValue = Math.min(VAR_MAX_SCORE, correct + bonus);
    const itemEffect = bonus > 0 && scoreValue > correct ? {
      slug: effect.slug,
      name: effect.name,
      type: effect.effect_type,
      value: Number(effect.effect_value),
      bonus: scoreValue - correct,
    } : null;
    const attempts = correct + misses;
    const accuracy = attempts > 0 ? Math.round((correct / attempts) * 10000) / 100 : 0;

    await tx`
      update public.var_patrol_rounds
         set submitted_at = now(),
             answers = ${JSON.stringify(answers.slice(0, VAR_MAX_SCENARIOS).map((a) => ({
               index: a.index,
               answer: a.answer,
               reactionMs: Number.isFinite(a.reactionMs) ? Math.round(a.reactionMs) : null,
               elapsedMs: Number.isFinite(a.elapsedMs) ? Math.round(a.elapsedMs) : null,
             })))}::jsonb,
             duration_ms = ${result.durationMs}
       where id = ${round.id}
    `;

    const [inserted] = await tx`
      insert into public.var_patrol_scores
        (round_id, user_id, nick_snapshot, week_start, score, hits, misses, accuracy, max_combo, duration_ms, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.var_patrol_week_start(now()),
          ${scoreValue},
          ${correct},
          ${misses},
          ${accuracy},
          ${maxCombo},
          ${result.durationMs},
          ${JSON.stringify({
            answer_count: answers.length,
            server_validated: true,
            base_score: correct,
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
