// Balance + invariant harness for „Saper Maraton" (saper).
//
// Not a parity contract — scripts/saper-parity.mjs owns that. This drives the
// REAL simulation (extracted from the fenced PARITY BLOCK in games/saper.js, so
// it can never test a stale copy) to check the things the design promises and
// to re-derive the numbers quoted in supabase/arcade.sql and the panel copy.
//
// Run: node scripts/saper-balance.mjs [seeds]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'games', 'saper.js'), 'utf8');
const START = '// ── PARITY BLOCK START';
const END = '// ── PARITY BLOCK END';
const block = src.slice(src.indexOf('\n', src.indexOf(START)) + 1, src.indexOf(END));
const sim = new Function(`${block}
  return { SP_TICK_MS, SP_ROUND_TICKS, SP_MINE_PENALTY_TICKS, SP_MAX_SCORE, SP_LADDER,
           SP_OPEN, SP_FLAG, SP_CHORD, SP_CLEAR_BASE, SP_CLEAR_PER_RUNG,
           SP_SPEED_BONUS_MAX, SP_STREAK_STEP, SP_STREAK_CAP,
           spInitState, spTick, spApplyMove, spNeighbors, spRung };`)();

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
}

// ── the player ───────────────────────────────────────────────────────────────
// Trivial deductions, then pairwise subset rules (1-2-1 and friends), then the
// lowest-probability guess. Roughly a competent office player, not a solver.
function chooseMove(b) {
  const n = b.w * b.h;
  const cons = [];
  for (let c = 0; c < n; c += 1) {
    if (!b.open[c] || b.adj[c] <= 0) continue;
    let flags = 0;
    const hidden = [];
    for (const nb of sim.spNeighbors(b, c)) {
      if (b.flag[nb]) flags += 1;
      else if (!b.open[nb]) hidden.push(nb);
    }
    if (hidden.length) cons.push({ cell: c, need: b.adj[c] - flags, hidden });
  }
  for (const k of cons) {
    if (k.need === 0) return [sim.SP_CHORD, k.cell];
    if (k.need === k.hidden.length) return [sim.SP_FLAG, k.hidden[0]];
  }
  for (const A of cons) for (const B of cons) {
    if (A === B || !A.hidden.every(h => B.hidden.includes(h))) continue;
    const diff = B.hidden.filter(h => !A.hidden.includes(h));
    if (!diff.length) continue;
    if (B.need - A.need === 0) return [sim.SP_OPEN, diff[0]];
    if (B.need - A.need === diff.length) return [sim.SP_FLAG, diff[0]];
  }
  const hidden = [];
  for (let c = 0; c < n; c += 1) if (!b.open[c] && !b.flag[c]) hidden.push(c);
  if (!hidden.length) return null;
  const bg = (b.m - b.flags) / hidden.length;
  const prob = new Map();
  for (const k of cons) for (const h of k.hidden) {
    const v = k.need / k.hidden.length;
    if (!prob.has(h) || v > prob.get(h)) prob.set(h, v);
  }
  let best = hidden[0], bestP = Infinity;
  for (const h of hidden) {
    const v = prob.has(h) ? prob.get(h) : bg;
    if (v < bestP) { bestP = v; best = h; }
  }
  return [sim.SP_OPEN, best];
}

function play(seed, msPerMove, watch) {
  const st = sim.spInitState(seed);
  const tpm = Math.max(1, Math.round(msPerMove / sim.SP_TICK_MS));
  let guard = 0;
  while (!st.over && guard++ < 40000) {
    for (let i = 0; i < tpm && !st.over; i += 1) sim.spTick(st);
    if (st.over) break;
    const b = st.board;
    const first = !b.placed;
    const act = first
      ? [sim.SP_OPEN, Math.floor(b.h / 2) * b.w + Math.floor(b.w / 2)]
      : chooseMove(b);
    if (!act) { while (!st.over) sim.spTick(st); break; }
    if (!sim.spApplyMove(st, act[0], act[1])) return { st, illegal: act };
    if (first && watch) watch(b, act[1]);
  }
  return { st };
}

const N = Number(process.argv[2] || 400);
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

console.log('\n── ladder ───────────────────────────────────────────────────────');
let ladderOk = true;
let fallbackReachable = false;
sim.SP_LADDER.forEach((r, i) => {
  const cells = r.w * r.h;
  // Mines are placed outside the 3×3 around the first click. Worst case that
  // 3×3 is fully on the board, so `cells - 9` candidates must hold every mine —
  // otherwise spPlaceMines silently drops to its single-cell fallback and the
  // "first click is always safe" promise weakens to "never fatal".
  if (cells - 9 < r.m) { fallbackReachable = true; ladderOk = false; }
  console.log(`  rung ${i}: ${r.w}×${r.h}, ${String(r.m).padStart(2)} min — gęstość ${(r.m / cells * 100).toFixed(1)}%`);
});
check('every rung keeps a full 3×3 opening safe', ladderOk,
  fallbackReachable ? 'a rung falls back to sparing only the clicked cell' : '');

