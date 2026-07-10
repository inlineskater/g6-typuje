// Beam-search solver for „Super Mariusz" (super_mariusz_v2).
// Finds a completing move log (held-key bitmask change points) for the fixed
// deterministic course/physics duplicated from index.html / the Edge Function.
// Used only during course authoring — NOT part of the parity contract; this
// file transcribes the sim (byte-for-byte with the other three copies) purely
// to search for a GOLDEN_MOVES log, then prints it + endTick + completion ms.
//
// Run: node scripts/sm-solve.mjs
//
// Approach: beam search over states keyed by (tick, quantized x, quantized y,
// quantized vx, vy, onGround). At each tick we choose one of a small action
// set {neutral, left, right, right+jump, left+jump, jump-release-right} and
// score surviving beam states by forward x progress (with a tie-break
// favoring being further right and alive). Because the course is a strict
// left-to-right corridor, greedy beam search with enough width converges.

const SM_TICK_MS = 50;
const SM_MAX_TICKS = 6000;
const SM_SUB = 256;
const SM_COURSE_ID = 'super_mariusz_v2';

const SM_RUN_ACCEL = 14;
const SM_FRICTION = 14;
const SM_MAX_SPEED = 88;
const SM_GRAVITY = 18;
const SM_JUMP_VY = -180;
const SM_JUMP_CUT_VY = -60;
const SM_MAX_FALL = 200;
const SM_COYOTE_TICKS = 2;
const SM_JUMP_BUFFER_TICKS = 2;

const SM_PLAYER_W = 192;
const SM_PLAYER_H = 224;
const SM_ENEMY_SPEED = 32;
const SM_ENEMY_W = 208;
const SM_ENEMY_H = 192;
const SM_SPIKE_INSET = 48;

const SM_COURSE = [
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  "............................................................................................................................................................................................................................................................................................................................................................................................................................................................................",
  ".......................................................................................................................................................................................................................###..........##...........###.........###...........###.........####...........####..................................................................................................................................................................",
  "................................................................................................................................................................................................................####..........###.........####..........##..........####..........##...........###...............................................................################################################...........................................................",
  "..S.......^.......^........^....................^^.^^..^^.^^..^^.^^..^^.^^..^^............................................................................................^.............................................................................................................................................E.......E...E......E.......E...E..................^^......^^........^^.......^^.............^...E...^^............E...^....^^....E.............F....",
  "################################...#####...#############################################################################....###.....###....###.....###....###.....###.....###################################................................................................................................###############...#######...#####....#######...#####################################################################.....#######################.....##########",
];

let _smParsed = null;
function smParseCourse() {
  if (_smParsed) return _smParsed;
  const rows = SM_COURSE;
  const height = rows.length;
  const width = rows[0].length;
  const solid = new Uint8Array(width * height);
  const spike = new Uint8Array(width * height);
  let startX = 2 * SM_SUB, startY = 0;
  let flagX = (width - 2) * SM_SUB;
  const enemySpawns = [];
  for (let r = 0; r < height; r += 1) {
    const row = rows[r];
    for (let c = 0; c < width; c += 1) {
      const ch = row[c];
      if (ch === '#') solid[r * width + c] = 1;
      else if (ch === '^') spike[r * width + c] = 1;
      else if (ch === 'S') { startX = c * SM_SUB; startY = (r + 1) * SM_SUB - SM_PLAYER_H; }
      else if (ch === 'F') { flagX = c * SM_SUB; }
      else if (ch === 'E') { enemySpawns.push({ x: c * SM_SUB, row: r + 1 }); }
    }
  }
  _smParsed = { width, height, solid, spike, startX, startY, flagX, enemySpawns, courseBottom: height * SM_SUB };
  return _smParsed;
}

function smTileSolid(course, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= course.width || ty >= course.height) return ty >= course.height ? false : true;
  return course.solid[ty * course.width + tx] === 1;
}
function smTileSpike(course, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= course.width || ty >= course.height) return false;
  return course.spike[ty * course.width + tx] === 1;
}
function smAabbOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function smInitState() {
  const course = smParseCourse();
  const enemies = course.enemySpawns.map(e => ({ x: e.x, y: e.row * SM_SUB - SM_ENEMY_H, dir: 1 }));
  return {
    tick: 0, x: course.startX, y: course.startY, vx: 0, vy: 0,
    onGround: false, coyote: 0, jumpBuf: 0, prevJumpHeld: false,
    enemies, dead: false, finished: false,
  };
}

