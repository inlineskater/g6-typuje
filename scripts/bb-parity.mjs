// Parity harness for „Kulki G6" (bubble_breaker).
//
// Unlike the older *-parity.mjs harnesses, this one does NOT re-transcribe the
// sim a third time — a hand copy in the harness can itself drift and then
// cheerfully agree with neither file. Both PARITY BLOCKs are EXTRACTED from
// their source files at run time and evaluated, so the thing under test is the
// shipped code:
//
//   client ← games/bubble-breaker.js
//   server ← supabase/functions/bubble-breaker-action/index.ts
//
// Two checks:
//   1. TEXTUAL — the two fenced blocks must be identical once comments and
//      blank lines are stripped. Catches drift the fuzzer might miss (an
//      unreferenced constant, a changed comment-only invariant).
//   2. BEHAVIOURAL — fuzz many seeds with several tap policies through both
//      copies and compare {score, popped, pops, best, cleared, remaining,
//      over} plus the legality of every tap.
//
// Run: node scripts/bb-parity.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_FILE = join(ROOT, 'games', 'bubble-breaker.js');
const SERVER_FILE = join(ROOT, 'supabase', 'functions', 'bubble-breaker-action', 'index.ts');

const START = '// ── PARITY BLOCK START';
const END = '// ── PARITY BLOCK END';

function extractBlock(path) {
  const src = readFileSync(path, 'utf8');
  const from = src.indexOf(START);
  const to = src.indexOf(END);
  if (from < 0 || to < 0 || to < from) {
    console.error(`FATAL: no PARITY BLOCK fences in ${path}`);
    process.exit(2);
  }
  return src.slice(src.indexOf('\n', from) + 1, to);
}

// Comments and blank lines are free to differ (the two files explain
// themselves to different readers); code is not.
function normalize(block) {
  return block
    .split('\n')
    .map(line => line.replace(/\s*\/\/.*$/, '').trimEnd())
    .filter(line => line.trim().length > 0)
    .join('\n');
}

const clientBlock = extractBlock(CLIENT_FILE);
const serverBlock = extractBlock(SERVER_FILE);

let textualOk = true;
if (normalize(clientBlock) !== normalize(serverBlock)) {
  textualOk = false;
  const a = normalize(clientBlock).split('\n');
  const b = normalize(serverBlock).split('\n');
  console.log('TEXTUAL MISMATCH between the two PARITY BLOCKs:');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      console.log(`  line ${i + 1}`);
      console.log(`    client: ${a[i] ?? '<missing>'}`);
      console.log(`    server: ${b[i] ?? '<missing>'}`);
    }
  }
}

// ── load both copies as independent modules ──────────────────────────────────
function loadSim(block, label) {
  const factory = new Function(`
    ${block}
    return { BB_COLS, BB_ROWS, BB_COLORS, BB_MIN_GROUP, BB_CLEAR_BONUS, BB_MAX_SCORE,
             bbInitState, bbGroupAt, bbGroupScore, bbHasMove, bbRemaining, bbPopAt };
  `);
  try {
    return factory();
  } catch (err) {
    console.error(`FATAL: ${label} PARITY BLOCK does not evaluate standalone:`, err.message);
    process.exit(2);
  }
}

const client = loadSim(clientBlock, 'client');
const server = loadSim(serverBlock, 'server');

// ── tap policies: produce a legal sequence of pops for a seed ────────────────
// Each returns the chosen cell index given the current board, or -1 to stop.
const POLICIES = {
  // Always take the biggest group available — the "patient" strategy the
  // scoring rewards, and the one that produces the longest runs.
  greedy(sim, st, rnd) {
    let bestIdx = -1, bestLen = 0;
    const seen = new Set();
    for (let i = 0; i < st.cells.length; i += 1) {
      if (st.cells[i] < 0 || seen.has(i)) continue;
      const g = sim.bbGroupAt(st.cells, i);
      g.forEach(x => seen.add(x));
      if (g.length >= sim.BB_MIN_GROUP && g.length > bestLen) { bestLen = g.length; bestIdx = i; }
    }
    return bestIdx;
  },
  // Always take the smallest legal group — the worst sensible play, and the one
  // that maximises the number of pops (so the longest move logs).
  smallest(sim, st) {
    let bestIdx = -1, bestLen = Infinity;
    const seen = new Set();
    for (let i = 0; i < st.cells.length; i += 1) {
      if (st.cells[i] < 0 || seen.has(i)) continue;
      const g = sim.bbGroupAt(st.cells, i);
      g.forEach(x => seen.add(x));
      if (g.length >= sim.BB_MIN_GROUP && g.length < bestLen) { bestLen = g.length; bestIdx = i; }
    }
    return bestIdx;
  },
  // Uniformly random legal group.
  random(sim, st, rnd) {
    const anchors = [];
    const seen = new Set();
    for (let i = 0; i < st.cells.length; i += 1) {
      if (st.cells[i] < 0 || seen.has(i)) continue;
      const g = sim.bbGroupAt(st.cells, i);
      g.forEach(x => seen.add(x));
      if (g.length >= sim.BB_MIN_GROUP) anchors.push(i);
    }
    if (!anchors.length) return -1;
    return anchors[Math.floor(rnd() * anchors.length)];
  },
};

