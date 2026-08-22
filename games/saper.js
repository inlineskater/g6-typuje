// ── „Saper Maraton" (saper) — Minesweeper as an arcade score chase ───────────
// The one office classic the rotation never had. Not a single 16×16 board you
// pick at for five minutes: a NINETY SECOND marathon over a stream of small
// boards. Clear one and the next deals instantly, one rung harder; hit a mine
// and you lose the board plus five seconds off the clock, but NOT the run.
// That last rule is the whole design — Minesweeper's worst moment is the
// forced 50/50 guess, and a marathon that ends on one would be miserable.
//
// Debuts as a full seasonal game on the week starting 2026-08-24. It runs in
// two modes, exactly like „Kulki G6":
//
//   seasonal  — supabase/functions/saper-action issues the seed and owns the
//               score. The client logs every move it made and the tick it made
//               it on; the server replays seed + that list.
//   arcade    — „Wszystkie Gry" (allGamesMode): a local seed, no round row,
//               score client-reported through record_arcade_score() and
//               guarded only by the cap in supabase/arcade.sql.
//
// ANTI-CHEAT NOTE. Minesweeper over a known seed is exactly the shape an
// offline solver eats for breakfast, so the guard here is the clock rather
// than „Kulki G6"'s per-move minimum: the round IS a tick clock, and the
// server requires that a submitted round took at least as much WALL CLOCK as
// the ticks it claims to have simulated. Forging a full 1800-tick log
// therefore costs 90 real seconds, the same 90 seconds everyone else spends.
// The client's clock is derived from wall time (not from how often the RAF
// fires), so backgrounding the tab burns the round down instead of buying free
// thinking time.
//
// ⚠️ PARITY CONTRACT: everything between the PARITY BLOCK fences below must
// stay byte-for-byte equivalent to the same block in
// supabase/functions/saper-action/index.ts. Verified by
// `node scripts/saper-parity.mjs`.

// ── PARITY BLOCK START ──────────────────────────────────────────────────────
const SP_TICK_MS = 50;
const SP_ROUND_TICKS = 1800;          // 90 s
const SP_MINE_PENALTY_TICKS = 100;    // 5 s off the clock per detonation
const SP_MAX_MOVES = 6000;
// Ceiling on a submitted score, and the value mirrored by the arcade cap in
// supabase/arcade.sql. Measured, not guessed: scripts/saper-balance.mjs drives
// a deducing bot at a sustained 7 moves/second — well past what hands do — and
// tops out around 5000, while a good human run lands near 2200. 9999 leaves
// room for a genuinely exceptional round without being meaningless.
const SP_MAX_SCORE = 9999;

// Move kinds. The client logs one of these per accepted input, never per click
// — a click the simulation rejects is not a move and never reaches the log.
const SP_OPEN = 0;
const SP_FLAG = 1;
const SP_CHORD = 2;

// The difficulty ladder, indexed by BOARDS CLEARED (not boards dealt) — so a
// detonation costs you the board and the clock, never a promotion you did not
// earn. Density runs 13.9% → 15.6% → 17.2% → 17.3% → 19.8%: Windows beginner
// through a shade past intermediate, which is as far as anyone gets inside 90
// seconds.
const SP_LADDER = [
  { w: 6, h: 6, m: 5 },
  { w: 7, h: 7, m: 8 },
  { w: 8, h: 8, m: 11 },
  { w: 9, h: 9, m: 14 },
  { w: 9, h: 9, m: 16 },
];

const SP_CLEAR_BASE = 100;            // every cleared board
const SP_CLEAR_PER_RUNG = 40;         // ...plus this much per ladder rung
const SP_SPEED_BONUS_MAX = 60;        // ...plus a bonus that decays with time
const SP_SPEED_DECAY_TICKS = 6;       // 1 point per 6 ticks; gone after 18 s
const SP_STREAK_STEP = 25;            // ...plus this per consecutive clear
const SP_STREAK_CAP = 5;              // ...capped, so one long run can't run away

function spRung(st) {
  return Math.min(st.cleared, SP_LADDER.length - 1);
}

function spRng(st) {
  st.rng = (Math.imul(st.rng, 1664525) + 1013904223) >>> 0;
  return st.rng / 4294967296;
}

function spNeighbors(b, c) {
  const x = c % b.w;
  const y = (c - x) / b.w;
  const out = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= b.w || ny < 0 || ny >= b.h) continue;
      out.push(ny * b.w + nx);
    }
  }
  return out;
}

function spDeal(st) {
  const spec = SP_LADDER[spRung(st)];
  const n = spec.w * spec.h;
  st.board = {
    w: spec.w,
    h: spec.h,
    m: spec.m,
    mine: new Array(n).fill(0),
    adj: new Array(n).fill(0),
    open: new Array(n).fill(0),
    flag: new Array(n).fill(0),
    placed: false,
    opened: 0,
    flags: 0,
    boom: false,
    boomAt: -1,
    startTick: st.tick,
  };
  st.boardsDealt += 1;
}

