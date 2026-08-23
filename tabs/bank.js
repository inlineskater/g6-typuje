// Lazy-loaded tab module — see ensureTabModule() in index.html.
// Owns its own top-level const/let; reads shared globals (me, el, showToast,
// headerCoins, setText, fmtDateTime, plCount) from index.html, which always
// runs first. Its function declarations overwrite index.html's no-op stubs
// (stopBankTimer) that switchTab()/doLogout() call unconditionally.
'use strict';

// ── 🏦 Bank G6 ──────────────────────────────────────────────────────────────
// Four investment products plus the shop's interest item. The server is
// authoritative for every number that moves coins; everything below is a
// PREVIEW, so these constants exist only to render an estimate before you
// commit. They mirror supabase/bank.sql — keep them in sync, and never let the
// client's arithmetic become the thing anyone is paid on.
const BANK_LOKATA_TERMS = [
  { days: 7,  bps: 350  },
  { days: 14, bps: 800  },
  { days: 30, bps: 1900 },
];
const BANK_LOKATA_MIN = 500;
const BANK_LOKATA_MAX = 30000;
const BANK_PIGGY_MAX = 5000;
const BANK_PIGGY_BPS = 40;        // per day, simple
const BANK_PIGGY_LOCK_DAYS = 7;
const BANK_PIGGY_MAX_DAYS = 90;   // accrual ceiling, mirrors bank_piggy_interest()

let bankState = null;
let bankTerm = 30;                // selected lokata term
let bankTimer = null;
let bankCountdowns = [];          // [{ node, until }] refreshed by the 1s tick
let bankBusy = false;

function bankFmt(n) { return Math.round(Number(n) || 0).toLocaleString('pl-PL'); }

// "2 dni 4 godz." / "18 min" — the granularity people actually care about at
// each scale, rather than a fixed unit that reads as 0 or as six digits.
function bankFmtLeft(untilMs) {
  const ms = untilMs - Date.now();
  if (ms <= 0) return 'gotowe';
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins - days * 1440) / 60);
  if (days > 0) return `${days} ${plCount(days, 'dzień', 'dni', 'dni')}${hours ? ` ${hours} godz.` : ''}`;
  if (hours > 0) return `${hours} godz. ${mins - hours * 60} min`;
  return `${Math.max(1, mins)} min`;
}

function stopBankTimer() {
  if (bankTimer) { clearInterval(bankTimer); bankTimer = null; }
  bankCountdowns = [];
}