// Drive a full round through `sim`, returning the move log and the outcome.
function drive(sim, seed, policy, rnd) {
  const st = sim.bbInitState(seed);
  const moves = [];
  let guard = 0;
  while (!st.over && guard < 400) {
    guard += 1;
    const idx = policy(sim, st, rnd);
    if (idx < 0) break;
    const res = sim.bbPopAt(st, idx);
    if (!res) break;               // policy produced an illegal tap — a real bug
    moves.push(idx);
  }
  return { moves, out: outcome(sim, st) };
}

// Replay a move log through `sim`, asserting every tap is legal.
function replay(sim, seed, moves) {
  const st = sim.bbInitState(seed);
  for (let i = 0; i < moves.length; i += 1) {
    if (!sim.bbPopAt(st, moves[i])) return { illegalAt: i, ...outcome(sim, st) };
  }
  return { illegalAt: -1, ...outcome(sim, st) };
}

function outcome(sim, st) {
  return {
    score: Math.min(sim.BB_MAX_SCORE, st.score),
    popped: st.popped,
    pops: st.pops,
    best: st.best,
    cleared: st.cleared,
    remaining: sim.bbRemaining(st.cells),
    over: st.over,
  };
}

function eq(a, b) {
  return a.score === b.score && a.popped === b.popped && a.pops === b.pops
    && a.best === b.best && a.cleared === b.cleared && a.remaining === b.remaining
    && a.over === b.over;
}

// A tiny seeded PRNG so a failing run is reproducible from the printed seed.
function makeRnd(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ── fuzz ─────────────────────────────────────────────────────────────────────
const N = Number(process.argv[2] || 2000);
const policyNames = Object.keys(POLICIES);
let mismatches = 0;
let illegal = 0;
const stats = {};
policyNames.forEach(p => { stats[p] = { runs: 0, sum: 0, max: 0, cleared: 0, maxMoves: 0 }; });

for (let i = 0; i < N; i += 1) {
  const seed = 1 + Math.floor(Math.random() * 2147483646);
  const pName = policyNames[i % policyNames.length];
  const rnd = makeRnd(seed);

  // The client plays the round; the server replays the log it produced. That is
  // exactly the production data flow.
  const driven = drive(client, seed, POLICIES[pName], rnd);
  const c = replay(client, seed, driven.moves);
  const s = replay(server, seed, driven.moves);

  if (s.illegalAt >= 0 || c.illegalAt >= 0) {
    illegal += 1;
    if (illegal <= 5) console.log('ILLEGAL TAP seed', seed, 'policy', pName, 'client@', c.illegalAt, 'server@', s.illegalAt);
  }
  if (!eq(c, s) || !eq(c, driven.out)) {
    mismatches += 1;
    if (mismatches <= 5) {
      console.log('MISMATCH seed', seed, 'policy', pName);
      console.log('  live  ', driven.out);
      console.log('  client', c);
      console.log('  server', s);
    }
  }

  const st = stats[pName];
  st.runs += 1;
  st.sum += driven.out.score;
  if (driven.out.score > st.max) st.max = driven.out.score;
  if (driven.out.cleared) st.cleared += 1;
  if (driven.moves.length > st.maxMoves) st.maxMoves = driven.moves.length;
}

console.log(`\ntextual parity: ${textualOk ? 'OK' : 'FAILED'}`);
console.log(`ran ${N} rounds across [${policyNames.join(', ')}] — mismatches: ${mismatches} · illegal taps: ${illegal}`);
for (const p of policyNames) {
  const st = stats[p];
  console.log(`  ${p.padEnd(9)} avg ${Math.round(st.sum / st.runs).toString().padStart(5)} · max ${String(st.max).padStart(5)} · cleared ${st.cleared}/${st.runs} · longest log ${st.maxMoves} pops`);
}
// The longest legal log bounds BB_MAX_MOVES in the Edge Function (ceil(225/2)
// = 113); a run that exceeds it would be rejected in production.
process.exit(textualOk && mismatches === 0 && illegal === 0 ? 0 : 1);
