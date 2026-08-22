// ── „Wszystkie Gry" — live gameplay previews for the picker cards ────────────
// Every card in #ag-picker shows a small autoplaying attract-mode of the real
// game instead of a static emoji. There are no recorded GIFs anywhere in this
// repo: each preview RENDERS THROUGH THE GAME'S OWN DRAW CODE, so it can never
// drift out of sync with how the game actually looks. That works because
// games/*.js keep their canvas context and runtime in top-level `let` bindings
// — one global lexical scope shared by every classic script — so a preview can
// point them at its own canvas plus a throwaway runtime for the duration of a
// single synchronous draw call and restore them right after (see each def's
// draw()). Nothing here ever calls a game's begin*/finish*/stop* functions, so
// no round is started and no score is ever submitted.
//
// Motion comes from small preview-only bots. Where a game's simulation is a
// pure, DOM-free, network-free function (tetris, egg_catch, super_mariusz,
// popup_panic) the REAL simulation runs. The other games' step functions
// submit scores and write HUD elements when the bot dies, so those previews
// step a light stand-in that mutates the same runtime shape the draw code
// reads — plausible motion, no parity contract, never authoritative.

const AGP_FRAME_MS = 1000 / 30;   // previews are decoration: 30 fps is plenty
const AGP_MAX_DT = 120;           // a backgrounded tab must not fast-forward
const AGP_DPR_CAP = 2;

const agpLive = new Map();        // gameType -> preview state
let agpRaf = null;
let agpLastFrame = 0;
let agpIo = null;                 // IntersectionObserver: animate only what's on screen
let agpRo = null;                 // ResizeObserver: rescale the DOM-based previews
let agpVisibilityHooked = false;

function agpReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function agpRandSeed() {
  return (Math.floor(Math.random() * 0xfffffff) + 1) >>> 0;
}

// ── Engine ──────────────────────────────────────────────────────────────────

function agpFitCanvas(p) {
  const canvas = p.canvas;
  if (!canvas) return false;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, AGP_DPR_CAP);
  const w = Math.max(1, Math.round((rect.width || p.vw) * dpr));
  const h = Math.max(1, Math.round((rect.height || p.vh) * dpr));
  if (canvas.width !== w || canvas.height !== h || !p.ctx) {
    canvas.width = w;
    canvas.height = h;
    p.ctx = canvas.getContext('2d');
  }
  if (!p.ctx) return false;
  // `raw` previews (VAR Patrol) size everything off canvas.width themselves.
  if (p.def.raw) p.ctx.setTransform(1, 0, 0, 1, 0, 0);
  else p.ctx.setTransform(w / p.vw, 0, 0, h / p.vh, 0, 0);
  p.ctx.imageSmoothingEnabled = !p.def.pixelArt;
  return true;
}

function agpScaleDom(p) {
  if (!p.host || !p.stage) return;
  const rect = p.stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scale = Math.min(rect.width / p.vw, rect.height / p.vh);
  p.host.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
}

function agpMount(card) {
  const game = card.dataset.game;
  const def = AGP_DEFS[game];
  const stage = card.querySelector('.ag-card-media');
  if (!def || !stage || agpLive.has(game)) return;

  const p = { game, def, card, stage, ready: false, visible: false, acc: 0, t: 0 };
  agpLive.set(game, p);

  ensureGameScript(def.dep).then(() => {
    const size = def.size ? def.size() : [def.vw, def.vh];
    p.vw = size[0];
    p.vh = size[1];
    if (def.dom) {
      const host = document.createElement('div');
      host.className = 'ag-prev-dom';
      host.style.width = p.vw + 'px';
      host.style.height = p.vh + 'px';
      p.host = host;
      stage.appendChild(host);
      agpScaleDom(p);
      if (agpRo) agpRo.observe(stage);
    } else {
      const canvas = document.createElement('canvas');
      canvas.className = 'ag-prev-canvas';
      canvas.style.aspectRatio = p.vw + ' / ' + p.vh;
      p.canvas = canvas;
      stage.appendChild(canvas);
    }
    def.init(p);
    p.ready = true;
    stage.classList.add('is-live');
    agpDrawOne(p);          // first frame immediately, even before it scrolls in
  }).catch(() => {
    stage.classList.add('is-failed');
  });
}

function agpDrawOne(p) {
  if (!p.ready) return;
  if (p.canvas && !agpFitCanvas(p)) return;
  // A board that only makes sense up close (Bug Jumper's 56×32 grid) can ask
  // for a zoomed window on top of the base fit — the game still draws its whole
  // board, we just look at part of it.
  const view = p.def.view && p.def.view(p);
  if (view && p.ctx) {
    const half = { x: p.vw / (2 * view.zoom), y: p.vh / (2 * view.zoom) };
    const cx = Math.max(half.x, Math.min(p.vw - half.x, view.cx));
    const cy = Math.max(half.y, Math.min(p.vh - half.y, view.cy));
    p.ctx.translate(p.vw / 2, p.vh / 2);
    p.ctx.scale(view.zoom, view.zoom);
    p.ctx.translate(-cx, -cy);
  }
  try { p.def.draw(p); } catch (e) { /* a broken preview must never break the picker */ }
}

function agpFrame(now) {
  agpRaf = null;
  if (!agpLive.size) return;
  const dt = Math.min(AGP_MAX_DT, Math.max(0, now - (agpLastFrame || now)));
  if (now - agpLastFrame >= AGP_FRAME_MS - 1) {
    agpLastFrame = now;
    agpLive.forEach(p => {
      if (!p.ready || !p.visible) return;
      try { p.def.step(p, dt); } catch (e) { /* keep the loop alive */ }
      agpDrawOne(p);
    });
  }
  agpSchedule();
}

function agpSchedule() {
  if (agpRaf != null || document.hidden || agpReducedMotion()) return;
  let anyVisible = false;
  agpLive.forEach(p => { if (p.visible) anyVisible = true; });
  if (!anyVisible) return;
  agpRaf = requestAnimationFrame(agpFrame);
}

// Called by loadAllGamesTab(): mount a preview per card, then animate whichever
// ones are actually on screen.
function agpStartPreviews() {
  if (!agpIo && 'IntersectionObserver' in window) {
    agpIo = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const game = entry.target.dataset.game;
        const p = agpLive.get(game);
        if (!p) return;
        p.visible = entry.isIntersecting;
        if (p.visible) agpDrawOne(p);
      });
      agpLastFrame = performance.now();
      agpSchedule();
    }, { rootMargin: '120px 0px' });
  }
  if (!agpRo && 'ResizeObserver' in window) {
    agpRo = new ResizeObserver(() => { agpLive.forEach(p => { if (p.host) agpScaleDom(p); }); });
  }
  if (!agpVisibilityHooked) {
    agpVisibilityHooked = true;
    document.addEventListener('visibilitychange', () => {
      agpLastFrame = performance.now();
      agpSchedule();
    });
  }
  document.querySelectorAll('#ag-picker .ag-card').forEach(card => {
    agpMount(card);
    // Re-observing is what re-delivers an initial entry: observe() alone is a
    // no-op on an already-watched card, so after agpStopPreviews() cleared
    // p.visible nothing would ever set it back when the picker reopens.
    if (agpIo) { agpIo.unobserve(card); agpIo.observe(card); }
    else { const p = agpLive.get(card.dataset.game); if (p) p.visible = true; }
  });
  agpLastFrame = performance.now();
  agpSchedule();
}

// Called when the picker is left (a game is opened, or the tab changes): stop
// animating but keep the mounted previews so coming back is instant.
function agpStopPreviews() {
  if (agpRaf != null) { cancelAnimationFrame(agpRaf); agpRaf = null; }
  agpLive.forEach(p => { p.visible = false; });
}

