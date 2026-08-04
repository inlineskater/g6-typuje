// ── „Kulki G6" (bubble_breaker) — Bubble Breaker / SameGame ──────────────────
// The Windows Mobile classic that shipped on every Pocket PC (Dell Axim X51 &
// friends): a board full of coloured balls, tap a group of touching same-colour
// balls to pop it, and the bigger the group the more it is worth — n×(n−1), so
// one group of 10 (90) beats five groups of 2 (10). Balls fall into the gap and
// empty columns slide left; the round ends when no group of two remains.
//
// ARCADE-ONLY (like Filler and Uzdrowiciel were at launch): there is no
// bubble-breaker-action Edge Function and no seasonal SQL, so the score is
// client-reported through record_arcade_score() exactly like every other
// arcade-archive run, guarded only by the cap in supabase/arcade.sql.
// The simulation below is nevertheless kept PURE and DETERMINISTIC (seed +
// a list of tapped indices fully reproduces a round, no DOM/network/Date
// inside bbInitState/bbPopAt) for two reasons: games/previews.js runs the real
// thing rather than a look-alike, and promoting this to a seasonal game later
// is then a transcription of the block below into an Edge Function, not a
// rewrite. Keep that property when editing.

const BB_COLS = 15;
const BB_ROWS = 15;
const BB_COLORS = 5;
const BB_MIN_GROUP = 2;
const BB_CLEAR_BONUS = 1000;   // board emptied completely
// Score ceiling used by the anti-cheat cap in supabase/arcade.sql. Total score
// over a full board is exactly BALLS × (average group size − 1), so even the
// fantasy board where all 225 balls arrive pre-sorted into five solid 45-ball
// blobs scores 225×44 = 9900, +1000 for the clear = 10900. 12000 leaves head
// room without being meaningless.
const BB_MAX_SCORE = 12000;

const BB_CELL = 24;
const BB_HUD_H = 40;
const BB_CS_W = BB_COLS * BB_CELL;                 // 360
const BB_CS_H = BB_HUD_H + BB_ROWS * BB_CELL;      // 400
const BB_MAX_DPR = 2;

const BB_FALL_MS = 190;   // ball slide after a pop
const BB_BURST_MS = 260;  // popped-ball ring
const BB_FLOAT_MS = 750;  // rising „+42"

function bbIdx(col, row) { return row * BB_COLS + col; }

function bbRng(st) {
  st.rngState = (Math.imul(st.rngState, 1664525) + 1013904223) >>> 0;
  return st.rngState / 4294967296;
}

function bbInitState(seed) {
  const st = {
    rngState: (Number(seed) >>> 0) || 1,
    cells: new Array(BB_COLS * BB_ROWS).fill(-1),
    // Cosmetic-only, but derived from the same deterministic stream so a
    // replay produces identical ids: lets the renderer animate a ball from
    // where it was to where it landed instead of teleporting the board.
    ids: new Array(BB_COLS * BB_ROWS).fill(0),
    nextId: 1,
    score: 0,
    popped: 0,
    pops: 0,
    best: 0,       // largest group popped this round
    cleared: false,
    over: false,
  };
  for (let i = 0; i < st.cells.length; i += 1) {
    st.cells[i] = Math.floor(bbRng(st) * BB_COLORS);
    st.ids[i] = st.nextId;
    st.nextId += 1;
  }
  return st;
}

// Every ball 4-connected to `start` sharing its colour. Returns [] on an empty
// cell. Same-colour balls touching only at a corner are NOT connected.
function bbGroupAt(cells, start) {
  const color = cells[start];
  if (color < 0) return [];
  const seen = new Set([start]);
  const stack = [start];
  const out = [];
  while (stack.length) {
    const idx = stack.pop();
    out.push(idx);
    const col = idx % BB_COLS;
    const row = (idx - col) / BB_COLS;
    if (col > 0)            bbGroupPush(cells, seen, stack, bbIdx(col - 1, row), color);
    if (col < BB_COLS - 1)  bbGroupPush(cells, seen, stack, bbIdx(col + 1, row), color);
    if (row > 0)            bbGroupPush(cells, seen, stack, bbIdx(col, row - 1), color);
    if (row < BB_ROWS - 1)  bbGroupPush(cells, seen, stack, bbIdx(col, row + 1), color);
  }
  return out;
}

