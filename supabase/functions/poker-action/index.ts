// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";
import pokersolver from "npm:pokersolver@2.1.4";

const Hand = pokersolver.Hand ?? pokersolver.default?.Hand;
if (!Hand) throw new Error("pokersolver Hand export is unavailable.");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
const db = databaseUrl
  ? postgres(databaseUrl, { prepare: false, max: 8, idle_timeout: 20 })
  : null;

const BOT_NICKS = ["Bot 1", "Bot 2", "Bot 3", "Bot 4"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function gameError(message) {
  const err = new Error(message);
  err.isGameError = true;
  return err;
}

function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function pokerBuyInBonus(effect) {
  return effect?.effect_type === "buy_in_bonus"
    ? Math.max(0, asInt(effect.effect_value, 0))
    : 0;
}

function sortSeats(seats) {
  return [...seats].sort((a, b) => a.seat_no - b.seat_no);
}

function createDeck() {
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
  const suits = ["s", "h", "d", "c"];
  const deck = [];
  for (const rank of ranks) {
    for (const suit of suits) deck.push(rank + suit);
  }
  return deck;
}

function shuffle(deck) {
  const out = [...deck];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function nextSeatNo(afterSeat, occupiedSeatNos) {
  const sorted = [...occupiedSeatNos].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const next = sorted.find((seatNo) => seatNo > afterSeat);
  return next ?? sorted[0];
}

function nextSeatObject(afterSeat, seats, predicate) {
  const sorted = sortSeats(seats);
  if (sorted.length === 0) return null;
  const startIndex = sorted.findIndex((seat) => seat.seat_no === afterSeat);
  for (let i = 1; i <= sorted.length; i += 1) {
    const seat = sorted[(Math.max(startIndex, -1) + i) % sorted.length];
    if (predicate(seat)) return seat;
  }
  return null;
}

function isLive(seat) {
  return seat.in_hand && !seat.folded;
}

function canAct(seat) {
  return isLive(seat) && !seat.all_in && seat.stack > 0;
}

function needsAction(table, seat) {
  return canAct(seat) && (!seat.acted || seat.round_bet < table.current_bet);
}

function tablePot(seats) {
  return seats.reduce((sum, seat) => sum + asInt(seat.hand_bet), 0);
}

function setDeadline(table) {
  table.action_deadline = new Date(Date.now() + asInt(table.action_seconds, 30) * 1000).toISOString();
}

function clearAction(table) {
  table.current_seat = null;
  table.action_deadline = null;
}

function legalActionsFor(table, seat) {
  if (!seat || table.current_seat !== seat.seat_no || !needsAction(table, seat)) {
    return { canAct: false };
  }

  const toCall = Math.max(0, table.current_bet - seat.round_bet);
  const callAmount = Math.min(toCall, seat.stack);
  const maxRaiseTo = seat.round_bet + seat.stack;
  const minRaiseTo = table.current_bet + Math.max(table.min_raise, table.big_blind);

  return {
    canAct: true,
    canFold: true,
    canCheck: toCall === 0,
    canCall: toCall > 0 && seat.stack > 0,
    canRaise: maxRaiseTo >= minRaiseTo,
    canAllIn: seat.stack > 0,
    callAmount,
    toCall,
    minRaiseTo,
    maxRaiseTo,
  };
}

function publicSeat(seat, userId, visibleCards) {
  const isBot = !!seat.is_bot;
  return {
    id: seat.id,
    seatNo: seat.seat_no,
    userId: seat.user_id,
    nick: isBot ? (seat.bot_nick ?? "Bot") : seat.nick_snapshot,
    isBot,
    stack: asInt(seat.stack),
    inHand: !!seat.in_hand,
    folded: !!seat.folded,
    allIn: !!seat.all_in,
    roundBet: asInt(seat.round_bet),
    handBet: asInt(seat.hand_bet),
    acted: !!seat.acted,
    lastAction: seat.last_action,
    isMe: !isBot && seat.user_id === userId,
    cards: visibleCards[seat.seat_no] ?? null,
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

async function ensureMainTable(tx) {
  await tx`
    insert into public.poker_tables (slug)
    values ('main')
    on conflict (slug) do nothing
  `;
  const rows = await tx`select * from public.poker_tables where slug = 'main'`;
  if (!rows[0]) throw new Error("Poker table was not created.");
  return rows[0];
}

async function loadLockedGame(tx) {
  const tableRows = await tx`select * from public.poker_tables where slug = 'main' for update`;
  const table = tableRows[0] ?? await ensureMainTable(tx);
  const seats = await tx`
    select * from public.poker_seats
    where table_id = ${table.id}
    order by seat_no
    for update
  `;
  const handRows = table.hand_id
    ? await tx`select * from public.poker_hands where id = ${table.hand_id} for update`
    : [];
  return { table, seats, hand: handRows[0] ?? null };
}

async function persistTable(tx, table) {
  await tx`
    update public.poker_tables
       set phase = ${table.phase},
           hand_id = ${table.hand_id},
           hand_no = ${asInt(table.hand_no)},
           dealer_seat = ${table.dealer_seat},
           current_seat = ${table.current_seat},
           current_bet = ${asInt(table.current_bet)},
           min_raise = ${asInt(table.min_raise)},
           pot = ${asInt(table.pot)},
           board = ${table.board ?? []}::text[],
           action_deadline = ${table.action_deadline},
           updated_at = now()
     where id = ${table.id}
  `;
}

async function persistSeats(tx, seats) {
  for (const seat of seats) {
    await tx`
      update public.poker_seats
         set stack = ${asInt(seat.stack)},
             in_hand = ${!!seat.in_hand},
             folded = ${!!seat.folded},
             all_in = ${!!seat.all_in},
             round_bet = ${asInt(seat.round_bet)},
             hand_bet = ${asInt(seat.hand_bet)},
             acted = ${!!seat.acted},
             last_action = ${seat.last_action},
             is_bot = ${!!seat.is_bot},
             bot_nick = ${seat.bot_nick ?? null},
             updated_at = now()
       where id = ${seat.id}
    `;
  }
}

async function persistHand(tx, hand) {
  if (!hand) return;
  await tx`
    update public.poker_hands
       set deck = ${hand.deck ?? []}::text[],
           burn_cards = ${hand.burn_cards ?? []}::text[],
           active_seats = ${hand.active_seats ?? []}::integer[],
           result = ${hand.result ? JSON.stringify(hand.result) : null}::jsonb,
           settled_at = ${hand.settled_at}
     where id = ${hand.id}
  `;
}

async function logEvent(tx, tableId, handId, message) {
  await tx`
    insert into public.poker_events (table_id, hand_id, message)
    values (${tableId}, ${handId}, ${message})
  `;
}

function postBlind(seat, amount, label) {
  const paid = Math.min(seat.stack, amount);
  seat.stack -= paid;
  seat.round_bet += paid;
  seat.hand_bet += paid;
  seat.all_in = seat.stack === 0;
  seat.last_action = `${label} ${paid}`;
  return paid;
}

function markFullRaise(table, seats, raiser, previousBet) {
  const raiseSize = raiser.round_bet - previousBet;
  if (raiseSize >= Math.max(table.min_raise, table.big_blind)) {
    table.min_raise = raiseSize;
    for (const seat of seats) {
      if (seat.seat_no !== raiser.seat_no && canAct(seat)) seat.acted = false;
    }
  }
}

function payIntoPot(seat, amount) {
  const paid = Math.min(seat.stack, Math.max(0, amount));
  seat.stack -= paid;
  seat.round_bet += paid;
  seat.hand_bet += paid;
  if (seat.stack === 0) seat.all_in = true;
  return paid;
}

function nextStreetInfo(phase) {
  if (phase === "preflop") return { phase: "flop", count: 3, label: "Flop" };
  if (phase === "flop") return { phase: "turn", count: 1, label: "Turn" };
  if (phase === "turn") return { phase: "river", count: 1, label: "River" };
  return null;
}

function dealStreet(table, hand, info) {
  const deck = [...hand.deck];
  const burnCards = [...(hand.burn_cards ?? [])];
  const board = [...(table.board ?? [])];
  const burn = deck.pop();
  if (burn) burnCards.push(burn);
  for (let i = 0; i < info.count; i += 1) {
    const card = deck.pop();
    if (card) board.push(card);
  }
  hand.deck = deck;
  hand.burn_cards = burnCards;
  table.board = board;
  table.phase = info.phase;
}

function sidePots(seats) {
  const committed = seats.filter((seat) => seat.in_hand && seat.hand_bet > 0);
  const levels = [...new Set(committed.map((seat) => seat.hand_bet))].sort((a, b) => a - b);
  const pots = [];
  let previous = 0;

  for (const level of levels) {
    const contributors = committed.filter((seat) => seat.hand_bet >= level);
    const amount = (level - previous) * contributors.length;
    const eligible = contributors.filter((seat) => !seat.folded);
    if (amount > 0 && eligible.length > 0) pots.push({ amount, eligible });
    previous = level;
  }

  return pots;
}

async function settleByFold(tx, table, seats, hand) {
  const winner = seats.find(isLive);
  if (!winner) throw new Error("No fold winner.");
  const pot = tablePot(seats);
  winner.stack += pot;

  const result = {
    type: "fold",
    board: table.board ?? [],
    winners: [{
      seatNo: winner.seat_no,
      nick: winner.is_bot ? (winner.bot_nick ?? "Bot") : winner.nick_snapshot,
      amount: pot,
      hand: "Fold",
      description: "Wszyscy pozostali spasowali",
    }],
  };

  await finishHand(tx, table, seats, hand, result, `${result.winners[0].nick} wygrywa ${pot} coinów po foldzie.`);
}

async function settleShowdown(tx, table, seats, hand) {
  const liveSeats = seats.filter(isLive);
  while ((table.board ?? []).length < 5) {
    const info = nextStreetInfo(table.phase);
    if (!info) break;
    dealStreet(table, hand, info);
  }

  const revealSeatNos = liveSeats.map((seat) => seat.seat_no);
  if (revealSeatNos.length > 0) {
    await tx`
      update public.poker_player_cards
         set revealed = true
       where hand_id = ${hand.id}
         and seat_no = any(${revealSeatNos}::integer[])
    `;
  }

  const cardRows = await tx`
    select seat_no, cards
    from public.poker_player_cards
    where hand_id = ${hand.id}
  `;
  const cardsBySeat = Object.fromEntries(cardRows.map((row) => [row.seat_no, row.cards ?? []]));
  const solvedBySeat = new Map();

  for (const seat of liveSeats) {
    const solved = Hand.solve([...(cardsBySeat[seat.seat_no] ?? []), ...(table.board ?? [])]);
    solved.seatNo = seat.seat_no;
    solvedBySeat.set(seat.seat_no, solved);
  }

  const payouts = new Map();
  const potResults = [];

  for (const pot of sidePots(seats)) {
    let winnerSeatNos;
    if (pot.eligible.length === 1) {
      winnerSeatNos = [pot.eligible[0].seat_no];
    } else {
      // Wrap pokersolver in try-catch; split pot among eligibles on failure.
      try {
        const solvedHands = pot.eligible.map((seat) => solvedBySeat.get(seat.seat_no)).filter(Boolean);
        winnerSeatNos = Hand.winners(solvedHands).map((handResult) => handResult.seatNo);
      } catch {
        await logEvent(tx, table.id, hand.id, "Błąd oceny rąk — pot podzielony równo.");
        winnerSeatNos = pot.eligible.map((s) => s.seat_no);
      }
    }

    winnerSeatNos.sort((a, b) => a - b);
    const share = Math.floor(pot.amount / winnerSeatNos.length);
    let remainder = pot.amount - share * winnerSeatNos.length;
    for (const seatNo of winnerSeatNos) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      payouts.set(seatNo, (payouts.get(seatNo) ?? 0) + share + extra);
    }

    potResults.push({ amount: pot.amount, winnerSeatNos });
  }

  for (const seat of seats) {
    seat.stack += payouts.get(seat.seat_no) ?? 0;
  }

  const winnerDetails = [...payouts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([seatNo, amount]) => {
      const seat = seats.find((s) => s.seat_no === seatNo);
      const solved = solvedBySeat.get(seatNo);
      return {
        seatNo,
        nick: seat?.is_bot ? (seat.bot_nick ?? "Bot") : (seat?.nick_snapshot ?? "Gracz"),
        amount,
        hand: solved?.name ?? "Hand",
        description: solved?.descr ?? "",
      };
    });

  const result = {
    type: "showdown",
    board: table.board ?? [],
    pots: potResults,
    winners: winnerDetails,
  };

  const msg = winnerDetails
    .map((winner) => `${winner.nick} +${winner.amount} (${winner.description || winner.hand})`)
    .join(", ");
  await finishHand(tx, table, seats, hand, result, `Showdown: ${msg}.`);
}

async function finishHand(tx, table, seats, hand, result, message) {
  table.phase = "waiting";
  table.current_seat = null;
  table.current_bet = 0;
  table.min_raise = table.big_blind;
  table.pot = 0;
  table.action_deadline = null;

  for (const seat of seats) {
    seat.in_hand = false;
    seat.folded = false;
    seat.all_in = false;
    seat.round_bet = 0;
    seat.hand_bet = 0;
    seat.acted = false;
    seat.last_action = null;
  }

  hand.result = result;
  hand.settled_at = new Date().toISOString();

  await persistSeats(tx, seats);
  await persistTable(tx, table);
  await persistHand(tx, hand);
  await tx`delete from public.poker_seats where table_id = ${table.id} and stack <= 0`;
  await logEvent(tx, table.id, hand.id, message);
}

// ── Bot intelligence ────────────────────────────────────────────────────────

const RANK_VALUES = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };

function ratePreflopHand(cards) {
  if (!cards || cards.length < 2) return 0.3;
  const r1 = cards[0][0], r2 = cards[1][0];
  const s1 = cards[0][1], s2 = cards[1][1];
  const suited = s1 === s2;
  const v1 = RANK_VALUES[r1] ?? 0, v2 = RANK_VALUES[r2] ?? 0;
  const high = Math.max(v1, v2), low = Math.min(v1, v2);
  const paired = v1 === v2;
  const gap = high - low;

  if (paired) {
    if (high >= 12) return 0.95; // QQ+
    if (high >= 10) return 0.85; // TT-JJ
    if (high >= 7) return 0.70;  // 77-99
    return 0.55;                  // 22-66
  }
  if (high === 14 && low === 13) return suited ? 0.90 : 0.85; // AK
  if (high === 14 && low >= 11) return suited ? 0.75 : 0.70;  // AQ, AJ
  if (high === 13 && low === 12) return suited ? 0.70 : 0.65;  // KQ
  if (high === 14) return suited ? 0.60 : 0.40;                // Ax
  if (suited && gap === 1 && low >= 7) return 0.58;            // suited connectors 87s+
  if (suited && gap === 1) return 0.45;                         // low suited connectors
  if (suited && high >= 10) return 0.50;                        // suited broadways
  if (suited) return 0.35;
  if (high >= 10 && low >= 10) return 0.55;                    // offsuit broadways
  if (high >= 10) return 0.35;
  return 0.22;
}

function ratePostflopHand(holeCards, board) {
  try {
    const solved = Hand.solve([...holeCards, ...board]);
    const rankMap = { 1: 0.25, 2: 0.45, 3: 0.60, 4: 0.70, 5: 0.80, 6: 0.85, 7: 0.90, 8: 0.95, 9: 0.97, 10: 1.0 };
    return rankMap[solved.rank] ?? 0.3;
  } catch { return 0.3; }
}

function applyBotMove(table, seats, botSeat, botCards, board) {
  const toCall = Math.max(0, table.current_bet - botSeat.round_bet);
  const pot = tablePot(seats);
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const isPreflop = !board || board.length === 0;

  let strength = isPreflop ? ratePreflopHand(botCards) : ratePostflopHand(botCards, board);
  // personality variance per seat
  strength += ((botSeat.seat_no % 4) - 1.5) * 0.03;
  // randomness
  strength += (Math.random() - 0.5) * 0.1;
  strength = Math.max(0, Math.min(1, strength));

  const minRaiseTo = table.current_bet + Math.max(table.min_raise, table.big_blind);
  const maxRaiseTo = botSeat.round_bet + botSeat.stack;
  const canRaise = maxRaiseTo >= minRaiseTo;

  function botRaise() {
    let raiseTo;
    if (isPreflop) {
      raiseTo = table.current_bet > table.big_blind
        ? Math.round(table.current_bet + table.big_blind * 2.5)
        : table.big_blind * 3;
    } else {
      const potRaise = table.current_bet + Math.round(pot * (0.6 + Math.random() * 0.2));
      raiseTo = potRaise;
    }
    raiseTo = Math.max(minRaiseTo, Math.min(maxRaiseTo, raiseTo));
    if (canRaise) {
      applyPlayerMove(table, seats, botSeat, { move: "raise", raiseTo }, false);
    } else if (toCall > 0) {
      applyPlayerMove(table, seats, botSeat, { move: "call" }, false);
    } else {
      botSeat.acted = true; botSeat.last_action = "check";
    }
  }

  const r = Math.random();

  if (toCall === 0) {
    if (strength > 0.80) { r < 0.65 ? botRaise() : (botSeat.acted = true, botSeat.last_action = "check"); }
    else if (strength > 0.55) { r < 0.40 ? botRaise() : (botSeat.acted = true, botSeat.last_action = "check"); }
    else if (strength > 0.35) { r < 0.15 ? botRaise() : (botSeat.acted = true, botSeat.last_action = "check"); }
    else { r < 0.10 ? botRaise() : (botSeat.acted = true, botSeat.last_action = "check"); }
  } else {
    if (strength > 0.80) {
      r < 0.60 ? botRaise() : applyPlayerMove(table, seats, botSeat, { move: "call" }, false);
    } else if (strength > 0.55) {
      if (strength > potOdds + 0.1) { applyPlayerMove(table, seats, botSeat, { move: "call" }, false); }
      else { r < 0.60 ? (botSeat.folded = true, botSeat.acted = true, botSeat.last_action = "fold") : applyPlayerMove(table, seats, botSeat, { move: "call" }, false); }
    } else if (strength > 0.35) {
      if (strength > potOdds + 0.2) { applyPlayerMove(table, seats, botSeat, { move: "call" }, false); }
      else { r < 0.75 ? (botSeat.folded = true, botSeat.acted = true, botSeat.last_action = "fold") : applyPlayerMove(table, seats, botSeat, { move: "call" }, false); }
    } else {
      if (r < 0.88) { botSeat.folded = true; botSeat.acted = true; botSeat.last_action = "fold"; }
      else if (r < 0.92 && canRaise) { botRaise(); }
      else { applyPlayerMove(table, seats, botSeat, { move: "call" }, false); }
    }
  }
}

async function advanceGame(tx, table, seats, hand, afterSeatNo) {
  table.pot = tablePot(seats);

  const liveSeats = seats.filter(isLive);
  if (liveSeats.length <= 1) {
    await settleByFold(tx, table, seats, hand);
    return;
  }

  let nextActor = nextSeatObject(afterSeatNo, seats, (seat) => needsAction(table, seat));
  if (nextActor) {
    table.current_seat = nextActor.seat_no;
    setDeadline(table);

    // Load bot hole cards for strategic decisions.
    const botSeatNos = seats.filter((s) => s.is_bot && s.in_hand).map((s) => s.seat_no);
    const botCardRows = botSeatNos.length > 0
      ? await tx`select seat_no, cards from public.poker_player_cards where hand_id = ${hand.id} and seat_no = any(${botSeatNos}::integer[])`
      : [];
    const botCardsBySeat = new Map(botCardRows.map((r) => [r.seat_no, r.cards]));

    // If the next actor is a bot, auto-play until a human needs to act (or hand ends).
    let botLoops = 0;
    while (nextActor.is_bot && botLoops++ < 20) {
      applyBotMove(table, seats, nextActor, botCardsBySeat.get(nextActor.seat_no) ?? [], table.board ?? []);
      table.pot = tablePot(seats);

      const liveAfterBot = seats.filter(isLive);
      if (liveAfterBot.length <= 1) {
        await settleByFold(tx, table, seats, hand);
        return;
      }

      const followingActor = nextSeatObject(nextActor.seat_no, seats, (seat) => needsAction(table, seat));
      if (!followingActor) {
        // No one needs to act — fall through to street/showdown handling below.
        nextActor = null;
        break;
      }
      nextActor = followingActor;
      table.current_seat = nextActor.seat_no;
      setDeadline(table);
    }

    if (nextActor) {
      // A human is next to act — persist and wait for their request.
      await persistSeats(tx, seats);
      await persistTable(tx, table);
      await persistHand(tx, hand);
      return;
    }
    // nextActor became null inside bot loop — fall through to settlement/new-street logic.
    table.pot = tablePot(seats);
  }

  const actorsLeft = seats.filter(canAct);
  if (actorsLeft.length < 2) {
    await settleShowdown(tx, table, seats, hand);
    return;
  }

  if (table.phase === "river") {
    await settleShowdown(tx, table, seats, hand);
    return;
  }

  const info = nextStreetInfo(table.phase);
  if (!info) {
    await settleShowdown(tx, table, seats, hand);
    return;
  }

  dealStreet(table, hand, info);
  table.current_bet = 0;
  table.min_raise = table.big_blind;
  table.pot = tablePot(seats);
  for (const seat of seats) {
    if (seat.in_hand) {
      seat.round_bet = 0;
      seat.acted = false;
      seat.last_action = null;
    }
  }

  await logEvent(tx, table.id, hand.id, `${info.label}: ${(table.board ?? []).join(" ")}`);
  await advanceGame(tx, table, seats, hand, table.dealer_seat);
}

async function stateResponse(tx, userId) {
  const table = await ensureMainTable(tx);
  const profileRows = await tx`
    select id, nick, coins
    from public.profiles
    where id = ${userId}
  `;
  const profile = profileRows[0];
  if (!profile) throw gameError("Nie znaleziono profilu.");

  const seats = await tx`
    select *
    from public.poker_seats
    where table_id = ${table.id}
    order by seat_no
  `;

  const eventsDesc = await tx`
    select id, message, created_at
    from public.poker_events
    where table_id = ${table.id}
    order by created_at desc
    limit 30
  `;

  const handRows = table.hand_id
    ? await tx`select id, result from public.poker_hands where id = ${table.hand_id}`
    : [];
  const lastHand = handRows[0] ?? null;

  const cardRows = table.hand_id
    ? await tx`
        select seat_no, user_id, cards, revealed
        from public.poker_player_cards
        where hand_id = ${table.hand_id}
      `
    : [];

  const visibleCards = {};
  for (const row of cardRows) {
    if (row.user_id === userId || row.revealed) visibleCards[row.seat_no] = row.cards;
  }

  const mySeat = seats.find((seat) => !seat.is_bot && seat.user_id === userId) ?? null;
  const humanSeats = seats.filter((seat) => !seat.is_bot);
  const playableSeats = seats.filter((seat) => seat.stack > 0);
  const pokerEffect = await getStrongestHeroEffect(tx, userId, "poker");
  const buyInBonus = pokerBuyInBonus(pokerEffect);
  const buyInCost = asInt(table.buy_in) + buyInBonus;

  const glassesRows = await tx`
    SELECT 1 FROM public.hero_equipment he
    JOIN public.hero_item_instances hii ON hii.id = he.item_instance_id
    JOIN public.hero_item_defs hid ON hid.id = hii.item_def_id
    WHERE he.user_id = ${userId}
      AND hii.owner_id = ${userId}
      AND hid.is_active = true
      AND hid.slug = 'poker_glasses'
    LIMIT 1
  `;
  const hasPokerGlasses = glassesRows.length > 0;

  // Win-probability hint via Monte Carlo — for admin and poker-glasses owners.
  let adminHint = null;
  if ((profile.nick === "admin" || hasPokerGlasses) && mySeat && mySeat.in_hand && !mySeat.folded && visibleCards[mySeat.seat_no]) {
    const myCards = visibleCards[mySeat.seat_no];
    const board = table.board ?? [];
    const opponents = seats.filter((s) => s.seat_no !== mySeat.seat_no && isLive(s)).length;
    if (opponents > 0) {
      const used = new Set([...myCards, ...board]);
      const remaining = createDeck().filter((c) => !used.has(c));
      const SIMS = 500;
      let wins = 0;
      for (let i = 0; i < SIMS; i++) {
        const shuffled = shuffle(remaining);
        let idx = 0;
        const simBoard = [...board];
        while (simBoard.length < 5) simBoard.push(shuffled[idx++]);
        const myHand = Hand.solve([...myCards, ...simBoard]);
        let best = true;
        for (let o = 0; o < opponents; o++) {
          const oppCards = [shuffled[idx++], shuffled[idx++]];
          const oppHand = Hand.solve([...oppCards, ...simBoard]);
          if (Hand.winners([myHand, oppHand])[0] !== myHand) { best = false; break; }
        }
        if (best) wins++;
      }
      adminHint = Math.round((wins / SIMS) * 100);
    }
  }

  return {
    table: {
      id: table.id,
      phase: table.phase,
      handNo: asInt(table.hand_no),
      buyIn: asInt(table.buy_in),
      smallBlind: asInt(table.small_blind),
      bigBlind: asInt(table.big_blind),
      actionSeconds: asInt(table.action_seconds),
      maxSeats: asInt(table.max_seats, 6),
      dealerSeat: table.dealer_seat,
      currentSeat: table.current_seat,
      currentBet: asInt(table.current_bet),
      minRaise: asInt(table.min_raise),
      pot: asInt(table.pot),
      board: table.board ?? [],
      actionDeadline: table.action_deadline,
      buyInBonus,
      buyInCost,
    },
    profile: {
      coins: asInt(profile.coins),
      nick: profile.nick,
    },
    seats: seats.map((seat) => publicSeat(seat, userId, visibleCards)),
    me: {
      seatNo: mySeat?.seat_no ?? null,
      stack: mySeat ? asInt(mySeat.stack) : 0,
      // canSit counts only human seats against the limit — bot seats don't block humans.
      canSit: !mySeat && humanSeats.length < asInt(table.max_seats, 6) && asInt(profile.coins) >= buyInCost,
      canStand: !!mySeat && table.phase === "waiting",
      canStart: !!mySeat && table.phase === "waiting" && playableSeats.length >= 2,
      legalActions: legalActionsFor(table, mySeat),
    },
    lastResult: lastHand?.result ?? null,
    events: eventsDesc.reverse(),
    adminHint,
  };
}

async function getState(userId) {
  return await db.begin(async (tx) => stateResponse(tx, userId));
}

async function sit(userId) {
  return await db.begin(async (tx) => {
    const { table, seats } = await loadLockedGame(tx);
    if (seats.some((seat) => !seat.is_bot && seat.user_id === userId)) throw gameError("Już siedzisz przy stole.");
    const humanSeats = seats.filter((seat) => !seat.is_bot);
    if (humanSeats.length >= asInt(table.max_seats, 6)) throw gameError("Brak wolnych miejsc.");

    const profileRows = await tx`
      select id, nick, coins
      from public.profiles
      where id = ${userId}
      for update
    `;
    const profile = profileRows[0];
    if (!profile) throw gameError("Nie znaleziono profilu.");

    const effect = await getStrongestHeroEffect(tx, userId, "poker");
    const stackBonus = pokerBuyInBonus(effect);
    const buyInCost = asInt(table.buy_in) + stackBonus;
    if (asInt(profile.coins) < buyInCost) throw gameError("Masz za mało coinów na buy-in.");
    const startingStack = buyInCost;

    const occupied = seats.map((seat) => seat.seat_no);
    let seatNo = 0;
    while (occupied.includes(seatNo)) seatNo += 1;

    await tx`
      update public.profiles
         set coins = coins - ${buyInCost}
       where id = ${userId}
    `;
    await tx`
      insert into public.poker_seats (table_id, seat_no, user_id, nick_snapshot, stack)
      values (${table.id}, ${seatNo}, ${userId}, ${profile.nick}, ${startingStack})
    `;
    await tx`
      insert into public.poker_ledger (user_id, nick_snapshot, type, amount)
      values (${userId}, ${profile.nick}, 'buy_in', ${buyInCost})
    `;
    await logEvent(
      tx,
      table.id,
      table.hand_id,
      stackBonus > 0
        ? `${profile.nick} siada do stołu za ${buyInCost} coinów (${table.buy_in}+${stackBonus} dzięki ${effect.name}).`
        : `${profile.nick} siada do stołu za ${table.buy_in} coinów.`
    );
    return stateResponse(tx, userId);
  });
}

async function stand(userId) {
  return await db.begin(async (tx) => {
    const { table, seats } = await loadLockedGame(tx);
    if (table.phase !== "waiting") throw gameError("Możesz odejść dopiero po zakończeniu rozdania.");
    const seat = seats.find((row) => !row.is_bot && row.user_id === userId);
    if (!seat) throw gameError("Nie siedzisz przy stole.");

    await tx`
      update public.profiles
         set coins = coins + ${asInt(seat.stack)}
       where id = ${userId}
    `;
    await tx`delete from public.poker_seats where id = ${seat.id}`;
    if (asInt(seat.stack) > 0) {
      await tx`
        insert into public.poker_ledger (user_id, nick_snapshot, type, amount)
        values (${userId}, ${seat.nick_snapshot}, 'cashout', ${asInt(seat.stack)})
      `;
    }
    await logEvent(tx, table.id, table.hand_id, `${seat.nick_snapshot} odchodzi od stołu z ${seat.stack} coinami.`);
    return stateResponse(tx, userId);
  });
}

async function startHand(userId) {
  return await db.begin(async (tx) => {
    const { table, seats } = await loadLockedGame(tx);
    if (table.phase !== "waiting") throw gameError("Rozdanie już trwa.");
    if (!seats.some((seat) => !seat.is_bot && seat.user_id === userId)) throw gameError("Najpierw usiądź przy stole.");

    const active = sortSeats(seats.filter((seat) => seat.stack > 0));
    if (active.length < 2) throw gameError("Do rozdania potrzeba co najmniej dwóch graczy.");

    const activeSeatNos = active.map((seat) => seat.seat_no);
    const dealerSeat = table.dealer_seat == null
      ? activeSeatNos[0]
      : nextSeatNo(table.dealer_seat, activeSeatNos);
    const smallBlindSeat = active.length === 2 ? dealerSeat : nextSeatNo(dealerSeat, activeSeatNos);
    const bigBlindSeat = nextSeatNo(smallBlindSeat, activeSeatNos);

    const deck = shuffle(createDeck());
    const dealOrder = [];
    let dealSeat = nextSeatNo(dealerSeat, activeSeatNos);
    for (let i = 0; i < active.length; i += 1) {
      dealOrder.push(dealSeat);
      dealSeat = nextSeatNo(dealSeat, activeSeatNos);
    }

    const cardsBySeat = Object.fromEntries(activeSeatNos.map((seatNo) => [seatNo, []]));
    for (let round = 0; round < 2; round += 1) {
      for (const seatNo of dealOrder) cardsBySeat[seatNo].push(deck.pop());
    }

    for (const seat of seats) {
      seat.in_hand = activeSeatNos.includes(seat.seat_no);
      seat.folded = false;
      seat.all_in = false;
      seat.round_bet = 0;
      seat.hand_bet = 0;
      seat.acted = false;
      seat.last_action = null;
    }

    const sbSeat = seats.find((seat) => seat.seat_no === smallBlindSeat);
    const bbSeat = seats.find((seat) => seat.seat_no === bigBlindSeat);
    postBlind(sbSeat, asInt(table.small_blind), "SB");
    postBlind(bbSeat, asInt(table.big_blind), "BB");

    const handId = crypto.randomUUID();
    table.hand_id = handId;
    table.hand_no = asInt(table.hand_no) + 1;
    table.dealer_seat = dealerSeat;
    table.phase = "preflop";
    table.current_bet = Math.max(sbSeat.round_bet, bbSeat.round_bet);
    table.min_raise = asInt(table.big_blind);
    table.pot = tablePot(seats);
    table.board = [];
    clearAction(table);

    const hand = {
      id: handId,
      table_id: table.id,
      hand_no: table.hand_no,
      dealer_seat: dealerSeat,
      deck,
      burn_cards: [],
      active_seats: activeSeatNos,
      result: null,
      settled_at: null,
    };

    await tx`
      insert into public.poker_hands (id, table_id, hand_no, dealer_seat, deck, active_seats)
      values (${handId}, ${table.id}, ${table.hand_no}, ${dealerSeat}, ${deck}::text[], ${activeSeatNos}::integer[])
    `;

    for (const seat of active) {
      await tx`
        insert into public.poker_player_cards (hand_id, table_id, seat_no, user_id, cards)
        values (${handId}, ${table.id}, ${seat.seat_no}, ${seat.user_id}, ${cardsBySeat[seat.seat_no]}::text[])
      `;
    }

    await logEvent(tx, table.id, handId, `Rozdanie #${table.hand_no}: dealer ${dealerSeat + 1}, blindy ${table.small_blind}/${table.big_blind}.`);
    await advanceGame(tx, table, seats, hand, bigBlindSeat);
    return stateResponse(tx, userId);
  });
}

function applyPlayerMove(table, seats, actor, body, timedOut = false) {
  const move = timedOut
    ? (Math.max(0, table.current_bet - actor.round_bet) === 0 ? "check" : "fold")
    : String(body.move ?? "");
  const toCall = Math.max(0, table.current_bet - actor.round_bet);

  if (move === "fold") {
    actor.folded = true;
    actor.acted = true;
    actor.last_action = timedOut ? "timeout fold" : "fold";
    return;
  }

  if (move === "check") {
    if (toCall > 0) throw gameError("Nie możesz checkować, gdy jest zakład do sprawdzenia.");
    actor.acted = true;
    actor.last_action = timedOut ? "timeout check" : "check";
    return;
  }

  if (move === "call") {
    if (toCall <= 0) throw gameError("Nie ma zakładu do sprawdzenia.");
    const paid = payIntoPot(actor, toCall);
    actor.acted = true;
    actor.last_action = actor.all_in ? `all-in call ${paid}` : `call ${paid}`;
    return;
  }

  if (move === "raise") {
    const raiseTo = asInt(body.raiseTo, 0);
    const maxRaiseTo = actor.round_bet + actor.stack;
    const minRaiseTo = table.current_bet + Math.max(table.min_raise, table.big_blind);
    if (raiseTo < minRaiseTo) throw gameError(`Minimalne przebicie to ${minRaiseTo}.`);
    if (raiseTo > maxRaiseTo) throw gameError("Nie masz tylu coinów w stacku.");
    const previousBet = table.current_bet;
    const paid = payIntoPot(actor, raiseTo - actor.round_bet);
    table.current_bet = actor.round_bet;
    markFullRaise(table, seats, actor, previousBet);
    actor.acted = true;
    actor.last_action = actor.all_in ? `all-in raise ${raiseTo}` : `raise ${raiseTo}`;
    return;
  }

  if (move === "all_in") {
    if (actor.stack <= 0) throw gameError("Nie masz coinów w stacku.");
    const previousBet = table.current_bet;
    const paid = payIntoPot(actor, actor.stack);
    if (actor.round_bet > table.current_bet) {
      table.current_bet = actor.round_bet;
      markFullRaise(table, seats, actor, previousBet);
    }
    actor.acted = true;
    actor.last_action = `all-in ${paid}`;
    return;
  }

  throw gameError("Nieznana akcja.");
}

async function act(userId, body) {
  return await db.begin(async (tx) => {
    const { table, seats, hand } = await loadLockedGame(tx);
    if (!hand || table.phase === "waiting") throw gameError("Nie ma aktywnego rozdania.");
    const actor = seats.find((seat) => !seat.is_bot && seat.user_id === userId);
    if (!actor || actor.seat_no !== table.current_seat) throw gameError("Teraz nie jest Twoja kolej.");
    if (!needsAction(table, actor)) throw gameError("Nie masz teraz akcji.");

    applyPlayerMove(table, seats, actor, body, false);
    await advanceGame(tx, table, seats, hand, actor.seat_no);
    return stateResponse(tx, userId);
  });
}

async function claimTimeout(userId) {
  return await db.begin(async (tx) => {
    const { table, seats, hand } = await loadLockedGame(tx);
    if (!hand || table.phase === "waiting" || table.current_seat == null) return stateResponse(tx, userId);
    if (!table.action_deadline || new Date(table.action_deadline).getTime() > Date.now()) {
      return stateResponse(tx, userId);
    }

    const actor = seats.find((seat) => seat.seat_no === table.current_seat);
    if (!actor || !needsAction(table, actor)) return stateResponse(tx, userId);

    // Bots should not time out via the client claim — they play inline.
    if (actor.is_bot) return stateResponse(tx, userId);

    applyPlayerMove(table, seats, actor, {}, true);
    await advanceGame(tx, table, seats, hand, actor.seat_no);
    return stateResponse(tx, userId);
  });
}

async function setBots(userId, count) {
  return await db.begin(async (tx) => {
    const { table, seats } = await loadLockedGame(tx);
    const [profile] = await tx`select nick from public.profiles where id = ${userId}`;
    if (profile?.nick !== "admin") throw gameError("Tylko admin może zmieniać boty.");
    if (table.phase !== "waiting") throw gameError("Boty można zmienić tylko między rozdaniami.");

    const n = Math.max(0, Math.min(4, asInt(count)));

    // Remove all existing bot seats.
    await tx`delete from public.poker_seats where table_id = ${table.id} and is_bot = true`;

    const humanSeats = seats.filter((s) => !s.is_bot);
    const slotsAvailable = asInt(table.max_seats, 6) - humanSeats.length;
    const botsToAdd = Math.min(n, slotsAvailable);
    const occupiedNos = humanSeats.map((s) => s.seat_no);

    for (let i = 0; i < botsToAdd; i += 1) {
      let seatNo = 0;
      while (occupiedNos.includes(seatNo)) seatNo += 1;
      occupiedNos.push(seatNo);
      const nick = BOT_NICKS[i];
      await tx`
        insert into public.poker_seats (table_id, seat_no, user_id, nick_snapshot, stack, is_bot, bot_nick)
        values (${table.id}, ${seatNo}, null, ${nick}, ${asInt(table.buy_in)}, true, ${nick})
      `;
    }

    const msg = botsToAdd > 0 ? `Dodano ${botsToAdd} botów.` : "Usunięto boty.";
    await logEvent(tx, table.id, null, msg);
    return stateResponse(tx, userId);
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  try {
    if (!db) throw new Error("SUPABASE_DB_URL is not configured for poker-action.");
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "state");

    let state;
    if (action === "state") state = await getState(user.id);
    else if (action === "sit") state = await sit(user.id);
    else if (action === "stand") state = await stand(user.id);
    else if (action === "start_hand") state = await startHand(user.id);
    else if (action === "act") state = await act(user.id, body);
    else if (action === "claim_timeout") state = await claimTimeout(user.id);
    else if (action === "set_bots") state = await setBots(user.id, body.count);
    else throw gameError("Nieznana akcja.");

    return json({ ok: true, ...state });
  } catch (err) {
    console.error(err);
    const message = err?.isGameError
      ? err.message
      : "Nie udało się wykonać akcji pokerowej.";
    return json({ ok: false, error: message });
  }
});
