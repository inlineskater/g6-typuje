// ── „Tetris G6" (tetris) — classic falling-block stacker in a 10×20 well ─────
// PARITY CONTRACT: the TT_* constants and ttInitState / ttRng / ttDrawPiece /
// ttCollides / ttSpawn / ttLockPiece / ttTryMove / ttTryRotate / ttGrounded /
// ttTouchLock / ttApplyAction / ttAdvanceTick below must stay byte-for-byte
// equivalent to the block in supabase/functions/tetris-action/index.ts. The
// client plays this exact deterministic simulation (seeded LCG 7-bag) and logs
// only the actions it took per tick; the server replays seed + events to derive
// the trusted score. Rendering constants (TT_CS_*, TT_COLORS, DAS/ARR) are
// client-only and NOT part of the contract.
const TT_TICK_MS = 50;
const TT_W = 10;                   // well width in cells
const TT_H = 20;                   // well height in cells
const TT_SPAWN_X = 3;              // x of the 4×4 piece box at spawn
const TT_MAX_TICKS = 12000;        // 10 min hard cap
const TT_MAX_EVENTS = 12000;       // max input events accepted per round
const TT_MAX_ACTIONS_PER_TICK = 6; // more than this inside one 50 ms tick is bot-grade spam
const TT_MAX_SCORE = 999999;       // anti-cheat ceiling
const TT_LOCK_TICKS = 10;          // 0.5 s lock delay once the piece is grounded
const TT_MAX_LOCK_RESETS = 12;     // a move/rotate can refresh the lock delay this often
const TT_LINES_PER_LEVEL = 10;
const TT_MAX_LEVEL = 15;
const TT_LINE_SCORES = [0, 100, 300, 500, 800]; // × level
const TT_SOFT_DROP_POINTS = 1;     // per cell
const TT_HARD_DROP_POINTS = 2;     // per cell
const TT_KICKS = [0, -1, 1, -2, 2]; // horizontal wall-kick offsets tried on rotation

// Actions — the only thing the client logs.
const TT_A_LEFT = 0, TT_A_RIGHT = 1, TT_A_CW = 2, TT_A_CCW = 3, TT_A_SOFT = 4, TT_A_HARD = 5;

// Each piece is 4 rotation states as a 4×4 bitmask; bit 0x8000 is the top-left
// cell, reading left→right then top→bottom.
const TT_PIECES = [
  [0x0F00, 0x2222, 0x00F0, 0x4444], // I
  [0x8E00, 0x6440, 0x0E20, 0x44C0], // J
  [0x2E00, 0x4460, 0x0E80, 0xC440], // L
  [0x6600, 0x6600, 0x6600, 0x6600], // O
  [0x6C00, 0x4620, 0x06C0, 0x8C40], // S
  [0x4E00, 0x4640, 0x0E40, 0x4C40], // T
  [0xC600, 0x2640, 0x0C60, 0x4C80], // Z
];

function ttGravityTicks(level) {
  return Math.max(2, 21 - level * 2);
}

function ttRng(st) {
  st.rngState = (Math.imul(st.rngState, 1664525) + 1013904223) >>> 0;
  return st.rngState / 4294967296;
}

// 7-bag: refill + Fisher-Yates shuffle off the shared rng, then pop.
function ttDrawPiece(st) {
  if (!st.bag.length) {
    st.bag = [0, 1, 2, 3, 4, 5, 6];
    for (let i = st.bag.length - 1; i > 0; i -= 1) {
      const j = Math.floor(ttRng(st) * (i + 1));
      const tmp = st.bag[i]; st.bag[i] = st.bag[j]; st.bag[j] = tmp;
    }
  }
  return st.bag.pop();
}

