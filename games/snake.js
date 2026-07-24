// ── Snake — canvas ──────────────────────────────────────────────────────────
const SN_GRID = 20;
const SN_CELL = 20;
const SN_CS = SN_GRID * SN_CELL;
const SN_TICK_MS = 120;
const SN_MIN_TICK_MS = 80;
const SN_SPEEDUP_EVERY_TICKS = 250;
const SN_SPEEDUP_STEP_MS = 2;
const SN_MAX_DPR = 2;
const SN_DIRS = Object.freeze({
  U: Object.freeze({ x: 0, y: -1 }),
  D: Object.freeze({ x: 0, y: 1 }),
  L: Object.freeze({ x: -1, y: 0 }),
  R: Object.freeze({ x: 1, y: 0 }),
});

function newSnakeRuntime() {
  return {
    playing: false, submitting: false, archiveMode: false,
    roundId: null,
    seed: 1,
    tickMs: SN_TICK_MS,
    timer: null,
    tick: 0,
    dir: 'R',
    queuedDir: null,
    queuedTick: 0,
    snake: snakeInitialBody(),
    food: null,
    rng: null,
    score: 0,
    moves: 0,
    moveLog: [],
    endedReason: '',
    pointerStart: null,
  };
}

let snCtx = null;
let snStatScoreText = null;
let snStatLengthText = null;
let snStatMovesText = null;

function snakeInitialBody() {
  const mid = Math.floor(SN_GRID / 2);
  return [
    { x: mid, y: mid },
    { x: mid - 1, y: mid },
    { x: mid - 2, y: mid },
  ];
}

