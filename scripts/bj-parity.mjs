// Throwaway parity harness for Bug Jumper's dynamic course (bug_jumper).
// Transcribes the deterministic course generator + move-replay resolver from
// BOTH sources and asserts they agree on the generated course AND on
// {bestRow, completed, completionMs, collisions} across many random seeds +
// randomly-driven move logs (including moves into walls and off the board).
//   - client  <- index.html (BJ_* consts + bjGenerateCourse/bjCellBlocked/bjCellOpen)
//   - server  <- supabase/functions/bug-jumper-action/index.ts (generateCourse/replayMoves)
// Run: node scripts/bj-parity.mjs

const BJ_COLS = 10;
const BJ_ROWS = 32;
const BJ_LANE_COUNT = 30;
const BJ_SAFE_ROWS = [10, 20, 30];
const BJ_BAND_HALF = 3;
const ROUND_DURATION_MS = 25000;
const INPUT_COOLDOWN_MS = 100;
const MAX_SCORE = 30;
const BJ_SHAPES = [
  [4, 4, 4],
  [4, 4, 6],
  [4, 4, 3],
  [4, 6, 3],
  [4, 3, 6],
  [3, 6, 3],
];
const MOVE_TIME_TOLERANCE_MS = 12;

function makeSim(tag) {
  function mod(n, m) { return ((n % m) + m) % m; }
  function makeRng(seed) {
    let state = (Number(seed) || 1) >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }
  function generateCourse(seed) {
    const rng = makeRng(seed);
    const shapeIndex = mod(Number(seed) >>> 0, BJ_SHAPES.length);
    const shape = BJ_SHAPES[shapeIndex];
    const lanes = [];
    for (let row = 1; row <= BJ_LANE_COUNT; row++) {
      if (BJ_SAFE_ROWS.includes(row)) {
        lanes.push({ safe: true, dir: 1, intervalMs: 1, phaseMs: 0, bugs: [], bandStart: 0, bandEnd: BJ_COLS - 1 });
        continue;
      }
      const segIdx = row <= 10 ? 0 : row <= 20 ? 1 : 2;
      const center = shape[segIdx];
      const bandStart = center - BJ_BAND_HALF;
      const bandEnd = center + BJ_BAND_HALF;
      const bandWidth = bandEnd - bandStart + 1;
      const rowProgress = (row - 1) / (BJ_LANE_COUNT - 1);
      const baseInterval = 700 - rowProgress * 300;
      const intervalMs = Math.max(260, Math.round(baseInterval + (rng() - 0.5) * 80));
      const phaseMs = Math.floor(rng() * 300);
      const dir = rng() < 0.5 ? 1 : -1;
      const bugCount = rng() < 0.25 ? 2 : 1;
      const bugs = [];
      for (let i = 0; i < bugCount; i++) {
        const len = 1 + (rng() < 0.15 ? 1 : 0);
        const col = bandStart + Math.floor(rng() * bandWidth);
        bugs.push({ col, len });
      }
      lanes.push({ safe: false, dir, intervalMs, phaseMs, bugs, bandStart, bandEnd });
    }
    return {
      id: 'bug_jumper_dynamic_v1', version: 4, seed: Number(seed) >>> 0, shapeIndex,
      cols: BJ_COLS, rows: BJ_ROWS, laneCount: BJ_LANE_COUNT, safeRows: BJ_SAFE_ROWS,
      durationMs: ROUND_DURATION_MS, inputCooldownMs: INPUT_COOLDOWN_MS, maxScore: MAX_SCORE,
      lanes,
    };
  }
  function bugColAt(lane, bug, elapsedMs) {
    const bandWidth = lane.bandEnd - lane.bandStart + 1;
    const interval = Math.max(1, lane.intervalMs | 0);
    const phase = Math.max(0, lane.phaseMs | 0);
    const steps = Math.floor((Math.max(0, elapsedMs) + phase) / interval);
    const rel = mod((bug.col - lane.bandStart) + steps * (lane.dir || 1), bandWidth);
    return lane.bandStart + rel;
  }
  function cellBlocked(row, col, elapsedMs, course) {
    if (row < 1 || row > course.laneCount) return false;
    const lane = course.lanes[row - 1];
    if (!lane || lane.safe) return false;
    const bandWidth = lane.bandEnd - lane.bandStart + 1;
    return lane.bugs.some((bug) => {
      const head = bugColAt(lane, bug, elapsedMs);
      for (let i = 0; i < bug.len; i++) {
        if (lane.bandStart + mod((head - lane.bandStart) + i, bandWidth) === col) return true;
      }
      return false;
    });
  }
  function cellOpen(row, col, course) {
    if (row <= 0 || row >= course.rows - 1) return true;
    if (course.safeRows.includes(row)) return true;
    const lane = course.lanes[row - 1];
    if (!lane) return true;
    return col >= lane.bandStart && col <= lane.bandEnd;
  }
  function nextLaneStepAfter(lane, elapsedMs) {
    const interval = Math.max(1, lane.intervalMs | 0);
    const phase = Math.max(0, lane.phaseMs | 0);
    const step = Math.floor((Math.max(0, elapsedMs) + phase) / interval) + 1;
    return Math.max(0, step * interval - phase);
  }
  function firstCollisionBetween(state, fromMs, toMs, course) {
    if (state.row < 1 || state.row > course.laneCount) return null;
    const start = Math.max(0, fromMs);
    const end = Math.max(start, toMs);
    if (cellBlocked(state.row, state.col, start, course)) return start;
    const lane = course.lanes[state.row - 1];
    let t = nextLaneStepAfter(lane, start);
    let guard = 0;
    while (t <= end + MOVE_TIME_TOLERANCE_MS && guard < 100) {
      if (t >= start && cellBlocked(state.row, state.col, t, course)) return Math.min(end, Math.max(start, t));
      t += Math.max(1, lane.intervalMs | 0);
      guard += 1;
    }
    if (cellBlocked(state.row, state.col, end, course)) return end;
    return null;
  }
  function replayMoves(moves, course, untilMs = ROUND_DURATION_MS) {
    const state = { row: 0, col: Math.floor(BJ_COLS / 2), bestRow: 0, completed: false, completionMs: null, collisions: 0, lastMs: 0, nextInputAt: 0 };
    function resolveUntil(toMs) {
      if (state.completed) return;
      const hitAt = firstCollisionBetween(state, state.lastMs, toMs, course);
      if (hitAt != null) {
        state.collisions += 1;
        state.row = 0;
        state.col = Math.floor(BJ_COLS / 2);
        state.lastMs = hitAt;
      }
      state.lastMs = Math.max(state.lastMs, toMs);
    }
    for (const move of moves) {
      resolveUntil(move.t);
      if (state.completed) break;
      if (move.t + MOVE_TIME_TOLERANCE_MS < state.nextInputAt) continue; // too fast, skip like a rejected move
      state.nextInputAt = move.t + INPUT_COOLDOWN_MS;
      if (move.dc !== 0) {
        const proposedCol = Math.max(0, Math.min(BJ_COLS - 1, state.col + move.dc));
        if (cellOpen(state.row, proposedCol, course)) state.col = proposedCol;
        resolveUntil(move.t);
        continue;
      }
      const newRow = state.row + move.dr;
      if (newRow < 0 || newRow > course.rows - 1) continue;
      if (!cellOpen(newRow, state.col, course)) continue;
      if (newRow >= course.rows - 1) {
        state.row = course.rows - 1;
        state.bestRow = BJ_LANE_COUNT;
        state.completed = true;
        state.completionMs = move.t;
        break;
      }
      state.row = newRow;
      if (move.dr > 0 && newRow >= 1 && newRow <= BJ_LANE_COUNT) state.bestRow = Math.max(state.bestRow, newRow);
      resolveUntil(move.t);
    }
    if (!state.completed) resolveUntil(Math.min(ROUND_DURATION_MS, Math.max(0, untilMs)));
    return {
      bestRow: Math.min(MAX_SCORE, state.bestRow),
      completed: state.completed,
      completionMs: state.completed ? Math.round(state.completionMs) : null,
      collisions: state.collisions,
    };
  }
  return { generateCourse, replayMoves, tag };
}

