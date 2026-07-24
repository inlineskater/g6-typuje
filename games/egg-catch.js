// ── Łap Jajka (egg_catch) — Elektronika LCD egg catcher ─────────────────────
// PARITY CONTRACT: the EC_* constants and the ecInitState/ecAdvanceTick
// transition rules must stay byte-for-byte equivalent to the block in
// supabase/functions/egg-catch-action/index.ts — the server replays
// seed + moves to derive the trusted score.
const EC_TICK_MS = 100;
const EC_LANES = 4;              // 0 TL, 1 BL, 2 TR, 3 BR
const EC_STEPS = 5;              // egg slots 0..4; resolves stepping past 4
const EC_MAX_MISSES = 3;
const EC_MAX_TICKS = 6000;       // 10 min hard cap
const EC_MAX_SCORE = 1000;       // anti-cheat ceiling
const EC_BEAT_START_TICKS = 8;   // 0.8 s per egg step at level 0
const EC_BEAT_MIN_TICKS = 3;
const EC_LEVEL_EVERY = 10;       // spawned eggs per speed level
const EC_SPAWN_GAP_START = 3;    // beats between spawns
const EC_SPAWN_GAP_MIN = 2;
const EC_SPAWN_GAP_DROP_LEVEL = 4;
const EC_CS_W = 360, EC_CS_H = 280;
const EC_MAX_DPR = 2;

function ecLevel(spawned) { return Math.floor(spawned / EC_LEVEL_EVERY); }
function ecBeatTicks(level) { return Math.max(EC_BEAT_MIN_TICKS, EC_BEAT_START_TICKS - level); }
function ecSpawnGapBeats(level) { return level >= EC_SPAWN_GAP_DROP_LEVEL ? EC_SPAWN_GAP_MIN : EC_SPAWN_GAP_START; }

function ecInitState(seed) {
  return {
    rngState: (Number(seed) >>> 0) || 1,
    wolfPos: 0,
    eggs: [],            // { lane, step }
    spawned: 0,
    caught: 0,
    misses: 0,
    beatCountdown: ecBeatTicks(0),
    spawnCountdown: 1,   // first egg on the first beat
    tick: 0,
  };
}

function ecRng(st) {
  st.rngState = (Math.imul(st.rngState, 1664525) + 1013904223) >>> 0;
  return st.rngState / 4294967296;
}

// One simulation tick. movePos (0..3 or null) is applied BEFORE the beat check.
function ecAdvanceTick(st, movePos) {
  st.tick += 1;
  if (movePos != null) st.wolfPos = movePos;
  const ev = { beat: false, caught: [], broken: [], spawnedLane: null };
  st.beatCountdown -= 1;
  if (st.beatCountdown > 0) return ev;
  ev.beat = true;

  const kept = [];
  for (const egg of st.eggs) {
    egg.step += 1;
    if (egg.step >= EC_STEPS) {
      if (egg.lane === st.wolfPos) { st.caught += 1; ev.caught.push(egg.lane); }
      else { st.misses += 1; ev.broken.push(egg.lane); }
    } else {
      kept.push(egg);
    }
  }
  st.eggs = kept;
  if (st.misses >= EC_MAX_MISSES) return ev;

  st.spawnCountdown -= 1;
  if (st.spawnCountdown <= 0) {
    const first = Math.floor(ecRng(st) * EC_LANES);
    for (let i = 0; i < EC_LANES; i += 1) {
      const lane = (first + i) % EC_LANES;
      const blocked = st.eggs.some(e => e.lane === lane && e.step <= 1);
      if (!blocked) {
        st.eggs.push({ lane, step: 0 });
        st.spawned += 1;
        ev.spawnedLane = lane;
        break;
      }
    }
    st.spawnCountdown = ecSpawnGapBeats(ecLevel(st.spawned));
  }
  st.beatCountdown = ecBeatTicks(ecLevel(st.spawned));
  return ev;
}

