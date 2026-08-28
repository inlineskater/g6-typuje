// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
//  „Drabina Kariery G6" — Hi-Lo card ladder. The server owns every card.
// ════════════════════════════════════════════════════════════════════════════
//  The client never generates a card, never computes a payout, and never learns
//  anything before it is public: each card is drawn from crypto RNG at the
//  moment the call is made, which is why (unlike mines/crash) there is no
//  secrets table — see the header of supabase/hilo.sql.
//
//  ⚠️ The house edge is applied ONCE at cash-out, never per step. Each step
//  multiplies the pot by exactly 1/p, so the ladder is a martingale and RTP is
//  a flat 95% at every streak length. Applying HOUSE_FACTOR per step would
//  compound to 0.54 over 12 steps and punish exactly the runs the game exists
//  for. The probabilities shown on the buttons are the real ones.
// ════════════════════════════════════════════════════════════════════════════
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const ALLOWED_ORIGINS = new Set([
  "https://inlineskater.github.io",
]);

function corsHeaders(req) {
  const origin = req?.headers?.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://inlineskater.github.io",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const db = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 4, idle_timeout: 20 });

const RANKS = 13;                    // 1..13 == 2,3,…,10,J,Q,K,A
const HOUSE_FACTOR = 0.95;
// Timed COMMUNAL „Amulet Fortuny" (casino-luck-item.sql): while ANY unexpired
// instance exists (any owner — the buyer pays for everyone), the edge is this
// instead (RTP 95% -> 98%). Never set >= 1.
const CASINO_LUCK_HOUSE_FACTOR = 0.98;
// Auto-cash-out ceilings.
//
// The ceiling that matters is in COINS, not in multiplier: a multiplier cap
// alone is either meaningless for a 10-coin stake or ruinous for a 10,000-coin
// one. MAX_PAYOUT is ~a third of the money supply measured on 2026-08-28
// (406,848) — a genuine all-time event, and bounded. MAX_MULT only exists to
// stop a trivial stake climbing forever.
//
// ⚠️ A cap TRUNCATES the fair value of the ladder, so it is the one thing that
// can make the published odds a lie. It has to stay far enough out that normal
// play never meets it, and the UI has to show the effective ceiling for the
// chosen stake — `capMultiplier` in the state payload is exactly that.
const MAX_PAYOUT = 150_000;
const MAX_MULT = 100_000;
const MAX_DRAWS = 250;
const STAKES = [10, 25, 50, 100, 250, 500, 1000];
const MAX_BET = 10_000_000;
const DEFAULT_BET = 50;

function gameError(message) {
  return Object.assign(new Error(message), { isGame: true });
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

async function requireUser(req) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) throw gameError("Musisz być zalogowany.");
  const authClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) throw gameError("Sesja wygasła.");
  return data.user;
}

function validateBet(raw) {
  const bet = Math.trunc(Number(raw ?? DEFAULT_BET));
  if (!Number.isInteger(bet) || bet < 1 || bet > MAX_BET) throw gameError("Nieprawidłowa stawka.");
  return bet;
}

function randomInt(maxExclusive) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % maxExclusive;
}

function drawCard() {
  return { rank: randomInt(RANKS) + 1, suit: randomInt(4) };
}

// Ties win BOTH calls — the standard, and the forgiving, hilo formulation.
//   P(higher or same) = (14 - r)/13      P(lower or same) = r/13
function probs(rank) {
  return { hi: (RANKS + 1 - rank) / RANKS, lo: rank / RANKS };
}

function floor4(n) { return Math.floor(n * 10000) / 10000; }

// What the caller sees on the two buttons: the true probability and the exact
// multiplier the pot would become. No house factor here — it is taken once at
// cash-out, so these are honest odds.
function optionsFor(rank, multiplier, ceiling = MAX_MULT) {
  const p = probs(rank);
  const step = q => floor4(1 / q);
  return {
    hi: { p: floor4(p.hi), step: step(p.hi), next: floor4(Math.min(ceiling, multiplier / p.hi)), sure: p.hi >= 1 },
    lo: { p: floor4(p.lo), step: step(p.lo), next: floor4(Math.min(ceiling, multiplier / p.lo)), sure: p.lo >= 1 },
  };
}

function wins(dir, prevRank, nextRank) {
  return dir === "hi" ? nextRank >= prevRank : nextRank <= prevRank;
}

function payoutFor(bet, multiplier, houseFactor) {
  return Math.min(MAX_PAYOUT, Math.floor(Number(bet) * Number(multiplier) * Number(houseFactor)));
}

// The multiplier at which this stake reaches MAX_PAYOUT. Shown to the player so
// the ceiling is never a surprise mid-ladder.
function capMultiplier(bet, houseFactor) {
  return Math.min(MAX_MULT, MAX_PAYOUT / (Number(bet) * Number(houseFactor)));
}

