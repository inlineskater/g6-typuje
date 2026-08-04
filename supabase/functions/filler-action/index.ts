// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

// „Filler" — 1v1 territory flood-fill. SERVER-AUTHORITATIVE FOR EVERY MOVE
// (Poker/Roulette/Wheel model), not the client-replayed-tick-simulation
// pattern every other seasonal/arcade game in this repo uses — see
// supabase/filler.sql's header comment and docs/filler.md for the full
// rationale. There is deliberately no client-side authoritative sim and no
// parity-fuzzer script: the client only ever renders whatever board state
// this function returns.
//
// Bot-mode and PvP-mode share this one Edge Function and one pair of tables:
// a "vs bot" match is just a 2-seat match whose seat 1 is
// (user_id NULL, is_bot true) — Poker's bots.sql trick. There is no hidden
// information (the whole board is public at all times), so there is no
// secrets table and no per-caller sanitization — every caller gets the same
// board.

const ALLOWED_ORIGINS = new Set([
  "https://inlineskater.github.io",
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(req) {
  const origin = req?.headers?.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin) ? origin : "https://inlineskater.github.io",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const db = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 4, idle_timeout: 20 });

// ── Constants ────────────────────────────────────────────────────────────
// Board: 21x27 = 567 tiles, 7 colors. Odd cell count ⇒ majority = 284 ⇒ ties
// are structurally impossible (no draw-handling complexity needed). ANY board
// size here must keep width*height ODD or a real draw becomes reachable and
// every `winner_seat IS NULL` reader needs a genuine draw case.
//
// The "portrait-looking" 21x27 renders as a LANDSCAPE field: on the diamond
// lattice (see neighbors4) rows overlap by half a tile, so h rows are only
// (h+1)/2 tiles tall — 21x27 draws as 21.5 x 14, a 1.54:1 field matching the
// original's proportions. The old square-grid 31x17 would draw 3.5:1 here.
const FILLER_W = 21, FILLER_H = 27, FILLER_COLORS = 7;
// Practice matches vs a bot use a SMALLER board: scripts/filler-balance.mjs
// puts 15x19=285 at median 40 total plies (20 of your own moves) against
// 21x27's 58/29 — a ~30% shorter game, which is what makes a bot match a
// quick practice round rather than a full sitting. Safe to differ per match
// because a bot match never scores (see finishScoring), so it can't skew a
// leaderboard calibrated on the PvP board, and because every dimension-
// dependent value below is derived from the match row's own width/height
// rather than from these constants. 285 is odd, and 15x19 draws as
// 15.5 x 10 = 1.55:1 — see the note above.
const FILLER_BOT_W = 15, FILLER_BOT_H = 19;

const FILLER_TURN_MS = 15_000;         // per-turn deadline
const FILLER_TURN_GRACE_MS = 1_500;    // RTT slack before the server steals a turn
const FILLER_QUEUE_MS = 18_000;        // human wait before the bot fallback
// anti-stall safety cap — scripts/filler-balance.mjs (2000 bot-vs-bot sims at
// 21x27x7 on the diamond lattice) measured median 58 / p90 67 / p99 76 / max
// 86 total plies, with 0/2000 re-runs hitting this cap; real games finish
// ~58 plies. The smaller bot board finishes sooner still, so one cap covers
// both.
const FILLER_MAX_MOVES = 100;
const FILLER_ABANDON_TIMEOUTS = 3;     // consecutive auto-plays vs a BOT ⇒ cancel, no score
const FILLER_SWEEP_LIMIT = 5;          // distinct stale matches healed per request
const FILLER_CATCHUP_MAX = 6;          // plies caught up per stale match per request
const FILLER_INLINE_BOT_MAX = 20;      // guard on the inline "keep playing while it's a bot's turn" loop

const FILLER_BOT_NICKS = ["Bot Zaklepywacz", "Kolorek", "Pan Wypełniacz", "Zalewacz"];

// Score (PvP only — see the anti-farming note below).
const FILLER_SCORE_CAP = 350;
// scripts/filler-balance.mjs measured the winner's own moves_made at median
// 29 / p90 34 / p99 38 on the 21x27x7 board; par = median * 1.15, rounded.
const FILLER_MOVES_PAR = 33;
const FILLER_SCORE_MIN_MOVES = 6;      // total match plies below this ⇒ no score, no exploit surface
const FILLER_SCORE_COOLDOWN_S = 20;    // per-user-per-game, mirrors record_arcade_score's spirit

// Bot heuristic weights — single-ply greedy argmax, matching this repo's
// house style (Poker's applyBotMove, the preview bots' agpSnakeChooseDir /
// agpTetrisPlan). Nothing here does multi-ply search.
const FB_W_GAIN = 1.00, FB_W_FRONTIER = 0.25, FB_W_DENY = 0.35, FB_JITTER = 0.60;
const FB_ENDGAME_NEUTRAL = 0.15; // below this neutral share, pure max-gain (denial stops mattering)

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

