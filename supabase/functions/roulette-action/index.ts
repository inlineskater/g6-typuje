// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://inlineskater.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const db = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 4, idle_timeout: 20 });

const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const VALID_TYPES = new Set(["straight","red","black","odd","even","high","low","dozen","column"]);

// Auto-evict a seat once its last_seen heartbeat is older than this. The
// frontend pings `state` every ROULETTE_HEARTBEAT_MS (≈25s) in index.html while
// seated + tab visible; 90s tolerates ~3 missed pings (background throttling, a
// brief tab switch, transient network) before freeing an abandoned seat. Keep
// the client heartbeat comfortably below this (rule of thumb: heartbeat ≤ ⅓).
const SEAT_STALE_MS = 90_000;

function gameError(message) {
  const err = new Error(message);
  err.isGame = true;
  return err;
}

function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function numberColor(n) {
  if (n === 0) return "green";
  return REDS.has(n) ? "red" : "black";
}

function betWins(bet, number) {
  const color = numberColor(number);
  switch (bet.type) {
    case "straight": return bet.value === number;
    case "red": return color === "red";
    case "black": return color === "black";
    case "odd": return number > 0 && number % 2 === 1;
    case "even": return number > 0 && number % 2 === 0;
    case "low": return number >= 1 && number <= 18;
    case "high": return number >= 19 && number <= 36;
    case "dozen":
      if (number === 0) return false;
      return Math.ceil(number / 12) === bet.value;
    case "column":
      if (number === 0) return false;
      return ((number - 1) % 3) + 1 === bet.value;
    default: return false;
  }
}

function betMultiplier(type) {
  if (type === "straight") return 36;
  if (type === "dozen" || type === "column") return 3;
  return 2;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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

function normalizeBet(input) {
  const b = input ?? {};
  if (!VALID_TYPES.has(b.type)) throw gameError(`Nieprawidłowy typ: ${b.type}`);
  const amount = asInt(b.amount);
  if (!amount || amount < 1) throw gameError("Kwota musi być > 0.");
  const out = { type: String(b.type), amount };
  if (out.type === "straight") {
    const v = asInt(b.value, -1);
    if (v < 0 || v > 36) throw gameError("Numer musi być 0-36.");
    out.value = v;
  } else if (out.type === "dozen") {
    const v = asInt(b.value, -1);
    if (v < 1 || v > 3) throw gameError("Tuzin musi być 1, 2 lub 3.");
    out.value = v;
  } else if (out.type === "column") {
    const v = asInt(b.value, -1);
    if (v < 1 || v > 3) throw gameError("Kolumna musi być 1, 2 lub 3.");
    out.value = v;
  }
  return out;
}

function normalizeBets(bets) {
  if (!Array.isArray(bets)) throw gameError("Nieprawidłowe zakłady.");
  if (bets.length > 50) throw gameError("Za dużo zakładów.");
  return bets.map(normalizeBet);
}

function normalizeSeatNo(value) {
  if (value === undefined || value === null || value === "") return null;
  const seatNo = asInt(value, -1);
  if (seatNo < 0 || seatNo > 5) throw gameError("Nieprawidłowe miejsce.");
  return seatNo;
}

function sumBets(bets) {
  return bets.reduce((sum, bet) => sum + asInt(bet.amount), 0);
}

function randomNumber() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % 37;
}

function chancePercent(percent) {
  const n = Number(percent);
  if (!Number.isFinite(n) || n <= 0) return false;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % 10000) < Math.min(10000, Math.round(n * 100));
}

function randomFrom(values) {
  if (!values.length) return null;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return values[buf[0] % values.length];
}

async function getStrongestHeroEffect(tx, userId, game) {
  try {
    const rows = await tx`
      select d.slug, d.name, d.emoji, d.effect_game, d.effect_type, d.effect_value
      from public.hero_item_instances i
      join public.hero_item_defs d on d.id = i.item_def_id
      where i.owner_id = ${userId}
        and d.is_active = true
        and d.effect_game = ${game}
        and (i.expires_at is null or i.expires_at > now())
      order by d.effect_value desc, d.price desc, d.slug
      limit 1
    `;
    return rows[0] ?? null;
  } catch (err) {
    console.warn("Hero item effects unavailable:", err?.message ?? err);
    return null;
  }
}

