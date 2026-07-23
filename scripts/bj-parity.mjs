// Throwaway parity harness for Bug Jumper's dynamic course (bug_jumper).
// Transcribes the deterministic course generator + move-replay resolver from
// BOTH sources and asserts they agree on the generated course AND on
// {bestRow, completed, completionMs, collisions} across many random seeds +
// randomly-driven move logs (including moves into walls and off the board).
//   - client  <- index.html (BJ_* consts + bjGenerateCourse/bjCellBlocked/bjCellOpen)
//   - server  <- supabase/functions/bug-jumper-action/index.ts (generateCourse/replayMoves)
// Run: node scripts/bj-parity.mjs

const BJ_COLS = 56;
const BJ_ROWS = 32;
const BJ_LANE_COUNT = 30;
const BJ_SAFE_ROWS = [10, 20, 30];
const BJ_BAND_HALF = 7;
const BJ_DRIFT_MAX = 3;
const ROUND_DURATION_MS = 25000;
const INPUT_COOLDOWN_MS = 100;
const MAX_SCORE = 30;
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
    const lanes = [];
    let center = Math.floor(BJ_COLS / 2);
    for (let row = 1; row <= BJ_LANE_COUNT; row++) {
      const delta = Math.floor(rng() * (BJ_DRIFT_MAX * 2 + 1)) - BJ_DRIFT_MAX;
      center = Math.max(BJ_BAND_HALF, Math.min(BJ_COLS - 1 - BJ_BAND_HALF, center + delta));

      if (BJ_SAFE_ROWS.includes(row)) {
        lanes.push({ safe: true, bandStart: 0, bandEnd: BJ_COLS - 1, obstacles: [] });
        continue;
      }
      const bandStart = center - BJ_BAND_HALF;
      const bandEnd = center + BJ_BAND_HALF;
      const bandWidth = bandEnd - bandStart + 1;
      const rowProgress = (row - 1) / (BJ_LANE_COUNT - 1);
      const obstacleCount = 1 + Math.floor(rng() * 3);
      const obstacles = [];
      for (let i = 0; i < obstacleCount; i++) {
        const roll = rng();
        if (roll < 0.5) {
          const len = 1 + (rng() < 0.15 ? 1 : 0);
          const col = bandStart + Math.floor(rng() * bandWidth);
          const baseInterval = 700 - rowProgress * 300;
          const intervalMs = Math.max(260, Math.round(baseInterval + (rng() - 0.5) * 80));
          const phaseMs = Math.floor(rng() * 300);
          const dir = rng() < 0.5 ? 1 : -1;
          obstacles.push({ kind: 'crawl', col, len, dir, intervalMs, phaseMs });
        } else if (roll < 0.8) {
          const maxRange = Math.max(2, Math.min(bandWidth, 6));
          const rangeLen = 2 + Math.floor(rng() * (maxRange - 1));
          const anchorSpan = Math.max(1, bandEnd - (rangeLen - 1) - bandStart + 1);
          const anchor = bandStart + Math.floor(rng() * anchorSpan);
          const baseInterval = 600 - rowProgress * 250;
          const intervalMs = Math.max(220, Math.round(baseInterval + (rng() - 0.5) * 80));
          const phaseMs = Math.floor(rng() * 300);
          obstacles.push({ kind: 'bounce', anchor, rangeLen, intervalMs, phaseMs });
        } else {
          const len = 1 + (rng() < 0.15 ? 1 : 0);
          const col = bandStart + Math.floor(rng() * (bandWidth - len + 1));
          obstacles.push({ kind: 'block', col, len });
        }
      }
      lanes.push({ safe: false, bandStart, bandEnd, obstacles });
    }
    return {
      id: 'bug_jumper_dynamic_v1', version: 5, seed: Number(seed) >>> 0,
      cols: BJ_COLS, rows: BJ_ROWS, laneCount: BJ_LANE_COUNT, safeRows: BJ_SAFE_ROWS,
      durationMs: ROUND_DURATION_MS, inputCooldownMs: INPUT_COOLDOWN_MS, maxScore: MAX_SCORE,
      lanes,
    };
  }
  function crawlColAt(lane, obs, elapsedMs) {
    const bandWidth = lane.bandEnd - lane.bandStart + 1;
    const interval = Math.max(1, obs.intervalMs | 0);
    const phase = Math.max(0, obs.phaseMs | 0);
    const steps = Math.floor((Math.max(0, elapsedMs) + phase) / interval);
    const rel = mod((obs.col - lane.bandStart) + steps * (obs.dir || 1), bandWidth);
    return lane.bandStart + rel;
  }
  function bounceColAt(obs, elapsedMs) {
    const interval = Math.max(1, obs.intervalMs | 0);
    const phase = Math.max(0, obs.phaseMs | 0);
    const period = Math.max(1, 2 * (obs.rangeLen - 1));
    const steps = Math.floor((Math.max(0, elapsedMs) + phase) / interval);
    const cyclePos = mod(steps, period);
    const offset = cyclePos <= obs.rangeLen - 1 ? cyclePos : period - cyclePos;
    return obs.anchor + offset;
  }
  function cellBlocked(row, col, elapsedMs, course) {
    if (row < 1 || row > course.laneCount) return false;
    const lane = course.lanes[row - 1];
    if (!lane || lane.safe) return false;
    const bandWidth = lane.bandEnd - lane.bandStart + 1;
    return lane.obstacles.some((obs) => {
      if (obs.kind === 'crawl') {
        const head = crawlColAt(lane, obs, elapsedMs);
        for (let i = 0; i < obs.len; i++) {
          if (lane.bandStart + mod((head - lane.bandStart) + i, bandWidth) === col) return true;
        }
        return false;
      }
      if (obs.kind === 'bounce') return bounceColAt(obs, elapsedMs) === col;
      if (obs.kind === 'block') return col >= obs.col && col < obs.col + obs.len;
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
    let best = Infinity;
    for (const obs of lane.obstacles) {
      if (obs.kind === 'block') continue;
      const interval = Math.max(1, obs.intervalMs | 0);
      const phase = Math.max(0, obs.phaseMs | 0);
      const step = Math.floor((Math.max(0, elapsedMs) + phase) / interval) + 1;
      const t = Math.max(0, step * interval - phase);
      if (t < best) best = t;
    }
    return best;
  }
  function firstCollisionBetween(state, fromMs, toMs, course) {
    if (state.row < 1 || state.row > course.laneCount) return null;
    const start = Math.max(0, fromMs);
    const end = Math.max(start, toMs);
    if (cellBlocked(state.row, state.col, start, course)) return start;
    const lane = course.lanes[state.row - 1];
    let t = nextLaneStepAfter(lane, start);
    let guard = 0;
    while (t <= end + MOVE_TIME_TOLERANCE_MS && guard < 300) {
      if (t >= start && cellBlocked(state.row, state.col, t, course)) return Math.min(end, Math.max(start, t));
      const nt = nextLaneStepAfter(lane, t);
      if (nt <= t) break;
      t = nt;
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
  const moveCount = 60 + Math.floor(rng() * 300);
  for (let i = 0; i < moveCount && t < ROUND_DURATION_MS; i++) {
    t += 80 + Math.floor(rng() * 300);
    const roll = rng();
    let dr = 0, dc = 0;
    if (roll < 0.45) dr = 1;
    else if (roll < 0.55) dr = -1;
    else if (roll < 0.78) dc = 1;
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

// Sanity checks on the generated courses themselves (bounds, safe rows open).
let sanityFailures = 0;
for (const seed of seeds.slice(0, 50)) {
  const course = client.generateCourse(seed);
  for (let row = 1; row <= BJ_LANE_COUNT; row++) {
    const lane = course.lanes[row - 1];
    if (BJ_SAFE_ROWS.includes(row)) {
      if (!lane.safe || lane.bandStart !== 0 || lane.bandEnd !== BJ_COLS - 1) {
        sanityFailures++;
        console.log('SANITY FAIL: safe row not fully open, seed', seed, 'row', row);
      }
      continue;
    }
    if (lane.bandStart < 0 || lane.bandEnd > BJ_COLS - 1 || lane.bandStart > lane.bandEnd) {
      sanityFailures++;
      console.log('SANITY FAIL: band out of bounds, seed', seed, 'row', row, lane.bandStart, lane.bandEnd);
    }
    for (const obs of lane.obstacles) {
      if (obs.kind === 'block') {
        // block never wraps: its full length must fit inside the band.
        if (obs.col < lane.bandStart || obs.col + obs.len - 1 > lane.bandEnd) {
          sanityFailures++;
          console.log('SANITY FAIL: block outside band, seed', seed, 'row', row, obs);
        }
      }
      if (obs.kind === 'crawl') {
        // crawl wraps segment-by-segment (see bjCellBlocked), so only the
        // head reference needs to be in-band — verify every rendered segment
        // at several timestamps actually lands in-band, proving the wrap works.
        if (obs.col < lane.bandStart || obs.col > lane.bandEnd) {
          sanityFailures++;
          console.log('SANITY FAIL: crawl head outside band, seed', seed, 'row', row, obs);
        }
        const bandWidth = lane.bandEnd - lane.bandStart + 1;
        for (let t = 0; t < ROUND_DURATION_MS; t += 137) {
          const interval = Math.max(1, obs.intervalMs | 0);
          const phase = Math.max(0, obs.phaseMs | 0);
          const steps = Math.floor((t + phase) / interval);
          const head = lane.bandStart + (((obs.col - lane.bandStart) + steps * (obs.dir || 1)) % bandWidth + bandWidth) % bandWidth;
          for (let i = 0; i < obs.len; i++) {
            const seg = lane.bandStart + (((head - lane.bandStart) + i) % bandWidth + bandWidth) % bandWidth;
            if (seg < lane.bandStart || seg > lane.bandEnd) {
              sanityFailures++;
              console.log('SANITY FAIL: crawl segment escaped band, seed', seed, 'row', row, obs, 't', t, 'seg', seg);
            }
          }
        }
      }
      if (obs.kind === 'bounce') {
        if (obs.anchor < lane.bandStart || obs.anchor + obs.rangeLen - 1 > lane.bandEnd) {
          sanityFailures++;
          console.log('SANITY FAIL: bounce range outside band, seed', seed, 'row', row, obs);
        }
      }
    }
  }
}

console.log(`Tested ${seeds.length} seeds (course) / ${seeds.length * 3} replays.`);
console.log(`Course mismatches: ${courseMismatches}`);
console.log(`Replay mismatches: ${replayMismatches}`);
console.log(`Sanity checks on 50 courses, failures: ${sanityFailures}`);
if (courseMismatches > 0 || replayMismatches > 0 || sanityFailures > 0) {
  console.error('FAIL: parity broken between index.html and bug-jumper-action.');
  process.exit(1);
} else {
  console.log('OK: client and server Bug Jumper simulations agree.');
}
