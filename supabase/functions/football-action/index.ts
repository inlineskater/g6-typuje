// @ts-nocheck
// World Cup 2026 fixed-odds betting ("Mundial") — backed by The Odds API (v4).
// Owns all writes to football_matches / football_bets. Browsers can only read
// those tables (RLS SELECT) — odds are never trusted from the client; the bet
// action locks the odds already stored server-side. The cron action (gated by
// FOOTBALL_CRON_SECRET) refreshes events/odds and settles finished matches.
//
// Quota note: The Odds API free tier is 500 requests/month. Each cron run costs
// 1 (odds) + 2 (scores, only when there is something to settle) = up to 3. The
// pg_cron job therefore runs every 6h (≈12 req/day, ≈360/month) — hourly is
// impossible on free (24×30 > 500). See supabase/football.sql.
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://inlineskater.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
const db = databaseUrl
  ? postgres(databaseUrl, { prepare: false, max: 4, idle_timeout: 20 })
  : null;

// ── The Odds API config ────────────────────────────────────────────────────
const ODDS_BASE = "https://api.the-odds-api.com/v4";
const SPORT_KEY = Deno.env.get("ODDS_SPORT_KEY") ?? "soccer_fifa_world_cup";
const ODDS_REGIONS = Deno.env.get("ODDS_REGIONS") ?? "eu";
const PREFERRED_BOOKMAKER = Deno.env.get("ODDS_BOOKMAKER") ?? ""; // e.g. "pinnacle"; empty = first usable
const SCORES_DAYS_FROM = 3;

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