function ttCollides(st, piece, rot, px, py) {
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

function ttSpawn(st) {
  st.piece = st.next;
  st.next = ttDrawPiece(st);
  st.rot = 0;
  st.px = TT_SPAWN_X;
  st.py = 0;
  st.gravity = 0;
  st.lockTimer = -1;
  st.lockResets = 0;
  st.pieces += 1;
  if (ttCollides(st, st.piece, st.rot, st.px, st.py)) st.dead = true;
}

function ttInitState(seed) {
  const st = {
    rngState: (Number(seed) >>> 0) || 1,
    tick: 0,
    board: new Array(TT_W * TT_H).fill(0), // 0 = empty, else piece index + 1
    bag: [],
    piece: 0, next: 0, rot: 0, px: TT_SPAWN_X, py: 0,
    gravity: 0,
    lockTimer: -1,  // -1 = airborne
    lockResets: 0,
    lines: 0, level: 1, score: 0, pieces: 0,
    dead: false,
  };
  st.next = ttDrawPiece(st);
  ttSpawn(st);
  return st;
}

function ttLockPiece(st, ev) {
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
    y += 1; // rows shifted down — re-test this line
  }
  if (cleared > 0) {
    st.lines += cleared;
    st.score += TT_LINE_SCORES[cleared] * st.level;
    st.level = Math.min(TT_MAX_LEVEL, 1 + Math.floor(st.lines / TT_LINES_PER_LEVEL));
  }
  if (ev) { ev.locks += 1; ev.cleared += cleared; }
  ttSpawn(st);
}

function ttTryMove(st, dx, dy) {
  if (ttCollides(st, st.piece, st.rot, st.px + dx, st.py + dy)) return false;
  st.px += dx;
  st.py += dy;
  return true;
}

function ttTryRotate(st, dir) {
  const nrot = (st.rot + (dir > 0 ? 1 : 3)) & 3;
  for (let i = 0; i < TT_KICKS.length; i += 1) {
    const nx = st.px + TT_KICKS[i];
    if (!ttCollides(st, st.piece, nrot, nx, st.py)) { st.rot = nrot; st.px = nx; return true; }
  }
  return false;
}

function ttGrounded(st) {
  return ttCollides(st, st.piece, st.rot, st.px, st.py + 1);
}

// A successful move/rotate refreshes the lock delay a limited number of times.
function ttTouchLock(st) {
  if (st.lockTimer >= 0 && st.lockResets < TT_MAX_LOCK_RESETS) {
    st.lockTimer = 0;
    st.lockResets += 1;
  }
}

function ttApplyAction(st, a, ev) {
  if (st.dead) return;
  if (a === TT_A_LEFT)  { if (ttTryMove(st, -1, 0)) ttTouchLock(st); return; }
  if (a === TT_A_RIGHT) { if (ttTryMove(st, 1, 0))  ttTouchLock(st); return; }
  if (a === TT_A_CW)    { if (ttTryRotate(st, 1))   ttTouchLock(st); return; }
  if (a === TT_A_CCW)   { if (ttTryRotate(st, -1))  ttTouchLock(st); return; }
  if (a === TT_A_SOFT) {
    if (ttTryMove(st, 0, 1)) { st.score += TT_SOFT_DROP_POINTS; st.gravity = 0; }
    return;
  }
  if (a === TT_A_HARD) {
    let dist = 0;
    while (ttTryMove(st, 0, 1)) dist += 1;
    st.score += dist * TT_HARD_DROP_POINTS;
    ttLockPiece(st, ev);
  }
}

// One simulation tick: the player's actions for THIS tick (in press order),
// then gravity, then the lock-delay countdown.
function ttAdvanceTick(st, actions) {
  st.tick += 1;
  const ev = { cleared: 0, locks: 0 };
  if (actions && actions.length) {
    for (let i = 0; i < actions.length; i += 1) {
      ttApplyAction(st, actions[i], ev);
      if (st.dead) return ev;
    }
  }
  st.gravity += 1;
  if (st.gravity >= ttGravityTicks(st.level)) {
    st.gravity = 0;
    ttTryMove(st, 0, 1);
  }
  if (ttGrounded(st)) {
    st.lockTimer = st.lockTimer < 0 ? 0 : st.lockTimer + 1;
    if (st.lockTimer >= TT_LOCK_TICKS) ttLockPiece(st, ev);
  } else {
    st.lockTimer = -1;
    st.lockResets = 0;
  }
  return ev;
}