// Timed COMMUNAL „Amulet Fortuny" (casino-luck-item.sql): while ANY unexpired
// instance exists (any owner — the buyer pays for everyone), every winning
// payout gets +CASINO_LUCK_PAYOUT_PCT% (RTP 97.3% -> 98.3%). It stacks with a
// personal roulette item (rescue or payout_bonus); the worst stack — straight
// bets + lucky_trousers + amulet — sits at 99.25% RTP with the constants
// below. 2% here would push that stack to 100.2% (+EV); never raise any of
// CASINO_LUCK_PAYOUT_PCT / MAX_RESCUE_CHANCE_PCT / the stake-refund rescue cap
// without redoing the joint math.
const CASINO_LUCK_PAYOUT_PCT = 1;

// win_chance_bonus (lucky_trousers) hard server-side ceiling. The rescue used
// to pay full multipliers, which made single straight-number betting +32% EV
// (1% of losses turned into a 36x win) — a grindable coin printer. The rescue
// now refunds AT MOST the round's total stake (loss -> money back), and the
// trigger chance is clamped here regardless of the item's effect_value.
const MAX_RESCUE_CHANCE_PCT = 1;

async function hasCasinoLuck(tx) {
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
    return rows.length > 0;
  } catch (err) {
    console.warn("Casino luck lookup unavailable:", err?.message ?? err);
    return false;
  }
}

async function ensureMainTable(tx) {
  await tx`
    insert into public.roulette_tables (slug)
    values ('main')
    on conflict (slug) do nothing
  `;
  const rows = await tx`select * from public.roulette_tables where slug = 'main' for update`;
  if (!rows[0]) throw new Error("Roulette table was not created.");
  return rows[0];
}

async function createNextRound(tx, table) {
  const roundId = crypto.randomUUID();
  const roundNo = asInt(table.round_no) + 1;
  const rows = await tx`
    insert into public.roulette_rounds (id, table_id, round_no)
    values (${roundId}, ${table.id}, ${roundNo})
    returning *
  `;
  await tx`
    update public.roulette_tables
       set current_round_id = ${roundId},
           round_no = ${roundNo},
           updated_at = now()
     where id = ${table.id}
  `;
  table.current_round_id = roundId;
  table.round_no = roundNo;
  return rows[0];
}

async function ensureBettingRound(tx, table) {
  let round = null;
  if (table.current_round_id) {
    const rows = await tx`
      select * from public.roulette_rounds
      where id = ${table.current_round_id}
      for update
    `;
    round = rows[0] ?? null;
  }
  if (!round || round.status !== "betting") {
    round = await createNextRound(tx, table);
  }
  return round;
}

async function loadLockedGame(tx) {
  const table = await ensureMainTable(tx);
  const round = await ensureBettingRound(tx, table);
  const seats = await tx`
    select *
    from public.roulette_seats
    where table_id = ${table.id}
    order by seat_no
    for update
  `;
  return { table, round, seats };
}

function outcomeForBets(bets, tableNumber, effect) {
  let totalWon = 0;
  for (const b of bets) {
    if (betWins(b, tableNumber)) totalWon += b.amount * betMultiplier(b.type);
  }

  let itemEffect = null;
  const rescueChance = Math.min(Number(effect?.effect_value ?? 0), MAX_RESCUE_CHANCE_PCT);
  if (effect?.effect_type === "win_chance_bonus" && totalWon === 0 && chancePercent(rescueChance)) {
    const winners = [];
    for (let n = 0; n <= 36; n++) {
      if (bets.some((b) => betWins(b, n))) winners.push(n);
    }
    const rescuedNumber = randomFrom(winners);
    if (rescuedNumber !== null) {
      // Stake refund, not a multiplier win: pay the rescued number's winnings
      // capped at the round's total stake. Uncapped, a straight-only bettor
      // gets a 36x rescue and the item turns +EV (see MAX_RESCUE_CHANCE_PCT).
      const totalStake = bets.reduce((s, b) => s + b.amount, 0);
      let rescueWin = 0;
      for (const b of bets) {
        if (betWins(b, rescuedNumber)) rescueWin += b.amount * betMultiplier(b.type);
      }
      totalWon = Math.min(rescueWin, totalStake);
      itemEffect = {
        slug: effect.slug,
        name: effect.name,
        type: effect.effect_type,
        value: rescueChance,
        rescuedNumber,
        rescuedColor: numberColor(rescuedNumber),
        refund: totalWon,
      };
    }
  } else if (effect?.effect_type === "payout_bonus" && totalWon > 0) {
    // floor, not ceil: ceil paid a full bonus coin on tiny wins (a 1-coin
    // even-money win got ceil(2*1%) = +1 coin = +50% EV — min-stake grind).
    const bonus = Math.floor(totalWon * Number(effect.effect_value) / 100);
    if (bonus > 0) {
      totalWon += bonus;
      itemEffect = {
        slug: effect.slug,
        name: effect.name,
        type: effect.effect_type,
        value: Number(effect.effect_value),
        bonus,
      };
    }
  }

  return { totalWon, itemEffect };
}

