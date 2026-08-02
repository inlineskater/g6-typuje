// ── „Filler" (1v1 territory flood-fill) — arcade-only Phase 1 ────────────────
// SERVER-AUTHORITATIVE FOR EVERY MOVE (Poker/Roulette/Wheel model). This file
// never runs an authoritative simulation — it only renders whatever board
// state supabase/functions/filler-action returns and sends the player's own
// color picks. There is deliberately no client-side game logic to keep in
// parity with the server (see supabase/filler.sql's header comment and
// docs/filler.md), which is why this file has no PARITY CONTRACT banner and
// no matching scripts/filler-parity.mjs the way every tick-simulation game
// here does.
//
// Rendering-only board: keeps the last-rendered `cells`/`owners` strings and
// repaints only the tile indices that actually changed, rather than
// rebuilding the whole 527-cell grid on every poll/realtime tick.

// 7 colors ("7 Colors" — the international name of the original 1990 game).
// Length must stay >= any match's colorCount; fillerRenderPalette rebuilds
// its buttons from m.colorCount so an older/smaller match never shows a
// dead extra swatch.
const FILLER_COLOR_HEX = ['#e5484d', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7'];
const FILLER_POLL_MS = 2000;
const FILLER_STATE_MIN_GAP_MS = 900; // dedupe a realtime doorbell landing right after our own fetch

let fillerRuntime = null;
let fillerRealtimeChannel = null;

function newFillerRuntime() {
  return {
    mounted: false,
    loading: false,
    lastStateAt: 0,
    lastCells: null,
    lastOwners: null,
    matchId: null,
    pollTimer: null,
    tickTimer: null,
    data: null, // last full { coins, nick, match, history } snapshot
  };
}

async function invokeFiller(payload) {
  const { data, error } = await sb.functions.invoke('filler-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z Fillerem.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd Fillera.');
  return data;
}

function fillerEl(id) {
  return document.getElementById(id);
}

// ── State loading / polling / realtime ──────────────────────────────────────

async function loadFillerState(showSpinner = false) {
  const rt = fillerRuntime;
  if (!rt || rt.loading) return;
  rt.loading = true;
  rt.lastStateAt = Date.now();
  const status = fillerEl('filler-status');
  if (showSpinner && status) status.textContent = 'Wczytywanie…';
  try {
    const data = await invokeFiller({ action: 'state' });
    rt.data = data;
    renderFillerPanel(data);
    fillerSyncRealtime(data.match);
  } catch (err) {
    if (status) status.textContent = 'Błąd wczytywania: ' + (err?.message || 'nieznany błąd.');
  } finally {
    rt.loading = false;
  }
}

function fillerStartPoll() {
  const rt = fillerRuntime;
  if (!rt || rt.pollTimer) return;
  rt.pollTimer = setInterval(() => {
    if (Date.now() - rt.lastStateAt >= FILLER_POLL_MS - 100) loadFillerState(false);
  }, FILLER_POLL_MS);
}

function fillerStopPoll() {
  const rt = fillerRuntime;
  if (rt?.pollTimer) { clearInterval(rt.pollTimer); rt.pollTimer = null; }
}

// A pure doorbell — the realtime payload is never trusted, we always
// re-fetch the authoritative snapshot via `state`. Subscribed with a
// per-match filter (not table-wide) so an unrelated match's moves never
// wake every connected client.
function fillerSyncRealtime(match) {
  const rt = fillerRuntime;
  if (!rt) return;
  const matchId = match?.id || null;
  if (matchId === rt.matchId && fillerRealtimeChannel) return;
  if (fillerRealtimeChannel) {
    sb.removeChannel(fillerRealtimeChannel);
    fillerRealtimeChannel = null;
  }
  rt.matchId = matchId;
  if (!matchId) return;
  const reload = () => {
    if (Date.now() - rt.lastStateAt < FILLER_STATE_MIN_GAP_MS) return;
    loadFillerState(false);
  };
  fillerRealtimeChannel = sb.channel('filler-match-' + matchId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'filler_matches', filter: 'id=eq.' + matchId }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'filler_match_players', filter: 'match_id=eq.' + matchId }, reload)
    .subscribe();
}

// ── Rendering ────────────────────────────────────────────────────────────