// ── Rendering (client-only) ─────────────────────────────────────────────────
const TT_CELL = 24;
const TT_PAD = 10;
const TT_WELL_W = TT_W * TT_CELL;              // 240
const TT_WELL_H = TT_H * TT_CELL;              // 480
const TT_CS_W = TT_PAD * 2 + TT_WELL_W + 80;   // 340
const TT_CS_H = TT_PAD * 2 + TT_WELL_H;        // 500
const TT_SIDE_X = TT_PAD + TT_WELL_W + 12;
const TT_MAX_DPR = 2;
const TT_COLORS = ['#22d3ee', '#3b82f6', '#f59e0b', '#facc15', '#22c55e', '#a855f7', '#ef4444'];
// Auto-repeat while a direction key is held (delayed auto shift / auto repeat rate).
const TT_DAS_MS = 150;
const TT_ARR_MS = 45;
const TT_MAX_CATCHUP_TICKS = 4; // schedule debt above this is dropped, not replayed

let ttCtx = null;

function tetrisInitCanvas() {
  const canvas = document.getElementById('tt-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const DPR = Math.min(window.devicePixelRatio || 1, TT_MAX_DPR);
  const w = Math.round((rect.width || TT_CS_W) * DPR);
  const h = Math.round((rect.height || TT_CS_H) * DPR);
  if (!ttCtx || canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    ttCtx = canvas.getContext('2d');
  }
  ttCtx.setTransform(w / TT_CS_W, 0, 0, h / TT_CS_H, 0, 0);
}

function ttDrawBlock(ctx, x, y, size, color, ghost) {
  if (ghost) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 2, y + 2, size - 4, size - 4);
    ctx.globalAlpha = 1;
    return;
  }
  ctx.fillStyle = color;
  ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ctx.fillRect(x + 1, y + 1, size - 2, 3);
  ctx.fillRect(x + 1, y + 1, 3, size - 2);
  ctx.fillStyle = 'rgba(0,0,0,.28)';
  ctx.fillRect(x + 1, y + size - 4, size - 2, 3);
  ctx.fillRect(x + size - 4, y + 1, 3, size - 2);
}

function ttDrawPieceMask(ctx, piece, rot, ox, oy, size, ghost) {
  const mask = TT_PIECES[piece][rot & 3];
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      if (!(mask & (0x8000 >> (r * 4 + c)))) continue;
      ttDrawBlock(ctx, ox + c * size, oy + r * size, size, TT_COLORS[piece], ghost);
    }
  }
}