function spInitState(seed) {
  const st = {
    rng: (Number(seed) >>> 0) || 1,
    tick: 0,
    penalty: 0,
    score: 0,
    cleared: 0,
    streak: 0,
    bestStreak: 0,
    booms: 0,
    opened: 0,
    boardsDealt: 0,
    board: null,
    over: false,
  };
  spDeal(st);
  return st;
}

// Mines are placed on the FIRST OPEN of each board, never before, and never
// inside the 3×3 around that cell — so the opening click always breaks a hole
// open instead of ending the board on a coin flip. Deterministic given the
// stream position and the clicked cell, which is all the replay needs.
function spPlaceMines(st, safe) {
  const b = st.board;
  const n = b.w * b.h;
  const sx = safe % b.w;
  const sy = (safe - sx) / b.w;
  let cand = [];
  for (let i = 0; i < n; i += 1) {
    const x = i % b.w;
    const y = (i - x) / b.w;
    if (Math.abs(x - sx) <= 1 && Math.abs(y - sy) <= 1) continue;
    cand.push(i);
  }
  // A board too cramped to keep a whole 3×3 clear falls back to sparing only
  // the clicked cell. No rung on the ladder needs this; it exists so the
  // function is total for any future SP_LADDER edit.
  if (cand.length < b.m) {
    cand = [];
    for (let i = 0; i < n; i += 1) if (i !== safe) cand.push(i);
  }
  for (let k = 0; k < b.m; k += 1) {
    const j = k + Math.floor(spRng(st) * (cand.length - k));
    const t = cand[k];
    cand[k] = cand[j];
    cand[j] = t;
    b.mine[cand[k]] = 1;
  }
  for (let i = 0; i < n; i += 1) {
    if (b.mine[i]) { b.adj[i] = -1; continue; }
    let a = 0;
    const nbs = spNeighbors(b, i);
    for (let q = 0; q < nbs.length; q += 1) if (b.mine[nbs[q]]) a += 1;
    b.adj[i] = a;
  }
  b.placed = true;
}

// Reveal `start`, cascading through the zero region. Flagged cells are left
// alone by the cascade, exactly as every desktop Minesweeper does it. A mine
// can only ever be hit at `start` — the cascade only expands out of cells with
// no adjacent mines — so the outcome does not depend on stack order.
function spRevealFrom(st, start) {
  const b = st.board;
  const stack = [start];
  while (stack.length) {
    const c = stack.pop();
    if (b.open[c] || b.flag[c]) continue;
    b.open[c] = 1;
    b.opened += 1;
    st.opened += 1;
    if (b.mine[c]) { b.boom = true; b.boomAt = c; return; }
    if (b.adj[c] !== 0) continue;
    const nbs = spNeighbors(b, c);
    for (let q = 0; q < nbs.length; q += 1) {
      const nb = nbs[q];
      if (!b.open[nb] && !b.flag[nb]) stack.push(nb);
    }
  }
}

// Resolve whatever the last move did to the board: a detonation costs the
// board, the streak and five seconds; a full clear pays out and deals the next
// rung. Either way the player is handed a fresh board in the same instant.
function spSettle(st) {
  const b = st.board;
  if (b.boom) {
    st.booms += 1;
    st.streak = 0;
    st.penalty += SP_MINE_PENALTY_TICKS;
    if (st.tick + st.penalty >= SP_ROUND_TICKS) { st.over = true; return; }
    spDeal(st);
    return;
  }
  if (!b.placed || b.opened !== b.w * b.h - b.m) return;

  const rung = spRung(st);
  const spent = st.tick - b.startTick;
  const speed = Math.max(0, SP_SPEED_BONUS_MAX - Math.floor(spent / SP_SPEED_DECAY_TICKS));
  st.streak += 1;
  if (st.streak > st.bestStreak) st.bestStreak = st.streak;
  const streakBonus = Math.min(st.streak - 1, SP_STREAK_CAP) * SP_STREAK_STEP;
  st.score += SP_CLEAR_BASE + SP_CLEAR_PER_RUNG * rung + speed + streakBonus;
  st.cleared += 1;
  spDeal(st);
}

// One clock tick. Carries no input: the round's length is the server's to
// decide, so the clock advances on its own and moves are applied against it.
function spTick(st) {
  if (st.over) return;
  st.tick += 1;
  if (st.tick + st.penalty >= SP_ROUND_TICKS) st.over = true;
}

