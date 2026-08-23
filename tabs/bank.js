// Lazy-loaded tab module — see ensureTabModule() in index.html.
// Owns its own top-level const/let; reads shared globals (me, el, showToast,
// headerCoins, setText, fmtDateTime, plCount, withTabModule) from index.html,
// which always runs first. Its function declarations overwrite index.html's
// no-op stubs (stopBankTimer) that switchTab()/doLogout() call unconditionally.
'use strict';

// ── 🏦 Bank G6 ──────────────────────────────────────────────────────────────
// Presented as a bank statement, not as a page of feature cards: a KPI strip, a
// sub-tab bar, and dense tables with tabular figures. People are here to read
// numbers off a column and compare products, and a grid of rounded panels is a
// bad instrument for that.
//
// Every constant below mirrors supabase/bank.sql and exists ONLY to render a
// preview before you commit. The server is authoritative for anything that
// moves a coin; the client merely predicts. Keep them in sync.
const BANK_TERMS = [
  { days: 7,  bps: 250  },
  { days: 14, bps: 600  },
  { days: 30, bps: 1400 },
];
const BANK_LOKATA_MIN = 500;
const BANK_LOKATA_MAX = 15000;
const BANK_PIGGY_MAX = 3000;
const BANK_PIGGY_BPS = 30;        // per day, simple
const BANK_PIGGY_LOCK_DAYS = 7;
const BANK_PIGGY_MAX_DAYS = 90;   // accrual ceiling, mirrors bank_piggy_interest()
const BANK_SIGNET_PRICE = 15000;
const BANK_SIGNET_PCT = 2;

const BANK_SECTIONS = [
  { id: 'overview', label: 'Przegląd' },
  { id: 'lokata',   label: 'Lokaty' },
  { id: 'piggy',    label: 'Skarbonka' },
  { id: 'bonds',    label: 'Obligacje' },
  { id: 'shares',   label: 'Udziały w kasynie' },
  { id: 'market',   label: 'Rynek wtórny' },
  { id: 'rates',    label: 'Tabela oprocentowania' },
  { id: 'terms',    label: 'Regulamin' },
];

let bankState = null;
let bankSection = 'overview';
let bankTerm = 30;
let bankTimer = null;
let bankCountdowns = [];   // [{ node, until }] — refreshed by the 1s tick
let bankBusy = false;
let bankRefetching = false;

// ── formatting ──────────────────────────────────────────────────────────────
const bankFmt = n => Math.round(Number(n) || 0).toLocaleString('pl-PL');
const bankPct = bps => (Number(bps) / 100).toFixed(2).replace('.', ',') + '%';
const bankCoins = n => bankFmt(n) + ' 🪙';

// "23 dni 4 godz." / "18 min" — the granularity that matters at each scale,
// rather than one fixed unit that reads as either 0 or six digits.
function bankFmtLeft(untilMs) {
  if (!Number.isFinite(untilMs)) return '—';
  const ms = untilMs - Date.now();
  if (ms <= 0) return 'zapadło';
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins - days * 1440) / 60);
  if (days > 0) return `${days} ${plCount(days, 'dzień', 'dni', 'dni')}${hours ? ` ${hours} godz.` : ''}`;
  if (hours > 0) return `${hours} godz. ${mins - hours * 60} min`;
  return `${Math.max(1, mins)} min`;
}

function bankDate(ts) { return ts ? fmtDateTime(ts) : '—'; }

// Day only — table rows do not need a timestamp, and the extra width was
// pushing the action column off the right edge.
function bankDay(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pl-PL');
}

// ── lifecycle ───────────────────────────────────────────────────────────────

// Full teardown — switchTab()/doLogout() call this. It also drops the countdown
// registry, which is why startBankTimer() must NOT call it: render fills that
// registry and the timer starts right after, so clearing it on start would
// leave the ticker with nothing to update.
function stopBankTimer() {
  clearBankInterval();
  bankCountdowns = [];
}

function clearBankInterval() {
  if (bankTimer) { clearInterval(bankTimer); bankTimer = null; }
}

function startBankTimer() {
  clearBankInterval();
  bankTimer = setInterval(() => {
    let due = false;
    bankCountdowns.forEach(c => {
      const left = bankFmtLeft(c.until);
      if (c.node.textContent !== left) c.node.textContent = left;
      if (c.until <= Date.now()) due = true;
    });
    // Something just matured. The server settles lazily on read, so ask it —
    // but guard the call: the tick keeps firing while the round trip is in
    // flight, and unguarded that queues one bank_state() per second.
    if (due && !bankRefetching) {
      bankRefetching = true;
      loadBank().finally(() => { bankRefetching = false; });
    }
  }, 1000);
}

async function loadBank() {
  const body = document.getElementById('bank-body');
  if (!body) return;
  const { data, error } = await sb.rpc('bank_state');
  if (error) {
    body.replaceChildren(el('div', { className: 'bk-empty' },
      'Bank G6 jest niedostępny — wdróż supabase/bank.sql. (' + error.message + ')'));
    return;
  }
  bankState = data;
  if (typeof bankState?.coins === 'number' && me) {
    me.coins = bankState.coins;
    if (headerCoins) setText(headerCoins, me.coins);
  }
  renderBank();
  startBankTimer();
}

// Every mutation funnels through here: one busy flag (so a double-tap cannot
// open two deposits), one error translation, one reload.
async function bankCall(fn, args, okMsg, btn) {
  if (bankBusy) return null;
  bankBusy = true;
  if (btn) btn.disabled = true;
  const { data, error } = await sb.rpc(fn, args || {});
  bankBusy = false;
  if (error) {
    const key = Object.keys(BANK_ERRORS).find(k => (error.message || '').includes(k));
    showToast('❌ ' + (BANK_ERRORS[key] || error.message));
    if (btn) btn.disabled = false;
    return null;
  }
  if (typeof data?.coins_left === 'number' && me) {
    me.coins = data.coins_left;
    if (headerCoins) setText(headerCoins, me.coins);
  }
  if (okMsg) showToast(okMsg(data));
  await loadBank();
  return data;
}