function smResolveAxis(course, px, py, w, h, dx, dy) {
  let x = px, y = py;
  if (dx !== 0) {
    x += dx;
    const dir = dx > 0 ? 1 : -1;
    const edgeX = dir > 0 ? x + w : x;
    const tx = Math.floor(edgeX / SM_SUB) - (dir > 0 ? 0 : 1);
    const topRow = Math.floor(y / SM_SUB);
    const botRow = Math.floor((y + h - 1) / SM_SUB);
    for (let ty = topRow; ty <= botRow; ty += 1) {
      if (smTileSolid(course, tx, ty)) {
        x = dir > 0 ? tx * SM_SUB - w : (tx + 1) * SM_SUB;
        break;
      }
    }
    return { x, y, landed: false };
  }
  if (dy !== 0) {
    y += dy;
    const dir = dy > 0 ? 1 : -1;
    let landed = false;
    const edgeY = dir > 0 ? y + h : y;
    const ty = Math.floor(edgeY / SM_SUB) - (dir > 0 ? 0 : 1);
    const leftCol = Math.floor(x / SM_SUB);
    const rightCol = Math.floor((x + w - 1) / SM_SUB);
    for (let tx = leftCol; tx <= rightCol; tx += 1) {
      if (smTileSolid(course, tx, ty)) {
        y = dir > 0 ? ty * SM_SUB - h : (ty + 1) * SM_SUB;
        if (dir > 0) landed = true;
        break;
      }
    }
    return { x, y, landed };
  }
  return { x, y, landed: false };
}

function smAdvanceTick(st, keys) {
  const course = smParseCourse();
  st.tick += 1;
  const left = (keys & 1) !== 0;
  const right = (keys & 2) !== 0;
  const jump = (keys & 4) !== 0;
  const jumpPressed = jump && !st.prevJumpHeld;
  st.prevJumpHeld = jump;

  if (jumpPressed) st.jumpBuf = SM_JUMP_BUFFER_TICKS;
  else if (st.jumpBuf > 0) st.jumpBuf -= 1;

  if (left && !right) st.vx = Math.max(-SM_MAX_SPEED, st.vx - SM_RUN_ACCEL);
  else if (right && !left) st.vx = Math.min(SM_MAX_SPEED, st.vx + SM_RUN_ACCEL);
  else {
    if (st.vx > 0) st.vx = Math.max(0, st.vx - SM_FRICTION);
    else if (st.vx < 0) st.vx = Math.min(0, st.vx + SM_FRICTION);
  }

  const canJump = st.onGround || st.coyote > 0;
  let jumped = false;
  if (st.jumpBuf > 0 && canJump) {
    st.vy = SM_JUMP_VY;
    st.onGround = false;
    st.coyote = 0;
    st.jumpBuf = 0;
    jumped = true;
  } else if (!jump && st.vy < SM_JUMP_CUT_VY) {
    st.vy = SM_JUMP_CUT_VY;
  }

  st.vy = Math.min(SM_MAX_FALL, st.vy + SM_GRAVITY);

  const rx = smResolveAxis(course, st.x, st.y, SM_PLAYER_W, SM_PLAYER_H, st.vx, 0);
  if (rx.x !== st.x + st.vx) st.vx = 0;
  st.x = rx.x;

  const ry = smResolveAxis(course, st.x, st.y, SM_PLAYER_W, SM_PLAYER_H, 0, st.vy);
  if (ry.landed) {
    st.onGround = true;
    st.coyote = SM_COYOTE_TICKS;
    st.vy = 0;
  } else {
    if (st.onGround) st.coyote = SM_COYOTE_TICKS;
    else if (st.coyote > 0) st.coyote -= 1;
    st.onGround = false;
  }
  st.y = ry.y;

  for (const en of st.enemies) {
    const nx = en.x + en.dir * SM_ENEMY_SPEED;
    const dir = en.dir;
    const leadX = dir > 0 ? nx + SM_ENEMY_W : nx;
    const tx = Math.floor(leadX / SM_SUB) - (dir > 0 ? 0 : 1);
    const ty = Math.floor((en.y + SM_ENEMY_H - 1) / SM_SUB);
    const wallAhead = smTileSolid(course, dir > 0 ? tx + 1 : tx - 1, Math.floor(en.y / SM_SUB));
    const floorAhead = smTileSolid(course, tx, ty + 1);
    if (wallAhead || !floorAhead) en.dir = -en.dir;
    else en.x = nx;
  }

  const feetRow = Math.floor((st.y + SM_PLAYER_H - 1) / SM_SUB);
  const headRow = Math.floor(st.y / SM_SUB);
  const leftCol = Math.floor((st.x + SM_SPIKE_INSET) / SM_SUB);
  const rightCol = Math.floor((st.x + SM_PLAYER_W - 1 - SM_SPIKE_INSET) / SM_SUB);
  let spiked = false;
  for (let ty = headRow; ty <= feetRow && !spiked; ty += 1) {
    for (let tx = leftCol; tx <= rightCol; tx += 1) {
      if (smTileSpike(course, tx, ty)) { spiked = true; break; }
    }
  }
  let enemyHit = false;
  for (const en of st.enemies) {
    if (smAabbOverlap(st.x + SM_SPIKE_INSET, st.y, SM_PLAYER_W - 2 * SM_SPIKE_INSET, SM_PLAYER_H, en.x, en.y, SM_ENEMY_W, SM_ENEMY_H)) {
      enemyHit = true;
      break;
    }
  }
  const fell = st.y > course.courseBottom;
  if (spiked || enemyHit || fell) st.dead = true;

  if (!st.dead && st.x + SM_PLAYER_W / 2 >= course.flagX) st.finished = true;

  return { jumped, landed: ry.landed, died: st.dead, finished: st.finished };
}