// One input. Returns false when the move is not legal against this board —
// the client only logs moves this accepted, so on replay a false means the two
// sides disagree and the run is not scoreable.
function spApplyMove(st, action, cell) {
  if (st.over) return false;
  const b = st.board;
  if (!b) return false;
  if (!Number.isInteger(cell) || cell < 0 || cell >= b.w * b.h) return false;

  if (action === SP_FLAG) {
    if (b.open[cell]) return false;
    if (b.flag[cell]) { b.flag[cell] = 0; b.flags -= 1; }
    else { b.flag[cell] = 1; b.flags += 1; }
    return true;
  }

  if (action === SP_OPEN) {
    if (b.flag[cell]) return false;   // a flag protects the cell under it
    if (b.open[cell]) return false;   // already open — that is what a chord is for
    if (!b.placed) spPlaceMines(st, cell);
    spRevealFrom(st, cell);
    spSettle(st);
    return true;
  }

  if (action === SP_CHORD) {
    if (!b.open[cell]) return false;
    const need = b.adj[cell];
    if (need <= 0) return false;
    const nbs = spNeighbors(b, cell);
    let flags = 0;
    const hidden = [];
    for (let q = 0; q < nbs.length; q += 1) {
      const nb = nbs[q];
      if (b.flag[nb]) flags += 1;
      else if (!b.open[nb]) hidden.push(nb);
    }
    if (flags !== need) return false;   // not satisfied — nothing to chord
    if (!hidden.length) return false;   // nothing left to open under it
    for (let q = 0; q < hidden.length; q += 1) {
      spRevealFrom(st, hidden[q]);
      if (b.boom) break;                // the rest of the neighbours never open
    }
    spSettle(st);
    return true;
  }

  return false;
}

// Drive the whole round from seed + move log. Both sides run this: the client
// only to sanity-check itself, the server to decide the score. Moves are
// grouped by tick, so several inputs inside one 50 ms tick replay in order.
function spReplay(seed, moves) {
  const st = spInitState(seed);
  let mi = 0;
  while (mi < moves.length && moves[mi].tick === 0) {
    if (!spApplyMove(st, moves[mi].a, moves[mi].c)) return { ok: false, atMove: mi };
    mi += 1;
  }
  for (let t = 1; t <= SP_ROUND_TICKS && !st.over; t += 1) {
    spTick(st);
    while (mi < moves.length && moves[mi].tick === t) {
      if (st.over) break;
      if (!spApplyMove(st, moves[mi].a, moves[mi].c)) return { ok: false, atMove: mi };
      mi += 1;
    }
  }
  // Moves left over claim a tick the round never reached.
  if (mi < moves.length) return { ok: false, atMove: mi };
  return {
    ok: true,
    score: Math.min(SP_MAX_SCORE, st.score),
    rawScore: st.score,
    ticks: st.tick,
    cleared: st.cleared,
    booms: st.booms,
    bestStreak: st.bestStreak,
    opened: st.opened,
    boardsDealt: st.boardsDealt,
    over: st.over,
  };
}
// ── PARITY BLOCK END ────────────────────────────────────────────────────────

// Rendering-only constants. Deliberately BELOW the parity fence — the Edge
// Function has no canvas, so keeping them inside would make every layout tweak
// look like a parity break.
const SP_CS_W = 400;
const SP_HUD_H = 62;
const SP_FIELD = 400;                       // the square the board is fitted into
const SP_CS_H = SP_HUD_H + SP_FIELD;
const SP_MAX_DPR = 2;

const SP_FREEZE_BOOM_MS = 850;   // how long a detonated board stays on screen
const SP_FREEZE_CLEAR_MS = 420;  // ...and a cleared one
const SP_FLOAT_MS = 900;

// Windows 3.1 / 95 Minesweeper, down to the number colours.
const SP_FACE = '#c0c0c0';
const SP_HI = '#ffffff';
const SP_LO = '#7b7b7b';
const SP_GRID = '#9a9a9a';
const SP_NUM_COLORS = ['', '#0000ff', '#008000', '#ff0000', '#000080', '#800000', '#008080', '#000000', '#808080'];

function newSaperRuntime() {
  return {
    playing: false, submitting: false, settled: false, archiveMode: false,
    seed: 1,
    roundId: null,        // seasonal rounds only; null in arcade/demo mode
    moveLog: [],          // { tick, a, c } per accepted input — the replay payload
    sim: spInitState(1),
    flagMode: false,      // the touch-friendly 🚩 toggle
    freeze: null,         // { board, until, kind } — last board held on screen
    floats: [],           // { x, y, until, text }
    press: null,          // { cell, at, moved } — long-press-to-flag tracking
    hover: -1,
    raf: null,
    startedAt: 0,
    endedReason: '',
  };
}

let spCtx = null;