function publicBet(row, nickByUser, userId) {
  return {
    id: row.id,
    userId: row.user_id,
    seatNo: asInt(row.seat_no),
    nick: nickByUser.get(row.user_id) ?? "Gracz",
    type: row.type,
    value: row.value,
    amount: asInt(row.amount),
    isMe: row.user_id === userId,
  };
}

async function stateResponse(tx, userId, extra = {}) {
  const { table, round, seats } = await loadLockedGame(tx);
  const profileRows = await tx`
    select id, nick, coins, is_admin
    from public.profiles
    where id = ${userId}
  `;
  const profile = profileRows[0];
  if (!profile) throw gameError("Nie znaleziono profilu.");

  const bets = await tx`
    select *
    from public.roulette_bets
    where round_id = ${round.id}
    order by created_at, id
  `;
  const betTotals = new Map();
  for (const bet of bets) betTotals.set(bet.user_id, (betTotals.get(bet.user_id) ?? 0) + asInt(bet.amount));

  const seatUserIds = seats.map((s) => s.user_id);
  const overallRows = seatUserIds.length
    ? await tx`
        select user_id, coalesce(sum(total_won - total_bet), 0)::integer as overall_net
        from public.roulette_spins
        where user_id = any(${seatUserIds}::uuid[])
        group by user_id
      `
    : [];
  const overallByUser = new Map(overallRows.map((r) => [r.user_id, asInt(r.overall_net)]));
  const nickByUser = new Map(seats.map((s) => [s.user_id, s.nick_snapshot]));

  const mySeat = seats.find((s) => s.user_id === userId) ?? null;
  const currentBet = betTotals.get(userId) ?? 0;
  const activeBettors = seats.filter((s) => (betTotals.get(s.user_id) ?? 0) > 0);
  const readyBettors = activeBettors.filter((s) => s.ready);
  const allBettorsReady = activeBettors.length > 0 && activeBettors.every((s) => s.ready);

  const lastRoundRows = await tx`
    select *
    from public.roulette_rounds
    where table_id = ${table.id}
      and status = 'resolved'
    order by resolved_at desc nulls last, created_at desc
    limit 1
  `;
  const lastRound = lastRoundRows[0] ?? null;
  let lastResult = null;
  if (lastRound) {
    const spinRows = await tx`
      select rs.*, p.nick
      from public.roulette_spins rs
      join public.profiles p on p.id = rs.user_id
      where rs.round_id = ${lastRound.id}
      order by rs.seat_no nulls last, rs.created_at
    `;
    lastResult = {
      id: lastRound.id,
      roundNo: asInt(lastRound.round_no),
      number: asInt(lastRound.result_number),
      color: lastRound.result_color,
      totalBet: asInt(lastRound.total_bet),
      totalWon: asInt(lastRound.total_won),
      resolvedAt: lastRound.resolved_at,
      players: spinRows.map((row) => ({
        userId: row.user_id,
        seatNo: row.seat_no,
        nick: row.nick,
        bets: typeof row.bets === "string" ? JSON.parse(row.bets) : row.bets,
        totalBet: asInt(row.total_bet),
        totalWon: asInt(row.total_won),
        net: asInt(row.total_won) - asInt(row.total_bet),
        itemEffect: typeof row.item_effect === "string" ? JSON.parse(row.item_effect) : row.item_effect,
        isMe: row.user_id === userId,
      })),
    };
  }

  const historyRows = await tx`
    select id, round_no, result_number, result_color, total_bet, total_won, resolved_at
    from public.roulette_rounds
    where table_id = ${table.id}
      and status = 'resolved'
    order by resolved_at desc nulls last, created_at desc
    limit 20
  `;

  return {
    ...extra,
    table: {
      id: table.id,
      roundNo: asInt(table.round_no),
      maxSeats: asInt(table.max_seats, 6),
      currentRoundId: round.id,
      currentRoundNo: asInt(round.round_no),
      activeBettors: activeBettors.length,
      readyBettors: readyBettors.length,
      allBettorsReady,
    },
    profile: {
      coins: asInt(profile.coins),
      nick: profile.nick,
    },
    seats: seats.map((seat) => ({
      id: seat.id,
      seatNo: asInt(seat.seat_no),
      userId: seat.user_id,
      nick: seat.nick_snapshot,
      ready: !!seat.ready,
      currentBet: betTotals.get(seat.user_id) ?? 0,
      sessionBet: asInt(seat.session_total_bet),
      sessionWon: asInt(seat.session_total_won),
      sessionNet: asInt(seat.session_total_won) - asInt(seat.session_total_bet),
      overallNet: overallByUser.get(seat.user_id) ?? 0,
      isMe: seat.user_id === userId,
    })),
    bets: bets.map((row) => publicBet(row, nickByUser, userId)),
    me: {
      seatNo: mySeat?.seat_no ?? null,
      seated: !!mySeat,
      ready: !!mySeat?.ready,
      currentBet,
      canSit: !mySeat && seats.length < asInt(table.max_seats, 6),
      canLeave: !!mySeat,
      canBet: !!mySeat && !mySeat.ready,
      canReady: !!mySeat && seats.length > 1 && currentBet > 0 && !mySeat.ready,
      canCancelReady: !!mySeat && !!mySeat.ready,
      canSpin: !!mySeat && seats.length <= 1 && currentBet > 0,
    },
    lastResult,
    history: historyRows.map((row) => ({
      id: row.id,
      roundNo: asInt(row.round_no),
      result_number: asInt(row.result_number),
      result_color: row.result_color,
      total_bet: asInt(row.total_bet),
      total_won: asInt(row.total_won),
      resolved_at: row.resolved_at,
    })),
  };
}