function newEggCatchRuntime() {
  return {
    playing: false, submitting: false, archiveMode: false,
    roundId: null,
    seed: 1,
    timer: null,
    sim: ecInitState(1),
    queuedPos: null,
    queuedTick: 0,
    moveLog: [],
    moves: 0,
    endedReason: '',
    fx: [],              // cosmetic: { kind: 'caught'|'broken', lane, untilTick }
    pointerDown: false,
  };
}

let ecCtx = null;
let ecStatScoreText = null;
let ecStatMissesText = null;
let ecStatLevelText = null;

// LCD geometry: hens at the four chute tops, baskets beside the wolf.
const EC_GEO = {
  henX: [40, 40, 320, 320], henY: [64, 118, 64, 118],
  basketX: [142, 142, 218, 218], basketY: [140, 178, 140, 178],
  floorY: 208,
};

function ecSlotXY(lane, step) {
  const t = (step + 0.6) / EC_STEPS;
  return {
    x: EC_GEO.henX[lane] + (EC_GEO.basketX[lane] - EC_GEO.henX[lane]) * t,
    y: EC_GEO.henY[lane] + (EC_GEO.basketY[lane] - EC_GEO.henY[lane]) * t,
  };
}

function eggCatchInitCanvas() {
  const canvas = document.getElementById('ec-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const DPR = Math.min(window.devicePixelRatio || 1, EC_MAX_DPR);
  const w = Math.round((rect.width || EC_CS_W) * DPR);
  const h = Math.round((rect.height || EC_CS_H) * DPR);
  if (!ecCtx || canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    ecCtx = canvas.getContext('2d');
  }
  ecCtx.setTransform(w / EC_CS_W, 0, 0, h / EC_CS_H, 0, 0);
}

function eggCatchResetBoard(seed = 1) {
  const rt = eggCatchRuntime || newEggCatchRuntime();
  rt.seed = seed;
  rt.sim = ecInitState(seed);
  rt.queuedPos = null;
  rt.queuedTick = 0;
  rt.moveLog = [];
  rt.moves = 0;
  rt.endedReason = '';
  rt.fx = [];
  eggCatchRuntime = rt;
  return rt;
}

function eggCatchResetStatCache() {
  ecStatScoreText = null;
  ecStatMissesText = null;
  ecStatLevelText = null;
}

function eggCatchSetStats(force = false) {
  const rt = eggCatchRuntime || newEggCatchRuntime();
  const st = rt.sim;
  const scoreText = String(Math.min(EC_MAX_SCORE, st.caught));
  const missesText = st.misses + '/' + EC_MAX_MISSES;
  const levelText = String(ecLevel(st.spawned) + 1);
  if (ecScoreEl && (force || scoreText !== ecStatScoreText)) { ecScoreEl.textContent = scoreText; ecStatScoreText = scoreText; }
  if (ecMissesEl && (force || missesText !== ecStatMissesText)) { ecMissesEl.textContent = missesText; ecStatMissesText = missesText; }
  if (ecLevelEl && (force || levelText !== ecStatLevelText)) { ecLevelEl.textContent = levelText; ecStatLevelText = levelText; }
}

// LCD-style segment color; ghosts are the barely-visible "off" segments that
// give old Elektronika handhelds their look.
const EC_SEG = '#39402e';
const EC_GHOST = 'rgba(57,64,46,.13)';

function ecDrawEgg(ctx, x, y, ghost) {
  ctx.fillStyle = ghost ? EC_GHOST : EC_SEG;
  ctx.beginPath();
  ctx.ellipse(x, y, 6.5, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  if (!ghost) {
    ctx.fillStyle = '#b9c5a4';
    ctx.beginPath();
    ctx.ellipse(x - 2, y - 2.5, 1.6, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function ecDrawBasket(ctx, lane, active) {
  const x = EC_GEO.basketX[lane], y = EC_GEO.basketY[lane];
  ctx.strokeStyle = active ? EC_SEG : EC_GHOST;
  ctx.lineWidth = active ? 4 : 3;
  ctx.beginPath();
  ctx.moveTo(x - 12, y - 4);
  ctx.quadraticCurveTo(x, y + 12, x + 12, y - 4);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 12, y - 4);
  ctx.lineTo(x + 12, y - 4);
  ctx.stroke();
}

function eggCatchDraw() {
  const ctx = ecCtx;
  if (!ctx) return;
  const rt = eggCatchRuntime;
  const st = rt?.sim;
  const W = EC_CS_W, H = EC_CS_H;

  // beige case + LCD screen
  ctx.fillStyle = '#e9d9ae';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#b9c5a4';
  ctx.fillRect(12, 12, W - 24, H - 60);
  ctx.strokeStyle = '#7d6a41';
  ctx.lineWidth = 2;
  ctx.strokeRect(12, 12, W - 24, H - 60);
  ctx.fillStyle = '#8a6d3f';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('E L E K T R O N I K A   G 6  ·  Ł A P   J A J K A', W / 2, H - 26);

  // chute rails + ghost slots
  for (let lane = 0; lane < EC_LANES; lane += 1) {
    const a = ecSlotXY(lane, -0.4), b = ecSlotXY(lane, EC_STEPS - 0.4);
    ctx.strokeStyle = 'rgba(57,64,46,.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y + 10);
    ctx.lineTo(b.x, b.y + 10);
    ctx.stroke();
    for (let s = 0; s < EC_STEPS; s += 1) {
      const p = ecSlotXY(lane, s);
      ecDrawEgg(ctx, p.x, p.y, true);
    }
  }

  // hens
  ctx.font = '20px sans-serif';
  for (let lane = 0; lane < EC_LANES; lane += 1) {
    const flip = lane >= 2;
    ctx.save();
    ctx.translate(EC_GEO.henX[lane] + (flip ? 6 : -6), EC_GEO.henY[lane] - 2);
    if (!flip) ctx.scale(-1, 1);
    ctx.fillText('🐔', 0, 0);
    ctx.restore();
  }

  // live eggs
  if (st) {
    st.eggs.forEach(egg => {
      const p = ecSlotXY(egg.lane, egg.step);
      ecDrawEgg(ctx, p.x, p.y, false);
    });
  }

  // baskets (active one solid, others ghosted) + wolf
  const wolfPos = st ? st.wolfPos : 0;
  for (let lane = 0; lane < EC_LANES; lane += 1) ecDrawBasket(ctx, lane, lane === wolfPos);
  const wolfSide = wolfPos >= 2 ? 1 : -1;
  ctx.save();
  ctx.translate(W / 2, 186);
  if (wolfSide < 0) ctx.scale(-1, 1);
  ctx.font = '34px sans-serif';
  ctx.fillText('🐺', 0, 0);
  ctx.restore();

  // cosmetic FX
  if (rt && st) {
    ctx.font = '15px sans-serif';
    rt.fx.forEach(f => {
      if (f.kind === 'broken') {
        const x = EC_GEO.basketX[f.lane] + (f.lane >= 2 ? 26 : -26);
        ctx.fillText('🍳', x, EC_GEO.floorY);
      } else {
        ctx.fillStyle = EC_SEG;
        ctx.font = 'bold 12px monospace';
        ctx.fillText('+1', EC_GEO.basketX[f.lane], EC_GEO.basketY[f.lane] - 20);
        ctx.font = '15px sans-serif';
      }
    });
  }

  // HUD: misses top-left, score top-right (LCD digits)
  if (st) {
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('🍳'.repeat(st.misses) || '', 22, 30);
    ctx.fillStyle = EC_SEG;
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.min(EC_MAX_SCORE, st.caught)).padStart(3, '0'), W - 22, 30);
    ctx.textAlign = 'center';
  }

  // idle overlay
  if (!rt?.playing) {
    ctx.fillStyle = 'rgba(185,197,164,.82)';
    ctx.fillRect(12, 12, W - 24, H - 60);
    ctx.fillStyle = EC_SEG;
    ctx.font = 'bold 24px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('ŁAP JAJKA', W / 2, H / 2 - 46);
    ctx.font = '36px sans-serif';
    ctx.fillText('🥚🐺', W / 2, H / 2 - 8);
    ctx.font = '11px monospace';
    ctx.fillStyle = 'rgba(57,64,46,.75)';
    const hint = rt?.archiveMode ? 'demo lokalne' : 'Q/A/P/L · strzalki · tapnij cwiartke';
    ctx.fillText(hint, W / 2, H / 2 + 30);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

async function invokeEggCatch(payload) {
  const { data, error } = await sb.functions.invoke('egg-catch-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z Łap Jajka.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd Łap Jajka.');
  return data;
}

async function loadEggCatchState(showSpinner = true) {
  eggCatchInitCanvas();
  if (!eggCatchRuntime) eggCatchResetBoard(1);
  eggCatchDraw();
  const weeklyWrap  = document.getElementById('ec-weekly-board');
  const allTimeWrap = document.getElementById('ec-alltime-board');
  const awardsWrap  = document.getElementById('ec-awards');
  if (showSpinner) {
    if (weeklyWrap)  weeklyWrap.replaceChildren(makeSpinner());
    if (allTimeWrap) allTimeWrap.replaceChildren(makeSpinner());
    if (awardsWrap)  awardsWrap.replaceChildren();
  }
  try {
    const data = await invokeEggCatch({ action: 'state' });
    renderEggCatchState(data);
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Brak danych.'));
    if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
    if (ecStatus) ecStatus.textContent = 'Łap Jajka nie jest jeszcze aktywne.';
  }
}

function renderEggCatchState(data) {
  if (data.profile) { me.coins = data.profile.coins; setText(headerCoins, me.coins); }
  const weekLabel = document.getElementById('ec-week-label');
  if (weekLabel) {
    const range = whackBossWeekRange(data.weekStart);
    weekLabel.textContent = range ? range.short : '';
  }
  renderEggCatchTable(document.getElementById('ec-weekly-board'), data.weekly || [], 'weekly');
  renderEggCatchTable(document.getElementById('ec-alltime-board'), data.allTime || [], 'allTime');
  renderEggCatchAwards(document.getElementById('ec-awards'), data.awards || []);
  if (!eggCatchRuntime?.playing && ecStatus) {
    ecStatus.textContent = data.myWeekly
      ? 'Twój najlepszy wynik w tym tygodniu: ' + data.myWeekly.score + '.'
      : 'Łap jajka do koszyka. Najlepszy wynik tygodnia trafia do rankingu.';
  }
}

function renderEggCatchTable(wrap, rows, mode) {
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

function renderEggCatchAwards(wrap, awards) {
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

function stopEggCatchRound() {
  const rt = eggCatchRuntime;
  if (rt?.timer) clearTimeout(rt.timer);
  eggCatchRuntime = newEggCatchRuntime();
  eggCatchResetBoard(eggCatchRuntime.seed || 1);
  eggCatchRuntime.playing = false;
  eggCatchRuntime.archiveMode = rt?.archiveMode || false;
  if (ecStartBtn) { ecStartBtn.disabled = false; ecStartBtn.textContent = 'Start rundy'; }
  eggCatchResetStatCache();
  eggCatchSetStats(true);
  eggCatchInitCanvas();
  eggCatchDraw();
}

function beginEggCatchRound(round, options = {}) {
  stopEggCatchRound();
  const seed = Number(round.seed || Date.now()) || 1;
  eggCatchRuntime = newEggCatchRuntime();
  const rt = eggCatchResetBoard(seed);
  rt.playing = true;
  rt.archiveMode = !!options.archiveMode;
  rt.roundId = round.id;
  if (ecStartBtn) { ecStartBtn.disabled = true; ecStartBtn.textContent = 'Runda trwa'; }
  if (ecStatus) {
    ecStatus.textContent = rt.archiveMode
      ? 'Demo — wynik nie zostanie zapisany.'
      : 'Q/A/P/L albo strzałki. Trzy stłuczki kończą rundę.';
  }
  if (ecArena) {
    if (!ecArena.hasAttribute('tabindex')) ecArena.tabIndex = 0;
    try { ecArena.focus({ preventScroll: true }); } catch { ecArena.focus(); }
  }
  eggCatchResetStatCache();
  eggCatchSetStats(true);
  eggCatchDraw();
  rt.timer = setTimeout(eggCatchTick, EC_TICK_MS);
}

function eggCatchQueuePos(pos) {
  const rt = eggCatchRuntime;
  if (!rt?.playing || !Number.isInteger(pos) || pos < 0 || pos >= EC_LANES) return false;
  const st = rt.sim;
  const effective = rt.queuedPos != null ? rt.queuedPos : st.wolfPos;
  if (pos === effective) return false;
  const tick = st.tick + 1;
  if (rt.queuedTick === tick) return false;
  rt.queuedPos = pos;
  rt.queuedTick = tick;
  rt.moveLog.push({ tick, pos });
  rt.moves = rt.moveLog.length;
  return true;
}

function eggCatchTick() {
  const rt = eggCatchRuntime;
  if (!rt?.playing) return;
  const st = rt.sim;
  const nextTick = st.tick + 1;
  let movePos = null;
  if (rt.queuedPos != null && rt.queuedTick === nextTick) {
    movePos = rt.queuedPos;
    rt.queuedPos = null;
    rt.queuedTick = 0;
  }
  const ev = ecAdvanceTick(st, movePos);
  ev.caught.forEach(l => rt.fx.push({ kind: 'caught', lane: l, untilTick: st.tick + 6 }));
  ev.broken.forEach(l => rt.fx.push({ kind: 'broken', lane: l, untilTick: st.tick + 12 }));
  rt.fx = rt.fx.filter(f => f.untilTick > st.tick);
  eggCatchSetStats();
  eggCatchDraw();
  if (st.misses >= EC_MAX_MISSES) {
    rt.endedReason = '3 stłuczki';
    finishEggCatchRound();
    return;
  }
  if (st.tick >= EC_MAX_TICKS) {
    rt.endedReason = 'limit czasu';
    finishEggCatchRound();
    return;
  }
  rt.timer = setTimeout(eggCatchTick, EC_TICK_MS);
}

async function startEggCatchRound() {
  const rt = eggCatchRuntime;
  if (rt?.playing || rt?.submitting) return;
  if (allGamesMode) {
    try { await payArcadeEntry(allGamesSelectedGame); } catch (e) { showToast('❌ Nie udało się wejść do gry.'); return; }
  }
  if (ecStartBtn) { ecStartBtn.disabled = true; ecStartBtn.textContent = 'Ładuję...'; }
  if (ecStatus) ecStatus.textContent = 'Przygotowuję rundę...';
  try {
    const data = await invokeEggCatch({ action: 'start' });
    renderEggCatchState(data);
    beginEggCatchRound(data.round);
    if (allGamesMode) eggCatchRuntime.archiveMode = true;
  } catch (err) {
    showToast('❌ ' + err.message);
    if (ecStatus) ecStatus.textContent = 'Nie udało się wystartować rundy.';
    if (ecStartBtn) { ecStartBtn.disabled = false; ecStartBtn.textContent = 'Start rundy'; }
  }
}

async function finishEggCatchRound() {
  const rt = eggCatchRuntime;
  if (!rt || rt.submitting) return;
  rt.playing = false;
  rt.submitting = true;
  if (rt.timer) clearTimeout(rt.timer);
  eggCatchSetStats(true);
  eggCatchDraw();

  if (rt.archiveMode) {
    rt.submitting = false;
    if (ecStartBtn) { ecStartBtn.disabled = false; ecStartBtn.textContent = 'Zagraj ponownie'; }
    const finalScore = Math.min(EC_MAX_SCORE, rt.sim.caught);
    if (allGamesMode) {
      try {
        await recordArcadeScore('egg_catch', finalScore);
        if (ecStatus) ecStatus.textContent = 'Wynik: ' + finalScore + ' · zapisano w rankingu arcade!';
        loadArcadeScores('egg_catch');
      } catch (e) { if (ecStatus) ecStatus.textContent = 'Wynik: ' + finalScore + ' (błąd zapisu).'; }
    } else {
      if (ecStatus) ecStatus.textContent = 'Demo — wynik: ' + finalScore + ' (nie zapisano).';
    }
    return;
  }

  if (ecStartBtn) { ecStartBtn.disabled = true; ecStartBtn.textContent = 'Zapisuję...'; }
  if (ecStatus) ecStatus.textContent = 'Zapisuję wynik...';
  try {
    const data = await invokeEggCatch({
      action: 'submit',
      roundId: rt.roundId,
      seed: rt.seed,
      moves: rt.moveLog,
      elapsedTicks: rt.sim.tick,
      score: Math.min(EC_MAX_SCORE, rt.sim.caught),
    });
    renderEggCatchState(data);
    showToast('✅ Wynik zapisany: ' + data.score.score);
    if (ecStatus) {
      const reason = rt.endedReason ? ' · ' + rt.endedReason : '';
      ecStatus.textContent = 'Ostatni wynik: ' + data.score.score + reason + '.';
    }
  } catch (err) {
    showToast('❌ ' + err.message);
    if (ecStatus) ecStatus.textContent = 'Nie udało się zapisać wyniku.';
  } finally {
    rt.submitting = false;
    if (ecStartBtn) { ecStartBtn.disabled = false; ecStartBtn.textContent = 'Zagraj ponownie'; }
  }
}

if (ecStartBtn) ecStartBtn.addEventListener('click', startEggCatchRound);

document.addEventListener('keydown', evt => {
  const rt = eggCatchRuntime;
  if (!rt?.playing) return;
  const key = evt.key.toLowerCase();
  const st = rt.sim;
  const effective = rt.queuedPos != null ? rt.queuedPos : st.wolfPos;
  let pos = null;
  if (key === 'q') pos = 0;
  else if (key === 'a') pos = 1;
  else if (key === 'p') pos = 2;
  else if (key === 'l') pos = 3;
  else if (evt.key === 'ArrowLeft') pos = (effective % 2 === 0) ? 0 : 1;
  else if (evt.key === 'ArrowRight') pos = (effective % 2 === 0) ? 2 : 3;
  else if (evt.key === 'ArrowUp' || key === 'w') pos = effective < 2 ? 0 : 2;
  else if (evt.key === 'ArrowDown' || key === 's') pos = effective < 2 ? 1 : 3;
  if (pos == null) return;
  evt.preventDefault();
  eggCatchQueuePos(pos);
});

if (ecArena) {
  ecArena.addEventListener('pointerdown', evt => {
    evt.preventDefault();
    const rt = eggCatchRuntime;
    if (!rt?.playing && !rt?.submitting) {
      startEggCatchRound();
      return;
    }
    if (!rt?.playing) return;
    const rect = ecArena.getBoundingClientRect();
    const right = (evt.clientX - rect.left) > rect.width / 2;
    const bottom = (evt.clientY - rect.top) > rect.height / 2;
    eggCatchQueuePos((right ? 2 : 0) + (bottom ? 1 : 0));
  });
}

