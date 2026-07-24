// ── „Zamknij Popupy!" (popup_panic) — fake-desktop popup frenzy ───────────────
// PARITY CONTRACT: the PP_* constants and ppInitState / ppSpawnGap / ppSpawnOne /
// ppAdvanceTick below must stay byte-for-byte equivalent to the block in
// supabase/functions/popup-panic-action/index.ts. The client plays this exact
// deterministic simulation (seeded LCG spawns) and logs only the popup ids it
// closed per tick; the server replays seed + events to derive the trusted score.
const PP_TICK_MS = 100;
const PP_ROUND_TICKS = 300;        // 30 s — survive to the cap = win
const PP_MAX_OPEN = 12;            // this many popups open at once = buried (lose)
const PP_MALWARE_TICKS = 25;       // 2.5 s to close a malware popup, else infected
const PP_MALWARE_CHANCE = 0.13;
const PP_MIN_REACTION_TICKS = 2;   // a popup is "materializing" for its first tick
const PP_SPAWN_GAP_START = 8;
const PP_SPAWN_GAP_MIN = 2;
const PP_RAMP_EVERY = 30;          // every 3 s the spawn gap shrinks by one tick
const PP_BURST_AT_TICK = 120;      // after 12 s a spawn can arrive as a 2-popup burst
const PP_BURST_CHANCE = 0.30;
const PP_BOARD_W = 960;
const PP_BOARD_H = 560;
const PP_POPUP_W = 168;
const PP_POPUP_H = 96;
const PP_SCORE_NORMAL = 1;
const PP_SCORE_MALWARE = 3;
const PP_MAX_EVENTS = 3000;
const PP_MAX_SCORE = 2000;

function ppInitState(seed) {
  return {
    rngState: (Number(seed) >>> 0) || 1,
    tick: 0,
    nextId: 1,
    open: [],            // { id, type (0 normal / 1 malware), x, y, spawnTick, deadline }
    spawnCountdown: 1,   // first popup on tick 1
    closed: 0,
    normalClosed: 0,
    malwareClosed: 0,
    score: 0,
    dead: false,
    deadReason: null,    // 'buried' | 'infected'
  };
}

function ppRng(st) {
  st.rngState = (Math.imul(st.rngState, 1664525) + 1013904223) >>> 0;
  return st.rngState / 4294967296;
}

function ppSpawnGap(tick) {
  const steps = Math.floor(tick / PP_RAMP_EVERY);
  return Math.max(PP_SPAWN_GAP_MIN, PP_SPAWN_GAP_START - steps);
}

// Draws exactly 3 rng values (type, x, y) in this order.
function ppSpawnOne(st) {
  const type = ppRng(st) < PP_MALWARE_CHANCE ? 1 : 0;
  const x = Math.floor(ppRng(st) * (PP_BOARD_W - PP_POPUP_W));
  const y = Math.floor(ppRng(st) * (PP_BOARD_H - PP_POPUP_H));
  const popup = {
    id: st.nextId,
    type,
    x,
    y,
    spawnTick: st.tick,
    deadline: type === 1 ? st.tick + PP_MALWARE_TICKS : 0,
  };
  st.nextId += 1;
  st.open.push(popup);
  return popup;
}