// ── Board representation ────────────────────────────────────────────────
// Stored as two fixed-length TEXT columns (cells/owners), not jsonb: cheap
// O(n) flood-fill input, cheap client-side diffing, ~1054 bytes/match on the
// wire. Decoded here into plain number arrays for the BFS.

function decodeBoard(row) {
  return {
    w: row.width,
    h: row.height,
    cells: row.cells.split("").map(Number),
    owners: row.owners.split("").map((c) => (c === "." ? -1 : Number(c))),
  };
}

function encodeBoard(board) {
  return {
    cells: board.cells.join(""),
    owners: board.owners.map((o) => (o < 0 ? "." : String(o))).join(""),
  };
}

function cloneBoard(board) {
  return { w: board.w, h: board.h, cells: board.cells.slice(), owners: board.owners.slice() };
}

function tileCounts(owners) {
  let t0 = 0, t1 = 0, neutral = 0;
  for (const o of owners) { if (o === 0) t0++; else if (o === 1) t1++; else neutral++; }
  return [t0, t1, neutral];
}

function seatColor(board, seat) {
  for (let i = 0; i < board.owners.length; i++) if (board.owners[i] === seat) return board.cells[i];
  return -1; // unreachable — each seat always owns >=1 tile from creation onward
}

// ⚠️ DIAMOND (staggered) LATTICE — not a square grid. The board is rendered as
// interlocking rhombi like the 1990 original, which is a square grid rotated
// 45° and re-indexed so the playfield stays rectangular: odd rows sit half a
// tile to the right, and rows overlap by half a tile height. A rhombus
// therefore shares a full EDGE only with the two tiles above and the two
// below — same-row left/right neighbors meet at a single point and are NOT
// connected. Getting this wrong doesn't crash anything, it just makes fills
// jump between tiles that visibly don't touch.
//
// This must stay identical to the layout in games/filler.js. It is the one
// place where the client's geometry and the server's rules have to agree, so
// SHIPPING THE FRONTEND WITHOUT REDEPLOYING THIS FUNCTION (or vice versa)
// produces a board whose fills contradict what the player sees.
function neighbors4(i, w, h) {
  const x = i % w, y = (i - x) / w;
  const d = (y & 1) ? 0 : -1; // odd rows are shifted right by half a tile
  const out = [];
  if (y > 0) {
    if (x + d >= 0) out.push(i - w + d);
    if (x + d + 1 < w) out.push(i - w + d + 1);
  }
  if (y < h - 1) {
    if (x + d >= 0) out.push(i + w + d);
    if (x + d + 1 < w) out.push(i + w + d + 1);
  }
  return out;
}

// Recolors `seat`'s whole territory to `color`, then transitively absorbs
// every 4-adjacent same-colored NEUTRAL tile (cascading through newly
// absorbed tiles' own same-colored neighbors) — one full connected blob per
// move, not a one-tile ring. Only ever absorbs owners===-1 tiles, so it can
// never "steal" the opponent's territory regardless of color. Mutates
// `board` in place; returns tiles gained.
function absorb(board, seat, color) {
  const { w, h, cells, owners } = board;
  const n = w * h;
  const seen = new Uint8Array(n);
  const queue = [];
  for (let i = 0; i < n; i++) {
    if (owners[i] === seat) { cells[i] = color; seen[i] = 1; queue.push(i); }
  }
  let gained = 0, head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    for (const j of neighbors4(i, w, h)) {
      if (seen[j]) continue;
      seen[j] = 1;
      if (owners[j] === -1 && cells[j] === color) {
        owners[j] = seat;
        gained++;
        queue.push(j);
      }
    }
  }
  return gained;
}

// Distinct neutral tiles 4-adjacent to `seat`'s territory — a cheap frontier
// size proxy the bot heuristic uses to prefer moves that open up more future
// growth, not just the biggest single grab.
function countNeutralFrontier(board, seat) {
  const { w, h, owners } = board;
  const n = w * h;
  const seen = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (owners[i] !== seat) continue;
    for (const j of neighbors4(i, w, h)) {
      if (owners[j] === -1 && !seen[j]) { seen[j] = 1; count++; }
    }
  }
  return count;
}

// Majority is derived from THIS board's own size, not a module constant —
// bot matches run a smaller board (FILLER_BOT_W/H) and historical matches may
// carry yet another size, and every one of them must be judged against its
// own half-plus-one.
function evaluateEnd(board, moveNo) {
  const majority = Math.floor((board.w * board.h) / 2) + 1;
  const [t0, t1, neutral] = tileCounts(board.owners);
  if (t0 >= majority) return { winnerSeat: 0, reason: "majority" };
  if (t1 >= majority) return { winnerSeat: 1, reason: "majority" };
  if (neutral === 0) return { winnerSeat: t0 === t1 ? null : (t0 > t1 ? 0 : 1), reason: "partitioned" };
  if (moveNo >= FILLER_MAX_MOVES) return { winnerSeat: t0 === t1 ? null : (t0 > t1 ? 0 : 1), reason: "move_cap" };
  return null;
}

