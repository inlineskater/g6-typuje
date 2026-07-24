// ── Najazd Faktur (Invoice Horde) — canvas ───────────────────────────────────
// Deterministic integer arena-survivor. The simulation here is replayed 1:1 by
// the invoice-horde-action Edge Function, so every constant below must match it.
const IH_ARENA = 360;
const IH_CS = IH_ARENA;
const IH_TICK_MS = 80;
const IH_DURATION_MS = 60000; // hard safety cap only — survival ends on first hit
const IH_MAX_TICKS = Math.floor(IH_DURATION_MS / IH_TICK_MS);
const IH_MAX_DPR = 2;
const IH_PLAYER_SPEED = 9;
const IH_PLAYER_RADIUS = 10;
const IH_ENEMY_SPEED = 6;
const IH_ENEMY_RADIUS = 9;
const IH_HIT_DIST2 = (IH_PLAYER_RADIUS + IH_ENEMY_RADIUS) * (IH_PLAYER_RADIUS + IH_ENEMY_RADIUS);
const IH_FIRE_INTERVAL = 3;
const IH_FIRE_RANGE = 66;
const IH_FIRE_RANGE2 = IH_FIRE_RANGE * IH_FIRE_RANGE;
const IH_START_HP = 1;
const IH_ENEMY_CAP = 70;
const IH_MAX_SCORE = 200;
// „CF" mini-boss: multi-hit ticket, slower than the swarm but soaks several hits.
const IH_BOSS_INTERVAL = 125; // ticks between boss spawns (~10s)
const IH_BOSS_HP = 5;
const IH_BOSS_SPEED = 4;
const IH_BOSS_RADIUS = 16;
const IH_BOSS_HIT_DIST2 = (IH_PLAYER_RADIUS + IH_BOSS_RADIUS) * (IH_PLAYER_RADIUS + IH_BOSS_RADIUS);
const IH_BOSS_SCORE = 5;
const IH_DIRS = Object.freeze({
  U:  Object.freeze({ x: 0,  y: -1 }),
  D:  Object.freeze({ x: 0,  y: 1 }),
  L:  Object.freeze({ x: -1, y: 0 }),
  R:  Object.freeze({ x: 1,  y: 0 }),
  UL: Object.freeze({ x: -1, y: -1 }),
  UR: Object.freeze({ x: 1,  y: -1 }),
  DL: Object.freeze({ x: -1, y: 1 }),
  DR: Object.freeze({ x: 1,  y: 1 }),
  S:  Object.freeze({ x: 0,  y: 0 }),
});

let ihCtx = null;
let ihRafId = null;
const ihKeys = { U: false, D: false, L: false, R: false };
let ihStatScoreText = null;
let ihStatThreatText = null;

function newInvoiceHordeRuntime() {
  return {
    playing: false, submitting: false, archiveMode: false,
    roundId: null,
    seed: 1,
    durationMs: IH_DURATION_MS,
    tickMs: IH_TICK_MS,
    startPerf: 0,
    lastStepPerf: 0,
    timer: null,
    tick: 0,
    dir: 'S',
    pendingDir: null,
    pendingTick: 0,
    player: { x: 180, y: 180, px: 180, py: 180 },
    enemies: [],
    rng: null,
    hp: IH_START_HP,
    score: 0,
    moves: 0,
    moveLog: [],
    shotFx: null,
    particles: [],   // cosmetic only — never read by the sim or submitted
    floaters: [],    // cosmetic "+1" pops
    deathAt: 0,      // for the death shake/flash
    endedReason: '',
    pointerActive: false,
    pointerStart: null,
  };
}

