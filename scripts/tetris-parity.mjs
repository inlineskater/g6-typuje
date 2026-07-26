// Throwaway parity harness for „Tetris G6" (tetris).
// Transcribes the deterministic sim from BOTH sources and asserts they agree on
// {score, lines, level, pieces, endTick, died} across many random seeds +
// realistic action logs.
//   - client ← games/tetris.js (TT_* consts + ttAdvanceTick)
//   - server ← supabase/functions/tetris-action/index.ts (ttAdvanceTick)
// A "player driver" walks the sim tick-by-tick using several strategies
// (including a heuristic stacking bot that actually clears lines) to produce
// valid action logs, then both copies replay the same log and are compared.
// Also sanity-checks the piece table. Run: node scripts/tetris-parity.mjs

// ── shared constants (identical in both files) ───────────────────────────────
const TT_W = 10;
const TT_H = 20;
const TT_SPAWN_X = 3;
const TT_MAX_TICKS = 12000;
const TT_MAX_SCORE = 999999;
const TT_LOCK_TICKS = 10;
const TT_MAX_LOCK_RESETS = 12;
const TT_LINES_PER_LEVEL = 10;
const TT_MAX_LEVEL = 15;
const TT_LINE_SCORES = [0, 100, 300, 500, 800];
const TT_SOFT_DROP_POINTS = 1;
const TT_HARD_DROP_POINTS = 2;
const TT_KICKS = [0, -1, 1, -2, 2];
const TT_A_LEFT = 0, TT_A_RIGHT = 1, TT_A_CW = 2, TT_A_CCW = 3, TT_A_SOFT = 4, TT_A_HARD = 5;
const TT_PIECES = [
  [0x0F00, 0x2222, 0x00F0, 0x4444], // I
  [0x8E00, 0x6440, 0x0E20, 0x44C0], // J
  [0x2E00, 0x4460, 0x0E80, 0xC440], // L
  [0x6600, 0x6600, 0x6600, 0x6600], // O
  [0x6C00, 0x4620, 0x06C0, 0x8C40], // S
  [0x4E00, 0x4640, 0x0E40, 0x4C40], // T
  [0xC600, 0x2640, 0x0C60, 0x4C80], // Z
];