const BANK_ERRORS = {
  insufficient_coins: 'Za mało coinów na rachunku.',
  over_cap:           'Przekroczony limit produktu.',
  amount_too_small:   `Kwota minimalna to ${bankCoins(BANK_LOKATA_MIN)}.`,
  bad_term:           'Nieprawidłowy okres.',
  bad_qty:            'Nieprawidłowa liczba sztuk.',
  sold_out:           'Emisja wyczerpana.',
  per_user_limit:     'Osiągnięto limit udziałów z emisji pierwotnej.',
  no_open_series:     'Brak otwartej emisji.',
  not_for_sale:       'Pozycja nie jest już wystawiona.',
  own_listing:        'To Twoja własna oferta.',
  bond_matured:       'Obligacja już zapadła — nie można jej nabyć.',
  deposit_not_found:  'Nie znaleziono depozytu.',
  holding_not_found:  'Nie znaleziono pozycji.',
  bad_price:          'Nieprawidłowa cena.',
};

// ── small builders ──────────────────────────────────────────────────────────

function bankSection_(title, lede) {
  const sec = el('div', { className: 'bk-sec' });
  if (title) sec.appendChild(el('h3', {}, title));
  if (lede) sec.appendChild(el('p', { className: 'bk-lede' }, lede));
  return sec;
}