function ihMakeRng(seed) {
  let state = Number(seed || 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function ihIsqrt(n) {
  if (n <= 0) return 0;
  let x = n;
  let y = (x + 1) >> 1;
  while (y < x) {
    x = y;
    y = (x + Math.trunc(n / x)) >> 1;
  }
  return x;
}

function ihClamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function ihSpawnInterval(tick) {
  // Must match spawnInterval() in invoice-horde-action; tunes the difficulty.
  return tick < 150 ? 10 : tick < 320 ? 7 : tick < 500 ? 5 : tick < 680 ? 3 : 2;
}

function ihSpawnEnemy(rng) {
  const edge = Math.floor(rng() * 4);
  const t = Math.floor(rng() * (IH_ARENA + 1));
  let x, y;
  if (edge === 0) { x = t; y = 0; }
  else if (edge === 1) { x = t; y = IH_ARENA; }
  else if (edge === 2) { x = 0; y = t; }
  else { x = IH_ARENA; y = t; }
  // pri is a cosmetic priority tint (Math.random, NOT the sim rng — no desync)
  return { x, y, px: x, py: y, pri: (Math.random() * 3) | 0 };
}

function ihSpawnBoss(rng) {
  // Same two rng draws and edge mapping as ihSpawnEnemy — must match the
  // spawnBoss() in invoice-horde-action.
  const edge = Math.floor(rng() * 4);
  const t = Math.floor(rng() * (IH_ARENA + 1));
  let x, y;
  if (edge === 0) { x = t; y = 0; }
  else if (edge === 1) { x = t; y = IH_ARENA; }
  else if (edge === 2) { x = 0; y = t; }
  else { x = IH_ARENA; y = t; }
  return { x, y, px: x, py: y, boss: true, hp: IH_BOSS_HP };
}

function ihDirCode(x, y) {
  if (x < 0 && y < 0) return 'UL';
  if (x > 0 && y < 0) return 'UR';
  if (x < 0 && y > 0) return 'DL';
  if (x > 0 && y > 0) return 'DR';
  if (y < 0) return 'U';
  if (y > 0) return 'D';
  if (x < 0) return 'L';
  if (x > 0) return 'R';
  return 'S';
}

function ihResetBoard(seed = 1) {
  const rt = invoiceHordeRuntime || newInvoiceHordeRuntime();
  rt.seed = seed;
  rt.tick = 0;
  rt.dir = 'S';
  rt.pendingDir = null;
  rt.pendingTick = 0;
  rt.player = { x: 180, y: 180, px: 180, py: 180 };
  rt.enemies = [];
  rt.rng = ihMakeRng(seed);
  rt.hp = IH_START_HP;
  rt.score = 0;
  rt.moves = 0;
  rt.moveLog = [];
  rt.shotFx = null;
  rt.particles = [];
  rt.floaters = [];
  rt.deathAt = 0;
  rt.endedReason = '';
  rt.lastStepPerf = 0;
  invoiceHordeRuntime = rt;
  return rt;
}

// Cosmetic burst when a ticket is resolved (uses Math.random, NOT the sim rng,
// so it can never desync the deterministic replay).
function ihBurst(rt, x, y) {
  const now = performance.now();
  const n = 7;
  for (let i = 0; i < n; i += 1) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.6;
    const sp = 0.045 + Math.random() * 0.06;
    rt.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, at: now, life: 300 + Math.random() * 200 });
  }
  rt.floaters.push({ x, y, at: now, life: 680 });
  if (rt.particles.length > 220) rt.particles.splice(0, rt.particles.length - 220);
  if (rt.floaters.length > 24) rt.floaters.splice(0, rt.floaters.length - 24);
}

function ihInitCanvas() {
  const canvas = document.getElementById('ih-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const DPR = Math.min(window.devicePixelRatio || 1, IH_MAX_DPR);
  const w = Math.round((rect.width || IH_CS) * DPR);
  const h = Math.round((rect.height || IH_CS) * DPR);
  if (!ihCtx || canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    ihCtx = canvas.getContext('2d');
  }
  ihCtx.setTransform(w / IH_CS, 0, 0, h / IH_CS, 0, 0);
}

function ihElapsed(now = performance.now()) {
  const rt = invoiceHordeRuntime;
  if (!rt?.startPerf) return rt?.tick ? rt.tick * IH_TICK_MS : 0;
  return Math.max(0, Math.min(rt.durationMs, now - rt.startPerf));
}

function ihResetStatCache() {
  ihStatScoreText = null;
  ihStatThreatText = null;
}

function ihSetStats(force = false) {
  const rt = invoiceHordeRuntime || newInvoiceHordeRuntime();
  const scoreText = String(rt.score || 0);
  const threatText = String(rt.playing ? (rt.enemies?.length || 0) : 0);
  if (ihScoreEl && (force || scoreText !== ihStatScoreText)) { ihScoreEl.textContent = scoreText; ihStatScoreText = scoreText; }
  if (ihThreatEl && (force || threatText !== ihStatThreatText)) { ihThreatEl.textContent = threatText; ihStatThreatText = threatText; }
}

function ihDurationText(ms) {
  const n = Math.max(0, Number(ms) || 0);
  return (n / 1000).toFixed(1) + 's';
}

function ihRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ihDrawParticles(ctx, rt, now) {
  if (!rt.particles?.length) return;
  const keep = [];
  for (const p of rt.particles) {
    const age = now - p.at;
    if (age >= p.life) continue;
    const k = 1 - age / p.life;
    ctx.fillStyle = 'rgba(103,232,249,' + (0.9 * k).toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(p.x + p.vx * age, p.y + p.vy * age, 0.8 + 2.4 * k, 0, Math.PI * 2);
    ctx.fill();
    keep.push(p);
  }
  rt.particles = keep;
}

function ihDrawFloaters(ctx, rt, now) {
  if (!rt.floaters?.length) return;
  const keep = [];
  ctx.save();
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const f of rt.floaters) {
    const age = now - f.at;
    if (age >= f.life) continue;
    const k = age / f.life;
    ctx.fillStyle = 'rgba(134,239,172,' + (1 - k).toFixed(3) + ')';
    ctx.fillText('+1', f.x, f.y - 4 - 22 * k);
    keep.push(f);
  }
  ctx.restore();
  rt.floaters = keep;
}