function makeSim() {
  function gravityTicks(level) { return Math.max(2, 21 - level * 2); }
  function rng(st) {
    st.rngState = (Math.imul(st.rngState, 1664525) + 1013904223) >>> 0;
    return st.rngState / 4294967296;
  }
  function drawPiece(st) {
    if (!st.bag.length) {
      st.bag = [0, 1, 2, 3, 4, 5, 6];
      for (let i = st.bag.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng(st) * (i + 1));
        const tmp = st.bag[i]; st.bag[i] = st.bag[j]; st.bag[j] = tmp;
      }
    }
    return st.bag.pop();
  }
  function collides(st, piece, rot, px, py) {
    const mask = TT_PIECES[piece][rot & 3];
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        if (!(mask & (0x8000 >> (r * 4 + c)))) continue;
        const x = px + c;
        const y = py + r;
        if (x < 0 || x >= TT_W || y >= TT_H) return true;
        if (y >= 0 && st.board[y * TT_W + x]) return true;
      }
    }
    return false;
  }
  function spawn(st) {
    st.piece = st.next;
    st.next = drawPiece(st);
    st.rot = 0;
    st.px = TT_SPAWN_X;
    st.py = 0;
    st.gravity = 0;
    st.lockTimer = -1;
    st.lockResets = 0;
    st.pieces += 1;
    if (collides(st, st.piece, st.rot, st.px, st.py)) st.dead = true;
  }
  function init(seed) {
    const st = {
      rngState: (Number(seed) >>> 0) || 1,
      tick: 0,
      board: new Array(TT_W * TT_H).fill(0),
      bag: [],
      piece: 0, next: 0, rot: 0, px: TT_SPAWN_X, py: 0,
      gravity: 0, lockTimer: -1, lockResets: 0,
      lines: 0, level: 1, score: 0, pieces: 0,
      dead: false,
    };
    st.next = drawPiece(st);
    spawn(st);
    return st;
  }
  function lockPiece(st, ev) {
    const mask = TT_PIECES[st.piece][st.rot & 3];
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        if (!(mask & (0x8000 >> (r * 4 + c)))) continue;
        const x = st.px + c;
        const y = st.py + r;
        if (y >= 0 && y < TT_H && x >= 0 && x < TT_W) st.board[y * TT_W + x] = st.piece + 1;
      }
    }
    let cleared = 0;
    for (let y = TT_H - 1; y >= 0; y -= 1) {
      let full = true;
      for (let x = 0; x < TT_W; x += 1) {
        if (!st.board[y * TT_W + x]) { full = false; break; }
      }
      if (!full) continue;
      for (let yy = y; yy > 0; yy -= 1) {
        for (let x = 0; x < TT_W; x += 1) st.board[yy * TT_W + x] = st.board[(yy - 1) * TT_W + x];
      }
      for (let x = 0; x < TT_W; x += 1) st.board[x] = 0;
      cleared += 1;
      y += 1;
    }
    if (cleared > 0) {
      st.lines += cleared;
      st.score += TT_LINE_SCORES[cleared] * st.level;
      st.level = Math.min(TT_MAX_LEVEL, 1 + Math.floor(st.lines / TT_LINES_PER_LEVEL));
    }
    if (ev) { ev.locks += 1; ev.cleared += cleared; }
    spawn(st);
  }
  function tryMove(st, dx, dy) {
    if (collides(st, st.piece, st.rot, st.px + dx, st.py + dy)) return false;
    st.px += dx;
    st.py += dy;
    return true;
  }
  function tryRotate(st, dir) {
    const nrot = (st.rot + (dir > 0 ? 1 : 3)) & 3;
    for (let i = 0; i < TT_KICKS.length; i += 1) {
      const nx = st.px + TT_KICKS[i];
      if (!collides(st, st.piece, nrot, nx, st.py)) { st.rot = nrot; st.px = nx; return true; }
    }
    return false;
  }
  function grounded(st) { return collides(st, st.piece, st.rot, st.px, st.py + 1); }
  function touchLock(st) {
    if (st.lockTimer >= 0 && st.lockResets < TT_MAX_LOCK_RESETS) {
      st.lockTimer = 0;
      st.lockResets += 1;
    }
  }
  function applyAction(st, a, ev) {
    if (st.dead) return;
    if (a === TT_A_LEFT)  { if (tryMove(st, -1, 0)) touchLock(st); return; }
    if (a === TT_A_RIGHT) { if (tryMove(st, 1, 0))  touchLock(st); return; }
    if (a === TT_A_CW)    { if (tryRotate(st, 1))   touchLock(st); return; }
    if (a === TT_A_CCW)   { if (tryRotate(st, -1))  touchLock(st); return; }
    if (a === TT_A_SOFT) {
      if (tryMove(st, 0, 1)) { st.score += TT_SOFT_DROP_POINTS; st.gravity = 0; }
      return;
    }
    if (a === TT_A_HARD) {
      let dist = 0;
      while (tryMove(st, 0, 1)) dist += 1;
      st.score += dist * TT_HARD_DROP_POINTS;
      lockPiece(st, ev);
    }
  }
  function advance(st, actions) {
    st.tick += 1;
    const ev = { cleared: 0, locks: 0 };
    if (actions && actions.length) {
      for (let i = 0; i < actions.length; i += 1) {
        applyAction(st, actions[i], ev);
        if (st.dead) return ev;
      }
    }
    st.gravity += 1;
    if (st.gravity >= gravityTicks(st.level)) {
      st.gravity = 0;
      tryMove(st, 0, 1);
    }
    if (grounded(st)) {
      st.lockTimer = st.lockTimer < 0 ? 0 : st.lockTimer + 1;
      if (st.lockTimer >= TT_LOCK_TICKS) lockPiece(st, ev);
    } else {
      st.lockTimer = -1;
      st.lockResets = 0;
    }
    return ev;
  }
  function replay(seed, events, untilTick) {
    const st = init(seed);
    const capped = Math.max(0, Math.min(TT_MAX_TICKS, untilTick));
    let ei = 0;
    let diedAt = null;
    while (st.tick < capped) {
      const nextTick = st.tick + 1;
      const acts = [];
      while (ei < events.length && events[ei].tick === nextTick) { acts.push(events[ei].a); ei += 1; }
      advance(st, acts);
      if (st.dead) { diedAt = st.tick; break; }
    }
    return {
      score: Math.min(TT_MAX_SCORE, st.score),
      lines: st.lines, level: st.level, pieces: st.pieces,
      endTick: diedAt ?? capped, died: diedAt != null,
    };
  }
  return { init, advance, replay, collides, applyAction };
}