// ── Tetris G6 — real simulation, Dellacherie-lite stacking bot ───────────────

function agpTetrisReset(p) {
  p.st = ttInitState(agpRandSeed());
  p.rt = { sim: p.st, flashUntil: 0, playing: true };
  p.plan = [];
  p.planPiece = -1;
  p.deadFor = 0;
}

// Board score after a candidate placement (same weights the parity harness bot
// uses in scripts/tetris-parity.mjs).
function agpTetrisEval(board, clearedLines) {
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

// Rotations + sideways steps for the active piece. The fall itself is left to
// soft drops so the preview shows the piece travelling, not teleporting.
function agpTetrisPlan(st) {
  let best = null;
  for (let k = 0; k < 4; k += 1) {
    const rot = (st.rot + k) & 3;
    for (let x = -2; x <= TT_W; x += 1) {
      const probe = { ...st, board: st.board.slice(), bag: st.bag.slice(), rot, px: x };
      if (ttCollides(probe, probe.piece, probe.rot, probe.px, probe.py)) continue;
      const before = probe.lines;
      ttApplyAction(probe, TT_A_HARD, { cleared: 0, locks: 0 });
      const score = agpTetrisEval(probe.board, probe.lines - before);
      if (!best || score > best.score) best = { score, k, dx: x - st.px };
    }
  }
  if (!best) return [];
  const plan = [];
  for (let i = 0; i < best.k; i += 1) plan.push(TT_A_CW);
  const step = best.dx < 0 ? TT_A_LEFT : TT_A_RIGHT;
  for (let i = 0; i < Math.abs(best.dx); i += 1) plan.push(step);
  return plan;
}

// ── Snake — preview-only pathing bot (its real step submits a score) ─────────

function agpSnakeReset(p) {
  const seed = agpRandSeed();
  p.rt = {
    playing: true, archiveMode: false, score: 0, tick: 0, dir: 'R',
    snake: snakeInitialBody(), rng: snakeMakeRng(seed), food: null,
  };
  p.rt.food = snakeSpawnFood(p.rt);
  p.deadFor = 0;
}

// Reachable cells from (x,y), capped — enough to notice a dead end forming.
function agpSnakeFlood(rt, sx, sy, cap) {
  const blocked = new Set(rt.snake.slice(0, -1).map(snakeCellKey));
  const seen = new Set([sx + ',' + sy]);
  const queue = [[sx, sy]];
  let count = 0;
  while (queue.length && count < cap) {
    const [x, y] = queue.shift();
    count += 1;
    const around = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of around) {
      const key = nx + ',' + ny;
      if (nx < 0 || ny < 0 || nx >= SN_GRID || ny >= SN_GRID) continue;
      if (seen.has(key) || blocked.has(key)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return count;
}

function agpSnakeChooseDir(rt) {
  const head = rt.snake[0];
  const blocked = new Set(rt.snake.slice(0, -1).map(snakeCellKey));
  let best = null;
  for (const dir of ['U', 'D', 'L', 'R']) {
    if (snakeOpposite(rt.dir, dir)) continue;
    const v = SN_DIRS[dir];
    const nx = head.x + v.x, ny = head.y + v.y;
    if (nx < 0 || ny < 0 || nx >= SN_GRID || ny >= SN_GRID) continue;
    if (blocked.has(nx + ',' + ny)) continue;
    const room = agpSnakeFlood(rt, nx, ny, 80);
    const dist = rt.food ? Math.abs(nx - rt.food.x) + Math.abs(ny - rt.food.y) : 0;
    const rank = room * 100 - dist - (dir === rt.dir ? -1 : 0);
    if (!best || rank > best.rank) best = { dir, rank };
  }
  return best ? best.dir : rt.dir;
}

function agpSnakeStep(p) {
  const rt = p.rt;
  rt.dir = agpSnakeChooseDir(rt);
  const v = SN_DIRS[rt.dir];
  const head = rt.snake[0];
  const next = { x: head.x + v.x, y: head.y + v.y };
  rt.tick += 1;
  if (next.x < 0 || next.y < 0 || next.x >= SN_GRID || next.y >= SN_GRID) return false;
  const eating = rt.food && next.x === rt.food.x && next.y === rt.food.y;
  const body = eating ? rt.snake : rt.snake.slice(0, -1);
  if (body.some(part => part.x === next.x && part.y === next.y)) return false;
  rt.snake.unshift(next);
  if (eating) {
    rt.score += 1;
    rt.food = snakeSpawnFood(rt);
    if (!rt.food) return false;
  } else {
    rt.snake.pop();
  }
  return true;
}

// ── Łap Jajka — real simulation, bot chases the most advanced egg ────────────

function agpEggReset(p) {
  p.st = ecInitState(agpRandSeed());
  p.rt = { sim: p.st, playing: true, archiveMode: false, fx: [] };
  p.deadFor = 0;
}

function agpEggTargetLane(st) {
  let best = null;
  for (const egg of st.eggs) {
    if (!best || egg.step > best.step) best = egg;
  }
  return best ? best.lane : st.wolfPos;
}

// ── 3 Pary Spodni — preview-only flight model ───────────────────────────────

function agpFlappyReset(p) {
  p.rt = {
    playing: true, archiveMode: false, score: 0, pipes: 0, lives: FP_MAX_LIVES,
    player: { y: FP_CS_H / 2, vy: 0 }, obstacles: [], toasts: [],
    invincible: false, hitFlash: 0, rng: Math.random,
  };
  fpSpawnObstacle(p.rt);
  p.rt.obstacles[0].x = FP_CS_W * 0.9;
  p.deadFor = 0;
}

function agpFlappyStep(p, dt) {
  const rt = p.rt;
  const s = Math.min(dt, 40) / 1000;
  const next = rt.obstacles.find(o => o.x + FP_PIPE_W > FP_PLAYER_X - FP_PLAYER_R);
  const aim = next ? next.gapY - 6 : FP_CS_H / 2;
  if (rt.player.y > aim && rt.player.vy > -120) rt.player.vy = FP_FLAP_V;
  rt.player.vy += FP_GRAVITY * s;
  rt.player.y += rt.player.vy * s;

  rt.obstacles.forEach(o => { o.x -= FP_PIPE_SPEED * s; });
  const last = rt.obstacles[rt.obstacles.length - 1];
  if (!last || last.x < FP_CS_W - FP_PIPE_SPACING) fpSpawnObstacle(rt);
  rt.obstacles = rt.obstacles.filter(o => o.x + FP_PIPE_W > -10);

  rt.obstacles.forEach(o => {
    if (!o.scored && o.x + FP_PIPE_W < FP_PLAYER_X) {
      o.scored = true;
      rt.score += 1;
      rt.toasts.push({ text: '+1', x: FP_PLAYER_X, y: rt.player.y - 22, born: performance.now() });
    }
  });

  const hitPipe = rt.obstacles.some(o => (
    FP_PLAYER_X + FP_PLAYER_R > o.x && FP_PLAYER_X - FP_PLAYER_R < o.x + FP_PIPE_W
    && (rt.player.y - FP_PLAYER_R < o.gapY - FP_GAP / 2 || rt.player.y + FP_PLAYER_R > o.gapY + FP_GAP / 2)
  ));
  const outside = rt.player.y < 0 || rt.player.y > FP_CS_H;
  if (hitPipe || outside) agpFlappyReset(p);
}

// ── Najazd Ticketów — preview-only kiting bot ───────────────────────────────

function agpHordeReset(p) {
  const now = performance.now();
  p.rt = {
    playing: true, archiveMode: false, score: 0, tick: 0, dir: 'S',
    durationMs: IH_DURATION_MS, tickMs: IH_TICK_MS, startPerf: now, lastStepPerf: now,
    player: { x: 180, y: 180, px: 180, py: 180 }, enemies: [], rng: ihMakeRng(agpRandSeed()),
    hp: IH_START_HP, particles: [], floaters: [], shotFx: null, deathAt: 0,
  };
  p.deadFor = 0;
}

// Kite: sum a 1/d repulsion from every nearby ticket, add a pull back toward
// the middle (so the bot never corners itself against a wall, which is how a
// real player dies), and walk that way. Good enough to survive long enough for
// the swarm to build up, which is the thing worth showing.
function agpHordeChooseDir(rt) {
  const p0 = rt.player;
  let vx = (IH_ARENA / 2 - p0.x) * 0.045;
  let vy = (IH_ARENA / 2 - p0.y) * 0.045;
  for (const e of rt.enemies) {
    const dx = p0.x - e.x;
    const dy = p0.y - e.y;
    const d = Math.max(6, Math.hypot(dx, dy));
    if (d > 170) continue;
    const push = (e.boss ? 900 : 1400) / (d * d);
    vx += dx * push;
    vy += dy * push;
  }
  // Wall repulsion: the arena edges kill just as effectively as a ticket does.
  const edge = 46;
  if (p0.x < edge) vx += (edge - p0.x) * 0.06;
  if (p0.y < edge) vy += (edge - p0.y) * 0.06;
  if (p0.x > IH_ARENA - edge) vx -= (p0.x - (IH_ARENA - edge)) * 0.06;
  if (p0.y > IH_ARENA - edge) vy -= (p0.y - (IH_ARENA - edge)) * 0.06;

  const mag = Math.hypot(vx, vy);
  if (mag < 0.35) return 'S';
  const thresh = mag * 0.42;   // diagonal only when both axes really matter
  return ihDirCode(Math.abs(vx) > thresh ? vx : 0, Math.abs(vy) > thresh ? vy : 0);
}

function agpHordeStep(p) {
  const rt = p.rt;
  const tick = rt.tick + 1;
  rt.tick = tick;
  rt.dir = agpHordeChooseDir(rt);

  const p0 = rt.player;
  p0.px = p0.x; p0.py = p0.y;
  const pv = IH_DIRS[rt.dir];
  p0.x = ihClamp(p0.x + pv.x * IH_PLAYER_SPEED, 0, IH_ARENA);
  p0.y = ihClamp(p0.y + pv.y * IH_PLAYER_SPEED, 0, IH_ARENA);

  if (tick % ihSpawnInterval(tick) === 0 && rt.enemies.length < IH_ENEMY_CAP) {
    rt.enemies.push(ihSpawnEnemy(rt.rng));
  }
  if (tick % IH_BOSS_INTERVAL === 0 && rt.enemies.length < IH_ENEMY_CAP) {
    rt.enemies.push(ihSpawnBoss(rt.rng));
  }

  for (const e of rt.enemies) {
    e.px = e.x; e.py = e.y;
    const dx = p0.x - e.x;
    const dy = p0.y - e.y;
    const d = ihIsqrt(dx * dx + dy * dy);
    if (d > 0) {
      const sp = e.boss ? IH_BOSS_SPEED : IH_ENEMY_SPEED;
      e.x += Math.trunc((dx * sp) / d);
      e.y += Math.trunc((dy * sp) / d);
    }
  }

  const survivors = [];
  let died = false;
  for (const e of rt.enemies) {
    const dx = p0.x - e.x;
    const dy = p0.y - e.y;
    const hd2 = e.boss ? IH_BOSS_HIT_DIST2 : IH_HIT_DIST2;
    if (dx * dx + dy * dy <= hd2) { died = true; break; }
    survivors.push(e);
  }
  rt.enemies = survivors;
  if (died) {
    rt.deathAt = performance.now();
    rt.playing = false;
    return;
  }

  if (tick % IH_FIRE_INTERVAL === 0 && rt.enemies.length) {
    let bestIdx = -1;
    let bestD2 = IH_FIRE_RANGE2 + 1;
    for (let i = 0; i < rt.enemies.length; i += 1) {
      const dx = p0.x - rt.enemies[i].x;
      const dy = p0.y - rt.enemies[i].y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= IH_FIRE_RANGE2 && d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      const target = rt.enemies[bestIdx];
      rt.shotFx = { fx: p0.x, fy: p0.y, tx: target.x, ty: target.y, at: performance.now() };
      ihBurst(rt, target.x, target.y);
      if (target.boss) {
        target.hp -= 1;
        if (target.hp <= 0) {
          rt.enemies.splice(bestIdx, 1);
          rt.score = Math.min(IH_MAX_SCORE, rt.score + IH_BOSS_SCORE);
        }
      } else {
        rt.enemies.splice(bestIdx, 1);
        rt.score = Math.min(IH_MAX_SCORE, rt.score + 1);
      }
    }
  }
  rt.lastStepPerf = performance.now();
}

// ── Bug Jumper — real course generator, preview-only climbing bot ────────────

function agpBugReset(p) {
  p.rt = {
    playing: true, archiveMode: false, course: bjGenerateCourse(agpRandSeed()),
    score: 0, playerCol: BJ_START_COL, playerRow: 0, bestRowReached: 0,
    collisions: 0, durationMs: BJ_DURATION_MS, startPerf: performance.now(),
    hitFlash: 0, prodFlash: 0, toasts: [],
  };
}

function agpBugStep(p) {
  const rt = p.rt;
  const now = performance.now();
  const elapsed = now - rt.startPerf;
  if (elapsed > rt.durationMs - 400) { agpBugReset(p); return; }

  const course = rt.course;
  const row = rt.playerRow;
  const up = row + 1;
  // Look a little into the future so the bot commits like a human would.
  const safeAt = (r, c) => bjCellOpen(r, c, course) && !bjCellBlocked(r, c, elapsed + 140, course);

  if (up <= BJ_ROWS - 1 && safeAt(up, rt.playerCol)) {
    rt.playerRow = up;
    if (up > rt.bestRowReached) {
      rt.bestRowReached = up;
      rt.score = bjGameScore(rt);
      rt.toasts.push({ text: '+1', col: rt.playerCol, row: up, born: now, color: '#facc15' });
    }
    if (rt.playerRow >= BJ_ROWS - 1) { rt.prodFlash = now; agpBugReset(p); }
    return;
  }

  // Blocked above: shuffle toward a column that opens up next row.
  const lane = course.lanes[up - 1];
  let target = rt.playerCol;
  if (lane && !lane.safe) {
    let bestDist = Infinity;
    for (let c = lane.bandStart; c <= lane.bandEnd; c += 1) {
      if (!safeAt(up, c)) continue;
      const d = Math.abs(c - rt.playerCol);
      if (d < bestDist) { bestDist = d; target = c; }
    }
  }
  const dir = target === rt.playerCol ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(target - rt.playerCol);
  const nextCol = Math.max(0, Math.min(BJ_COLS - 1, rt.playerCol + dir));
  if (bjCellOpen(row, nextCol, course) && !bjCellBlocked(row, nextCol, elapsed + 140, course)) {
    rt.playerCol = nextCol;
  }
  // Caught by a crawler on its own line: flash and drop a row, like a real hit.
  if (bjCellBlocked(row, rt.playerCol, elapsed, course)) {
    rt.hitFlash = now;
    rt.collisions += 1;
    rt.playerRow = Math.max(0, row - 1);
  }
}

// ── VAR Patrol — locally built offside scenes through the real monitor draw ──

const AGP_VP_CLIP_MS = 850;
const AGP_VP_DECISION_MS = 760;
const AGP_VP_FEEDBACK_MS = 1100;

function agpVpRandInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Cosmetic stand-in for makeScenario() in var-patrol-action: only the shape of
// `scene` matters, since nothing here is scored.
function agpVpScenario(index) {
  const tight = Math.random() < (index > 2 ? 0.7 : 0.4);
  const gap = tight ? agpVpRandInt(2, 7) : agpVpRandInt(10, 18);
  const offside = Math.random() < 0.5;
  const defenderX = agpVpRandInt(42, 66);
  const attackerX = offside ? defenderX + gap : defenderX - gap;
  const attackerY = agpVpRandInt(32, 70);
  const defenderY = Math.max(26, Math.min(76, attackerY + agpVpRandInt(-10, 10)));
  const defenders = [{ x: defenderX, y: defenderY, label: 'D', main: true }];
  for (let i = 0; i < agpVpRandInt(3, 5); i += 1) {
    defenders.push({ x: Math.max(18, defenderX - agpVpRandInt(5, 28)), y: agpVpRandInt(28, 76), label: String((i % 4) + 2) });
  }
  const attackers = [{ x: attackerX, y: attackerY, label: 'A', main: true }];
  for (let i = 0; i < agpVpRandInt(2, 4); i += 1) {
    attackers.push({ x: Math.max(18, Math.min(82, defenderX + agpVpRandInt(-22, 14))), y: agpVpRandInt(28, 76), label: String((i % 3) + 7) });
  }
  return {
    index,
    type: 'offside',
    scene: {
      attackerX, defenderX, attackerY, defenderY,
      attackDirection: 'right', tight,
      passer: { x: agpVpRandInt(15, 24), y: agpVpRandInt(58, 78) },
      defenders, attackers,
    },
  };
}

function agpVpNext(p) {
  p.idx = (p.idx || 0) + 1;
  p.scenario = agpVpScenario(p.idx);
  p.phase = 'clip';
  p.phaseT = 0;
  p.feedback = null;
}

// ── Super Mariusz — the parity harness's verified completing run, replayed ───

// Golden input log from scripts/sm-parity.mjs: a clean 66 s run of
// super_mariusz_v2 that reaches the flag. Kept here as data so the preview is a
// real speedrun rather than a bot flailing into the first spike. If SM_COURSE
// ever changes, re-run scripts/sm-solve.mjs and paste the new log into both.
const AGP_SM_GOLDEN = [{ tick: 1, keys: 2 }, { tick: 12, keys: 6 }, { tick: 19, keys: 2 }, { tick: 35, keys: 6 }, { tick: 42, keys: 2 }, { tick: 61, keys: 6 }, { tick: 68, keys: 2 }, { tick: 89, keys: 6 }, { tick: 90, keys: 2 }, { tick: 112, keys: 6 }, { tick: 113, keys: 2 }, { tick: 134, keys: 6 }, { tick: 141, keys: 2 }, { tick: 154, keys: 6 }, { tick: 161, keys: 2 }, { tick: 175, keys: 6 }, { tick: 182, keys: 2 }, { tick: 195, keys: 6 }, { tick: 202, keys: 2 }, { tick: 216, keys: 6 }, { tick: 218, keys: 2 }, { tick: 348, keys: 6 }, { tick: 349, keys: 2 }, { tick: 369, keys: 6 }, { tick: 371, keys: 2 }, { tick: 392, keys: 6 }, { tick: 393, keys: 2 }, { tick: 410, keys: 6 }, { tick: 413, keys: 2 }, { tick: 435, keys: 6 }, { tick: 436, keys: 2 }, { tick: 456, keys: 6 }, { tick: 458, keys: 2 }, { tick: 478, keys: 6 }, { tick: 484, keys: 2 }, { tick: 590, keys: 6 }, { tick: 594, keys: 2 }, { tick: 613, keys: 6 }, { tick: 615, keys: 2 }, { tick: 630, keys: 6 }, { tick: 631, keys: 2 }, { tick: 650, keys: 6 }, { tick: 652, keys: 2 }, { tick: 665, keys: 6 }, { tick: 666, keys: 2 }, { tick: 688, keys: 6 }, { tick: 690, keys: 2 }, { tick: 706, keys: 6 }, { tick: 707, keys: 2 }, { tick: 723, keys: 6 }, { tick: 725, keys: 2 }, { tick: 741, keys: 6 }, { tick: 742, keys: 2 }, { tick: 764, keys: 6 }, { tick: 766, keys: 2 }, { tick: 781, keys: 6 }, { tick: 782, keys: 2 }, { tick: 799, keys: 6 }, { tick: 801, keys: 2 }, { tick: 819, keys: 6 }, { tick: 820, keys: 2 }, { tick: 843, keys: 6 }, { tick: 845, keys: 2 }, { tick: 857, keys: 6 }, { tick: 858, keys: 2 }, { tick: 890, keys: 6 }, { tick: 895, keys: 2 }, { tick: 915, keys: 6 }, { tick: 916, keys: 2 }, { tick: 927, keys: 6 }, { tick: 932, keys: 2 }, { tick: 948, keys: 6 }, { tick: 955, keys: 2 }, { tick: 970, keys: 6 }, { tick: 971, keys: 2 }, { tick: 982, keys: 6 }, { tick: 984, keys: 2 }, { tick: 1000, keys: 6 }, { tick: 1001, keys: 2 }, { tick: 1012, keys: 6 }, { tick: 1016, keys: 2 }, { tick: 1164, keys: 6 }, { tick: 1165, keys: 2 }, { tick: 1184, keys: 6 }, { tick: 1191, keys: 2 }, { tick: 1210, keys: 6 }, { tick: 1213, keys: 2 }, { tick: 1231, keys: 6 }, { tick: 1232, keys: 2 }, { tick: 1240, keys: 6 }, { tick: 1243, keys: 2 }, { tick: 1254, keys: 6 }, { tick: 1259, keys: 2 }, { tick: 1294, keys: 6 }, { tick: 1296, keys: 2 }, { tick: 1320, keys: 0 }];

function agpMariuszReset(p) {
  p.st = smInitState();
  p.rt = { sim: p.st, playing: true, archiveMode: false, facing: 1 };
  p.mi = 0;
  p.keys = 0;
  p.deadFor = 0;
}

// ── Uzdrowiciel G6 — real sim, triage bot, real party frames ────────────────

function agpHealerReset(p) {
  // A random class each cycle, so the card advertises all three.
  p.st = hdInitState((Date.now() ^ 0x5eed) >>> 0, Math.floor(Math.random() * HD_CLASSES.length));
  // A real healer runtime, so hdDraw()/hdConsumeFx()/hdStepFx() run unmodified
  // against it — the battlefield in the thumbnail is the battlefield in the
  // game, down to the floating combat text.
  p.rt = newHealerRuntime();
  p.rt.sim = p.st;
  p.rt.playing = true;
  p.deadFor = 0;
}

// Deliberately imperfect: it tops up whoever is lowest and answers AoE with
// Wild Growth, but never weaves for the 5-second rule — so the preview shows a
// party under real pressure with mana visibly draining, which is the game.
function agpHealerBot(st) {
  // Take the upgrade and pull straight away. A real rest is 5-15 s of full bars
  // and nothing moving — correct in game, dead air in a thumbnail — so the
  // preview stays permanently in combat, which is what it is advertising.
  if (st.phase === 'rest') {
    if (!st.upgradePicked) return [{ a: HD_A_UPGRADE, t: 0 }];
    return [{ a: HD_A_PULL, t: 0 }];
  }
  if (st.gcd > 0 || st.cast) return null;
  let low = 0, lowPct = 2;
  for (let i = 0; i < HD_PARTY; i += 1) {
    const pct = st.hp[i] / st.maxHp[i];
    if (pct < lowPct) { lowPct = pct; low = i; }
  }
  const hurt = st.hp.filter((hp, i) => hp < st.maxHp[i] * 0.8).length;
  // Slot-based, so the same bot drives whichever class the preview rolled.
  if (hurt >= 3 && st.cd[HD_SP_RAID] === 0 && st.mana >= hdCost(st, HD_SP_RAID)) return [{ a: HD_A_RAID, t: 0 }];
  if (lowPct < 0.45 && st.cd[HD_SP_BIG] === 0 && st.mana >= hdCost(st, HD_SP_BIG)) return [{ a: HD_A_BIG, t: low }];
  if (lowPct < 0.9 && st.mana >= hdCost(st, HD_SP_FILL)) return [{ a: HD_A_FILL, t: low }];
  return null;
}

// ── Zamknij Popupy! — real simulation, real popup markup, bot with a delay ───

function agpPopupReset(p) {
  p.st = ppInitState(agpRandSeed());
  p.els = new Map();
  if (p.host) p.host.querySelectorAll('.pp-popup').forEach(node => node.remove());
  p.deadFor = 0;
}

function agpPopupBotCloses(st) {
  const ready = st.open.filter(popup => st.tick + 1 >= popup.spawnTick + PP_MIN_REACTION_TICKS + 2);
  if (!ready.length) return [];
  const malware = ready.filter(popup => popup.type === 1).sort((a, b) => a.deadline - b.deadline);
  if (malware.length) return [malware[0].id];
  // Keep a couple of windows on screen so the desktop never looks empty.
  if (st.open.length <= 2 && Math.random() < 0.5) return [];
  return [ready[0].id];
}

function agpPopupRender(p) {
  const st = p.st;
  const host = p.host;
  if (!host) return;
  const openIds = new Set(st.open.map(popup => popup.id));
  p.els.forEach((node, id) => {
    if (openIds.has(id)) return;
    node.classList.add('pp-gone');
    setTimeout(() => node.remove(), 140);
    p.els.delete(id);
  });
  for (const popup of st.open) {
    if (p.els.has(popup.id)) continue;
    const node = popupPanicCreateEl(popup);
    node.style.left = (popup.x / PP_BOARD_W * 100) + '%';
    node.style.top = (popup.y / PP_BOARD_H * 100) + '%';
    host.appendChild(node);
    p.els.set(popup.id, node);
  }
  host.classList.toggle('is-danger', st.open.length >= PP_MAX_OPEN - 3);
}

// ── Whack-a-Boss — the real arena/boss markup on a preview-only schedule ─────

const AGP_WB_GAP_MS = 240;
const AGP_WB_SHOW_MS = 620;
const AGP_WB_HIT_MS = 180;

function agpWhackTarget(p) {
  const target = document.createElement('span');
  target.className = 'wb-target hidden';
  const source = document.getElementById('wb-target');
  // Reuse the game's own boss markup so the preview boss is literally the boss.
  target.innerHTML = source ? source.innerHTML : '<span class="wb-boss"></span>';
  return target;
}

function agpWhackFloat(p, x, y) {
  if (!p.host) return;
  const node = document.createElement('div');
  node.className = 'wb-float';
  node.textContent = '+1';
  node.style.left = x + '%';
  node.style.top = y + '%';
  p.host.appendChild(node);
  setTimeout(() => node.remove(), 700);
}

// ── Filler — self-contained cosmetic demo (own tiny flood-fill + bots) ───────
// Deliberately NOT the real game: a smaller board, a simpler greedy chooser,
// no shared code with games/filler.js or supabase/functions/filler-action.
// Filler is server-authoritative for every real move (see docs/filler.md),
// so there is no client-side simulation to reuse here even if we wanted to.
// Rows are half-height because the board is a DIAMOND lattice (odd rows
// offset half a tile, rows overlapping by half) — so 13x15 draws as
// 13.5 x 8, a landscape field, not a portrait one. Same shape rule as the
// real game; see games/filler.js.
const AGP_FL_COLS = 13, AGP_FL_ROWS = 15, AGP_FL_COLORS = 5;
const AGP_FL_MOVE_MS = 550;
const AGP_FL_HOLD_MS = 1400; // pause on a finished board before restarting
const AGP_FL_HEX = ['#e5484d', '#f97316', '#eab308', '#22c55e', '#06b6d4'];

// Diamond-lattice adjacency: full edges are shared only with the two tiles
// above and the two below. Mirrors filler-action's neighbors4() in rule (not
// as a parity contract — this preview is cosmetic), because a demo filling
// through tiles that visibly don't touch would advertise the wrong game.
function agpFillerNeighbors(i) {
  const x = i % AGP_FL_COLS, y = (i - x) / AGP_FL_COLS;
  const d = (y & 1) ? 0 : -1;
  const out = [];
  if (y > 0) {
    if (x + d >= 0) out.push(i - AGP_FL_COLS + d);
    if (x + d + 1 < AGP_FL_COLS) out.push(i - AGP_FL_COLS + d + 1);
  }
  if (y < AGP_FL_ROWS - 1) {
    if (x + d >= 0) out.push(i + AGP_FL_COLS + d);
    if (x + d + 1 < AGP_FL_COLS) out.push(i + AGP_FL_COLS + d + 1);
  }
  return out;
}

function agpFillerAbsorb(cells, owners, seat, color) {
  const n = cells.length;
  const seen = new Uint8Array(n);
  const q = [];
  for (let i = 0; i < n; i++) if (owners[i] === seat) { cells[i] = color; seen[i] = 1; q.push(i); }
  let head = 0, gained = 0;
  while (head < q.length) {
    const i = q[head++];
    for (const j of agpFillerNeighbors(i)) {
      if (seen[j]) continue;
      seen[j] = 1;
      if (owners[j] === -1 && cells[j] === color) { owners[j] = seat; gained++; q.push(j); }
    }
  }
  return gained;
}

function agpFillerSeatColor(cells, owners, seat) {
  for (let i = 0; i < owners.length; i++) if (owners[i] === seat) return cells[i];
  return -1;
}

// Greedy-only chooser, deliberately simpler than the real bot in
// filler-action (no frontier/denial terms) — this is cosmetic, not a
// difficulty reference.
function agpFillerChoose(cells, owners, seat) {
  const me = agpFillerSeatColor(cells, owners, seat);
  const foe = agpFillerSeatColor(cells, owners, 1 - seat);
  let best = -1, bestGain = -1;
  for (let c = 0; c < AGP_FL_COLORS; c++) {
    if (c === me || c === foe) continue;
    const gain = agpFillerAbsorb(cells.slice(), owners.slice(), seat, c);
    if (gain > bestGain) { bestGain = gain; best = c; }
  }
  return best;
}

function agpFillerNewState() {
  const n = AGP_FL_COLS * AGP_FL_ROWS;
  const cells = new Array(n);
  for (let i = 0; i < n; i++) cells[i] = Math.floor(Math.random() * AGP_FL_COLORS);
  const owners = new Array(n).fill(-1);
  const a = (AGP_FL_ROWS - 1) * AGP_FL_COLS, b = AGP_FL_COLS - 1;
  while (cells[b] === cells[a]) cells[b] = Math.floor(Math.random() * AGP_FL_COLORS);
  owners[a] = 0; owners[b] = 1;
  return { cells, owners, turn: Math.random() < 0.5 ? 0 : 1, moves: 0, done: false };
}

function agpFillerPaint(p) {
  const cells = p.st.cells;
  for (let i = 0; i < cells.length; i++) p.tiles[i].style.backgroundColor = AGP_FL_HEX[cells[i]];
}

function agpFillerStep(p) {
  const st = p.st;
  if (st.done) {
    p.doneFor = (p.doneFor || 0) + AGP_FL_MOVE_MS;
    if (p.doneFor > AGP_FL_HOLD_MS) { p.st = agpFillerNewState(); p.doneFor = 0; agpFillerPaint(p); }
    return;
  }
  const color = agpFillerChoose(st.cells, st.owners, st.turn);
  if (color === -1) { st.done = true; return; }
  agpFillerAbsorb(st.cells, st.owners, st.turn, color);
  st.moves++;
  let t0 = 0, t1 = 0, neutral = 0;
  for (const o of st.owners) { if (o === 0) t0++; else if (o === 1) t1++; else neutral++; }
  const majority = Math.floor(st.owners.length / 2) + 1;
  if (t0 >= majority || t1 >= majority || neutral === 0 || st.moves > 80) st.done = true;
  else st.turn = 1 - st.turn;
  agpFillerPaint(p);
}

// ── „Kulki G6" — real simulation, greedy-with-a-look-ahead tapping bot ───────
// bbInitState/bbPopAt are pure (no DOM, no network, no score submission), so
// the preview runs the actual game rather than a look-alike. The bot is
// deliberately not optimal — it mostly takes the biggest group, which is what a
// casual player does and what reads best as an attract mode.

const AGP_BB_MOVE_MS = 620;    // pause between taps, so a viewer can follow
const AGP_BB_HOLD_MS = 1600;   // linger on a finished board before reshuffling

// ── „Saper Maraton" ─────────────────────────────────────────────────────────
// Runs the REAL simulation (spInitState/spTick/spApplyMove are pure), driven by
// a small Minesweeper player: the two trivial deductions, then pairwise subset
// rules, then the lowest-probability guess. It therefore clears most boards and
// occasionally blows up — which is exactly what the card should advertise.
const AGP_SP_MOVE_MS = 360;    // pause between clicks, so a viewer can follow
const AGP_SP_HOLD_MS = 2600;   // how long the finished round is held on screen

function agpSaperReset(p) {
  p.st = spInitState(agpRandSeed());
  p.rt = { playing: true, sim: p.st, freeze: null, floats: [], flagMode: false };
  p.doneFor = 0;
}

function agpSaperMove(b) {
  const n = b.w * b.h;
  const cons = [];
  for (let c = 0; c < n; c += 1) {
    if (!b.open[c] || b.adj[c] <= 0) continue;
    let flags = 0;
    const hidden = [];
    for (const nb of spNeighbors(b, c)) {
      if (b.flag[nb]) flags += 1;
      else if (!b.open[nb]) hidden.push(nb);
    }
    if (hidden.length) cons.push({ cell: c, need: b.adj[c] - flags, hidden });
  }
  for (const k of cons) {
    if (k.need === 0) return [SP_CHORD, k.cell];
    if (k.need === k.hidden.length) return [SP_FLAG, k.hidden[0]];
  }
  for (const A of cons) for (const B of cons) {
    if (A === B || !A.hidden.every(h => B.hidden.includes(h))) continue;
    const diff = B.hidden.filter(h => !A.hidden.includes(h));
    if (!diff.length) continue;
    if (B.need - A.need === 0) return [SP_OPEN, diff[0]];
    if (B.need - A.need === diff.length) return [SP_FLAG, diff[0]];
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
  return [SP_OPEN, best];
}

function agpSaperStep(p) {
  const st = p.st;
  const now = performance.now();
  if (st.over) {
    // Letting `playing` go false is what makes saperDraw paint its real
    // end-of-round card — a better beat to end the attract loop on.
    p.rt.playing = false;
    p.doneFor += AGP_SP_MOVE_MS;
    if (p.doneFor > AGP_SP_HOLD_MS) agpSaperReset(p);
    return;
  }
  // Burn the clock at the rate the real game does, so the HUD counts down.
  const ticks = Math.round(AGP_SP_MOVE_MS / SP_TICK_MS);
  for (let i = 0; i < ticks && !st.over; i += 1) spTick(st);
  if (st.over) return;
  // A finished board held on screen hides the live one underneath; the real
  // game refuses input during that window and so does the bot.
  if (p.rt.freeze && p.rt.freeze.until > now) return;

  const b = st.board;
  const act = !b.placed
    ? [SP_OPEN, Math.floor(b.h / 2) * b.w + Math.floor(b.w / 2)]
    : agpSaperMove(b);
  if (!act) return;
  const clearedBefore = st.cleared;
  const scoreBefore = st.score;
  if (!spApplyMove(st, act[0], act[1])) return;
  if (b.boom) {
    p.rt.freeze = { board: b, until: now + SP_FREEZE_BOOM_MS, kind: 'boom' };
    p.rt.floats.push({ x: SP_CS_W / 2, y: SP_HUD_H + 40, until: now + SP_FLOAT_MS, text: '💥 −5 s', color: '#dc2626' });
  } else if (st.cleared > clearedBefore) {
    p.rt.freeze = { board: b, until: now + SP_FREEZE_CLEAR_MS, kind: 'clear' };
    p.rt.floats.push({ x: SP_CS_W / 2, y: SP_HUD_H + 40, until: now + SP_FLOAT_MS, text: '+' + (st.score - scoreBefore), color: '#0a7d2c' });
  }
}

function agpBubbleReset(p) {
  p.st = bbInitState(agpRandSeed());
  p.rt = { playing: true, sim: p.st, sel: null, anim: null, burst: [], floats: [] };
  p.doneFor = 0;
}

// All distinct poppable groups on the board, largest first.
function agpBubbleGroups(cells) {
  const seen = new Set();
  const groups = [];
  for (let i = 0; i < cells.length; i += 1) {
    if (cells[i] < 0 || seen.has(i)) continue;
    const g = bbGroupAt(cells, i);
    g.forEach(x => seen.add(x));
    if (g.length >= BB_MIN_GROUP) groups.push(g);
  }
  return groups.sort((a, b) => b.length - a.length);
}

function agpBubbleStep(p) {
  const st = p.st;
  const now = performance.now();
  if (st.over) {
    p.rt.playing = false;
    p.doneFor += AGP_BB_MOVE_MS;
    if (p.doneFor > AGP_BB_HOLD_MS) agpBubbleReset(p);
    return;
  }
  const groups = agpBubbleGroups(st.cells);
  // Letting `playing` go false is what makes bubbleBreakerDraw paint its real
  // game-over card — a nicer beat to end the attract loop on than a dead board.
  if (!groups.length) { st.over = true; p.rt.playing = false; return; }

  // Show the selection for one beat before popping it — the highlight ring is
  // half of what this game looks like, so an attract mode that skipped it
  // would advertise the wrong thing.
  if (!p.rt.sel) {
    const pick = groups[Math.random() < 0.75 ? 0 : Math.min(1, groups.length - 1)];
    p.rt.sel = { anchor: pick[0], group: pick, gain: bbGroupScore(pick.length) };
    return;
  }
  const idx = p.rt.sel.anchor;
  const color = st.cells[idx];
  const res = bbPopAt(st, idx);
  p.rt.sel = null;
  if (!res) return;
  res.group.forEach(i => p.rt.burst.push({ idx: i, color, until: now + BB_BURST_MS }));
  p.rt.anim = { until: now + BB_FALL_MS, moves: res.moved };
  const at = { x: (idx % BB_COLS) * BB_CELL + BB_CELL / 2, y: BB_HUD_H + Math.floor(idx / BB_COLS) * BB_CELL + BB_CELL / 2 };
  p.rt.floats.push({ x: at.x, y: at.y, until: now + BB_FLOAT_MS, text: '+' + res.gained });
}

// ── Definitions ─────────────────────────────────────────────────────────────

const AGP_DEFS = {
  whack_boss: {
    dep: null, dom: true, vw: 480, vh: 270,
    init(p) {
      p.host.className = 'ag-prev-dom wb-arena playing';
      p.host.style.width = p.vw + 'px';
      p.host.style.height = p.vh + 'px';
      p.target = agpWhackTarget(p);
      p.host.appendChild(p.target);
      p.phase = 'gap';
      p.phaseT = 0;
    },
    step(p, dt) {
      p.phaseT += dt;
      const target = p.target;
      if (p.phase === 'gap' && p.phaseT >= AGP_WB_GAP_MS) {
        p.x = 12 + Math.random() * 76;
        p.y = 16 + Math.random() * 68;
        target.style.left = p.x + '%';
        target.style.top = p.y + '%';
        target.classList.remove('hidden', 'whacked');
        target.classList.add('pop');
        p.phase = 'show';
        p.phaseT = 0;
      } else if (p.phase === 'show' && p.phaseT >= AGP_WB_SHOW_MS) {
        target.classList.remove('pop');
        target.classList.add('whacked');
        agpWhackFloat(p, p.x, p.y);
        p.phase = 'hit';
        p.phaseT = 0;
      } else if (p.phase === 'hit' && p.phaseT >= AGP_WB_HIT_MS) {
        target.classList.add('hidden');
        target.classList.remove('whacked');
        p.phase = 'gap';
        p.phaseT = 0;
      }
    },
    draw() { /* DOM-driven: the step above is the frame */ },
  },

  bug_jumper: {
    dep: 'bug_jumper', pixelArt: true,
    size: () => [BJ_CS_W, BJ_CS_H],
    // 56 columns squeezed into a thumbnail is unreadable soup — follow the
    // climber instead, the way a spectator would.
    view: p => ({
      zoom: 2.6,
      cx: p.rt.playerCol * BJ_CELL + BJ_CELL / 2,
      cy: (BJ_ROWS - 1 - p.rt.playerRow) * BJ_CELL + BJ_CELL / 2,
    }),
    init(p) { agpBugReset(p); },
    step(p, dt) {
      p.acc += dt;
      while (p.acc >= 230) { p.acc -= 230; agpBugStep(p); }
    },
    draw(p) {
      const oc = bjCtx, ort = bugJumperRuntime;
      bjCtx = p.ctx; bugJumperRuntime = p.rt;
      try { bjDraw(performance.now()); } finally { bjCtx = oc; bugJumperRuntime = ort; }
    },
  },

  flappy_pants: {
    dep: 'flappy_pants',
    size: () => [FP_CS_W, FP_CS_H],
    init(p) { agpFlappyReset(p); },
    step(p, dt) { agpFlappyStep(p, dt); },
    draw(p) {
      const oc = fpCtx, ort = flappyPantsRuntime;
      fpCtx = p.ctx; flappyPantsRuntime = p.rt;
      try { fpDraw(performance.now()); } finally { fpCtx = oc; flappyPantsRuntime = ort; }
    },
  },

  snake: {
    dep: 'snake', pixelArt: true,
    size: () => [SN_CS, SN_CS],
    init(p) { agpSnakeReset(p); },
    step(p, dt) {
      p.acc += dt;
      while (p.acc >= SN_TICK_MS) {
        p.acc -= SN_TICK_MS;
        if (p.deadFor) {
          p.deadFor += SN_TICK_MS;
          if (p.deadFor > 900) agpSnakeReset(p);
        } else if (!agpSnakeStep(p)) {
          p.deadFor = 1;
        }
      }
    },
    draw(p) {
      const oc = snCtx, ort = snakeRuntime;
      snCtx = p.ctx; snakeRuntime = p.rt;
      try { snakeDraw(performance.now()); } finally { snCtx = oc; snakeRuntime = ort; }
    },
  },

  invoice_horde: {
    dep: 'invoice_horde',
    size: () => [IH_CS, IH_CS],
    init(p) { agpHordeReset(p); },
    step(p, dt) {
      p.acc += dt;
      while (p.acc >= IH_TICK_MS) {
        p.acc -= IH_TICK_MS;
        if (p.rt.playing) agpHordeStep(p);
        else {
          p.deadFor += IH_TICK_MS;
          if (p.deadFor > 800) agpHordeReset(p);
        }
      }
    },
    draw(p) {
      const oc = ihCtx, ort = invoiceHordeRuntime;
      ihCtx = p.ctx; invoiceHordeRuntime = p.rt;
      try { ihDraw(performance.now()); } finally { ihCtx = oc; invoiceHordeRuntime = ort; }
    },
  },

  var_patrol: {
    dep: 'var_patrol', raw: true, vw: 480, vh: 270,
    size: () => [480, 270],
    init(p) { p.idx = 0; agpVpNext(p); },
    step(p, dt) {
      p.phaseT += dt;
      if (p.phase === 'clip' && p.phaseT >= AGP_VP_CLIP_MS) {
        p.phase = 'decision';
        p.phaseT = 0;
      } else if (p.phase === 'decision' && p.phaseT >= AGP_VP_DECISION_MS) {
        const correct = Math.random() < 0.85;
        p.feedback = {
          isCorrect: correct,
          message: correct
            ? (p.scenario.scene.attackerX > p.scenario.scene.defenderX ? 'Napastnik przed obrońcą' : 'Równa linia — gra')
            : 'Sprawdź linię ostatniego obrońcy',
        };
        p.phase = 'feedback';
        p.phaseT = 0;
      } else if (p.phase === 'feedback' && p.phaseT >= AGP_VP_FEEDBACK_MS) {
        agpVpNext(p);
      }
    },
    draw(p) {
      const ort = varPatrolRuntime;
      varPatrolRuntime = { phase: p.phase, phaseStartedAt: 0, feedback: p.feedback, playing: true };
      const progress = p.phase === 'clip' ? Math.min(1, p.phaseT / AGP_VP_CLIP_MS) : 1;
      try { vpDrawMonitor(p.ctx, p.scenario, p.phase, progress); } finally { varPatrolRuntime = ort; }
    },
  },

  egg_catch: {
    dep: 'egg_catch',
    size: () => [EC_CS_W, EC_CS_H],
    init(p) { agpEggReset(p); },
    step(p, dt) {
      p.acc += dt;
      while (p.acc >= EC_TICK_MS) {
        p.acc -= EC_TICK_MS;
        const st = p.st;
        if (st.misses >= EC_MAX_MISSES) {
          p.deadFor += EC_TICK_MS;
          if (p.deadFor > 1100) agpEggReset(p);
          continue;
        }
        const want = agpEggTargetLane(st);
        const ev = ecAdvanceTick(st, want === st.wolfPos ? null : want);
        ev.caught.forEach(lane => p.rt.fx.push({ kind: 'caught', lane, untilTick: st.tick + 3 }));
        ev.broken.forEach(lane => p.rt.fx.push({ kind: 'broken', lane, untilTick: st.tick + 5 }));
        p.rt.fx = p.rt.fx.filter(f => f.untilTick > st.tick);
      }
    },
    draw(p) {
      const oc = ecCtx, ort = eggCatchRuntime;
      ecCtx = p.ctx; eggCatchRuntime = p.rt;
      try { eggCatchDraw(); } finally { ecCtx = oc; eggCatchRuntime = ort; }
    },
  },

  super_mariusz: {
    dep: 'super_mariusz', pixelArt: true,
    size: () => [SM_CS_W, SM_CS_H],
    init(p) { agpMariuszReset(p); },
    step(p, dt) {
      p.acc += dt;
      while (p.acc >= SM_TICK_MS) {
        p.acc -= SM_TICK_MS;
        const st = p.st;
        if (st.dead || st.finished || st.tick >= 1400) {
          p.deadFor += SM_TICK_MS;
          if (p.deadFor > 1400) agpMariuszReset(p);
          continue;
        }
        const nextTick = st.tick + 1;
        while (p.mi < AGP_SM_GOLDEN.length && AGP_SM_GOLDEN[p.mi].tick <= nextTick) {
          p.keys = AGP_SM_GOLDEN[p.mi].keys;
          p.mi += 1;
        }
        smAdvanceTick(st, p.keys);
      }
    },
    draw(p) {
      const oc = smCtx, ort = superMariuszRuntime;
      smCtx = p.ctx; superMariuszRuntime = p.rt;
      try { smDraw(); } finally { smCtx = oc; superMariuszRuntime = ort; }
    },
  },

  bubble_breaker: {
    dep: 'bubble_breaker',
    size: () => [BB_CS_W, BB_CS_H],
    init(p) { agpBubbleReset(p); },
    step(p, dt) {
      p.acc += dt;
      while (p.acc >= AGP_BB_MOVE_MS) {
        p.acc -= AGP_BB_MOVE_MS;
        agpBubbleStep(p);
      }
    },
    draw(p) {
      const oc = bbCtx, ort = bubbleBreakerRuntime;
      bbCtx = p.ctx; bubbleBreakerRuntime = p.rt;
      try { bubbleBreakerDraw(performance.now()); } finally { bbCtx = oc; bubbleBreakerRuntime = ort; }
    },
  },

  saper: {
    dep: 'saper',
    size: () => [SP_CS_W, SP_CS_H],
    init(p) { agpSaperReset(p); },
    step(p, dt) {
      p.acc += dt;
      while (p.acc >= AGP_SP_MOVE_MS) {
        p.acc -= AGP_SP_MOVE_MS;
        agpSaperStep(p);
      }
    },
    draw(p) {
      const oc = spCtx, ort = saperRuntime;
      spCtx = p.ctx; saperRuntime = p.rt;
      try { saperDraw(performance.now()); } finally { spCtx = oc; saperRuntime = ort; }
    },
  },

  popup_panic: {
    dep: 'popup_panic', dom: true, vw: 640, vh: 373,
    init(p) {
      p.host.className = 'ag-prev-dom pp-arena is-playing';
      p.host.style.width = p.vw + 'px';
      p.host.style.height = p.vh + 'px';
      const bar = document.querySelector('#pp-arena .pp-taskbar');
      if (bar) p.host.appendChild(bar.cloneNode(true));
      agpPopupReset(p);
    },
    step(p, dt) {
      p.acc += dt;
      while (p.acc >= PP_TICK_MS) {
        p.acc -= PP_TICK_MS;
        const st = p.st;
        if (st.dead || st.tick >= PP_ROUND_TICKS) {
          p.deadFor += PP_TICK_MS;
          if (p.deadFor > 1200) agpPopupReset(p);
          continue;
        }
        ppAdvanceTick(st, agpPopupBotCloses(st));
      }
      agpPopupRender(p);
    },
    draw() { /* DOM-driven */ },
  },

  // „Uzdrowiciel G6" — the real hdAdvanceTick driven by a small triage bot,
  // rendered through the game's own hdDraw() on the HoMM3 hex battlefield. It
  // used to be a DOM preview that rebuilt three raid frames by hand; the party
  // is five strong now and the frames are only half the screen, so the preview
  // shows the thing worth showing and stays honest by construction.
  healer_dungeon: {
    dep: 'healer_dungeon',
    size: () => [HD_CS_W, HD_CS_H],
    init(p) { agpHealerReset(p); },
    step(p, dt) {
      p.acc += dt;
      while (p.acc >= HD_TICK_MS) {
        p.acc -= HD_TICK_MS;
        const st = p.st;
        if (st.dead || st.tick >= 2400) {
          p.deadFor += HD_TICK_MS;
          if (p.deadFor > 1200) agpHealerReset(p);
          continue;
        }
        hdAdvanceTick(st, agpHealerBot(st));
        hdConsumeFx(p.rt);
      }
      hdStepFx(p.rt, dt);
    },
    draw(p) {
      const oc = hdCtx, ort = healerRuntime;
      hdCtx = p.ctx; healerRuntime = p.rt;
      try { hdDraw(); } finally { hdCtx = oc; healerRuntime = ort; }
    },
  },

  tetris: {
    dep: 'tetris',
    size: () => [TT_CS_W, TT_CS_H],
    init(p) { agpTetrisReset(p); },
    step(p, dt) {
      p.acc += dt;
      while (p.acc >= TT_TICK_MS) {
        p.acc -= TT_TICK_MS;
        const st = p.st;
        // a real round also ends on the 60 s clock — restart there too, or the
        // preview would sit forever on a 0 s countdown
        if (st.dead || st.tick >= TT_MAX_TICKS) {
          p.deadFor += TT_TICK_MS;
          if (p.deadFor > 1200) agpTetrisReset(p);
          continue;
        }
        if (st.pieces !== p.planPiece) { p.plan = agpTetrisPlan(st); p.planPiece = st.pieces; }
        let acts = [];
        if (p.plan.length) acts = [p.plan.shift()];
        else if (st.tick % 2 === 0) acts = [TT_A_SOFT];   // visible descent, not a teleport
        ttAdvanceTick(st, acts);
      }
    },
    draw(p) {
      const oc = ttCtx, ort = tetrisRuntime;
      ttCtx = p.ctx; tetrisRuntime = p.rt;
      try { tetrisDraw(); } finally { ttCtx = oc; tetrisRuntime = ort; }
    },
  },

  filler: {
    dep: null, dom: true, vw: 480, vh: 270,
    init(p) {
      p.host.className = 'ag-prev-dom fl-prev';
      p.host.style.display = 'block';
      p.host.style.position = 'relative';
      p.host.replaceChildren();
      p.tiles = [];
      const n = AGP_FL_COLS * AGP_FL_ROWS;
      // Absolute placement on the diamond lattice — positions never change,
      // so they are set once here and only the color is touched per frame.
      const cw = AGP_FL_COLS + 0.5, ch = (AGP_FL_ROWS + 1) / 2;
      for (let i = 0; i < n; i++) {
        const x = i % AGP_FL_COLS, y = (i - x) / AGP_FL_COLS;
        const d = document.createElement('div');
        d.className = 'fl-prev-cell';
        d.style.left = ((x + ((y & 1) ? 0.5 : 0)) / cw * 100) + '%';
        d.style.top = ((y / 2) / ch * 100) + '%';
        d.style.width = (1 / cw * 100) + '%';
        d.style.height = (1 / ch * 100) + '%';
        p.host.appendChild(d);
        p.tiles.push(d);
      }
      p.st = agpFillerNewState();
      p.doneFor = 0;
      agpFillerPaint(p);
    },
    step(p, dt) {
      p.acc += dt;
      while (p.acc >= AGP_FL_MOVE_MS) { p.acc -= AGP_FL_MOVE_MS; agpFillerStep(p); }
    },
    draw(p) {}, // DOM preview — mutations happen directly in step()/agpFillerPaint()
  },
};