function ihDraw(now = performance.now()) {
  const ctx = ihCtx;
  if (!ctx) return;
  const rt = invoiceHordeRuntime;
  const W = IH_CS;
  const alpha = rt?.playing && rt.lastStepPerf
    ? ihClamp((now - rt.lastStepPerf) / rt.tickMs, 0, 1)
    : 1;

  // death shake / flash factor
  let shx = 0, shy = 0, deathK = 0;
  if (rt?.deathAt) {
    const dt = now - rt.deathAt;
    if (dt < 460) { deathK = 1 - dt / 460; const m = 7 * deathK; shx = (Math.random() * 2 - 1) * m; shy = (Math.random() * 2 - 1) * m; }
  }

  ctx.save();
  ctx.translate(shx, shy);

  // background — dark terminal
  const bg = ctx.createLinearGradient(0, 0, 0, W);
  bg.addColorStop(0, '#070d16'); bg.addColorStop(1, '#0a1626');
  ctx.fillStyle = bg; ctx.fillRect(-8, -8, W + 16, W + 16);
  ctx.strokeStyle = 'rgba(56,189,248,.08)'; ctx.lineWidth = 1;
  for (let i = 0; i <= IH_ARENA; i += 30) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, W); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(W, i); ctx.stroke();
  }

  if (rt?.playing && rt.player) {
    const ppx = rt.player.px + (rt.player.x - rt.player.px) * alpha;
    const ppy = rt.player.py + (rt.player.y - rt.player.py) * alpha;

    // fire range ring
    ctx.strokeStyle = 'rgba(56,189,248,.18)'; ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.arc(ppx, ppy, IH_FIRE_RANGE, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);

    // resolve beam
    if (rt.shotFx && now - rt.shotFx.at < 130) {
      const k = 1 - (now - rt.shotFx.at) / 130;
      ctx.save();
      ctx.shadowColor = '#67e8f9'; ctx.shadowBlur = 8;
      ctx.strokeStyle = 'rgba(103,232,249,' + (0.85 * k + 0.15).toFixed(3) + ')';
      ctx.lineWidth = 1.5 + 2 * k;
      ctx.beginPath(); ctx.moveTo(rt.shotFx.fx ?? ppx, rt.shotFx.fy ?? ppy); ctx.lineTo(rt.shotFx.tx, rt.shotFx.ty); ctx.stroke();
      ctx.restore();
    }

    // enemies — support tickets
    const PRI = ['#ef4444', '#f59e0b', '#38bdf8'];
    const pulse = 1 + Math.sin(now / 170) * 0.06;
    for (const e of rt.enemies) {
      const ex = e.px + (e.x - e.px) * alpha;
      const ey = e.py + (e.y - e.py) * alpha;
      if (e.boss) {
        // „CF" mini-boss — oversized red ticket with 👔, label and HP bar.
        const bs = IH_BOSS_RADIUS * pulse;
        ctx.save();
        ctx.shadowColor = 'rgba(185,28,28,.7)'; ctx.shadowBlur = 12;
        ihRoundRect(ctx, ex - bs, ey - bs * 0.82, bs * 2, bs * 1.64, 3.5);
        ctx.fillStyle = '#7f1d1d'; ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.5; ctx.strokeStyle = '#fca5a5';
        ihRoundRect(ctx, ex - bs, ey - bs * 0.82, bs * 2, bs * 1.64, 3.5); ctx.stroke();
        // 👔 above
        ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('👔', ex, ey - bs * 0.82 - 6);
        // bold CF label
        ctx.fillStyle = '#fff'; ctx.font = 'bold 12px monospace';
        ctx.fillText('CF', ex, ey + 1);
        // HP bar under the ticket
        const hpw = bs * 2;
        const hpFrac = ihClamp(e.hp / IH_BOSS_HP, 0, 1);
        ctx.fillStyle = 'rgba(0,0,0,.45)';
        ctx.fillRect(ex - bs, ey + bs * 0.82 + 3, hpw, 3);
        ctx.fillStyle = '#f87171';
        ctx.fillRect(ex - bs, ey + bs * 0.82 + 3, hpw * hpFrac, 3);
        ctx.restore();
        continue;
      }
      const s = IH_ENEMY_RADIUS * pulse;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
      ihRoundRect(ctx, ex - s, ey - s * 0.78, s * 2, s * 1.56, 2.5);
      ctx.fillStyle = '#e8f0fb'; ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.fillStyle = PRI[e.pri || 0];
      ctx.fillRect(ex - s, ey - s * 0.78, 3, s * 1.56); // priority stripe
      ctx.fillStyle = 'rgba(30,41,59,.5)';
      ctx.fillRect(ex - s + 6, ey - 3, s * 2 - 9, 1.4);
      ctx.fillRect(ex - s + 6, ey + 1, s * 2 - 13, 1.4);
      ctx.restore();
    }

    ihDrawParticles(ctx, rt, now);

    // player — IT node with glow
    ctx.save();
    const g = ctx.createRadialGradient(ppx, ppy, 1, ppx, ppy, IH_PLAYER_RADIUS * 2.3);
    g.addColorStop(0, 'rgba(56,189,248,.5)'); g.addColorStop(1, 'rgba(56,189,248,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ppx, ppy, IH_PLAYER_RADIUS * 2.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0ea5e9'; ctx.beginPath(); ctx.arc(ppx, ppy, IH_PLAYER_RADIUS, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#bae6fd'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ppx, ppy, IH_PLAYER_RADIUS, 0, Math.PI * 2); ctx.stroke();
    ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🧑‍💻', ppx, ppy + 0.5);
    ctx.restore();

    ihDrawFloaters(ctx, rt, now);

    // score
    ctx.save();
    ctx.shadowColor = 'rgba(56,189,248,.8)'; ctx.shadowBlur = 6;
    ctx.fillStyle = '#e0f2fe'; ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(String(rt.score || 0), 10, 8);
    ctx.restore();
  } else {
    ctx.fillStyle = 'rgba(7,13,22,.9)';
    ctx.fillRect(0, 0, W, W);
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('NAJAZD TICKETÓW', W / 2, W / 2 - 24);
    ctx.font = '40px sans-serif';
    ctx.fillText('🎫', W / 2, W / 2 + 12);
    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(125,211,252,.75)';
    const hint = rt?.archiveMode ? 'demo lokalne' : 'strzałki / WASD / swipe';
    ctx.fillText(hint, W / 2, W / 2 + 50);
  }

  // death flash
  if (deathK > 0) { ctx.fillStyle = 'rgba(239,68,68,' + (0.35 * deathK).toFixed(3) + ')'; ctx.fillRect(-8, -8, W + 16, W + 16); }

  // vignette
  const vg = ctx.createRadialGradient(W / 2, W / 2, W * 0.34, W / 2, W / 2, W * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.45)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, W);

  // frame
  ctx.strokeStyle = 'rgba(56,189,248,.4)'; ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, W - 4, W - 4);
  ctx.restore();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
}