function fillerStatusText(data) {
  const m = data.match;
  if (!m) return 'Wybierz tryb gry poniżej.';
  if (m.status === 'waiting') return 'Szukanie przeciwnika… (bot dołączy, jeśli nikt się nie zgłosi)';
  if (m.status === 'active') {
    if (m.isMyTurn) return 'Twoja kolej — wybierz kolor.';
    const opp = m.players.find((p) => !p.isMe);
    return 'Kolej: ' + (opp ? opp.nick : 'przeciwnik') + '…';
  }
  if (m.status === 'finished' || m.status === 'cancelled') return fillerResultText(m);
  return '';
}

function fillerResultText(m) {
  if (m.endReason === 'abandoned' || m.endReason === 'cancelled') return 'Mecz przerwany — bez wyniku.';
  const me = m.players.find((p) => p.isMe);
  if (!me) return 'Mecz zakończony.';
  const won = m.winnerSeat === me.seat;
  const scoreTxt = me.score != null ? ' (+' + me.score + ' pkt)' : '';
  return (won ? '🏆 Wygrana!' : '💀 Przegrana.') + ' ' + me.tiles + '/' + (m.width * m.height) + ' pól.' + scoreTxt;
}

function fillerRenderButtons(data) {
  const m = data.match;
  const btnBot = fillerEl('filler-btn-bot');
  const btnFind = fillerEl('filler-btn-find');
  const btnCancel = fillerEl('filler-btn-cancel');
  const btnResign = fillerEl('filler-btn-resign');
  const idle = !m || m.status === 'finished' || m.status === 'cancelled';
  if (btnBot) btnBot.classList.toggle('hidden', !idle);
  if (btnFind) btnFind.classList.toggle('hidden', !idle);
  if (btnCancel) btnCancel.classList.toggle('hidden', !(m && m.status === 'waiting'));
  if (btnResign) btnResign.classList.toggle('hidden', !(m && m.status === 'active'));
}

function fillerRenderTimer(data) {
  const rt = fillerRuntime;
  if (rt.tickTimer) { clearInterval(rt.tickTimer); rt.tickTimer = null; }
  const el2 = fillerEl('filler-timer');
  if (!el2) return;
  const m = data.match;
  const target = m?.status === 'active' ? m.turnDeadline : (m?.status === 'waiting' ? m.queueExpiresAt : null);
  if (!target) { el2.textContent = ''; return; }
  const targetMs = new Date(target).getTime();
  const tick = () => {
    const remain = Math.max(0, Math.round((targetMs - Date.now()) / 1000));
    el2.textContent = remain > 0 ? remain + ' s' : '…';
  };
  tick();
  rt.tickTimer = setInterval(tick, 500);
}

function fillerRenderPlayers(data) {
  const wrap = fillerEl('filler-players');
  if (!wrap) return;
  wrap.replaceChildren();
  const m = data.match;
  if (!m) return;
  const total = m.width * m.height;
  for (const p of m.players) {
    const row = el('div', { className: 'filler-player-row' + (p.isMe ? ' is-me' : '') });
    const swatch = el('span', { className: 'filler-swatch', style: { backgroundColor: FILLER_COLOR_HEX[p.color] || '#888' } });
    const pct = total ? Math.round((p.tiles / total) * 100) : 0;
    row.append(
      swatch,
      el('span', { className: 'filler-player-nick' }, (p.isBot ? '🤖 ' : '') + p.nick),
      el('span', { className: 'filler-player-tiles' }, p.tiles + ' pól (' + pct + '%)'),
    );
    wrap.appendChild(row);
  }
}