function tetrisDraw() {
  const rt = tetrisRuntime;
  if (!ttCtx) tetrisInitCanvas();
  const ctx = ttCtx;
  if (!ctx) return;
  const st = rt?.sim;

  ctx.clearRect(0, 0, TT_CS_W, TT_CS_H);

  // well background + grid
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(TT_PAD, TT_PAD, TT_WELL_W, TT_WELL_H);
  ctx.strokeStyle = 'rgba(148,163,184,.10)';
  ctx.lineWidth = 1;
  for (let x = 1; x < TT_W; x += 1) {
    ctx.beginPath();
    ctx.moveTo(TT_PAD + x * TT_CELL + .5, TT_PAD);
    ctx.lineTo(TT_PAD + x * TT_CELL + .5, TT_PAD + TT_WELL_H);
    ctx.stroke();
  }
  for (let y = 1; y < TT_H; y += 1) {
    ctx.beginPath();
    ctx.moveTo(TT_PAD, TT_PAD + y * TT_CELL + .5);
    ctx.lineTo(TT_PAD + TT_WELL_W, TT_PAD + y * TT_CELL + .5);
    ctx.stroke();
  }

  if (st) {
    // settled blocks
    for (let y = 0; y < TT_H; y += 1) {
      for (let x = 0; x < TT_W; x += 1) {
        const v = st.board[y * TT_W + x];
        if (!v) continue;
        ttDrawBlock(ctx, TT_PAD + x * TT_CELL, TT_PAD + y * TT_CELL, TT_CELL, TT_COLORS[v - 1], false);
      }
    }
    if (!st.dead) {
      // ghost drop position
      let gy = st.py;
      while (!ttCollides(st, st.piece, st.rot, st.px, gy + 1)) gy += 1;
      if (gy !== st.py) {
        ttDrawPieceMask(ctx, st.piece, st.rot, TT_PAD + st.px * TT_CELL, TT_PAD + gy * TT_CELL, TT_CELL, true);
      }
      ttDrawPieceMask(ctx, st.piece, st.rot, TT_PAD + st.px * TT_CELL, TT_PAD + st.py * TT_CELL, TT_CELL, false);
    }
    // line-clear flash (cosmetic, never read by the sim)
    if (rt.flashUntil > performance.now() && !tetrisReducedMotion()) {
      ctx.fillStyle = 'rgba(255,255,255,.22)';
      ctx.fillRect(TT_PAD, TT_PAD, TT_WELL_W, TT_WELL_H);
    }
  }

  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 2;
  ctx.strokeRect(TT_PAD - 1, TT_PAD - 1, TT_WELL_W + 2, TT_WELL_H + 2);

  // side panel: next piece + level
  ctx.fillStyle = '#94a3b8';
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('NASTĘPNY', TT_SIDE_X, TT_PAD + 12);
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(TT_SIDE_X, TT_PAD + 20, 68, 60);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(TT_SIDE_X + .5, TT_PAD + 20.5, 68, 60);
  if (st && !st.dead) {
    ttDrawPieceMask(ctx, st.next, 0, TT_SIDE_X + 6, TT_PAD + 28, 14, false);
  }
  if (st) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.fillText('POZIOM', TT_SIDE_X, TT_PAD + 108);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '900 22px system-ui, sans-serif';
    ctx.fillText(String(st.level), TT_SIDE_X, TT_PAD + 132);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.fillText('LINIE', TT_SIDE_X, TT_PAD + 162);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '900 22px system-ui, sans-serif';
    ctx.fillText(String(st.lines), TT_SIDE_X, TT_PAD + 186);
    // next level in: how many more lines until gravity steps up
    if (st.level < TT_MAX_LEVEL) {
      ctx.fillStyle = '#64748b';
      ctx.font = '700 9px system-ui, sans-serif';
      ctx.fillText('do ' + (st.level + 1) + ' lvl: ' + (st.level * TT_LINES_PER_LEVEL - st.lines), TT_SIDE_X, TT_PAD + 204);
    }
  }
}

function tetrisReducedMotion() {
  return typeof plinkoReducedMotion === 'function' ? plinkoReducedMotion() : false;
}

// ── Handheld fullscreen ─────────────────────────────────────────────────────
// On phones/tablets a round always opens fullscreen: the well needs the height,
// and the touch pad needs thumb-sized targets. The `.tt-fs` CSS class is the
// real mechanism (iOS Safari has no element Fullscreen API at all); the native
// request is layered on top purely to hide the browser chrome where it works.
// The breakpoint below mirrors the one that shows .tt-pad in index.html.
function tetrisIsHandheld() {
  return !window.matchMedia('(min-width: 780px) and (hover: hover)').matches;
}

function tetrisPanel() {
  return document.getElementById('seasonal-game-tetris')?.querySelector('.bj-game-panel') || null;
}

function tetrisEnterFullscreen() {
  const panel = tetrisPanel();
  if (!panel || panel.classList.contains('tt-fs')) return;
  panel.classList.add('tt-fs');
  document.body.classList.add('tt-fs-open');
  const req = panel.requestFullscreen || panel.webkitRequestFullscreen;
  if (req) {
    try {
      const res = req.call(panel);
      panel.dataset.ttRealFs = '1';
      if (res && typeof res.catch === 'function') res.catch(() => { delete panel.dataset.ttRealFs; });
    } catch (e) { delete panel.dataset.ttRealFs; }
  }
  requestAnimationFrame(() => { tetrisInitCanvas(); tetrisDraw(); });
}

function tetrisExitFullscreen() {
  const panel = tetrisPanel();
  if (panel) { panel.classList.remove('tt-fs'); delete panel.dataset.ttRealFs; }
  document.body.classList.remove('tt-fs-open');
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) {
      try {
        const res = exit.call(document);
        if (res && typeof res.catch === 'function') res.catch(() => {});
      } catch (e) { /* already out */ }
    }
  }
  requestAnimationFrame(() => { tetrisInitCanvas(); tetrisDraw(); });
}