function bbGroupPush(cells, seen, stack, idx, color) {
  if (seen.has(idx) || cells[idx] !== color) return;
  seen.add(idx);
  stack.push(idx);
}

function bbGroupScore(n) { return n < BB_MIN_GROUP ? 0 : n * (n - 1); }

// Balls drop to the bottom of their column, then non-empty columns slide left —
// the original's compaction, which is what keeps distant colours meeting.
function bbSettle(st) {
  const cells = st.cells, ids = st.ids;
  for (let col = 0; col < BB_COLS; col += 1) {
    let write = BB_ROWS - 1;
    for (let row = BB_ROWS - 1; row >= 0; row -= 1) {
      const from = bbIdx(col, row);
      if (cells[from] < 0) continue;
      const to = bbIdx(col, write);
      if (to !== from) {
        cells[to] = cells[from]; ids[to] = ids[from];
        cells[from] = -1; ids[from] = 0;
      }
      write -= 1;
    }
  }
  let writeCol = 0;
  for (let col = 0; col < BB_COLS; col += 1) {
    if (cells[bbIdx(col, BB_ROWS - 1)] < 0) continue;   // empty column: skip
    if (writeCol !== col) {
      for (let row = 0; row < BB_ROWS; row += 1) {
        const from = bbIdx(col, row), to = bbIdx(writeCol, row);
        cells[to] = cells[from]; ids[to] = ids[from];
        cells[from] = -1; ids[from] = 0;
      }
    }
    writeCol += 1;
  }
}

function bbHasMove(cells) {
  for (let idx = 0; idx < cells.length; idx += 1) {
    const color = cells[idx];
    if (color < 0) continue;
    const col = idx % BB_COLS;
    const row = (idx - col) / BB_COLS;
    if (col < BB_COLS - 1 && cells[bbIdx(col + 1, row)] === color) return true;
    if (row < BB_ROWS - 1 && cells[bbIdx(col, row + 1)] === color) return true;
  }
  return false;
}

function bbRemaining(cells) {
  let n = 0;
  for (let i = 0; i < cells.length; i += 1) if (cells[i] >= 0) n += 1;
  return n;
}

// The one state transition. Returns null when the tap is not a legal pop.
function bbPopAt(st, start) {
  if (st.over) return null;
  const group = bbGroupAt(st.cells, start);
  if (group.length < BB_MIN_GROUP) return null;

  const before = new Map();
  for (let i = 0; i < st.cells.length; i += 1) if (st.cells[i] >= 0) before.set(st.ids[i], i);

  const gained = bbGroupScore(group.length);
  group.forEach(idx => { st.cells[idx] = -1; st.ids[idx] = 0; });
  bbSettle(st);

  st.score += gained;
  st.popped += group.length;
  st.pops += 1;
  if (group.length > st.best) st.best = group.length;

  const left = bbRemaining(st.cells);
  if (left === 0) {
    st.cleared = true;
    st.score += BB_CLEAR_BONUS;
  }
  if (!bbHasMove(st.cells)) st.over = true;

  const moved = [];
  for (let i = 0; i < st.cells.length; i += 1) {
    if (st.cells[i] < 0) continue;
    const from = before.get(st.ids[i]);
    if (from != null && from !== i) moved.push({ to: i, from });
  }
  return { group, gained, moved, remaining: left };
}

// ── Runtime ─────────────────────────────────────────────────────────────────

function newBubbleBreakerRuntime() {
  return {
    playing: false, submitting: false, settled: false, archiveMode: false,
    seed: 1,
    sim: bbInitState(1),
    sel: null,          // { anchor, group, gain } — hovered (mouse) or tapped (touch)
    anim: null,         // { until, moves: [{to, from}] }
    burst: [],          // { idx, until, color }
    floats: [],         // { x, y, until, text }
    raf: null,
    startedAt: 0,
    endedReason: '',
  };
}