async function resolveRound(tx, table, round, triggerUserId, force = false) {
  const seats = await tx`
    select *
    from public.roulette_seats
    where table_id = ${table.id}
    order by seat_no
    for update
  `;
  const bets = await tx`
    select *
    from public.roulette_bets
    where round_id = ${round.id}
    order by created_at, id
    for update
  `;
  if (!bets.length) return { resolved: false };

  const betsByUser = new Map();
  for (const row of bets) {
    const list = betsByUser.get(row.user_id) ?? [];
    list.push({ type: row.type, value: row.value, amount: asInt(row.amount) });
    betsByUser.set(row.user_id, list);
  }
  const bettors = seats.filter((seat) => betsByUser.has(seat.user_id));
  if (!force && seats.length > 1 && !bettors.every((seat) => seat.ready)) {
    return { resolved: false };
  }

  const userIds = bettors.map((seat) => seat.user_id);
  const profiles = await tx`
    select id, coins
    from public.profiles
    where id = any(${userIds}::uuid[])
    for update
  `;
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  for (const seat of bettors) {
    const playerBets = betsByUser.get(seat.user_id) ?? [];
    const totalBet = sumBets(playerBets);
    const profile = profilesById.get(seat.user_id);
    if (!profile || asInt(profile.coins) < totalBet) {
      await tx`
        update public.roulette_seats
           set ready = false, updated_at = now()
         where id = ${seat.id}
      `;
      return {
        resolved: false,
        notice: `${seat.nick_snapshot} nie ma już coinów na swój zakład.`,
      };
    }
  }

  const number = randomNumber();
  const color = numberColor(number);
  const casinoLuck = await hasCasinoLuck(tx);
  let roundTotalBet = 0;
  let roundTotalWon = 0;

  for (const seat of bettors) {
    const playerBets = betsByUser.get(seat.user_id) ?? [];
    const totalBet = sumBets(playerBets);
    const effect = await getStrongestHeroEffect(tx, seat.user_id, "roulette");
    let { totalWon, itemEffect } = outcomeForBets(playerBets, number, effect);
    if (totalWon > 0 && casinoLuck) {
      // floor (see payout_bonus note in outcomeForBets): ceil is +EV at 1-coin stakes.
      const luckBonus = Math.floor(totalWon * CASINO_LUCK_PAYOUT_PCT / 100);
      if (luckBonus > 0) {
        totalWon += luckBonus;
        itemEffect = itemEffect ?? {
          slug: "lucky_amulet",
          name: "Amulet Fortuny",
          type: "casino_luck",
          value: CASINO_LUCK_PAYOUT_PCT,
          bonus: luckBonus,
        };
      }
    }
    roundTotalBet += totalBet;
    roundTotalWon += totalWon;

    await tx`
      update public.profiles
         set coins = coins - ${totalBet} + ${totalWon}
       where id = ${seat.user_id}
    `;
    await tx`
      update public.roulette_seats
         set ready = false,
             session_total_bet = session_total_bet + ${totalBet},
             session_total_won = session_total_won + ${totalWon},
             updated_at = now()
       where id = ${seat.id}
    `;
    await tx`
      insert into public.roulette_spins
        (user_id, table_id, round_id, seat_no, bets, result_number, result_color, total_bet, total_won, item_effect)
      values
        (${seat.user_id}, ${table.id}, ${round.id}, ${seat.seat_no}, ${JSON.stringify(playerBets)}::jsonb,
         ${number}, ${color}, ${totalBet}, ${totalWon}, ${itemEffect ? JSON.stringify(itemEffect) : null}::jsonb)
    `;
  }

  await tx`
    update public.roulette_rounds
       set status = 'resolved',
           result_number = ${number},
           result_color = ${color},
           total_bet = ${roundTotalBet},
           total_won = ${roundTotalWon},
           spun_by = ${triggerUserId},
           resolved_at = now()
     where id = ${round.id}
  `;
  await createNextRound(tx, table);
  return { resolved: true };
}