let bankRefetching = false;
function startBankTimer() {
  stopBankTimer();
  bankTimer = setInterval(() => {
    let due = false;
    bankCountdowns.forEach(c => {
      const left = bankFmtLeft(c.until);
      if (c.node.textContent !== left) c.node.textContent = left;
      if (c.until <= Date.now()) due = true;
    });
    // Something just matured — the server settles lazily on read, so ask it.
    // Guarded: the tick keeps firing while the round trip is in flight, and an
    // unguarded call would queue one bank_state() per second until it lands.
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
    body.replaceChildren(el('div', { className: 'bank-note' },
      'Bank G6 jest jeszcze niedostępny. Wdróż supabase/bank.sql. (' + error.message + ')'));
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
// open two lokaty), one error translation, one reload.
async function bankCall(fn, args, okMsg, btn) {
  if (bankBusy) return null;
  bankBusy = true;
  if (btn) btn.disabled = true;
  const { data, error } = await sb.rpc(fn, args || {});
  bankBusy = false;
  if (error) {
    showToast('❌ ' + (BANK_ERRORS[bankErrKey(error.message)] || error.message));
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

function bankErrKey(msg) {
  return Object.keys(BANK_ERRORS).find(k => (msg || '').includes(k)) || '';
}

const BANK_ERRORS = {
  insufficient_coins: 'Za mało coinów!',
  over_cap:           'Przekroczony limit dla tego produktu.',
  amount_too_small:   `Minimalna kwota to ${bankFmt(BANK_LOKATA_MIN)} 🪙.`,
  bad_term:           'Nieprawidłowy okres lokaty.',
  bad_qty:            'Nieprawidłowa liczba sztuk.',
  sold_out:           'Wyprzedane!',
  per_user_limit:     'Masz już maksymalną liczbę udziałów z emisji.',
  no_open_series:     'Brak otwartej emisji obligacji.',
  not_for_sale:       'Ta pozycja nie jest już na sprzedaż.',
  own_listing:        'To Twoja własna oferta.',
  bond_matured:       'Ta obligacja już zapadła — nie można jej kupić.',
  deposit_not_found:  'Nie znaleziono tej lokaty.',
  holding_not_found:  'Nie znaleziono tej pozycji.',
  bad_price:          'Nieprawidłowa cena.',
};

// ── Rendering ───────────────────────────────────────────────────────────────

function renderBank() {
  const body = document.getElementById('bank-body');
  if (!body || !bankState) return;
  bankCountdowns = [];

  const wrap = el('div', { className: 'bank-wrap' });
  wrap.appendChild(bankHeroEl());

  const grid = el('div', { className: 'bank-grid' });
  grid.appendChild(bankLokataCard());
  grid.appendChild(bankPiggyCard());
  grid.appendChild(bankBondCard());
  grid.appendChild(bankShareCard());
  grid.appendChild(bankSignetCard());
  grid.appendChild(bankMarketCard());
  wrap.appendChild(grid);

  body.replaceChildren(wrap);
}

// Total currently working in the bank + what it throws off per day. The daily
// figure is deliberately split: lokata/skarbonka/bond income is contractual,
// the share dividend is an estimate off recent house net and is labelled so.
function bankSummary() {
  const deps = (bankState.deposits || []).filter(d => !d.closed_at);
  const holds = bankState.holdings || [];
  const invested = deps.reduce((a, d) => a + Number(d.mark || 0), 0)
    + holds.reduce((a, h) => a + Number(h.kind === 'bond' ? h.face_value : h.purchase_price), 0);

  let perDay = 0;
  deps.forEach(d => {
    if (d.product === 'lokata') {
      perDay += Number(d.interest_if_held) / Math.max(1, Number(d.term_days));
    } else {
      perDay += Math.floor(Number(d.principal) * BANK_PIGGY_BPS / 10000);
    }
  });
  holds.filter(h => h.kind === 'bond').forEach(h => { perDay += Number(h.coupon_per_day); });
  const shareBps = holds.filter(h => h.kind === 'share')
    .reduce((a, h) => a + Number(h.share_bps || 0), 0);
  const shareDay = Math.floor(Number(bankState.shares?.house_net_avg || 0) * shareBps / 10000);

  const earned = (bankState.dividends || []).reduce((a, d) => a + Number(d.amount || 0), 0);
  return { invested, perDay: Math.round(perDay), shareDay, earned };
}

function bankHeroEl() {
  const s = bankSummary();
  const hero = el('div', { className: 'bank-hero' });
  const intro = el('div', {});
  intro.appendChild(el('h2', {}, '🏦 Bank G6'));
  intro.appendChild(el('p', {},
    'Cztery sposoby, żeby monety pracowały zamiast leżeć. Im dłużej blokujesz, tym więcej płacimy — '
    + 'a Udział w Kasynie płaci tyle, ile kasyno naprawdę zarobiło, więc w chudym tygodniu nie płaci nic.'));
  hero.appendChild(intro);

  const stats = el('div', { className: 'bank-hero-stats' });
  const add = (label, value) => {
    const t = el('div', { className: 'bank-stat' });
    t.appendChild(el('b', {}, value));
    t.appendChild(el('span', {}, label));
    stats.appendChild(t);
  };
  add('W banku', bankFmt(s.invested) + ' 🪙');
  add('Odsetki / dzień', bankFmt(s.perDay) + ' 🪙');
  add('Dywidenda ~ / dzień', bankFmt(s.shareDay) + ' 🪙');
  add('Wypłacono (30 dni)', bankFmt(s.earned) + ' 🪙');
  hero.appendChild(stats);
  return hero;
}

function bankCardEl(title, subtitle, isNew) {
  const card = el('div', { className: 'bank-card' });
  const h = el('h3', {});
  h.append(title);
  if (isNew) h.appendChild(el('span', { className: 'nav-new-badge' }, 'Nowość'));
  card.appendChild(h);
  if (subtitle) card.appendChild(el('p', { className: 'bank-card-sub' }, subtitle));
  return card;
}

// Amount input + MAX button. `maxFn` is read at click time, not at build time,
// so the cap stays correct after a deposit changes the remaining headroom.
function bankAmountRow(placeholder, maxFn, onSubmit, btnLabel) {
  const row = el('div', { className: 'bank-row' });
  const input = el('input', { type: 'number', min: String(BANK_LOKATA_MIN), step: '100', placeholder });
  const maxBtn = el('button', { className: 'btn-ghost bank-btn-sm' }, 'MAX');
  maxBtn.addEventListener('click', () => { input.value = String(maxFn()); input.dispatchEvent(new Event('input')); });
  const go = el('button', { className: 'btn-primary bank-btn-sm' }, btnLabel);
  go.addEventListener('click', () => onSubmit(Math.floor(Number(input.value) || 0), go));
  row.append(input, maxBtn, go);
  return { row, input };
}

function bankLokataCard() {
  const caps = bankState.caps || {};
  const free = Math.max(0, BANK_LOKATA_MAX - Number(caps.lokata_open || 0));
  const card = bankCardEl('🏦 Lokata Terminowa',
    'Blokujesz monety na sztywny termin i dostajesz z góry znaną kwotę. '
    + 'Zerwanie przed czasem zwraca kapitał — bez odsetek.', true);

  const terms = el('div', { className: 'bank-terms' });
  BANK_LOKATA_TERMS.forEach(t => {
    const b = el('button', { className: 'bank-term' + (t.days === bankTerm ? ' active' : '') });
    b.appendChild(el('b', {}, `${t.days} dni`));
    b.appendChild(el('span', {}, `+${(t.bps / 100).toFixed(1).replace('.', ',')}%`));
    b.addEventListener('click', () => { bankTerm = t.days; renderBank(); });
    terms.appendChild(b);
  });
  card.appendChild(terms);

  const preview = el('div', { className: 'bank-note' });
  const term = BANK_LOKATA_TERMS.find(t => t.days === bankTerm);
  const { row, input } = bankAmountRow(
    `Kwota (min ${bankFmt(BANK_LOKATA_MIN)})`,
    () => Math.min(free, Math.floor(Number(me?.coins) || 0)),
    (amount, btn) => bankCall('bank_open_deposit',
      { p_product: 'lokata', p_amount: amount, p_term_days: bankTerm },
      d => `✅ Lokata założona. Wypłata ${fmtDateTime(d.matures_at)}.`, btn),
    'Załóż lokatę');
  const updatePreview = () => {
    const amount = Math.floor(Number(input.value) || 0);
    if (!amount) { preview.textContent = `Wolny limit: ${bankFmt(free)} 🪙 z ${bankFmt(BANK_LOKATA_MAX)} 🪙.`; return; }
    const interest = Math.floor(amount * term.bps / 10000);
    preview.textContent = `Po ${bankTerm} dniach otrzymasz ${bankFmt(amount + interest)} 🪙 `
      + `(+${bankFmt(interest)} 🪙, ok. ${(term.bps / 100 / bankTerm).toFixed(2).replace('.', ',')}%/dzień).`;
  };
  input.addEventListener('input', updatePreview);
  updatePreview();
  card.append(row, preview);
  card.appendChild(bankDepositList('lokata'));
  return card;
}

function bankPiggyCard() {
  const caps = bankState.caps || {};
  const free = Math.max(0, BANK_PIGGY_MAX - Number(caps.piggy_open || 0));
  const card = bankCardEl('🐷 Skarbonka',
    `Bez terminu — wyjmujesz kiedy chcesz. Ale odsetki (${(BANK_PIGGY_BPS / 100).toFixed(2).replace('.', ',')}%/dzień) `
    + `naliczają się dopiero po ${BANK_PIGGY_LOCK_DAYS} dniach: rozbita wcześniej oddaje sam kapitał.`, true);

  const preview = el('div', { className: 'bank-note' });
  const { row, input } = bankAmountRow(
    `Kwota (min ${bankFmt(BANK_LOKATA_MIN)})`,
    () => Math.min(free, Math.floor(Number(me?.coins) || 0)),
    (amount, btn) => bankCall('bank_open_deposit',
      { p_product: 'skarbonka', p_amount: amount },
      () => '🐷 Wrzucone do skarbonki.', btn),
    'Wrzuć');
  const updatePreview = () => {
    const amount = Math.floor(Number(input.value) || 0);
    const perDay = Math.floor(amount * BANK_PIGGY_BPS / 10000);
    preview.textContent = amount
      ? `${bankFmt(perDay)} 🪙 dziennie po odblokowaniu, maks. ${bankFmt(perDay * BANK_PIGGY_MAX_DAYS)} 🪙 przez ${BANK_PIGGY_MAX_DAYS} dni.`
      : `Wolny limit: ${bankFmt(free)} 🪙 z ${bankFmt(BANK_PIGGY_MAX)} 🪙.`;
  };
  input.addEventListener('input', updatePreview);
  updatePreview();
  card.append(row, preview);
  card.appendChild(bankDepositList('skarbonka'));
  return card;
}

function bankDepositList(product) {
  const list = el('div', { className: 'bank-list' });
  const rows = (bankState.deposits || []).filter(d => d.product === product && !d.closed_at);
  if (!rows.length) {
    list.appendChild(el('div', { className: 'bank-empty' },
      product === 'lokata' ? 'Nie masz otwartych lokat.' : 'Skarbonka jest pusta.'));
    return list;
  }
  rows.forEach(d => {
    const until = Date.parse(d.matures_at);
    const ready = until <= Date.now();
    const item = el('div', { className: 'bank-item' + (ready ? ' ready' : '') });
    const main = el('div', { className: 'bank-item-main' });
    main.appendChild(el('b', {}, `${bankFmt(d.principal)} 🪙`
      + (product === 'lokata' ? ` → ${bankFmt(Number(d.principal) + Number(d.interest_if_held))} 🪙` : '')));
    const sub = el('span', {});
    if (ready) {
      sub.append(product === 'lokata'
        ? 'zapadła — wypłata w ciągu godziny'
        : `odblokowana, narosło ${bankFmt(d.interest_if_held)} 🪙`);
    } else {
      sub.append(product === 'lokata' ? 'wypłata za ' : 'odblokowanie za ');
      const cd = el('b', {}, bankFmtLeft(until));
      sub.appendChild(cd);
      bankCountdowns.push({ node: cd, until });
    }
    main.appendChild(sub);
    item.appendChild(main);

    const btn = el('button', { className: 'btn-ghost bank-btn-sm' },
      ready ? 'Odbierz' : (product === 'lokata' ? 'Zerwij' : 'Rozbij'));
    btn.addEventListener('click', () => {
      if (!ready && !confirm(product === 'lokata'
        ? 'Zerwanie lokaty przed terminem oznacza ZERO odsetek. Odzyskasz sam kapitał. Na pewno?'
        : `Skarbonka nie doczekała ${BANK_PIGGY_LOCK_DAYS} dni — odsetki przepadną. Rozbić?`)) return;
      bankCall('bank_close_deposit', { p_id: d.id },
        r => r.interest > 0 ? `✅ Wypłacono ${bankFmt(r.principal + r.interest)} 🪙 (+${bankFmt(r.interest)} odsetek).`
                            : `Zwrócono ${bankFmt(r.principal)} 🪙 — bez odsetek.`, btn);
    });
    item.appendChild(btn);
    list.appendChild(item);
  });
  return list;
}

function bankBondCard() {
  const ser = bankState.series;
  const card = bankCardEl('📜 Obligacje G6',
    'Stały kupon co dzień plus zwrot nominału na koniec. W przeciwieństwie do lokaty '
    + 'możesz ją odsprzedać komuś innemu, zanim zapadnie.', true);

  if (!ser) {
    card.appendChild(el('div', { className: 'bank-empty' }, 'Aktualna emisja jest wyprzedana. Nowa w przyszłym tygodniu.'));
  } else {
    const total = Number(ser.coupon_per_day) * Number(ser.term_days);
    card.appendChild(el('div', { className: 'bank-note' },
      `Emisja ${ser.code}: ${bankFmt(ser.price)} 🪙 za sztukę, kupon ${bankFmt(ser.coupon_per_day)} 🪙/dzień `
      + `przez ${ser.term_days} dni, potem zwrot ${bankFmt(ser.face_value)} 🪙 `
      + `(łącznie +${bankFmt(total)} 🪙, ${(total / ser.face_value * 100).toFixed(0)}%).`));
    const bar = el('div', { className: 'bank-supply' });
    bar.appendChild(el('i', { style: { width: (ser.sold / ser.edition_size * 100) + '%' } }));
    card.appendChild(bar);
    card.appendChild(el('div', { className: 'bank-note' },
      `Sprzedano ${ser.sold} z ${ser.edition_size} · zapisy do ${fmtDateTime(ser.closes_at)}`));

    const row = el('div', { className: 'bank-row' });
    const qty = el('input', { type: 'number', min: '1', max: '10', value: '1' });
    const go = el('button', { className: 'btn-primary bank-btn-sm' }, 'Kup obligacje');
    go.addEventListener('click', () => bankCall('bank_buy_bond',
      { p_qty: Math.max(1, Math.min(10, Math.floor(Number(qty.value) || 1))) },
      d => `📜 Kupiono ${d.qty} × ${ser.code}.`, go));
    row.append(qty, go);
    card.appendChild(row);
  }

  card.appendChild(bankHoldingList('bond'));
  return card;
}

function bankShareCard() {
  const sh = bankState.shares || {};
  const left = Math.max(0, Number(sh.supply || 0) - Number(sh.sold || 0));
  const perShare = Math.floor(Number(sh.house_net_avg || 0) * Number(sh.share_bps || 0) / 10000);
  const card = bankCardEl('🎰 Udział w Kasynie',
    'Kawałek zysku kasyna. Każdy udział wypłaca codziennie '
    + `${(Number(sh.share_bps || 0) / 100).toFixed(1).replace('.', ',')}% tego, co kasyno zarobiło na graczach `
    + '(średnia z 7 dni). To jedyny produkt, który potrafi zapłacić zero — i jedyny, '
    + 'który nie dodrukowuje monet, tylko rozdaje te już przegrane.', true);

  const bar = el('div', { className: 'bank-supply' });
  bar.appendChild(el('i', { style: { width: (Number(sh.sold || 0) / Number(sh.supply || 1) * 100) + '%' } }));
  card.appendChild(bar);
  card.appendChild(el('div', { className: 'bank-note' },
    `${sh.sold || 0} z ${sh.supply || 0} udziałów w obiegu · cena ${bankFmt(sh.price)} 🪙 · `
    + `maks. ${sh.max_per_user} z emisji na osobę (masz ${sh.mine_treasury || 0}).`));
  card.appendChild(el('div', { className: 'bank-note' },
    `Kasyno zarabia ostatnio ${bankFmt(sh.house_net_avg)} 🪙 dziennie → ok. `
    + `${bankFmt(perShare)} 🪙 na udział (${perShare > 0 ? `zwrot w ~${Math.ceil(Number(sh.price) / perShare)} dni` : 'obecnie 0'}). `
    + 'To historia, nie obietnica.'));

  if (left <= 0) {
    card.appendChild(el('div', { className: 'bank-empty' }, 'Cała emisja rozeszła się — zostaje rynek wtórny niżej.'));
  } else {
    const row = el('div', { className: 'bank-row' });
    const qty = el('input', { type: 'number', min: '1', max: String(sh.max_per_user), value: '1' });
    const go = el('button', { className: 'btn-primary bank-btn-sm' }, 'Kup udział');
    go.addEventListener('click', () => bankCall('bank_buy_share',
      { p_qty: Math.max(1, Math.floor(Number(qty.value) || 1)) },
      d => `🎰 Kupiono ${d.qty} ${plCount(d.qty, 'udział', 'udziały', 'udziałów')}.`, go));
    row.append(qty, go);
    card.appendChild(row);
  }

  card.appendChild(bankHoldingList('share'));

  const divs = (bankState.dividends || []).filter(d => d.kind === 'share').slice(0, 7);
  if (divs.length) {
    const table = el('table', { className: 'bank-ladder' });
    const tbody = el('tbody', {});
    const head = el('tr', {});
    head.append(el('th', {}, 'Dzień'), el('th', {}, 'Dywidenda'));
    tbody.appendChild(head);
    divs.forEach(d => {
      const tr = el('tr', {});
      tr.append(el('td', {}, d.pay_date), el('td', {}, bankFmt(d.amount) + ' 🪙'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    card.appendChild(table);
  }
  return card;
}

// Bonds and shares you own. Both are resellable, so both get the same
// list/unlist control — the ask price is the whole secondary market.
function bankHoldingList(kind) {
  const list = el('div', { className: 'bank-list' });
  const rows = (bankState.holdings || []).filter(h => h.kind === kind);
  if (!rows.length) {
    list.appendChild(el('div', { className: 'bank-empty' },
      kind === 'bond' ? 'Nie masz obligacji.' : 'Nie masz udziałów.'));
    return list;
  }
  rows.forEach(h => {
    const item = el('div', { className: 'bank-item' });
    const main = el('div', { className: 'bank-item-main' });
    if (kind === 'bond') {
      const until = Date.parse(h.matures_at);
      main.appendChild(el('b', {}, `${h.series_code || 'Obligacja'} · ${bankFmt(h.face_value)} 🪙`));
      const sub = el('span', {});
      sub.append(`kupon ${bankFmt(h.coupon_per_day)} 🪙/dzień · wykup za `);
      const cd = el('b', {}, bankFmtLeft(until));
      sub.appendChild(cd);
      bankCountdowns.push({ node: cd, until });
      if (Number(h.accrued) > 0) sub.append(` · nierozliczone ${bankFmt(h.accrued)} 🪙`);
      main.appendChild(sub);
    } else {
      main.appendChild(el('b', {}, `Udział #${h.serial_no}`));
      main.appendChild(el('span', {}, `wypłacono łącznie ${bankFmt(h.earned)} 🪙`));
    }
    item.appendChild(main);

    if (h.ask_price) {
      item.appendChild(el('span', { className: 'bank-note' }, `wystawione za ${bankFmt(h.ask_price)} 🪙`));
      const off = el('button', { className: 'btn-ghost bank-btn-sm' }, 'Wycofaj');
      off.addEventListener('click', () => bankCall('bank_unlist_holding', { p_id: h.id },
        () => 'Wycofano ze sprzedaży.', off));
      item.appendChild(off);
    } else {
      const sell = el('button', { className: 'btn-ghost bank-btn-sm' }, 'Sprzedaj');
      sell.addEventListener('click', () => {
        const suggested = kind === 'bond'
          ? Number(h.face_value) + Number(h.accrued)
          : Number(h.purchase_price);
        const raw = prompt(`Cena wywoławcza w 🪙 (kupno natychmiastowe).\n`
          + `Sugestia na podstawie wartości: ${bankFmt(suggested)} 🪙`, String(suggested));
        if (raw === null) return;
        const price = Math.floor(Number(raw) || 0);
        if (price < 1) { showToast('❌ Nieprawidłowa cena.'); return; }
        bankCall('bank_list_holding', { p_id: h.id, p_price: price },
          () => `Wystawiono za ${bankFmt(price)} 🪙.`, sell);
      });
      item.appendChild(sell);
    }
    list.appendChild(item);
  });
  return list;
}

// The interest item lives in the Sklep (it is a hero_item_defs row like every
// other special item); this card is a signpost to it, not a second buy path.
function bankSignetCard() {
  const sig = bankState.signet || {};
  const card = bankCardEl('💍 Sygnet Bankiera',
    'Ta sama stopa co legendarny Pierścień Bankiera — +2% dziennie — ale liczona '
    + 'tylko od pierwszych 12 000 🪙 gotówki, więc maksymalnie 240 🪙 dziennie. '
    + 'Odsetki naliczają się od GOTÓWKI: monety zablokowane w lokacie nie liczą się do podstawy.', true);

  card.appendChild(el('div', { className: 'bank-note' },
    'Cena 8 000 🪙 — przy pełnej podstawie zwraca się po ok. 33 dniach, przy typowym saldzie po ok. 39. '
    + 'Wypłata codziennie rano, automatycznie.'));

  if (sig.owned) {
    card.appendChild(el('div', { className: 'bank-item ready' },
      el('div', { className: 'bank-item-main' },
        el('b', {}, '✅ Masz sygnet'),
        el('span', {}, `wypłacono Ci już ${bankFmt(sig.paid_total)} 🪙 odsetek`))));
  } else if (sig.better) {
    // Buying it would be 8,000 coins for nothing: only the best interest item
    // pays. Say so here rather than letting them find out the next morning.
    card.appendChild(el('div', { className: 'bank-warn' },
      `Masz już „${sig.better}" — mocniejszy przedmiot odsetkowy. Liczy się tylko `
      + 'najlepszy z posiadanych, więc Sygnet nie dołożyłby Ci ani monety.'));
    card.appendChild(el('div', { className: 'bank-note' },
      `Wypłacono Ci już ${bankFmt(sig.paid_total)} 🪙 odsetek.`));
  } else {
    const go = el('button', { className: 'btn-primary bank-btn-sm' }, 'Zobacz w Sklepie →');
    go.addEventListener('click', () => withTabModule('shop', () => openHeroItemInShop('banker_signet')));
    card.appendChild(go);
    card.appendChild(el('div', { className: 'bank-note' },
      'Uwaga: liczy się tylko najlepszy posiadany przedmiot odsetkowy — dwa nie sumują się.'));
  }
  return card;
}

function bankMarketCard() {
  const rows = bankState.market || [];
  const card = bankCardEl('🤝 Rynek wtórny',
    'Obligacje i udziały wystawione przez graczy. Kupno jest natychmiastowe, '
    + 'a monety trafiają do sprzedającego — bank nic tu nie zarabia.', true);

  if (!rows.length) {
    card.appendChild(el('div', { className: 'bank-empty' }, 'Nikt nic nie wystawił.'));
    return card;
  }
  const list = el('div', { className: 'bank-list' });
  rows.forEach(h => {
    const item = el('div', { className: 'bank-item' });
    const main = el('div', { className: 'bank-item-main' });
    if (h.kind === 'bond') {
      const until = Date.parse(h.matures_at);
      main.appendChild(el('b', {}, `📜 Obligacja ${bankFmt(h.face_value)} 🪙`));
      const sub = el('span', {});
      sub.append(`${bankFmt(h.coupon_per_day)} 🪙/dzień · do wykupu `);
      const cd = el('b', {}, bankFmtLeft(until));
      sub.appendChild(cd);
      bankCountdowns.push({ node: cd, until });
      sub.append(` · od ${h.owner_nick}`);
      main.appendChild(sub);
    } else {
      main.appendChild(el('b', {}, `🎰 Udział #${h.serial_no}`));
      main.appendChild(el('span', {}, `od ${h.owner_nick}`));
    }
    item.appendChild(main);
    item.appendChild(el('b', {}, bankFmt(h.ask_price) + ' 🪙'));

    if (h.mine) {
      item.appendChild(el('span', { className: 'bank-note' }, 'Twoja oferta'));
    } else {
      const buy = el('button', { className: 'btn-primary bank-btn-sm' }, 'Kup');
      buy.disabled = (Number(me?.coins) || 0) < Number(h.ask_price);
      buy.addEventListener('click', () => bankCall('bank_buy_holding', { p_id: h.id },
        r => `✅ Kupiono za ${bankFmt(r.price)} 🪙.`, buy));
      item.appendChild(buy);
    }
    list.appendChild(item);
  });
  card.appendChild(list);
  return card;
}