let bbCtx = null;

const BB_HEX      = ['#e5484d', '#3b82f6', '#22c55e', '#eab308', '#a855f7'];
const BB_HEX_LITE = ['#ff9a9c', '#93c5fd', '#86efac', '#fde68a', '#e9d5ff'];
const BB_HEX_DARK = ['#8f1d20', '#1d4ed8', '#15803d', '#a16207', '#6b21a8'];

function bubbleBreakerInitCanvas() {
  const canvas = document.getElementById('bb-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const DPR = Math.min(window.devicePixelRatio || 1, BB_MAX_DPR);
  const w = Math.round((rect.width || BB_CS_W) * DPR);
  const h = Math.round((rect.height || BB_CS_H) * DPR);
  if (!bbCtx || canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    bbCtx = canvas.getContext('2d');
  }
  bbCtx.setTransform(w / BB_CS_W, 0, 0, h / BB_CS_H, 0, 0);
}

function bubbleBreakerResetBoard(seed = 1) {
  const rt = bubbleBreakerRuntime || newBubbleBreakerRuntime();
  rt.seed = seed;
  rt.sim = bbInitState(seed);
  rt.sel = null;
  rt.anim = null;
  rt.burst = [];
  rt.floats = [];
  rt.endedReason = '';
  rt.settled = false;   // a fresh board may be submitted again
  bubbleBreakerRuntime = rt;
  return rt;
}

function bbCellCenter(idx) {
  const col = idx % BB_COLS;
  const row = (idx - col) / BB_COLS;
  return { x: col * BB_CELL + BB_CELL / 2, y: BB_HUD_H + row * BB_CELL + BB_CELL / 2 };
}

function bbDrawBall(ctx, x, y, r, color, opts = {}) {
  const g = ctx.createRadialGradient(x - r * 0.34, y - r * 0.38, r * 0.12, x, y, r);
  g.addColorStop(0, BB_HEX_LITE[color]);
  g.addColorStop(0.55, BB_HEX[color]);
  g.addColorStop(1, BB_HEX_DARK[color]);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.beginPath();
  ctx.ellipse(x - r * 0.3, y - r * 0.38, r * 0.26, r * 0.18, -0.5, 0, Math.PI * 2);
  ctx.fill();
  if (opts.selected) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function bubbleBreakerDraw(now = performance.now()) {
  const ctx = bbCtx;
  if (!ctx) return;
  const rt = bubbleBreakerRuntime;
  const st = rt?.sim;
  const W = BB_CS_W, H = BB_CS_H;

  ctx.fillStyle = '#0f1729';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#141d33';
  ctx.fillRect(0, BB_HUD_H, W, H - BB_HUD_H);
  ctx.strokeStyle = 'rgba(148,163,184,.07)';
  ctx.lineWidth = 1;
  for (let c = 1; c < BB_COLS; c += 1) {
    ctx.beginPath();
    ctx.moveTo(c * BB_CELL, BB_HUD_H);
    ctx.lineTo(c * BB_CELL, H);
    ctx.stroke();
  }
  for (let r = 1; r < BB_ROWS; r += 1) {
    ctx.beginPath();
    ctx.moveTo(0, BB_HUD_H + r * BB_CELL);
    ctx.lineTo(W, BB_HUD_H + r * BB_CELL);
    ctx.stroke();
  }

  if (st) {
    const selected = new Set(rt.sel ? rt.sel.group : []);
    // A ball that just moved is drawn on the way from its old cell to its new
    // one; `from` positions come straight off the last bbPopAt result.
    const anim = rt.anim && rt.anim.until > now ? rt.anim : null;
    const t = anim ? 1 - Math.pow((rt.anim.until - now) / BB_FALL_MS, 2) : 1;
    const fromByTo = new Map();
    if (anim) rt.anim.moves.forEach(m => fromByTo.set(m.to, m.from));

    const pulse = rt.sel ? 1 + 0.06 * Math.sin(now / 110) : 1;
    for (let idx = 0; idx < st.cells.length; idx += 1) {
      const color = st.cells[idx];
      if (color < 0) continue;
      const to = bbCellCenter(idx);
      let x = to.x, y = to.y;
      const from = fromByTo.get(idx);
      if (from != null) {
        const f = bbCellCenter(from);
        x = f.x + (to.x - f.x) * t;
        y = f.y + (to.y - f.y) * t;
      }
      const isSel = selected.has(idx);
      bbDrawBall(ctx, x, y, (BB_CELL / 2 - 1.5) * (isSel ? pulse : 1), color, { selected: isSel });
    }

    rt.burst = rt.burst.filter(b => b.until > now);
    rt.burst.forEach(b => {
      const k = 1 - (b.until - now) / BB_BURST_MS;
      const p = bbCellCenter(b.idx);
      ctx.strokeStyle = BB_HEX[b.color];
      ctx.globalAlpha = Math.max(0, 1 - k);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (BB_CELL / 2 - 1.5) * (1 + k * 1.1), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    rt.floats = rt.floats.filter(f => f.until > now);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 15px system-ui, sans-serif';
    rt.floats.forEach(f => {
      const k = 1 - (f.until - now) / BB_FLOAT_MS;
      ctx.globalAlpha = Math.max(0, 1 - k);
      ctx.fillStyle = '#fef3c7';
      ctx.fillText(f.text, f.x, f.y - k * 26);
      ctx.globalAlpha = 1;
    });
  }

  // HUD strip
  ctx.fillStyle = '#0b1120';
  ctx.fillRect(0, 0, W, BB_HUD_H);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 9px system-ui, sans-serif';
  ctx.fillText('WYNIK', 10, 13);
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 19px system-ui, sans-serif';
  ctx.fillText(String(st ? st.score : 0), 10, 27);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 9px system-ui, sans-serif';
  ctx.fillText('KULEK', W - 10, 13);
  ctx.fillStyle = '#cbd5e1';
  ctx.font = 'bold 19px system-ui, sans-serif';
  ctx.fillText(String(st ? bbRemaining(st.cells) : 0), W - 10, 27);

  ctx.textAlign = 'center';
  if (rt?.sel) {
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText('⬤ ×' + rt.sel.group.length + '  =  +' + rt.sel.gain, W / 2, 21);
  }

  if (!rt?.playing) {
    ctx.fillStyle = 'rgba(8,12,24,.82)';
    ctx.fillRect(0, BB_HUD_H, W, H - BB_HUD_H);
    ctx.textAlign = 'center';
    if (st && st.over && st.pops > 0) {
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 26px system-ui, sans-serif';
      ctx.fillText('KONIEC GRY', W / 2, H / 2 - 30);
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 40px system-ui, sans-serif';
      ctx.fillText(String(st.score), W / 2, H / 2 + 12);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(st.cleared
        ? 'Plansza wyczyszczona! +' + BB_CLEAR_BONUS + ' bonusu'
        : 'Zostało ' + bbRemaining(st.cells) + ' kulek bez pary', W / 2, H / 2 + 46);
    } else {
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 28px system-ui, sans-serif';
      ctx.fillText('KULKI G6', W / 2, H / 2 - 24);
      ctx.font = '30px system-ui, sans-serif';
      ctx.fillText('🔴🔵🟢🟡🟣', W / 2, H / 2 + 16);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Zbijaj grupy stykających się kulek', W / 2, H / 2 + 54);
    }
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function bubbleBreakerSetStats() {
  const st = bubbleBreakerRuntime?.sim;
  if (!st) return;
  if (bbScoreEl) bbScoreEl.textContent = String(st.score);
  if (bbBallsEl) bbBallsEl.textContent = String(bbRemaining(st.cells));
  if (bbPopsEl)  bbPopsEl.textContent  = String(st.pops);
  if (bbBestEl)  bbBestEl.textContent  = String(st.best);
}

function bubbleBreakerLoop() {
  const rt = bubbleBreakerRuntime;
  if (!rt?.playing) return;
  bubbleBreakerDraw();
  rt.raf = requestAnimationFrame(bubbleBreakerLoop);
}

function stopBubbleBreakerRound() {
  const rt = bubbleBreakerRuntime;
  if (rt?.raf) cancelAnimationFrame(rt.raf);
  const wasArchive = rt?.archiveMode || false;
  bubbleBreakerRuntime = newBubbleBreakerRuntime();
  bubbleBreakerResetBoard(1);
  bubbleBreakerRuntime.playing = false;
  bubbleBreakerRuntime.archiveMode = wasArchive;
  if (bbStartBtn) { bbStartBtn.disabled = false; bbStartBtn.textContent = 'Start rundy'; }
  bubbleBreakerSetStats();
  bubbleBreakerInitCanvas();
  bubbleBreakerDraw();
}

function beginBubbleBreakerRound(seed) {
  stopBubbleBreakerRound();
  const rt = bubbleBreakerResetBoard(seed);
  rt.playing = true;
  rt.startedAt = performance.now();
  if (bbStartBtn) { bbStartBtn.disabled = true; bbStartBtn.textContent = 'Runda trwa'; }
  if (bbStatus) bbStatus.textContent = 'Najedź (albo dotknij) grupę, żeby ją zaznaczyć — kliknij zaznaczoną, żeby zbić.';
  bubbleBreakerSetStats();
  bubbleBreakerInitCanvas();
  bubbleBreakerLoop();
}

async function startBubbleBreakerRound() {
  const rt = bubbleBreakerRuntime;
  if (rt?.playing || rt?.submitting) return;
  if (allGamesMode) {
    try { await payArcadeEntry(allGamesSelectedGame); }
    catch (e) { showToast('❌ Nie udało się wejść do gry.'); return; }
  }
  beginBubbleBreakerRound((Math.floor(Math.random() * 0xfffffff) + 1) >>> 0);
  if (allGamesMode) bubbleBreakerRuntime.archiveMode = true;
}

async function finishBubbleBreakerRound() {
  const rt = bubbleBreakerRuntime;
  // `submitting` alone is not enough: it is cleared in the finally below, so a
  // second call after the first completed would submit the same board again and
  // report a cheerful „zapisano" for a row the RPC's 5 s cooldown rejected.
  // `settled` is the one-way latch; only a new round clears it.
  if (!rt || rt.submitting || rt.settled) return;
  rt.playing = false;
  rt.submitting = true;
  rt.settled = true;
  if (rt.raf) cancelAnimationFrame(rt.raf);
  rt.sel = null;
  bubbleBreakerSetStats();
  bubbleBreakerDraw();

  const score = Math.min(BB_MAX_SCORE, rt.sim.score);
  const tail = rt.sim.cleared ? ' 🧹 Cała plansza wyczyszczona!' : '';
  if (!allGamesMode) {
    rt.submitting = false;
    if (bbStartBtn) { bbStartBtn.disabled = false; bbStartBtn.textContent = 'Zagraj ponownie'; }
    if (bbStatus) bbStatus.textContent = 'Demo — wynik: ' + score + ' (nie zapisano).' + tail;
    return;
  }
  if (bbStartBtn) { bbStartBtn.disabled = true; bbStartBtn.textContent = 'Zapisuję...'; }
  try {
    await recordArcadeScore('bubble_breaker', score);
    if (bbStatus) bbStatus.textContent = 'Wynik: ' + score + ' · zapisano w rankingu arcade!' + tail;
    showToast('✅ Wynik zapisany: ' + score);
    loadArcadeScores('bubble_breaker');
  } catch (err) {
    if (bbStatus) bbStatus.textContent = 'Wynik: ' + score + ' (błąd zapisu).';
    showToast('❌ Nie udało się zapisać wyniku.');
  } finally {
    rt.submitting = false;
    if (bbStartBtn) { bbStartBtn.disabled = false; bbStartBtn.textContent = 'Zagraj ponownie'; }
  }
}

// ── Input ───────────────────────────────────────────────────────────────────
// One rule covers both pointer kinds: a tap on the CURRENTLY SELECTED group
// pops it, anything else just selects. A mouse selects by hovering, so a
// desktop player pops with a single click; a finger has no hover, so touch
// falls back to the original's tap-to-select / tap-again-to-pop confirmation.

function bbCellFromEvent(evt) {
  const canvas = document.getElementById('bb-canvas');
  if (!canvas) return -1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return -1;
  const x = (evt.clientX - rect.left) * (BB_CS_W / rect.width);
  const y = (evt.clientY - rect.top) * (BB_CS_H / rect.height) - BB_HUD_H;
  if (x < 0 || y < 0) return -1;
  const col = Math.floor(x / BB_CELL);
  const row = Math.floor(y / BB_CELL);
  if (col < 0 || col >= BB_COLS || row < 0 || row >= BB_ROWS) return -1;
  return bbIdx(col, row);
}

function bbSelect(idx) {
  const rt = bubbleBreakerRuntime;
  if (!rt?.playing) return;
  if (idx < 0) { rt.sel = null; return; }
  if (rt.sel && rt.sel.group.includes(idx)) return;   // same group, nothing changes
  const group = bbGroupAt(rt.sim.cells, idx);
  rt.sel = group.length >= BB_MIN_GROUP
    ? { anchor: idx, group, gain: bbGroupScore(group.length) }
    : null;
}

function bbCommit(idx) {
  const rt = bubbleBreakerRuntime;
  if (!rt?.playing || idx < 0) return;
  // Read the colour BEFORE popping — bbPopAt clears those cells, so afterwards
  // there is nothing left on the board to tint the burst rings with.
  const color = rt.sim.cells[idx];
  const res = bbPopAt(rt.sim, idx);
  if (!res) return;
  const now = performance.now();
  res.group.forEach(i => rt.burst.push({ idx: i, color, until: now + BB_BURST_MS }));
  rt.anim = { until: now + BB_FALL_MS, moves: res.moved };
  const anchor = bbCellCenter(idx);
  rt.floats.push({ x: anchor.x, y: anchor.y, until: now + BB_FLOAT_MS, text: '+' + res.gained });
  rt.sel = null;
  bubbleBreakerSetStats();
  if (rt.sim.over) {
    rt.endedReason = rt.sim.cleared ? 'plansza wyczyszczona' : 'brak ruchów';
    setTimeout(() => { if (bubbleBreakerRuntime === rt) finishBubbleBreakerRound(); }, BB_FALL_MS + 120);
  }
}

if (bbArena) {
  bbArena.addEventListener('pointermove', evt => {
    if (evt.pointerType !== 'mouse') return;
    const rt = bubbleBreakerRuntime;
    if (!rt?.playing) return;
    bbSelect(bbCellFromEvent(evt));
  });
  bbArena.addEventListener('pointerleave', evt => {
    if (evt.pointerType !== 'mouse') return;
    const rt = bubbleBreakerRuntime;
    if (rt?.playing) rt.sel = null;
  });
  bbArena.addEventListener('pointerdown', evt => {
    evt.preventDefault();
    const rt = bubbleBreakerRuntime;
    if (!rt?.playing) {
      if (!rt?.submitting) startBubbleBreakerRound();
      return;
    }
    const idx = bbCellFromEvent(evt);
    if (idx < 0) return;
    if (rt.sel && rt.sel.group.includes(idx)) bbCommit(idx);
    else bbSelect(idx);
  });
}

if (bbStartBtn) bbStartBtn.addEventListener('click', startBubbleBreakerRound);

// The panel is moved into #ag-game-slot after this file loads, so paint an
// idle board once the DOM settles rather than trusting the canvas is measured.
bubbleBreakerInitCanvas();
if (!bubbleBreakerRuntime) bubbleBreakerResetBoard(1);
bubbleBreakerDraw();
