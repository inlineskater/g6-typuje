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
// merge sizes, and repaints only the tiles that actually changed, rather than
// rebuilding the whole 567-tile board on every poll/realtime tick.
//
// The ONE piece of game logic that lives here (fillerPreviewPick) is an
// explicitly NON-authoritative optimistic preview — see its comment.

// 7 colors ("7 Colors" — the international name of the original 1990 game).
// Length must stay >= any match's colorCount; fillerRenderPalette rebuilds
// its buttons from m.colorCount so an older/smaller match never shows a
// dead extra swatch.
const FILLER_COLOR_HEX = ['#e5484d', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7'];
const FILLER_POLL_MS = 2000;
const FILLER_STATE_MIN_GAP_MS = 900; // dedupe a realtime doorbell landing right after our own fetch
// Visual tile merging, largest first: a diamond-shaped group of 4 rhombi that
// share BOTH color and owner is drawn as ONE rhombus of twice the size (and
// four of THOSE become one of four times the size). Purely cosmetic — the
// server's board is always w*h single tiles — and it works out to an exact
// retiling rather than an approximation, because four unit rhombi meeting at
// a lattice vertex occupy precisely the area of one double-size rhombus
// centered on that vertex. A grown territory is uniformly one color by
// definition, so without this a big holding reads as a wall of identical
// specks. Must be powers of two in descending order.
const FILLER_MERGE_SIZES = [4, 2];

// fillerRuntime is `let`-declared in index.html, not here: loadSeasonalTab()
// reads it (`fillerRuntime?.mounted`) before this file has necessarily been
// fetched, and a top-level `let` only creates its global binding when its own
// script executes — so declaring it here left a bare reference to an
// undeclared name, which throws ReferenceError, not undefined. A second
// top-level `let` for the same name across classic scripts sharing one global
// scope is a SyntaxError, so this must stay a plain assignment.
fillerRuntime = null;
let fillerRealtimeChannel = null;

function newFillerRuntime() {
  return {
    mounted: false,
    loading: false,
    lastStateAt: 0,
    lastCells: null,
    lastOwners: null,
    lastSpans: null,
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

// ── Diamond-lattice geometry ─────────────────────────────────────────────
// ⚠️ This geometry and filler-action's neighbors4() are ONE decision made in
// two places, and they must agree: the server decides which tiles a fill
// flows through, this decides which tiles visibly touch. See the banner over
// neighbors4() in supabase/functions/filler-action/index.ts.
//
// The board is a square grid rotated 45° and re-indexed so it stays
// rectangular: odd rows sit half a tile right, rows overlap by half a tile
// height, and every rhombus shares a full edge with the two tiles above and
// the two below (same-row left/right only meet at a point). Working in "tile
// units" where a rhombus is 1x1, the whole field is (w + 0.5) wide and
// (h + 1) / 2 tall — which is why h is roughly double w on these boards and
// they still draw landscape.
function fillerRowOffset(y) { return (y & 1) ? 0.5 : 0; }
function fillerContentW(w) { return w + 0.5; }
function fillerContentH(h) { return (h + 1) / 2; }

// The four half-size children of a size-s rhombus anchored at (x, y), in the
// N / W / E / S positions around its center. Derived from the lattice, not
// guessed: for the s=2 case the two middle children are exactly the anchor's
// own two lower edge-neighbors, which is what makes a merged gem an exact
// retiling of the tiles it replaces.
function fillerGemChildren(x, y, s) {
  const k = s / 2;
  // k is odd only when k === 1, where the horizontal step depends on the
  // anchor row's own half-tile offset.
  const dx = (k % 2 === 0) ? -k / 2 : ((y & 1) ? 0 : -1);
  return [[x, y], [x + dx, y + k], [x + dx + k, y + k], [x, y + 2 * k]];
}

// Collects every unit tile under a size-s rhombus anchored at (x, y).
// Returns false (leaving `out` unusable) if any part falls off the board.
function fillerGemCells(x, y, s, w, h, out) {
  if (s === 1) {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    out.push(y * w + x);
    return true;
  }
  for (const [cx, cy] of fillerGemChildren(x, y, s)) {
    if (!fillerGemCells(cx, cy, s / 2, w, h, out)) return false;
  }
  return true;
}

// Cosmetic merge pass: one byte per tile — 0 = swallowed by a bigger
// neighbor's rhombus (hidden), 1 = its own unit rhombus, N = the anchor of an
// N-times-size merged rhombus. Greedy, largest size first; no alignment rule
// is needed because any diamond-shaped group of four retiles exactly, so
// whatever the greedy pass leaves behind still tiles as unit rhombi.
function fillerComputeSpans(cells, owners, w, h) {
  const span = new Uint8Array(w * h).fill(1);
  const buf = [];
  for (const size of FILLER_MERGE_SIZES) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const base = y * w + x;
        if (span[base] !== 1) continue; // already inside a bigger gem
        buf.length = 0;
        if (!fillerGemCells(x, y, size, w, h, buf)) continue; // runs off the board
        const c = cells[base], o = owners[base];
        let uniform = true;
        for (const j of buf) {
          if (span[j] !== 1 || cells[j] !== c || owners[j] !== o) { uniform = false; break; }
        }
        if (!uniform) continue;
        for (const j of buf) span[j] = 0;
        span[base] = size;
      }
    }
  }
  return span;
}