// cols: [{ label, align }] · rows: [[cell, …]] where a cell is a string or Node.
function bankTable(cols, rows, footer) {
  const wrap = el('div', { className: 'bk-tw' });
  const table = el('table', { className: 'bk-t' });
  const thead = el('thead', {});
  const hr = el('tr', {});
  cols.forEach(c => hr.appendChild(el('th', { className: c.align || '' }, c.label)));
  thead.appendChild(hr);
  const tbody = el('tbody', {});
  rows.forEach(r => {
    const tr = el('tr', {});
    r.forEach((cell, i) => tr.appendChild(el('td', { className: cols[i]?.align || '' }, cell)));
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
  if (footer) {
    const tf = el('tfoot', {});
    const tr = el('tr', {});
    footer.forEach((cell, i) => tr.appendChild(el('td', { className: cols[i]?.align || '' }, cell)));
    tf.appendChild(tr);
    table.appendChild(tf);
  }
  wrap.appendChild(table);
  return wrap;
}

// A "Warunki produktu" strip — the definition block a bank puts above the form.
function bankTermsBlock(pairs) {
  const dl = el('dl', { className: 'bk-terms' });
  pairs.forEach(([label, value, sub]) => {
    const cell = el('div', { className: 'bk-term' });
    cell.appendChild(el('dt', {}, label));
    const dd = el('dd', {}, value);
    if (sub) dd.appendChild(el('small', {}, sub));
    cell.appendChild(dd);
    dl.appendChild(cell);
  });
  return dl;
}

function bankField(label, input) {
  const f = el('div', { className: 'bk-field' });
  f.appendChild(el('label', {}, label));
  f.appendChild(input);
  return f;
}

function bankCountdownCell(until) {
  const span = el('span', { className: 'bk-num' }, bankFmtLeft(until));
  bankCountdowns.push({ node: span, until });
  return span;
}

function bankFootnotes(items) {
  const ul = el('ul', { className: 'bk-foot' });
  items.forEach(t => ul.appendChild(el('li', {}, t)));
  return ul;
}

// ── portfolio arithmetic (display only; the server pays) ────────────────────

function bankPortfolio() {
  const deps = (bankState.deposits || []).filter(d => !d.closed_at);
  const holds = bankState.holdings || [];
  const lok = deps.filter(d => d.product === 'lokata');
  const pig = deps.filter(d => d.product === 'skarbonka');
  const bonds = holds.filter(h => h.kind === 'bond');
  const shares = holds.filter(h => h.kind === 'share');

  const sum = (a, f) => a.reduce((t, x) => t + Number(f(x) || 0), 0);
  const lokDay = sum(lok, d => Number(d.interest_if_held) / Math.max(1, Number(d.term_days)));
  const pigDay = sum(pig, d => Math.floor(Number(d.principal) * BANK_PIGGY_BPS / 10000));
  const bondDay = sum(bonds, h => h.coupon_per_day);
  const shareBps = sum(shares, h => h.share_bps);
  const shareDay = Math.floor(Number(bankState.shares?.house_net_avg || 0) * shareBps / 10000);

  return {
    lok, pig, bonds, shares,
    lokCap: sum(lok, d => d.principal), pigCap: sum(pig, d => d.principal),
    lokVal: sum(lok, d => d.mark), pigVal: sum(pig, d => d.mark),
    bondCap: sum(bonds, h => h.face_value),
    bondVal: sum(bonds, h => Number(h.face_value) + Number(h.accrued)),
    shareCap: sum(shares, h => h.purchase_price),
    lokDay: Math.round(lokDay), pigDay, bondDay, shareDay,
    get capital() { return this.lokCap + this.pigCap + this.bondCap + this.shareCap; },
    get value() { return this.lokVal + this.pigVal + this.bondVal + this.shareCap; },
    get perDay() { return this.lokDay + this.pigDay + this.bondDay + this.shareDay; },
    // Everything the Bank has actually credited in the window: coupons and
    // dividends, plus interest on deposits that have since been settled.
    paid30: (bankState.dividends || []).reduce((t, d) => t + Number(d.amount || 0), 0)
          + (bankState.deposits || []).filter(d => d.closed_at)
              .reduce((t, d) => t + Number(d.interest || 0), 0),
  };
}

// ── shell ───────────────────────────────────────────────────────────────────

function renderBank() {
  const body = document.getElementById('bank-body');
  if (!body || !bankState) return;
  bankCountdowns = [];

  const p = bankPortfolio();
  const root = el('div', { className: 'bk' });

  const head = el('div', { className: 'bk-head' });
  const top = el('div', { className: 'bk-head-top' });
  top.appendChild(el('h2', {}, '🏦 Bank G6 · rachunek inwestycyjny'));
  top.appendChild(el('div', { className: 'bk-head-meta' },
    `${me?.nick || ''} · stan na ${bankDate(new Date().toISOString())}`));
  head.appendChild(top);

  const kpis = el('div', { className: 'bk-kpis' });
  [
    ['Gotówka', bankCoins(me?.coins)],
    ['Kapitał ulokowany', bankCoins(p.capital)],
    ['Wartość bieżąca', bankCoins(p.value)],
    ['Dochód dzienny', bankCoins(p.perDay)],
    ['Wypłacono (30 dni)', bankCoins(p.paid30)],
  ].forEach(([l, v]) => {
    const k = el('div', { className: 'bk-kpi' });
    k.appendChild(el('span', {}, l));
    k.appendChild(el('b', {}, v));
    kpis.appendChild(k);
  });
  head.appendChild(kpis);
  root.appendChild(head);

  const tabs = el('div', { className: 'bk-tabs' });
  BANK_SECTIONS.forEach(sct => {
    const b = el('button', { className: 'bk-tab' + (sct.id === bankSection ? ' active' : '') }, sct.label);
    b.addEventListener('click', () => { bankSection = sct.id; renderBank(); });
    tabs.appendChild(b);
  });
  root.appendChild(tabs);

  const panel = el('div', { className: 'bk-body' });
  ({
    overview: bankOverview,
    lokata:   bankLokataSection,
    piggy:    bankPiggySection,
    bonds:    bankBondSection,
    shares:   bankShareSection,
    market:   bankMarketSection,
    rates:    bankRateSection,
    terms:    bankTermsSection,
  }[bankSection] || bankOverview)(panel, p);
  root.appendChild(panel);

  body.replaceChildren(root);
}

// ── Przegląd ────────────────────────────────────────────────────────────────

function bankOverview(panel, p) {
  const sec = bankSection_('Zestawienie portfela',
    'Wartość bieżąca to wycena pozycji z narosłymi odsetkami — tak samo liczy je ranking Net Worth. '
    + 'Nie jest to kwota do wypłaty na dziś: odsetki lokaty stają się wymagalne dopiero w terminie, '
    + 'a zerwanie wcześniej zwraca sam kapitał.');

  const nav = (id, label) => {
    const a = el('button', { className: 'bk-link' }, label);
    a.addEventListener('click', () => { bankSection = id; renderBank(); });
    return a;
  };

  const rows = [
    ['lokata', 'Lokata terminowa', p.lok.length, p.lokCap, p.lokDay, p.lokVal],
    ['piggy',  'Skarbonka',        p.pig.length, p.pigCap, p.pigDay, p.pigVal],
    ['bonds',  'Obligacje G6',     p.bonds.length, p.bondCap, p.bondDay, p.bondVal],
    ['shares', 'Udziały w kasynie', p.shares.length, p.shareCap, p.shareDay, p.shareCap],
  ].map(([id, name, n, cap, day, val]) => [
    nav(id, name),
    String(n),
    bankCoins(cap),
    n ? bankCoins(day) : '—',
    bankCoins(val),
  ]);

  sec.appendChild(bankTable(
    [{ label: 'Produkt' }, { label: 'Pozycje', align: 'c' }, { label: 'Kapitał', align: 'r' },
     { label: 'Dochód / dzień', align: 'r' }, { label: 'Wartość bieżąca', align: 'r' }],
    rows,
    ['Razem', String(p.lok.length + p.pig.length + p.bonds.length + p.shares.length),
     bankCoins(p.capital), bankCoins(p.perDay), bankCoins(p.value)]
  ));
  sec.appendChild(bankFootnotes([
    'Dochód z udziałów w kasynie jest szacunkiem opartym o średnią z 7 dni — w tygodniu bez gry wynosi 0.',
    'Wartość pozycji wchodzi do rankingu Net Worth na równi z gotówką.',
  ]));
  panel.appendChild(sec);

  // Coupons/dividends and settled deposits are one ledger from the player's
  // point of view; bank_state already returns recently closed deposits, and
  // leaving them out meant lokata interest appeared in no history at all.
  const hist = bankSection_('Historia rozliczeń (30 dni)');
  const ops = [
    ...(bankState.dividends || []).map(d => ({
      day: bankDay(d.pay_date),
      sortKey: d.pay_date,
      title: d.kind === 'share' ? 'Dywidenda — udziały w kasynie' : 'Kupon — obligacje',
      amount: Number(d.amount || 0),
      note: '',
    })),
    ...(bankState.deposits || []).filter(d => d.closed_at).map(d => ({
      day: bankDay(d.closed_at),
      title: d.product === 'lokata'
        ? `Lokata ${d.term_days} dni — rozliczenie`
        : 'Skarbonka — wypłata',
      amount: Number(d.interest || 0),
      note: d.broke_early
        ? `zamknięta przed terminem · zwrot kapitału ${bankFmt(d.principal)}`
        : `wypłacono ${bankFmt(d.payout)} (kapitał ${bankFmt(d.principal)})`,
      sortKey: d.closed_at,
    })),
  ].sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey)));

  const total = ops.reduce((t, o) => t + o.amount, 0);
  if (!ops.length) {
    hist.appendChild(el('div', { className: 'bk-tw' },
      el('div', { className: 'bk-empty' }, 'Brak rozliczeń w ostatnich 30 dniach.')));
  } else {
    hist.appendChild(bankTable(
      [{ label: 'Data' }, { label: 'Tytuł' }, { label: 'Odsetki', align: 'r' }],
      ops.slice(0, 25).map(o => {
        const title = el('span', {}, o.title);
        if (o.note) title.appendChild(el('small', {}, o.note));
        return [
          el('span', { className: 'bk-num' }, o.day),
          title,
          o.amount > 0 ? el('span', { className: 'bk-pos' }, '+' + bankCoins(o.amount)) : '—',
        ];
      }),
      ['', 'Razem', el('span', { className: 'bk-pos' }, '+' + bankCoins(total))]
    ));
  }
  panel.appendChild(hist);

  panel.appendChild(bankSignetSection());
}

// ── Lokata ──────────────────────────────────────────────────────────────────