// ── The Odds API fetch ─────────────────────────────────────────────────────
async function oddsGet(path) {
  const apiKey = Deno.env.get("ODDS_API_KEY");
  if (!apiKey) throw new Error("Missing ODDS_API_KEY.");
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${ODDS_BASE}${path}${sep}apiKey=${apiKey}`);
  const remaining = res.headers.get("x-requests-remaining");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Odds API ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return { data, remaining };
}

// De-vig: implied prob_i = (1/odd_i) / Σ(1/odd_j).
function deVig(oddsHome, oddsDraw, oddsAway) {
  const inv = [oddsHome, oddsDraw, oddsAway].map((o) => (o && o > 1 ? 1 / o : 0));
  const sum = inv[0] + inv[1] + inv[2];
  if (sum <= 0) return [null, null, null];
  return inv.map((v) => Math.round((v / sum) * 10000) / 10000);
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Read one bookmaker's 1X2 (h2h) decimal prices, or null if incomplete.
function readBookH2H(book, event) {
  const market = (book.markets ?? []).find((m) => m.key === "h2h");
  if (!market) return null;
  let oHome = null, oDraw = null, oAway = null;
  for (const o of market.outcomes ?? []) {
    const price = asNum(o.price);
    if (o.name === event.home_team) oHome = price;
    else if (o.name === event.away_team) oAway = price;
    else if (o.name === "Draw") oDraw = price;
  }
  return (oHome && oDraw && oAway) ? { oHome, oDraw, oAway } : null;
}

// Extract decimal 1X2 odds for an event. A single bookmaker can carry a stale or
// erroneous line (e.g. Marathon Bet pricing a WC draw at 1.25), so by default we
// take the MEDIAN across all bookmakers — robust to outliers. An explicit
// ODDS_BOOKMAKER override is honored when that book has a complete h2h line.
function extractH2H(event) {
  const books = event.bookmakers ?? [];
  if (PREFERRED_BOOKMAKER) {
    const b = books.find((x) => x.key === PREFERRED_BOOKMAKER);
    const t = b && readBookH2H(b, event);
    if (t) return { ...t, book: b.title ?? b.key };
  }
  const H = [], D = [], A = [];
  for (const b of books) {
    const t = readBookH2H(b, event);
    if (!t) continue;
    H.push(t.oHome); D.push(t.oDraw); A.push(t.oAway);
  }
  if (!H.length) return null;
  return {
    oHome: Math.round(median(H) * 1000) / 1000,
    oDraw: Math.round(median(D) * 1000) / 1000,
    oAway: Math.round(median(A) * 1000) / 1000,
    book: `Konsensus (${H.length} bukm.)`,
  };
}

// ── State (read) ─────────────────────────────────────────────────────────────
function mapMatch(row) {
  return {
    id: row.id,
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
    user_id: row.user_id,
    nick: row.nick_snapshot,
    match_id: row.match_id,
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

  // All players' bets are public on the Mundial page (football_bets RLS is
  // SELECT-to-all). The frontend marks the caller's own via user_id.
  const bets = await db`
    select *
    from public.football_bets
    order by created_at desc
    limit 500
  `;

  let profile = null;
  if (userId) {
    const [p] = await db`select id, nick, coins from public.profiles where id = ${userId}`;
    if (p) profile = { id: p.id, nick: p.nick, coins: asInt(p.coins) };
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
  const matchId = String(body.matchId ?? "");
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

// ── Cron: refresh events+odds, then settle finished matches ──────────────────
async function syncOdds() {
  const { data: events, remaining } = await oddsGet(
    `/sports/${SPORT_KEY}/odds?regions=${ODDS_REGIONS}&markets=h2h&oddsFormat=decimal`,
  );
  let upserted = 0;
  let priced = 0;
  for (const ev of events ?? []) {
    const id = String(ev.id ?? "");
    if (!id) continue;
    const kickoff = ev.commence_time;
    const started = new Date(kickoff).getTime() <= Date.now();
    const h2h = extractH2H(ev);
    const [pHome, pDraw, pAway] = h2h ? deVig(h2h.oHome, h2h.oDraw, h2h.oAway) : [null, null, null];

    await db`
      insert into public.football_matches
        (id, league_id, season, kickoff, status, home_team, away_team,
         odds_home, odds_draw, odds_away, prob_home, prob_draw, prob_away,
         bookmaker, odds_updated_at, updated_at)
      values (
        ${id}, 0, 2026, ${kickoff}, ${started ? "LIVE" : "NS"},
        ${ev.home_team ?? "?"}, ${ev.away_team ?? "?"},
        ${h2h ? h2h.oHome : null}, ${h2h ? h2h.oDraw : null}, ${h2h ? h2h.oAway : null},
        ${pHome}, ${pDraw}, ${pAway},
        ${h2h ? h2h.book : null}, ${h2h ? db`now()` : null}, now()
      )
      on conflict (id) do update set
        kickoff = excluded.kickoff,
        -- never downgrade a settled/finished match back to NS/LIVE
        status = case when public.football_matches.settled then public.football_matches.status else excluded.status end,
        home_team = excluded.home_team,
        away_team = excluded.away_team,
        odds_home = coalesce(excluded.odds_home, public.football_matches.odds_home),
        odds_draw = coalesce(excluded.odds_draw, public.football_matches.odds_draw),
        odds_away = coalesce(excluded.odds_away, public.football_matches.odds_away),
        prob_home = coalesce(excluded.prob_home, public.football_matches.prob_home),
        prob_draw = coalesce(excluded.prob_draw, public.football_matches.prob_draw),
        prob_away = coalesce(excluded.prob_away, public.football_matches.prob_away),
        bookmaker = coalesce(excluded.bookmaker, public.football_matches.bookmaker),
        odds_updated_at = coalesce(excluded.odds_updated_at, public.football_matches.odds_updated_at),
        updated_at = now()
    `;
    upserted += 1;
    if (h2h) priced += 1;
  }
  return { events: (events ?? []).length, upserted, priced, oddsRemaining: remaining, calls: 1 };
}

async function settleFinished() {
  // Only spend the (cost-2) scores call when something is actually pending.
  const [{ pending }] = await db`
    select count(*)::int as pending from public.football_matches
    where settled = false and kickoff <= now()
  `;
  if (!pending) return { settledMatches: 0, paidBets: 0, calls: 0, scoresRemaining: null };

  const { data: events, remaining } = await oddsGet(
    `/sports/${SPORT_KEY}/scores?daysFrom=${SCORES_DAYS_FROM}`,
  );
  let settledMatches = 0;
  let paidBets = 0;

  for (const ev of events ?? []) {
    if (!ev.completed) continue;
    const id = String(ev.id ?? "");
    const scores = ev.scores ?? [];
    const hs = asInt((scores.find((s) => s.name === ev.home_team) || {}).score, null);
    const as = asInt((scores.find((s) => s.name === ev.away_team) || {}).score, null);
    if (hs == null || as == null) continue;
    const result = hs > as ? "1" : hs < as ? "2" : "X";

    const settled = await db.begin(async (tx) => {
      const [match] = await tx`
        select id, settled from public.football_matches where id = ${id} for update
      `;
      if (!match || match.settled) return false;

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
      await tx`
        update public.football_matches
           set status = 'FT', result = ${result}, home_goals = ${hs}, away_goals = ${as},
               settled = true, updated_at = now()
         where id = ${id}
      `;
      return true;
    });
    if (settled) settledMatches += 1;
  }
  return { settledMatches, paidBets, calls: 1, scoresRemaining: remaining };
}

// Refund + void a single match's open bets in one transaction. Returns the
// number of bets refunded, or null if the match was already settled/missing.
async function voidMatchTx(tx, id) {
  const [m] = await tx`
    select id, settled from public.football_matches where id = ${id} for update
  `;
  if (!m || m.settled) return null;
  const open = await tx`
    select id, user_id, stake from public.football_bets
    where match_id = ${id} and status = 'open' for update
  `;
  for (const b of open) {
    await tx`update public.profiles set coins = coins + ${asInt(b.stake)} where id = ${b.user_id}`;
    await tx`update public.football_bets set status = 'void', settled_at = now() where id = ${b.id}`;
  }
  await tx`
    update public.football_matches
       set status = 'CANC', settled = true, updated_at = now()
     where id = ${id}
  `;
  return open.length;
}

// ── Void: refund open bets on matches with no available result ────────────────
async function voidStale() {
  // Settlement runs first and covers a 3-day /scores window, so anything still
  // open this long after kickoff has no result available (cancelled / abandoned
  // / walkover / API gap). A WC match incl. ET+penalties never exceeds ~3h, so
  // 12h is a generous safety margin that never races a slow-but-coming result.
  const stale = await db`
    select id from public.football_matches
    where settled = false and result is null
      and kickoff <= now() - interval '12 hours'
  `;
  let voidedMatches = 0;
  let refundedBets = 0;
  for (const { id } of stale) {
    const refunded = await db.begin((tx) => voidMatchTx(tx, id));
    if (refunded != null) {
      voidedMatches += 1;
      refundedBets += refunded;
    }
  }
  return { voidedMatches, refundedBets };
}

// Admin-only immediate void of a specific match (safety valve for known
// cancellations, ahead of the 12h auto-sweep).
async function voidMatch(userId, body) {
  if (!db) throw new Error("Database is not configured.");
  const matchId = String(body.matchId ?? "");
  if (!matchId) throw gameError("Brak meczu.");

  const [profile] = await db`select public.is_admin(${userId}) as is_admin`;
  if (!profile?.is_admin) throw gameError("Tylko admin.");

  const refunded = await db.begin((tx) => voidMatchTx(tx, matchId));
  if (refunded == null) throw gameError("Mecz już rozliczony lub nie istnieje.");

  return { ...(await loadState(userId)), voidedMatch: matchId, refundedBets: refunded };
}

async function runCron() {
  if (!db) throw new Error("Database is not configured.");
  const od = await syncOdds();
  const st = await settleFinished();
  const vd = await voidStale();
  const summary = { ...od, ...st, ...vd, apiCalls: od.calls + st.calls };
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

    if (action === "void") {
      const user = await requireUser(req);
      const result = await voidMatch(user.id, body);
      return json({ ok: true, ...result });
    }

    throw gameError("Nieznana akcja.");
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
