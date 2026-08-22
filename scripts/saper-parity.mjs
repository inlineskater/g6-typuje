// Parity harness for „Saper Maraton" (saper).
//
// Like scripts/bb-parity.mjs, this does NOT re-transcribe the simulation a
// third time — a hand copy in the harness can itself drift and then cheerfully
// agree with neither file. Both PARITY BLOCKs are EXTRACTED from their source
// files at run time and evaluated, so the thing under test is the shipped code:
//
//   client ← games/saper.js
//   server ← supabase/functions/saper-action/index.ts
//
// Two checks:
//   1. TEXTUAL — the two fenced blocks must be identical once comments and
//      blank lines are stripped.
//   2. BEHAVIOURAL — drive rounds through the CLIENT copy with several player
//      policies, then replay the produced move log through BOTH copies (which
//      is exactly the production data flow) and compare the full outcome plus
//      the legality of every move.
//
// Run: node scripts/saper-parity.mjs [rounds]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_FILE = join(ROOT, 'games', 'saper.js');
const SERVER_FILE = join(ROOT, 'supabase', 'functions', 'saper-action', 'index.ts');

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
    return { SP_TICK_MS, SP_ROUND_TICKS, SP_MINE_PENALTY_TICKS, SP_MAX_MOVES, SP_MAX_SCORE,
             SP_OPEN, SP_FLAG, SP_CHORD, SP_LADDER,
             spRung, spRng, spNeighbors, spDeal, spInitState, spPlaceMines,
             spRevealFrom, spSettle, spTick, spApplyMove, spReplay };
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

// ── player policies ──────────────────────────────────────────────────────────
// Each returns [action, cell] for the current board, or null to stop. These are
// harness-only: they carry no parity obligation, they exist to generate a wide
// spread of LEGAL move logs (including nasty ones — chords that detonate,
// flag/unflag churn, guesses on a fresh board).

function constraints(sim, b) {
  const out = [];
  for (let c = 0; c < b.w * b.h; c += 1) {
    if (!b.open[c] || b.adj[c] <= 0) continue;
    let flags = 0;
    const hidden = [];
    for (const nb of sim.spNeighbors(b, c)) {
      if (b.flag[nb]) flags += 1;
      else if (!b.open[nb]) hidden.push(nb);
    }
    if (hidden.length) out.push({ cell: c, need: b.adj[c] - flags, hidden });
  }
  return out;
}

const POLICIES = {
  // A competent player: the two trivial deductions, then pairwise subset rules
  // (where 1-2-1 comes from), then the lowest-probability guess.
  solver(sim, b) {
    const cons = constraints(sim, b);
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
    for (let c = 0; c < b.w * b.h; c += 1) if (!b.open[c] && !b.flag[c]) hidden.push(c);
    if (!hidden.length) return null;
    const bg = (b.m - b.flags) / hidden.length;
    const p = new Map();
    for (const k of cons) for (const h of k.hidden) {
      const v = k.need / k.hidden.length;
      if (!p.has(h) || v > p.get(h)) p.set(h, v);
    }
    let best = hidden[0], bestP = Infinity;
    for (const h of hidden) {
      const v = p.has(h) ? p.get(h) : bg;
      if (v < bestP) { bestP = v; best = h; }
    }
    return [sim.SP_OPEN, best];
  },

  // Opens blind. Detonates constantly, which is the point: it drives the
  // penalty/reset path far harder than real play does.
  reckless(sim, b, rnd) {
    const hidden = [];
    for (let c = 0; c < b.w * b.h; c += 1) if (!b.open[c] && !b.flag[c]) hidden.push(c);
    if (!hidden.length) return null;
    return [sim.SP_OPEN, hidden[Math.floor(rnd() * hidden.length)]];
  },

  // Flags and unflags at random between openings, then chords whatever it can.
  // Exercises the flag bookkeeping and chording against wrong flags.
  fidget(sim, b, rnd) {
    const hidden = [];
    for (let c = 0; c < b.w * b.h; c += 1) if (!b.open[c] && !b.flag[c]) hidden.push(c);
    const roll = rnd();
    if (roll < 0.35 && hidden.length) return [sim.SP_FLAG, hidden[Math.floor(rnd() * hidden.length)]];
    if (roll < 0.5) {
      const flagged = [];
      for (let c = 0; c < b.w * b.h; c += 1) if (b.flag[c]) flagged.push(c);
      if (flagged.length) return [sim.SP_FLAG, flagged[Math.floor(rnd() * flagged.length)]];
    }
    if (roll < 0.75) {
      const cons = constraints(sim, b).filter(k => k.need === 0);
      if (cons.length) return [sim.SP_CHORD, cons[Math.floor(rnd() * cons.length)].cell];
    }
    if (!hidden.length) return null;
    return [sim.SP_OPEN, hidden[Math.floor(rnd() * hidden.length)]];
  },
};

