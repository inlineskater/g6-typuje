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

const ROUND_EXPIRES_SECONDS = 120;
const MIN_PLAY_MS = 1_500;
const MAX_SCORE_PER_ROUND = 200;
const MAX_LIVES = 3;
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
            ${game} in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake')
            and d.effect_type = 'score_bonus'
            and d.effect_game in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake')
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

  const [round] = await db`
    insert into public.flappy_pants_rounds
      (user_id, nick_snapshot, expires_at)
    values
      (${userId}, ${profile.nick}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
    returning id, started_at, expires_at
  `;

  return {
    ...(await loadState(userId)),
    round: {
      id: round.id,
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
    if (Date.now() < new Date(round.started_at).getTime() + MIN_PLAY_MS) {
      throw gameError("Runda jeszcze trwa.");
    }

    const pipes = Math.max(0, Math.min(MAX_SCORE_PER_ROUND, asInt(body.pipes, 0)));
    const baseScore = Math.max(0, Math.min(MAX_SCORE_PER_ROUND, asInt(body.score, pipes)));
    const livesUsed = Math.max(0, Math.min(MAX_LIVES, asInt(body.livesUsed, MAX_LIVES)));
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
         set submitted_at = now()
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
          ${JSON.stringify({ server_validated: false, base_score: baseScore, item_effect: itemEffect })}::jsonb
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
