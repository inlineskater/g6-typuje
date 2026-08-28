// ════════════════════════════════════════════════════════════════════════════
//  „Drabina Kariery G6" — Hi-Lo card ladder (tab module, lazy-loaded)
// ════════════════════════════════════════════════════════════════════════════
//  Scope rules (see CLAUDE.md „Lazy tab modules"): this file owns its top-level
//  names — index.html must NOT also declare them — and its function declarations
//  overwrite the no-op stubs index.html keeps for the teardown calls doLogout()
//  and switchTab() make unconditionally.
//
//  The client is a renderer. It never draws a card, never computes a payout and
//  never decides a win: every number on screen came from hilo-action.
// ════════════════════════════════════════════════════════════════════════════

let hiloState = null;
let hiloBusy = false;
let hiloBet = null;
let hiloFlash = null;      // { dir, card, won } for the reveal animation
let hiloFeed = [];

const HILO_RANK_NAMES = ['', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const HILO_SUITS = ['♠', '♥', '♦', '♣'];

function hiloCoins(n) { return Math.round(Number(n) || 0).toLocaleString('pl-PL'); }
function hiloMult(m) {
  const v = Number(m) || 0;
  return '×' + (v >= 100 ? v.toFixed(0) : v.toFixed(2)).replace('.', ',');
}

async function invokeHilo(action, body = {}) {
  const { data, error } = await sb.functions.invoke('hilo-action', { body: { action, ...body } });
  if (error) {
    // Edge Functions return the message in the response body on a 400, which
    // supabase-js hides behind a generic FunctionsHttpError — dig it out so the
    // player sees "Za mało monet" instead of "non-2xx status code".
    let msg = error.message || 'Błąd połączenia.';
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch (e) { /* keep msg */ }
    throw new Error(msg);
  }
  if (data && data.ok === false) throw new Error(data.error || 'Nie udało się.');
  return data;
}

function hiloCardEl(card, extraClass = '') {
  if (!card) return el('div', { className: 'hl-card empty ' + extraClass }, '?');
  const red = card.suit === 1 || card.suit === 2;
  return el('div', { className: 'hl-card ' + (red ? 'red ' : '') + extraClass },
    el('span', { className: 'hl-card-rank' }, HILO_RANK_NAMES[card.rank] || '?'),
    el('span', { className: 'hl-card-suit' }, HILO_SUITS[card.suit] || '♠'));
}

async function hiloAct(fn) {
  if (hiloBusy) return;
  hiloBusy = true;
  renderHilo();
  try { await fn(); }
  catch (e) { toast(String(e?.message || e)); }
  finally { hiloBusy = false; renderHilo(); }
}

function hiloStart() {
  const bet = Math.trunc(Number(hiloBet ?? hiloState?.defaultBet ?? 50));
  if (!(bet >= 1)) { toast('Podaj stawkę.'); return; }
  hiloAct(async () => {
    const res = await invokeHilo('start', { bet });
    hiloState = { ...hiloState, round: res.round, coins: res.coins };
    hiloFlash = null;
    refreshMeCoins();
  });
}

function hiloPick(direction) {
  hiloAct(async () => {
    const res = await invokeHilo('pick', { direction });
    hiloFlash = { dir: direction, card: res.card, won: res.result !== 'busted' };
    if (res.result === 'won') {
      hiloState = { ...hiloState, round: res.round, coins: res.coins };
    } else {
      hiloState = { ...hiloState, round: null, coins: res.coins };
      toast(res.result === 'busted'
        ? '💥 Zwolniony na ' + (res.streak + 1) + '. piętrze. Seria ' + res.streak + '.'
        : '🏔️ Sufit wypłaty! ' + hiloCoins(res.payout) + ' 🪙 przy serii ' + res.streak + '.');
      loadHiloFeed();
    }
    refreshMeCoins();
  });
}

function hiloSkip() {
  hiloAct(async () => {
    const res = await invokeHilo('skip');
    hiloFlash = null;
    if (res.round) hiloState = { ...hiloState, round: res.round };
    else { hiloState = { ...hiloState, round: null, coins: res.coins }; refreshMeCoins(); loadHiloFeed(); }
  });
}

function hiloCashOut() {
  hiloAct(async () => {
    const res = await invokeHilo('cash_out');
    hiloState = { ...hiloState, round: null, coins: res.coins };
    hiloFlash = null;
    toast('💰 Wypłacone ' + hiloCoins(res.payout) + ' 🪙 przy serii ' + res.streak + ' (' + hiloMult(res.multiplier) + ').');
    refreshMeCoins();
    loadHiloFeed();
  });
}

async function loadHiloFeed() {
  try {
    const { data } = await sb.from('hilo_recent').select('*').limit(12);
    hiloFeed = data || [];
  } catch (e) { hiloFeed = []; }
  renderHiloFeed();
}

async function loadHilo() {
  try {
    hiloState = await invokeHilo('state');
    if (hiloBet == null) hiloBet = hiloState.defaultBet;
  } catch (e) {
    hiloState = null;
    const host = document.getElementById('hilo-body');
    if (host) host.replaceChildren(el('div', { className: 'hl-empty' },
      'Nie udało się wczytać gry: ' + String(e?.message || e)));
    return;
  }
  renderHilo();
  loadHiloFeed();
}

function hiloBetRow() {
  const row = el('div', { className: 'hl-bet' });
  row.append(el('div', { className: 'hl-bet-label' }, 'Stawka'));
  const chips = el('div', { className: 'hl-chips' });
  (hiloState?.stakes || []).forEach(v => chips.append(el('button', {
    className: 'casino-chip' + (Number(hiloBet) === v ? ' active' : ''),
    onclick: () => { hiloBet = v; renderHilo(); },
  }, hiloCoins(v))));
  row.append(chips);
  const input = el('input', {
    className: 'hl-bet-input', type: 'number', min: '1', value: String(hiloBet ?? ''),
    oninput: e => { hiloBet = Math.trunc(Number(e.target.value) || 0); },
  });
  row.append(input);
  const start = el('button', { className: 'hl-btn is-primary', onclick: hiloStart }, 'Rozdaj kartę');
  start.disabled = hiloBusy;
  row.append(start);
  return row;
}

function hiloOptionBtn(dir, opt, label, arrow) {
  const b = el('button', { className: 'hl-opt ' + dir + (opt.sure ? ' sure' : ''), onclick: () => hiloPick(dir) },
    el('span', { className: 'hl-opt-arrow' }, arrow),
    el('span', { className: 'hl-opt-label' }, label),
    el('span', { className: 'hl-opt-odds' }, Math.round(opt.p * 100) + '% · ' + hiloMult(opt.step)),
    el('span', { className: 'hl-opt-next' }, 'pula → ' + hiloMult(opt.next)));
  b.disabled = hiloBusy;
  return b;
}

function renderHilo() {
  const host = document.getElementById('hilo-body');
  if (!host || !hiloState) return;
  const r = hiloState.round;
  host.replaceChildren();

  if (hiloState.casinoLuck) {
    host.append(el('div', { className: 'hl-luck' }, '🍀 Amulet Bezwstydnego Fartu jest aktywny — kasyno oddaje 98% zamiast 95%.'));
  }

  if (!r) {
    const idle = el('div', { className: 'hl-idle' });
    if (hiloFlash) idle.append(el('div', { className: 'hl-flash ' + (hiloFlash.won ? 'won' : 'lost') },
      hiloCardEl(hiloFlash.card, 'big'),
      el('div', {}, hiloFlash.won ? 'Sufit wypłaty osiągnięty.' : 'Ta karta zakończyła serię.')));
    idle.append(el('div', { className: 'hl-idle-title' }, 'Wybierz stawkę i wjedź windą.'));
    idle.append(hiloBetRow());
    host.append(idle);
    renderHiloRules(host);
    return;
  }

  // ── the ladder ────────────────────────────────────────────────────────────
  const stage = el('div', { className: 'hl-stage' });
  stage.append(el('div', { className: 'hl-meta' },
    el('div', {}, el('b', {}, String(r.streak)), el('span', {}, 'piętro')),
    el('div', {}, el('b', {}, hiloMult(r.multiplier)), el('span', {}, 'mnożnik')),
    el('div', { className: 'hl-pot' }, el('b', {}, hiloCoins(r.cashOut) + ' 🪙'), el('span', {}, 'w puli'))));

  const cardWrap = el('div', { className: 'hl-cardwrap' });
  if (hiloFlash?.card) cardWrap.append(hiloCardEl(hiloFlash.card, 'ghost'));
  cardWrap.append(hiloCardEl(r.card, 'big'));
  stage.append(cardWrap);

  stage.append(el('div', { className: 'hl-opts' },
    hiloOptionBtn('hi', r.options.hi, 'WYŻEJ lub tyle samo', '↑'),
    hiloOptionBtn('lo', r.options.lo, 'NIŻEJ lub tyle samo', '↓')));

  const actions = el('div', { className: 'hl-actions' });
  const cash = el('button', { className: 'hl-btn is-gold', onclick: hiloCashOut },
    'Wypłać ' + hiloCoins(r.cashOut) + ' 🪙');
  cash.disabled = hiloBusy || r.streak < 1;
  if (r.streak < 1) cash.title = 'Zagraj przynajmniej jedną kartę.';
  const skip = el('button', { className: 'hl-btn is-ghost', onclick: hiloSkip }, '⟳ Inna karta');
  skip.disabled = hiloBusy;
  actions.append(cash, skip);
  stage.append(actions);

  // The ladder so far — the thing people screenshot.
  if (r.history?.length) {
    const trail = el('div', { className: 'hl-trail' });
    r.history.slice(-14).forEach(h => trail.append(el('span', {
      className: 'hl-trail-step' + (h.won ? '' : ' lost'),
      title: (h.dir === 'hi' ? 'WYŻEJ' : 'NIŻEJ') + ' · ' + Math.round(h.p * 100) + '%',
    }, HILO_RANK_NAMES[h.to.rank])));
    stage.append(trail);
  }

  stage.append(el('div', { className: 'hl-cap' },
    'Sufit przy tej stawce: ' + hiloMult(r.maxMultiplier) + ' (maks. wypłata ' + hiloCoins(r.maxPayout) + ' 🪙).'));

  host.append(stage);
  renderHiloRules(host);
}

function renderHiloRules(host) {
  host.append(el('details', { className: 'hl-rules' },
    el('summary', {}, 'Zasady i szanse'),
    el('p', {}, 'Remis wygrywa OBIE strony — dlatego „wyżej lub tyle samo" i „niżej lub tyle samo". Procent na przycisku to prawdziwa szansa, a mnożnik to dokładnie jej odwrotność.'),
    el('p', {}, el('b', {}, 'Marża kasyna schodzi raz, przy wypłacie — nie co piętro.'), ' Dzięki temu zwrot to równe 95% niezależnie od tego, czy wysiadasz na 1. czy na 12. piętrze, i żadna strategia nie jest lepsza od innej. Zostaje sam wybór ryzyka.'),
    el('p', {}, '⟳ Inna karta losuje nową kartę bez zakładu — nic nie kosztuje i nic nie daje, jest po to, żeby przy dwójce albo asie nie zostać z ruchem ×1,00.')));
}

function renderHiloFeed() {
  const host = document.getElementById('hilo-feed');
  if (!host) return;
  host.replaceChildren(el('div', { className: 'hl-feed-title' }, '🔥 Ostatnie przejazdy'));
  if (!hiloFeed.length) { host.append(el('div', { className: 'hl-empty' }, 'Jeszcze nikt nie grał.')); return; }
  hiloFeed.forEach(f => host.append(el('div', { className: 'hl-feed-row' + (f.result === 'cashed' ? ' won' : '') },
    el('span', { className: 'hl-feed-nick' }, f.nick),
    el('span', { className: 'hl-feed-streak' }, 'p. ' + f.streak),
    el('span', { className: 'hl-feed-mult' }, hiloMult(f.multiplier)),
    el('b', {}, f.result === 'cashed' ? '+' + hiloCoins(f.total_won) : '−' + hiloCoins(f.bet)))));
}

// Teardown stub in index.html is overwritten by this.
function stopHiloTimer() { hiloFlash = null; hiloBusy = false; }