function ihDrawLoop() {
  ihDraw(performance.now());
  const rt = invoiceHordeRuntime;
  const deathActive = rt?.deathAt && performance.now() - rt.deathAt < 520;
  if (rt?.playing || deathActive) ihRafId = requestAnimationFrame(ihDrawLoop);
  else ihRafId = null;
}

function ihStartRaf() {
  if (ihRafId == null) ihRafId = requestAnimationFrame(ihDrawLoop);
}

function ihStopRaf() {
  if (ihRafId != null) { cancelAnimationFrame(ihRafId); ihRafId = null; }
}

async function invokeInvoiceHorde(payload) {
  const { data, error } = await sb.functions.invoke('invoice-horde-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z grą.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd gry.');
  return data;
}

async function loadInvoiceHordeState(showSpinner = true) {
  ihInitCanvas();
  if (!invoiceHordeRuntime) ihResetBoard(1);
  ihDraw(performance.now());
  const weeklyWrap  = document.getElementById('ih-weekly-board');
  const allTimeWrap = document.getElementById('ih-alltime-board');
  const awardsWrap  = document.getElementById('ih-awards');
  if (showSpinner) {
    if (weeklyWrap)  weeklyWrap.replaceChildren(makeSpinner());
    if (allTimeWrap) allTimeWrap.replaceChildren(makeSpinner());
    if (awardsWrap)  awardsWrap.replaceChildren();
  }
  try {
    const data = await invokeInvoiceHorde({ action: 'state' });
    renderInvoiceHordeState(data);
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Brak danych.'));
    if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
    if (ihStatus) ihStatus.textContent = 'Najazd Faktur nie jest jeszcze aktywny.';
  }
}