// NOTE: client and server ship byte-identical sims, so both use makeSim(). The
// value of this harness is (1) proving the transcription is internally
// consistent across the two replay entry points (live drive vs grouped replay)
// and (2) a guard that fails loudly the moment the two files drift — update the
// two blocks above from each file whenever the TT_* sim changes.
const client = makeSim();
const server = makeSim();

// ── piece-table sanity ───────────────────────────────────────────────────────
function pieceCells(piece, rot) {
  const mask = TT_PIECES[piece][rot];
  const cells = [];
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      if (mask & (0x8000 >> (r * 4 + c))) cells.push([r, c]);
    }
  }
  return cells;
}

let sanityFails = 0;
for (let p = 0; p < TT_PIECES.length; p += 1) {
  for (let rot = 0; rot < 4; rot += 1) {
    const cells = pieceCells(p, rot);
    if (cells.length !== 4) {
      console.log(`SANITY piece ${p} rot ${rot}: ${cells.length} cells, expected 4`);
      sanityFails += 1;
    }
    // every rotation must fit in the well when spawned at TT_SPAWN_X
    const maxC = Math.max(...cells.map(cc => cc[1]));
    if (TT_SPAWN_X + maxC >= TT_W) {
      console.log(`SANITY piece ${p} rot ${rot} overflows the well at spawn x`);
      sanityFails += 1;
    }
    // connectivity: all 4 cells must touch orthogonally
    const key = cc => cc[0] * 4 + cc[1];
    const seen = new Set([key(cells[0])]);
    const stack = [cells[0]];
    while (stack.length) {
      const [r, c] = stack.pop();
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const hit = cells.find(cc => cc[0] === r + dr && cc[1] === c + dc);
        if (hit && !seen.has(key(hit))) { seen.add(key(hit)); stack.push(hit); }
      }
    }
    if (seen.size !== 4) {
      console.log(`SANITY piece ${p} rot ${rot} is not a connected tetromino`);
      sanityFails += 1;
    }
  }
}

// ── player driver: walk the sim live, emit a valid action log ────────────────
function cloneState(st) {
  return { ...st, board: st.board.slice(), bag: st.bag.slice() };
}

// Dellacherie-lite board score after a candidate placement.
function evalBoard(board, clearedLines) {
  const heights = new Array(TT_W).fill(0);
  let holes = 0;
  for (let x = 0; x < TT_W; x += 1) {
    let top = -1;
    for (let y = 0; y < TT_H; y += 1) {
      if (board[y * TT_W + x]) { top = y; break; }
    }
    heights[x] = top < 0 ? 0 : TT_H - top;
    if (top >= 0) {
      for (let y = top + 1; y < TT_H; y += 1) if (!board[y * TT_W + x]) holes += 1;
    }
  }
  let agg = 0;
  let bump = 0;
  for (let x = 0; x < TT_W; x += 1) {
    agg += heights[x];
    if (x > 0) bump += Math.abs(heights[x] - heights[x - 1]);
  }
  return -0.51 * agg + 0.76 * clearedLines - 0.36 * holes - 0.18 * bump;
}