// Sweep abandoned seats. Mirrors leave()'s DB mutations exactly (coins are only
// touched at spin/resolve time, never at bet time, so deleting a stale seat's
// current-round bets refunds nothing and corrupts nothing). Runs inside the same
// FOR UPDATE lock as the rest of the txn, so concurrent state reads serialize and
// a second sweep simply finds the row already gone. Self-healing: any player's
// state read clears everyone's ghosts, even after the ghost's own tab is closed.
async function evictStaleSeats(tx) {
  const { table, round, seats } = await loadLockedGame(tx);
  if (!seats.length) return;

  // Don't yank a seat in the brief window right after a resolution: a client
  // mid-animation hasn't had a chance to send its next heartbeat yet. Correctness
  // doesn't depend on this (the FOR UPDATE lock already serializes us behind
  // resolveRound) — it just avoids a cosmetic seat-vanish during the reveal.
  const lastResolved = await tx`
    select resolved_at
    from public.roulette_rounds
    where table_id = ${table.id} and status = 'resolved'
    order by resolved_at desc nulls last, created_at desc
    limit 1
  `;
  const resolvedAt = lastResolved[0]?.resolved_at;
  if (resolvedAt && Date.now() - new Date(resolvedAt).getTime() < 5_000) return;

  const cutoff = Date.now() - SEAT_STALE_MS;
  const stale = seats.filter((seat) => {
    const seen = seat.last_seen ? new Date(seat.last_seen).getTime() : 0;
    return seen < cutoff;
  });
  if (!stale.length) return;

  for (const seat of stale) {
    await tx`delete from public.roulette_bets where round_id = ${round.id} and user_id = ${seat.user_id}`;
    await tx`delete from public.roulette_seats where id = ${seat.id}`;
  }
  await tx`update public.roulette_tables set updated_at = now() where id = ${table.id}`;
}