function snakeMakeRng(seed) {
  let state = Number(seed || 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function snakeCellKey(pos) {
  return pos.x + ',' + pos.y;
}

function snakeSpawnFood(rt) {
  const occupied = new Set(rt.snake.map(snakeCellKey));
  if (occupied.size >= SN_GRID * SN_GRID) return null;
  for (let guard = 0; guard < 2000; guard += 1) {
    const pos = {
      x: Math.floor(rt.rng() * SN_GRID),
      y: Math.floor(rt.rng() * SN_GRID),
    };
    if (!occupied.has(snakeCellKey(pos))) return pos;
  }
  for (let y = 0; y < SN_GRID; y += 1) {
    for (let x = 0; x < SN_GRID; x += 1) {
      const pos = { x, y };
      if (!occupied.has(snakeCellKey(pos))) return pos;
    }
  }
  return null;
}

function snakeResetBoard(seed = 1) {
  const rt = snakeRuntime || newSnakeRuntime();
  rt.seed = seed;
  rt.tick = 0;
  rt.dir = 'R';
  rt.queuedDir = null;
  rt.queuedTick = 0;
  rt.snake = snakeInitialBody();
  rt.rng = snakeMakeRng(seed);
  rt.food = snakeSpawnFood(rt);
  rt.score = 0;
  rt.moves = 0;
  rt.moveLog = [];
  rt.endedReason = '';
  snakeRuntime = rt;
  return rt;
}

function snakeInitCanvas() {
  const canvas = document.getElementById('sn-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const DPR = Math.min(window.devicePixelRatio || 1, SN_MAX_DPR);
  const w = Math.round((rect.width || SN_CS) * DPR);
  const h = Math.round((rect.height || SN_CS) * DPR);
  if (!snCtx || canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    snCtx = canvas.getContext('2d');
  }
  snCtx.setTransform(w / SN_CS, 0, 0, h / SN_CS, 0, 0);
  snCtx.imageSmoothingEnabled = false;
}

function snakeOpposite(a, b) {
  const da = SN_DIRS[a], db = SN_DIRS[b];
  return !!da && !!db && da.x + db.x === 0 && da.y + db.y === 0;
}

function snakeTickDelay(tick) {
  const stage = Math.floor(Math.max(0, Number(tick || 1) - 1) / SN_SPEEDUP_EVERY_TICKS);
  return Math.max(SN_MIN_TICK_MS, SN_TICK_MS - stage * SN_SPEEDUP_STEP_MS);
}

function snakeScheduleTick(rt = snakeRuntime) {
  if (!rt?.playing) return;
  if (rt.timer) clearTimeout(rt.timer);
  rt.tickMs = snakeTickDelay((rt.tick || 0) + 1);
  rt.timer = setTimeout(snakeTick, rt.tickMs);
}

function snakeResetStatCache() {
  snStatScoreText = null;
  snStatLengthText = null;
  snStatMovesText = null;
}

function snakeSetStats(force = false) {
  const rt = snakeRuntime || newSnakeRuntime();
  const scoreText = String(rt.score || 0);
  const lengthText = String(rt.snake?.length || 3);
  const movesText = String(rt.moves || 0);
  if (snScoreEl && (force || scoreText !== snStatScoreText)) {
    snScoreEl.textContent = scoreText;
    snStatScoreText = scoreText;
  }
  if (snLengthEl && (force || lengthText !== snStatLengthText)) {
    snLengthEl.textContent = lengthText;
    snStatLengthText = lengthText;
  }
  if (snMovesEl && (force || movesText !== snStatMovesText)) {
    snMovesEl.textContent = movesText;
    snStatMovesText = movesText;
  }
}

function snakeDraw(now = performance.now()) {
  const ctx = snCtx;
  if (!ctx) return;
  const rt = snakeRuntime;
  const W = SN_CS, C = SN_CELL;

  ctx.fillStyle = '#07140c';
  ctx.fillRect(0, 0, W, W);
  ctx.fillStyle = '#0d2114';
  for (let y = 0; y < SN_GRID; y += 1) {
    for (let x = (y % 2); x < SN_GRID; x += 2) {
      ctx.fillRect(x * C, y * C, C, C);
    }
  }
  ctx.strokeStyle = 'rgba(34,197,94,.14)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= SN_GRID; i += 1) {
    ctx.beginPath(); ctx.moveTo(i * C, 0); ctx.lineTo(i * C, W); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * C); ctx.lineTo(W, i * C); ctx.stroke();
  }

  if (rt?.food) {
    const fx = rt.food.x * C, fy = rt.food.y * C;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(fx + C / 2, fy + C / 2, C * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fef2f2';
    ctx.fillRect(fx + C * 0.48, fy + C * 0.18, C * 0.12, C * 0.12);
  }

  if (rt?.snake?.length) {
    rt.snake.forEach((part, index) => {
      const x = part.x * C, y = part.y * C;
      ctx.fillStyle = index === 0 ? '#86efac' : index % 2 ? '#22c55e' : '#16a34a';
      ctx.fillRect(x + 2, y + 2, C - 4, C - 4);
      if (index === 0) {
        ctx.fillStyle = '#052e16';
        ctx.fillRect(x + 6, y + 6, 3, 3);
        ctx.fillRect(x + C - 9, y + 6, 3, 3);
      }
    });
  }

  if (rt?.playing) {
    ctx.fillStyle = 'rgba(255,255,255,.88)';
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(String(rt.score || 0), 10, 8);
  } else {
    ctx.fillStyle = 'rgba(7,20,12,.88)';
    ctx.fillRect(0, 0, W, W);
    ctx.fillStyle = '#22c55e';
    ctx.font = 'bold 26px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('SNAKE', W / 2, W / 2 - 24);
    ctx.font = '42px sans-serif';
    ctx.fillText('🐍', W / 2, W / 2 + 12);
    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(134,239,172,.75)';
    const hint = rt?.archiveMode ? 'demo lokalne' : 'strzalki / WASD / swipe';
    ctx.fillText(hint, W / 2, W / 2 + 50);
  }

  ctx.strokeStyle = 'rgba(34,197,94,.35)';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, W - 6, W - 6);
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(1, 1, W - 2, W - 2);
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
}

async function invokeSnake(payload) {
  const { data, error } = await sb.functions.invoke('snake-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć ze Snake.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd Snake.');
  return data;
}

async function loadSnakeState(showSpinner = true) {
  snakeInitCanvas();
  if (!snakeRuntime) snakeResetBoard(1);
  snakeDraw(performance.now());
  const weeklyWrap  = document.getElementById('sn-weekly-board');
  const allTimeWrap = document.getElementById('sn-alltime-board');
  const awardsWrap  = document.getElementById('sn-awards');
  if (showSpinner) {
    if (weeklyWrap)  weeklyWrap.replaceChildren(makeSpinner());
    if (allTimeWrap) allTimeWrap.replaceChildren(makeSpinner());
    if (awardsWrap)  awardsWrap.replaceChildren();
  }
  try {
    const data = await invokeSnake({ action: 'state' });
    renderSnakeState(data);
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Brak danych.'));
    if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
    if (snStatus) snStatus.textContent = 'Snake nie jest jeszcze aktywny.';
  }
}

function renderSnakeState(data) {
  if (data.profile) { me.coins = data.profile.coins; setText(headerCoins, me.coins); }
  const weekLabel = document.getElementById('sn-week-label');
  if (weekLabel) {
    const range = whackBossWeekRange(data.weekStart);
    weekLabel.textContent = range ? range.short : '';
  }
  renderSnakeTable(document.getElementById('sn-weekly-board'), data.weekly || [], 'weekly');
  renderSnakeTable(document.getElementById('sn-alltime-board'), data.allTime || [], 'allTime');
  renderSnakeAwards(document.getElementById('sn-awards'), data.awards || []);
  if (!snakeRuntime?.playing && snStatus) {
    snStatus.textContent = data.myWeekly
      ? 'Twój najlepszy wynik w tym tygodniu: ' + data.myWeekly.score + '.'
      : 'Jedz jabłka. Najlepszy wynik tygodnia trafia do rankingu.';
  }
}

function renderSnakeTable(wrap, rows, mode) {
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
      el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Nick'), el('th', { title: 'Najwyższy wynik' }, 'Wynik'))),
      el('tbody', {}, ...bodyRows)
    )
  );
}

