// ── Flappy Pants (3 Pary Spodni) — canvas ─────────────────────────────────
const FP_CS_W        = 384;
const FP_CS_H        = 384;
const FP_MAX_LIVES   = 3;
const FP_PLAYER_X    = 112;
const FP_PLAYER_R    = 16;
const FP_GRAVITY     = 1350;   // units/s^2
const FP_FLAP_V      = -360;   // units/s
const FP_PIPE_SPEED  = 130;    // units/s
const FP_PIPE_W      = 54;
const FP_GAP         = 124;
const FP_PIPE_SPACING = 210;

function newFlappyPantsRuntime() {
  return {
    playing: false, submitting: false, archiveMode: false,
    roundId: null,
    seed: 1,
    rng: null,
    startPerf: 0,
    score: 0, pipes: 0,
    lives: FP_MAX_LIVES,
    player: { y: FP_CS_H / 2, vy: 0 },
    obstacles: [],
    spawnHold: 0,
    lastTs: 0,
    elapsed: 0, speedMult: 1,
    rafId: null,
    invincible: false, invincEnd: 0,
    hitFlash: 0,
    flapEvents: [],
    toasts: [],
  };
}

let fpCtx = null;

function fpInitCanvas() {
  if (fpCtx) return;
  const canvas = document.getElementById('fp-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const DPR = window.devicePixelRatio || 1;
  const w = Math.round((rect.width || FP_CS_W) * DPR);
  const h = Math.round((rect.height || FP_CS_H) * DPR);
  canvas.width  = w;
  canvas.height = h;
  fpCtx = canvas.getContext('2d');
  fpCtx.scale(w / FP_CS_W, h / FP_CS_H);
}

function fpSpawnObstacle(rt) {
  const min = FP_GAP / 2 + 30;
  const max = FP_CS_H - FP_GAP / 2 - 30;
  const rng = rt.rng || Math.random;
  rt.obstacles.push({ x: FP_CS_W, gapY: min + rng() * (max - min), scored: false });
}

function fpFlap() {
  const rt = flappyPantsRuntime;
  if (!rt?.playing) return;
  rt.player.vy = FP_FLAP_V;
  const atMs = rt.startPerf ? Math.max(0, performance.now() - rt.startPerf) : rt.elapsed * 1000;
  rt.flapEvents.push({ atMs: Math.round(atMs) });
}

function fpMakeRng(seed) {
  let state = Number(seed || 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function fpCheckCollision(rt) {
  const p = rt.player;
  if (p.y - FP_PLAYER_R < 0) return true;
  if (p.y + FP_PLAYER_R > FP_CS_H) return true;
  const left = FP_PLAYER_X - FP_PLAYER_R, right = FP_PLAYER_X + FP_PLAYER_R;
  return rt.obstacles.some(o => {
    if (o.x + FP_PIPE_W < left || o.x > right) return false;
    const gapTop = o.gapY - FP_GAP / 2, gapBottom = o.gapY + FP_GAP / 2;
    return (p.y - FP_PLAYER_R < gapTop) || (p.y + FP_PLAYER_R > gapBottom);
  });
}

function fpPlayerHit(ts) {
  const rt = flappyPantsRuntime;
  rt.lives -= 1;
  rt.hitFlash = ts;
  if (fpLivesEl) fpLivesEl.textContent = '👖'.repeat(Math.max(0, rt.lives)) || '—';
  rt.toasts.push({ text: '−1 para!', x: FP_PLAYER_X, y: rt.player.y - 22, born: ts, color: '#ff5555' });
  if (rt.lives <= 0) { finishFlappyPantsRound(); return; }
  rt.invincible = true;
  rt.invincEnd  = ts + 1300;
  rt.player.y   = FP_CS_H / 2;
  rt.player.vy  = 0;
  rt.obstacles  = [];
  rt.spawnHold  = ts + 900;
}

function fpTick(ts) {
  const rt = flappyPantsRuntime;
  if (!rt?.playing) return;
  if (!rt.lastTs) rt.lastTs = ts;
  let dt = (ts - rt.lastTs) / 1000;
  rt.lastTs = ts;
  if (dt > 0.05) dt = 0.05;

  rt.elapsed += dt;
  rt.speedMult = Math.min(2.6, 1 + rt.elapsed * 0.05);

  const p = rt.player;
  p.vy += FP_GRAVITY * dt;
  p.y  += p.vy * dt;

  rt.obstacles.forEach(o => { o.x -= FP_PIPE_SPEED * rt.speedMult * dt; });
  rt.obstacles = rt.obstacles.filter(o => o.x + FP_PIPE_W > -4);
  const last = rt.obstacles[rt.obstacles.length - 1];
  if ((!last || last.x <= FP_CS_W - FP_PIPE_SPACING) && ts >= rt.spawnHold) fpSpawnObstacle(rt);

  if (rt.invincible && ts >= rt.invincEnd) rt.invincible = false;

  rt.obstacles.forEach(o => {
    if (!o.scored && o.x + FP_PIPE_W < FP_PLAYER_X) {
      o.scored = true;
      rt.score += 1; rt.pipes += 1;
      rt.toasts.push({ text: String(rt.score), x: FP_PLAYER_X, y: p.y - 24, born: ts });
      if (fpScoreEl) fpScoreEl.textContent = String(rt.score);
    }
  });

  if (!rt.invincible && fpCheckCollision(rt)) fpPlayerHit(ts);

  fpDraw(ts);
  if (rt.playing) rt.rafId = requestAnimationFrame(fpTick);
}

function fpDraw(now) {
  const ctx = fpCtx;
  if (!ctx) return;
  const rt = flappyPantsRuntime;
  const W = FP_CS_W, H = FP_CS_H;

  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0a1a2e');
  sky.addColorStop(1, '#16324f');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  for (let i = 0; i < 14; i++) ctx.fillRect((i * 53) % W, (i * 37) % H, 2, 2);

  if (rt) {
    rt.obstacles.forEach(o => {
      const gapTop = o.gapY - FP_GAP / 2, gapBottom = o.gapY + FP_GAP / 2;
      ctx.fillStyle = '#3b5e8c';
      ctx.fillRect(o.x, 0, FP_PIPE_W, gapTop);
      ctx.fillRect(o.x, gapBottom, FP_PIPE_W, H - gapBottom);
      ctx.strokeStyle = 'rgba(120,180,255,0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(o.x + 0.5, 0.5, FP_PIPE_W - 1, gapTop - 1);
      ctx.strokeRect(o.x + 0.5, gapBottom + 0.5, FP_PIPE_W - 1, H - gapBottom - 1);
      ctx.font = `${Math.round(FP_PIPE_W * 0.66)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('👖', o.x + FP_PIPE_W / 2, gapTop - FP_PIPE_W * 0.38);
      ctx.fillText('👖', o.x + FP_PIPE_W / 2, gapBottom + FP_PIPE_W * 0.38);
    });

    const blinking = rt.invincible && Math.floor((now - rt.hitFlash) / 80) % 2 === 1;
    if (!blinking) {
      ctx.font = `${FP_PLAYER_R * 2}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('👖', FP_PLAYER_X, rt.player.y);
    }

    if (rt.playing) {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 30px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(String(rt.score), W / 2, 14);
    }

    if (rt.toasts?.length) {
      rt.toasts = rt.toasts.filter(t => now - t.born < 800);
      rt.toasts.forEach(t => {
        const age = now - t.born;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - age / 800);
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = t.color || '#ffe14f';
        ctx.fillText(t.text, t.x, t.y - age * 0.04);
        ctx.restore();
      });
    }
  }

  if (!rt?.playing) {
    ctx.fillStyle = 'rgba(10,26,46,0.92)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#4fc3f7';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('GOTOWY?', W / 2, H / 2 - 28);
    ctx.font = '40px sans-serif';
    ctx.fillText('👖', W / 2, H / 2 + 6);
    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(120,180,255,0.7)';
    ctx.fillText('spacja / klik / dotyk — graj', W / 2, H / 2 + 42);
  }

  ctx.fillStyle = 'rgba(0,0,0,0.07)';
  for (let sy = 0; sy < H; sy += 3) ctx.fillRect(0, sy, W, 1);

  ctx.strokeStyle = 'rgba(79,195,247,0.25)';
  ctx.lineWidth = 5; ctx.strokeRect(2.5, 2.5, W - 5, H - 5);
  ctx.strokeStyle = '#4fc3f7';
  ctx.lineWidth = 1.5; ctx.strokeRect(1, 1, W - 2, H - 2);

  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
}

async function invokeFlappyPants(payload) {
  const { data, error } = await sb.functions.invoke('flappy-pants-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z grą 3 Pary Spodni.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd gry 3 Pary Spodni.');
  return data;
}

async function loadFlappyPantsState(showSpinner = true) {
  fpInitCanvas();
  fpDraw(performance.now());
  const weeklyWrap  = document.getElementById('fp-weekly-board');
  const allTimeWrap = document.getElementById('fp-alltime-board');
  const awardsWrap  = document.getElementById('fp-awards');
  if (showSpinner) {
    if (weeklyWrap)  weeklyWrap.replaceChildren(makeSpinner());
    if (allTimeWrap) allTimeWrap.replaceChildren(makeSpinner());
    if (awardsWrap)  awardsWrap.replaceChildren();
  }
  try {
    const data = await invokeFlappyPants({ action: 'state' });
    renderFlappyPantsState(data);
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Brak danych.'));
    if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
    if (fpStatus) fpStatus.textContent = '3 Pary Spodni nie jest jeszcze aktywne.';
  }
}

function renderFlappyPantsState(data) {
  if (data.profile) { me.coins = data.profile.coins; setText(headerCoins, me.coins); }
  const weekLabel = document.getElementById('fp-week-label');
  if (weekLabel) {
    const range = whackBossWeekRange(data.weekStart);
    weekLabel.textContent = range ? range.short : '';
  }
  renderFlappyPantsTable(document.getElementById('fp-weekly-board'), data.weekly || [], 'weekly');
  renderFlappyPantsTable(document.getElementById('fp-alltime-board'), data.allTime || [], 'allTime');
  renderFlappyPantsAwards(document.getElementById('fp-awards'), data.awards || []);
  if (!flappyPantsRuntime?.playing && fpStatus) {
    fpStatus.textContent = data.myWeekly
      ? 'Twój najlepszy wynik w tym tygodniu: ' + data.myWeekly.score + '.'
      : 'Trzepocz spacją lub kliknięciem. Najlepszy wynik tygodnia trafia do rankingu.';
  }
}

function renderFlappyPantsTable(wrap, rows, mode) {
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

function renderFlappyPantsAwards(wrap, awards) {
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

function stopFlappyPantsRound() {
  const rt = flappyPantsRuntime;
  if (rt?.rafId) cancelAnimationFrame(rt.rafId);
  flappyPantsRuntime = newFlappyPantsRuntime();
  if (fpStartBtn) { fpStartBtn.disabled = false; fpStartBtn.textContent = 'Start rundy'; }
  if (fpScoreEl) fpScoreEl.textContent = '0';
  if (fpLivesEl) fpLivesEl.textContent = '👖👖👖';
  fpInitCanvas();
  fpDraw(performance.now());
}

function beginFlappyPantsRound(round) {
  stopFlappyPantsRound();
  flappyPantsRuntime = newFlappyPantsRuntime();
  const rt = flappyPantsRuntime;
  rt.playing = true;
  rt.roundId = round.id;
  rt.seed = Number(round.seed) || 1;
  rt.rng = fpMakeRng(rt.seed);
  const serverElapsed = round.startedAt && round.serverNow
    ? Math.max(0, new Date(round.serverNow).getTime() - new Date(round.startedAt).getTime())
    : 0;
  rt.startPerf = performance.now() - serverElapsed;
  if (fpStartBtn) { fpStartBtn.disabled = true; fpStartBtn.textContent = 'Runda trwa'; }
  if (fpStatus) fpStatus.textContent = 'Trzepocz — spacja / klik / ↑. Powodzenia!';
  rt.rafId = requestAnimationFrame(fpTick);
}

async function startFlappyPantsRound() {
  const rt = flappyPantsRuntime;
  if (rt?.playing || rt?.submitting) return;
  if (allGamesMode) {
    try { await payArcadeEntry(allGamesSelectedGame); } catch(e) { showToast('❌ Nie udało się wejść do gry.'); return; }
  }
  if (fpStartBtn) { fpStartBtn.disabled = true; fpStartBtn.textContent = 'Ładuję...'; }
  if (fpStatus) fpStatus.textContent = 'Przygotowuję rundę...';
  try {
    const data = await invokeFlappyPants({ action: 'start' });
    renderFlappyPantsState(data);
    beginFlappyPantsRound(data.round);
    if (allGamesMode && flappyPantsRuntime) flappyPantsRuntime.archiveMode = true;
  } catch (err) {
    showToast('❌ ' + err.message);
    if (fpStatus) fpStatus.textContent = 'Nie udało się wystartować rundy.';
    if (fpStartBtn) { fpStartBtn.disabled = false; fpStartBtn.textContent = 'Start rundy'; }
  }
}

async function finishFlappyPantsRound() {
  const rt = flappyPantsRuntime;
  if (!rt || rt.submitting) return;
  rt.playing    = false;
  rt.submitting = true;
  if (rt.rafId) cancelAnimationFrame(rt.rafId);
  if (fpStartBtn) { fpStartBtn.disabled = true; fpStartBtn.textContent = 'Zapisuję...'; }
  if (fpStatus) fpStatus.textContent = 'Zapisuję wynik...';
  fpDraw(performance.now());

  if (rt.archiveMode) {
    rt.submitting = false;
    if (fpStartBtn) { fpStartBtn.disabled = false; fpStartBtn.textContent = 'Zagraj ponownie'; }
    if (allGamesMode) {
      try {
        await recordArcadeScore('flappy_pants', rt.score);
        if (fpStatus) fpStatus.textContent = 'Wynik: ' + rt.score + ' · zapisano w rankingu arcade!';
        loadArcadeScores('flappy_pants');
      } catch(e) { if (fpStatus) fpStatus.textContent = 'Wynik: ' + rt.score + ' (błąd zapisu).'; }
    } else {
      if (fpStatus) fpStatus.textContent = 'Tryb archiwum — wynik: ' + rt.score + ' (nie zapisano).';
    }
    return;
  }

  try {
    const data = await invokeFlappyPants({
      action: 'submit', roundId: rt.roundId,
      score: rt.score,
      pipes: rt.pipes,
      livesUsed: FP_MAX_LIVES - rt.lives,
      elapsedMs: Math.round(rt.startPerf ? Math.max(0, performance.now() - rt.startPerf) : rt.elapsed * 1000),
      flapEvents: rt.flapEvents,
    });
    renderFlappyPantsState(data);
    showToast('✅ Wynik zapisany: ' + data.score.score);
    if (fpStatus) fpStatus.textContent = 'Ostatni wynik: ' + data.score.score + '.';
  } catch (err) {
    showToast('❌ ' + err.message);
    if (fpStatus) fpStatus.textContent = 'Nie udało się zapisać wyniku.';
  } finally {
    rt.submitting = false;
    if (fpStartBtn) { fpStartBtn.disabled = false; fpStartBtn.textContent = 'Zagraj ponownie'; }
  }
}

if (fpStartBtn) fpStartBtn.addEventListener('click', startFlappyPantsRound);

document.addEventListener('keydown', evt => {
  if (!flappyPantsRuntime?.playing) return;
  if (evt.key === ' ' || evt.code === 'Space' || evt.key === 'ArrowUp') {
    evt.preventDefault(); fpFlap();
  }
});
if (fpArena) {
  fpArena.addEventListener('pointerdown', evt => {
    evt.preventDefault();
    const rt = flappyPantsRuntime;
    if (rt?.playing) { fpFlap(); return; }
    if (!rt?.submitting) startFlappyPantsRound();
  });
}

