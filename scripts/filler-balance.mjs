// Filler balance harness — bot-vs-bot simulation used to PICK new tuning
// constants for the 2026-08 board resize (13x11x6 → 31x17x7), NOT a parity
// contract: there is no scripts/filler-parity.mjs for this game (see
// docs/filler.md — zero client sim, nothing to keep byte-identical with), so
// this file is not re-run in CI and does not need to track the Edge Function
// forever. The sim helpers below are transcribed by hand from
// supabase/functions/filler-action/index.ts as of the 2026-08-02 resize;
// re-transcribe them here if you want to re-tune again later.
//
// Run: node scripts/filler-balance.mjs

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function neighbors4(i, w, h) {
  const x = i % w, y = (i - x) / w;
  const out = [];
  if (x > 0) out.push(i - 1);
  if (x < w - 1) out.push(i + 1);
  if (y > 0) out.push(i - w);
  if (y < h - 1) out.push(i + w);
  return out;
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
  return -1;
}

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

// NOTE: takes majority/maxMoves as params (the real evaluateEnd reads module-
// level consts) so this harness can sweep candidate values without editing.
function evaluateEnd(board, moveNo, majority, maxMoves) {
  const [t0, t1, neutral] = tileCounts(board.owners);
  if (t0 >= majority) return { winnerSeat: 0, reason: "majority" };
  if (t1 >= majority) return { winnerSeat: 1, reason: "majority" };
  if (neutral === 0) return { winnerSeat: t0 === t1 ? null : (t0 > t1 ? 0 : 1), reason: "partitioned" };
  if (moveNo >= maxMoves) return { winnerSeat: t0 === t1 ? null : (t0 > t1 ? 0 : 1), reason: "move_cap" };
  return null;
}

function fallbackLegalColor(me, foe, colorCount) {
  for (let c = 0; c < colorCount; c++) if (c !== me && c !== foe) return c;
  return 0;
}

const FB_W_GAIN = 1.00, FB_W_FRONTIER = 0.25, FB_W_DENY = 0.35, FB_JITTER = 0.60;
const FB_ENDGAME_NEUTRAL = 0.15;

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

// FIXED version (the real generateBoard has a latent bug where the corner
// indices come from module-level FILLER_CORNER_A/B rather than its own w/h
// args — harmless today since it's only ever called with the module
// constants, but this resize is also fixing it — see the plan). Corners:
// bottom-left = seat 0, top-right = seat 1.
function generateBoard(seed, w, h, colorCount) {
  const rng = mulberry32(seed);
  const n = w * h;
  const cornerA = (h - 1) * w; // bottom-left
  const cornerB = w - 1;       // top-right
  const cells = new Array(n);
  for (let i = 0; i < n; i++) cells[i] = Math.floor(rng() * colorCount);
  const owners = new Array(n).fill(-1);
  while (cells[cornerB] === cells[cornerA]) {
    cells[cornerB] = Math.floor(rng() * colorCount);
  }
  owners[cornerA] = 0;
  owners[cornerB] = 1;
  return { w, h, cells, owners };
}

function fillerScore({ tilesShare, won, movesMade, scoreCap, movesPar }) {
  const base = Math.round(120 * tilesShare);
  const win = won ? 80 : 0;
  const dom = won ? Math.round(60 * Math.max(0, Math.min(1, (tilesShare - 0.5) * 2))) : 0;
  const eff = won ? Math.round(40 * Math.max(0, Math.min(1, (movesPar - movesMade) / movesPar))) : 0;
  return Math.max(0, Math.min(scoreCap, base + win + dom + eff));
}

// ── Percentile helper ────────────────────────────────────────────────────
function pct(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
function stats(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return {
    median: pct(s, 0.5), p90: pct(s, 0.9), p99: pct(s, 0.99), max: s[s.length - 1],
  };
}

// ── Play one full bot-vs-bot match ───────────────────────────────────────
function playMatch(w, h, colorCount, majority, maxMoves) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  const board = generateBoard(seed, w, h, colorCount);
  let moveNo = 0;
  const movesMade = [0, 0];
  let currentSeat = Math.random() < 0.5 ? 0 : 1; // activateMatch randomizes the first mover
  let end = evaluateEnd(board, moveNo, majority, maxMoves);
  while (!end) {
    const color = chooseColor(board, currentSeat, colorCount);
    absorb(board, currentSeat, color);
    moveNo++;
    movesMade[currentSeat]++;
    end = evaluateEnd(board, moveNo, majority, maxMoves);
    currentSeat = 1 - currentSeat;
  }
  const [t0, t1] = tileCounts(board.owners);
  const tiles = [t0, t1];
  return { totalPlies: moveNo, movesMade, tiles, winnerSeat: end.winnerSeat, reason: end.reason };
}