function renderSnakeAwards(wrap, awards) {
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

function stopSnakeRound() {
  const rt = snakeRuntime;
  if (rt?.timer) clearTimeout(rt.timer);
  snakeRuntime = newSnakeRuntime();
  snakeResetBoard(snakeRuntime.seed || 1);
  snakeRuntime.playing = false;
  snakeRuntime.archiveMode = rt?.archiveMode || false;
  if (snStartBtn) { snStartBtn.disabled = false; snStartBtn.textContent = 'Start rundy'; }
  snakeResetStatCache();
  snakeSetStats(true);
  snakeInitCanvas();
  snakeDraw(performance.now());
}

function beginSnakeRound(round, options = {}) {
  stopSnakeRound();
  const seed = Number(round.seed || Date.now()) || 1;
  snakeRuntime = newSnakeRuntime();
  const rt = snakeResetBoard(seed);
  rt.playing = true;
  rt.archiveMode = !!options.archiveMode;
  rt.roundId = round.id;
  rt.tickMs = Number(round.tickMs || SN_TICK_MS) || SN_TICK_MS;
  if (snStartBtn) { snStartBtn.disabled = true; snStartBtn.textContent = 'Runda trwa'; }
  if (snStatus) {
    snStatus.textContent = rt.archiveMode
      ? 'Demo — wynik nie zostanie zapisany.'
      : 'Steruj strzałkami, WASD albo swipe. Nie zawracaj.';
  }
  if (snArena) {
    if (!snArena.hasAttribute('tabindex')) snArena.tabIndex = 0;
    try { snArena.focus({ preventScroll: true }); } catch { snArena.focus(); }
  }
  snakeResetStatCache();
  snakeSetStats(true);
  snakeDraw(performance.now());
  snakeScheduleTick(rt);
}

function snakeQueueDir(dir) {
  const rt = snakeRuntime;
  if (!rt?.playing || !SN_DIRS[dir]) return false;
  const current = rt.queuedDir || rt.dir;
  if (dir === current || snakeOpposite(current, dir)) return false;
  const tick = rt.tick + 1;
  if (rt.queuedTick === tick) return false;
  rt.queuedDir = dir;
  rt.queuedTick = tick;
  rt.moveLog.push({ tick, dir });
  rt.moves = rt.moveLog.length;
  snakeSetStats();
  return true;
}

function snakeStep() {
  const rt = snakeRuntime;
  if (!rt?.playing) return;
  const nextTick = rt.tick + 1;
  if (rt.queuedDir && rt.queuedTick <= nextTick) {
    rt.dir = rt.queuedDir;
    rt.queuedDir = null;
    rt.queuedTick = 0;
  }
  const step = SN_DIRS[rt.dir];
  const head = rt.snake[0];
  const next = { x: head.x + step.x, y: head.y + step.y };
  rt.tick = nextTick;

  if (next.x < 0 || next.x >= SN_GRID || next.y < 0 || next.y >= SN_GRID) {
    rt.endedReason = 'ściana';
    finishSnakeRound();
    return;
  }

  const eating = rt.food && next.x === rt.food.x && next.y === rt.food.y;
  const bodyToCheck = eating ? rt.snake : rt.snake.slice(0, -1);
  if (bodyToCheck.some(part => part.x === next.x && part.y === next.y)) {
    rt.endedReason = 'ogon';
    finishSnakeRound();
    return;
  }

  rt.snake.unshift(next);
  if (eating) {
    rt.score += 1;
    rt.food = snakeSpawnFood(rt);
    if (!rt.food) {
      rt.endedReason = 'pełna plansza';
      finishSnakeRound();
      return;
    }
  } else {
    rt.snake.pop();
  }

  snakeSetStats();
  snakeDraw(performance.now());
}

function snakeTick() {
  const rt = snakeRuntime;
  if (!rt?.playing) return;
  snakeStep();
  if (rt.playing) snakeScheduleTick(rt);
}

async function startSnakeRound() {
  const rt = snakeRuntime;
  if (rt?.playing || rt?.submitting) return;
  if (allGamesMode) {
    try { await payArcadeEntry(allGamesSelectedGame); } catch(e) { showToast('❌ Nie udało się wejść do gry.'); return; }
  }
  if (snStartBtn) { snStartBtn.disabled = true; snStartBtn.textContent = 'Ładuję...'; }
  if (snStatus) snStatus.textContent = 'Przygotowuję rundę...';
  try {
    const data = await invokeSnake({ action: 'start' });
    renderSnakeState(data);
    beginSnakeRound(data.round, allGamesMode ? { archiveMode: true } : {});
  } catch (err) {
    showToast('❌ ' + err.message);
    if (snStatus) snStatus.textContent = 'Nie udało się wystartować rundy.';
    if (snStartBtn) { snStartBtn.disabled = false; snStartBtn.textContent = 'Start rundy'; }
  }
}

async function finishSnakeRound() {
  const rt = snakeRuntime;
  if (!rt || rt.submitting) return;
  rt.playing = false;
  rt.submitting = true;
  if (rt.timer) clearTimeout(rt.timer);
  snakeSetStats(true);
  snakeDraw(performance.now());

  if (rt.archiveMode) {
    rt.submitting = false;
    if (snStartBtn) { snStartBtn.disabled = false; snStartBtn.textContent = 'Zagraj ponownie'; }
    if (allGamesMode) {
      try {
        await recordArcadeScore('snake', rt.score);
        if (snStatus) snStatus.textContent = 'Wynik: ' + rt.score + ' · zapisano w rankingu arcade!';
        loadArcadeScores('snake');
      } catch(e) { if (snStatus) snStatus.textContent = 'Wynik: ' + rt.score + ' (błąd zapisu).'; }
    } else {
      if (snStatus) snStatus.textContent = 'Demo — wynik: ' + rt.score + ' (nie zapisano).';
    }
    return;
  }

  if (snStartBtn) { snStartBtn.disabled = true; snStartBtn.textContent = 'Zapisuję...'; }
  if (snStatus) snStatus.textContent = 'Zapisuję wynik...';
  try {
    const data = await invokeSnake({
      action: 'submit',
      roundId: rt.roundId,
      seed: rt.seed,
      moves: rt.moveLog,
      elapsedTicks: rt.tick,
      score: rt.score,
    });
    renderSnakeState(data);
    showToast('✅ Wynik zapisany: ' + data.score.score);
    if (snStatus) {
      const reason = rt.endedReason ? ' · ' + rt.endedReason : '';
      snStatus.textContent = 'Ostatni wynik: ' + data.score.score + reason + '.';
    }
  } catch (err) {
    showToast('❌ ' + err.message);
    if (snStatus) snStatus.textContent = 'Nie udało się zapisać wyniku.';
  } finally {
    rt.submitting = false;
    if (snStartBtn) { snStartBtn.disabled = false; snStartBtn.textContent = 'Zagraj ponownie'; }
  }
}

if (snStartBtn) snStartBtn.addEventListener('click', startSnakeRound);

document.addEventListener('keydown', evt => {
  if (!snakeRuntime?.playing) return;
  const key = evt.key.toLowerCase();
  const dir = evt.key === 'ArrowUp' || key === 'w' ? 'U'
    : evt.key === 'ArrowDown' || key === 's' ? 'D'
    : evt.key === 'ArrowLeft' || key === 'a' ? 'L'
    : evt.key === 'ArrowRight' || key === 'd' ? 'R'
    : null;
  if (!dir) return;
  evt.preventDefault();
  snakeQueueDir(dir);
});

if (snArena) {
  snArena.addEventListener('pointerdown', evt => {
    evt.preventDefault();
    if (!snakeRuntime?.playing && !snakeRuntime?.submitting) {
      startSnakeRound();
      return;
    }
    snakeRuntime.pointerStart = { x: evt.clientX, y: evt.clientY };
  });
  snArena.addEventListener('pointerup', evt => {
    const rt = snakeRuntime;
    const start = rt?.pointerStart;
    if (!rt?.playing || !start) return;
    rt.pointerStart = null;
    const dx = evt.clientX - start.x;
    const dy = evt.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
    snakeQueueDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U'));
  });
}