// Drive a full round through `sim`, returning the move log and the outcome.
// Mirrors the client runtime: the clock advances on its own, moves are applied
// against whatever tick it has reached, and only ACCEPTED moves are logged.
function drive(sim, seed, policy, rnd, ticksPerMove) {
  const st = sim.spInitState(seed);
  const moves = [];
  let guard = 0;
  while (!st.over && guard < 20000) {
    guard += 1;
    for (let i = 0; i < ticksPerMove && !st.over; i += 1) sim.spTick(st);
    if (st.over) break;
    const b = st.board;
    const act = !b.placed
      ? [sim.SP_OPEN, Math.floor(b.h / 2) * b.w + Math.floor(b.w / 2)]
      : policy(sim, b, rnd);
    // A policy with nothing left to do stops CLICKING, not the round — the
    // clock runs to the buzzer whether or not the player touches anything, and
    // spReplay() always drives it to the end. Breaking here instead would make
    // the harness disagree with both copies over `ticks`/`over` and report a
    // parity failure that is really its own.
    if (!act) { while (!st.over) sim.spTick(st); break; }
    if (!sim.spApplyMove(st, act[0], act[1])) return { moves, out: outcome(sim, st), rejected: act };
    moves.push({ tick: st.tick, a: act[0], c: act[1] });
  }
  return { moves, out: outcome(sim, st), rejected: null };
}

function outcome(sim, st) {
  return {
    score: Math.min(sim.SP_MAX_SCORE, st.score),
    ticks: st.tick,
    cleared: st.cleared,
    booms: st.booms,
    bestStreak: st.bestStreak,
    opened: st.opened,
    boardsDealt: st.boardsDealt,
    over: st.over,
  };
}

function eq(a, b) {
  return a.score === b.score && a.ticks === b.ticks && a.cleared === b.cleared
    && a.booms === b.booms && a.bestStreak === b.bestStreak && a.opened === b.opened
    && a.boardsDealt === b.boardsDealt && a.over === b.over;
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
const N = Number(process.argv[2] || 600);
const policyNames = Object.keys(POLICIES);
let mismatches = 0;
let rejected = 0;
let illegal = 0;
let maxMoves = 0;
const stats = {};
policyNames.forEach(p => { stats[p] = { runs: 0, sum: 0, max: 0, cleared: 0, booms: 0 }; });

for (let i = 0; i < N; i += 1) {
  const seed = 1 + Math.floor(Math.random() * 2147483646);
  const pName = policyNames[i % policyNames.length];
  const rnd = makeRnd(seed);
  // 2..12 ticks per move = 100 ms .. 600 ms per action, i.e. everything from an
  // unreasonably fast expert to someone reading their email in between.
  const ticksPerMove = 2 + (i % 11);

  // The client plays the round; the server replays the log it produced. That is
  // exactly the production data flow.
  const driven = drive(client, seed, POLICIES[pName], rnd, ticksPerMove);
  if (driven.rejected) {
    rejected += 1;
    if (rejected <= 5) console.log('POLICY PRODUCED AN ILLEGAL MOVE seed', seed, pName, driven.rejected);
  }
  const c = client.spReplay(seed, driven.moves);
  const s = server.spReplay(seed, driven.moves);

  if (!c.ok || !s.ok) {
    illegal += 1;
    if (illegal <= 5) console.log('REPLAY REJECTED seed', seed, 'policy', pName, 'client@', c.atMove, 'server@', s.atMove);
    continue;
  }
  const cOut = { score: c.score, ticks: c.ticks, cleared: c.cleared, booms: c.booms, bestStreak: c.bestStreak, opened: c.opened, boardsDealt: c.boardsDealt, over: c.over };
  const sOut = { score: s.score, ticks: s.ticks, cleared: s.cleared, booms: s.booms, bestStreak: s.bestStreak, opened: s.opened, boardsDealt: s.boardsDealt, over: s.over };
  if (!eq(cOut, sOut) || !eq(cOut, driven.out)) {
    mismatches += 1;
    if (mismatches <= 5) {
      console.log('MISMATCH seed', seed, 'policy', pName);
      console.log('  live  ', driven.out);
      console.log('  client', cOut);
      console.log('  server', sOut);
    }
  }

  if (driven.moves.length > maxMoves) maxMoves = driven.moves.length;
  const st = stats[pName];
  st.runs += 1;
  st.sum += driven.out.score;
  st.booms += driven.out.booms;
  if (driven.out.score > st.max) st.max = driven.out.score;
  st.cleared += driven.out.cleared;
}

console.log(`\ntextual parity: ${textualOk ? 'OK' : 'FAILED'}`);
console.log(`ran ${N} rounds across [${policyNames.join(', ')}] — mismatches: ${mismatches} · replays rejected: ${illegal} · policy errors: ${rejected}`);
for (const p of policyNames) {
  const st = stats[p];
  console.log(`  ${p.padEnd(9)} avg ${Math.round(st.sum / st.runs).toString().padStart(5)} · max ${String(st.max).padStart(5)} · plansz/rundę ${(st.cleared / st.runs).toFixed(1)} · min/rundę ${(st.booms / st.runs).toFixed(1)}`);
}
// The longest legal log bounds SP_MAX_MOVES in the Edge Function; a run past it
// would be rejected in production.
console.log(`longest move log: ${maxMoves} (SP_MAX_MOVES = ${client.SP_MAX_MOVES})`);
process.exit(textualOk && mismatches === 0 && illegal === 0 && rejected === 0 && maxMoves <= client.SP_MAX_MOVES ? 0 : 1);