function saperInitCanvas() {
  const canvas = document.getElementById('sp-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const DPR = Math.min(window.devicePixelRatio || 1, SP_MAX_DPR);
  const w = Math.round((rect.width || SP_CS_W) * DPR);
  const h = Math.round((rect.height || SP_CS_H) * DPR);
  if (!spCtx || canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    spCtx = canvas.getContext('2d');
  }
  spCtx.setTransform(w / SP_CS_W, 0, 0, h / SP_CS_H, 0, 0);
}

function saperResetBoard(seed = 1) {
  const rt = saperRuntime || newSaperRuntime();
  rt.seed = seed;
  rt.sim = spInitState(seed);
  rt.moveLog = [];
  rt.freeze = null;
  rt.floats = [];
  rt.press = null;
  rt.hover = -1;
  rt.roundId = null;
  rt.endedReason = '';
  rt.settled = false;    // a fresh round may be submitted again
  saperRuntime = rt;
  return rt;
}

// Board geometry, recomputed per board because the ladder changes its size.
function spGeom(b) {
  const cell = Math.floor(SP_FIELD / Math.max(b.w, b.h));
  const bw = cell * b.w;
  const bh = cell * b.h;
  return {
    cell,
    x0: Math.round((SP_CS_W - bw) / 2),
    y0: SP_HUD_H + Math.round((SP_FIELD - bh) / 2),
    bw,
    bh,
  };
}

function spBevel(ctx, x, y, w, h, depth) {
  ctx.fillStyle = SP_FACE;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = SP_HI;
  ctx.fillRect(x, y, w, depth);
  ctx.fillRect(x, y, depth, h);
  ctx.fillStyle = SP_LO;
  ctx.fillRect(x, y + h - depth, w, depth);
  ctx.fillRect(x + w - depth, y, depth, h);
}

function spInset(ctx, x, y, w, h, depth) {
  ctx.fillStyle = SP_LO;
  ctx.fillRect(x, y, w, depth);
  ctx.fillRect(x, y, depth, h);
  ctx.fillStyle = SP_HI;
  ctx.fillRect(x, y + h - depth, w, depth);
  ctx.fillRect(x + w - depth, y, depth, h);
}

function spDrawBoard(ctx, b, g, opts = {}) {
  const cell = g.cell;
  const reveal = !!opts.revealMines;
  for (let c = 0; c < b.w * b.h; c += 1) {
    const cx = c % b.w;
    const cy = (c - cx) / b.w;
    const x = g.x0 + cx * cell;
    const y = g.y0 + cy * cell;

    if (!b.open[c]) {
      if (reveal && b.mine[c] && !b.flag[c]) {
        ctx.fillStyle = SP_FACE;
        ctx.fillRect(x, y, cell, cell);
        ctx.strokeStyle = SP_GRID;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
        ctx.font = Math.floor(cell * 0.62) + 'px system-ui, sans-serif';
        ctx.fillText('💣', x + cell / 2, y + cell / 2 + 1);
        continue;
      }
      spBevel(ctx, x, y, cell, cell, Math.max(2, Math.round(cell * 0.09)));
      if (b.flag[c]) {
        ctx.font = Math.floor(cell * 0.58) + 'px system-ui, sans-serif';
        ctx.fillText(reveal && !b.mine[c] ? '❌' : '🚩', x + cell / 2, y + cell / 2 + 1);
      }
      continue;
    }

    ctx.fillStyle = c === b.boomAt ? '#e05a52' : SP_FACE;
    ctx.fillRect(x, y, cell, cell);
    ctx.strokeStyle = SP_GRID;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
    if (b.mine[c]) {
      ctx.font = Math.floor(cell * 0.62) + 'px system-ui, sans-serif';
      ctx.fillText('💣', x + cell / 2, y + cell / 2 + 1);
    } else if (b.adj[c] > 0) {
      ctx.fillStyle = SP_NUM_COLORS[b.adj[c]];
      ctx.font = 'bold ' + Math.floor(cell * 0.62) + 'px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(String(b.adj[c]), x + cell / 2, y + cell / 2 + 1);
    }
  }
  spInset(ctx, g.x0 - 3, g.y0 - 3, g.bw + 6, g.bh + 6, 3);
}

function spLed(ctx, x, y, w, text, color) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(x, y, w, 26);
  ctx.fillStyle = color;
  ctx.font = 'bold 19px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(text, x + w / 2, y + 14);
}

