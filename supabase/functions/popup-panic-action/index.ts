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

// ─────────────────────────────────────────────────────────────────────────────
// „Zamknij Popupy!" (popup_panic) — a fast ~30 s popup-closing frenzy.
//
// PARITY CONTRACT: the PP_* constants and the ppInitState / ppSpawnOne /
// ppSpawnGap / ppAdvanceTick / replayPopupPanic transition rules below must stay
// byte-for-byte equivalent to the PP_* block in index.html. The client plays this
// exact deterministic simulation (seeded LCG spawns) and logs only the ids it
// closed per tick; the server replays seed + events to derive the trusted score,
// so a client cannot claim a close of a popup that never existed / wasn't open.
// ─────────────────────────────────────────────────────────────────────────────
const PP_TICK_MS = 100;
const PP_ROUND_TICKS = 300;        // 30 s — survive to the cap = win
const PP_MAX_OPEN = 12;            // this many popups open at once = buried (lose)
const PP_MALWARE_TICKS = 25;       // 2.5 s to close a malware popup, else infected
const PP_MALWARE_CHANCE = 0.13;    // share of spawns that are malware
const PP_MIN_REACTION_TICKS = 2;   // a popup is "materializing" for 200 ms; closes before that don't count
const PP_SPAWN_GAP_START = 8;      // ticks between spawns at the start (0.8 s)
const PP_SPAWN_GAP_MIN = 2;        // fastest spawn cadence (0.2 s)
const PP_RAMP_EVERY = 30;          // every 3 s the spawn gap shrinks by one tick
const PP_BURST_AT_TICK = 120;      // after 12 s a spawn can arrive as a 2-popup burst
const PP_BURST_CHANCE = 0.30;
const PP_BOARD_W = 960;            // virtual popup-position space (cosmetic + client hit-test)
const PP_BOARD_H = 560;
const PP_POPUP_W = 168;
const PP_POPUP_H = 96;
const PP_SCORE_NORMAL = 1;
const PP_SCORE_MALWARE = 3;
const PP_MAX_EVENTS = 3000;        // max close events accepted per round
const PP_MAX_SCORE = 2000;         // anti-cheat ceiling

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

function ppInitState(seed) {
  return {
    rngState: (Number(seed) >>> 0) || 1,
    tick: 0,
    nextId: 1,
    open: [],            // { id, type (0 normal / 1 malware), x, y, spawnTick, deadline }
    spawnCountdown: 1,   // first popup on tick 1
    closed: 0,
    normalClosed: 0,
    malwareClosed: 0,
    score: 0,
    dead: false,
    deadReason: null,    // 'buried' | 'infected'
  };
}

function ppRng(st) {
  st.rngState = (Math.imul(st.rngState, 1664525) + 1013904223) >>> 0;
  return st.rngState / 4294967296;
}

function ppSpawnGap(tick) {
  const steps = Math.floor(tick / PP_RAMP_EVERY);
  return Math.max(PP_SPAWN_GAP_MIN, PP_SPAWN_GAP_START - steps);
}

// Draws exactly 3 rng values (type, x, y) in this order — the server replays this
// verbatim so the shared rng stream stays aligned even though it ignores x/y.
function ppSpawnOne(st) {
  const type = ppRng(st) < PP_MALWARE_CHANCE ? 1 : 0;
  const x = Math.floor(ppRng(st) * (PP_BOARD_W - PP_POPUP_W));
  const y = Math.floor(ppRng(st) * (PP_BOARD_H - PP_POPUP_H));
  const popup = {
    id: st.nextId,
    type,
    x,
    y,
    spawnTick: st.tick,
    deadline: type === 1 ? st.tick + PP_MALWARE_TICKS : 0,
  };
  st.nextId += 1;
  st.open.push(popup);
  return popup;
}

