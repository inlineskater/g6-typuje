// Throwaway parity harness for „Super Mariusz" (super_mariusz).
// Transcribes the deterministic sim from BOTH sources and asserts they agree
// on {finished, died, endTick, completionMs, score} across many random input
// logs, plus a golden completable run and course sanity checks.
//  - client sim  <- index.html (SM_* consts + smAdvanceTick)
//  - server sim  <- supabase/functions/super-mariusz-action/index.ts
// Run: node scripts/sm-parity.mjs

// ── CLIENT side (from index.html) ────────────────────────────────────────────
const SM_TICK_MSClient = 50;
const SM_MAX_TICKSClient = 6000;          // 5 min hard cap -> DNF
const SM_SCORE_CAP_SECONDSClient = 600;   // score = cap - floor(completion_ms/1000)
const SM_MAX_MOVESClient = 3000;
const SM_SUBClient = 256;                 // sub-units per tile
const SM_COURSE_IDClient = 'super_mariusz_v2';

const SM_RUN_ACCELClient = 14;
const SM_FRICTIONClient = 14;
const SM_MAX_SPEEDClient = 88;
const SM_GRAVITYClient = 18;
const SM_JUMP_VYClient = -180;
const SM_JUMP_CUT_VYClient = -60;
const SM_MAX_FALLClient = 200;
const SM_COYOTE_TICKSClient = 2;
const SM_JUMP_BUFFER_TICKSClient = 2;

const SM_PLAYER_WClient = 192;
const SM_PLAYER_HClient = 224;
const SM_ENEMY_SPEEDClient = 32;
const SM_ENEMY_WClient = 208;
const SM_ENEMY_HClient = 192;
const SM_SPIKE_INSETClient = 48;

// Fixed shared course: '#' solid, '^' spike, 'E' enemy spawn, 'S' start,
// 'F' flag, '.' empty. S/E markers sit one row above the surface they stand
// on (see smParseCourseClient), so the surface row itself stays a plain '#'.
const SM_COURSEClient = [
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

// Client-only rendering constants (not part of the parity contract).
const SM_CS_W = 640, SM_CS_H = 360, SM_MAX_DPR = 2;
const SM_VISIBLE_ROWS = 7;
const SM_TILE_PX = SM_CS_H / SM_VISIBLE_ROWS;
const SM_CAMERA_ROW0 = SM_COURSEClient.length - SM_VISIBLE_ROWS; // fixed vertical window

let _smParsedClient = null;
function smParseCourseClient() {
  if (_smParsedClient) return _smParsedClient;
  const rows = SM_COURSEClient;
  const height = rows.length;
  const width = rows[0].length;
  const solid = new Uint8Array(width * height);
  const spike = new Uint8Array(width * height);
  let startX = 2 * SM_SUBClient, startY = 0;
  let flagX = (width - 2) * SM_SUBClient;
  const enemySpawns = [];
  for (let r = 0; r < height; r += 1) {
    const row = rows[r];
    for (let c = 0; c < width; c += 1) {
      const ch = row[c];
      if (ch === '#') solid[r * width + c] = 1;
      else if (ch === '^') spike[r * width + c] = 1;
      else if (ch === 'S') { startX = c * SM_SUBClient; startY = (r + 1) * SM_SUBClient - SM_PLAYER_HClient; }
      else if (ch === 'F') { flagX = c * SM_SUBClient; }
      else if (ch === 'E') { enemySpawns.push({ x: c * SM_SUBClient, row: r + 1 }); }
    }
  }
  _smParsedClient = { width, height, solid, spike, startX, startY, flagX, enemySpawns, courseBottom: height * SM_SUBClient };
  return _smParsedClient;
}

function smTileSolidClient(course, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= course.width || ty >= course.height) return ty >= course.height ? false : true;
  return course.solid[ty * course.width + tx] === 1;
}

function smTileSpikeClient(course, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= course.width || ty >= course.height) return false;
  return course.spike[ty * course.width + tx] === 1;
}