// One simulation tick. closeIds = popup ids the player closed on THIS tick.
function ppAdvanceTick(st, closeIds) {
  st.tick += 1;
  const ev = { closed: [], ignored: [], spawned: [], infected: false, buried: false };

  if (closeIds && closeIds.length) {
    for (const id of closeIds) {
      const idx = st.open.findIndex(p => p.id === id);
      if (idx < 0) { ev.ignored.push(id); continue; }
      const popup = st.open[idx];
      if (st.tick < popup.spawnTick + PP_MIN_REACTION_TICKS) { ev.ignored.push(id); continue; }
      st.open.splice(idx, 1);
      st.closed += 1;
      if (popup.type === 1) { st.malwareClosed += 1; st.score += PP_SCORE_MALWARE; }
      else { st.normalClosed += 1; st.score += PP_SCORE_NORMAL; }
      ev.closed.push(popup);
    }
  }

  for (const popup of st.open) {
    if (popup.type === 1 && st.tick >= popup.deadline) {
      st.dead = true; st.deadReason = 'infected'; ev.infected = true; break;
    }
  }
  if (st.dead) return ev;

  st.spawnCountdown -= 1;
  if (st.spawnCountdown <= 0) {
    let count = 1;
    if (st.tick >= PP_BURST_AT_TICK && ppRng(st) < PP_BURST_CHANCE) count = 2;
    for (let i = 0; i < count; i += 1) {
      ev.spawned.push(ppSpawnOne(st));
      if (st.open.length >= PP_MAX_OPEN) { st.dead = true; st.deadReason = 'buried'; ev.buried = true; break; }
    }
    st.spawnCountdown = ppSpawnGap(st.tick);
  }
  return ev;
}

// ── Cosmetic content (client-only, derived from id — NOT part of the sim) ──
const PP_NORMAL_POPUPS = [
  { app: 'Błąd systemu', ic: '⚠️', msg: 'Wystąpił nieoczekiwany błąd 0x0006F.' },
  { app: 'Poczta G6', ic: '📧', msg: 'Masz 47 nieprzeczytanych maili od szefa!' },
  { app: 'Reklama', ic: '🎁', msg: 'GRATULACJE! Wygrałeś iPhone 20 Pro. Kliknij!' },
  { app: 'Drukarka', ic: '🖨️', msg: 'Brak tonera. Skontaktuj się z działem IT.' },
  { app: 'Aktualizacja', ic: '💾', msg: 'Restart za 10 sekund. Zapisz pracę!' },
  { app: 'Kalendarz', ic: '📅', msg: 'Daily za 2 minuty. Znowu.' },
  { app: 'Kuchnia', ic: '☕', msg: 'Ekspres w kuchni jest znowu zajęty.' },
  { app: 'Jira', ic: '🐛', msg: 'Przypisano Ci 12 nowych ticketów.' },
  { app: 'Zakupy', ic: '🛒', msg: 'Twój koszyk tęskni! -70% tylko dziś.' },
  { app: 'Antywirus', ic: '🛡️', msg: 'Skanowanie zakończone: 0 zagrożeń. Kliknij OK.' },
];
const PP_MALWARE_POPUPS = [
  { app: 'UWAGA: WIRUS', ic: '🦠', msg: 'Komputer zainfekowany! Zamknij TERAZ!' },
  { app: 'RANSOMWARE', ic: '💀', msg: 'Pliki zaszyfrowane. Zamknij, by przerwać!' },
  { app: 'Wykryto atak', ic: '🔓', msg: 'Ktoś loguje się na Twoje konto G6!' },
];
function ppPopupContent(popup) {
  const arr = popup.type === 1 ? PP_MALWARE_POPUPS : PP_NORMAL_POPUPS;
  return arr[popup.id % arr.length];
}

function newPopupPanicRuntime() {
  return {
    playing: false, submitting: false, archiveMode: false,
    roundId: null,
    seed: 1,
    timer: null,
    sim: ppInitState(1),
    eventLog: [],          // { tick, id }
    queued: [],            // ids queued for the upcoming tick
    queuedTick: 0,
    closingIds: new Set(), // ids already queued this tick (ignore repeat clicks)
    els: new Map(),        // id -> DOM element
    endedReason: '',
  };
}

function popupPanicClearBoard() {
  if (ppArena) ppArena.querySelectorAll('.pp-popup').forEach(e => e.remove());
  if (popupPanicRuntime) { popupPanicRuntime.els.clear(); }
}