async function casinoLuckFactor(tx) {
  try {
    const rows = await tx`
      select 1
      from public.hero_item_instances i
      join public.hero_item_defs d on d.id = i.item_def_id
      where d.is_active = true
        and d.effect_game = 'casino'
        and d.effect_type = 'casino_luck'
        and i.expires_at is not null
        and i.expires_at > now()
      limit 1
    `;
    return rows.length > 0 ? CASINO_LUCK_HOUSE_FACTOR : HOUSE_FACTOR;
  } catch (err) {
    console.warn("Casino luck lookup unavailable:", err?.message ?? err);
    return HOUSE_FACTOR;
  }
}

function roundOut(row) {
  if (!row) return null;
  const rank = Number(row.card_rank);
  const multiplier = Number(row.multiplier);
  const houseFactor = Number(row.house_factor);
  return {
    id: row.id,
    bet: Number(row.bet),
    card: { rank, suit: Number(row.card_suit) },
    streak: Number(row.streak),
    draws: Number(row.draws),
    multiplier: floor4(multiplier),
    status: row.status,
    history: Array.isArray(row.history) ? row.history : [],
    options: optionsFor(rank, multiplier, capMultiplier(row.bet, houseFactor)),
    cashOut: payoutFor(row.bet, multiplier, houseFactor),
    casinoLuck: houseFactor !== HOUSE_FACTOR,
    maxMultiplier: floor4(capMultiplier(row.bet, houseFactor)),
    maxPayout: MAX_PAYOUT,
    drawsLeft: Math.max(0, MAX_DRAWS - Number(row.draws)),
  };
}

async function activeRound(tx, userId, forUpdate = false) {
  const rows = forUpdate
    ? await tx`select * from public.hilo_rounds where user_id = ${userId} and status = 'active' for update`
    : await tx`select * from public.hilo_rounds where user_id = ${userId} and status = 'active'`;
  return rows[0] ?? null;
}

async function coinsOf(tx, userId, forUpdate = false) {
  const rows = forUpdate
    ? await tx`select coins from public.profiles where id = ${userId} for update`
    : await tx`select coins from public.profiles where id = ${userId}`;
  if (!rows[0]) throw gameError("Nie znaleziono profilu.");
  return Number(rows[0].coins);
}

// Close a round: write the spin row (history + Hazardista + economy stats read
// this, never hilo_rounds) and pay out if there is anything to pay.
async function finish(tx, round, result, payout) {
  await tx`
    update public.hilo_rounds
       set status = ${result}, ended_at = now()
     where id = ${round.id} and status = 'active'
  `;
  await tx`
    insert into public.hilo_spins
      (user_id, round_id, bet, streak, multiplier, total_won, result, item_effect)
    values (${round.user_id}, ${round.id}, ${round.bet}, ${round.streak},
            ${round.multiplier}, ${payout}, ${result},
            ${Number(round.house_factor) !== HOUSE_FACTOR ? "casino_luck" : null})
  `;
  let coins;
  if (payout > 0) {
    const rows = await tx`
      update public.profiles set coins = coins + ${payout}
       where id = ${round.user_id} returning coins
    `;
    coins = Number(rows[0].coins);
  } else {
    coins = await coinsOf(tx, round.user_id);
  }
  return coins;
}

async function handleState(user) {
  return await db.begin(async tx => {
    const row = await activeRound(tx, user.id);
    const factor = await casinoLuckFactor(tx);
    return {
      ok: true,
      round: roundOut(row),
      coins: await coinsOf(tx, user.id),
      stakes: STAKES,
      defaultBet: DEFAULT_BET,
      maxPayout: MAX_PAYOUT,
      maxMultiplier: MAX_MULT,
      casinoLuck: factor !== HOUSE_FACTOR,
      houseFactor: factor,
    };
  });
}

async function handleStart(user, payload) {
  const bet = validateBet(payload?.bet);
  return await db.begin(async tx => {
    if (await activeRound(tx, user.id, true)) throw gameError("Masz już otwartą rundę.");
    // Lock the balance BEFORE taking the stake, same order as every other table.
    const coins = await coinsOf(tx, user.id, true);
    if (coins < bet) throw gameError("Za mało monet.");
    const factor = await casinoLuckFactor(tx);
    const card = drawCard();
    await tx`update public.profiles set coins = coins - ${bet} where id = ${user.id}`;
    const rows = await tx`
      insert into public.hilo_rounds
        (user_id, bet, card_rank, card_suit, house_factor, draws)
      values (${user.id}, ${bet}, ${card.rank}, ${card.suit}, ${factor}, 1)
      returning *
    `;
    return { ok: true, round: roundOut(rows[0]), coins: coins - bet, casinoLuck: factor !== HOUSE_FACTOR };
  });
}