function bankLokataSection(panel, p) {
  const cap = Number(bankState.caps?.lokata_max) || BANK_LOKATA_MAX;
  const free = Math.max(0, cap - Number(bankState.caps?.lokata_open || 0));
  const term = BANK_TERMS.find(t => t.days === bankTerm) || BANK_TERMS[2];

  const sec = bankSection_('Lokata terminowa',
    'Kapitał zostaje zablokowany na sztywny okres, a Bank z góry deklaruje kwotę wypłaty. '
    + 'Środki na lokacie nie są dostępne: nie obstawisz nimi, nie kupisz skrzynki i nie liczą się '
    + 'do podstawy odsetkowej Sygnetu Bankiera. To jest cena tego oprocentowania.');

  sec.appendChild(bankTermsBlock([
    ['Oprocentowanie', bankPct(term.bps), `łącznie za ${term.days} dni`],
    ['Kwota minimalna', bankCoins(BANK_LOKATA_MIN)],
    ['Limit łączny', bankCoins(cap), `wolne: ${bankCoins(free)}`],
    ['Zerwanie', 'Zwrot kapitału', 'odsetki przepadają w całości'],
  ]));

  const form = el('div', { className: 'bk-form' });
  const sel = el('select', {});
  BANK_TERMS.forEach(t => {
    const o = el('option', { value: String(t.days) }, `${t.days} dni — ${bankPct(t.bps)}`);
    if (t.days === bankTerm) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => { bankTerm = Number(sel.value); renderBank(); });

  const amount = el('input', { type: 'number', min: String(BANK_LOKATA_MIN), step: '100', placeholder: '0' });
  const quote = el('div', { className: 'bk-quote' });
  const refresh = () => {
    const a = Math.floor(Number(amount.value) || 0);
    if (!a) { quote.textContent = `Podaj kwotę od ${bankCoins(BANK_LOKATA_MIN)} do ${bankCoins(free)}.`; return; }
    const i = Math.floor(a * term.bps / 10000);
    quote.replaceChildren();
    quote.append('Wypłata w terminie: ');
    quote.appendChild(el('b', {}, bankCoins(a + i)));
    quote.append(` — w tym ${bankCoins(i)} odsetek (${(term.bps / 100 / term.days).toFixed(3).replace('.', ',')}% dziennie).`);
  };
  amount.addEventListener('input', refresh);
  refresh();

  const maxBtn = el('button', { className: 'btn-ghost bk-btn' }, 'Maks.');
  maxBtn.addEventListener('click', () => {
    amount.value = String(Math.min(free, Math.floor(Number(me?.coins) || 0)));
    refresh();
  });
  const go = el('button', { className: 'btn-primary bk-btn' }, 'Załóż lokatę');
  go.addEventListener('click', () => bankCall('bank_open_deposit',
    { p_product: 'lokata', p_amount: Math.floor(Number(amount.value) || 0), p_term_days: bankTerm },
    d => `Lokata założona. Wypłata ${bankDate(d.matures_at)}.`, go));

  form.append(bankField('Okres', sel), bankField('Kwota', amount), maxBtn, go, quote);
  sec.appendChild(form);
  sec.appendChild(bankDepositTable('lokata'));
  panel.appendChild(sec);
}

function bankPiggySection(panel) {
  const cap = Number(bankState.caps?.piggy_max) || BANK_PIGGY_MAX;
  const free = Math.max(0, cap - Number(bankState.caps?.piggy_open || 0));
  const sec = bankSection_('Skarbonka',
    'Depozyt bez terminu — wypłacasz kiedy chcesz. Odsetki naliczają się prosto (bez kapitalizacji) '
    + `za każdy pełny dzień, ale są wymagalne dopiero po ${BANK_PIGGY_LOCK_DAYS} dniach: rozbicie wcześniej `
    + 'zwraca sam kapitał. Produkt startowy — limit jest celowo niski.');

  sec.appendChild(bankTermsBlock([
    ['Oprocentowanie', bankPct(BANK_PIGGY_BPS), 'dziennie, proste'],
    ['Okres karencji', `${BANK_PIGGY_LOCK_DAYS} dni`, 'wcześniej: bez odsetek'],
    ['Limit łączny', bankCoins(cap), `wolne: ${bankCoins(free)}`],
    ['Naliczanie', `maks. ${BANK_PIGGY_MAX_DAYS} dni`, 'potem odsetki nie rosną'],
  ]));

  const form = el('div', { className: 'bk-form' });
  const amount = el('input', { type: 'number', min: String(BANK_LOKATA_MIN), step: '100', placeholder: '0' });
  const quote = el('div', { className: 'bk-quote' });
  const refresh = () => {
    const a = Math.floor(Number(amount.value) || 0);
    const perDay = Math.floor(a * BANK_PIGGY_BPS / 10000);
    if (!a) { quote.textContent = `Podaj kwotę od ${bankCoins(BANK_LOKATA_MIN)} do ${bankCoins(free)}.`; return; }
    quote.replaceChildren();
    quote.append('Po karencji: ');
    quote.appendChild(el('b', {}, bankCoins(perDay) + ' dziennie'));
    quote.append(` — do ${bankCoins(perDay * BANK_PIGGY_MAX_DAYS)} przez ${BANK_PIGGY_MAX_DAYS} dni.`);
  };
  amount.addEventListener('input', refresh);
  refresh();

  const maxBtn = el('button', { className: 'btn-ghost bk-btn' }, 'Maks.');
  maxBtn.addEventListener('click', () => {
    amount.value = String(Math.min(free, Math.floor(Number(me?.coins) || 0)));
    refresh();
  });
  const go = el('button', { className: 'btn-primary bk-btn' }, 'Wpłać');
  go.addEventListener('click', () => bankCall('bank_open_deposit',
    { p_product: 'skarbonka', p_amount: Math.floor(Number(amount.value) || 0) },
    () => 'Wpłacono do skarbonki.', go));

  form.append(bankField('Kwota', amount), maxBtn, go, quote);
  sec.appendChild(form);
  sec.appendChild(bankDepositTable('skarbonka'));
  panel.appendChild(sec);
}

function bankDepositTable(product) {
  const rows = (bankState.deposits || []).filter(d => d.product === product && !d.closed_at);
  if (!rows.length) {
    return el('div', { className: 'bk-tw' }, el('div', { className: 'bk-empty' },
      product === 'lokata' ? 'Brak otwartych lokat.' : 'Skarbonka jest pusta.'));
  }
  const isLokata = product === 'lokata';
  return bankTable(
    [{ label: 'Otwarta' }, { label: isLokata ? 'Okres' : 'Karencja', align: 'c' },
     { label: 'Oprocent.', align: 'r' }, { label: 'Kapitał', align: 'r' },
     { label: isLokata ? 'Wypłata' : 'Odsetki', align: 'r' },
     { label: isLokata ? 'Do wykupu' : 'Status' }, { label: '', align: 'r' }],
    rows.map(d => {
      const until = Date.parse(d.matures_at);
      const ready = until <= Date.now();
      const btn = el('button', { className: 'btn-ghost bk-btn' },
        ready ? 'Wypłać' : (isLokata ? 'Zerwij' : 'Rozbij'));
      btn.addEventListener('click', () => {
        if (!ready && !confirm(isLokata
          ? `Zerwanie lokaty przed terminem: odsetki (${bankCoins(d.interest_if_held)}) przepadają w całości, `
            + `otrzymasz ${bankCoins(d.principal)}. Kontynuować?`
          : `Skarbonka nie osiągnęła ${BANK_PIGGY_LOCK_DAYS} dni — odsetki przepadną. Rozbić?`)) return;
        bankCall('bank_close_deposit', { p_id: d.id },
          r => r.interest > 0
            ? `Wypłacono ${bankCoins(r.principal + r.interest)}, w tym ${bankCoins(r.interest)} odsetek.`
            : `Zwrócono ${bankCoins(r.principal)} — bez odsetek.`, btn);
      });
      return [
        el('span', { className: 'bk-num' }, bankDay(d.opened_at)),
        isLokata ? `${d.term_days} dni` : `${BANK_PIGGY_LOCK_DAYS} dni`,
        bankPct(d.rate_bps) + (isLokata ? '' : ' / dz.'),
        bankCoins(d.principal),
        isLokata ? bankCoins(Number(d.principal) + Number(d.interest_if_held))
                 : el('span', { className: ready ? 'bk-pos' : '' }, bankCoins(d.interest_if_held)),
        ready ? el('span', { className: 'bk-tag ok' }, isLokata ? 'zapadła' : 'wymagalne')
              : bankCountdownCell(until),
        btn,
      ];
    })
  );
}

// ── Obligacje ───────────────────────────────────────────────────────────────

function bankBondSection(panel, p) {
  const ser = bankState.series;
  const sec = bankSection_('Obligacje G6',
    'Papier o stałym kuponie: Bank wypłaca ustaloną kwotę każdego dnia, a w dniu wykupu zwraca nominał. '
    + 'W odróżnieniu od lokaty obligacja jest zbywalna — możesz ją odsprzedać innemu graczowi przed terminem, '
    + 'a im mniej dni zostało, tym mniej jest warta.');

  if (ser) {
    const total = Number(ser.coupon_per_day) * Number(ser.term_days);
    sec.appendChild(bankTermsBlock([
      ['Emisja', ser.code, `zapisy do ${bankDate(ser.closes_at)}`],
      ['Cena / nominał', bankCoins(ser.price), `wykup po ${ser.term_days} dniach`],
      ['Kupon', bankCoins(ser.coupon_per_day), 'dziennie, wypłacany na bieżąco'],
      ['Rentowność', `+${bankCoins(total)}`, `${(total / ser.face_value * 100).toFixed(0)}% w ${ser.term_days} dni`],
    ]));

    const bar = el('div', { className: 'bk-bar' });
    bar.appendChild(el('i', { style: { width: (ser.sold / ser.edition_size * 100) + '%' } }));
    sec.appendChild(bar);
    sec.appendChild(el('p', { className: 'bk-note' },
      `Objęto ${ser.sold} z ${ser.edition_size} sztuk emisji.`));

    const form = el('div', { className: 'bk-form' });
    const qty = el('input', { type: 'number', min: '1', max: '10', value: '1' });
    const quote = el('div', { className: 'bk-quote' });
    const refresh = () => {
      const n = Math.max(1, Math.min(10, Math.floor(Number(qty.value) || 1)));
      quote.replaceChildren();
      quote.append('Koszt objęcia: ');
      quote.appendChild(el('b', {}, bankCoins(n * ser.price)));
      quote.append(` — kupon ${bankCoins(n * ser.coupon_per_day)} dziennie, wykup ${bankCoins(n * ser.face_value)}.`);
    };
    qty.addEventListener('input', refresh);
    refresh();
    const go = el('button', { className: 'btn-primary bk-btn' }, 'Obejmij');
    go.addEventListener('click', () => bankCall('bank_buy_bond',
      { p_qty: Math.max(1, Math.min(10, Math.floor(Number(qty.value) || 1))) },
      d => `Objęto ${d.qty} × ${ser.code}.`, go));
    form.append(bankField('Liczba sztuk', qty), go, quote);
    sec.appendChild(form);
  } else {
    sec.appendChild(el('div', { className: 'bk-tw' },
      el('div', { className: 'bk-empty' }, 'Bieżąca emisja jest wyczerpana. Kolejna otwiera się w przyszłym tygodniu.')));
  }

  sec.appendChild(bankHoldingTable('bond', p));
  panel.appendChild(sec);
}

// ── Udziały ─────────────────────────────────────────────────────────────────

function bankShareSection(panel, p) {
  const sh = bankState.shares || {};
  const left = Math.max(0, Number(sh.supply || 0) - Number(sh.sold || 0));
  const perShare = Math.floor(Number(sh.house_net_avg || 0) * Number(sh.share_bps || 0) / 10000);

  const sec = bankSection_('Udziały w kasynie',
    'Udział w wyniku kasyna. Każdego dnia posiadacz otrzymuje ustalony procent tego, co kasyno faktycznie '
    + 'zarobiło na graczach — liczony jako średnia z ostatnich 7 dni, bo obroty są nierówne i pojedynczy dzień '
    + 'nie jest miarodajny. Jako jedyny produkt Banku nie tworzy nowych monet: rozdziela te, które gracze '
    + 'już przegrali. Jako jedyny może też zapłacić zero.');

  sec.appendChild(bankTermsBlock([
    ['Cena emisyjna', bankCoins(sh.price)],
    ['Udział w wyniku', bankPct(sh.share_bps), 'dziennie, z wyniku kasyna'],
    ['Wielkość emisji', `${sh.sold || 0} / ${sh.supply || 0}`, `limit ${sh.max_per_user} szt. na osobę`],
    ['Termin', 'Bezterminowy', 'zbywalny na rynku wtórnym'],
  ]));

  sec.appendChild(bankTable(
    [{ label: 'Wskaźnik' }, { label: 'Wartość', align: 'r' }, { label: 'Uwagi' }],
    [
      ['Wynik kasyna, średnia 7 dni', bankCoins(sh.house_net_avg), 'podstawa najbliższej wypłaty'],
      ['Wynik kasyna, średnia 30 dni', bankCoins(sh.house_net_avg_30), 'dłuższy horyzont'],
      ['Dywidenda na udział', bankCoins(perShare), 'dziennie, szacunek'],
      ['Okres zwrotu', perShare > 0 ? `${Math.ceil(Number(sh.price) / perShare)} dni` : 'nieokreślony',
        perShare > 0 ? 'przy utrzymaniu obecnych obrotów' : 'kasyno nie generuje obecnie wyniku'],
    ]
  ));
  sec.appendChild(bankFootnotes([
    'Dane historyczne. Wypłata zależy wyłącznie od faktycznych obrotów kasyna i w tygodniu bez gry wynosi zero.',
    'Dni, w których gracze wygrali z kasynem, liczone są jako zero — strata nie przechodzi na kolejny dzień.',
    'Gra admina nie wchodzi do podstawy. Poker jest wyłączony: to gra między graczami, nie przeciw kasynu.',
  ]));

  if (left > 0) {
    const form = el('div', { className: 'bk-form' });
    const qty = el('input', { type: 'number', min: '1', max: String(sh.max_per_user), value: '1' });
    const quote = el('div', { className: 'bk-quote' },
      `Posiadasz ${sh.mine_treasury || 0} z ${sh.max_per_user} szt. dostępnych w emisji pierwotnej. Pozostało ${left} szt.`);
    const go = el('button', { className: 'btn-primary bk-btn' }, 'Obejmij');
    go.addEventListener('click', () => bankCall('bank_buy_share',
      { p_qty: Math.max(1, Math.floor(Number(qty.value) || 1)) },
      d => `Objęto ${d.qty} ${plCount(d.qty, 'udział', 'udziały', 'udziałów')}.`, go));
    form.append(bankField('Liczba sztuk', qty), go, quote);
    sec.appendChild(form);
  } else {
    sec.appendChild(el('p', { className: 'bk-note' },
      'Emisja pierwotna została w całości objęta. Udziały dostępne są wyłącznie na rynku wtórnym.'));
  }

  sec.appendChild(bankHoldingTable('share', p));
  panel.appendChild(sec);
}

function bankHoldingTable(kind, p) {
  const rows = (bankState.holdings || []).filter(h => h.kind === kind);
  if (!rows.length) {
    return el('div', { className: 'bk-tw' }, el('div', { className: 'bk-empty' },
      kind === 'bond' ? 'Brak obligacji w portfelu.' : 'Brak udziałów w portfelu.'));
  }
  const isBond = kind === 'bond';
  const cols = isBond
    ? [{ label: 'Emisja' }, { label: 'Nominał', align: 'r' }, { label: 'Kupon', align: 'r' },
       { label: 'Naliczone', align: 'r' }, { label: 'Do wykupu' }, { label: 'Status' }, { label: '', align: 'r' }]
    : [{ label: 'Udział' }, { label: 'Cena nabycia', align: 'r' }, { label: 'Udział w wyniku', align: 'r' },
       { label: 'Wypłacono', align: 'r' }, { label: 'Nabyty' }, { label: 'Status' }, { label: '', align: 'r' }];

  return bankTable(cols, rows.map(h => {
    const action = h.ask_price
      ? (() => { const b = el('button', { className: 'btn-ghost bk-btn' }, 'Wycofaj');
                 b.addEventListener('click', () => bankCall('bank_unlist_holding', { p_id: h.id },
                   () => 'Wycofano z rynku wtórnego.', b)); return b; })()
      : (() => { const b = el('button', { className: 'btn-ghost bk-btn' }, 'Wystaw');
                 b.addEventListener('click', () => bankListPrompt(h, b)); return b; })();
    const status = h.ask_price
      ? el('span', { className: 'bk-tag' }, 'wystawiony ' + bankCoins(h.ask_price))
      : el('span', { className: 'bk-tag ok' }, 'w portfelu');

    return isBond
      ? [h.series_code || '—', bankCoins(h.face_value), bankCoins(h.coupon_per_day) + ' / dz.',
         el('span', { className: Number(h.accrued) ? 'bk-pos' : '' }, bankCoins(h.accrued)),
         bankCountdownCell(Date.parse(h.matures_at)), status, action]
      : [`#${h.serial_no}`, bankCoins(h.purchase_price), bankPct(h.share_bps),
         el('span', { className: 'bk-pos' }, bankCoins(h.earned)),
         el('span', { className: 'bk-num' }, bankDay(h.created_at)), status, action];
  }));
}

function bankListPrompt(h, btn) {
  const fair = h.kind === 'bond' ? Number(h.face_value) + Number(h.accrued) : Number(h.purchase_price);
  const raw = prompt(
    'Cena wystawienia w 🪙 (sprzedaż natychmiastowa, pierwszy chętny nabywa).\n'
    + `Wartość odniesienia: ${bankFmt(fair)} 🪙`
    + (h.kind === 'bond' ? ' (nominał + kupon naliczony).' : ' (cena nabycia).'),
    String(fair));
  if (raw === null) return;
  const price = Math.floor(Number(raw) || 0);
  if (price < 1) { showToast('❌ Nieprawidłowa cena.'); return; }
  bankCall('bank_list_holding', { p_id: h.id, p_price: price },
    () => `Wystawiono za ${bankCoins(price)}.`, btn);
}

// ── Rynek wtórny ────────────────────────────────────────────────────────────

function bankMarketSection(panel) {
  const rows = bankState.market || [];
  const sec = bankSection_('Rynek wtórny',
    'Obligacje i udziały wystawione przez innych graczy. Transakcja jest natychmiastowa, a cała kwota '
    + 'trafia do sprzedającego — Bank nie pobiera prowizji i nic tu nie tworzy ani nie umarza. '
    + 'Obligacja, której termin wykupu już minął, nie jest zbywalna.');

  if (!rows.length) {
    sec.appendChild(el('div', { className: 'bk-tw' }, el('div', { className: 'bk-empty' }, 'Brak ofert.')));
    panel.appendChild(sec);
    return;
  }

  sec.appendChild(bankTable(
    [{ label: 'Instrument' }, { label: 'Sprzedający' }, { label: 'Dochód', align: 'r' },
     { label: 'Wartość odniesienia', align: 'r' }, { label: 'Do wykupu' },
     { label: 'Cena', align: 'r' }, { label: '', align: 'r' }],
    rows.map(h => {
      const isBond = h.kind === 'bond';
      const fair = isBond ? Number(h.face_value) + Number(h.accrued) : null;
      const price = Number(h.ask_price);
      const spread = fair ? Math.round((price / fair - 1) * 100) : null;
      let action;
      if (h.mine) {
        action = el('span', { className: 'bk-tag' }, 'Twoja oferta');
      } else {
        const b = el('button', { className: 'btn-primary bk-btn' }, 'Kup');
        b.disabled = (Number(me?.coins) || 0) < price;
        if (b.disabled) b.title = 'Za mało coinów';
        b.addEventListener('click', () => bankCall('bank_buy_holding', { p_id: h.id },
          r => `Nabyto za ${bankCoins(r.price)}.`, b));
        action = b;
      }
      const priceCell = el('span', { className: 'bk-num' }, bankCoins(price));
      const wrap = el('span', {});
      wrap.appendChild(priceCell);
      if (spread !== null) {
        wrap.appendChild(el('small', { className: spread > 0 ? 'bk-neg' : 'bk-pos' },
          (spread > 0 ? '+' : '') + spread + '% do wartości'));
      }
      return [
        isBond ? `📜 Obligacja ${bankFmt(h.face_value)}` : `🎰 Udział #${h.serial_no}`,
        h.owner_nick,
        isBond ? bankCoins(h.coupon_per_day) + ' / dz.' : bankPct(h.share_bps) + ' wyniku',
        fair ? bankCoins(fair) : '—',
        isBond ? bankCountdownCell(Date.parse(h.matures_at)) : 'bezterminowy',
        wrap,
        action,
      ];
    })
  ));
  panel.appendChild(sec);
}

// ── Tabela oprocentowania ───────────────────────────────────────────────────

function bankRateSection(panel) {
  const sh = bankState.shares || {};
  const ser = bankState.series;
  const sec = bankSection_('Tabela oprocentowania',
    'Obowiązuje dla nowych dyspozycji. Oprocentowanie już otwartej lokaty i kupon objętej obligacji '
    + 'są zapisywane w chwili zawarcia i nie zmieniają się wraz z tabelą.');

  const rows = [
    ['Skarbonka', 'bezterminowo', bankPct(BANK_PIGGY_BPS) + ' / dz.',
      bankPct(BANK_PIGGY_BPS * 30) + ' / 30 dni',
      bankCoins(bankState.caps?.piggy_max || BANK_PIGGY_MAX), 'zwrot kapitału'],
    ...BANK_TERMS.map(t => [
      'Lokata terminowa', `${t.days} dni`,
      (t.bps / 100 / t.days).toFixed(2).replace('.', ',') + '% / dz.',
      bankPct(t.bps) + ` / ${t.days} dni`,
      bankCoins(bankState.caps?.lokata_max || BANK_LOKATA_MAX), 'zwrot kapitału']),
    ['Obligacja G6', ser ? `${ser.term_days} dni` : '20 dni',
      ser ? (ser.coupon_per_day / ser.face_value * 100).toFixed(2).replace('.', ',') + '% / dz.' : '—',
      ser ? bankPct(ser.coupon_per_day * ser.term_days / ser.face_value * 10000) + ` / ${ser.term_days} dni` : '—',
      ser ? bankCoins(ser.edition_size * ser.price) + ' emisji' : '—', 'zbywalna'],
    ['Udział w kasynie', 'bezterminowo', 'zmienne', bankPct(sh.share_bps) + ' wyniku kasyna',
      `${sh.supply || 0} szt.`, 'zbywalny'],
    ['💍 Sygnet Bankiera', 'bezterminowo', bankPct(BANK_SIGNET_PCT * 100) + ' / dz.',
      'bez limitu', 'bez limitu', 'niezbywalny'],
  ];

  sec.appendChild(bankTable(
    [{ label: 'Produkt' }, { label: 'Okres' }, { label: 'Stopa dzienna', align: 'r' },
     { label: 'Stopa za okres', align: 'r' }, { label: 'Limit', align: 'r' }, { label: 'Wcześniejsze zamknięcie' }],
    rows
  ));
  sec.appendChild(bankFootnotes([
    'Odsetki lokaty i skarbonki są proste — nie podlegają kapitalizacji.',
    'Sygnet Bankiera nalicza od salda GOTÓWKI, więc jako jedyny produkt się kapitalizuje. Środki na lokacie nie wchodzą do podstawy.',
    'Stopa udziału w kasynie jest zmienna i może wynieść zero. Nie jest gwarantowana.',
    'Limity łączne dotyczą sumy otwartych pozycji jednego gracza; zamknięcie pozycji zwalnia limit.',
  ]));
  panel.appendChild(sec);
  panel.appendChild(bankSignetSection());
}

// ── Sygnet Bankiera ─────────────────────────────────────────────────────────
// The item lives in the Sklep (it is a hero_item_defs row like any other
// special item); this is a signpost with the arithmetic, not a second buy path.
function bankSignetSection() {
  const sig = bankState.signet || {};
  const cash = Math.floor(Number(me?.coins) || 0);
  const perDay = Math.floor(cash * BANK_SIGNET_PCT / 100);
  const sec = bankSection_('💍 Sygnet Bankiera',
    `Ten sam instrument, który posiada legendarny Pierścień Bankiera, na tych samych warunkach: `
    + `${BANK_SIGNET_PCT}% dziennie od całego salda gotówki, bez limitu kwoty i bez górnej granicy wypłaty. `
    + 'Nalicza wyłącznie od gotówki — monety zamrożone w lokacie, wydane na skrzynki albo stojące '
    + 'w pozycji rynkowej nie pracują.');

  sec.appendChild(bankTermsBlock([
    ['Cena', bankCoins(BANK_SIGNET_PRICE), 'jednorazowo, bezzwrotnie'],
    ['Oprocentowanie', BANK_SIGNET_PCT + ',00% / dz.', 'od całego salda gotówki'],
    ['Twoja wypłata dziś', bankCoins(perDay), `przy saldzie ${bankCoins(cash)}`],
    ['Okres zwrotu', perDay > 0 ? `${Math.ceil(BANK_SIGNET_PRICE / perDay)} dni` : '—',
      'przy niezmienionym saldzie'],
  ]));

  sec.appendChild(el('p', { className: 'bk-lede' },
    'Ponieważ stopa liczy się od salda, a saldo rośnie o wypłacone odsetki, jest to jedyny produkt '
    + 'w Banku, który się kapitalizuje — i jedyny, w którym większe saldo zwraca zakup szybciej. '
    + 'Poniżej okres zwrotu przy różnych saldach.'));

  const tiers = [5000, 10000, 25000, 50000, 100000];
  const yourTier = tiers.filter(b => b <= cash).pop();
  sec.appendChild(bankTable(
    [{ label: 'Saldo gotówki', align: 'r' }, { label: 'Wypłata dzienna', align: 'r' },
     { label: 'Okres zwrotu', align: 'r' }, { label: 'Uwagi' }],
    tiers.map(b => [
      bankCoins(b), bankCoins(Math.floor(b * BANK_SIGNET_PCT / 100)),
      `${Math.ceil(BANK_SIGNET_PRICE / Math.floor(b * BANK_SIGNET_PCT / 100))} dni`,
      b === yourTier ? el('span', { className: 'bk-tag ok' }, 'Twój przedział') : '',
    ])
  ));

  if (sig.owned) {
    sec.appendChild(el('p', { className: 'bk-note' },
      `Posiadasz Sygnet. Łącznie wypłacono Ci ${bankCoins(sig.paid_total)} odsetek.`));
  } else if (sig.better) {
    sec.appendChild(el('div', { className: 'bk-note-warn' },
      `Posiadasz już „${sig.better}" — instrument, który płaci Ci co najmniej tyle samo. `
      + 'Naliczany jest wyłącznie najlepszy posiadany przedmiot odsetkowy, więc zakup Sygnetu '
      + `nie zwiększyłby wypłaty ani o monetę. Dotychczas wypłacono Ci ${bankCoins(sig.paid_total)}.`));
  } else {
    const go = el('button', { className: 'btn-primary bk-btn' }, 'Przejdź do Sklepu →');
    go.addEventListener('click', () => withTabModule('shop', () => openHeroItemInShop('banker_signet')));
    sec.appendChild(go);
    sec.appendChild(el('p', { className: 'bk-note' },
      'Naliczany jest wyłącznie najlepszy posiadany przedmiot odsetkowy — dwa nie sumują się.'));
  }
  return sec;
}

// ── Regulamin ───────────────────────────────────────────────────────────────

function bankTermsSection(panel) {
  const sec = bankSection_('Zasady ogólne');
  [
    ['Naliczanie i wypłata',
      'Kupony obligacji i dywidendy z udziałów naliczane są za pełne dni kalendarzowe (strefa Europe/Warsaw) '
      + 'i wypłacane automatycznie. Rozliczenie uruchamia się przy każdym wejściu na tę zakładkę oraz co godzinę '
      + 'niezależnie od tego, czy ktokolwiek jest zalogowany. Opóźnienie rozliczenia nie powoduje utraty wypłaty: '
      + 'przy wykupie obligacji Bank dopłaca wszystkie nierozliczone kupony.'],
    ['Dzień nabycia',
      'Instrument nabyty dzisiaj uczestniczy w wypłatach od następnego dnia. Dotyczy to również zakupu na rynku wtórnym.'],
    ['Wcześniejsze zamknięcie',
      'Zerwanie lokaty i rozbicie skarbonki przed karencją zwraca kapitał w całości i nie pobiera opłat — '
      + 'przepadają wyłącznie odsetki. W żadnym produkcie Banku nie można wyjść z kwotą niższą niż wpłacona.'],
    ['Limity',
      'Limity dotyczą sumy otwartych pozycji jednego gracza i zwalniają się po zamknięciu pozycji. '
      + 'Ich zadaniem jest utrzymanie w ryzach inflacji monet: odsetki lokaty, skarbonki i kupony obligacji '
      + 'są nowymi monetami, których wcześniej w grze nie było.'],
    ['Skąd Bank bierze pieniądze',
      'Udział w kasynie jest jedynym produktem finansowanym w całości z istniejących monet — wypłaca część tego, '
      + 'co gracze realnie przegrali w Slotach, Ruletce, Plinko, Minach, Rakiecie i Kole Żubra. '
      + 'Pozostałe produkty tworzą nowe monety, dlatego mają twarde limity, a udział w kasynie ich nie potrzebuje.'],
    ['Rynek wtórny',
      'Bank nie jest stroną transakcji na rynku wtórnym i nie pobiera prowizji — cała kwota przechodzi '
      + 'od kupującego do sprzedającego. Cena jest wyłącznie sprawą stron; wartość odniesienia w tabeli '
      + 'jest podpowiedzią, nie wyceną Banku.'],
    ['Wpływ na ranking',
      'Kapitał i wartość pozycji w Banku wliczają się do Net Worth w Statystykach na równi z gotówką, '
      + 'więc ulokowanie monet nie obniża pozycji w rankingu.'],
  ].forEach(([h, body]) => {
    sec.appendChild(el('h3', { style: { fontSize: '12px', marginTop: '14px' } }, h));
    sec.appendChild(el('p', { className: 'bk-lede' }, body));
  });
  panel.appendChild(sec);
}