function popupPanicSetStats() {
  const st = popupPanicRuntime?.sim;
  if (!st) return;
  if (ppScoreEl) ppScoreEl.textContent = String(Math.min(PP_MAX_SCORE, st.score));
  if (ppTimeEl) ppTimeEl.textContent = (Math.max(0, PP_ROUND_TICKS - st.tick) / 10).toFixed(1);
  if (ppOpenEl) ppOpenEl.textContent = st.open.length + '/' + PP_MAX_OPEN;
}

function popupPanicCreateEl(popup) {
  const c = ppPopupContent(popup);
  const win = el('div', { className: 'pp-popup' + (popup.type === 1 ? ' is-malware' : '') });
  win.dataset.id = String(popup.id);
  win.style.zIndex = String(popup.id);
  win.appendChild(el('div', { className: 'pp-titlebar' },
    el('span', { className: 'pp-title' }, c.app),
    el('span', { className: 'pp-x', 'aria-hidden': 'true' }, '✕')
  ));
  win.appendChild(el('div', { className: 'pp-body' },
    el('span', { className: 'pp-ic' }, c.ic),
    el('span', { className: 'pp-msg' }, c.msg)
  ));
  if (popup.type === 1) {
    const bar = el('i', {});
    bar.style.animationDuration = (PP_MALWARE_TICKS * PP_TICK_MS) + 'ms';
    win.appendChild(el('div', { className: 'pp-deadline' }, bar));
  }
  return win;
}

function popupPanicRender() {
  const rt = popupPanicRuntime;
  if (!rt || !ppArena) return;
  const st = rt.sim;
  const openIds = new Set(st.open.map(p => p.id));
  for (const [id, elx] of rt.els) {
    if (!openIds.has(id)) {
      elx.classList.add('pp-gone');
      setTimeout(() => elx.remove(), 140);
      rt.els.delete(id);
    }
  }
  for (const popup of st.open) {
    let elx = rt.els.get(popup.id);
    if (!elx) {
      elx = popupPanicCreateEl(popup);
      ppArena.appendChild(elx);
      rt.els.set(popup.id, elx);
      elx.style.left = (popup.x / PP_BOARD_W * 100) + '%';
      elx.style.top  = (popup.y / PP_BOARD_H * 100) + '%';
    }
    const age = st.tick - popup.spawnTick;
    elx.classList.toggle('pp-spawning', age < 1);
  }
  ppArena.classList.toggle('is-danger', st.open.length >= PP_MAX_OPEN - 3);
}

function popupPanicQueueClose(id) {
  const rt = popupPanicRuntime;
  if (!rt?.playing) return;
  const st = rt.sim;
  const popup = st.open.find(p => p.id === id);
  if (!popup) return;
  const tick = st.tick + 1;
  if (tick < popup.spawnTick + PP_MIN_REACTION_TICKS) return; // still materializing
  if (rt.closingIds.has(id)) return;
  if (rt.queuedTick !== tick) { rt.queued = []; rt.queuedTick = tick; rt.closingIds.clear(); }
  rt.queued.push(id);
  rt.closingIds.add(id);
  rt.eventLog.push({ tick, id });
  const elx = rt.els.get(id);
  if (elx) elx.classList.add('pp-closing');
}

function popupPanicTick() {
  const rt = popupPanicRuntime;
  if (!rt?.playing) return;
  const st = rt.sim;
  const nextTick = st.tick + 1;
  let closeIds = null;
  if (rt.queued.length && rt.queuedTick === nextTick) {
    closeIds = rt.queued;
    rt.queued = [];
    rt.queuedTick = 0;
  }
  ppAdvanceTick(st, closeIds);
  rt.closingIds.clear();
  popupPanicRender();
  popupPanicSetStats();
  if (st.dead) {
    rt.endedReason = st.deadReason === 'infected' ? 'złapałeś wirusa' : 'zasypany popupami';
    finishPopupPanicRound();
    return;
  }
  if (st.tick >= PP_ROUND_TICKS) {
    rt.endedReason = 'przetrwałeś 30 s';
    finishPopupPanicRound();
    return;
  }
  rt.timer = setTimeout(popupPanicTick, PP_TICK_MS);
}