// Builds the board's tiles once (dimensions come from the match, e.g.
// 21x27=567), then only touches the ones whose color, ownership or merge size
// actually changed since the last render. Tiles are absolutely positioned in
// percentages of the board box — CSS grid cannot express a half-offset,
// half-overlapping lattice, and percentages keep the whole thing responsive
// with no resize handler.
function fillerRenderBoard(data) {
  const board = fillerEl('filler-board');
  if (!board) return;
  const m = data.match;
  const rt = fillerRuntime;
  if (!m) {
    board.replaceChildren();
    rt.lastCells = null;
    rt.lastOwners = null;
    rt.lastSpans = null;
    return;
  }
  const w = m.width, h = m.height, n = w * h;
  const cw = fillerContentW(w), ch = fillerContentH(h);
  const needsRebuild = board.dataset.matchId !== m.id || board.childElementCount !== n;
  if (needsRebuild) {
    board.replaceChildren();
    board.dataset.matchId = m.id;
    board.style.aspectRatio = cw + ' / ' + ch;
    for (let i = 0; i < n; i++) board.appendChild(el('div', { className: 'filler-cell' }));
    rt.lastCells = null;
    rt.lastOwners = null;
    rt.lastSpans = null;
  }
  const cells = m.cells, owners = m.owners;
  const spans = fillerComputeSpans(cells, owners, w, h);
  const prevCells = rt.lastCells, prevOwners = rt.lastOwners, prevSpans = rt.lastSpans;
  for (let i = 0; i < n; i++) {
    if (prevCells && prevCells[i] === cells[i] && prevOwners && prevOwners[i] === owners[i]
        && prevSpans && prevSpans[i] === spans[i]) continue;
    const cell = board.children[i];
    const sp = spans[i];
    if (sp === 0) { cell.style.display = 'none'; continue; }
    const x = i % w, y = (i - x) / w;
    // A size-s gem's top edge is always y/2 regardless of s: it grows
    // downward from its anchor row and outward around the anchor's column.
    cell.style.display = '';
    cell.style.left = ((x + fillerRowOffset(y) + 0.5 - sp / 2) / cw * 100) + '%';
    cell.style.top = ((y / 2) / ch * 100) + '%';
    cell.style.width = (sp / cw * 100) + '%';
    cell.style.height = (sp / ch * 100) + '%';
    cell.style.backgroundColor = FILLER_COLOR_HEX[Number(cells[i])] || '#888';
    const owner = owners[i];
    cell.classList.toggle('is-gem2', sp === 2);
    cell.classList.toggle('is-gem4', sp >= 4);
    cell.classList.toggle('is-seat0', owner === '0');
    cell.classList.toggle('is-seat1', owner === '1');
    cell.classList.toggle('is-neutral', owner === '.');
  }
  rt.lastCells = cells;
  rt.lastOwners = owners;
  rt.lastSpans = spans;
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

// OPTIMISTIC PREVIEW — deliberately NOT authoritative, and not a parity
// contract with the server's absorb(). It exists purely so your own move
// paints instantly instead of after a round trip: without it, the response
// arrives with BOTH your move and the bot's reply already applied, so you
// never actually see what your own pick did. The server's snapshot always
// lands ~a few hundred ms later and overwrites this wholesale, so a wrong
// preview self-corrects within one turn and can never affect the real board,
// the score, or anything persisted. Mirrors the server's flood-fill: recolor
// my whole territory, then transitively absorb 4-adjacent NEUTRAL tiles of
// that color.
function fillerPreviewPick(m, color) {
  const w = m.width, h = m.height, n = w * h;
  const cells = m.cells.split(''), owners = m.owners.split('');
  const seat = String(m.mySeat), col = String(color);
  const seen = new Uint8Array(n);
  const queue = [];
  for (let i = 0; i < n; i++) if (owners[i] === seat) { cells[i] = col; seen[i] = 1; queue.push(i); }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head], x = i % w, y = (i - x) / w;
    // Diamond-lattice adjacency — same rule as filler-action's neighbors4()
    // and as fillerGemChildren above; a preview using square adjacency would
    // flash fills through tiles that don't touch.
    const d = (y & 1) ? 0 : -1;
    const nb = [];
    if (y > 0) {
      if (x + d >= 0) nb.push(i - w + d);
      if (x + d + 1 < w) nb.push(i - w + d + 1);
    }
    if (y < h - 1) {
      if (x + d >= 0) nb.push(i + w + d);
      if (x + d + 1 < w) nb.push(i + w + d + 1);
    }
    for (const j of nb) {
      if (seen[j]) continue;
      seen[j] = 1;
      if (owners[j] === '.' && cells[j] === col) { owners[j] = seat; queue.push(j); }
    }
  }
  let t0 = 0, t1 = 0;
  for (const o of owners) { if (o === '0') t0++; else if (o === '1') t1++; }
  return {
    ...m,
    cells: cells.join(''),
    owners: owners.join(''),
    // isMyTurn false + no legal colors: locks the palette for the round trip,
    // which doubles as the double-click guard on fillerPickColor's own entry.
    isMyTurn: false,
    legalColors: [],
    players: m.players.map((p) => ({
      ...p,
      tiles: p.seat === 0 ? t0 : t1,
      color: p.seat === m.mySeat ? color : p.color,
    })),
  };
}

async function fillerPickColor(color) {
  const m = fillerRuntime?.data?.match;
  if (!m || m.status !== 'active' || !m.isMyTurn) return;
  const rt = fillerRuntime;
  // Suppress the 2s poll for the round trip, so a poll response built from
  // the pre-move board can't flicker the preview back.
  rt.lastStateAt = Date.now();
  rt.data = { ...rt.data, match: fillerPreviewPick(m, color) };
  renderFillerPanel(rt.data);
  try {
    const data = await invokeFiller({ action: 'pick_color', matchId: m.id, color, moveNo: m.moveNo });
    fillerRuntime.data = data;
    renderFillerPanel(data);
    fillerSyncRealtime(data.match);
  } catch (err) {
    showToast('❌ ' + (err?.message || 'Nieprawidłowy ruch.'));
    loadFillerState(false); // the optimistic preview above is now wrong — resync
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