function fallbackLegalColor(me, foe, colorCount) {
  for (let c = 0; c < colorCount; c++) if (c !== me && c !== foe) return c;
  return 0; // unreachable given colorCount >= 3
}

// Single-ply greedy argmax: clone the board, simulate each legal color's
// absorb, score = tilesGained + frontierGrowth - deniedOpponentGain + jitter.
// Serves the real bot AND the timeout auto-play (an idle human's turn is
// substituted with the same heuristic — see healOverdueMatch).
function chooseColor(board, seat, colorCount) {
  const me = seatColor(board, seat);
  const foe = seatColor(board, 1 - seat);
  const [, , neutral] = tileCounts(board.owners);
  const endgame = neutral / (board.w * board.h) < FB_ENDGAME_NEUTRAL;
  let best = null;
  for (let c = 0; c < colorCount; c++) {
    if (c === me || c === foe) continue;
    const mine = cloneBoard(board);
    const gain = absorb(mine, seat, c);
    let s = FB_W_GAIN * gain;
    if (!endgame) {
      s += FB_W_FRONTIER * countNeutralFrontier(mine, seat);
      const theirs = cloneBoard(board);
      const theirGain = absorb(theirs, 1 - seat, c);
      s -= FB_W_DENY * theirGain;
    }
    s += (Math.random() - 0.5) * FB_JITTER;
    if (!best || s > best.s) best = { s, c };
  }
  return best ? best.c : fallbackLegalColor(me, foe, colorCount);
}

// Seeded LCG-style PRNG (mulberry32) — the seed is stored for audit even
// though the board itself is persisted verbatim (there is no client replay
// that needs to reproduce it).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateBoard(seed, w, h, colorCount) {
  const rng = mulberry32(seed);
  const n = w * h;
  // Corners derived from this call's own w/h args, not module-level
  // constants — this function is otherwise generic over dimensions, and an
  // earlier version hard-coded FILLER_W/FILLER_H-derived corners here
  // (harmless only because every caller happened to pass those exact dims).
  const bottomLeft = (h - 1) * w;
  const topRight = w - 1;
  const cells = new Array(n);
  for (let i = 0; i < n; i++) cells[i] = Math.floor(rng() * colorCount);
  const owners = new Array(n).fill(-1);
  // Corners must start on different colors, or seat 1 would begin able to
  // legally absorb into seat 0's own starting tile's color trivially.
  while (cells[topRight] === cells[bottomLeft]) {
    cells[topRight] = Math.floor(rng() * colorCount);
  }
  // ⚠️ WHICH SEAT GETS WHICH CORNER IS RANDOM, and has to be. On the diamond
  // lattice the corners are NOT equivalent: the left column's ends have one
  // edge-neighbor where the right column's have two, so a fixed assignment
  // hands seat 0 a measurable disadvantage — scripts/filler-balance.mjs put
  // it at 43-45% over 1500 bot-vs-bot matches (and every alternative pair of
  // near-corners was skewed too, just in one direction or the other).
  // Alternating the assignment restores 49-51%. This is the same principle
  // as activateMatch randomizing the first mover: fairness comes from
  // randomizing an unavoidable asymmetry, not from pretending it isn't there.
  const flip = rng() < 0.5;
  owners[flip ? topRight : bottomLeft] = 0;
  owners[flip ? bottomLeft : topRight] = 1;
  return { w, h, cells, owners };
}

// ── Score formula (PvP only) ─────────────────────────────────────────────
function fillerScore({ tilesShare, won, movesMade }) {
  const base = Math.round(120 * tilesShare);
  const win = won ? 80 : 0;
  const dom = won ? Math.round(60 * Math.max(0, Math.min(1, (tilesShare - 0.5) * 2))) : 0;
  const eff = won ? Math.round(40 * Math.max(0, Math.min(1, (FILLER_MOVES_PAR - movesMade) / FILLER_MOVES_PAR))) : 0;
  return Math.max(0, Math.min(FILLER_SCORE_CAP, base + win + dom + eff));
}

function pickBotNick() {
  return FILLER_BOT_NICKS[Math.floor(Math.random() * FILLER_BOT_NICKS.length)];
}

// ── Locking helpers ──────────────────────────────────────────────────────
// Fixed order, never violated: (1) the caller's profile row, (2) the match
// row, (3) that match's player rows, (4) arcade_scores insert last. See
// docs/filler.md for the full race analysis this resolves.

async function lockProfile(tx, userId) {
  const rows = await tx`select id, nick from public.profiles where id = ${userId} for no key update`;
  if (!rows[0]) throw gameError("Profil nie istnieje.");
  return rows[0];
}