async function getState(userId) {
  return await db.begin(async (tx) => {
    await evictStaleSeats(tx);
    // Heartbeat: bump the caller's own seat so an idle *watcher* who never bets
    // isn't evicted (updated_at alone wouldn't cover them). No-op when not seated.
    await tx`
      update public.roulette_seats
         set last_seen = now()
       where table_id = (select id from public.roulette_tables where slug = 'main')
         and user_id = ${userId}
    `;
    return stateResponse(tx, userId);
  });
}

async function sit(userId, requestedSeatNo = null) {
  return await db.begin(async (tx) => {
    const { table, seats } = await loadLockedGame(tx);
    if (seats.some((seat) => seat.user_id === userId)) throw gameError("Już siedzisz przy stole.");
    const maxSeats = asInt(table.max_seats, 6);
    if (seats.length >= maxSeats) throw gameError("Brak wolnych miejsc.");

    const profileRows = await tx`
      select id, nick
      from public.profiles
      where id = ${userId}
    `;
    const profile = profileRows[0];
    if (!profile) throw gameError("Nie znaleziono profilu.");

    const occupied = seats.map((seat) => asInt(seat.seat_no));
    const normalizedSeatNo = normalizeSeatNo(requestedSeatNo);
    let seatNo = normalizedSeatNo;
    if (seatNo !== null) {
      if (seatNo >= maxSeats) throw gameError("Nieprawidłowe miejsce.");
      if (occupied.includes(seatNo)) throw gameError("To miejsce jest już zajęte.");
    } else {
      seatNo = 0;
      while (occupied.includes(seatNo)) seatNo += 1;
    }

    await tx`
      insert into public.roulette_seats (table_id, seat_no, user_id, nick_snapshot)
      values (${table.id}, ${seatNo}, ${userId}, ${profile.nick})
    `;
    return stateResponse(tx, userId);
  });
}

async function leave(userId) {
  return await db.begin(async (tx) => {
    const { table, round, seats } = await loadLockedGame(tx);
    const seat = seats.find((row) => row.user_id === userId);
    if (!seat) throw gameError("Nie siedzisz przy stole.");
    await tx`delete from public.roulette_bets where round_id = ${round.id} and user_id = ${userId}`;
    await tx`delete from public.roulette_seats where id = ${seat.id}`;
    await tx`update public.roulette_tables set updated_at = now() where id = ${table.id}`;
    return stateResponse(tx, userId);
  });
}

async function addBet(userId, betInput) {
  return await db.begin(async (tx) => {
    const { round, seats } = await loadLockedGame(tx);
    const seat = seats.find((row) => row.user_id === userId);
    if (!seat) throw gameError("Najpierw usiądź przy stole.");
    if (seat.ready) throw gameError("Cofnij gotowość, żeby zmienić zakład.");
    const bet = normalizeBet(betInput);

    const currentRows = await tx`
      select amount
      from public.roulette_bets
      where round_id = ${round.id}
        and user_id = ${userId}
    `;
    const currentTotal = currentRows.reduce((sum, row) => sum + asInt(row.amount), 0);
    const profileRows = await tx`
      select coins
      from public.profiles
      where id = ${userId}
    `;
    const coins = asInt(profileRows[0]?.coins);
    if (currentTotal + bet.amount > coins) throw gameError("Za mało coinów na taki zakład.");

    await tx`
      insert into public.roulette_bets (round_id, table_id, user_id, seat_no, type, value, amount)
      values (${round.id}, ${round.table_id}, ${userId}, ${seat.seat_no}, ${bet.type}, ${bet.value ?? null}, ${bet.amount})
    `;
    await tx`update public.roulette_seats set last_seen = now() where id = ${seat.id}`;
    return stateResponse(tx, userId);
  });
}