function fillerRenderPalette(data) {
  const wrap = fillerEl('filler-palette');
  if (!wrap) return;
  const m = data.match;
  // Rebuilds from m.colorCount, not FILLER_COLOR_HEX.length — an older or
  // smaller-than-usual match must never show a permanently-dead extra
  // swatch (or be short a swatch, if colorCount ever exceeds the palette).
  const colorCount = m ? m.colorCount : FILLER_COLOR_HEX.length;
  if (wrap.childElementCount !== colorCount) {
    wrap.replaceChildren();
    for (let c = 0; c < colorCount; c++) {
      const btn = el('button', {
        type: 'button', className: 'filler-color-btn', 'data-color': String(c),
        style: { backgroundColor: FILLER_COLOR_HEX[c] || '#888' },
        onclick: () => fillerPickColor(c),
      });
      wrap.appendChild(btn);
    }
  }
  const legal = new Set(m && m.status === 'active' && m.isMyTurn ? m.legalColors : []);
  const me = m && m.players.find((p) => p.isMe);
  const foe = m && m.players.find((p) => !p.isMe);
  Array.from(wrap.children).forEach((btn, c) => {
    btn.disabled = !legal.has(c);
    btn.classList.toggle('is-disabled', !legal.has(c));
    // Framed regardless of whose turn it is — these two colors are always
    // illegal to pick (own color, opponent's color), so showing which is
    // which is informational, not just a during-your-turn hint.
    btn.classList.toggle('is-mine', !!me && me.color === c);
    btn.classList.toggle('is-foe', !!foe && foe.color === c);
  });
}

// Builds the board's cell grid once (dimensions come from the match, e.g.
// 31x17=527), then only touches the tiles whose color or ownership actually
// changed since the last render.
function fillerRenderBoard(data) {
  const board = fillerEl('filler-board');
  if (!board) return;
  const m = data.match;
  const rt = fillerRuntime;
  if (!m) {
    board.replaceChildren();
    rt.lastCells = null;
    rt.lastOwners = null;
    return;
  }
  const n = m.width * m.height;
  const needsRebuild = board.dataset.matchId !== m.id || board.childElementCount !== n;
  if (needsRebuild) {
    board.replaceChildren();
    board.dataset.matchId = m.id;
    board.style.gridTemplateColumns = 'repeat(' + m.width + ', 1fr)';
    board.style.gridTemplateRows = 'repeat(' + m.height + ', 1fr)';
    board.style.aspectRatio = m.width + ' / ' + m.height;
    for (let i = 0; i < n; i++) board.appendChild(el('div', { className: 'filler-cell' }));
    rt.lastCells = null;
    rt.lastOwners = null;
  }
  const cells = m.cells, owners = m.owners;
  const prevCells = rt.lastCells, prevOwners = rt.lastOwners;
  for (let i = 0; i < n; i++) {
    if (prevCells && prevCells[i] === cells[i] && prevOwners && prevOwners[i] === owners[i]) continue;
    const cell = board.children[i];
    const color = Number(cells[i]);
    cell.style.backgroundColor = FILLER_COLOR_HEX[color] || '#888';
    const owner = owners[i];
    cell.classList.toggle('is-seat0', owner === '0');
    cell.classList.toggle('is-seat1', owner === '1');
    cell.classList.toggle('is-neutral', owner === '.');
  }
  rt.lastCells = cells;
  rt.lastOwners = owners;
}

function fillerRenderHistory(data) {
  const wrap = fillerEl('filler-history');
  if (!wrap) return;
  wrap.replaceChildren();
  for (const h of (data.history || []).slice(0, 8)) {
    const row = el('div', { className: 'filler-history-row' });
    const label = h.opponentKind === 'human'
      ? (h.won ? '🏆 Wygrana vs gracz' : '💀 Przegrana vs gracz')
      : (h.won ? '🏆 Wygrana vs bot (trening)' : '💀 Przegrana vs bot (trening)');
    row.append(
      el('span', {}, label),
      el('span', { className: 'filler-history-score' }, h.score != null ? '+' + h.score + ' pkt' : '—'),
    );
    wrap.appendChild(row);
  }
}

function renderFillerPanel(data) {
  const status = fillerEl('filler-status');
  if (status) status.textContent = fillerStatusText(data);
  fillerRenderButtons(data);
  fillerRenderTimer(data);
  fillerRenderPlayers(data);
  fillerRenderPalette(data);
  fillerRenderBoard(data);
  fillerRenderHistory(data);
}

// ── Actions ──────────────────────────────────────────────────────────────