// The caller's own currently-open (waiting or active) match, if any — the
// `active` flag on filler_match_players (kept true by the DB trigger until
// the match finishes/cancels) is what makes "does this user already have an
// open match" a single indexed lookup rather than a slow OR'd scan.
async function loadLiveMatchOf(tx, userId) {
  const rows = await tx`
    select m.* from public.filler_matches m
    join public.filler_match_players p on p.match_id = m.id
    where p.user_id = ${userId} and p.active
    order by m.created_at desc
    limit 1
    for update of m`;
  return rows[0] || null;
}

// `mode` picks the board size: a bot practice match gets the smaller, faster
// FILLER_BOT_W/H board. Note this is keyed on the REQUESTED mode, so a queued
// pvp match that later falls back to a bot keeps the full board — it was
// created before anyone knew a human wouldn't show up, and re-generating a
// board mid-queue would be a worse trade than a slightly longer bot game.
async function createMatch(tx, { mode, arcadeMode }) {
  const w = mode === "bot" ? FILLER_BOT_W : FILLER_W;
  const h = mode === "bot" ? FILLER_BOT_H : FILLER_H;
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const board = generateBoard(seed, w, h, FILLER_COLORS);
  const enc = encodeBoard(board);
  const [match] = await tx`
    insert into public.filler_matches
      (mode, arcade_mode, width, height, color_count, seed, cells, owners)
    values
      (${mode}, ${arcadeMode}, ${w}, ${h}, ${FILLER_COLORS}, ${seed}, ${enc.cells}, ${enc.owners})
    returning *`;
  return match;
}

async function insertHumanSeat(tx, match, seat, userId, nick) {
  const board = decodeBoard(match);
  const color = seatColor(board, seat);
  await tx`
    insert into public.filler_match_players (match_id, seat, user_id, nick_snapshot, color, tiles)
    values (${match.id}, ${seat}, ${userId}, ${String(nick || "Gracz")}, ${color}, 1)`;
}

async function insertBotSeat(tx, match, seat) {
  const board = decodeBoard(match);
  const color = seatColor(board, seat);
  const nick = pickBotNick();
  await tx`
    insert into public.filler_match_players (match_id, seat, is_bot, bot_nick, nick_snapshot, color, tiles)
    values (${match.id}, ${seat}, true, ${nick}, ${nick}, ${color}, 1)`;
}

// Flips a 'waiting' match to 'active': randomizes who moves first (fairness
// comes from randomizing the first mover, not from a mirrored board), sets
// the turn deadline. Does NOT play an opening bot move itself — the caller
// is expected to follow up with advanceAfterMove().
async function activateMatch(tx, match, opponentKind) {
  const startSeat = crypto.getRandomValues(new Uint8Array(1))[0] % 2;
  await tx`
    update public.filler_matches
    set status = 'active', opponent_kind = ${opponentKind}, current_seat = ${startSeat},
        turn_deadline = now() + (${FILLER_TURN_MS} * interval '1 millisecond'),
        started_at = now(), queue_expires_at = null, updated_at = now()
    where id = ${match.id}`;
}

// The one function that applies a single ply and everything that follows
// from it (tile/move counters, win check, turn flip or match finish). Used
// identically by a human's own pick_color, the inline bot reply, and the
// timeout auto-play — `auto` only controls the idle-detection `timeouts`
// counter (which the abandon rule reads), never the game rules themselves.
async function applyMove(tx, match, players, actor, color, { auto }) {
  const board = decodeBoard(match);
  const gain = absorb(board, actor.seat, color);
  const enc = encodeBoard(board);
  const newMoveNo = match.move_no + 1;
  const newMoves = match.moves + String(color);
  const [t0, t1] = tileCounts(board.owners);
  const otherPlayer = players.find((p) => p.seat !== actor.seat);
  const tilesForActor = actor.seat === 0 ? t0 : t1;
  const tilesForOther = actor.seat === 0 ? t1 : t0;
  const newTimeouts = auto ? actor.timeouts + 1 : 0;

  await tx`
    update public.filler_match_players
    set timeouts = ${newTimeouts}, moves_made = moves_made + 1,
        tiles = ${tilesForActor}, color = ${color}, updated_at = now()
    where id = ${actor.id}`;
  await tx`
    update public.filler_match_players
    set tiles = ${tilesForOther}, updated_at = now()
    where id = ${otherPlayer.id}`;

  const end = evaluateEnd(board, newMoveNo);

  if (end) {
    await tx`
      update public.filler_matches
      set cells = ${enc.cells}, owners = ${enc.owners}, move_no = ${newMoveNo}, moves = ${newMoves},
          last_seat = ${actor.seat}, last_color = ${color}, last_gain = ${gain},
          status = 'finished', winner_seat = ${end.winnerSeat}, end_reason = ${end.reason},
          current_seat = null, turn_deadline = null, finished_at = now(), updated_at = now()
      where id = ${match.id}`;
    const finishedMatch = { ...match, winner_seat: end.winnerSeat, end_reason: end.reason, move_no: newMoveNo };
    const updatedPlayers = await tx`select * from public.filler_match_players where match_id = ${match.id} order by seat`;
    await finishScoring(tx, finishedMatch, updatedPlayers);
    return true;
  }

  const nextSeat = 1 - actor.seat;
  await tx`
    update public.filler_matches
    set cells = ${enc.cells}, owners = ${enc.owners}, move_no = ${newMoveNo}, moves = ${newMoves},
        last_seat = ${actor.seat}, last_color = ${color}, last_gain = ${gain},
        current_seat = ${nextSeat}, turn_deadline = now() + (${FILLER_TURN_MS} * interval '1 millisecond'),
        updated_at = now()
    where id = ${match.id}`;
  return false;
}