function driveRandomMoves(rngDriver, seed) {
  // A greedy-ish random driver: mostly climbs, sometimes strafes, occasionally
  // tries invalid directions (off-board / into walls) to exercise no-ops.
  let state = (Number(seed) || 1) >>> 0;
  const rng = () => {
    state = (Math.imul(state, 2654435761) + 1) >>> 0;
    return state / 4294967296;
  };
  const moves = [];
  let t = 0;
  const moveCount = 40 + Math.floor(rng() * 200);
  for (let i = 0; i < moveCount && t < ROUND_DURATION_MS; i++) {
    t += 80 + Math.floor(rng() * 300);
    const roll = rng();
    let dr = 0, dc = 0;
    if (roll < 0.55) dr = 1;
    else if (roll < 0.65) dr = -1;
    else if (roll < 0.82) dc = 1;
    else dc = -1;
    moves.push({ t: Math.min(ROUND_DURATION_MS, t), dr, dc });
  }
  return moves;
}

const client = makeSim('client');
const server = makeSim('server');

let courseMismatches = 0;
let replayMismatches = 0;
const seeds = [];
for (let i = 0; i < 400; i++) seeds.push(Math.floor(Math.random() * 2147483647) + 1);
seeds.push(1, 2, 3, 2147483646);

for (const seed of seeds) {
  const cCourse = client.generateCourse(seed);
  const sCourse = server.generateCourse(seed);
  if (JSON.stringify(cCourse) !== JSON.stringify(sCourse)) {
    courseMismatches++;
    console.log('COURSE MISMATCH seed', seed);
  }

  for (let trial = 0; trial < 3; trial++) {
    const moves = driveRandomMoves(null, seed * 7 + trial);
    const cResult = client.replayMoves(moves, cCourse);
    const sResult = server.replayMoves(moves, sCourse);
    if (JSON.stringify(cResult) !== JSON.stringify(sResult)) {
      replayMismatches++;
      console.log('REPLAY MISMATCH seed', seed, 'trial', trial);
      console.log('  client:', JSON.stringify(cResult));
      console.log('  server:', JSON.stringify(sResult));
    }
  }
}