console.log('\n── invariants ───────────────────────────────────────────────────');
let firstClickBooms = 0, firstClickNotZero = 0, firstBoards = 0;
let penaltyMismatch = 0, clearUnderpaid = 0, illegalRuns = 0;
const scoreOfClear = [];
for (let i = 1; i <= N; i += 1) {
  const { st, illegal } = play(i * 7919, 240, (b, cell) => {
    firstBoards += 1;
    if (b.mine[cell]) firstClickBooms += 1;
    if (b.adj[cell] !== 0) firstClickNotZero += 1;
  });
  if (illegal) illegalRuns += 1;
  if (st.penalty !== st.booms * sim.SP_MINE_PENALTY_TICKS) penaltyMismatch += 1;
  if (st.cleared > 0 && st.score < st.cleared * sim.SP_CLEAR_BASE) clearUnderpaid += 1;
  if (st.cleared > 0) scoreOfClear.push(st.score / st.cleared);
}
check('the first click of a board never detonates', firstClickBooms === 0,
  `${firstClickBooms}/${firstBoards}`);
check('the first click always opens a region (adj = 0)', firstClickNotZero === 0,
  `${firstClickNotZero}/${firstBoards} landed on a number`);
check('clock penalty equals booms × SP_MINE_PENALTY_TICKS', penaltyMismatch === 0);
check('a cleared board never pays under SP_CLEAR_BASE', clearUnderpaid === 0);
check('the player policy never produces an illegal move', illegalRuns === 0);
check('average payout per board is above the floor', avg(scoreOfClear) > sim.SP_CLEAR_BASE,
  `${avg(scoreOfClear).toFixed(0)} pkt/planszę`);

// The round is the clock: a run only ends at the buzzer, or early because
// detonation penalties ate the rest of it. It must never just stop.
let notOver = 0, overshot = 0;
for (let i = 1; i <= 120; i += 1) {
  const { st } = play(i * 104729, 300);
  if (!st.over) notOver += 1;
  if (st.tick + st.penalty > sim.SP_ROUND_TICKS + sim.SP_MINE_PENALTY_TICKS) overshot += 1;
}
check('every run ends (buzzer or penalties)', notOver === 0);
check('no run runs past its own clock', overshot === 0);

console.log('\n── score bands ──────────────────────────────────────────────────');
console.log('  tempo             avg    med    p95    max   plansz  miny  rozbrojone');
const bands = [
  ['bot 100 ms/ruch  ', 100],
  ['ekspert 160 ms   ', 160],
  ['dobry 240 ms     ', 240],
  ['średni 400 ms    ', 400],
  ['powolny 700 ms   ', 700],
];
let humanCeiling = 0;   // fastest band a pair of hands could actually sustain
let botCeiling = 0;
for (const [label, mpm] of bands) {
  const sc = [], cl = [], bm = [];
  for (let i = 1; i <= N; i += 1) {
    const { st } = play(i * 7919, mpm);
    sc.push(Math.min(sim.SP_MAX_SCORE, st.score));
    cl.push(st.cleared);
    bm.push(st.booms);
  }
  sc.sort((a, b) => a - b);
  botCeiling = Math.max(botCeiling, sc[sc.length - 1]);
  // 100 ms/move is ten deliberate clicks a second sustained for a minute and a
  // half — a script, not a player. It is fine for the cap to clip that; it is
  // not fine for the cap to clip anyone else, so only the human-plausible
  // bands feed the margin check below.
  if (mpm >= 160) humanCeiling = Math.max(humanCeiling, sc[sc.length - 1]);
  const rate = avg(cl) / Math.max(1e-9, avg(cl) + avg(bm)) * 100;
  console.log(`  ${label} ${avg(sc).toFixed(0).padStart(5)}  ${String(sc[Math.floor(N / 2)]).padStart(5)}  ${String(sc[Math.floor(N * 0.95)]).padStart(5)}  ${String(sc[N - 1]).padStart(5)}    ${avg(cl).toFixed(1).padStart(5)} ${avg(bm).toFixed(1).padStart(5)}     ${rate.toFixed(0)}%`);
}

console.log('');
// SP_MAX_SCORE is a forgery bound, not a difficulty knob. What it must never do
// is clip real play, so it has to clear the best human-plausible run with room
// to spare. That it DOES bind the 100 ms/move script is the point of having it.
check('SP_MAX_SCORE clears the best human run by 50%+',
  humanCeiling * 1.5 < sim.SP_MAX_SCORE,
  `człowiek maks ${humanCeiling} · cap ${sim.SP_MAX_SCORE} · zapas ×${(sim.SP_MAX_SCORE / humanCeiling).toFixed(2)}`);
check('SP_MAX_SCORE does bind a 10-clicks/second script', botCeiling >= sim.SP_MAX_SCORE * 0.9,
  `bot maks ${botCeiling}`);

console.log(`\n${failures === 0 ? 'OK' : failures + ' FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