// If the current actor is a bot, keep applying its moves in the same
// request until a human needs to act or the match ends (Poker's advanceGame
// inline bot-turn pattern) — a human never waits on a cron/poll for a bot's
// reply. A bot's own ordinary turn is never a "timeout" (auto:false).
async function advanceAfterMove(tx, matchId) {
  let loops = 0;
  while (loops++ < FILLER_INLINE_BOT_MAX) {
    const [match] = await tx`select * from public.filler_matches where id = ${matchId} for update`;
    if (!match || match.status !== "active") return;
    const players = await tx`select * from public.filler_match_players where match_id = ${matchId} order by seat for update`;
    const actor = players.find((p) => p.seat === match.current_seat);
    if (!actor || !actor.is_bot) return;
    const board = decodeBoard(match);
    const color = chooseColor(board, actor.seat, match.color_count);
    await applyMove(tx, match, players, actor, color, { auto: false });
  }
}

// ── Anti-farming scoring (PvP only) ──────────────────────────────────────
// Bot matches NEVER reach this at all (finishScoring's opponent_kind guard).
// This is the actual fix for a real hole: filler-action bypasses
// record_arcade_score (and therefore its 5s-per-user-per-game throttle) on
// purpose, and arcade_leaderboard keeps only the best score EVER per user —
// so if a free, risk-free, unlimited-attempts bot win scored anything at
// all, a script could grind it for free until it rolled high. Scaling the
// bot-mode score down doesn't close that; only excluding it does.

async function scoreOnePlayer(tx, match, player, allPlayers, won, totalMoveNo) {
  if (player.is_bot || !player.user_id) return;
  if (totalMoveNo < FILLER_SCORE_MIN_MOVES) return; // implausibly short — no score, no exploit surface
  const total = match.width * match.height;
  const share = player.tiles / total;
  const score = fillerScore({ tilesShare: share, won, movesMade: player.moves_made });
  const opponent = allPlayers.find((p) => p.id !== player.id);
  try {
    // Non-fatal on purpose, via a SAVEPOINT: a scoring failure here must
    // never roll back the match-finish transaction, or the finish keeps
    // re-throwing on retry and — combined with the one-open-match
    // constraint — permanently locks both players out. Losing a
    // leaderboard row is recoverable; a bricked match is not.
    await tx.savepoint(async (sp) => {
      const [lastRow] = await sp`
        select max(created_at) as last_at from public.arcade_scores
        where user_id = ${player.user_id} and game_type = 'filler'`;
      const lastAt = lastRow?.last_at ? new Date(lastRow.last_at).getTime() : 0;
      if (Date.now() - lastAt < FILLER_SCORE_COOLDOWN_S * 1000) return; // mirrors record_arcade_score's spirit
      const meta = {
        opp: opponent?.user_id ?? null, // the opponent's user_id (not just nick) for two-account-collusion audits
        won,
        share: Math.round(share * 100),
        moves: player.moves_made,
      };
      await sp`
        insert into public.arcade_scores (user_id, game_type, score, coins_paid, client_meta)
        values (${player.user_id}, 'filler', ${score}, 0, ${JSON.stringify(meta)}::jsonb)`;
      await sp`update public.filler_match_players set score = ${score}, updated_at = now() where id = ${player.id}`;
    });
  } catch (err) {
    console.warn("filler arcade_scores insert failed (non-fatal):", err?.message ?? err);
  }

  // Phase 2 (seasonal promotion, dormant until the 2026-08-10 debut — see
  // supabase/filler-seasonal.sql + docs/filler.md). `match.arcade_mode` is
  // decided once at match-creation time from which panel launched it (the
  // arcade picker vs the seasonal tab), never re-derived from anything in
  // this request — it only routes WHICH TABLE receives a copy of this
  // already-fully-server-computed score, it never changes the score value
  // itself or bypasses any of the guards above, so trusting the client's
  // launch context here (mirroring healer-dungeon's archiveMode) carries no
  // scoring exploit. In Phase 1 arcade_mode is always true, so this branch
  // never runs yet; wrapped in its own savepoint so a missing filler_scores
  // table/function before Phase 2 ships can never break match-finish.
  if (!match.arcade_mode) {
    try {
      await tx.savepoint(async (sp) => {
        const meta = { opp: opponent?.user_id ?? null, moves: player.moves_made };
        await sp`
          insert into public.filler_scores
            (match_id, user_id, nick_snapshot, week_start, score, tiles, moves_made, won, client_meta)
          values
            (${match.id}, ${player.user_id}, ${player.nick_snapshot}, public.filler_week_start(now()),
             ${score}, ${player.tiles}, ${player.moves_made}, ${won}, ${JSON.stringify(meta)}::jsonb)
          on conflict (match_id, user_id) do nothing`;
      });
    } catch (err) {
      console.warn("filler_scores insert failed (non-fatal):", err?.message ?? err);
    }
  }
}

