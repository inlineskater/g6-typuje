// ── Bug Jumper (canvas) ───────────────────────────────────────────────────
// Course is procedurally generated per round from a server-issued seed (same
// deterministic-seed pattern as Snake/Invoice Horde/Popup Panic): the browser
// derives the lane/wall layout locally via bjGenerateCourse(seed) to play in
// real time, and bug-jumper-action independently re-derives it from the
// stored seed to replay + validate submitted moves. bjGenerateCourse and its
// helpers (bjMakeRng, bjCrawlColAt, bjBounceColAt, bjCellBlocked, bjCellOpen)
// must stay byte-for-byte identical to generateCourse/crawlColAt/bounceColAt/
// cellBlocked/cellOpen in supabase/functions/bug-jumper-action/index.ts.

const BJ_COLS         = 56;       // wide ~16:9 board (fits a fullscreen 1920x1080 monitor)
const BJ_ROWS         = 32;       // 0=start, 1-30=lines, 31=finish
const BJ_LANE_COUNT   = 30;
const BJ_SAFE_ROWS    = Object.freeze([10, 20, 30]);
const BJ_BAND_HALF    = 7;        // corridor half-width: band is center±7 (15 cols wide)
const BJ_DRIFT_MAX    = 3;        // corridor center can shift by up to ±3 cols per row
const BJ_DURATION_MS  = 25000;
const BJ_INPUT_COOLDOWN_MS = 100;
const BJ_MAX_SCORE    = 30;
const BJ_COURSE_VERSION = 5;
const BJ_CELL        = 24;
const BJ_CS_W        = BJ_COLS * BJ_CELL;
const BJ_CS_H        = BJ_ROWS * BJ_CELL;
const BJ_START_COL   = Math.floor(BJ_COLS / 2);
const BJ_MAX_DPR     = 1.5;
const BJ_INPUT_QUEUE_MAX = 4;
const BJ_INPUT_QUEUE_TTL_MS = 600;

function bjMakeRng(seed) {
  let state = Number(seed || 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// The corridor's center drifts a little (±BJ_DRIFT_MAX cols) row by row —
// no fixed template, so the walk is different every round and never repeats
// the same turn pattern twice (straight/L/S/zigzag all fall out of the same
// walk naturally, along with shapes no fixed catalog would produce).
// Three obstacle kinds live inside the corridor:
//   crawl  — sweeps across the band and wraps around (classic bug)
//   bounce — paces back and forth inside a smaller sub-range (doesn't wrap)
//   block  — stationary, always blocking its cell(s)
function bjGenerateCourse(seed) {
  const rng = bjMakeRng(seed);
  const lanes = [];
  let center = BJ_START_COL;
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
        // block never wraps, so col must leave room for the full length
        // inside the band (crawl doesn't need this — it wraps segment-by-
        // segment in bjCellBlocked, so any starting col self-corrects).
        const len = 1 + (rng() < 0.15 ? 1 : 0);
        const col = bandStart + Math.floor(rng() * (bandWidth - len + 1));
        obstacles.push({ kind: 'block', col, len });
      }
    }
    lanes.push({ safe: false, bandStart, bandEnd, obstacles });
  }
  return {
    id: BUG_JUMPER_DYNAMIC_COURSE_ID,
    version: BJ_COURSE_VERSION,
    seed: Number(seed) >>> 0,
    cols: BJ_COLS,
    rows: BJ_ROWS,
    laneCount: BJ_LANE_COUNT,
    safeRows: BJ_SAFE_ROWS,
    durationMs: BJ_DURATION_MS,
    inputCooldownMs: BJ_INPUT_COOLDOWN_MS,
    maxScore: BJ_MAX_SCORE,
    lanes,
  };
}

function newBugJumperRuntime() {
  return {
    playing: false, submitting: false, archiveMode: false,
    roundId: null,
    courseId: BUG_JUMPER_DYNAMIC_COURSE_ID,
    course: null,
    score: 0,
    playerCol: BJ_START_COL,
    playerRow: 0,
    bestRowReached: 0,
    completed: false,
    completionMs: null,
    collisions: 0,
    moveLog: [],
    durationMs: BJ_DURATION_MS,
    startPerf: 0, rafId: null,
    expiresAt: null,
    hitFlash: 0, prodFlash: 0,
    inputCooldown: 0,
    inputQueue: [],
    toasts: [],
  };
}

let bjCtx = null;
let bjStaticLayer = null;
let bjStaticLayerKey = '';
let bjOverlayLayer = null;
let bjOverlayLayerKey = '';
let bjSpriteCache = null;
let bjStatScoreText = null;
let bjStatProgressText = null;
let bjStatTimeText = null;