// Native fullscreen left by the system back gesture / Esc — drop our class too.
function tetrisOnFullscreenChange() {
  const panel = tetrisPanel();
  if (!panel) return;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fsEl && panel.dataset.ttRealFs === '1') tetrisExitFullscreen();
  else requestAnimationFrame(() => { tetrisInitCanvas(); tetrisDraw(); });
}
document.addEventListener('fullscreenchange', tetrisOnFullscreenChange);
document.addEventListener('webkitfullscreenchange', tetrisOnFullscreenChange);

// ── Runtime ─────────────────────────────────────────────────────────────────
function newTetrisRuntime() {
  return {
    playing: false, submitting: false, archiveMode: false,
    roundId: null,
    seed: 1,
    timer: null,
    nextTickAt: 0,
    sim: ttInitState(1),
    eventLog: [],       // { tick, a }
    queued: [],         // actions queued for the upcoming tick
    queuedTick: 0,
    held: {},           // key -> { action, repeatAt } for DAS auto-repeat
    softHeld: false,
    flashUntil: 0,
    endedReason: '',
  };
}

function tetrisSetStats() {
  const st = tetrisRuntime?.sim;
  if (!st) return;
  if (ttScoreEl) ttScoreEl.textContent = String(Math.min(TT_MAX_SCORE, st.score));
  if (ttLinesEl) ttLinesEl.textContent = String(st.lines);
  if (ttLevelEl) ttLevelEl.textContent = String(st.level);
}

function tetrisQueueAction(a) {
  const rt = tetrisRuntime;
  if (!rt?.playing || rt.sim.dead) return;
  if (rt.eventLog.length >= TT_MAX_EVENTS) return;
  const tick = rt.sim.tick + 1;
  if (rt.queuedTick !== tick) { rt.queued = []; rt.queuedTick = tick; }
  if (rt.queued.length >= TT_MAX_ACTIONS_PER_TICK) return;
  rt.queued.push(a);
  rt.eventLog.push({ tick, a });
}

function tetrisTick() {
  const rt = tetrisRuntime;
  if (!rt?.playing) return;
  const st = rt.sim;

  // held-direction auto-repeat (client-only; each repeat is a normal action)
  const now = performance.now();
  for (const key of Object.keys(rt.held)) {
    const h = rt.held[key];
    if (now >= h.repeatAt) {
      tetrisQueueAction(h.action);
      h.repeatAt = now + TT_ARR_MS;
    }
  }
  if (rt.softHeld) tetrisQueueAction(TT_A_SOFT);

  const nextTick = st.tick + 1;
  let acts = null;
  if (rt.queued.length && rt.queuedTick === nextTick) {
    acts = rt.queued;
    rt.queued = [];
    rt.queuedTick = 0;
  }
  const ev = ttAdvanceTick(st, acts);
  if (ev.cleared > 0) rt.flashUntil = now + 110;
  tetrisDraw();
  tetrisSetStats();

  if (st.dead) {
    rt.endedReason = 'stos sięgnął sufitu';
    finishTetrisRound();
    return;
  }
  if (st.tick >= TT_MAX_TICKS) {
    rt.endedReason = 'limit 10 minut';
    finishTetrisRound();
    return;
  }
  // Self-correcting schedule so gravity keeps a steady 50 ms beat — but never
  // bank a backlog: a throttled/backgrounded tab must resume in slow motion,
  // not fire a burst of unwatched ticks that drops the piece before the player
  // is even looking. Anything more than TT_MAX_CATCHUP_TICKS behind resyncs.
  rt.nextTickAt += TT_TICK_MS;
  const behindMs = performance.now() - rt.nextTickAt;
  if (behindMs > TT_MAX_CATCHUP_TICKS * TT_TICK_MS) rt.nextTickAt = performance.now() + TT_TICK_MS;
  rt.timer = setTimeout(tetrisTick, Math.max(0, rt.nextTickAt - performance.now()));
}

