// @ts-nocheck
// World Cup 2026 fixed-odds betting ("Mundial").
// Owns all writes to football_matches / football_bets. Browsers can only read
// those tables (RLS SELECT) — odds are never trusted from the client; the bet
// action locks the odds already stored server-side. The hourly cron (action
// "cron", authorized by FOOTBALL_CRON_SECRET) refreshes fixtures/odds from
// API-Football and auto-settles finished matches.
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
const db = databaseUrl
  ? postgres(databaseUrl, { prepare: false, max: 4, idle_timeout: 20 })
  : null;

// ── API-Football config ──────────────────────────────────────────────────────
// Confirm the league id / season once via GET /leagues?search=world cup&season=2026.
const API_BASE = "https://v3.football.api-sports.io";
const LEAGUE_ID = asInt(Deno.env.get("FOOTBALL_LEAGUE_ID"), 1);   // 1 = FIFA World Cup
const SEASON = asInt(Deno.env.get("FOOTBALL_SEASON"), 2026);
const PRIMARY_BOOKMAKER_ID = asInt(Deno.env.get("FOOTBALL_BOOKMAKER_ID"), 8); // 8 = Bet365
const MATCH_WINNER_BET_ID = 1;            // API-Football bet type "Match Winner" (1X2)
const MAX_ODDS_PAGES = 3;                 // cap API calls per run to respect free quota
const ODDS_WINDOW_HOURS = 120;            // only price fixtures kicking off within this window

const FINISHED = new Set(["FT", "AET", "PEN"]);
const VOIDED = new Set(["CANC", "ABD", "PST", "WO", "AWD"]);

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

function asNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