function smAabbOverlapClient(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function smInitStateClient() {
  const course = smParseCourseClient();
  const enemies = course.enemySpawns.map(e => ({ x: e.x, y: e.row * SM_SUBClient - SM_ENEMY_HClient, dir: 1 }));
  return {
    tick: 0,
    x: course.startX,
    y: course.startY,
    vx: 0,
    vy: 0,
    onGround: false,
    coyote: 0,
    jumpBuf: 0,
    prevJumpHeld: false,
    enemies,
    dead: false,
    finished: false,
  };
}

function smResolveAxisClient(course, px, py, w, h, dx, dy) {
  let x = px, y = py;
  if (dx !== 0) {
    x += dx;
    const dir = dx > 0 ? 1 : -1;
    const edgeX = dir > 0 ? x + w : x;
    const tx = Math.floor(edgeX / SM_SUBClient) - (dir > 0 ? 0 : 1);
    const topRow = Math.floor(y / SM_SUBClient);
    const botRow = Math.floor((y + h - 1) / SM_SUBClient);
    for (let ty = topRow; ty <= botRow; ty += 1) {
      if (smTileSolidClient(course, tx, ty)) {
        x = dir > 0 ? tx * SM_SUBClient - w : (tx + 1) * SM_SUBClient;
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
    const ty = Math.floor(edgeY / SM_SUBClient) - (dir > 0 ? 0 : 1);
    const leftCol = Math.floor(x / SM_SUBClient);
    const rightCol = Math.floor((x + w - 1) / SM_SUBClient);
    for (let tx = leftCol; tx <= rightCol; tx += 1) {
      if (smTileSolidClient(course, tx, ty)) {
        y = dir > 0 ? ty * SM_SUBClient - h : (ty + 1) * SM_SUBClient;
        if (dir > 0) landed = true;
        break;
      }
    }
    return { x, y, landed };
  }
  return { x, y, landed: false };
}

// One simulation tick. keys is a bitmask: bit0 LEFT, bit1 RIGHT, bit2 JUMP.
function smAdvanceTickClient(st, keys) {
  const course = smParseCourseClient();
  st.tick += 1;
  const left = (keys & 1) !== 0;
  const right = (keys & 2) !== 0;
  const jump = (keys & 4) !== 0;
  const jumpPressed = jump && !st.prevJumpHeld;
  st.prevJumpHeld = jump;

  if (jumpPressed) st.jumpBuf = SM_JUMP_BUFFER_TICKSClient;
  else if (st.jumpBuf > 0) st.jumpBuf -= 1;

  if (left && !right) st.vx = Math.max(-SM_MAX_SPEEDClient, st.vx - SM_RUN_ACCELClient);
  else if (right && !left) st.vx = Math.min(SM_MAX_SPEEDClient, st.vx + SM_RUN_ACCELClient);
  else {
    if (st.vx > 0) st.vx = Math.max(0, st.vx - SM_FRICTIONClient);
    else if (st.vx < 0) st.vx = Math.min(0, st.vx + SM_FRICTIONClient);
  }

  const canJump = st.onGround || st.coyote > 0;
  let jumped = false;
  if (st.jumpBuf > 0 && canJump) {
    st.vy = SM_JUMP_VYClient;
    st.onGround = false;
    st.coyote = 0;
    st.jumpBuf = 0;
    jumped = true;
  } else if (!jump && st.vy < SM_JUMP_CUT_VYClient) {
    st.vy = SM_JUMP_CUT_VYClient;
  }

  st.vy = Math.min(SM_MAX_FALLClient, st.vy + SM_GRAVITYClient);

  const rx = smResolveAxisClient(course, st.x, st.y, SM_PLAYER_WClient, SM_PLAYER_HClient, st.vx, 0);
  if (rx.x !== st.x + st.vx) st.vx = 0;
  st.x = rx.x;

  const ry = smResolveAxisClient(course, st.x, st.y, SM_PLAYER_WClient, SM_PLAYER_HClient, 0, st.vy);
  if (ry.landed) {
    st.onGround = true;
    st.coyote = SM_COYOTE_TICKSClient;
    st.vy = 0;
  } else {
    if (st.onGround) st.coyote = SM_COYOTE_TICKSClient;
    else if (st.coyote > 0) st.coyote -= 1;
    st.onGround = false;
  }
  st.y = ry.y;

  for (const en of st.enemies) {
    const nx = en.x + en.dir * SM_ENEMY_SPEEDClient;
    const dir = en.dir;
    const leadX = dir > 0 ? nx + SM_ENEMY_WClient : nx;
    const tx = Math.floor(leadX / SM_SUBClient) - (dir > 0 ? 0 : 1);
    const ty = Math.floor((en.y + SM_ENEMY_HClient - 1) / SM_SUBClient);
    const wallAhead = smTileSolidClient(course, dir > 0 ? tx + 1 : tx - 1, Math.floor(en.y / SM_SUBClient));
    const floorAhead = smTileSolidClient(course, tx, ty + 1);
    if (wallAhead || !floorAhead) en.dir = -en.dir;
    else en.x = nx;
  }

  const feetRow = Math.floor((st.y + SM_PLAYER_HClient - 1) / SM_SUBClient);
  const headRow = Math.floor(st.y / SM_SUBClient);
  const leftCol = Math.floor((st.x + SM_SPIKE_INSETClient) / SM_SUBClient);
  const rightCol = Math.floor((st.x + SM_PLAYER_WClient - 1 - SM_SPIKE_INSETClient) / SM_SUBClient);
  let spiked = false;
  for (let ty = headRow; ty <= feetRow && !spiked; ty += 1) {
    for (let tx = leftCol; tx <= rightCol; tx += 1) {
      if (smTileSpikeClient(course, tx, ty)) { spiked = true; break; }
    }
  }
  let enemyHit = false;
  for (const en of st.enemies) {
    if (smAabbOverlapClient(st.x + SM_SPIKE_INSETClient, st.y, SM_PLAYER_WClient - 2 * SM_SPIKE_INSETClient, SM_PLAYER_HClient, en.x, en.y, SM_ENEMY_WClient, SM_ENEMY_HClient)) {
      enemyHit = true;
      break;
    }
  }
  const fell = st.y > course.courseBottom;
  if (spiked || enemyHit || fell) st.dead = true;

  if (!st.dead && st.x + SM_PLAYER_WClient / 2 >= course.flagX) st.finished = true;

  return { jumped, landed: ry.landed, died: st.dead, finished: st.finished };
}

// ── SERVER side (from supabase/functions/super-mariusz-action/index.ts) ─────
const SM_TICK_MSServer = 50;
const SM_MAX_TICKSServer = 6000;          // 5 min hard cap -> DNF
const SM_SCORE_CAP_SECONDSServer = 600;   // score = cap - floor(completion_ms/1000)
const SM_MAX_MOVESServer = 3000;
const SM_SUBServer = 256;                 // sub-units per tile
const SM_COURSE_IDServer = "super_mariusz_v2";

const SM_RUN_ACCELServer = 14;
const SM_FRICTIONServer = 14;
const SM_MAX_SPEEDServer = 88;
const SM_GRAVITYServer = 18;
const SM_JUMP_VYServer = -180;
const SM_JUMP_CUT_VYServer = -60;
const SM_MAX_FALLServer = 200;
const SM_COYOTE_TICKSServer = 2;
const SM_JUMP_BUFFER_TICKSServer = 2;

const SM_PLAYER_WServer = 192;
const SM_PLAYER_HServer = 224;
const SM_ENEMY_SPEEDServer = 32;
const SM_ENEMY_WServer = 208;
const SM_ENEMY_HServer = 192;
const SM_SPIKE_INSETServer = 48;

// Fixed shared course: '#' solid, '^' spike, 'E' enemy spawn, 'S' start,
// 'F' flag, '.' empty. S/E markers sit one row above the surface they stand
// on (see smParseCourseServer), so the surface row itself stays a plain '#'.
const SM_COURSEServer = [
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

let _smParsedServer = null;
function smParseCourseServer() {
  if (_smParsedServer) return _smParsedServer;
  const rows = SM_COURSEServer;
  const height = rows.length;
  const width = rows[0].length;
  const solid = new Uint8Array(width * height);
  const spike = new Uint8Array(width * height);
  let startX = 2 * SM_SUBServer, startY = 0;
  let flagX = (width - 2) * SM_SUBServer;
  const enemySpawns = [];
  for (let r = 0; r < height; r += 1) {
    const row = rows[r];
    for (let c = 0; c < width; c += 1) {
      const ch = row[c];
      if (ch === "#") solid[r * width + c] = 1;
      else if (ch === "^") spike[r * width + c] = 1;
      else if (ch === "S") { startX = c * SM_SUBServer; startY = (r + 1) * SM_SUBServer - SM_PLAYER_HServer; }
      else if (ch === "F") { flagX = c * SM_SUBServer; }
      else if (ch === "E") { enemySpawns.push({ x: c * SM_SUBServer, row: r + 1 }); }
    }
  }
  _smParsedServer = { width, height, solid, spike, startX, startY, flagX, enemySpawns, courseBottom: height * SM_SUBServer };
  return _smParsedServer;
}

function smTileSolidServer(course, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= course.width || ty >= course.height) return ty >= course.height ? false : true;
  return course.solid[ty * course.width + tx] === 1;
}

function smTileSpikeServer(course, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= course.width || ty >= course.height) return false;
  return course.spike[ty * course.width + tx] === 1;
}

function smAabbOverlapServer(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function smInitStateServer() {
  const course = smParseCourseServer();
  const enemies = course.enemySpawns.map((e) => ({ x: e.x, y: e.row * SM_SUBServer - SM_ENEMY_HServer, dir: 1 }));
  return {
    tick: 0,
    x: course.startX,
    y: course.startY,
    vx: 0,
    vy: 0,
    onGround: false,
    coyote: 0,
    jumpBuf: 0,
    prevJumpHeld: false,
    enemies,
    dead: false,
    finished: false,
  };
}

function smResolveAxisServer(course, px, py, w, h, dx, dy) {
  let x = px, y = py;
  if (dx !== 0) {
    x += dx;
    const dir = dx > 0 ? 1 : -1;
    const edgeX = dir > 0 ? x + w : x;
    const tx = Math.floor(edgeX / SM_SUBServer) - (dir > 0 ? 0 : 1);
    const topRow = Math.floor(y / SM_SUBServer);
    const botRow = Math.floor((y + h - 1) / SM_SUBServer);
    for (let ty = topRow; ty <= botRow; ty += 1) {
      if (smTileSolidServer(course, tx, ty)) {
        x = dir > 0 ? tx * SM_SUBServer - w : (tx + 1) * SM_SUBServer;
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
    const ty = Math.floor(edgeY / SM_SUBServer) - (dir > 0 ? 0 : 1);
    const leftCol = Math.floor(x / SM_SUBServer);
    const rightCol = Math.floor((x + w - 1) / SM_SUBServer);
    for (let tx = leftCol; tx <= rightCol; tx += 1) {
      if (smTileSolidServer(course, tx, ty)) {
        y = dir > 0 ? ty * SM_SUBServer - h : (ty + 1) * SM_SUBServer;
        if (dir > 0) landed = true;
        break;
      }
    }
    return { x, y, landed };
  }
  return { x, y, landed: false };
}

// One simulation tick. keys is a bitmask: bit0 LEFT, bit1 RIGHT, bit2 JUMP.
function smAdvanceTickServer(st, keys) {
  const course = smParseCourseServer();
  st.tick += 1;
  const left = (keys & 1) !== 0;
  const right = (keys & 2) !== 0;
  const jump = (keys & 4) !== 0;
  const jumpPressed = jump && !st.prevJumpHeld;
  st.prevJumpHeld = jump;

  if (jumpPressed) st.jumpBuf = SM_JUMP_BUFFER_TICKSServer;
  else if (st.jumpBuf > 0) st.jumpBuf -= 1;

  // 1) horizontal accel/friction
  if (left && !right) st.vx = Math.max(-SM_MAX_SPEEDServer, st.vx - SM_RUN_ACCELServer);
  else if (right && !left) st.vx = Math.min(SM_MAX_SPEEDServer, st.vx + SM_RUN_ACCELServer);
  else {
    if (st.vx > 0) st.vx = Math.max(0, st.vx - SM_FRICTIONServer);
    else if (st.vx < 0) st.vx = Math.min(0, st.vx + SM_FRICTIONServer);
  }

  // 2) jump (buffered press + coyote time), jump-cut for variable height
  const canJump = st.onGround || st.coyote > 0;
  if (st.jumpBuf > 0 && canJump) {
    st.vy = SM_JUMP_VYServer;
    st.onGround = false;
    st.coyote = 0;
    st.jumpBuf = 0;
  } else if (!jump && st.vy < SM_JUMP_CUT_VYServer) {
    st.vy = SM_JUMP_CUT_VYServer;
  }

  // 3) gravity
  st.vy = Math.min(SM_MAX_FALLServer, st.vy + SM_GRAVITYServer);

  // 4) move X then Y, resolving tile collisions
  const rx = smResolveAxisServer(course, st.x, st.y, SM_PLAYER_WServer, SM_PLAYER_HServer, st.vx, 0);
  if (rx.x !== st.x + st.vx) st.vx = 0;
  st.x = rx.x;

  const ry = smResolveAxisServer(course, st.x, st.y, SM_PLAYER_WServer, SM_PLAYER_HServer, 0, st.vy);
  if (ry.landed) {
    st.onGround = true;
    st.coyote = SM_COYOTE_TICKSServer;
    st.vy = 0;
  } else {
    if (st.onGround) st.coyote = SM_COYOTE_TICKSServer;
    else if (st.coyote > 0) st.coyote -= 1;
    st.onGround = false;
  }
  st.y = ry.y;

  // 5) enemies advance / reverse deterministically
  for (const en of st.enemies) {
    const nx = en.x + en.dir * SM_ENEMY_SPEEDServer;
    const dir = en.dir;
    const leadX = dir > 0 ? nx + SM_ENEMY_WServer : nx;
    const tx = Math.floor(leadX / SM_SUBServer) - (dir > 0 ? 0 : 1);
    const ty = Math.floor((en.y + SM_ENEMY_HServer - 1) / SM_SUBServer);
    const wallAhead = smTileSolidServer(course, dir > 0 ? tx + 1 : tx - 1, Math.floor(en.y / SM_SUBServer));
    const floorAhead = smTileSolidServer(course, tx, ty + 1);
    if (wallAhead || !floorAhead) en.dir = -en.dir;
    else en.x = nx;
  }

  // 6) death checks: spike (inset hitbox), enemy contact, fell off the course
  const feetRow = Math.floor((st.y + SM_PLAYER_HServer - 1) / SM_SUBServer);
  const headRow = Math.floor(st.y / SM_SUBServer);
  const leftCol = Math.floor((st.x + SM_SPIKE_INSETServer) / SM_SUBServer);
  const rightCol = Math.floor((st.x + SM_PLAYER_WServer - 1 - SM_SPIKE_INSETServer) / SM_SUBServer);
  let spiked = false;
  for (let ty = headRow; ty <= feetRow && !spiked; ty += 1) {
    for (let tx = leftCol; tx <= rightCol; tx += 1) {
      if (smTileSpikeServer(course, tx, ty)) { spiked = true; break; }
    }
  }
  let enemyHit = false;
  for (const en of st.enemies) {
    if (smAabbOverlapServer(st.x + SM_SPIKE_INSETServer, st.y, SM_PLAYER_WServer - 2 * SM_SPIKE_INSETServer, SM_PLAYER_HServer, en.x, en.y, SM_ENEMY_WServer, SM_ENEMY_HServer)) {
      enemyHit = true;
      break;
    }
  }
  const fell = st.y > course.courseBottom;
  if (spiked || enemyHit || fell) st.dead = true;

  // 7) finish check
  if (!st.dead && st.x + SM_PLAYER_WServer / 2 >= course.flagX) st.finished = true;

  return { died: st.dead, finished: st.finished };
}

function replaySuperMariusz(moves, untilTick) {
  const st = smInitStateServer();
  const capped = Math.max(0, Math.min(SM_MAX_TICKSServer, untilTick));
  let moveIndex = 0;
  let keys = 0;
  let endTick = capped;
  let died = false;
  let finished = false;
  while (st.tick < capped) {
    const nextTick = st.tick + 1;
    while (moveIndex < moves.length && moves[moveIndex].tick === nextTick) {
      keys = moves[moveIndex].keys;
      moveIndex += 1;
    }
    const ev = smAdvanceTickServer(st, keys);
    if (ev.died) { died = true; endTick = st.tick; break; }
    if (ev.finished) { finished = true; endTick = st.tick; break; }
  }
  const completionMs = finished ? endTick * SM_TICK_MSServer : null;
  const score = finished ? Math.max(0, SM_SCORE_CAP_SECONDSServer - Math.floor(completionMs / 1000)) : 0;
  return { finished, died, endTick, completionMs, score };
}

// ── shared replay driver (both sides' smInitState/smAdvanceTick are identical
//    in shape, so a single driver called against each namespace is enough to
//    catch any divergence in the transition functions themselves) ───────────
function replay(initState, advanceTick, tickMs, scoreCapSeconds, maxTicks, moves, untilTick) {
  const st = initState();
  const capped = Math.max(0, Math.min(maxTicks, untilTick));
  let moveIndex = 0;
  let keys = 0;
  let endTick = capped;
  let died = false;
  let finished = false;
  while (st.tick < capped) {
    const nextTick = st.tick + 1;
    while (moveIndex < moves.length && moves[moveIndex].tick === nextTick) {
      keys = moves[moveIndex].keys;
      moveIndex += 1;
    }
    const ev = advanceTick(st, keys);
    if (ev.died) { died = true; endTick = st.tick; break; }
    if (ev.finished) { finished = true; endTick = st.tick; break; }
  }
  const completionMs = finished ? endTick * tickMs : null;
  const score = finished ? Math.max(0, scoreCapSeconds - Math.floor(completionMs / 1000)) : 0;
  return { finished, died, endTick, completionMs, score };
}

function clientReplay(moves, untilTick) {
  return replay(smInitStateClient, smAdvanceTickClient, SM_TICK_MSClient, SM_SCORE_CAP_SECONDSClient, SM_MAX_TICKSClient, moves, untilTick);
}
function serverReplay(moves, untilTick) {
  return replay(smInitStateServer, smAdvanceTickServer, SM_TICK_MSServer, SM_SCORE_CAP_SECONDSServer, SM_MAX_TICKSServer, moves, untilTick);
}

// ── course sanity checks ─────────────────────────────────────────────────────
{
  const rows = SM_COURSEClient;
  const width = rows[0].length;
  if (!rows.every(r => r.length === width)) throw new Error('course rows have inconsistent width');
  let sCount = 0, fCount = 0;
  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const ch = rows[r][c];
      if (ch === 'S') sCount += 1;
      if (ch === 'F') fCount += 1;
      if (ch === '^') {
        // a spike must sit directly above a solid tile (walkable surface)
        const below = r + 1 < rows.length ? rows[r + 1][c] : null;
        if (below !== '#') throw new Error(`spike at row ${r} col ${c} has no solid tile below it`);
      }
    }
  }
  if (sCount !== 1) throw new Error('course must have exactly one S (start), found ' + sCount);
  if (fCount !== 1) throw new Error('course must have exactly one F (flag), found ' + fCount);
  console.log('course sanity checks passed (single S/F, spikes on solid ground, uniform row width)');
}

// ── golden run: a hand-verified move log that completes the course ─────────
const GOLDEN_MOVES = [{"tick":1,"keys":2},{"tick":12,"keys":6},{"tick":19,"keys":2},{"tick":35,"keys":6},{"tick":42,"keys":2},{"tick":61,"keys":6},{"tick":68,"keys":2},{"tick":89,"keys":6},{"tick":90,"keys":2},{"tick":112,"keys":6},{"tick":113,"keys":2},{"tick":134,"keys":6},{"tick":141,"keys":2},{"tick":154,"keys":6},{"tick":161,"keys":2},{"tick":175,"keys":6},{"tick":182,"keys":2},{"tick":195,"keys":6},{"tick":202,"keys":2},{"tick":216,"keys":6},{"tick":218,"keys":2},{"tick":348,"keys":6},{"tick":349,"keys":2},{"tick":369,"keys":6},{"tick":371,"keys":2},{"tick":392,"keys":6},{"tick":393,"keys":2},{"tick":410,"keys":6},{"tick":413,"keys":2},{"tick":435,"keys":6},{"tick":436,"keys":2},{"tick":456,"keys":6},{"tick":458,"keys":2},{"tick":478,"keys":6},{"tick":484,"keys":2},{"tick":590,"keys":6},{"tick":594,"keys":2},{"tick":613,"keys":6},{"tick":615,"keys":2},{"tick":630,"keys":6},{"tick":631,"keys":2},{"tick":650,"keys":6},{"tick":652,"keys":2},{"tick":665,"keys":6},{"tick":666,"keys":2},{"tick":688,"keys":6},{"tick":690,"keys":2},{"tick":706,"keys":6},{"tick":707,"keys":2},{"tick":723,"keys":6},{"tick":725,"keys":2},{"tick":741,"keys":6},{"tick":742,"keys":2},{"tick":764,"keys":6},{"tick":766,"keys":2},{"tick":781,"keys":6},{"tick":782,"keys":2},{"tick":799,"keys":6},{"tick":801,"keys":2},{"tick":819,"keys":6},{"tick":820,"keys":2},{"tick":843,"keys":6},{"tick":845,"keys":2},{"tick":857,"keys":6},{"tick":858,"keys":2},{"tick":890,"keys":6},{"tick":895,"keys":2},{"tick":915,"keys":6},{"tick":916,"keys":2},{"tick":927,"keys":6},{"tick":932,"keys":2},{"tick":948,"keys":6},{"tick":955,"keys":2},{"tick":970,"keys":6},{"tick":971,"keys":2},{"tick":982,"keys":6},{"tick":984,"keys":2},{"tick":1000,"keys":6},{"tick":1001,"keys":2},{"tick":1012,"keys":6},{"tick":1016,"keys":2},{"tick":1164,"keys":6},{"tick":1165,"keys":2},{"tick":1184,"keys":6},{"tick":1191,"keys":2},{"tick":1210,"keys":6},{"tick":1213,"keys":2},{"tick":1231,"keys":6},{"tick":1232,"keys":2},{"tick":1240,"keys":6},{"tick":1243,"keys":2},{"tick":1254,"keys":6},{"tick":1259,"keys":2},{"tick":1294,"keys":6},{"tick":1296,"keys":2},{"tick":1320,"keys":0}];

{
  const a = clientReplay(GOLDEN_MOVES, SM_MAX_TICKSClient);
  const b = serverReplay(GOLDEN_MOVES, SM_MAX_TICKSServer);
  if (!a.finished || !b.finished) throw new Error('golden run did not finish: ' + JSON.stringify({a, b}));
  if (a.endTick !== 1320 || a.completionMs !== 66000) throw new Error('golden run result drifted: ' + JSON.stringify(a));
  if (a.endTick < 1200 || a.endTick > 1800) throw new Error('golden run completion time outside the 60-90s brutal-course band: ' + JSON.stringify(a));
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('golden run mismatch between client/server: ' + JSON.stringify({a, b}));
  console.log('golden run passed: finished at tick', a.endTick, '=', (a.completionMs / 1000).toFixed(2) + 's, score', a.score);
}

// ── empty-input DNF: standing still forever must deterministically time out ─
{
  const a = clientReplay([], SM_MAX_TICKSClient);
  const b = serverReplay([], SM_MAX_TICKSServer);
  if (a.finished || a.died) throw new Error('empty-input run unexpectedly ended early: ' + JSON.stringify(a));
  if (a.endTick !== SM_MAX_TICKSClient || a.score !== 0) throw new Error('empty-input DNF result unexpected: ' + JSON.stringify(a));
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('empty-input mismatch between client/server: ' + JSON.stringify({a, b}));
  console.log('empty-input DNF passed: capped at tick', a.endTick, 'score', a.score);
}

// ── fuzz: random held-key change logs, replayed on both sides ──────────────
function randMoves(rnd, maxTick) {
  const n = Math.floor(rnd() * 60);
  const ticks = new Set();
  while (ticks.size < n) ticks.add(1 + Math.floor(rnd() * maxTick));
  return [...ticks].sort((x, y) => x - y).map(tick => ({ tick, keys: Math.floor(rnd() * 8) }));
}

let mismatches = 0;
const N = 4000;
for (let i = 0; i < N; i += 1) {
  const rnd = Math.random;
  const moves = randMoves(rnd, SM_MAX_TICKSClient);
  const a = clientReplay(moves, SM_MAX_TICKSClient);
  const b = serverReplay(moves, SM_MAX_TICKSServer);
  if (a.finished !== b.finished || a.died !== b.died || a.endTick !== b.endTick || a.completionMs !== b.completionMs || a.score !== b.score) {
    mismatches += 1;
    if (mismatches <= 5) console.log('MISMATCH moves', JSON.stringify(moves), '\n client', a, '\n server', b);
  }
}
console.log(`ran ${N} fuzz rounds — mismatches: ${mismatches}`);
process.exit(mismatches === 0 ? 0 : 1);