// opts.keepFullscreen is for the begin→stop→begin reset inside beginTetrisRound:
// every OTHER caller (tab switch, logout, arcade back button) is leaving the
// game, so it must drop fullscreen too.
function stopTetrisRound(opts = {}) {
  const rt = tetrisRuntime;
  if (rt?.timer) clearTimeout(rt.timer);
  const archive = rt?.archiveMode || false;
  tetrisRuntime = newTetrisRuntime();
  tetrisRuntime.archiveMode = archive;
  if (ttArena) ttArena.classList.remove('is-playing');
  if (ttStartBtn) { ttStartBtn.disabled = false; ttStartBtn.textContent = 'Start rundy'; }
  if (!opts.keepFullscreen) tetrisExitFullscreen();
  tetrisSetStats();
  tetrisInitCanvas();
  tetrisDraw();
}

function beginTetrisRound(round, options = {}) {
  stopTetrisRound({ keepFullscreen: true });
  const seed = Number(round.seed || Date.now()) || 1;
  tetrisRuntime = newTetrisRuntime();
  const rt = tetrisRuntime;
  rt.seed = seed;
  rt.sim = ttInitState(seed);
  rt.playing = true;
  rt.archiveMode = !!options.archiveMode;
  rt.roundId = round.id;
  if (ttArena) ttArena.classList.add('is-playing');
  if (ttStartBtn) { ttStartBtn.disabled = true; ttStartBtn.textContent = 'Runda trwa'; }
  if (ttStatus) ttStatus.textContent = rt.archiveMode
    ? 'Demo — wynik nie zostanie zapisany.'
    : 'Układaj linie! ← → ruch, ↑ obrót, ↓ miękki zrzut, spacja = twardy zrzut.';
  tetrisInitCanvas();
  tetrisSetStats();
  tetrisDraw();
  rt.nextTickAt = performance.now() + TT_TICK_MS;
  rt.timer = setTimeout(tetrisTick, TT_TICK_MS);
}

async function invokeTetris(payload) {
  const { data, error } = await sb.functions.invoke('tetris-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z Tetrisem.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd Tetrisa.');
  return data;
}

async function loadTetrisState(showSpinner = true) {
  if (!tetrisRuntime) tetrisRuntime = newTetrisRuntime();
  tetrisSetStats();
  tetrisInitCanvas();
  tetrisDraw();
  const weeklyWrap  = document.getElementById('tt-weekly-board');
  const allTimeWrap = document.getElementById('tt-alltime-board');
  const awardsWrap  = document.getElementById('tt-awards');
  if (showSpinner) {
    if (weeklyWrap)  weeklyWrap.replaceChildren(makeSpinner());
    if (allTimeWrap) allTimeWrap.replaceChildren(makeSpinner());
    if (awardsWrap)  awardsWrap.replaceChildren();
  }
  try {
    const data = await invokeTetris({ action: 'state' });
    renderTetrisState(data);
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Brak danych.'));
    if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
    if (ttStatus) ttStatus.textContent = 'Tetris nie jest jeszcze aktywny.';
  }
}

function renderTetrisState(data) {
  if (data.profile) { me.coins = data.profile.coins; setText(headerCoins, me.coins); }
  const weekLabel = document.getElementById('tt-week-label');
  if (weekLabel) {
    const range = whackBossWeekRange(data.weekStart);
    weekLabel.textContent = range ? range.short : '';
  }
  renderTetrisTable(document.getElementById('tt-weekly-board'), data.weekly || [], 'weekly');
  renderTetrisTable(document.getElementById('tt-alltime-board'), data.allTime || [], 'allTime');
  renderTetrisAwards(document.getElementById('tt-awards'), data.awards || []);
  if (!tetrisRuntime?.playing && ttStatus) {
    ttStatus.textContent = data.myWeekly
      ? 'Twój najlepszy wynik w tym tygodniu: ' + data.myWeekly.score + '.'
      : 'Układaj linie — najlepszy wynik tygodnia trafia do rankingu.';
  }
}