// Deliberately does NOT call payArcadeEntry()/recordArcadeScore() — 'filler'
// is intentionally absent from both RPCs (see supabase/arcade.sql), and
// filler-action's own privileged connection is the only writer of
// game_type='filler' arcade_scores rows. See docs/filler.md.
async function fillerPlayBot() {
  try {
    // arcadeMode mirrors healer-dungeon's archiveMode: which panel launched
    // this (the „Wszystkie Gry" picker vs, in Phase 2, the seasonal tab).
    // Phase 1: allGamesMode is always true here, since there is no other
    // entry point yet.
    const data = await invokeFiller({ action: 'play_bot', arcadeMode: allGamesMode });
    fillerRuntime.data = data;
    renderFillerPanel(data);
    fillerSyncRealtime(data.match);
  } catch (err) {
    showToast('❌ ' + (err?.message || 'Nie udało się rozpocząć gry.'));
  }
}

async function fillerFindOpponent() {
  try {
    const data = await invokeFiller({ action: 'find_opponent', arcadeMode: allGamesMode });
    fillerRuntime.data = data;
    renderFillerPanel(data);
    fillerSyncRealtime(data.match);
  } catch (err) {
    showToast('❌ ' + (err?.message || 'Nie udało się dołączyć do kolejki.'));
  }
}

async function fillerCancelQueue() {
  try {
    const data = await invokeFiller({ action: 'cancel_queue' });
    fillerRuntime.data = data;
    renderFillerPanel(data);
    fillerSyncRealtime(data.match);
  } catch (err) {
    showToast('❌ ' + (err?.message || 'Nie udało się anulować.'));
  }
}

async function fillerPickColor(color) {
  const m = fillerRuntime?.data?.match;
  if (!m || m.status !== 'active' || !m.isMyTurn) return;
  try {
    const data = await invokeFiller({ action: 'pick_color', matchId: m.id, color, moveNo: m.moveNo });
    fillerRuntime.data = data;
    renderFillerPanel(data);
    fillerSyncRealtime(data.match);
  } catch (err) {
    showToast('❌ ' + (err?.message || 'Nieprawidłowy ruch.'));
  }
}

async function fillerResign() {
  const m = fillerRuntime?.data?.match;
  if (!m || m.status !== 'active') return;
  try {
    const data = await invokeFiller({ action: 'resign', matchId: m.id });
    fillerRuntime.data = data;
    renderFillerPanel(data);
    fillerSyncRealtime(data.match);
  } catch (err) {
    showToast('❌ ' + (err?.message || 'Nie udało się poddać meczu.'));
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────

function fillerSetupOnce() {
  if (fillerSetupOnce.done) return;
  fillerSetupOnce.done = true;
  const btnBot = fillerEl('filler-btn-bot');
  const btnFind = fillerEl('filler-btn-find');
  const btnCancel = fillerEl('filler-btn-cancel');
  const btnResign = fillerEl('filler-btn-resign');
  if (btnBot) btnBot.addEventListener('click', fillerPlayBot);
  if (btnFind) btnFind.addEventListener('click', fillerFindOpponent);
  if (btnCancel) btnCancel.addEventListener('click', fillerCancelQueue);
  if (btnResign) btnResign.addEventListener('click', fillerResign);
}

// Called by selectAllGame()'s post-mount hook (see index.html) and by the
// stop*Round() no-op-stub convention on tab exit. There is no "round" to
// begin/end in the tick-simulation sense — this just (re)enters the panel.
function startFillerRound() {
  if (!fillerRuntime) fillerRuntime = newFillerRuntime();
  fillerSetupOnce();
  fillerRuntime.mounted = true;
  fillerStartPoll();
  loadFillerState(true);
}

// The no-op-stub convention: every other game's leaveAllGamesTab/selectAllGame/
// switchTab teardown chain calls stopFillerRound() unconditionally. No
// explicit "leave match" RPC is needed on tab-exit — the self-healing sweep
// in filler-action heals an abandoned match on its own (see docs/filler.md).
function stopFillerRound() {
  if (!fillerRuntime) fillerRuntime = newFillerRuntime();
  fillerRuntime.mounted = false;
  fillerStopPoll();
  if (fillerRuntime.tickTimer) { clearInterval(fillerRuntime.tickTimer); fillerRuntime.tickTimer = null; }
  if (fillerRealtimeChannel) { sb.removeChannel(fillerRealtimeChannel); fillerRealtimeChannel = null; }
  fillerRuntime.matchId = null;
}

fillerSetupOnce();
