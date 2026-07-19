// @ts-nocheck
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

const BOARD_SIZE = 25;
const HOUSE_FACTOR = 0.95;
// Timed COMMUNAL „Amulet Fortuny" (casino-luck-item.sql): while ANY unexpired
// instance exists (any owner — the buyer pays for everyone), multipliers are
// computed with this factor instead (RTP 95% -> 98%). Never set ≥1.
const CASINO_LUCK_HOUSE_FACTOR = 0.98;
const MAX_MULT = 1000;
const STAKES = [1, 5, 10, 25, 50, 100, 250, 500]; // preset chips; any integer 1..MAX_BET is allowed
const MAX_BET = 10_000_000;               // ceiling for a custom stake (balance enforced separately)
const DEFAULT_BET = 10;
const DEFAULT_MINES = 3;

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
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authClient = createClient(supabaseUrl!, anonKey!, {
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

function validateMineCount(raw) {
  const count = Math.trunc(Number(raw ?? DEFAULT_MINES));
  if (count < 1 || count >= BOARD_SIZE) throw gameError("Nieprawidłowa liczba min.");
  return count;
}

function validateTile(raw) {
  const tile = Math.trunc(Number(raw));
  if (!Number.isInteger(tile) || tile < 0 || tile >= BOARD_SIZE) throw gameError("Nieprawidłowe pole.");
  return tile;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function floor2(value) {
  return Math.floor(Number(value) * 100) / 100;
}

function multiplierFor(mineCount, safeRevealed, houseFactor = HOUSE_FACTOR) {
  const k = Math.max(0, Math.trunc(Number(safeRevealed)));
  const mines = validateMineCount(mineCount);
  const safeTiles = BOARD_SIZE - mines;
  if (k <= 0) return 1;
  if (k > safeTiles) return MAX_MULT;

  let fair = 1;
  for (let i = 0; i < k; i += 1) {
    fair *= (BOARD_SIZE - i) / (BOARD_SIZE - mines - i);
  }
  return Math.min(MAX_MULT, floor2(fair * houseFactor));
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

function potentialPayout(bet, multiplier) {
  return Math.floor(Number(bet) * Number(multiplier));
}

function randomInt(maxExclusive) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % maxExclusive;
}

function generateMines(count) {
  const tiles = Array.from({ length: BOARD_SIZE }, (_, i) => i);
  for (let i = tiles.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles.slice(0, count).sort((a, b) => a - b);
}

function roundOut(row, houseFactor = HOUSE_FACTOR) {
  if (!row) return null;
  const revealedTiles = asArray(row.revealed_tiles).map(Number).filter(Number.isInteger);
  const safeRevealed = Number(row.safe_revealed || 0);
  const currentMultiplier = Number(row.current_multiplier || 1);
  const safeTiles = BOARD_SIZE - Number(row.mine_count);
  const nextMultiplier = row.status === "active" && safeRevealed < safeTiles
    ? multiplierFor(Number(row.mine_count), safeRevealed + 1, houseFactor)
    : null;
  return {
    id: row.id,
    bet: Number(row.bet),
    mineCount: Number(row.mine_count),
    status: row.status,
    revealedTiles,
    safeRevealed,
    currentMultiplier,
    nextMultiplier,
    potentialPayout: row.status === "active" && safeRevealed > 0 ? potentialPayout(row.bet, currentMultiplier) : Number(row.total_won || 0),
    totalWon: Number(row.total_won || 0),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function historyOut(rows) {
  return rows.map((row) => ({
    id: row.id,
    roundId: row.round_id,
    bet: Number(row.bet),
    mineCount: Number(row.mine_count),
    safeRevealed: Number(row.safe_revealed),
    finalMultiplier: Number(row.final_multiplier || 0),
    totalWon: Number(row.total_won || 0),
    result: row.result,
    createdAt: row.created_at,
  }));
}

function completedRoundOut(round, secret, result) {
  const mineTiles = asArray(secret?.mine_tiles).map(Number).filter(Number.isInteger);
  return {
    ...roundOut(round),
    result,
    mineTiles,
  };
}

async function stateResponse(tx, userId, extra = {}, houseFactor = null) {
  const factor = houseFactor ?? await casinoLuckFactor(tx);
  const [profile] = await tx`select coins, nick from public.profiles where id = ${userId}`;
  const [active] = await tx`
    select *
    from public.mines_rounds
    where user_id = ${userId} and status = 'active'
    order by created_at desc
    limit 1`;
  const history = await tx`
    select id, round_id, bet, mine_count, safe_revealed, final_multiplier, total_won, result, created_at
    from public.mines_spins
    where user_id = ${userId}
    order by created_at desc
    limit 12`;
  return {
    coins: profile?.coins ?? 0,
    nick: profile?.nick ?? "",
    activeRound: roundOut(active, factor),
    history: historyOut(history),
    stakes: STAKES,
    boardSize: BOARD_SIZE,
    maxMultiplier: MAX_MULT,
    houseFactor: factor,
    casinoLuck: factor !== HOUSE_FACTOR,
    ...extra,
  };
}

async function insertSpin(tx, round, secret, result) {
  const mineTiles = asArray(secret.mine_tiles);
  const revealedTiles = asArray(round.revealed_tiles);
  await tx`
    insert into public.mines_spins
      (user_id, round_id, bet, mine_count, safe_revealed, final_multiplier,
       total_won, result, revealed_tiles, mine_tiles)
    values
      (${round.user_id}, ${round.id}, ${round.bet}, ${round.mine_count}, ${round.safe_revealed},
       ${round.current_multiplier}, ${round.total_won}, ${result},
       ${JSON.stringify(revealedTiles)}, ${JSON.stringify(mineTiles)})`;
}

async function startRound(userId, rawBet, rawMineCount) {
  const bet = validateBet(rawBet);
  const mineCount = validateMineCount(rawMineCount);

  return await db.begin(async (tx) => {
    const [profile] = await tx`select coins from public.profiles where id = ${userId} for update`;
    if (!profile) throw gameError("Profil nie istnieje.");

    const [existing] = await tx`
      select id from public.mines_rounds
      where user_id = ${userId} and status = 'active'
      order by created_at desc
      limit 1`;
    if (existing) {
      return await stateResponse(tx, userId, { notice: "Masz aktywną rundę — dokończ ją albo wypłać." });
    }

    if (profile.coins < bet) throw gameError("Za mało coinów!");

    const mines = generateMines(mineCount);
    const [round] = await tx`
      insert into public.mines_rounds (user_id, bet, mine_count)
      values (${userId}, ${bet}, ${mineCount})
      returning *`;
    await tx`insert into public.mines_round_secrets (round_id, mine_tiles)
             values (${round.id}, ${JSON.stringify(mines)})`;
    await tx`update public.profiles set coins = coins - ${bet} where id = ${userId}`;

    return await stateResponse(tx, userId);
  });
}

async function revealTile(userId, roundId, rawTile) {
  const tile = validateTile(rawTile);
  if (!roundId) throw gameError("Brak aktywnej rundy.");

  return await db.begin(async (tx) => {
    const [round] = await tx`
      select *
      from public.mines_rounds
      where id = ${roundId} and user_id = ${userId}
      for update`;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.status !== "active") throw gameError("Ta runda jest już zakończona.");

    const [secret] = await tx`select mine_tiles from public.mines_round_secrets where round_id = ${round.id}`;
    if (!secret) throw gameError("Brak sekretu rundy.");

    const revealed = asArray(round.revealed_tiles).map(Number);
    if (revealed.includes(tile)) throw gameError("To pole jest już odkryte.");

    const mineTiles = asArray(secret.mine_tiles).map(Number);
    const nextRevealed = [...revealed, tile].sort((a, b) => a - b);
    const factor = await casinoLuckFactor(tx);

    if (mineTiles.includes(tile)) {
      const [updated] = await tx`
        update public.mines_rounds
        set status = 'busted',
            revealed_tiles = ${JSON.stringify(nextRevealed)},
            current_multiplier = 0,
            total_won = 0,
            completed_at = now()
        where id = ${round.id}
        returning *`;
      await insertSpin(tx, updated, secret, "bust");
      return await stateResponse(tx, userId, {
        completedRound: completedRoundOut(updated, secret, "bust"),
      }, factor);
    }

    const safeRevealed = Number(round.safe_revealed) + 1;
    const multiplier = multiplierFor(round.mine_count, safeRevealed, factor);
    const safeTiles = BOARD_SIZE - Number(round.mine_count);
    const autoCash = safeRevealed >= safeTiles || multiplier >= MAX_MULT;
    const won = autoCash ? potentialPayout(round.bet, multiplier) : 0;
    if (autoCash) {
      await tx`update public.profiles set coins = coins + ${won} where id = ${userId}`;
    }
    if (autoCash) {
      const [updated] = await tx`
        update public.mines_rounds
        set revealed_tiles = ${JSON.stringify(nextRevealed)},
            safe_revealed = ${safeRevealed},
            current_multiplier = ${multiplier},
            status = 'cashed',
            total_won = ${won},
            completed_at = now()
        where id = ${round.id}
        returning *`;
      await insertSpin(tx, updated, secret, "auto_cashout");
      return await stateResponse(tx, userId, {
        completedRound: completedRoundOut(updated, secret, "auto_cashout"),
      }, factor);
    }

    const [updated] = await tx`
      update public.mines_rounds
      set revealed_tiles = ${JSON.stringify(nextRevealed)},
          safe_revealed = ${safeRevealed},
          current_multiplier = ${multiplier}
      where id = ${round.id}
      returning *`;

    return await stateResponse(tx, userId, {}, factor);
  });
}

async function cashOut(userId, roundId) {
  if (!roundId) throw gameError("Brak aktywnej rundy.");
  return await db.begin(async (tx) => {
    const [round] = await tx`
      select *
      from public.mines_rounds
      where id = ${roundId} and user_id = ${userId}
      for update`;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.status !== "active") throw gameError("Ta runda jest już zakończona.");
    if (Number(round.safe_revealed) < 1) throw gameError("Odkryj przynajmniej jedno bezpieczne pole.");

    const [secret] = await tx`select mine_tiles from public.mines_round_secrets where round_id = ${round.id}`;
    if (!secret) throw gameError("Brak sekretu rundy.");

    const factor = await casinoLuckFactor(tx);
    const multiplier = multiplierFor(round.mine_count, round.safe_revealed, factor);
    const won = potentialPayout(round.bet, multiplier);
    await tx`update public.profiles set coins = coins + ${won} where id = ${userId}`;
    const [updated] = await tx`
      update public.mines_rounds
      set status = 'cashed',
          current_multiplier = ${multiplier},
          total_won = ${won},
          completed_at = now()
      where id = ${round.id}
      returning *`;
    await insertSpin(tx, updated, secret, "cashout");
    return await stateResponse(tx, userId, {
      completedRound: completedRoundOut(updated, secret, "cashout"),
      cashedOut: { multiplier, won },
    }, factor);
  });
}

async function getState(userId) {
  return await db.begin((tx) => stateResponse(tx, userId));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "state");

    let result;
    if (action === "state" || action === "history") result = await getState(user.id);
    else if (action === "start") result = await startRound(user.id, body.bet, body.mineCount);
    else if (action === "reveal") result = await revealTile(user.id, body.roundId, body.tile);
    else if (action === "cash_out") result = await cashOut(user.id, body.roundId);
    else throw gameError("Nieznana akcja.");

    return json(req, { ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json(req, { ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