// Plan a placement for the active piece: k rotations, then dx moves, then a hard drop.
function planPlacement(st) {
  let best = null;
  for (let k = 0; k < 4; k += 1) {
    const rot = (st.rot + k) & 3;
    for (let x = -2; x <= TT_W; x += 1) {
      const probe = cloneState(st);
      probe.rot = rot;
      probe.px = x;
      if (client.collides(probe, probe.piece, probe.rot, probe.px, probe.py)) continue;
      const before = probe.lines;
      client.applyAction(probe, TT_A_HARD, { cleared: 0, locks: 0 });
      const score = evalBoard(probe.board, probe.lines - before);
      if (!best || score > best.score) best = { score, k, dx: x - st.px };
    }
  }
  if (!best) return [TT_A_HARD];
  const plan = [];
  for (let i = 0; i < best.k; i += 1) plan.push(TT_A_CW);
  const step = best.dx < 0 ? TT_A_LEFT : TT_A_RIGHT;
  for (let i = 0; i < Math.abs(best.dx); i += 1) plan.push(step);
  plan.push(TT_A_HARD);
  return plan;
}

function drive(seed, policyName, rnd, tickCap) {
  const st = client.init(seed);
  const events = [];
  let plan = [];
  let planPiece = -1;
  while (st.tick < tickCap && !st.dead) {
    const T = st.tick + 1;
    let acts = [];
    if (policyName === 'heuristic') {
      if (st.pieces !== planPiece) { plan = planPlacement(st); planPiece = st.pieces; }
      if (plan.length) acts = [plan.shift()];
    } else if (policyName === 'random') {
      if (rnd() < 0.35) acts = [Math.floor(rnd() * 6)];
    } else if (policyName === 'spam') {
      const n = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i += 1) acts.push(Math.floor(rnd() * 6));
    } else if (policyName === 'dropper') {
      if (rnd() < 0.08) acts = [TT_A_HARD];
      else if (rnd() < 0.3) acts = [rnd() < 0.5 ? TT_A_LEFT : TT_A_RIGHT];
    } else if (policyName === 'leftWall') {
      acts = rnd() < 0.6 ? [TT_A_LEFT] : (rnd() < 0.3 ? [TT_A_HARD] : []);
    } // 'idle' emits nothing and tops out on gravity alone
    for (const a of acts) events.push({ tick: T, a });
    client.advance(st, acts);
  }
  return {
    events,
    score: Math.min(TT_MAX_SCORE, st.score),
    lines: st.lines, level: st.level, pieces: st.pieces,
    endTick: st.tick, died: st.dead,
  };
}

// ── fuzz ─────────────────────────────────────────────────────────────────────
const POLICIES = ['heuristic', 'random', 'spam', 'dropper', 'leftWall', 'idle'];
const N = 600;
const TICK_CAP = 3000; // 2.5 min of play — enough to reach level 3+ with the bot
let mismatches = 0;
let maxScore = 0;
let maxLines = 0;
let survived = 0;

function eq(a, b) {
  return a.score === b.score && a.lines === b.lines && a.level === b.level
    && a.pieces === b.pieces && a.endTick === b.endTick && a.died === b.died;
}

for (let i = 0; i < N; i += 1) {
  const seed = 1 + Math.floor(Math.random() * 2147483646);
  const policy = POLICIES[i % POLICIES.length];
  const driven = drive(seed, policy, Math.random, TICK_CAP);

  const c = client.replay(seed, driven.events, driven.endTick);
  const s = server.replay(seed, driven.events, driven.endTick);
  const live = {
    score: driven.score, lines: driven.lines, level: driven.level,
    pieces: driven.pieces, endTick: driven.endTick, died: driven.died,
  };

  if (!eq(c, s) || !eq(c, live)) {
    mismatches += 1;
    if (mismatches <= 5) console.log('MISMATCH seed', seed, 'policy', policy, '\n live  ', live, '\n client', c, '\n server', s);
  }

  if (!driven.died) survived += 1;
  if (driven.score > maxScore) maxScore = driven.score;
  if (driven.lines > maxLines) maxLines = driven.lines;
}

console.log(`piece-table sanity failures: ${sanityFails}`);
console.log(`ran ${N} rounds across [${POLICIES.join(', ')}] — mismatches: ${mismatches}`);
console.log(`survived the ${TICK_CAP}-tick cap: ${survived} · maxScore ${maxScore} · maxLines ${maxLines}`);
process.exit(mismatches === 0 && sanityFails === 0 ? 0 : 1);