async function finishScoring(tx, match, players) {
  if (match.opponent_kind !== "human") return; // bot matches never score, win or lose
  for (const p of players) {
    const won = match.winner_seat === p.seat;
    await scoreOnePlayer(tx, match, p, players, won, match.move_no);
  }
}

// ── Self-healing sweep ───────────────────────────────────────────────────
// Scans GLOBALLY (any user's action heals other users' stuck matches too),
// bounded so it stays cheap.
//
// Runs on `state` and the two matchmaking actions, but deliberately NOT on
// `pick_color`/`resign`: bounded-but-cheap is still up to FILLER_SWEEP_LIMIT
// stale matches × FILLER_CATCHUP_MAX plies of somebody else's game replayed
// inline, and on the move path that latency lands squarely between a player's
// click and their own board updating. Coverage is unaffected — every mounted
// client polls `state` every ~2s, so the sweep still runs constantly whenever
// anyone has Filler open, and filler_sweep_abandoned is the cron backstop for
// when nobody does.

async function fillWithBot(tx, matchId) {
  const [match] = await tx`select * from public.filler_matches where id = ${matchId} and status = 'waiting' for update`;
  if (!match) return; // already handled by a racing sweep/action
  const players = await tx`select * from public.filler_match_players where match_id = ${match.id} for update`;
  if (players.length !== 1) return; // shouldn't happen — don't corrupt state on a surprise shape
  await insertBotSeat(tx, match, 1);
  await activateMatch(tx, match, "bot");
  await advanceAfterMove(tx, match.id);
}

async function healOverdueMatch(tx, matchId) {
  let loops = 0;
  while (loops++ < FILLER_CATCHUP_MAX) {
    const [match] = await tx`select * from public.filler_matches where id = ${matchId} and status = 'active' for update`;
    if (!match) return;
    if (!match.turn_deadline) return;
    if (new Date(match.turn_deadline).getTime() + FILLER_TURN_GRACE_MS > Date.now()) return; // caught up
    const players = await tx`select * from public.filler_match_players where match_id = ${matchId} order by seat for update`;
    const actor = players.find((p) => p.seat === match.current_seat);
    if (!actor) return;

    // Abandon rule: a human stuck vs a BOT (nobody real is waiting on this
    // result) who has gone unresponsive for several consecutive turns —
    // cancel, no score for anyone, rather than grinding a phantom match.
    if (!actor.is_bot && match.opponent_kind === "bot" && actor.timeouts >= FILLER_ABANDON_TIMEOUTS) {
      await tx`
        update public.filler_matches
        set status = 'cancelled', end_reason = 'abandoned', current_seat = null, turn_deadline = null,
            finished_at = now(), updated_at = now()
        where id = ${matchId}`;
      return;
    }

    const board = decodeBoard(match);
    const color = chooseColor(board, actor.seat, match.color_count);
    await applyMove(tx, match, players, actor, color, { auto: true });
    // In a genuine PvP match this just runs the game out to a real
    // conclusion for the present player — no forfeiture logic needed.
  }
}

async function sweepGlobal(tx) {
  const stale = await tx`
    select id from public.filler_matches
    where status = 'waiting' and queue_expires_at <= now()
    order by id
    limit ${FILLER_SWEEP_LIMIT}
    for update skip locked`;
  for (const row of stale) await fillWithBot(tx, row.id);

  const overdue = await tx`
    select id from public.filler_matches
    where status = 'active' and turn_deadline is not null
      and turn_deadline + (${FILLER_TURN_GRACE_MS} * interval '1 millisecond') <= now()
    order by id
    limit ${FILLER_SWEEP_LIMIT}
    for update skip locked`;
  for (const row of overdue) await healOverdueMatch(tx, row.id);
}

// ── Snapshot builders ────────────────────────────────────────────────────