function saperDraw(now = performance.now()) {
  const ctx = spCtx;
  if (!ctx) return;
  const rt = saperRuntime;
  const st = rt?.sim;
  const W = SP_CS_W, H = SP_CS_H;

  ctx.fillStyle = '#bdbdbd';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // The board on screen is the live one, unless a just-finished board is being
  // held up so the player can actually see what happened to it.
  const freeze = rt?.freeze && rt.freeze.until > now ? rt.freeze : null;
  const board = freeze ? freeze.board : st?.board;
  if (board) spDrawBoard(ctx, board, spGeom(board), { revealMines: !!freeze && freeze.kind === 'boom' });

  // HUD: mines left · time · score, in the classic sunken strip.
  spBevel(ctx, 0, 0, W, SP_HUD_H, 3);
  const left = board ? Math.max(-99, board.m - board.flags) : 0;
  const ticksLeft = st ? Math.max(0, SP_ROUND_TICKS - st.tick - st.penalty) : SP_ROUND_TICKS;
  const secsLeft = Math.ceil(ticksLeft * SP_TICK_MS / 1000);
  spLed(ctx, 12, 18, 62, (left < 0 ? '-' : '') + String(Math.abs(left)).padStart(2, '0'),
    left < 0 ? '#ff7b6b' : '#ff2d2d');
  spLed(ctx, W - 74, 18, 62, String(secsLeft).padStart(3, '0'),
    secsLeft <= 10 ? '#ffd23d' : '#ff2d2d');

  ctx.fillStyle = '#1f1f1f';
  ctx.font = 'bold 9px system-ui, sans-serif';
  ctx.fillText('WYNIK', W / 2, 15);
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.fillText(String(st ? Math.min(SP_MAX_SCORE, st.score) : 0), W / 2, 33);
  ctx.fillStyle = '#4a4a4a';
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.fillText((st ? st.cleared : 0) + ' plansz · seria ' + (st ? st.streak : 0), W / 2, 50);

  if (rt) {
    rt.floats = rt.floats.filter(f => f.until > now);
    ctx.textAlign = 'center';
    rt.floats.forEach(f => {
      const k = 1 - (f.until - now) / SP_FLOAT_MS;
      ctx.globalAlpha = Math.max(0, 1 - k);
      ctx.fillStyle = f.color || '#0a7d2c';
      ctx.font = 'bold 21px system-ui, sans-serif';
      ctx.fillText(f.text, f.x, f.y - k * 34);
      ctx.globalAlpha = 1;
    });
  }

  if (!rt?.playing) {
    ctx.fillStyle = 'rgba(24,24,24,.78)';
    ctx.fillRect(0, SP_HUD_H, W, H - SP_HUD_H);
    ctx.fillStyle = '#f8fafc';
    // `over` alone, not "and you finished at least one board": a round where
    // the buzzer caught you mid-board is still a played round, and showing it
    // the attract-mode title card instead of its result reads as if the run
    // never happened.
    if (st && st.over) {
      ctx.font = 'bold 25px system-ui, sans-serif';
      ctx.fillText('CZAS!', W / 2, SP_HUD_H + 118);
      ctx.fillStyle = '#ffd23d';
      ctx.font = 'bold 44px system-ui, sans-serif';
      ctx.fillText(String(Math.min(SP_MAX_SCORE, st.score)), W / 2, SP_HUD_H + 168);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('Rozbrojonych plansz: ' + st.cleared + ' · najdłuższa seria: ' + st.bestStreak, W / 2, SP_HUD_H + 206);
      ctx.fillStyle = st.booms ? '#fca5a5' : '#86efac';
      ctx.fillText(st.booms ? 'Wpadek na minę: ' + st.booms : 'Ani jednej miny — perfekcyjnie!', W / 2, SP_HUD_H + 228);
    } else {
      ctx.font = 'bold 27px system-ui, sans-serif';
      ctx.fillText('SAPER MARATON', W / 2, SP_HUD_H + 128);
      ctx.font = '34px system-ui, sans-serif';
      ctx.fillText('💣 🚩 💣', W / 2, SP_HUD_H + 176);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('90 sekund. Ile plansz rozbroisz?', W / 2, SP_HUD_H + 218);
    }
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function saperSetStats() {
  const st = saperRuntime?.sim;
  if (!st) return;
  if (spScoreEl)  spScoreEl.textContent  = String(Math.min(SP_MAX_SCORE, st.score));
  if (spBoardsEl) spBoardsEl.textContent = String(st.cleared);
  if (spStreakEl) spStreakEl.textContent = String(st.streak);
  if (spTimeEl) {
    const ticksLeft = Math.max(0, SP_ROUND_TICKS - st.tick - st.penalty);
    spTimeEl.textContent = Math.ceil(ticksLeft * SP_TICK_MS / 1000) + ' s';
  }
}

// The clock is derived from WALL TIME, not from how often the RAF fired. A
// backgrounded tab therefore burns the round down instead of pausing it —
// which for a puzzle would be free thinking time — and the tick count the
// server sees always matches the seconds actually spent.
function saperLoop() {
  const rt = saperRuntime;
  if (!rt?.playing) return;
  const target = Math.min(SP_ROUND_TICKS, Math.floor((performance.now() - rt.startedAt) / SP_TICK_MS));
  while (rt.sim.tick < target && !rt.sim.over) spTick(rt.sim);
  saperSetStats();
  saperDraw();
  if (rt.sim.over) { finishSaperRound(); return; }
  rt.raf = requestAnimationFrame(saperLoop);
}

function stopSaperRound() {
  const rt = saperRuntime;
  if (rt?.raf) cancelAnimationFrame(rt.raf);
  const wasArchive = rt?.archiveMode || false;
  // Flag mode is a preference, not round state. A touch player who turned it on
  // means it for the session, and beginSaperRound() calls through here, so
  // rebuilding the runtime would silently switch it off before every round.
  const wasFlagMode = rt?.flagMode || false;
  saperRuntime = newSaperRuntime();
  saperResetBoard(1);
  saperRuntime.playing = false;
  saperRuntime.archiveMode = wasArchive;
  saperRuntime.flagMode = wasFlagMode;
  if (spStartBtn) { spStartBtn.disabled = false; spStartBtn.textContent = 'Start rundy'; }
  saperSyncFlagBtn();
  saperSetStats();
  saperInitCanvas();
  saperDraw();
}

function beginSaperRound(seed, options = {}) {
  stopSaperRound();
  const rt = saperResetBoard(seed);
  rt.playing = true;
  rt.archiveMode = !!options.archiveMode;
  rt.roundId = options.roundId || null;
  rt.startedAt = performance.now();
  if (spStartBtn) { spStartBtn.disabled = true; spStartBtn.textContent = 'Runda trwa'; }
  if (spStatus) spStatus.textContent = 'Klikaj pola. Prawy przycisk (albo 🚩) stawia flagę, kliknięcie w cyfrę z kompletem flag odsłania resztę.';
  saperSetStats();
  saperInitCanvas();
  saperLoop();
}

async function startSaperRound() {
  const rt = saperRuntime;
  if (rt?.playing || rt?.submitting) return;

  // Arcade path: a purely local round. No server round row is burned for a run
  // that can never enter the weekly ranking.
  if (allGamesMode) {
    try { await payArcadeEntry(allGamesSelectedGame); }
    catch (e) { showToast('❌ Nie udało się wejść do gry.'); return; }
    beginSaperRound((Math.floor(Math.random() * 0xfffffff) + 1) >>> 0, { archiveMode: true });
    return;
  }

  // Seasonal path: the server owns the seed and, on submit, the score.
  if (spStartBtn) { spStartBtn.disabled = true; spStartBtn.textContent = 'Ładuję...'; }
  if (spStatus) spStatus.textContent = 'Przygotowuję rundę...';
  try {
    const data = await invokeSaper({ action: 'start' });
    renderSaperState(data);
    beginSaperRound(Number(data.round.seed) || 1, { roundId: data.round.id });
  } catch (err) {
    showToast('❌ ' + err.message);
    if (spStatus) spStatus.textContent = 'Nie udało się wystartować rundy.';
    if (spStartBtn) { spStartBtn.disabled = false; spStartBtn.textContent = 'Start rundy'; }
  }
}

async function finishSaperRound() {
  const rt = saperRuntime;
  // `submitting` alone is not enough: it is cleared in the finally below, so a
  // second call after the first completed would submit the same round again
  // and report a cheerful „zapisano" for a row the server rejected.
  // `settled` is the one-way latch; only a new round clears it.
  if (!rt || rt.submitting || rt.settled) return;
  rt.playing = false;
  rt.submitting = true;
  rt.settled = true;
  if (rt.raf) cancelAnimationFrame(rt.raf);
  rt.freeze = null;
  saperSetStats();
  saperDraw();

  const score = Math.min(SP_MAX_SCORE, rt.sim.score);
  const tail = rt.sim.booms ? '' : ' 🎖️ Bez ani jednej miny!';

  // Arcade / demo: client-reported score, guarded only by the arcade cap.
  if (rt.archiveMode || !rt.roundId) {
    if (!allGamesMode) {
      rt.submitting = false;
      if (spStartBtn) { spStartBtn.disabled = false; spStartBtn.textContent = 'Zagraj ponownie'; }
      if (spStatus) spStatus.textContent = 'Demo — wynik: ' + score + ' (nie zapisano).';
      return;
    }
    if (spStartBtn) { spStartBtn.disabled = true; spStartBtn.textContent = 'Zapisuję...'; }
    try {
      await recordArcadeScore('saper', score);
      if (spStatus) spStatus.textContent = 'Wynik: ' + score + ' · zapisano w rankingu arcade!' + tail;
      showToast('✅ Wynik zapisany: ' + score);
      loadArcadeScores('saper');
    } catch (err) {
      if (spStatus) spStatus.textContent = 'Wynik: ' + score + ' (błąd zapisu).';
      showToast('❌ Nie udało się zapisać wyniku.');
    } finally {
      rt.submitting = false;
      if (spStartBtn) { spStartBtn.disabled = false; spStartBtn.textContent = 'Zagraj ponownie'; }
    }
    return;
  }

  // Seasonal: send seed + the move log; the server replays and decides.
  if (spStartBtn) { spStartBtn.disabled = true; spStartBtn.textContent = 'Zapisuję...'; }
  if (spStatus) spStatus.textContent = 'Zapisuję wynik...';
  try {
    const data = await invokeSaper({
      action: 'submit',
      roundId: rt.roundId,
      moves: rt.moveLog,
      score,
    });
    renderSaperState(data);
    showToast('✅ Wynik zapisany: ' + data.score.score);
    if (spStatus) {
      spStatus.textContent = 'Ostatni wynik: ' + data.score.score
        + ' (' + data.score.boards_cleared + ' plansz, seria ' + data.score.best_streak + ').' + tail;
    }
  } catch (err) {
    showToast('❌ ' + err.message);
    if (spStatus) spStatus.textContent = 'Nie udało się zapisać wyniku: ' + err.message;
  } finally {
    rt.submitting = false;
    if (spStartBtn) { spStartBtn.disabled = false; spStartBtn.textContent = 'Zagraj ponownie'; }
  }
}

// ── Seasonal networking + leaderboards ──────────────────────────────────────

async function invokeSaper(payload) {
  const { data, error } = await sb.functions.invoke('saper-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z Saperem.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd Sapera.');
  return data;
}

async function loadSaperState(showSpinner = true) {
  if (!saperRuntime) saperResetBoard(1);
  saperSetStats();
  saperInitCanvas();
  saperDraw();
  const weeklyWrap  = document.getElementById('sp-weekly-board');
  const allTimeWrap = document.getElementById('sp-alltime-board');
  const awardsWrap  = document.getElementById('sp-awards');
  if (showSpinner) {
    if (weeklyWrap)  weeklyWrap.replaceChildren(makeSpinner());
    if (allTimeWrap) allTimeWrap.replaceChildren(makeSpinner());
    if (awardsWrap)  awardsWrap.replaceChildren();
  }
  try {
    const data = await invokeSaper({ action: 'state' });
    renderSaperState(data);
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Brak danych.'));
    if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
    if (spStatus) spStatus.textContent = 'Saper nie jest jeszcze aktywny.';
  }
}

function renderSaperState(data) {
  if (data.profile) { me.coins = data.profile.coins; setText(headerCoins, me.coins); }
  const weekLabel = document.getElementById('sp-week-label');
  if (weekLabel) {
    const range = whackBossWeekRange(data.weekStart);
    weekLabel.textContent = range ? range.short : '';
  }
  renderSaperTable(document.getElementById('sp-weekly-board'), data.weekly || [], 'weekly');
  renderSaperTable(document.getElementById('sp-alltime-board'), data.allTime || [], 'allTime');
  renderSaperAwards(document.getElementById('sp-awards'), data.awards || []);
  if (!saperRuntime?.playing && spStatus) {
    spStatus.textContent = data.myWeekly
      ? 'Twój najlepszy wynik w tym tygodniu: ' + data.myWeekly.score + '.'
      : 'Masz 90 sekund — najlepszy wynik tygodnia trafia do rankingu.';
  }
}

function renderSaperTable(wrap, rows, mode) {
  if (!wrap) return;
  rows = rows.filter(r => r.nick !== 'admin');
  if (!rows.length) {
    wrap.replaceChildren(el('p', { className: 'bj-empty' }, mode === 'weekly' ? 'Jeszcze nikt nie zagrał w tym tygodniu.' : 'Brak rekordów.'));
    return;
  }
  const bodyRows = rows.slice(0, 10).map(row => el('tr', {},
    el('td', { className: 'lb-rank' + (row.rank === 1 ? ' gold' : '') }, whackBossRankLabel(row.rank)),
    el('td', { className: 'lb-nick' + (row.user_id === me?.id ? ' me' : '') }, row.nick + (row.user_id === me?.id ? ' (Ty)' : '')),
    el('td', { className: 'lb-num', title: 'Rozbrojonych plansz' }, String(row.boards_cleared ?? 0)),
    lbScoreCell(row)
  ));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'),
        el('th', {}, 'Nick'),
        el('th', { title: 'Rozbrojonych plansz' }, '🚩'),
        el('th', { title: 'Najwyższy wynik' }, 'Wynik')
      )),
      el('tbody', {}, ...bodyRows)
    )
  );
}