function bjInitCanvas() {
  const canvas = document.getElementById('bj-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const DPR = Math.min(window.devicePixelRatio || 1, BJ_MAX_DPR);
  const w = Math.round((rect.width || BJ_CS_W) * DPR);
  const h = Math.round((rect.height || BJ_CS_H) * DPR);
  if (bjCtx && canvas.width === w && canvas.height === h) return;
  canvas.width  = w;
  canvas.height = h;
  bjCtx = canvas.getContext('2d');
  bjCtx.setTransform(w / BJ_CS_W, 0, 0, h / BJ_CS_H, 0, 0);
  bjCtx.imageSmoothingEnabled = false;
}

function bjCourseKey(course) {
  return [course?.id || 'course', course?.version || 0, course?.seed || 0].join(':');
}

function bjCreateLayer() {
  const canvas = document.createElement('canvas');
  canvas.width = BJ_CS_W;
  canvas.height = BJ_CS_H;
  return { canvas, ctx: canvas.getContext('2d') };
}

function bjGetStaticLayer(course) {
  const key = bjCourseKey(course);
  if (bjStaticLayer && bjStaticLayerKey === key) return bjStaticLayer;

  const { canvas, ctx } = bjCreateLayer();
  const W = BJ_CS_W, H = BJ_CS_H, C = BJ_CELL;

  for (let row = 0; row < BJ_ROWS; row++) {
    const y = (BJ_ROWS - 1 - row) * C;
    if (row === 0) ctx.fillStyle = '#161b24';
    else if (row === BJ_ROWS - 1) ctx.fillStyle = '#0e2e28';
    else if (BJ_SAFE_ROWS.includes(row)) ctx.fillStyle = '#0f2b30';
    else ctx.fillStyle = row % 2 === 0 ? '#141922' : '#10141b';
    ctx.fillRect(0, y, W, C);
  }

  // ── Walls — cells outside this round's corridor band, blocking movement ──
  if (course?.lanes) {
    ctx.fillStyle = '#241019';
    for (let row = 1; row <= BJ_LANE_COUNT; row++) {
      if (BJ_SAFE_ROWS.includes(row)) continue;
      const lane = course.lanes[row - 1];
      if (!lane) continue;
      const y = (BJ_ROWS - 1 - row) * C;
      for (let col = 0; col < BJ_COLS; col++) {
        if (col < lane.bandStart || col > lane.bandEnd) ctx.fillRect(col * C, y, C, C);
      }
    }
    ctx.strokeStyle = 'rgba(244,63,94,0.25)';
    ctx.lineWidth = 1;
    for (let row = 1; row <= BJ_LANE_COUNT; row++) {
      if (BJ_SAFE_ROWS.includes(row)) continue;
      const lane = course.lanes[row - 1];
      if (!lane) continue;
      const y = (BJ_ROWS - 1 - row) * C;
      for (let col = 0; col < BJ_COLS; col++) {
        if (col < lane.bandStart || col > lane.bandEnd) ctx.strokeRect(col * C + 0.5, y + 0.5, C - 1, C - 1);
      }
    }
  }

  ctx.strokeStyle = 'rgba(34,211,238,0.14)';
  ctx.lineWidth = 1;
  for (let c = 0; c <= BJ_COLS; c++) {
    ctx.beginPath(); ctx.moveTo(c * C, 0); ctx.lineTo(c * C, H); ctx.stroke();
  }
  for (let r = 0; r <= BJ_ROWS; r++) {
    ctx.beginPath(); ctx.moveTo(0, r * C); ctx.lineTo(W, r * C); ctx.stroke();
  }

  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  for (let row = 0; row < BJ_ROWS; row++) {
    let label;
    if (row === 0) label = 'START';
    else if (row === BJ_ROWS - 1) label = 'GÓRA';
    else if (BJ_SAFE_ROWS.includes(row)) label = 'SAFE ' + row;
    else label = 'LINIA ' + row;
    ctx.fillStyle = row === BJ_ROWS - 1 ? '#2dd4bf' : 'rgba(34,211,238,0.45)';
    if (BJ_SAFE_ROWS.includes(row)) ctx.fillStyle = '#5eead4';
    ctx.fillText(label, 3, (BJ_ROWS - 1 - row) * C + 3);
  }

  bjStaticLayer = canvas;
  bjStaticLayerKey = key;
  return bjStaticLayer;
}

function bjGetOverlayLayer(course) {
  const key = bjCourseKey(course);
  if (bjOverlayLayer && bjOverlayLayerKey === key) return bjOverlayLayer;

  const { canvas, ctx } = bjCreateLayer();
  const W = BJ_CS_W, H = BJ_CS_H;

  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  for (let sy = 0; sy < H; sy += 3) {
    ctx.fillRect(0, sy, W, 1);
  }

  ctx.strokeStyle = 'rgba(34,211,238,0.25)';
  ctx.lineWidth = 5;
  ctx.strokeRect(2.5, 2.5, W - 5, H - 5);
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  bjOverlayLayer = canvas;
  bjOverlayLayerKey = key;
  return bjOverlayLayer;
}

function bjCreateCellSprite(draw) {
  const canvas = document.createElement('canvas');
  canvas.width = BJ_CELL;
  canvas.height = BJ_CELL;
  const ctx = canvas.getContext('2d');
  draw(ctx, BJ_CELL);
  return canvas;
}

function bjGetSprites() {
  if (bjSpriteCache) return bjSpriteCache;

  const makeHead = (bg, border, emoji) => bjCreateCellSprite((ctx, C) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, C, C);
    ctx.strokeStyle = border;
    ctx.strokeRect(0.5, 0.5, C - 1, C - 1);
    ctx.font = `${Math.round(C * 0.5)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(emoji, C / 2, C / 2);
  });

  const makeBody = (bg, border) => bjCreateCellSprite((ctx, C) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, C, C);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, C - 1, C - 1);
  });

  const makePlayer = (fill) => bjCreateCellSprite((ctx, C) => {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, C, C);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(C * 0.5)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('▲', C / 2, C / 2);
  });

  bjSpriteCache = {
    crawlHead: makeHead('#7c2d12', 'rgba(251,146,60,0.4)', '🐛'),
    crawlBody: makeBody('#7c2d12', 'rgba(251,146,60,0.3)'),
    bounceHead: makeHead('#4c1d95', 'rgba(167,139,250,0.4)', '☎️'),
    blockHead: makeHead('#78350f', 'rgba(251,191,36,0.5)', '🚧'),
    blockBody: makeBody('#78350f', 'rgba(251,191,36,0.35)'),
    player: makePlayer('#22d3ee'),
    playerHit: makePlayer('#f43f5e'),
  };
  return bjSpriteCache;
}

function bjMod(n, m) {
  return ((n % m) + m) % m;
}

function bjElapsed(now = performance.now()) {
  const rt = bugJumperRuntime;
  if (!rt?.startPerf) return 0;
  return Math.max(0, Math.min(rt.durationMs, now - rt.startPerf));
}

// crawl: sweeps across the whole band, wrapping around at the edges.
function bjCrawlColAt(lane, obs, elapsedMs) {
  const bandWidth = lane.bandEnd - lane.bandStart + 1;
  const interval = Math.max(1, Number(obs.intervalMs) || 1);
  const phase = Math.max(0, Number(obs.phaseMs) || 0);
  const steps = Math.floor((Math.max(0, elapsedMs) + phase) / interval);
  const rel = bjMod((Number(obs.col) - lane.bandStart) + steps * Number(obs.dir || 1), bandWidth);
  return lane.bandStart + rel;
}

// bounce: paces back and forth inside its own smaller range — never wraps.
function bjBounceColAt(obs, elapsedMs) {
  const interval = Math.max(1, Number(obs.intervalMs) || 1);
  const phase = Math.max(0, Number(obs.phaseMs) || 0);
  const period = Math.max(1, 2 * (obs.rangeLen - 1));
  const steps = Math.floor((Math.max(0, elapsedMs) + phase) / interval);
  const cyclePos = bjMod(steps, period);
  const offset = cyclePos <= obs.rangeLen - 1 ? cyclePos : period - cyclePos;
  return obs.anchor + offset;
}

function bjCellBlocked(row, col, elapsedMs, course) {
  if (!course || row < 1 || row > BJ_LANE_COUNT) return false;
  const lane = course.lanes[row - 1];
  if (!lane || lane.safe) return false;
  const bandWidth = lane.bandEnd - lane.bandStart + 1;
  return lane.obstacles.some(obs => {
    if (obs.kind === 'crawl') {
      const head = bjCrawlColAt(lane, obs, elapsedMs);
      for (let i = 0; i < obs.len; i++) {
        if (lane.bandStart + bjMod((head - lane.bandStart) + i, bandWidth) === col) return true;
      }
      return false;
    }
    if (obs.kind === 'bounce') {
      return bjBounceColAt(obs, elapsedMs) === col;
    }
    if (obs.kind === 'block') {
      return col >= obs.col && col < obs.col + obs.len;
    }
    return false;
  });
}

// Corridor/wall check — a cell outside the round's band is impassable.
function bjCellOpen(row, col, course) {
  if (row <= 0 || row >= BJ_ROWS - 1) return true;
  if (BJ_SAFE_ROWS.includes(row)) return true;
  const lane = course?.lanes?.[row - 1];
  if (!lane) return true;
  return col >= lane.bandStart && col <= lane.bandEnd;
}

function bjGameScore(rt = bugJumperRuntime) {
  if (!rt) return 0;
  return Math.min(BJ_LANE_COUNT, rt.bestRowReached);
}

function bjResetStatCache() {
  bjStatScoreText = null;
  bjStatProgressText = null;
  bjStatTimeText = null;
}

function bjSetStats(remainingMs = null, force = false) {
  const rt = bugJumperRuntime;
  const remaining = remainingMs == null
    ? (rt?.playing ? Math.max(0, rt.durationMs - bjElapsed()) : BJ_DURATION_MS)
    : remainingMs;
  const timeText = Math.max(0, remaining / 1000).toFixed(1);
  const scoreText = String(bjGameScore(rt));
  const progressText = String(rt?.bestRowReached || 0) + '/' + BJ_LANE_COUNT;
  if (bjTimeEl && (force || timeText !== bjStatTimeText)) {
    bjTimeEl.textContent = timeText;
    bjStatTimeText = timeText;
  }
  if (bjScoreEl && (force || scoreText !== bjStatScoreText)) {
    bjScoreEl.textContent = scoreText;
    bjStatScoreText = scoreText;
  }
  if (bjProgressEl && (force || progressText !== bjStatProgressText)) {
    bjProgressEl.textContent = progressText;
    bjStatProgressText = progressText;
  }
}

function bjDraw(now) {
  const ctx = bjCtx;
  if (!ctx) return;
  const rt = bugJumperRuntime;
  const course = rt?.course || null;
  const elapsed = rt ? bjElapsed(now) : 0;
  const W = BJ_CS_W, H = BJ_CS_H, C = BJ_CELL;

  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bjGetStaticLayer(course), 0, 0, W, H);

  if (rt?.playing) {
    const sprites = bjGetSprites();

    const finishAge = now - (rt.prodFlash || 0);
    if (finishAge < 350) {
      ctx.fillStyle = 'rgba(45,212,191,0.5)';
      ctx.fillRect(0, 0, W, C);
    }

    // ── Obstacles: crawl (wraps), bounce (paces), block (stationary) ──
    course?.lanes?.forEach((lane, li) => {
      const row = li + 1;
      const ry = (BJ_ROWS - 1 - row) * C;
      const bandWidth = lane.bandEnd - lane.bandStart + 1;
      lane.obstacles?.forEach(obs => {
        if (obs.kind === 'crawl') {
          const head = bjCrawlColAt(lane, obs, elapsed);
          for (let i = 0; i < obs.len; i++) {
            const cellCol = lane.bandStart + bjMod((head - lane.bandStart) + i, bandWidth);
            const bx = cellCol * C;
            ctx.drawImage(i === 0 ? sprites.crawlHead : sprites.crawlBody, bx, ry, C, C);
          }
        } else if (obs.kind === 'bounce') {
          const bx = bjBounceColAt(obs, elapsed) * C;
          ctx.drawImage(sprites.bounceHead, bx, ry, C, C);
        } else if (obs.kind === 'block') {
          for (let i = 0; i < obs.len; i++) {
            const bx = (obs.col + i) * C;
            ctx.drawImage(i === 0 ? sprites.blockHead : sprites.blockBody, bx, ry, C, C);
          }
        }
      });
    });

    // ── Player — cyan cell with white ▲ ──
    const px = rt.playerCol * C, py = (BJ_ROWS - 1 - rt.playerRow) * C;
    const hitAge = now - rt.hitFlash;
    ctx.drawImage(hitAge < 180 ? sprites.playerHit : sprites.player, px, py, C, C);
  }

  // ── Score toasts (neon yellow) ──
  if (rt?.toasts?.length) {
    rt.toasts = rt.toasts.filter(t => now - t.born < 900);
    rt.toasts.forEach(t => {
      const age = now - t.born;
      const alpha = Math.max(0, 1 - age / 900);
      const tx = t.col * C + C / 2;
      const ty = (BJ_ROWS - 1 - t.row) * C - age * 0.045;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = 'bold 13px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = t.color === '#cc0000' ? '#f43f5e' : '#facc15';
      ctx.fillText(t.text, tx, ty);
      ctx.restore();
    });
  }

  // ── Idle overlay ──
  if (!rt?.playing) {
    ctx.fillStyle = 'rgba(17,21,28,0.92)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#22d3ee';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('DYNAMIC', W / 2, H / 2 - 14);
    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(34,211,238,0.5)';
    ctx.fillText('↑  ↓  ←  →  strzałki', W / 2, H / 2 + 12);
  }

  ctx.drawImage(bjGetOverlayLayer(course), 0, 0, W, H);

  // reset text state
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
}

async function invokeBugJumper(payload) {
  const { data, error } = await sb.functions.invoke('bug-jumper-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z Bug Jumper.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd Bug Jumper.');
  return data;
}

async function loadBugJumperState(showSpinner = true) {
  bjInitCanvas();
  bjDraw(performance.now());
  const weeklyWrap  = document.getElementById('bj-weekly-board');
  const allTimeWrap = document.getElementById('bj-alltime-board');
  const awardsWrap  = document.getElementById('bj-awards');
  if (showSpinner) {
    if (weeklyWrap)  weeklyWrap.replaceChildren(makeSpinner());
    if (allTimeWrap) allTimeWrap.replaceChildren(makeSpinner());
    if (awardsWrap)  awardsWrap.replaceChildren();
  }
  try {
    const data = await invokeBugJumper({ action: 'state' });
    renderBugJumperState(data);
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Brak danych.'));
    if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
    if (bjStatus) bjStatus.textContent = 'Bug Jumper nie jest jeszcze aktywny.';
  }
}

function renderBugJumperState(data) {
  if (data.profile) { me.coins = data.profile.coins; setText(headerCoins, me.coins); }
  const weekLabel = document.getElementById('bj-week-label');
  if (weekLabel) {
    const range = whackBossWeekRange(data.weekStart);
    weekLabel.textContent = range ? range.short : '';
  }
  renderBugJumperTable(document.getElementById('bj-weekly-board'), data.weekly || [], 'weekly');
  renderBugJumperTable(document.getElementById('bj-alltime-board'), data.allTime || [], 'allTime');
  renderBugJumperAwards(document.getElementById('bj-awards'), data.awards || []);
  if (!bugJumperRuntime?.playing && bjStatus) {
    bjStatus.textContent = data.myWeekly
      ? 'Twoja średnia z ' + Math.min(5, data.myWeekly.rounds_played || 1) + ' najlepszych rund w tym tygodniu: ' + data.myWeekly.score + '.'
      : 'Użyj strzałek kursora. Trasa jest inna w każdej rundzie — omijaj ściany i robaki.';
  }
}

function renderBugJumperTable(wrap, rows, mode) {
  if (!wrap) return;
  rows = rows.filter(r => r.nick !== 'admin');
  if (!rows.length) {
    wrap.replaceChildren(el('p', { className: 'bj-empty' }, mode === 'weekly' ? 'Jeszcze nikt nie zagrał w tym tygodniu.' : 'Brak rekordów.'));
    return;
  }
  const bodyRows = rows.slice(0, 10).map(row => el('tr', {},
    el('td', { className: 'lb-rank' + (row.rank === 1 ? ' gold' : '') }, whackBossRankLabel(row.rank)),
    el('td', { className: 'lb-nick' + (row.user_id === me?.id ? ' me' : '') }, row.nick + (row.user_id === me?.id ? ' (Ty)' : '')),
    el('td', { className: 'lb-net' }, String(row.score))
  ));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Nick'), el('th', { title: 'Średnia z 5 najlepszych rund' }, 'Wynik'))),
      el('tbody', {}, ...bodyRows)
    )
  );
}

function renderBugJumperAwards(wrap, awards) {
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

function bjClearInputQueue(rt = bugJumperRuntime) {
  if (rt?.inputQueue) rt.inputQueue.length = 0;
}

function bjPruneInputQueue(rt, now = performance.now()) {
  if (!rt?.inputQueue) return;
  while (rt.inputQueue.length && now > rt.inputQueue[0].expiresAt) {
    rt.inputQueue.shift();
  }
}

function bjCheckCollision(elapsedMs = bjElapsed()) {
  const rt = bugJumperRuntime;
  if (!rt) return false;
  const row = rt.playerRow;
  if (row < 1 || row >= BJ_ROWS - 1) return false;
  return bjCellBlocked(row, rt.playerCol, elapsedMs, rt.course);
}

function bjPlayerHit(elapsedMs = bjElapsed()) {
  const rt = bugJumperRuntime;
  if (!rt) return;
  const hitRow = rt.playerRow;
  const hitCol = rt.playerCol;
  rt.hitFlash      = performance.now();
  rt.collisions   += 1;
  rt.playerRow     = 0;
  rt.playerCol     = BJ_START_COL;
  bjClearInputQueue(rt);
  rt.toasts.push({ text: 'HIT! → START', col: hitCol, row: hitRow, born: performance.now(), color: '#cc0000' });
  bjSetStats(Math.max(0, rt.durationMs - elapsedMs));
}

function bjResolveCollisionAt(elapsedMs = bjElapsed()) {
  if (bjCheckCollision(elapsedMs)) {
    bjPlayerHit(elapsedMs);
    return true;
  }
  return false;
}

function bjInputCooldownMs(rt = bugJumperRuntime) {
  return Math.max(1, Number(rt?.course?.inputCooldownMs) || BJ_INPUT_COOLDOWN_MS);
}

function bjMovePlayer(dr, dc, now = performance.now()) {
  const rt = bugJumperRuntime;
  if (!rt?.playing || rt.completed) return false;
  if (now < rt.inputCooldown) return false;
  const course = rt.course;
  const elapsed = bjElapsed(now);
  bjResolveCollisionAt(elapsed);
  rt.inputCooldown = now + bjInputCooldownMs(rt);
  rt.moveLog.push({ t: Math.round(elapsed), dr, dc });

  // Sideways move: blocked by a wall outside this row's corridor band.
  if (dc !== 0) {
    const proposedCol = Math.max(0, Math.min(BJ_COLS - 1, rt.playerCol + dc));
    if (bjCellOpen(rt.playerRow, proposedCol, course)) rt.playerCol = proposedCol;
    bjResolveCollisionAt(elapsed);
    bjSetStats(Math.max(0, rt.durationMs - elapsed), true);
    return true;
  }

  // Vertical move: blocked if the next row's corridor doesn't include the
  // current column — the player must shuffle sideways first.
  const newRow = rt.playerRow + dr;
  if (newRow < 0 || newRow > BJ_ROWS - 1) return true;
  if (!bjCellOpen(newRow, rt.playerCol, course)) return true;

  if (newRow >= BJ_ROWS - 1) {
    rt.bestRowReached = BJ_LANE_COUNT;
    rt.completed = true;
    rt.completionMs = Math.round(elapsed);
    rt.score = BJ_LANE_COUNT;
    rt.prodFlash = now;
    rt.playerRow = BJ_ROWS - 1;
    bjClearInputQueue(rt);
    rt.toasts.push({ text: 'META', col: rt.playerCol, row: BJ_ROWS - 1, born: now, color: '#0077aa' });
    bjSetStats(0, true);
    bjDraw(now);
    finishBugJumperRound();
    return true;
  }

  if (dr > 0 && newRow >= 1 && newRow <= BJ_LANE_COUNT && newRow > rt.bestRowReached) {
    rt.bestRowReached = newRow;
    rt.score = bjGameScore(rt);
    rt.toasts.push({ text: String(rt.score), col: rt.playerCol, row: newRow, born: now, color: '#0055cc' });
  }
  rt.playerRow = newRow;
  bjResolveCollisionAt(elapsed);
  bjSetStats(Math.max(0, rt.durationMs - elapsed), true);
  return true;
}

function bjQueueMove(dr, dc, now = performance.now()) {
  const rt = bugJumperRuntime;
  if (!rt?.playing || rt.completed) return;
  if (!Array.isArray(rt.inputQueue)) rt.inputQueue = [];
  bjPruneInputQueue(rt, now);
  if (now >= rt.inputCooldown && rt.inputQueue.length === 0) {
    bjMovePlayer(dr, dc, now);
    return;
  }
  if (rt.inputQueue.length >= BJ_INPUT_QUEUE_MAX) return;
  rt.inputQueue.push({ dr, dc, expiresAt: now + BJ_INPUT_QUEUE_TTL_MS });
}

function bjFlushQueuedMove(now = performance.now()) {
  const rt = bugJumperRuntime;
  if (!rt?.playing || rt.completed || !rt.inputQueue?.length) return false;
  bjPruneInputQueue(rt, now);
  if (!rt.inputQueue.length) return false;
  if (now < rt.inputCooldown) return false;
  const queued = rt.inputQueue.shift();
  return bjMovePlayer(queued.dr, queued.dc, now);
}

function bjTick(ts) {
  const rt = bugJumperRuntime;
  if (!rt?.playing) return;

  const remaining = rt.durationMs - (ts - rt.startPerf);
  bjSetStats(remaining);
  if (remaining <= 0) { finishBugJumperRound(); return; }
  bjFlushQueuedMove(ts);
  if (!bugJumperRuntime?.playing) return;

  if (bugJumperRuntime.playerRow >= 1 && bugJumperRuntime.playerRow <= BJ_LANE_COUNT) {
    bjResolveCollisionAt(bjElapsed(ts));
  }
  bjDraw(ts);
  if (bugJumperRuntime?.playing) bugJumperRuntime.rafId = requestAnimationFrame(bjTick);
}

function stopBugJumperRound() {
  const rt = bugJumperRuntime;
  if (rt?.rafId) cancelAnimationFrame(rt.rafId);
  bugJumperRuntime = newBugJumperRuntime();
  if (bjStartBtn) { bjStartBtn.disabled = false; bjStartBtn.textContent = 'Start rundy'; }
  bjResetStatCache();
  bjSetStats(BJ_DURATION_MS, true);
  bjInitCanvas();
  bjDraw(performance.now());
}

function beginBugJumperRound(round, options = {}) {
  stopBugJumperRound();
  bugJumperRuntime = newBugJumperRuntime();
  const rt = bugJumperRuntime;
  rt.playing    = true;
  rt.roundId    = round.id;
  rt.archiveMode = !!options.archiveMode;
  rt.courseId   = round.courseId || BUG_JUMPER_DYNAMIC_COURSE_ID;
  rt.course     = bjGenerateCourse(round.seed);
  rt.durationMs = round.durationMs || BJ_DURATION_MS;
  rt.expiresAt  = round.expiresAt || null;
  const serverElapsed = round.startedAt && round.serverNow
    ? Math.max(0, new Date(round.serverNow).getTime() - new Date(round.startedAt).getTime())
    : 0;
  rt.startPerf = performance.now() - serverElapsed;
  if (bjStartBtn) { bjStartBtn.disabled = true; bjStartBtn.textContent = 'Runda trwa'; }
  if (bjStatus) {
    bjStatus.textContent = rt.archiveMode
      ? 'Tryb testowy admina — wynik nie zostanie zapisany.'
      : '↑ ↓ ← → — wspinaj się, omijaj ściany i robaki.';
  }
  if (bjArena) {
    if (!bjArena.hasAttribute('tabindex')) bjArena.tabIndex = 0;
    try { bjArena.focus({ preventScroll: true }); } catch { bjArena.focus(); }
  }
  bjResetStatCache();
  bjSetStats(rt.durationMs - serverElapsed, true);
  rt.rafId = requestAnimationFrame(bjTick);
}

function prepareBugJumperAdminTest() {
  bjInitCanvas();
  stopBugJumperRound();
  const weekLabel = document.getElementById('bj-week-label');
  if (weekLabel) weekLabel.textContent = 'test';
  const weeklyWrap = document.getElementById('bj-weekly-board');
  const allTimeWrap = document.getElementById('bj-alltime-board');
  const awardsWrap = document.getElementById('bj-awards');
  if (weeklyWrap) weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Tryb testowy admina — ranking nie jest używany.'));
  if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Start uruchamia lokalną rundę bez zapisu w bazie.'));
  if (awardsWrap) awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Nagrody nie są naliczane w teście.'));
  if (bjStatus) bjStatus.textContent = 'Admin test — losowa dynamiczna trasa, bez zapisu wyniku.';
}

async function startBugJumperRound() {
  const rt = bugJumperRuntime;
  if (rt?.playing || rt?.submitting) return;
  if (activeTab === 'bug-jumper-test') {
    const now = new Date().toISOString();
    const seed = Math.floor(Math.random() * 2147483647) + 1;
    beginBugJumperRound({
      id: 'admin-test-' + Date.now(),
      courseId: BUG_JUMPER_DYNAMIC_COURSE_ID,
      seed,
      durationMs: BJ_DURATION_MS,
      startedAt: now,
      serverNow: now,
    }, { archiveMode: true });
    return;
  }
  if (allGamesMode) {
    try { await payArcadeEntry(allGamesSelectedGame); } catch(e) { showToast('❌ Nie udało się wejść do gry.'); return; }
  }
  if (bjStartBtn) { bjStartBtn.disabled = true; bjStartBtn.textContent = 'Ładuję...'; }
  if (bjStatus) bjStatus.textContent = 'Przygotowuję rundę...';
  try {
    const data = await invokeBugJumper({ action: 'start' });
    renderBugJumperState(data);
    beginBugJumperRound(data.round, allGamesMode ? { archiveMode: true } : {});
  } catch (err) {
    showToast('❌ ' + err.message);
    if (bjStatus) bjStatus.textContent = 'Nie udało się wystartować rundy.';
    if (bjStartBtn) { bjStartBtn.disabled = false; bjStartBtn.textContent = 'Start rundy'; }
  }
}

// True once the server's submission window for this round (round.expiresAt,
// ROUND_EXPIRES_SECONDS = 120s server-side) has passed — e.g. the tab sat
// backgrounded long enough that requestAnimationFrame never fired to notice
// the 25s round had ended. Submitting past this point is guaranteed to fail
// with "Runda wygasła." from bug-jumper-action, so callers should treat the
// round as locally abandoned instead of round-tripping to the server for it.
function bjRoundExpired(rt = bugJumperRuntime) {
  return !!rt?.expiresAt && Date.now() >= new Date(rt.expiresAt).getTime();
}

async function finishBugJumperRound() {
  const rt = bugJumperRuntime;
  if (!rt || rt.submitting) return;
  bjClearInputQueue(rt);
  rt.playing    = false;
  rt.submitting = true;
  if (rt.rafId) cancelAnimationFrame(rt.rafId);

  if (!rt.archiveMode && bjRoundExpired(rt)) {
    rt.submitting = false;
    showToast('⏱️ Zbyt długo nie było Cię na karcie — runda wygasła (masz 120 s na jej dokończenie).');
    if (bjStatus) bjStatus.textContent = 'Runda wygasła — kliknij Start, aby zagrać ponownie.';
    if (bjStartBtn) { bjStartBtn.disabled = false; bjStartBtn.textContent = 'Start rundy'; }
    bjDraw(performance.now());
    return;
  }

  if (bjStartBtn) { bjStartBtn.disabled = true; bjStartBtn.textContent = 'Zapisuję...'; }
  if (bjStatus) bjStatus.textContent = 'Zapisuję wynik...';
  bjSetStats(0, true);
  bjDraw(performance.now());

  if (rt.archiveMode) {
    rt.submitting = false;
    if (bjStartBtn) { bjStartBtn.disabled = false; bjStartBtn.textContent = 'Zagraj ponownie'; }
    if (allGamesMode) {
      try {
        await recordArcadeScore('bug_jumper', rt.score);
        if (bjStatus) bjStatus.textContent = 'Wynik: ' + rt.score + ' · zapisano w rankingu arcade!';
        loadArcadeScores('bug_jumper');
      } catch(e) { if (bjStatus) bjStatus.textContent = 'Wynik: ' + rt.score + ' (błąd zapisu).'; }
    } else {
      if (bjStatus) bjStatus.textContent = 'Tryb archiwum — wynik: ' + rt.score + ' (nie zapisano).';
    }
    return;
  }

  try {
    const data = await invokeBugJumper({
      action: 'submit', roundId: rt.roundId,
      courseId: rt.courseId,
      moves: rt.moveLog.slice(0, 400),
      score: bjGameScore(rt),
      hits: rt.bestRowReached,
      misses: rt.collisions,
      maxCombo: rt.completed ? 1 : 0,
      completionMs: rt.completionMs,
    });
    renderBugJumperState(data);
    showToast('✅ Wynik zapisany: ' + data.score.score);
    if (bjStatus) {
      const finish = data.score.completion_ms != null ? ' · meta ' + (data.score.completion_ms / 1000).toFixed(2) + ' s' : '';
      bjStatus.textContent = 'Ostatni wynik: ' + data.score.score + finish + '.';
    }
  } catch (err) {
    showToast('❌ ' + err.message);
    if (bjStatus) bjStatus.textContent = 'Nie udało się zapisać wyniku.';
  } finally {
    rt.submitting = false;
    if (bjStartBtn) { bjStartBtn.disabled = false; bjStartBtn.textContent = 'Zagraj ponownie'; }
  }
}

if (bjStartBtn) bjStartBtn.addEventListener('click', startBugJumperRound);

// ── Pause the round while the tab is hidden ─────────────────────────────
// requestAnimationFrame is throttled/paused by the browser in a backgrounded
// tab, so an abandoned tab can silently blow past the server's 120s
// submission window (ROUND_EXPIRES_SECONDS in bug-jumper-action) before
// bjTick ever gets a frame to notice the round ended. Freeze the RAF loop on
// hide and restart it on return, instead of letting a throttled background
// frame fire the finish/submit path at some unpredictable later point;
// bjRoundExpired() inside finishBugJumperRound() then decides whether the
// round is still submittable or has to be abandoned locally.
document.addEventListener('visibilitychange', () => {
  const rt = bugJumperRuntime;
  if (!rt?.playing || rt.archiveMode) return;
  if (document.hidden) {
    if (rt.rafId) cancelAnimationFrame(rt.rafId);
    rt.rafId = null;
  } else if (!rt.rafId) {
    rt.rafId = requestAnimationFrame(bjTick);
  }
});

// ── Bug Jumper fullscreen ────────────────────────────────────────────────
const bjGamePanel = document.getElementById('bj-game-panel');
const bjFullscreenBtn = document.getElementById('bj-fullscreen-btn');

function bjIsFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

async function bjToggleFullscreen() {
  if (!bjGamePanel) return;
  try {
    if (!bjIsFullscreen()) {
      if (bjGamePanel.requestFullscreen) await bjGamePanel.requestFullscreen();
      else if (bjGamePanel.webkitRequestFullscreen) bjGamePanel.webkitRequestFullscreen();
    } else if (document.exitFullscreen) {
      await document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  } catch {
    showToast('❌ Nie udało się przełączyć pełnego ekranu.');
  }
}

function bjOnFullscreenChange() {
  if (bjFullscreenBtn) bjFullscreenBtn.textContent = bjIsFullscreen() ? '⤢ Wyjdź z pełnego ekranu' : '⛶ Pełny ekran';
  bjInitCanvas();
  bjDraw(performance.now());
}

if (bjFullscreenBtn) bjFullscreenBtn.addEventListener('click', bjToggleFullscreen);
document.addEventListener('fullscreenchange', bjOnFullscreenChange);
document.addEventListener('webkitfullscreenchange', bjOnFullscreenChange);

// Arrow keys only — no WASD, no touch
document.addEventListener('keydown', evt => {
  if (!bugJumperRuntime?.playing) return;
  if (evt.key === 'ArrowUp')    { evt.preventDefault(); bjQueueMove(1, 0); }
  if (evt.key === 'ArrowDown')  { evt.preventDefault(); bjQueueMove(-1, 0); }
  if (evt.key === 'ArrowLeft')  { evt.preventDefault(); bjQueueMove(0, -1); }
  if (evt.key === 'ArrowRight') { evt.preventDefault(); bjQueueMove(0, 1); }
});