function buildMatchOut(match, players, userId) {
  const me = players.find((p) => p.user_id === userId);
  const opponent = players.find((p) => p.id !== me?.id);
  const legalColors = [];
  if (me && opponent) {
    for (let c = 0; c < match.color_count; c++) {
      if (c !== me.color && c !== opponent.color) legalColors.push(c);
    }
  }
  return {
    id: match.id,
    status: match.status,
    mode: match.mode,
    opponentKind: match.opponent_kind,
    width: match.width,
    height: match.height,
    colorCount: match.color_count,
    cells: match.cells,
    owners: match.owners,
    moveNo: match.move_no,
    mySeat: me ? me.seat : null,
    isMyTurn: match.status === "active" && !!me && match.current_seat === me.seat,
    currentSeat: match.current_seat,
    turnDeadline: match.turn_deadline,
    queueExpiresAt: match.queue_expires_at,
    legalColors,
    lastMove: match.last_seat != null ? { seat: match.last_seat, color: match.last_color, gain: match.last_gain } : null,
    winnerSeat: match.winner_seat,
    endReason: match.end_reason,
    players: players.map((p) => ({
      seat: p.seat,
      isBot: p.is_bot,
      nick: p.is_bot ? p.bot_nick : p.nick_snapshot,
      color: p.color,
      tiles: p.tiles,
      movesMade: p.moves_made,
      score: p.score,
      isMe: p.user_id === userId,
    })),
  };
}

async function stateResponse(tx, userId) {
  const [profile] = await tx`select coins, nick from public.profiles where id = ${userId}`;
  const liveRows = await tx`
    select m.* from public.filler_matches m
    join public.filler_match_players p on p.match_id = m.id
    where p.user_id = ${userId} and p.active
    order by m.created_at desc
    limit 1`;
  const match = liveRows[0] || null;
  let matchOut = null;
  if (match) {
    const players = await tx`select * from public.filler_match_players where match_id = ${match.id} order by seat`;
    matchOut = buildMatchOut(match, players, userId);
  }
  const history = await tx`
    select m.id, m.opponent_kind, m.end_reason, m.winner_seat, m.finished_at,
           p.seat, p.tiles, p.score
    from public.filler_matches m
    join public.filler_match_players p on p.match_id = m.id and p.user_id = ${userId}
    where m.status = 'finished'
    order by m.finished_at desc
    limit 10`;
  return {
    coins: profile?.coins ?? 0,
    nick: profile?.nick ?? "",
    match: matchOut,
    history: history.map((h) => ({
      id: h.id,
      opponentKind: h.opponent_kind,
      endReason: h.end_reason,
      won: h.winner_seat === h.seat,
      tiles: Number(h.tiles),
      score: h.score != null ? Number(h.score) : null,
      finishedAt: h.finished_at,
    })),
  };
}

// ── Actions ──────────────────────────────────────────────────────────────

async function getState(userId) {
  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    await sweepGlobal(tx);
    return await stateResponse(tx, userId);
  });
}

// Instant vs-bot. If the caller already has a live WAITING match, converts
// it (fills seat 1 with a bot) instead of erroring "already have an open
// match" — no dead end. A live ACTIVE match is just returned as-is.
// `arcadeMode` (default true) reflects which panel launched the match — the
// arcade picker (Phase 1, always) or the seasonal tab (Phase 2, once its
// SEASONAL_ROTATION entry goes live) — see the note in scoreOnePlayer for
// why trusting this from the client carries no scoring exploit.
async function playBot(userId, arcadeMode) {
  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    const me = await lockProfile(tx, userId);
    await sweepGlobal(tx);
    const live = await loadLiveMatchOf(tx, userId);
    if (live) {
      if (live.status === "waiting") {
        await insertBotSeat(tx, live, 1);
        await activateMatch(tx, live, "bot");
        await advanceAfterMove(tx, live.id);
      }
      return await stateResponse(tx, userId);
    }
    const match = await createMatch(tx, { mode: "bot", arcadeMode });
    await insertHumanSeat(tx, match, 0, userId, me.nick);
    await insertBotSeat(tx, match, 1);
    await activateMatch(tx, match, "bot");
    await advanceAfterMove(tx, match.id);
    return await stateResponse(tx, userId);
  });
}

// Public queue + bot fallback. Short-circuits to the caller's existing live
// match if any — this is what makes "no self-join" airtight, since a user
// with zero live matches can never encounter their own row in the scan.
async function findOpponent(userId, arcadeMode) {
  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    const me = await lockProfile(tx, userId);
    await sweepGlobal(tx);
    const live = await loadLiveMatchOf(tx, userId);
    if (live) return await stateResponse(tx, userId); // idempotent: double-click / second tab

    const [open] = await tx`
      select * from public.filler_matches
      where status = 'waiting'
      order by created_at asc
      limit 1
      for update skip locked`;

    if (open) {
      await insertHumanSeat(tx, open, 1, userId, me.nick);
      await activateMatch(tx, open, "human");
      await advanceAfterMove(tx, open.id); // no-op here (both seats human), kept for uniformity
    } else {
      const match = await createMatch(tx, { mode: "pvp", arcadeMode });
      await insertHumanSeat(tx, match, 0, userId, me.nick);
      await tx`
        update public.filler_matches
        set queue_expires_at = now() + (${FILLER_QUEUE_MS} * interval '1 millisecond')
        where id = ${match.id}`;
    }
    return await stateResponse(tx, userId);
  });
}