function stopPopupPanicRound() {
  const rt = popupPanicRuntime;
  if (rt?.timer) clearTimeout(rt.timer);
  const archive = rt?.archiveMode || false;
  popupPanicRuntime = newPopupPanicRuntime();
  popupPanicRuntime.archiveMode = archive;
  popupPanicClearBoard();
  if (ppArena) { ppArena.classList.remove('is-playing', 'is-danger'); }
  if (ppStartBtn) { ppStartBtn.disabled = false; ppStartBtn.textContent = 'Start rundy'; }
  popupPanicSetStats();
}

function beginPopupPanicRound(round, options = {}) {
  stopPopupPanicRound();
  const seed = Number(round.seed || Date.now()) || 1;
  popupPanicRuntime = newPopupPanicRuntime();
  const rt = popupPanicRuntime;
  rt.seed = seed;
  rt.sim = ppInitState(seed);
  rt.playing = true;
  rt.archiveMode = !!options.archiveMode;
  rt.roundId = round.id;
  popupPanicClearBoard();
  if (ppArena) ppArena.classList.add('is-playing');
  if (ppStartBtn) { ppStartBtn.disabled = true; ppStartBtn.textContent = 'Runda trwa'; }
  if (ppStatus) ppStatus.textContent = rt.archiveMode
    ? 'Demo — wynik nie zostanie zapisany.'
    : 'Zamykaj popupy! 12 naraz = koniec, a malware ma zegar.';
  popupPanicSetStats();
  rt.timer = setTimeout(popupPanicTick, PP_TICK_MS);
}

async function invokePopupPanic(payload) {
  const { data, error } = await sb.functions.invoke('popup-panic-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z Zamknij Popupy.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd Zamknij Popupy.');
  return data;
}

async function loadPopupPanicState(showSpinner = true) {
  if (!popupPanicRuntime) popupPanicRuntime = newPopupPanicRuntime();
  popupPanicSetStats();
  const weeklyWrap  = document.getElementById('pp-weekly-board');
  const allTimeWrap = document.getElementById('pp-alltime-board');
  const awardsWrap  = document.getElementById('pp-awards');
  if (showSpinner) {
    if (weeklyWrap)  weeklyWrap.replaceChildren(makeSpinner());
    if (allTimeWrap) allTimeWrap.replaceChildren(makeSpinner());
    if (awardsWrap)  awardsWrap.replaceChildren();
  }
  try {
    const data = await invokePopupPanic({ action: 'state' });
    renderPopupPanicState(data);
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Brak danych.'));
    if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
    if (ppStatus) ppStatus.textContent = 'Zamknij Popupy nie jest jeszcze aktywne.';
  }
}

function renderPopupPanicState(data) {
  if (data.profile) { me.coins = data.profile.coins; setText(headerCoins, me.coins); }
  const weekLabel = document.getElementById('pp-week-label');
  if (weekLabel) {
    const range = whackBossWeekRange(data.weekStart);
    weekLabel.textContent = range ? range.short : '';
  }
  renderPopupPanicTable(document.getElementById('pp-weekly-board'), data.weekly || [], 'weekly');
  renderPopupPanicTable(document.getElementById('pp-alltime-board'), data.allTime || [], 'allTime');
  renderPopupPanicAwards(document.getElementById('pp-awards'), data.awards || []);
  if (!popupPanicRuntime?.playing && ppStatus) {
    ppStatus.textContent = data.myWeekly
      ? 'Twój najlepszy wynik w tym tygodniu: ' + data.myWeekly.score + '.'
      : 'Zamykaj popupy jak leci. Najlepszy wynik tygodnia trafia do rankingu.';
  }
}