// Shape-select adjustment (startRound in bug-jumper-action): nudging a random
// seed's remainder to a requested shape must always land on that shape.
function mod(n, m) { return ((n % m) + m) % m; }
let shapeSelectMismatches = 0;
for (let i = 0; i < 500; i++) {
  const raw = Math.floor(Math.random() * 2147483647) + 1;
  for (let want = 0; want < BJ_SHAPES.length; want++) {
    let seed = raw - mod(raw, BJ_SHAPES.length) + want;
    if (seed < 1) seed += BJ_SHAPES.length;
    const got = client.generateCourse(seed).shapeIndex;
    if (got !== want) {
      shapeSelectMismatches++;
      console.log('SHAPE-SELECT MISMATCH raw', raw, 'want', want, 'seed', seed, 'got', got);
    }
  }
}
console.log(`Shape-select checks: ${500 * BJ_SHAPES.length}, mismatches: ${shapeSelectMismatches}`);

console.log(`Tested ${seeds.length} seeds (course) / ${seeds.length * 3} replays.`);
console.log(`Course mismatches: ${courseMismatches}`);
console.log(`Replay mismatches: ${replayMismatches}`);
if (courseMismatches > 0 || replayMismatches > 0 || shapeSelectMismatches > 0) {
  console.error('FAIL: parity broken between index.html and bug-jumper-action.');
  process.exit(1);
} else {
  console.log('OK: client and server Bug Jumper simulations agree.');
}