function renderInvoiceHordeState(data) {
  if (data.profile) { me.coins = data.profile.coins; setText(headerCoins, me.coins); }
  const weekLabel = document.getElementById('ih-week-label');
  if (weekLabel) {
    const range = whackBossWeekRange(data.weekStart);
    weekLabel.textContent = range ? range.short : '';
  }
  renderInvoiceHordeTable(document.getElementById('ih-weekly-board'), data.weekly || [], 'weekly');
  renderInvoiceHordeTable(document.getElementById('ih-alltime-board'), data.allTime || [], 'allTime');
  renderInvoiceHordeAwards(document.getElementById('ih-awards'), data.awards || []);
  if (!invoiceHordeRuntime?.playing && ihStatus) {
    ihStatus.textContent = data.myWeekly
      ? 'Twój najlepszy wynik w tym tygodniu: ' + data.myWeekly.score + '.'
      : 'Zamykaj tickety i przeżyj jak najdłużej. Najlepszy wynik tygodnia trafia do rankingu.';
  }
}

function renderInvoiceHordeTable(wrap, rows, mode) {
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
      el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Nick'), el('th', { title: 'Rozwiązane tickety' }, 'Wynik'))),
      el('tbody', {}, ...bodyRows)
    )
  );
}

function renderInvoiceHordeAwards(wrap, awards) {
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

function stopInvoiceHordeRound() {
  const rt = invoiceHordeRuntime;
  if (rt?.timer) clearInterval(rt.timer);
  ihStopRaf();
  invoiceHordeRuntime = newInvoiceHordeRuntime();
  ihResetBoard(invoiceHordeRuntime.seed || 1);
  invoiceHordeRuntime.playing = false;
  invoiceHordeRuntime.archiveMode = rt?.archiveMode || false;
  ihKeys.U = ihKeys.D = ihKeys.L = ihKeys.R = false;
  if (ihStartBtn) { ihStartBtn.disabled = false; ihStartBtn.textContent = 'Start rundy'; }
  ihResetStatCache();
  ihSetStats(true);
  ihInitCanvas();
  ihDraw(performance.now());
}

function beginInvoiceHordeRound(round, options = {}) {
  stopInvoiceHordeRound();
  const seed = Number(round.seed || Date.now()) || 1;
  invoiceHordeRuntime = newInvoiceHordeRuntime();
  const rt = ihResetBoard(seed);
  rt.playing = true;
  rt.archiveMode = !!options.archiveMode;
  rt.roundId = round.id;
  rt.durationMs = Number(round.durationMs || round.duration_ms || IH_DURATION_MS) || IH_DURATION_MS;
  rt.tickMs = Number(round.tickMs || IH_TICK_MS) || IH_TICK_MS;
  const serverElapsed = round.startedAt && round.serverNow
    ? Math.max(0, new Date(round.serverNow).getTime() - new Date(round.startedAt).getTime())
    : 0;
  rt.startPerf = performance.now() - serverElapsed;
  rt.lastStepPerf = performance.now();
  ihKeys.U = ihKeys.D = ihKeys.L = ihKeys.R = false;
  if (ihStartBtn) { ihStartBtn.disabled = true; ihStartBtn.textContent = 'Runda trwa'; }
  if (ihStatus) {
    ihStatus.textContent = rt.archiveMode
      ? 'Demo — wynik nie zostanie zapisany.'
      : 'Steruj strzałkami, WASD albo swipe. Skrypt zamyka tickety sam.';
  }
  if (ihArena) {
    if (!ihArena.hasAttribute('tabindex')) ihArena.tabIndex = 0;
    try { ihArena.focus({ preventScroll: true }); } catch { ihArena.focus(); }
  }
  ihResetStatCache();
  ihSetStats(true);
  ihInitCanvas();
  ihStartRaf();
  rt.timer = setInterval(ihTick, rt.tickMs);
}

function ihSetInput(code) {
  const rt = invoiceHordeRuntime;
  if (!rt?.playing || !IH_DIRS[code]) return;
  rt.pendingDir = code;
  rt.pendingTick = rt.tick + 1;
}

function ihStep() {
  const rt = invoiceHordeRuntime;
  if (!rt?.playing) return;
  const nextTick = rt.tick + 1;

  // 1. apply queued input change for this tick (logged only when it changes dir)
  if (rt.pendingDir !== null && rt.pendingTick <= nextTick) {
    if (rt.pendingDir !== rt.dir) {
      rt.dir = rt.pendingDir;
      rt.moveLog.push({ tick: nextTick, dir: rt.dir });
      rt.moves = rt.moveLog.length;
    }
    rt.pendingDir = null;
    rt.pendingTick = 0;
  }
  rt.tick = nextTick;

  // 2. move player
  const p = rt.player;
  p.px = p.x; p.py = p.y;
  const pv = IH_DIRS[rt.dir];
  p.x = ihClamp(p.x + pv.x * IH_PLAYER_SPEED, 0, IH_ARENA);
  p.y = ihClamp(p.y + pv.y * IH_PLAYER_SPEED, 0, IH_ARENA);

  // 3. spawn (capped — rng only consumed when a spawn actually happens)
  if (nextTick % ihSpawnInterval(nextTick) === 0 && rt.enemies.length < IH_ENEMY_CAP) {
    rt.enemies.push(ihSpawnEnemy(rt.rng));
  }
  if (nextTick % IH_BOSS_INTERVAL === 0 && rt.enemies.length < IH_ENEMY_CAP) {
    rt.enemies.push(ihSpawnBoss(rt.rng));
  }

  // 4. move enemies toward player
  for (const e of rt.enemies) {
    e.px = e.x; e.py = e.y;
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d = ihIsqrt(dx * dx + dy * dy);
    if (d > 0) {
      const sp = e.boss ? IH_BOSS_SPEED : IH_ENEMY_SPEED;
      e.x += Math.trunc((dx * sp) / d);
      e.y += Math.trunc((dy * sp) / d);
    }
  }

  // 5. contact damage (kamikaze: 1 patience, removed)
  const survivors = [];
  let died = false;
  for (const e of rt.enemies) {
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const hd2 = e.boss ? IH_BOSS_HIT_DIST2 : IH_HIT_DIST2;
    if (dx * dx + dy * dy <= hd2) {
      rt.hp -= 1;
      if (rt.hp <= 0) { died = true; break; }
    } else {
      survivors.push(e);
    }
  }
  rt.enemies = survivors;
  if (died) {
    rt.hp = 0;
    rt.deathAt = performance.now();
    rt.endedReason = 'ticket Cię dopadł';
    ihSetStats(true);
    finishInvoiceHordeRound();
    return;
  }

  // 6. auto-fire: nearest faktura in range is booked (+1)
  if (nextTick % IH_FIRE_INTERVAL === 0 && rt.enemies.length) {
    let bestIdx = -1;
    let bestD2 = IH_FIRE_RANGE2 + 1;
    for (let i = 0; i < rt.enemies.length; i += 1) {
      const dx = p.x - rt.enemies[i].x;
      const dy = p.y - rt.enemies[i].y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= IH_FIRE_RANGE2 && d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      const target = rt.enemies[bestIdx];
      rt.shotFx = { fx: p.x, fy: p.y, tx: target.x, ty: target.y, at: performance.now() };
      if (target.boss) {
        target.hp -= 1;
        ihBurst(rt, target.x, target.y);
        if (target.hp <= 0) {
          rt.enemies.splice(bestIdx, 1);
          rt.score = Math.min(IH_MAX_SCORE, rt.score + IH_BOSS_SCORE);
        }
      } else {
        ihBurst(rt, target.x, target.y);
        rt.enemies.splice(bestIdx, 1);
        rt.score = Math.min(IH_MAX_SCORE, rt.score + 1);
      }
    }
  }

  rt.lastStepPerf = performance.now();

  if (rt.tick >= IH_MAX_TICKS) {
    rt.endedReason = 'przeżyłeś do końca!';
    finishInvoiceHordeRound();
    return;
  }
  ihSetStats();
}

function ihTick() {
  const rt = invoiceHordeRuntime;
  if (!rt?.playing) return;
  if (ihElapsed() >= rt.durationMs) {
    rt.endedReason = 'przeżyłeś do końca!';
    finishInvoiceHordeRound();
    return;
  }
  ihStep();
}

function prepareInvoiceHordeAdminTest() {
  if (invoiceHordeRuntime?.playing) stopInvoiceHordeRound();
  if (!invoiceHordeRuntime) ihResetBoard(1);
  invoiceHordeRuntime.archiveMode = true;
  ihInitCanvas();
  ihResetStatCache();
  ihSetStats(true);
  ihDraw(performance.now());
  if (ihStartBtn) { ihStartBtn.disabled = false; ihStartBtn.textContent = 'Start rundy'; }
  const weekLabel = document.getElementById('ih-week-label');
  if (weekLabel) weekLabel.textContent = 'test';
  const weeklyWrap  = document.getElementById('ih-weekly-board');
  const allTimeWrap = document.getElementById('ih-alltime-board');
  const awardsWrap  = document.getElementById('ih-awards');
  if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Tryb testowy admina — ranking nie jest używany.'));
  if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Start uruchamia lokalną rundę bez zapisu w bazie.'));
  if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Nagrody nie są naliczane w teście.'));
  if (ihStatus) ihStatus.textContent = 'Admin test — lokalna runda, bez zapisu wyniku.';
}

async function startInvoiceHordeRound() {
  const rt = invoiceHordeRuntime;
  if (rt?.playing || rt?.submitting) return;
  if (activeTab === 'invoice-horde-test') {
    const now = new Date().toISOString();
    beginInvoiceHordeRound({
      id: 'admin-test-' + Date.now(),
      seed: Math.floor(Math.random() * 2147483647) + 1,
      durationMs: IH_DURATION_MS,
      tickMs: IH_TICK_MS,
      startedAt: now,
      serverNow: now,
    }, { archiveMode: true });
    return;
  }
  if (allGamesMode) {
    try { await payArcadeEntry(allGamesSelectedGame); } catch(e) { showToast('❌ Nie udało się wejść do gry.'); return; }
  }
  if (ihStartBtn) { ihStartBtn.disabled = true; ihStartBtn.textContent = 'Ładuję...'; }
  if (ihStatus) ihStatus.textContent = 'Przygotowuję rundę...';
  try {
    const data = await invokeInvoiceHorde({ action: 'start' });
    renderInvoiceHordeState(data);
    beginInvoiceHordeRound(data.round, allGamesMode ? { archiveMode: true } : {});
  } catch (err) {
    showToast('❌ ' + err.message);
    if (ihStatus) ihStatus.textContent = 'Nie udało się wystartować rundy.';
    if (ihStartBtn) { ihStartBtn.disabled = false; ihStartBtn.textContent = 'Start rundy'; }
  }
}

async function finishInvoiceHordeRound() {
  const rt = invoiceHordeRuntime;
  if (!rt || rt.submitting) return;
  rt.playing = false;
  rt.submitting = true;
  if (rt.timer) clearInterval(rt.timer);
  ihStartRaf(); // keep drawing briefly so the death shake/flash animates out
  ihSetStats(true);
  ihDraw(performance.now());

  if (rt.archiveMode) {
    rt.submitting = false;
    if (ihStartBtn) { ihStartBtn.disabled = false; ihStartBtn.textContent = 'Zagraj ponownie'; }
    if (allGamesMode) {
      try {
        await recordArcadeScore('invoice_horde', rt.score);
        if (ihStatus) ihStatus.textContent = 'Wynik: ' + rt.score + ' · zapisano w rankingu arcade!';
        loadArcadeScores('invoice_horde');
      } catch(e) { if (ihStatus) ihStatus.textContent = 'Wynik: ' + rt.score + ' (błąd zapisu).'; }
    } else {
      if (ihStatus) ihStatus.textContent = 'Demo — wynik: ' + rt.score + ' (nie zapisano).';
    }
    return;
  }

  if (ihStartBtn) { ihStartBtn.disabled = true; ihStartBtn.textContent = 'Zapisuję...'; }
  if (ihStatus) ihStatus.textContent = 'Zapisuję wynik...';
  try {
    const data = await invokeInvoiceHorde({
      action: 'submit',
      roundId: rt.roundId,
      seed: rt.seed,
      moves: rt.moveLog.slice(0, 2000),
      elapsedTicks: rt.tick,
      score: rt.score,
    });
    renderInvoiceHordeState(data);
    showToast('✅ Wynik zapisany: ' + data.score.score);
    if (ihStatus) {
      const reason = rt.endedReason ? ' · ' + rt.endedReason : '';
      ihStatus.textContent = 'Rozwiązane tickety: ' + data.score.score + reason + '.';
    }
  } catch (err) {
    showToast('❌ ' + err.message);
    if (ihStatus) ihStatus.textContent = 'Nie udało się zapisać wyniku.';
  } finally {
    rt.submitting = false;
    if (ihStartBtn) { ihStartBtn.disabled = false; ihStartBtn.textContent = 'Zagraj ponownie'; }
  }
}

if (ihStartBtn) ihStartBtn.addEventListener('click', startInvoiceHordeRound);

document.addEventListener('keydown', evt => {
  if (!invoiceHordeRuntime?.playing) return;
  const key = evt.key.toLowerCase();
  const code = evt.key === 'ArrowUp' || key === 'w' ? 'U'
    : evt.key === 'ArrowDown' || key === 's' ? 'D'
    : evt.key === 'ArrowLeft' || key === 'a' ? 'L'
    : evt.key === 'ArrowRight' || key === 'd' ? 'R'
    : null;
  if (!code) return;
  evt.preventDefault();
  if (ihKeys[code]) return;
  ihKeys[code] = true;
  ihSetInput(ihDirCode((ihKeys.R ? 1 : 0) - (ihKeys.L ? 1 : 0), (ihKeys.D ? 1 : 0) - (ihKeys.U ? 1 : 0)));
});

document.addEventListener('keyup', evt => {
  if (!invoiceHordeRuntime?.playing) return;
  const key = evt.key.toLowerCase();
  const code = evt.key === 'ArrowUp' || key === 'w' ? 'U'
    : evt.key === 'ArrowDown' || key === 's' ? 'D'
    : evt.key === 'ArrowLeft' || key === 'a' ? 'L'
    : evt.key === 'ArrowRight' || key === 'd' ? 'R'
    : null;
  if (!code || !ihKeys[code]) return;
  ihKeys[code] = false;
  ihSetInput(ihDirCode((ihKeys.R ? 1 : 0) - (ihKeys.L ? 1 : 0), (ihKeys.D ? 1 : 0) - (ihKeys.U ? 1 : 0)));
});

if (ihArena) {
  ihArena.addEventListener('pointerdown', evt => {
    evt.preventDefault();
    if (!invoiceHordeRuntime?.playing && !invoiceHordeRuntime?.submitting) {
      startInvoiceHordeRound();
      return;
    }
    invoiceHordeRuntime.pointerActive = true;
    invoiceHordeRuntime.pointerStart = { x: evt.clientX, y: evt.clientY };
  });
  ihArena.addEventListener('pointermove', evt => {
    const rt = invoiceHordeRuntime;
    if (!rt?.playing || !rt.pointerActive || !rt.pointerStart) return;
    const dx = evt.clientX - rt.pointerStart.x;
    const dy = evt.clientY - rt.pointerStart.y;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (Math.max(adx, ady) < 14) { ihSetInput('S'); return; }
    let sx = 0, sy = 0;
    if (adx > ady * 2.414) { sx = dx > 0 ? 1 : -1; }        // mostly horizontal
    else if (ady > adx * 2.414) { sy = dy > 0 ? 1 : -1; }   // mostly vertical
    else { sx = dx > 0 ? 1 : -1; sy = dy > 0 ? 1 : -1; }    // diagonal
    ihSetInput(ihDirCode(sx, sy));
  });
  const ihStopPointer = () => {
    const rt = invoiceHordeRuntime;
    if (!rt) return;
    rt.pointerActive = false;
    rt.pointerStart = null;
    if (rt.playing) ihSetInput('S');
  };
  ihArena.addEventListener('pointerup', ihStopPointer);
  ihArena.addEventListener('pointercancel', ihStopPointer);
  ihArena.addEventListener('pointerleave', ihStopPointer);
}