// One simulation tick. closeIds is the list of popup ids the player closed on
// THIS tick (click order). Returns cosmetic events (mirrored for the client).
function ppAdvanceTick(st, closeIds) {
  st.tick += 1;
  const ev = { closed: [], ignored: [], spawned: [], infected: false, buried: false };

  // 1) apply the player's close events
  if (closeIds && closeIds.length) {
    for (const id of closeIds) {
      const idx = st.open.findIndex((p) => p.id === id);
      if (idx < 0) { ev.ignored.push(id); continue; }
      const popup = st.open[idx];
      if (st.tick < popup.spawnTick + PP_MIN_REACTION_TICKS) { ev.ignored.push(id); continue; }
      st.open.splice(idx, 1);
      st.closed += 1;
      if (popup.type === 1) { st.malwareClosed += 1; st.score += PP_SCORE_MALWARE; }
      else { st.normalClosed += 1; st.score += PP_SCORE_NORMAL; }
      ev.closed.push(popup);
    }
  }

  // 2) any malware still open past its deadline infects the machine
  for (const popup of st.open) {
    if (popup.type === 1 && st.tick >= popup.deadline) {
      st.dead = true;
      st.deadReason = "infected";
      ev.infected = true;
      break;
    }
  }
  if (st.dead) return ev;

  // 3) spawns (with a chance of a 2-popup burst late in the round)
  st.spawnCountdown -= 1;
  if (st.spawnCountdown <= 0) {
    let count = 1;
    if (st.tick >= PP_BURST_AT_TICK && ppRng(st) < PP_BURST_CHANCE) count = 2;
    for (let i = 0; i < count; i += 1) {
      ev.spawned.push(ppSpawnOne(st));
      if (st.open.length >= PP_MAX_OPEN) {
        st.dead = true;
        st.deadReason = "buried";
        ev.buried = true;
        break;
      }
    }
    st.spawnCountdown = ppSpawnGap(st.tick);
  }
  return ev;
}

function parseEvents(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu kliknięć rundy.");
  if (value.length > PP_MAX_EVENTS) throw gameError("Za dużo kliknięć w rundzie.");
  let previousTick = 0;
  return value.map((entry) => {
    const tick = asInt(entry?.tick, NaN);
    const id = asInt(entry?.id, NaN);
    if (!Number.isFinite(tick) || tick < 1 || tick > PP_ROUND_TICKS) throw gameError("Nieprawidłowe kliknięcie.");
    if (!Number.isFinite(id) || id < 1) throw gameError("Nieprawidłowy popup.");
    if (tick < previousTick) throw gameError("Kliknięcia nie są uporządkowane.");
    previousTick = tick;
    return { tick, id };
  });
}