function renderSaperAwards(wrap, awards) {
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

// ── Input ───────────────────────────────────────────────────────────────────
// Desktop: left = open (or chord, if the cell is a number whose flags add up),
// right = flag. Touch has neither a right button nor a hover, so it gets the
// two things mobile Minesweeper settled on years ago: a long press flags, and
// a 🚩 mode button flips what a plain tap does.

const SP_LONG_PRESS_MS = 320;

function saperSyncFlagBtn() {
  if (!spFlagBtn) return;
  const on = !!saperRuntime?.flagMode;
  spFlagBtn.classList.toggle('is-on', on);
  spFlagBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  spFlagBtn.textContent = on ? '🚩 Tryb flag: WŁ' : '🚩 Tryb flag: WYŁ';
}

function spCellFromEvent(evt) {
  const canvas = document.getElementById('sp-canvas');
  const rt = saperRuntime;
  if (!canvas || !rt?.sim?.board) return -1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return -1;
  const b = rt.sim.board;
  const g = spGeom(b);
  const x = (evt.clientX - rect.left) * (SP_CS_W / rect.width) - g.x0;
  const y = (evt.clientY - rect.top) * (SP_CS_H / rect.height) - g.y0;
  if (x < 0 || y < 0 || x >= g.bw || y >= g.bh) return -1;
  const cx = Math.floor(x / g.cell);
  const cy = Math.floor(y / g.cell);
  return cy * b.w + cx;
}

// The one place a move enters the log. Nothing is recorded that the simulation
// did not accept, so a replay can never trip over a move the client only tried.
function spDo(action, cell) {
  const rt = saperRuntime;
  if (!rt?.playing || cell < 0) return false;
  // While a finished board is held on screen the live board underneath is
  // invisible; taking input for it would mean clicking blind.
  if (rt.freeze && rt.freeze.until > performance.now()) return false;

  const st = rt.sim;
  const before = st.board;
  const clearedBefore = st.cleared;
  const scoreBefore = st.score;
  if (!spApplyMove(st, action, cell)) return false;
  rt.moveLog.push({ tick: st.tick, a: action, c: cell });

  if (before.boom) {
    rt.freeze = { board: before, until: performance.now() + SP_FREEZE_BOOM_MS, kind: 'boom' };
    rt.floats.push({ x: SP_CS_W / 2, y: SP_HUD_H + 40, until: performance.now() + SP_FLOAT_MS, text: '💥 −5 s', color: '#dc2626' });
  } else if (st.cleared > clearedBefore) {
    rt.freeze = { board: before, until: performance.now() + SP_FREEZE_CLEAR_MS, kind: 'clear' };
    rt.floats.push({ x: SP_CS_W / 2, y: SP_HUD_H + 40, until: performance.now() + SP_FLOAT_MS, text: '+' + (st.score - scoreBefore), color: '#0a7d2c' });
  }
  saperSetStats();
  return true;
}

// A plain tap: open, unless the flag toggle is on, or the cell is a revealed
// number — chording there is what makes a fast run fast.
function spPrimary(cell) {
  const rt = saperRuntime;
  if (!rt?.sim?.board || cell < 0) return;
  if (rt.flagMode) { spDo(SP_FLAG, cell); return; }
  if (rt.sim.board.open[cell]) { spDo(SP_CHORD, cell); return; }
  spDo(SP_OPEN, cell);
}

if (spArena) {
  spArena.addEventListener('contextmenu', evt => evt.preventDefault());

  spArena.addEventListener('pointerdown', evt => {
    const rt = saperRuntime;
    if (!rt?.playing) {
      if (!rt?.submitting) startSaperRound();
      return;
    }
    evt.preventDefault();
    const cell = spCellFromEvent(evt);
    if (cell < 0) return;
    if (evt.button === 2) { spDo(SP_FLAG, cell); rt.press = null; return; }
    // Touch/pen: hold to flag. The mouse acts on pointerdown as usual.
    if (evt.pointerType === 'mouse') { spPrimary(cell); rt.press = null; return; }
    rt.press = {
      cell,
      x: evt.clientX,
      y: evt.clientY,
      timer: setTimeout(() => {
        const r = saperRuntime;
        if (!r?.press || r.press.cell !== cell) return;
        r.press = null;
        spDo(SP_FLAG, cell);
      }, SP_LONG_PRESS_MS),
    };
  });

  spArena.addEventListener('pointermove', evt => {
    const rt = saperRuntime;
    if (!rt?.press) return;
    if (Math.abs(evt.clientX - rt.press.x) > 12 || Math.abs(evt.clientY - rt.press.y) > 12) {
      clearTimeout(rt.press.timer);
      rt.press = null;
    }
  });

  const endPress = evt => {
    const rt = saperRuntime;
    if (!rt?.press) return;
    clearTimeout(rt.press.timer);
    const cell = rt.press.cell;
    rt.press = null;
    if (evt.type === 'pointerup' && spCellFromEvent(evt) === cell) spPrimary(cell);
  };
  spArena.addEventListener('pointerup', endPress);
  spArena.addEventListener('pointercancel', endPress);
  spArena.addEventListener('pointerleave', endPress);
}

if (spStartBtn) spStartBtn.addEventListener('click', startSaperRound);
if (spFlagBtn) {
  spFlagBtn.addEventListener('click', () => {
    const rt = saperRuntime || saperResetBoard(1);
    rt.flagMode = !rt.flagMode;
    saperSyncFlagBtn();
  });
}

// The panel is moved into #ag-game-slot after this file loads, so paint an idle
// board once rather than trusting the canvas has been measured.
saperInitCanvas();
if (!saperRuntime) saperResetBoard(1);
saperSyncFlagBtn();
saperDraw();