// ── Beam search ─────────────────────────────────────────────────────────────
const ACTIONS = [
  0,        // neutral
  1,        // left
  2,        // right
  6,        // right + jump
  5,        // left + jump
  4,        // jump only
];

function cloneState(st) {
  return { ...st, enemies: st.enemies.map(e => ({ ...e })) };
}

function stateKey(st) {
  // quantize to keep beam size manageable
  const qx = Math.round(st.x / 16);
  const qy = Math.round(st.y / 16);
  const qvx = st.vx;
  const qvy = Math.round(st.vy / 4);
  return `${qx}|${qy}|${qvx}|${qvy}|${st.onGround ? 1 : 0}|${st.coyote}|${st.jumpBuf}`;
}

function solve({ beamWidth = 400, maxTicks = 2200 } = {}) {
  const course = smParseCourse();
  let beam = [{ state: smInitState(), keys: 0, moves: [], lastKeys: 0 }];
  const seen = new Map();

  for (let tick = 1; tick <= maxTicks; tick += 1) {
    const nextBeam = [];
    for (const entry of beam) {
      for (const action of ACTIONS) {
        const st = cloneState(entry.state);
        const ev = smAdvanceTick(st, action);
        if (st.dead) continue; // prune
        const moves = entry.lastKeys !== action
          ? [...entry.moves, { tick, keys: action }]
          : entry.moves;
        if (ev.finished) {
          return { finished: true, endTick: st.tick, completionMs: st.tick * SM_TICK_MS, moves };
        }
        nextBeam.push({ state: st, keys: action, moves, lastKeys: action });
      }
    }
    if (!nextBeam.length) {
      const bestX = Math.max(...beam.map(e => e.state.x)) / SM_SUB;
      throw new Error(`beam died out at tick ${tick} (no surviving states) — course likely too hard or a jump gap is impossible; best x pre-death ~${bestX.toFixed(2)} tiles`);
    }
    // score: prefer higher x, then higher progress toward flag, break ties randomly-but-deterministically
    nextBeam.sort((a, b) => {
      if (b.state.x !== a.state.x) return b.state.x - a.state.x;
      return (b.state.onGround ? 1 : 0) - (a.state.onGround ? 1 : 0);
    });
    // dedupe by quantized state key, keep best-x per key
    const dedup = [];
    const localSeen = new Set();
    for (const entry of nextBeam) {
      const key = stateKey(entry.state);
      if (localSeen.has(key)) continue;
      localSeen.add(key);
      dedup.push(entry);
      if (dedup.length >= beamWidth) break;
    }
    beam = dedup;
  }
  throw new Error(`did not finish within ${maxTicks} ticks; best x reached = ${Math.max(...beam.map(e => e.state.x)) / SM_SUB} tiles (flag at ${course.flagX / SM_SUB})`);
}

const result = solve({ beamWidth: 500, maxTicks: 2200 });
console.log('SOLVED. endTick =', result.endTick, ' completionMs =', result.completionMs, ' seconds =', (result.completionMs / 1000).toFixed(2));
console.log('moves.length =', result.moves.length);
console.log('GOLDEN_MOVES =', JSON.stringify(result.moves));