function renderPopupPanicTable(wrap, rows, mode) {
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

function renderPopupPanicAwards(wrap, awards) {
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

async function startPopupPanicRound() {
  const rt = popupPanicRuntime;
  if (rt?.playing || rt?.submitting) return;
  if (allGamesMode) {
    try { await payArcadeEntry(allGamesSelectedGame); } catch (e) { showToast('❌ Nie udało się wejść do gry.'); return; }
  }
  if (ppStartBtn) { ppStartBtn.disabled = true; ppStartBtn.textContent = 'Ładuję...'; }
  if (ppStatus) ppStatus.textContent = 'Przygotowuję rundę...';
  try {
    const data = await invokePopupPanic({ action: 'start' });
    renderPopupPanicState(data);
    beginPopupPanicRound(data.round);
    if (allGamesMode) popupPanicRuntime.archiveMode = true;
  } catch (err) {
    showToast('❌ ' + err.message);
    if (ppStatus) ppStatus.textContent = 'Nie udało się wystartować rundy.';
    if (ppStartBtn) { ppStartBtn.disabled = false; ppStartBtn.textContent = 'Start rundy'; }
  }
}

async function finishPopupPanicRound() {
  const rt = popupPanicRuntime;
  if (!rt || rt.submitting) return;
  rt.playing = false;
  rt.submitting = true;
  if (rt.timer) clearTimeout(rt.timer);
  if (ppArena) ppArena.classList.remove('is-playing');
  popupPanicSetStats();

  const finalScore = Math.min(PP_MAX_SCORE, rt.sim.score);

  if (rt.archiveMode) {
    rt.submitting = false;
    if (ppStartBtn) { ppStartBtn.disabled = false; ppStartBtn.textContent = 'Zagraj ponownie'; }
    if (allGamesMode) {
      try {
        await recordArcadeScore('popup_panic', finalScore);
        if (ppStatus) ppStatus.textContent = 'Wynik: ' + finalScore + ' · zapisano w rankingu arcade!';
        loadArcadeScores('popup_panic');
      } catch (e) { if (ppStatus) ppStatus.textContent = 'Wynik: ' + finalScore + ' (błąd zapisu).'; }
    } else {
      if (ppStatus) ppStatus.textContent = 'Demo — wynik: ' + finalScore + ' (nie zapisano).';
    }
    return;
  }

  if (ppStartBtn) { ppStartBtn.disabled = true; ppStartBtn.textContent = 'Zapisuję...'; }
  if (ppStatus) ppStatus.textContent = 'Zapisuję wynik...';
  try {
    const data = await invokePopupPanic({
      action: 'submit',
      roundId: rt.roundId,
      seed: rt.seed,
      events: rt.eventLog,
      elapsedTicks: rt.sim.tick,
      score: finalScore,
    });
    renderPopupPanicState(data);
    showToast('✅ Wynik zapisany: ' + data.score.score);
    if (ppStatus) {
      const reason = rt.endedReason ? ' · ' + rt.endedReason : '';
      ppStatus.textContent = 'Ostatni wynik: ' + data.score.score + reason + '.';
    }
  } catch (err) {
    showToast('❌ ' + err.message);
    if (ppStatus) ppStatus.textContent = 'Nie udało się zapisać wyniku.';
  } finally {
    rt.submitting = false;
    if (ppStartBtn) { ppStartBtn.disabled = false; ppStartBtn.textContent = 'Zagraj ponownie'; }
  }
}

if (ppStartBtn) ppStartBtn.addEventListener('click', startPopupPanicRound);

if (ppArena) {
  ppArena.addEventListener('pointerdown', evt => {
    const rt = popupPanicRuntime;
    const win = evt.target.closest ? evt.target.closest('.pp-popup') : null;
    if (win && rt?.playing) {
      evt.preventDefault();
      popupPanicQueueClose(Number(win.dataset.id));
      return;
    }
    if (!win && !rt?.playing && !rt?.submitting) {
      evt.preventDefault();
      startPopupPanicRound();
    }
  });
}