function replayPopupPanic(seed, events, untilTick) {
  const st = ppInitState(seed);
  const capped = Math.max(0, Math.min(PP_ROUND_TICKS, untilTick));
  let ei = 0;
  let diedAtTick = null;

  while (st.tick < capped) {
    const nextTick = st.tick + 1;
    const ids = [];
    while (ei < events.length && events[ei].tick === nextTick) {
      ids.push(events[ei].id);
      ei += 1;
    }
    ppAdvanceTick(st, ids);
    if (st.dead) {
      diedAtTick = st.tick;
      break;
    }
  }

  return {
    score: Math.min(PP_MAX_SCORE, st.score),
    closed: st.closed,
    normalClosed: st.normalClosed,
    malwareClosed: st.malwareClosed,
    spawned: st.nextId - 1,
    endTick: diedAtTick ?? capped,
    died: diedAtTick != null,
    deadReason: st.deadReason,
    completed: diedAtTick == null && capped >= PP_ROUND_TICKS,
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
        and (i.expires_at is null or i.expires_at > now())
        and (
          d.effect_game = ${game}
          or (
            ${game} in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz', 'popup_panic')
            and d.effect_type = 'score_bonus'
            and d.effect_game in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz', 'popup_panic')
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
    closed: asInt(row.closed),
    malware: asInt(row.malware),
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

  const [weekRow] = await db`select public.popup_panic_week_start(now()) as week_start`;
  const weekly = await db`
    select *
    from public.popup_panic_current_week
    order by rank
    limit 20
  `;
  const allTime = await db`
    select *
    from public.popup_panic_all_time
    order by rank
    limit 20
  `;
  const awards = await db`
    select *
    from public.popup_panic_recent_awards
    order by week_start desc, rank asc
    limit 12
  `;
  const [myWeekly] = await db`
    select *
    from public.popup_panic_current_week
    where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select *
    from public.popup_panic_all_time
    where user_id = ${userId}
  `;

  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    weekStart: weekRow?.week_start,
    tickMs: PP_TICK_MS,
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
    insert into public.popup_panic_rounds
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
      tickMs: PP_TICK_MS,
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
  const events = parseEvents(body.events);
  const requestedTick = asInt(body.elapsedTicks, 0);
  if (requestedTick < 1 || requestedTick > PP_ROUND_TICKS) throw gameError("Nieprawidłowy koniec rundy.");

  const effect = await getStrongestHeroEffect(db, userId, "popup_panic");

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.popup_panic_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");

    const actualElapsed = Date.now() - new Date(round.started_at).getTime();
    const actualTickCap = Math.floor((actualElapsed + 1500) / PP_TICK_MS);
    const endTick = requestedTick;
    if (events.some((entry) => entry.tick > endTick)) throw gameError("Kliknięcie po końcu rundy.");
    if (endTick > actualTickCap) throw gameError("Runda jeszcze trwa.");

    const replay = replayPopupPanic(asInt(round.seed), events, endTick);
    if (replay.endTick !== endTick) throw gameError("Runda zakończyła się wcześniej.");
    if (!replay.died && !replay.completed) throw gameError("Runda jeszcze trwa.");

    const baseScore = Math.max(0, Math.min(PP_MAX_SCORE, replay.score));
    const bonus = effect?.effect_type === "score_bonus"
      ? Math.max(0, asInt(effect.effect_value, 0))
      : 0;
    const scoreValue = Math.min(PP_MAX_SCORE, baseScore + bonus);
    const itemEffect = bonus > 0 && scoreValue > baseScore ? {
      slug: effect.slug,
      name: effect.name,
      type: effect.effect_type,
      value: Number(effect.effect_value),
      bonus: scoreValue - baseScore,
    } : null;
    const survivedPct = Math.round((replay.endTick / PP_ROUND_TICKS) * 10000) / 100;

    await tx`
      update public.popup_panic_rounds
         set submitted_at = now()
       where id = ${round.id}
    `;

    const [inserted] = await tx`
      insert into public.popup_panic_scores
        (round_id, user_id, nick_snapshot, week_start, score, closed, malware, moves, duration_ms, accuracy, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.popup_panic_week_start(now()),
          ${scoreValue},
          ${replay.closed},
          ${replay.malwareClosed},
          ${events.length},
          ${replay.endTick * PP_TICK_MS},
          ${survivedPct},
          ${JSON.stringify({
            seed: asInt(round.seed),
            tick_ms: PP_TICK_MS,
            elapsed_ticks: replay.endTick,
            client_score: asInt(body.score, 0),
            server_validated: true,
            died: replay.died,
            dead_reason: replay.deadReason,
            completed: replay.completed,
            spawned: replay.spawned,
            base_score: baseScore,
            item_effect: itemEffect,
          })}::jsonb
        )
      returning *
    `;

    return { inserted, itemEffect, replay };
  });

  return {
    ...(await loadState(userId)),
    score: {
      id: score.inserted.id,
      score: asInt(score.inserted.score),
      closed: asInt(score.inserted.closed),
      malware: asInt(score.inserted.malware),
      moves: asInt(score.inserted.moves),
      died: score.replay.died,
      deadReason: score.replay.deadReason,
      completed: score.replay.completed,
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