// ── API-Football fetch ─────────────────────────────────────────────────────────
async function apiGet(path) {
  const apiKey = Deno.env.get("FOOTBALL_API_KEY");
  if (!apiKey) throw new Error("Missing FOOTBALL_API_KEY.");
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "x-apisports-key": apiKey },
  });
  if (!res.ok) throw new Error(`API-Football ${path} -> HTTP ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data?.errors) ? data.errors.length : (data?.errors && Object.keys(data.errors).length)) {
    console.warn("API-Football errors:", JSON.stringify(data.errors));
  }
  return data;
}

// De-vig: implied prob_i = (1/odd_i) / Σ(1/odd_j).
function deVig(oddsHome, oddsDraw, oddsAway) {
  const inv = [oddsHome, oddsDraw, oddsAway].map((o) => (o && o > 1 ? 1 / o : 0));
  const sum = inv[0] + inv[1] + inv[2];
  if (sum <= 0) return [null, null, null];
  return inv.map((v) => Math.round((v / sum) * 10000) / 10000);
}

function resultFromFixture(fixture) {
  // Prefer the API's winner flags (handles extra time / penalties); fall back to goals.
  const home = fixture?.teams?.home;
  const away = fixture?.teams?.away;
  if (home?.winner === true) return "1";
  if (away?.winner === true) return "2";
  const hg = asInt(fixture?.goals?.home, null);
  const ag = asInt(fixture?.goals?.away, null);
  if (hg == null || ag == null) return null;
  if (hg > ag) return "1";
  if (hg < ag) return "2";
  return "X";
}

// ── State (read) ─────────────────────────────────────────────────────────────
function mapMatch(row) {
  return {
    id: String(row.id),
    kickoff: row.kickoff,
    status: row.status,
    home_team: row.home_team,
    away_team: row.away_team,
    home_logo: row.home_logo,
    away_logo: row.away_logo,
    home_goals: row.home_goals == null ? null : asInt(row.home_goals),
    away_goals: row.away_goals == null ? null : asInt(row.away_goals),
    result: row.result,
    odds_home: asNum(row.odds_home),
    odds_draw: asNum(row.odds_draw),
    odds_away: asNum(row.odds_away),
    prob_home: asNum(row.prob_home),
    prob_draw: asNum(row.prob_draw),
    prob_away: asNum(row.prob_away),
    bookmaker: row.bookmaker,
    settled: row.settled === true,
  };
}

function mapBet(row) {
  return {
    id: row.id,
    match_id: String(row.match_id),
    pick: row.pick,
    stake: asInt(row.stake),
    locked_odds: asNum(row.locked_odds),
    potential_payout: asInt(row.potential_payout),
    status: row.status,
    created_at: row.created_at,
    settled_at: row.settled_at,
  };
}

async function loadState(userId) {
  if (!db) throw new Error("Database is not configured.");

  const matches = await db`
    select *
    from public.football_matches
    where settled = false
       or kickoff > now() - interval '2 days'
    order by kickoff asc
    limit 200
  `;

  let profile = null;
  let bets = [];
  if (userId) {
    const [p] = await db`select id, nick, coins from public.profiles where id = ${userId}`;
    if (p) profile = { id: p.id, nick: p.nick, coins: asInt(p.coins) };
    bets = await db`
      select *
      from public.football_bets
      where user_id = ${userId}
      order by created_at desc
      limit 100
    `;
  }

  return {
    profile,
    matches: matches.map(mapMatch),
    bets: bets.map(mapBet),
  };
}

// ── Bet (write) ────────────────────────────────────────────────────────────────
async function placeBet(userId, body) {
  if (!db) throw new Error("Database is not configured.");
  const matchId = asInt(body.matchId, 0);
  const pick = String(body.pick ?? "");
  const stake = asInt(body.stake, 0);
  if (!matchId) throw gameError("Brak meczu.");
  if (!["1", "X", "2"].includes(pick)) throw gameError("Niepoprawny typ.");
  if (stake < 1) throw gameError("Stawka musi być dodatnia.");

  const bet = await db.begin(async (tx) => {
    const [match] = await tx`
      select * from public.football_matches where id = ${matchId} for update
    `;
    if (!match) throw gameError("Mecz nie istnieje.");
    if (match.status !== "NS") throw gameError("Mecz już się rozpoczął — zakłady zamknięte.");
    if (new Date(match.kickoff).getTime() <= Date.now()) throw gameError("Zakłady na ten mecz są zamknięte.");

    const odds = pick === "1" ? match.odds_home : pick === "X" ? match.odds_draw : match.odds_away;
    const lockedOdds = asNum(odds);
    if (!lockedOdds || lockedOdds <= 1) throw gameError("Brak kursów dla tego meczu.");

    const [profile] = await tx`
      select id, nick, coins from public.profiles where id = ${userId} for update
    `;
    if (!profile) throw gameError("Profil nie istnieje.");
    if (asInt(profile.coins) < stake) throw gameError("Za mało coinów!");

    const payout = Math.floor(stake * lockedOdds);

    await tx`update public.profiles set coins = coins - ${stake} where id = ${userId}`;

    const [inserted] = await tx`
      insert into public.football_bets
        (user_id, nick_snapshot, match_id, pick, stake, locked_odds, potential_payout)
      values
        (${userId}, ${profile.nick}, ${matchId}, ${pick}, ${stake}, ${lockedOdds}, ${payout})
      returning *
    `;
    return inserted;
  });

  return {
    ...(await loadState(userId)),
    placed: mapBet(bet),
  };
}

// ── Cron: sync fixtures + odds, then settle finished matches ─────────────────────
async function syncFixtures() {
  const data = await apiGet(`/fixtures?league=${LEAGUE_ID}&season=${SEASON}`);
  const fixtures = data?.response ?? [];
  for (const f of fixtures) {
    const id = asInt(f?.fixture?.id, 0);
    if (!id) continue;
    const status = String(f?.fixture?.status?.short ?? "NS");
    await db`
      insert into public.football_matches
        (id, league_id, season, kickoff, status, home_team, away_team, home_logo, away_logo, home_goals, away_goals, updated_at)
      values (
        ${id}, ${LEAGUE_ID}, ${SEASON},
        ${f?.fixture?.date}, ${status},
        ${f?.teams?.home?.name ?? "?"}, ${f?.teams?.away?.name ?? "?"},
        ${f?.teams?.home?.logo ?? null}, ${f?.teams?.away?.logo ?? null},
        ${asInt(f?.goals?.home, null)}, ${asInt(f?.goals?.away, null)},
        now()
      )
      on conflict (id) do update set
        kickoff = excluded.kickoff,
        status = excluded.status,
        home_team = excluded.home_team,
        away_team = excluded.away_team,
        home_logo = excluded.home_logo,
        away_logo = excluded.away_logo,
        home_goals = excluded.home_goals,
        away_goals = excluded.away_goals,
        updated_at = now()
    `;
  }
  return { fixtures: fixtures.length, calls: 1 };
}

async function syncOdds() {
  // Which not-yet-started fixtures are within the pricing window?
  const windowRows = await db`
    select id from public.football_matches
    where status = 'NS'
      and kickoff between now() and now() + (${ODDS_WINDOW_HOURS} || ' hours')::interval
  `;
  const wanted = new Set(windowRows.map((r) => asInt(r.id)));
  if (wanted.size === 0) return { priced: 0, calls: 0 };

  let priced = 0;
  let calls = 0;
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= MAX_ODDS_PAGES) {
    const data = await apiGet(`/odds?league=${LEAGUE_ID}&season=${SEASON}&bet=${MATCH_WINNER_BET_ID}&page=${page}`);
    calls += 1;
    totalPages = asInt(data?.paging?.total, 1);
    for (const row of data?.response ?? []) {
      const fixtureId = asInt(row?.fixture?.id, 0);
      if (!wanted.has(fixtureId)) continue;
      const books = row?.bookmakers ?? [];
      const book = books.find((b) => asInt(b?.id) === PRIMARY_BOOKMAKER_ID) ?? books[0];
      if (!book) continue;
      const mw = (book.bets ?? []).find((b) => asInt(b?.id) === MATCH_WINNER_BET_ID || b?.name === "Match Winner");
      if (!mw) continue;
      let oHome = null, oDraw = null, oAway = null;
      for (const v of mw.values ?? []) {
        const label = String(v?.value ?? "").toLowerCase();
        const odd = asNum(v?.odd);
        if (label === "home" || label === "1") oHome = odd;
        else if (label === "draw" || label === "x") oDraw = odd;
        else if (label === "away" || label === "2") oAway = odd;
      }
      if (!oHome || !oDraw || !oAway) continue;
      const [pHome, pDraw, pAway] = deVig(oHome, oDraw, oAway);
      await db`
        update public.football_matches set
          odds_home = ${oHome}, odds_draw = ${oDraw}, odds_away = ${oAway},
          prob_home = ${pHome}, prob_draw = ${pDraw}, prob_away = ${pAway},
          bookmaker = ${book.name ?? null}, odds_updated_at = now(), updated_at = now()
        where id = ${fixtureId}
      `;
      priced += 1;
    }
    page += 1;
  }
  return { priced, calls };
}

async function settleFinished() {
  // Re-read fixtures we just upserted; settle any finished/void match still open.
  const rows = await db`
    select id, status, home_goals, away_goals
    from public.football_matches
    where settled = false and status = any(${[...FINISHED, ...VOIDED]})
  `;
  let settledMatches = 0;
  let paidBets = 0;
  let voidedBets = 0;

  for (const m of rows) {
    const id = asInt(m.id);
    const isVoid = VOIDED.has(m.status);
    // Build a minimal fixture-like object for result derivation.
    const hg = m.home_goals == null ? null : asInt(m.home_goals);
    const ag = m.away_goals == null ? null : asInt(m.away_goals);
    const result = isVoid ? null : resultFromFixture({ teams: {}, goals: { home: hg, away: ag } });
    if (!isVoid && !result) continue; // finished but no usable score yet — try next run

    await db.begin(async (tx) => {
      if (isVoid) {
        // Refund every open bet on this match.
        const open = await tx`
          select id, user_id, stake from public.football_bets
          where match_id = ${id} and status = 'open' for update
        `;
        for (const b of open) {
          await tx`update public.profiles set coins = coins + ${asInt(b.stake)} where id = ${b.user_id}`;
          await tx`update public.football_bets set status = 'void', settled_at = now() where id = ${b.id}`;
          voidedBets += 1;
        }
        await tx`update public.football_matches set settled = true, updated_at = now() where id = ${id}`;
        return;
      }

      const open = await tx`
        select id, user_id, pick, potential_payout from public.football_bets
        where match_id = ${id} and status = 'open' for update
      `;
      for (const b of open) {
        if (b.pick === result) {
          await tx`update public.profiles set coins = coins + ${asInt(b.potential_payout)} where id = ${b.user_id}`;
          await tx`update public.football_bets set status = 'won', settled_at = now() where id = ${b.id}`;
          paidBets += 1;
        } else {
          await tx`update public.football_bets set status = 'lost', settled_at = now() where id = ${b.id}`;
        }
      }
      await tx`update public.football_matches set result = ${result}, settled = true, updated_at = now() where id = ${id}`;
    });
    settledMatches += 1;
  }
  return { settledMatches, paidBets, voidedBets };
}

async function runCron() {
  if (!db) throw new Error("Database is not configured.");
  const fx = await syncFixtures();
  const od = await syncOdds();
  const st = await settleFinished();
  const summary = { ...fx, ...od, ...st, apiCalls: fx.calls + od.calls };
  console.log("football cron:", JSON.stringify(summary));
  return summary;
}

// ── HTTP entry ───────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "state");

    if (action === "cron") {
      const secret = req.headers.get("x-cron-secret") ?? "";
      const expected = Deno.env.get("FOOTBALL_CRON_SECRET") ?? "";
      if (!expected || secret !== expected) return json({ ok: false, error: "Forbidden." }, 403);
      const result = await runCron();
      return json({ ok: true, ...result });
    }

    if (action === "state") {
      // Public read; include user's bets only when a valid session is present.
      let userId = null;
      try { userId = (await requireUser(req)).id; } catch (_e) { userId = null; }
      const result = await loadState(userId);
      return json({ ok: true, ...result });
    }

    if (action === "bet") {
      const user = await requireUser(req);
      const result = await placeBet(user.id, body);
      return json({ ok: true, ...result });
    }

    throw gameError("Nieznana akcja.");
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