async function cancelQueue(userId) {
  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    await lockProfile(tx, userId);
    const live = await loadLiveMatchOf(tx, userId);
    if (live && live.status === "waiting") {
      await tx`
        update public.filler_matches
        set status = 'cancelled', end_reason = 'cancelled', finished_at = now(), updated_at = now()
        where id = ${live.id}`;
    }
    return await stateResponse(tx, userId);
  });
}

async function pickColor(userId, body) {
  const matchId = String(body?.matchId ?? "");
  const rawColor = body?.color;
  const rawMoveNo = body?.moveNo;
  if (!matchId) throw gameError("Brak identyfikatora meczu.");

  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    await lockProfile(tx, userId);
    // No sweepGlobal here — this is the latency-critical move path (see the
    // sweep's own comment). Nothing below depends on it: the match row is
    // re-read under lock and re-validated on every field that matters.
    const [match] = await tx`select * from public.filler_matches where id = ${matchId} for update`;
    if (!match) throw gameError("Mecz nie istnieje.");
    const players = await tx`select * from public.filler_match_players where match_id = ${matchId} order by seat for update`;
    const me = players.find((p) => p.user_id === userId);
    if (!me) throw gameError("Nie grasz w tym meczu.");

    if (match.status !== "active") return await stateResponse(tx, userId); // match already ended — silent no-op
    if (match.move_no !== Number(rawMoveNo)) return await stateResponse(tx, userId); // stale/double-click — silent no-op
    if (match.current_seat !== me.seat) throw gameError("Teraz nie Twoja kolej.");

    const color = Math.trunc(Number(rawColor));
    if (!Number.isInteger(color) || color < 0 || color >= match.color_count) throw gameError("Nieprawidłowy kolor.");
    const opponent = players.find((p) => p.seat !== me.seat);
    if (color === me.color || color === opponent.color) {
      throw gameError("Nie można wybrać własnego ani przeciwnika koloru.");
    }

    await applyMove(tx, match, players, me, color, { auto: false });
    await advanceAfterMove(tx, matchId);
    return await stateResponse(tx, userId);
  });
}

async function resign(userId, body) {
  const matchId = String(body?.matchId ?? "");
  if (!matchId) throw gameError("Brak identyfikatora meczu.");

  return await db.begin(async (tx) => {
    await tx`set local lock_timeout = '4s'`;
    await lockProfile(tx, userId);
    // No sweepGlobal — same reasoning as pick_color.
    const [match] = await tx`select * from public.filler_matches where id = ${matchId} for update`;
    if (!match || match.status !== "active") throw gameError("Ten mecz już się zakończył.");
    const players = await tx`select * from public.filler_match_players where match_id = ${matchId} order by seat for update`;
    const me = players.find((p) => p.user_id === userId);
    if (!me) throw gameError("Nie grasz w tym meczu.");
    const winnerSeat = 1 - me.seat;

    await tx`
      update public.filler_matches
      set status = 'finished', winner_seat = ${winnerSeat}, end_reason = 'resigned',
          current_seat = null, turn_deadline = null, finished_at = now(), updated_at = now()
      where id = ${matchId}`;

    // Only the opponent scores — the resigner gets no row at all (mirrors a
    // bot-match loss, and closes a "resign instantly, farm cheap attempts"
    // angle a scored-loss-on-resign would otherwise open).
    if (match.opponent_kind === "human") {
      const opponent = players.find((p) => p.seat === winnerSeat);
      if (opponent && !opponent.is_bot) {
        await scoreOnePlayer(tx, match, opponent, players, true, match.move_no);
      }
    }
    return await stateResponse(tx, userId);
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "state");

    const arcadeMode = typeof body.arcadeMode === "boolean" ? body.arcadeMode : true;

    let result;
    if (action === "state" || action === "history") result = await getState(user.id);
    else if (action === "play_bot") result = await playBot(user.id, arcadeMode);
    else if (action === "find_opponent") result = await findOpponent(user.id, arcadeMode);
    else if (action === "cancel_queue") result = await cancelQueue(user.id);
    else if (action === "pick_color") result = await pickColor(user.id, body);
    else if (action === "resign") result = await resign(user.id, body);
    else throw gameError("Nieznana akcja.");

    return json(req, { ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json(req, { ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