function renderTetrisTable(wrap, rows, mode) {
  if (!wrap) return;
  rows = rows.filter(r => r.nick !== 'admin');
  if (!rows.length) {
    wrap.replaceChildren(el('p', { className: 'bj-empty' }, mode === 'weekly' ? 'Jeszcze nikt nie zagrał w tym tygodniu.' : 'Brak rekordów.'));
    return;
  }
  const bodyRows = rows.slice(0, 10).map(row => el('tr', {},
    el('td', { className: 'lb-rank' + (row.rank === 1 ? ' gold' : '') }, whackBossRankLabel(row.rank)),
    el('td', { className: 'lb-nick' + (row.user_id === me?.id ? ' me' : '') }, row.nick + (row.user_id === me?.id ? ' (Ty)' : '')),
    lbScoreCell(row)
  ));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'),
        el('th', {}, 'Nick'),
        el('th', { title: 'Najwyższy wynik' }, 'Wynik')
      )),
      el('tbody', {}, ...bodyRows)
    )
  );
}

function renderTetrisAwards(wrap, awards) {
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

async function startTetrisRound() {
  const rt = tetrisRuntime;
  if (rt?.playing || rt?.submitting) return;
  // Must run BEFORE the first await — requestFullscreen() is only granted
  // while the click that got us here still counts as a user gesture.
  if (tetrisIsHandheld()) tetrisEnterFullscreen();
  if (allGamesMode) {
    try { await payArcadeEntry(allGamesSelectedGame); } catch (e) { showToast('❌ Nie udało się wejść do gry.'); return; }
  }
  if (ttStartBtn) { ttStartBtn.disabled = true; ttStartBtn.textContent = 'Ładuję...'; }
  if (ttStatus) ttStatus.textContent = 'Przygotowuję rundę...';
  try {
    const data = await invokeTetris({ action: 'start' });
    renderTetrisState(data);
    beginTetrisRound(data.round);
    if (allGamesMode) tetrisRuntime.archiveMode = true;
  } catch (err) {
    showToast('❌ ' + err.message);
    if (ttStatus) ttStatus.textContent = 'Nie udało się wystartować rundy.';
    if (ttStartBtn) { ttStartBtn.disabled = false; ttStartBtn.textContent = 'Start rundy'; }
    tetrisExitFullscreen(); // no round to play — don't strand the player fullscreen
  }
}

async function finishTetrisRound() {
  const rt = tetrisRuntime;
  if (!rt || rt.submitting) return;
  rt.playing = false;
  rt.submitting = true;
  rt.held = {};
  rt.softHeld = false;
  if (rt.timer) clearTimeout(rt.timer);
  if (ttArena) ttArena.classList.remove('is-playing');
  tetrisSetStats();
  tetrisDraw();

  const finalScore = Math.min(TT_MAX_SCORE, rt.sim.score);

  if (rt.archiveMode) {
    rt.submitting = false;
    if (ttStartBtn) { ttStartBtn.disabled = false; ttStartBtn.textContent = 'Zagraj ponownie'; }
    if (allGamesMode) {
      try {
        await recordArcadeScore('tetris', finalScore);
        if (ttStatus) ttStatus.textContent = 'Wynik: ' + finalScore + ' · zapisano w rankingu arcade!';
        loadArcadeScores('tetris');
      } catch (e) { if (ttStatus) ttStatus.textContent = 'Wynik: ' + finalScore + ' (błąd zapisu).'; }
    } else {
      if (ttStatus) ttStatus.textContent = 'Demo — wynik: ' + finalScore + ' (nie zapisano).';
    }
    return;
  }

  if (ttStartBtn) { ttStartBtn.disabled = true; ttStartBtn.textContent = 'Zapisuję...'; }
  if (ttStatus) ttStatus.textContent = 'Zapisuję wynik...';
  try {
    const data = await invokeTetris({
      action: 'submit',
      roundId: rt.roundId,
      seed: rt.seed,
      events: rt.eventLog,
      elapsedTicks: rt.sim.tick,
      score: finalScore,
    });
    renderTetrisState(data);
    showToast('✅ Wynik zapisany: ' + data.score.score);
    if (ttStatus) {
      const reason = rt.endedReason ? ' · ' + rt.endedReason : '';
      ttStatus.textContent = 'Ostatni wynik: ' + data.score.score + ' (' + data.score.lines + ' linii)' + reason + '.';
    }
  } catch (err) {
    showToast('❌ ' + err.message);
    if (ttStatus) ttStatus.textContent = 'Nie udało się zapisać wyniku.';
  } finally {
    rt.submitting = false;
    if (ttStartBtn) { ttStartBtn.disabled = false; ttStartBtn.textContent = 'Zagraj ponownie'; }
  }
}

// ── Input ───────────────────────────────────────────────────────────────────
const TT_KEY_ACTIONS = {
  ArrowLeft: TT_A_LEFT,
  ArrowRight: TT_A_RIGHT,
  a: TT_A_LEFT,
  d: TT_A_RIGHT,
};
const TT_KEY_ROTATE = {
  ArrowUp: TT_A_CW,
  x: TT_A_CW,
  w: TT_A_CW,
  z: TT_A_CCW,
  Control: TT_A_CCW,
};

document.addEventListener('keydown', evt => {
  const rt = tetrisRuntime;
  if (!rt?.playing) return;
  const key = evt.key.length === 1 ? evt.key.toLowerCase() : evt.key;

  if (key in TT_KEY_ACTIONS) {
    evt.preventDefault();
    if (rt.held[key]) return; // browser key-repeat — our own DAS drives repeats
    const action = TT_KEY_ACTIONS[key];
    rt.held[key] = { action, repeatAt: performance.now() + TT_DAS_MS };
    tetrisQueueAction(action);
    return;
  }
  if (key in TT_KEY_ROTATE) {
    evt.preventDefault();
    if (evt.repeat) return;
    tetrisQueueAction(TT_KEY_ROTATE[key]);
    return;
  }
  if (key === 'ArrowDown' || key === 's') {
    evt.preventDefault();
    rt.softHeld = true;
    return;
  }
  if (key === ' ' || key === 'Spacebar') {
    evt.preventDefault();
    if (evt.repeat) return;
    tetrisQueueAction(TT_A_HARD);
  }
});

document.addEventListener('keyup', evt => {
  const rt = tetrisRuntime;
  if (!rt) return;
  const key = evt.key.length === 1 ? evt.key.toLowerCase() : evt.key;
  if (key in TT_KEY_ACTIONS) delete rt.held[key];
  if (key === 'ArrowDown' || key === 's') rt.softHeld = false;
});

window.addEventListener('blur', () => {
  const rt = tetrisRuntime;
  if (!rt) return;
  rt.held = {};
  rt.softHeld = false;
});

// On-screen controls (mobile): press-and-hold repeats through the same DAS path.
document.querySelectorAll('#tt-pad [data-tt-act]').forEach(btn => {
  const action = Number(btn.dataset.ttAct);
  const press = evt => {
    evt.preventDefault();
    const rt = tetrisRuntime;
    if (!rt?.playing) return;
    if (action === TT_A_SOFT) { rt.softHeld = true; return; }
    tetrisQueueAction(action);
    if (action === TT_A_LEFT || action === TT_A_RIGHT) {
      rt.held['pad' + action] = { action, repeatAt: performance.now() + TT_DAS_MS };
    }
  };
  const release = () => {
    const rt = tetrisRuntime;
    if (!rt) return;
    if (action === TT_A_SOFT) rt.softHeld = false;
    delete rt.held['pad' + action];
  };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
});

if (ttStartBtn) ttStartBtn.addEventListener('click', startTetrisRound);
document.getElementById('tt-fs-exit')?.addEventListener('click', evt => {
  evt.preventDefault();
  evt.stopPropagation();
  tetrisExitFullscreen();
});

if (ttArena) {
  ttArena.addEventListener('pointerdown', evt => {
    const rt = tetrisRuntime;
    if (!rt?.playing && !rt?.submitting) {
      evt.preventDefault();
      startTetrisRound();
    }
  });
}

window.addEventListener('resize', () => {
  if (!ttCtx) return;
  tetrisInitCanvas();
  tetrisDraw();
});

tetrisInitCanvas();
tetrisDraw();