async function setBets(userId, betsInput) {
  return await db.begin(async (tx) => {
    const { round, seats } = await loadLockedGame(tx);
    const seat = seats.find((row) => row.user_id === userId);
    if (!seat) throw gameError("Najpierw usiądź przy stole.");
    if (seat.ready) throw gameError("Cofnij gotowość, żeby zmienić zakład.");
    const bets = normalizeBets(betsInput);
    const total = sumBets(bets);
    const profileRows = await tx`select coins from public.profiles where id = ${userId}`;
    if (total > asInt(profileRows[0]?.coins)) throw gameError("Za mało coinów na taki zakład.");

    await tx`delete from public.roulette_bets where round_id = ${round.id} and user_id = ${userId}`;
    for (const bet of bets) {
      await tx`
        insert into public.roulette_bets (round_id, table_id, user_id, seat_no, type, value, amount)
        values (${round.id}, ${round.table_id}, ${userId}, ${seat.seat_no}, ${bet.type}, ${bet.value ?? null}, ${bet.amount})
      `;
    }
    await tx`update public.roulette_seats set ready = false, updated_at = now(), last_seen = now() where id = ${seat.id}`;
    return stateResponse(tx, userId);
  });
}

async function clearBets(userId) {
  return await db.begin(async (tx) => {
    const { round, seats } = await loadLockedGame(tx);
    const seat = seats.find((row) => row.user_id === userId);
    if (!seat) throw gameError("Nie siedzisz przy stole.");
    await tx`delete from public.roulette_bets where round_id = ${round.id} and user_id = ${userId}`;
    await tx`update public.roulette_seats set ready = false, updated_at = now(), last_seen = now() where id = ${seat.id}`;
    return stateResponse(tx, userId);
  });
}

async function setReady(userId, readyValue) {
  return await db.begin(async (tx) => {
    const { table, round, seats } = await loadLockedGame(tx);
    const seat = seats.find((row) => row.user_id === userId);
    if (!seat) throw gameError("Najpierw usiądź przy stole.");
    const ready = !!readyValue;
    if (ready) {
      const betRows = await tx`
        select amount
        from public.roulette_bets
        where round_id = ${round.id}
          and user_id = ${userId}
      `;
      const total = betRows.reduce((sum, row) => sum + asInt(row.amount), 0);
      if (total <= 0) throw gameError("Najpierw postaw zakład.");
      const profileRows = await tx`select coins from public.profiles where id = ${userId}`;
      if (total > asInt(profileRows[0]?.coins)) throw gameError("Za mało coinów na ten zakład.");
    }

    await tx`
      update public.roulette_seats
         set ready = ${ready}, updated_at = now(), last_seen = now()
       where id = ${seat.id}
    `;
    const result = ready ? await resolveRound(tx, table, round, userId, false) : { resolved: false };
    return stateResponse(tx, userId, result.notice ? { notice: result.notice } : {});
  });
}

async function spinNow(userId) {
  return await db.begin(async (tx) => {
    const { table, round, seats } = await loadLockedGame(tx);
    const seat = seats.find((row) => row.user_id === userId);
    if (!seat) throw gameError("Najpierw usiądź przy stole.");
    const betRows = await tx`
      select amount
      from public.roulette_bets
      where round_id = ${round.id}
        and user_id = ${userId}
    `;
    const total = betRows.reduce((sum, row) => sum + asInt(row.amount), 0);
    if (total <= 0) throw gameError("Najpierw postaw zakład.");

    if (seats.length > 1) {
      await tx`update public.roulette_seats set ready = true, updated_at = now(), last_seen = now() where id = ${seat.id}`;
      const result = await resolveRound(tx, table, round, userId, false);
      return stateResponse(tx, userId, result.notice ? { notice: result.notice } : {});
    }

    const result = await resolveRound(tx, table, round, userId, true);
    return stateResponse(tx, userId, result.notice ? { notice: result.notice } : {});
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "state");

    let result;
    if (action === "state" || action === "history") result = await getState(user.id);
    else if (action === "sit") result = await sit(user.id, body.seatNo ?? body.seat_no);
    else if (action === "leave") result = await leave(user.id);
    else if (action === "add_bet") result = await addBet(user.id, body.bet);
    else if (action === "set_bets") result = await setBets(user.id, body.bets);
    else if (action === "clear_bets") result = await clearBets(user.id);
    else if (action === "set_ready") result = await setReady(user.id, body.ready);
    else if (action === "spin_now" || action === "spin") result = await spinNow(user.id);
    else throw gameError("Nieznana akcja.");

    return json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