// ── Config: the new board ────────────────────────────────────────────────
const W = 31, H = 17, COLORS = 7;
const N = W * H;
const MAJORITY = Math.floor(N / 2) + 1;
const N_MATCHES = 2000;
const UNBOUNDED_CAP = 5000; // large enough to observe natural game length

console.log(`Filler balance harness — ${W}x${H} = ${N} tiles, ${COLORS} colors, majority = ${MAJORITY}`);
console.log(`Simulating ${N_MATCHES} bot-vs-bot matches (uncapped, max_moves=${UNBOUNDED_CAP})...\n`);

// ── Phase 1: observe the natural distribution (effectively uncapped) ────
const totalPlies = [], winnerMoves = [], winnerShare = [];
let reasonCounts = {};
for (let i = 0; i < N_MATCHES; i++) {
  const m = playMatch(W, H, COLORS, MAJORITY, UNBOUNDED_CAP);
  totalPlies.push(m.totalPlies);
  reasonCounts[m.reason] = (reasonCounts[m.reason] || 0) + 1;
  if (m.winnerSeat !== null) {
    winnerMoves.push(m.movesMade[m.winnerSeat]);
    winnerShare.push(m.tiles[m.winnerSeat] / N);
  }
}

const plyStats = stats(totalPlies);
const moveStats = stats(winnerMoves);
const shareStats = stats(winnerShare);

console.log("End reasons:", reasonCounts);
console.log("Total plies per match — median: %d, p90: %d, p99: %d, max: %d", plyStats.median, plyStats.p90, plyStats.p99, plyStats.max);
console.log("Winner's own moves_made — median: %d, p90: %d, p99: %d, max: %d", moveStats.median, moveStats.p90, moveStats.p99, moveStats.max);
console.log("Winner's final tile share — median: %s, p90: %s, max: %s\n", shareStats.median.toFixed(3), shareStats.p90.toFixed(3), shareStats.max.toFixed(3));

// ── Derive the two tuned constants ───────────────────────────────────────
const suggestedMaxMoves = Math.ceil((plyStats.p99 * 1.3) / 10) * 10;
const suggestedMovesPar = Math.round(moveStats.median * 1.15);

console.log(`Suggested FILLER_MAX_MOVES = ${suggestedMaxMoves}  (today's 200 is ~5.7x the ~35-typical match)`);
console.log(`Suggested FILLER_MOVES_PAR = ${suggestedMovesPar}  (today's 20 vs ~17-18 typical)\n`);

// ── Phase 2: re-run with the CHOSEN cap, confirm it never binds, and print
// the resulting fillerScore distribution for both winners and losers ─────
console.log(`Re-simulating ${N_MATCHES} matches with FILLER_MAX_MOVES=${suggestedMaxMoves} to confirm it never binds...\n`);
const winnerScores = [], loserScores = [];
let capHits = 0;
for (let i = 0; i < N_MATCHES; i++) {
  const m = playMatch(W, H, COLORS, MAJORITY, suggestedMaxMoves);
  if (m.reason === "move_cap") capHits++;
  if (m.winnerSeat === null) continue; // structurally shouldn't happen (N is odd), but guard anyway
  const loserSeat = 1 - m.winnerSeat;
  winnerScores.push(fillerScore({
    tilesShare: m.tiles[m.winnerSeat] / N, won: true,
    movesMade: m.movesMade[m.winnerSeat], scoreCap: 350, movesPar: suggestedMovesPar,
  }));
  loserScores.push(fillerScore({
    tilesShare: m.tiles[loserSeat] / N, won: false,
    movesMade: m.movesMade[loserSeat], scoreCap: 350, movesPar: suggestedMovesPar,
  }));
}
const winScoreStats = stats(winnerScores);
const loseScoreStats = stats(loserScores);

console.log(`Matches that hit the move cap: ${capHits}/${N_MATCHES} (expect 0)`);
console.log("Winner score — median: %d, p90: %d, max: %d", winScoreStats.median, winScoreStats.p90, winScoreStats.max);
console.log("Loser score  — median: %d, p90: %d, max: %d", loseScoreStats.median, loseScoreStats.p90, loseScoreStats.max);
console.log(`\nDoc calibration line should read roughly:`);
console.log(`"a close loss ≈ ${Math.round(loseScoreStats.median * 0.6)}-${loseScoreStats.p90} pts, a solid PvP win ≈ ${winScoreStats.median}-${winScoreStats.p90}, a fast decisive blowout approaches the 350 cap."`);