async function handlePick(user, payload) {
  const dir = payload?.direction === "lo" ? "lo" : payload?.direction === "hi" ? "hi" : null;
  if (!dir) throw gameError("Wybierz WYŻEJ albo NIŻEJ.");
  return await db.begin(async tx => {
    const round = await activeRound(tx, user.id, true);
    if (!round) throw gameError("Nie masz otwartej rundy.");

    const prevRank = Number(round.card_rank);
    const p = probs(prevRank)[dir];
    const next = drawCard();
    const won = wins(dir, prevRank, next.rank);

    const history = (Array.isArray(round.history) ? round.history : []).concat([{
      from: { rank: prevRank, suit: Number(round.card_suit) },
      to: { rank: next.rank, suit: next.suit },
      dir, p: floor4(p), won,
    }]);
    const draws = Number(round.draws) + 1;

    if (!won) {
      // Bust: the stake was taken at start, so nothing more moves.
      const coins = await finish(tx, round, "busted", 0);
      return {
        ok: true, result: "busted", card: next, direction: dir, probability: floor4(p),
        streak: Number(round.streak), multiplier: floor4(Number(round.multiplier)),
        payout: 0, coins, history,
      };
    }

    const ceiling = capMultiplier(round.bet, Number(round.house_factor));
    const multiplier = Math.min(ceiling, Number(round.multiplier) / p);
    const streak = Number(round.streak) + 1;
    const capped = multiplier >= ceiling || draws >= MAX_DRAWS;

    if (capped) {
      // Ceiling reached — pay out rather than leaving a round that cannot grow.
      const closing = { ...round, streak, multiplier, history };
      const payout = payoutFor(round.bet, multiplier, Number(round.house_factor));
      const coins = await finish(tx, closing, "cashed", payout);
      return {
        ok: true, result: "capped", card: next, direction: dir, probability: floor4(p),
        streak, multiplier: floor4(multiplier), payout, coins, history,
      };
    }

    const rows = await tx`
      update public.hilo_rounds
         set card_rank = ${next.rank}, card_suit = ${next.suit},
             streak = ${streak}, draws = ${draws},
             multiplier = ${multiplier}, history = ${JSON.stringify(history)}::jsonb
       where id = ${round.id} and status = 'active'
      returning *
    `;
    return {
      ok: true, result: "won", card: next, direction: dir, probability: floor4(p),
      round: roundOut(rows[0]), coins: await coinsOf(tx, user.id),
    };
  });
}

// Redraw without betting. EV-neutral by construction (the pot does not move and
// the new card is uniform), so it is free and unlimited — it exists so a player
// dealt a 2 or an ace is not forced into a ×1.00 call. It still consumes a draw,
// which is what MAX_DRAWS is really bounding.
async function handleSkip(user) {
  return await db.begin(async tx => {
    const round = await activeRound(tx, user.id, true);
    if (!round) throw gameError("Nie masz otwartej rundy.");
    const draws = Number(round.draws) + 1;
    if (draws >= MAX_DRAWS) {
      const payout = payoutFor(round.bet, Number(round.multiplier), Number(round.house_factor));
      const coins = await finish(tx, round, "cashed", payout);
      return { ok: true, result: "capped", payout, coins,
               streak: Number(round.streak), multiplier: floor4(Number(round.multiplier)) };
    }
    const card = drawCard();
    const rows = await tx`
      update public.hilo_rounds
         set card_rank = ${card.rank}, card_suit = ${card.suit}, draws = ${draws}
       where id = ${round.id} and status = 'active'
      returning *
    `;
    return { ok: true, result: "skipped", card, round: roundOut(rows[0]) };
  });
}

async function handleCashOut(user) {
  return await db.begin(async tx => {
    const round = await activeRound(tx, user.id, true);
    if (!round) throw gameError("Nie masz otwartej rundy.");
    if (Number(round.streak) < 1) {
      // Cashing out before the first call would just refund 95% of the stake —
      // a guaranteed loss nobody means to take.
      throw gameError("Zagraj przynajmniej jedną kartę.");
    }
    const payout = payoutFor(round.bet, Number(round.multiplier), Number(round.house_factor));
    const coins = await finish(tx, round, "cashed", payout);
    return { ok: true, result: "cashed", payout, coins,
             streak: Number(round.streak), multiplier: floor4(Number(round.multiplier)) };
  });
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  try {
    const user = await requireUser(req);
    const payload = await req.json().catch(() => ({}));
    switch (payload?.action) {
      case "state":    return json(req, await handleState(user));
      case "start":    return json(req, await handleStart(user, payload));
      case "pick":     return json(req, await handlePick(user, payload));
      case "skip":     return json(req, await handleSkip(user));
      case "cash_out": return json(req, await handleCashOut(user));
      default:         return json(req, { ok: false, error: "Nieznana akcja." }, 400);
    }
  } catch (err) {
    const message = err?.isGame ? err.message : "Coś poszło nie tak.";
    if (!err?.isGame) console.error("hilo-action", err);
    return json(req, { ok: false, error: message }, err?.isGame ? 400 : 500);
  }
});
