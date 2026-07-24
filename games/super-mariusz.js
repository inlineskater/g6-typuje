
// Progress score: tile column reached by the player's center (peak x), capped
// at the flag column — every finisher scores exactly the cap, so the shared
// ORDER BY score DESC, completion_ms ASC NULLS LAST ranks distance first and
// decides by time only among finishers.
function smProgressScore(st) {
  const course = smParseCourse();
  const flagCol = Math.floor(course.flagX / SM_SUB);
  return Math.max(0, Math.min(flagCol, Math.floor((st.maxX + SM_PLAYER_W / 2) / SM_SUB)));
}

function smInitState() {
  const course = smParseCourse();
  const enemies = course.enemySpawns.map(e => ({ x: e.x, y: e.row * SM_SUB - SM_ENEMY_H, dir: 1 }));
  return {
    tick: 0,
    x: course.startX,
    maxX: course.startX,
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

// One simulation tick. keys is a bitmask: bit0 LEFT, bit1 RIGHT, bit2 JUMP.
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
  if (st.x > st.maxX) st.maxX = st.x;

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


function newSuperMariuszRuntime() {
  return {
    playing: false, submitting: false, archiveMode: false,
    roundId: null,
    timer: null,
    sim: smInitState(),
    heldKeys: 0,
    loggedKeys: 0,
    moveLog: [],
    endedReason: '',
  };
}

let smCtx = null;
let smStatTimeText = null;
let smStatProgressText = null;
let smStatStatusText = null;

function smInitCanvas() {
  const canvas = document.getElementById('sm-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const DPR = Math.min(window.devicePixelRatio || 1, SM_MAX_DPR);
  const w = Math.round((rect.width || SM_CS_W) * DPR);
  const h = Math.round((rect.height || SM_CS_H) * DPR);
  if (!smCtx || canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    smCtx = canvas.getContext('2d');
  }
  smCtx.setTransform(w / SM_CS_W, 0, 0, h / SM_CS_H, 0, 0);
  smCtx.imageSmoothingEnabled = false;
}

function smResetBoard() {
  const rt = superMariuszRuntime || newSuperMariuszRuntime();
  rt.sim = smInitState();
  rt.heldKeys = 0;
  rt.loggedKeys = 0;
  rt.moveLog = [];
  rt.endedReason = '';
  superMariuszRuntime = rt;
  return rt;
}

function smResetStatCache() {
  smStatTimeText = null;
  smStatProgressText = null;
  smStatStatusText = null;
}

function smSetStats(force = false) {
  const rt = superMariuszRuntime || newSuperMariuszRuntime();
  const st = rt.sim;
  const timeText = smFormatTime(st.tick * SM_TICK_MS);
  const progressPct = smProgressPct(smProgressScore(st));
  const progressText = progressPct + '%';
  const statusText = st.dead ? 'DNF' : st.finished ? 'META!' : rt.playing ? 'W BIEGU' : '—';
  if (smTimeEl && (force || timeText !== smStatTimeText)) { smTimeEl.textContent = timeText; smStatTimeText = timeText; }
  if (smProgressEl && (force || progressText !== smStatProgressText)) { smProgressEl.textContent = progressText; smStatProgressText = progressText; }
  if (smStatusStatEl && (force || statusText !== smStatStatusText)) { smStatusStatEl.textContent = statusText; smStatStatusText = statusText; }
}

// ── NES pixel-art rendering (client-only; free of the parity contract) ─────
const SM_PX = SM_TILE_PX / 8; // one virtual 8x8 NES pixel, in CSS px

function smDrawGroundTile(ctx, sx, sy) {
  // SMB1-style ground block: two-tone orange/brown brick with dark mortar
  // lines and a light top-edge highlight, drawn as an 8x8 pixel pattern.
  const s = SM_PX;
  const w = SM_TILE_PX + 1, h = SM_TILE_PX + 1;
  ctx.fillStyle = '#c84c0c';
  ctx.fillRect(Math.round(sx), Math.round(sy), w, h);
  ctx.fillStyle = '#e0691c';
  ctx.fillRect(Math.round(sx), Math.round(sy), w, Math.round(s));
  ctx.fillStyle = '#3f1500';
  // mortar cross lines (NES brick pattern)
  ctx.fillRect(Math.round(sx), Math.round(sy + s * 3), w, Math.max(1, Math.round(s * 0.5)));
  ctx.fillRect(Math.round(sx + s * 3.5), Math.round(sy), Math.max(1, Math.round(s * 0.5)), Math.round(s * 3.5));
  ctx.fillRect(Math.round(sx + s * 1.5), Math.round(sy + s * 3.5), Math.max(1, Math.round(s * 0.5)), Math.round(s * 4.5));
  ctx.fillRect(Math.round(sx + s * 5.5), Math.round(sy + s * 3.5), Math.max(1, Math.round(s * 0.5)), Math.round(s * 4.5));
}

function smDrawSpikeTile(ctx, sx, sy) {
  // pixel-stepped triangle: stacked shrinking rects, bone-grey with dark outline
  const s = SM_PX;
  const steps = [
    [0, 6, 8, 2], [1, 4, 6, 2], [2, 2, 4, 2], [3, 0, 2, 2],
  ];
  ctx.fillStyle = '#1a1a1a';
  for (const [px, py, pw, ph] of steps) {
    ctx.fillRect(Math.round(sx + (px - 0.5) * s), Math.round(sy + (py - 0.5) * s), Math.ceil((pw + 1) * s), Math.ceil((ph + 1) * s));
  }
  ctx.fillStyle = '#e0e0e0';
  for (const [px, py, pw, ph] of steps) {
    ctx.fillRect(Math.round(sx + px * s), Math.round(sy + py * s), Math.ceil(pw * s), Math.ceil(ph * s));
  }
}

// deterministic cosmetic sky decorations (no RNG — derived from tile column)
function smDrawSky(ctx, cameraTileX, visibleCols) {
  ctx.fillStyle = '#5c94fc';
  ctx.fillRect(0, 0, SM_CS_W, SM_CS_H);
  const firstCol = Math.floor(cameraTileX) - 2;
  const lastCol = Math.ceil(cameraTileX + visibleCols) + 2;
  const groundSy = (SM_COURSE.length - 1 - SM_CAMERA_ROW0) * SM_TILE_PX;
  // pixel clouds every ~17 cols at rows 1.2-2.2 (virtual "sky" band)
  for (let base = Math.floor(firstCol / 17) * 17; base <= lastCol; base += 17) {
    const cx = (base + 8 - cameraTileX) * SM_TILE_PX;
    const cy = SM_TILE_PX * 0.9;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(cx), Math.round(cy + SM_PX * 2), Math.round(SM_TILE_PX * 1.6), Math.round(SM_PX * 3));
    ctx.fillRect(Math.round(cx + SM_TILE_PX * 0.3), Math.round(cy), Math.round(SM_TILE_PX * 0.9), Math.round(SM_PX * 4));
    ctx.fillRect(Math.round(cx + SM_TILE_PX * 0.9), Math.round(cy + SM_PX), Math.round(SM_TILE_PX * 0.7), Math.round(SM_PX * 3.5));
    ctx.fillStyle = '#b5efef';
    ctx.fillRect(Math.round(cx), Math.round(cy + SM_PX * 4), Math.round(SM_TILE_PX * 1.6), Math.round(SM_PX));
  }
  // green bushes every ~13 cols along the floor line (behind tiles)
  for (let base = Math.floor(firstCol / 13) * 13; base <= lastCol; base += 13) {
    const bx = (base - cameraTileX) * SM_TILE_PX;
    const by = groundSy - SM_PX * 2;
    ctx.fillStyle = '#1fae4a';
    ctx.fillRect(Math.round(bx), Math.round(by), Math.round(SM_TILE_PX * 2.2), Math.round(SM_PX * 2));
    ctx.fillStyle = '#2fd15f';
    ctx.fillRect(Math.round(bx + SM_TILE_PX * 0.3), Math.round(by - SM_PX), Math.round(SM_TILE_PX * 1.6), Math.round(SM_PX));
  }
}

function smDrawFlag(ctx, sx, sy, groundSy) {
  const s = SM_PX;
  ctx.fillStyle = '#c9c9c9';
  ctx.fillRect(Math.round(sx + SM_TILE_PX * 0.42), Math.round(sy), Math.max(2, Math.round(s * 0.6)), Math.round(groundSy - sy));
  ctx.fillStyle = '#e8e8e8';
  ctx.beginPath();
  ctx.arc(Math.round(sx + SM_TILE_PX * 0.42 + s * 0.3), Math.round(sy), Math.round(s * 0.9), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#22c55e';
  ctx.beginPath();
  ctx.moveTo(Math.round(sx + SM_TILE_PX * 0.42 + s * 0.6), Math.round(sy + s * 1.5));
  ctx.lineTo(Math.round(sx + SM_TILE_PX * 0.42 + s * 4.5), Math.round(sy + s * 2.7));
  ctx.lineTo(Math.round(sx + SM_TILE_PX * 0.42 + s * 0.6), Math.round(sy + s * 4));
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#8a6540';
  ctx.fillRect(Math.round(sx + SM_TILE_PX * 0.15), Math.round(groundSy - s * 1.5), Math.round(SM_TILE_PX * 0.7), Math.round(s * 1.5));
}

function smDrawEnemy(ctx, sx, sy, w, h, tick, dir) {
  // pixel "walking briefcase goomba": brown body + handle, angry eyes, 2-frame feet
  const s = h / 8;
  ctx.fillStyle = '#5a3a1e';
  ctx.fillRect(Math.round(sx), Math.round(sy + s * 1.5), Math.round(w), Math.round(h * 0.72));
  ctx.fillStyle = '#8a5a2e';
  ctx.fillRect(Math.round(sx), Math.round(sy + s * 1.5), Math.round(w), Math.round(s));
  // handle
  ctx.fillStyle = '#2a1a0e';
  ctx.fillRect(Math.round(sx + w * 0.35), Math.round(sy), Math.round(w * 0.3), Math.round(s * 1.6));
  // eyes (angry)
  ctx.fillStyle = '#fff';
  const eyeY = sy + h * 0.42;
  ctx.fillRect(Math.round(sx + w * 0.2), Math.round(eyeY), Math.round(s * 1.2), Math.round(s * 1.2));
  ctx.fillRect(Math.round(sx + w * 0.6), Math.round(eyeY), Math.round(s * 1.2), Math.round(s * 1.2));
  ctx.fillStyle = '#000';
  ctx.fillRect(Math.round(sx + w * 0.2 + (dir > 0 ? s * 0.5 : 0)), Math.round(eyeY), Math.round(s * 0.7), Math.round(s * 1.2));
  ctx.fillRect(Math.round(sx + w * 0.6 + (dir > 0 ? s * 0.5 : 0)), Math.round(eyeY), Math.round(s * 0.7), Math.round(s * 1.2));
  // angry brows
  ctx.fillStyle = '#000';
  ctx.fillRect(Math.round(sx + w * 0.15), Math.round(eyeY - s * 0.6), Math.round(s * 1.4), Math.round(s * 0.5));
  ctx.fillRect(Math.round(sx + w * 0.55), Math.round(eyeY - s * 0.6), Math.round(s * 1.4), Math.round(s * 0.5));
  // 2-frame stubby feet
  const frame = Math.floor(tick / 4) % 2;
  ctx.fillStyle = '#1a1a1a';
  const footY = sy + h * 0.94;
  if (frame === 0) {
    ctx.fillRect(Math.round(sx + w * 0.1), Math.round(footY), Math.round(s * 1.4), Math.round(s));
    ctx.fillRect(Math.round(sx + w * 0.6), Math.round(footY), Math.round(s * 1.4), Math.round(s));
  } else {
    ctx.fillRect(Math.round(sx + w * 0.2), Math.round(footY), Math.round(s * 1.4), Math.round(s));
    ctx.fillRect(Math.round(sx + w * 0.5), Math.round(footY), Math.round(s * 1.4), Math.round(s));
  }
}

function smDrawPlayer(ctx, sx, sy, w, h, rt, st) {
  const s = h / 8; // virtual pixel size for a ~6x7-pixel-tall sprite
  const dead = st.dead;
  const capCol = dead ? '#5c1414' : '#d21f1f';
  const skinCol = dead ? '#7a5a3a' : '#f1c27d';
  const overallsCol = dead ? '#1a2440' : '#2f5fd6';
  const shirtCol = dead ? '#5c1414' : '#d21f1f';
  const shoeCol = dead ? '#2a1a0e' : '#5a3a1e';

  ctx.save();
  if (dead) {
    // death pose: upside-down, desaturated (cosmetic only, sim already ended)
    ctx.translate(sx + w / 2, sy + h / 2);
    ctx.scale(1, -1);
    ctx.translate(-(sx + w / 2), -(sy + h / 2));
  }

  const jumping = !st.onGround;
  const walking = !jumping && st.vx !== 0;
  const walkFrame = walking ? Math.floor(Math.abs(st.x) / 128) % 2 : 0;
  const facing = rt.facing || 1;

  // legs / shoes
  ctx.fillStyle = shoeCol;
  if (jumping) {
    // tucked legs
    ctx.fillRect(Math.round(sx + w * 0.2), Math.round(sy + h * 0.78), Math.round(w * 0.25), Math.round(h * 0.2));
    ctx.fillRect(Math.round(sx + w * 0.55), Math.round(sy + h * 0.78), Math.round(w * 0.25), Math.round(h * 0.2));
  } else if (walking && walkFrame === 1) {
    ctx.fillRect(Math.round(sx + w * 0.1), Math.round(sy + h * 0.82), Math.round(w * 0.3), Math.round(h * 0.18));
    ctx.fillRect(Math.round(sx + w * 0.6), Math.round(sy + h * 0.78), Math.round(w * 0.3), Math.round(h * 0.2));
  } else {
    ctx.fillRect(Math.round(sx + w * 0.15), Math.round(sy + h * 0.8), Math.round(w * 0.3), Math.round(h * 0.2));
    ctx.fillRect(Math.round(sx + w * 0.55), Math.round(sy + h * 0.8), Math.round(w * 0.3), Math.round(h * 0.2));
  }

  // overalls (legs + body)
  ctx.fillStyle = overallsCol;
  ctx.fillRect(Math.round(sx), Math.round(sy + h * 0.55), Math.round(w), Math.round(h * 0.3));
  ctx.fillRect(Math.round(sx + w * 0.15), Math.round(sy + h * 0.4), Math.round(w * 0.7), Math.round(h * 0.2));

  // shirt sleeves / arms
  ctx.fillStyle = shirtCol;
  if (jumping) {
    // arms up
    ctx.fillRect(Math.round(sx - w * 0.05), Math.round(sy + h * 0.28), Math.round(w * 0.22), Math.round(h * 0.22));
    ctx.fillRect(Math.round(sx + w * 0.83), Math.round(sy + h * 0.28), Math.round(w * 0.22), Math.round(h * 0.22));
  } else {
    ctx.fillRect(Math.round(sx - w * 0.03), Math.round(sy + h * 0.42), Math.round(w * 0.2), Math.round(h * 0.18));
    ctx.fillRect(Math.round(sx + w * 0.83), Math.round(sy + h * 0.42), Math.round(w * 0.2), Math.round(h * 0.18));
  }

  // face / skin
  ctx.fillStyle = skinCol;
  ctx.fillRect(Math.round(sx + w * 0.22), Math.round(sy + h * 0.18), Math.round(w * 0.56), Math.round(h * 0.24));

  // eye (faces direction of travel)
  ctx.fillStyle = '#000';
  const eyeX = facing >= 0 ? sx + w * 0.58 : sx + w * 0.3;
  ctx.fillRect(Math.round(eyeX), Math.round(sy + h * 0.24), Math.round(s * 0.9), Math.round(s * 0.9));

  // cap with brim
  ctx.fillStyle = capCol;
  ctx.fillRect(Math.round(sx + w * 0.12), Math.round(sy), Math.round(w * 0.76), Math.round(h * 0.2));
  ctx.fillRect(Math.round(facing >= 0 ? sx + w * 0.5 : sx - w * 0.08), Math.round(sy + h * 0.14), Math.round(w * 0.5), Math.round(h * 0.08));

  ctx.restore();
}

function smDraw() {
  if (!smCtx) return;
  const rt = superMariuszRuntime || newSuperMariuszRuntime();
  const st = rt.sim;
  const course = smParseCourse();
  const ctx = smCtx;

  // track cosmetic facing off the last nonzero vx
  if (st.vx > 0) rt.facing = 1;
  else if (st.vx < 0) rt.facing = -1;

  ctx.clearRect(0, 0, SM_CS_W, SM_CS_H);

  const visibleCols = SM_CS_W / SM_TILE_PX;
  const playerTileX = st.x / SM_SUB;
  let cameraTileX = playerTileX - visibleCols * 0.35;
  cameraTileX = Math.max(0, Math.min(course.width - visibleCols, cameraTileX));

  smDrawSky(ctx, cameraTileX, visibleCols);

  const toScreenX = worldTileX => (worldTileX - cameraTileX) * SM_TILE_PX;
  const toScreenY = worldTileY => (worldTileY - SM_CAMERA_ROW0) * SM_TILE_PX;

  const firstCol = Math.max(0, Math.floor(cameraTileX) - 1);
  const lastCol = Math.min(course.width - 1, Math.ceil(cameraTileX + visibleCols) + 1);
  for (let ty = SM_CAMERA_ROW0; ty < course.height; ty += 1) {
    for (let tx = firstCol; tx <= lastCol; tx += 1) {
      const sx = toScreenX(tx), sy = toScreenY(ty);
      if (course.solid[ty * course.width + tx]) {
        smDrawGroundTile(ctx, sx, sy);
      } else if (course.spike[ty * course.width + tx]) {
        smDrawSpikeTile(ctx, sx, sy);
      }
    }
  }

  // flag
  const flagSx = toScreenX(course.flagX / SM_SUB);
  const flagSy = toScreenY(SM_CAMERA_ROW0);
  const groundSy = toScreenY(course.height - 1);
  smDrawFlag(ctx, flagSx, flagSy, groundSy + SM_TILE_PX);

  // enemies
  st.enemies.forEach(en => {
    const sx = toScreenX(en.x / SM_SUB);
    const sy = toScreenY(en.y / SM_SUB);
    const w = SM_ENEMY_W / SM_SUB * SM_TILE_PX;
    const h = SM_ENEMY_H / SM_SUB * SM_TILE_PX;
    smDrawEnemy(ctx, sx, sy, w, h, st.tick, en.dir);
  });

  // player (Mariusz)
  const psx = toScreenX(st.x / SM_SUB);
  const psy = toScreenY(st.y / SM_SUB);
  const pw = SM_PLAYER_W / SM_SUB * SM_TILE_PX;
  const ph = SM_PLAYER_H / SM_SUB * SM_TILE_PX;
  smDrawPlayer(ctx, psx, psy, pw, ph, rt, st);

  // scanline overlay
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  for (let y = 0; y < SM_CS_H; y += 3) {
    ctx.fillRect(0, y, SM_CS_W, 1);
  }
}

async function invokeSuperMariusz(payload) {
  const { data, error } = await sb.functions.invoke('super-mariusz-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z Super Mariuszem.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd Super Mariusza.');
  return data;
}

async function loadSuperMariuszState(showSpinner = true) {
  smInitCanvas();
  if (!superMariuszRuntime) smResetBoard();
  smDraw();
  const weeklyWrap  = document.getElementById('sm-weekly-board');
  const allTimeWrap = document.getElementById('sm-alltime-board');
  const awardsWrap  = document.getElementById('sm-awards');
  if (showSpinner) {
    if (weeklyWrap)  weeklyWrap.replaceChildren(makeSpinner());
    if (allTimeWrap) allTimeWrap.replaceChildren(makeSpinner());
    if (awardsWrap)  awardsWrap.replaceChildren();
  }
  try {
    const data = await invokeSuperMariusz({ action: 'state' });
    renderSuperMariuszState(data);
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Brak danych.'));
    if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
    if (smStatus) smStatus.textContent = '„Super Mariusz" nie jest jeszcze aktywny.';
  }
}

function renderSuperMariuszState(data) {
  if (data.profile) { me.coins = data.profile.coins; setText(headerCoins, me.coins); }
  const weekLabel = document.getElementById('sm-week-label');
  if (weekLabel) {
    const range = whackBossWeekRange(data.weekStart);
    weekLabel.textContent = range ? range.short : '';
  }
  renderSuperMariuszTable(document.getElementById('sm-weekly-board'), data.weekly || [], 'weekly');
  renderSuperMariuszTable(document.getElementById('sm-alltime-board'), data.allTime || [], 'allTime');
  renderSuperMariuszAwards(document.getElementById('sm-awards'), data.awards || []);
  if (!superMariuszRuntime?.playing && smStatus) {
    smStatus.textContent = data.myWeekly
      ? (data.myWeekly.completed
          ? 'Twój najlepszy czas w tym tygodniu: ' + smFormatTime(data.myWeekly.completion_ms) + '.'
          : 'Twój najdalszy zasięg w tym tygodniu: ' + smProgressPct(data.myWeekly.score) + '% trasy.')
      : '←→/AD bieg, Spacja/W/↑ skok. Liczy się dystans; wśród finisherów — czas.';
  }
}

function renderSuperMariuszTable(wrap, rows, mode) {
  if (!wrap) return;
  rows = rows.filter(r => r.nick !== 'admin');
  if (!rows.length) {
    wrap.replaceChildren(el('p', { className: 'bj-empty' }, mode === 'weekly' ? 'Jeszcze nikt nie zagrał w tym tygodniu.' : 'Brak rekordów.'));
    return;
  }
  const bodyRows = rows.slice(0, 10).map(row => el('tr', {},
    el('td', { className: 'lb-rank' + (row.rank === 1 ? ' gold' : '') }, whackBossRankLabel(row.rank)),
    el('td', { className: 'lb-nick' + (row.user_id === me?.id ? ' me' : '') }, row.nick + (row.user_id === me?.id ? ' (Ty)' : '')),
    el('td', { className: 'lb-net' }, row.completed === false ? smProgressPct(row.score) + '%' : '🏁 ' + smFormatTime(row.completion_ms))
  ));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Nick'), el('th', { title: 'Meta: czas ukończenia · DNF: % pokonanej trasy' }, 'Wynik'))),
      el('tbody', {}, ...bodyRows)
    )
  );
}

function renderSuperMariuszAwards(wrap, awards) {
  if (!wrap) return;
  if (!awards.length) {
    wrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Pierwsze nagrody pojawią się po zakończeniu tygodnia.'));
    return;
  }
  wrap.replaceChildren(...awards.slice(0, 6).map(row => {
    const label = whackBossWeekRange(row.week_start)?.short || '';
    return el('div', { className: 'bj-award-row' },
      el('span', {}, whackBossRankLabel(row.rank) + ' ' + row.nick + (label ? ' · ' + label : '')),
      el('strong', {}, '+' + row.prize_coins + ' 🪙')
    );
  }));
}

function stopSuperMariuszRound() {
  const rt = superMariuszRuntime;
  if (rt?.timer) clearTimeout(rt.timer);
  const wasArchive = rt?.archiveMode || false;
  superMariuszRuntime = newSuperMariuszRuntime();
  smResetBoard();
  superMariuszRuntime.playing = false;
  superMariuszRuntime.archiveMode = wasArchive;
  if (smStartBtn) { smStartBtn.disabled = false; smStartBtn.textContent = 'Start rundy'; }
  smResetStatCache();
  smSetStats(true);
  smInitCanvas();
  smDraw();
}

function beginSuperMariuszRound(round, options = {}) {
  stopSuperMariuszRound();
  superMariuszRuntime = newSuperMariuszRuntime();
  const rt = smResetBoard();
  rt.playing = true;
  rt.archiveMode = !!options.archiveMode;
  rt.roundId = round.id;
  if (smStartBtn) { smStartBtn.disabled = true; smStartBtn.textContent = 'Runda trwa'; }
  if (smStatus) {
    smStatus.textContent = rt.archiveMode
      ? 'Demo — wynik nie zostanie zapisany.'
      : 'Jedno życie — kolce, teczki i przepaście zabijają od razu.';
  }
  if (smArena) {
    if (!smArena.hasAttribute('tabindex')) smArena.tabIndex = 0;
    try { smArena.focus({ preventScroll: true }); } catch { smArena.focus(); }
  }
  smResetStatCache();
  smSetStats(true);
  smDraw();
  rt.timer = setTimeout(smTick, SM_TICK_MS);
}

function smTick() {
  const rt = superMariuszRuntime;
  if (!rt?.playing) return;
  const st = rt.sim;
  const nextTick = st.tick + 1;
  if (rt.heldKeys !== rt.loggedKeys) {
    rt.moveLog.push({ tick: nextTick, keys: rt.heldKeys });
    rt.loggedKeys = rt.heldKeys;
    if (rt.moveLog.length > SM_MAX_MOVES) rt.moveLog.shift();
  }
  const ev = smAdvanceTick(st, rt.heldKeys);
  smSetStats();
  smDraw();
  if (ev.died) {
    rt.endedReason = 'śmierć';
    finishSuperMariuszRound();
    return;
  }
  if (ev.finished) {
    rt.endedReason = 'meta';
    finishSuperMariuszRound();
    return;
  }
  if (st.tick >= SM_MAX_TICKS) {
    rt.endedReason = 'limit czasu';
    finishSuperMariuszRound();
    return;
  }
  rt.timer = setTimeout(smTick, SM_TICK_MS);
}

async function startSuperMariuszRound() {
  const rt = superMariuszRuntime;
  if (rt?.playing || rt?.submitting) return;
  if (allGamesMode) {
    try { await payArcadeEntry(allGamesSelectedGame); } catch (e) { showToast('❌ Nie udało się wejść do gry.'); return; }
  }
  if (smStartBtn) { smStartBtn.disabled = true; smStartBtn.textContent = 'Ładuję...'; }
  if (smStatus) smStatus.textContent = 'Przygotowuję rundę...';
  try {
    const data = await invokeSuperMariusz({ action: 'start' });
    renderSuperMariuszState(data);
    beginSuperMariuszRound(data.round);
    if (allGamesMode) superMariuszRuntime.archiveMode = true;
  } catch (err) {
    showToast('❌ ' + err.message);
    if (smStatus) smStatus.textContent = 'Nie udało się wystartować rundy.';
    if (smStartBtn) { smStartBtn.disabled = false; smStartBtn.textContent = 'Start rundy'; }
  }
}

async function finishSuperMariuszRound() {
  const rt = superMariuszRuntime;
  if (!rt || rt.submitting) return;
  rt.playing = false;
  rt.submitting = true;
  if (rt.timer) clearTimeout(rt.timer);
  smSetStats(true);
  smDraw();

  const finished = rt.sim.finished;
  const completionMs = finished ? rt.sim.tick * SM_TICK_MS : null;
  const clientScore = smProgressScore(rt.sim);
  const clientPct = smProgressPct(clientScore);

  if (rt.archiveMode) {
    rt.submitting = false;
    if (smStartBtn) { smStartBtn.disabled = false; smStartBtn.textContent = 'Zagraj ponownie'; }
    if (allGamesMode) {
      try {
        await recordArcadeScore('super_mariusz', clientScore);
        if (smStatus) smStatus.textContent = finished ? 'Czas: ' + smFormatTime(completionMs) + ' · zapisano w rankingu arcade!' : 'DNF — ' + clientPct + '% trasy · zapisano w rankingu arcade.';
        loadArcadeScores('super_mariusz');
      } catch (e) { if (smStatus) smStatus.textContent = 'Wynik: ' + clientScore + ' (błąd zapisu).'; }
    } else {
      if (smStatus) smStatus.textContent = finished ? 'Demo — czas: ' + smFormatTime(completionMs) + ' (nie zapisano).' : 'Demo — DNF, ' + clientPct + '% trasy (nie zapisano).';
    }
    return;
  }

  if (smStartBtn) { smStartBtn.disabled = true; smStartBtn.textContent = 'Zapisuję...'; }
  if (smStatus) smStatus.textContent = 'Zapisuję wynik...';
  try {
    const data = await invokeSuperMariusz({
      action: 'submit',
      roundId: rt.roundId,
      moves: rt.moveLog,
      elapsedTicks: rt.sim.tick,
      score: clientScore,
    });
    renderSuperMariuszState(data);
    if (data.score.completed) {
      showToast('✅ Ukończono w ' + smFormatTime(data.score.completion_ms));
      if (smStatus) smStatus.textContent = 'Ostatni czas: ' + smFormatTime(data.score.completion_ms) + '.';
    } else {
      const pct = smProgressPct(data.score.score);
      showToast('💀 DNF — zapisano ' + pct + '% trasy');
      if (smStatus) smStatus.textContent = 'DNF (' + rt.endedReason + ') — dotarłeś do ' + pct + '% trasy.';
    }
  } catch (err) {
    showToast('❌ ' + err.message);
    if (smStatus) smStatus.textContent = 'Nie udało się zapisać wyniku.';
  } finally {
    rt.submitting = false;
    if (smStartBtn) { smStartBtn.disabled = false; smStartBtn.textContent = 'Zagraj ponownie'; }
  }
}

if (smStartBtn) smStartBtn.addEventListener('click', startSuperMariuszRound);

document.addEventListener('keydown', evt => {
  const rt = superMariuszRuntime;
  if (!rt?.playing) return;
  let bit = 0;
  const key = evt.key.toLowerCase();
  if (key === 'arrowleft' || key === 'a') bit = 1;
  else if (key === 'arrowright' || key === 'd') bit = 2;
  else if (key === ' ' || key === 'arrowup' || key === 'w') bit = 4;
  if (!bit) return;
  evt.preventDefault();
  rt.heldKeys |= bit;
});
document.addEventListener('keyup', evt => {
  const rt = superMariuszRuntime;
  if (!rt) return;
  let bit = 0;
  const key = evt.key.toLowerCase();
  if (key === 'arrowleft' || key === 'a') bit = 1;
  else if (key === 'arrowright' || key === 'd') bit = 2;
  else if (key === ' ' || key === 'arrowup' || key === 'w') bit = 4;
  if (!bit) return;
  rt.heldKeys &= ~bit;
});

if (smArena) {
  const smPointers = new Map(); // pointerId -> bit contributed
  smArena.addEventListener('pointerdown', evt => {
    evt.preventDefault();
    const rt = superMariuszRuntime;
    if (!rt?.playing && !rt?.submitting) {
      startSuperMariuszRound();
      return;
    }
    if (!rt?.playing) return;
    const rect = smArena.getBoundingClientRect();
    const relX = (evt.clientX - rect.left) / rect.width;
    const relY = (evt.clientY - rect.top) / rect.height;
    let bit;
    if (relY < 0.45) bit = 4; // upper zone = jump
    else bit = relX < 0.5 ? 1 : 2; // lower-left run left, lower-right run right
    smPointers.set(evt.pointerId, bit);
    rt.heldKeys |= bit;
    try { smArena.setPointerCapture(evt.pointerId); } catch {}
  });
  const releasePointer = evt => {
    const rt = superMariuszRuntime;
    const bit = smPointers.get(evt.pointerId);
    smPointers.delete(evt.pointerId);
    if (!rt || !bit) return;
    let stillHeld = false;
    smPointers.forEach(b => { if (b === bit) stillHeld = true; });
    if (!stillHeld) rt.heldKeys &= ~bit;
  };
  smArena.addEventListener('pointerup', releasePointer);
  smArena.addEventListener('pointercancel', releasePointer);
}

