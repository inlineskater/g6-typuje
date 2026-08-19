// Lazy-loaded tab module — see ensureTabModule() in index.html.
// Moved out of index.html's inline <script> so it is fetched only when
// this tab is actually opened. Owns its own top-level const/let; reads
// shared globals from index.html, which always runs first.
'use strict';

// ── 🎟️ Loteria po Mundialu (activity raffle) ───────────────────────────────
// Its own tab (#tab-lottery). Prize pool = 10 × the Bank's Mundial net; tickets
// earned across the whole portal. Caps mirror supabase/lottery.sql — keep in sync.
const LOTTERY_TIERS = [
  { place: '1.', pct: 0.30 },
  { place: '2.', pct: 0.20 },
  { place: '3.', pct: 0.14 },
  { place: '4.', pct: 0.10 },
  { place: '5.', pct: 0.08 },
  { place: '6.', pct: 0.06 },
];
const LOTTERY_DIVIDEND_PCT = 0.12; // reszta puli — po równo dla każdego z biletem

// Every ticket category, mapped to its field on a player row. `how` tells the
// player exactly what to do to earn more — shown in the "Twoje bilety" table.
const LOTTERY_CATS = [
  { key: 'mundial',  label: 'Mundial',        icon: '⚽', cap: 15, how: 'Postaw zakład na mecz' },
  { key: 'rynek',    label: 'Rynek Proroctw', icon: '📊', cap: 10, how: 'Obstawiaj rynki predykcyjne' },
  { key: 'kasyno',   label: 'Kasyno',         icon: '🎰', cap: 10, how: 'Zagraj w grę losową (dzień)' },
  { key: 'sezonowe', label: 'Gra tygodnia',   icon: '🕹️', cap: 8,  how: 'Zagraj w grę tygodnia (tydzień)' },
  { key: 'farma',    label: 'Farma',          icon: '🌱', cap: 8,  how: 'Zbieraj plony (dzień)' },
  { key: 'targ',     label: 'Targowisko',     icon: '🛍️', cap: 6,  how: 'Sfinalizuj transakcję' },
  { key: 'plotno',   label: 'Wspólne Płótno', icon: '🎨', cap: 6,  how: 'Maluj piksele (dzień)' },
  { key: 'ogrod',    label: 'Ogród Zen',      icon: '🪴', cap: 5,  how: 'Załóż 2 rośliny zen' },
  { key: 'ozdoby',   label: 'Ozdoby roślin',  icon: '🎀', cap: 4,  how: 'Ubierz roślinę w ozdobę (+2 za roślinę, nie za ozdobę — max 2 rośliny)' },
  { key: 'dzialki',  label: 'Działki',        icon: '🚜', cap: 12, how: 'Kup działkę (+2 za każdą)' },
  { key: 'breadth',  label: 'Wszechstronność',icon: '🌈', cap: 14, how: '+2 za każdą aktywność z punktem' },
];
let lotteryRankView = 'list'; // 'list' | 'matrix'
function setLotteryRankView(v) { lotteryRankView = v; renderLottery(); }
const LOTTERY_ACTIVITY_KEYS = ['mundial','rynek','kasyno','sezonowe','farma','targ','plotno'];
const LOTTERY_OWNER_KEYS = ['ogrod','ozdoby','dzialki'];

let lotteryData = null;
let lotteryLoading = false;
let lotteryDraws = [];          // lottery_draws rows, newest first
let lotteryDrawsMissing = false; // supabase/lottery-draw.sql not installed yet

async function renderLottery(force) {
  const body = document.getElementById('lottery-body');
  if (!body) return;
  if (lotteryData && !force) { body.replaceChildren(buildLotteryPanel(lotteryData)); return; }
  if (lotteryLoading) return;
  lotteryLoading = true;
  if (!lotteryData) body.replaceChildren(makeSpinner());
  else body.replaceChildren(buildLotteryPanel(lotteryData)); // keep showing stale data with a spinning refresh button
  try {
    const [standRes, drawRes] = await Promise.all([
      sb.rpc('mundial_lottery_standings'),
      sb.from('lottery_draws').select('*').order('committed_at', { ascending: false }).limit(12),
    ]);
    if (standRes.error) throw standRes.error;
    // The draw tables may not be installed yet (supabase/lottery-draw.sql) — the
    // machine degrades to a note instead of taking the whole tab down with it.
    lotteryDrawsMissing = !!drawRes.error;
    lotteryDraws = drawRes.error ? [] : (drawRes.data || []);
    const data = standRes.data;
    lotteryData = data;
    body.replaceChildren(buildLotteryPanel(data));
    setupLotteryRealtime();
  } catch (_e) {
    body.replaceChildren(el('div', { className: 'lot' },
      el('p', { className: 'lot-lede' }, 'Nie udało się wczytać loterii. Spróbuj odświeżyć stronę.')));
  } finally {
    lotteryLoading = false;
  }
}

// Polish thousands grouping (80 290) for the lottery's headline figures only —
// the rest of the app uses plain fmtNum.
function lotNum(n) { return Math.round(+n || 0).toLocaleString('pl-PL'); }
// The pool multiplier comes from the RPC (mundial_lottery_standings → 'multiplier'),
// never from a literal in the copy — that is how "10×" would survive a change to
// the SQL and start lying.
function lotMult(d) { return String(+((d || {}).multiplier) || 100); }
function lotCoins(n) {
  return el('span', { className: 'lot-num' }, lotNum(n),
    el('span', { className: 'lot-coin' }, ' 🪙'));
}
function lotCatValue(p, key) {
  return key === 'breadth' ? (+p.breadth || 0) : (+p[key] || 0);
}

function buildLotteryPanel(d) {
  lotMachineStop(); // a rebuild orphans the old canvas — never leave its RAF running
  if (lotIsFs()) lotExitFs(); // ...and never leave the page locked behind a dead overlay
  const pool = Math.max(0, +d.prize_pool || 0);
  const bankNet = +d.bank_net || 0;
  const total = +d.total_tickets || 0;
  const players = Array.isArray(d.players) ? d.players : [];
  const live = bankNet > 0 && pool > 0;
  const maxTk = players.reduce((m, p) => Math.max(m, +p.tickets || 0), 0) || 1;
  const mine = me ? players.find(p => p.id === me.id) : null;

  // ── Header ──
  const header = el('div', { className: 'lot-head' },
    el('div', {},
      el('div', { className: 'lot-eyebrow' }, 'Mistrzostwa Świata 2026'),
      el('h1', { className: 'lot-title' }, 'Loteria po Mundialu'),
    ),
    el('span', { className: 'lot-badge' }, 'Nowość'),
  );
  const lede = el('p', { className: 'lot-lede' },
    'Cały zysk Banku z Mundialu wraca do graczy. Bilety zbierasz za aktywność na całym portalu — a pod koniec lipca losujemy zwycięzców. Im więcej biletów, tym większa szansa.');

  // ── Ticket ──
  const face = el('div', { className: 'lot-ticket-face' },
    el('div', { className: 'lot-pool-label' }, 'Pula nagród'),
    el('div', { className: 'lot-pool' }, live ? lotCoins(pool) : '—'),
    el('div', { className: 'lot-pool-note' }, live
      ? lotMult(d) + '× wynik Banku w Mundialu (obecnie +' + lotNum(bankNet) + ' 🪙)'
      : 'Pula to ' + lotMult(d) + '× zysk Banku z Mundialu. Rośnie z każdym przegranym zakładem gracza.'),
  );
  const stubFact = (label, val) => el('div', { className: 'lot-fact' },
    el('div', { className: 'lot-fact-label' }, label),
    el('div', { className: 'lot-fact-val' }, val));
  const stub = el('div', { className: 'lot-ticket-stub' },
    stubFact('Zbieramy do', '31 lipca'),
    stubFact('Losowanie', '1 sierpnia'),
    stubFact('Biletów w puli', lotNum(total)),
  );
  const ticket = el('div', { className: 'lot-ticket' }, face, stub);

  // ── Twoje bilety (personal breakdown — exactly why you have your total) ──
  let mineSection = '';
  if (mine) {
    const myTotal = +mine.tickets || 0;
    const tickRow = (icon, label, have, cap, full, hint) => el('div', { className: 'lot-tick-row' + (full ? ' is-full' : '') },
      el('span', { className: 'lot-tick-cat' }, (icon ? icon + ' ' : '') + label),
      el('span', { className: 'lot-tick-val' }, el('b', {}, String(have)), el('span', { className: 'sl' }, ' / ' + cap)),
      full ? el('span', { className: 'lot-tick-how done' }, '✓ komplet') : el('span', { className: 'lot-tick-how' }, el('b', {}, '+' + (cap - have)), ' ' + hint),
    );
    const catRows = LOTTERY_CATS.map(c => {
      const v = lotCatValue(mine, c.key);
      return tickRow(c.icon, c.label, v, c.cap, v >= c.cap, c.how);
    });
    catRows.push(tickRow('🎁', 'Bilet powitalny', 1, 1, true, ''));
    const myRoom = LOTTERY_CATS.reduce((s, c) => s + Math.max(0, c.cap - lotCatValue(mine, c.key)), 0);
    mineSection = el('section', { className: 'lot-section lot-mine' },
      el('div', { className: 'lot-section-head' },
        el('div', { className: 'lot-section-title' }, 'Twoje bilety'),
        el('div', { className: 'lot-section-hint' },
          total > 0 ? 'szansa ' + ((myTotal / total * 100) < 1 ? (myTotal / total * 100).toFixed(1) : Math.round(myTotal / total * 100)) + '%' : ''),
      ),
      el('div', { className: 'lot-mine-total' },
        el('span', { className: 'lot-mine-num' }, String(myTotal)),
        el('span', { className: 'lot-mine-lbl' }, myTotal === 1 ? 'bilet' : 'biletów'),
        myRoom > 0 ? el('span', { className: 'lot-mine-room' }, '+' + myRoom + ' do zdobycia') : '',
      ),
      el('div', { className: 'lot-tick' }, ...catRows),
    );
  }

  // ── Podział puli ──
  const splitRows = LOTTERY_TIERS.map((t, i) => el('tr', { className: i === 0 ? 'is-top' : '' },
    el('td', { className: 'rk' }, t.place + ' miejsce'),
    el('td', { className: 'sh' }, Math.round(t.pct * 100) + '%'),
    el('td', { className: 'amt' }, live ? lotNum(Math.round(pool * t.pct)) + ' 🪙' : '—'),
  ));
  const divAmt = Math.round(pool * LOTTERY_DIVIDEND_PCT);
  const pc = +d.player_count || players.length || 0;
  const divEach = pc ? Math.floor(divAmt / pc) : 0;
  splitRows.push(el('tr', { className: 'is-div' },
    el('td', { className: 'rk' }, 'Dywidenda dla wszystkich'),
    el('td', { className: 'sh' }, Math.round(LOTTERY_DIVIDEND_PCT * 100) + '%'),
    el('td', { className: 'amt' }, live ? lotNum(divAmt) + ' 🪙' : '—'),
  ));
  const drawPct = Math.round((1 - LOTTERY_DIVIDEND_PCT) * 100);
  const splitSection = el('section', { className: 'lot-section' },
    el('div', { className: 'lot-section-head' },
      el('div', { className: 'lot-section-title' }, 'Podział puli'),
      el('div', { className: 'lot-section-hint' }, '6 nagród + dywidenda'),
    ),
    el('table', { className: 'lot-split' }, el('tbody', {}, ...splitRows)),
    el('div', { className: 'lot-explain' },
      el('p', {}, el('b', {}, 'Losowanie (' + drawPct + '% puli): '),
        'sześć nagród losujemy ważnie liczbą biletów i bez powtórzeń — więcej biletów to większa szansa, a jedna osoba nie zajmie dwóch miejsc.'),
      el('p', {}, el('b', {}, 'Dywidenda (' + Math.round(LOTTERY_DIVIDEND_PCT * 100) + '% puli): '),
        live && divEach
          ? lotNum(divAmt) + ' 🪙 ÷ ' + pc + ' graczy z biletem = ok. ' + lotNum(divEach) + ' 🪙 dla każdego. To gwarantowana wypłata — dostajesz ją niezależnie od losowania.'
          : 'równa działka dla każdego, kto ma choć jeden bilet — gwarantowana, niezależnie od losowania.'),
    ),
  );

  // ── Jak zdobyć bilety (full catalog, grouped) ──
  const earnRow = c => {
    const bonus = c.key === 'breadth';
    return el('div', { className: 'lot-earn-row' + (bonus ? ' is-bonus' : '') },
      el('div', { className: 'lot-earn-name' }, c.label),
      el('div', { className: 'lot-earn-rule' }, c.how),
      el('div', { className: 'lot-earn-cap' }, 'max ' + c.cap),
    );
  };
  const catByKey = k => LOTTERY_CATS.find(c => c.key === k);
  const earnSection = el('section', { className: 'lot-section' },
    el('div', { className: 'lot-section-head' },
      el('div', { className: 'lot-section-title' }, 'Za co zdobywasz bilety'),
      el('div', { className: 'lot-section-hint' }, 'graj szeroko, nie tylko dużo'),
    ),
    el('div', { className: 'lot-earn-group' }, 'Za aktywność'),
    el('div', { className: 'lot-earn' }, ...LOTTERY_ACTIVITY_KEYS.map(k => earnRow(catByKey(k)))),
    el('div', { className: 'lot-earn-group' }, 'Za rozwój i posiadanie'),
    el('div', { className: 'lot-earn' }, ...LOTTERY_OWNER_KEYS.map(k => earnRow(catByKey(k)))),
    el('div', { className: 'lot-earn-group' }, 'Bonusy'),
    el('div', { className: 'lot-earn' },
      earnRow(catByKey('breadth')),
      el('div', { className: 'lot-earn-row is-bonus' },
        el('div', { className: 'lot-earn-name' }, 'Bilet powitalny'),
        el('div', { className: 'lot-earn-rule' }, 'Każdy gracz dostaje jeden na start'),
        el('div', { className: 'lot-earn-cap' }, '+1'),
      ),
    ),
  );

  // ── Ranking ──
  const rankRows = players.map((p, i) => {
    const tk = +p.tickets || 0;
    const chance = total > 0 ? (tk / total) * 100 : 0;
    const isMe = me && p.id === me.id;
    const breakdown = LOTTERY_CATS.map(c => c.label + ' ' + lotCatValue(p, c.key)).join(' · ');
    const bar = el('span', {});
    const row = el('div', { className: 'lot-rank-row' + (isMe ? ' is-me' : ''), title: breakdown },
      el('div', { className: 'lot-rank-top' },
        el('div', { className: 'lot-rank-pos' }, String(i + 1)),
        el('div', { className: 'lot-rank-nick' }, p.nick || '—',
          isMe ? el('span', { className: 'lot-rank-you' }, 'Ty') : ''),
        el('div', { className: 'lot-rank-spacer' }),
        el('div', { className: 'lot-rank-tickets' }, String(tk), el('small', {}, 'bil.')),
        el('div', { className: 'lot-rank-chance' }, (chance < 1 ? chance.toFixed(1) : Math.round(chance)) + '%'),
      ),
      el('div', { className: 'lot-rank-bar' }, bar),
    );
    const frac = tk / maxTk;
    if (plinkoReducedMotion && plinkoReducedMotion()) { bar.style.transform = 'scaleX(' + frac + ')'; }
    else { bar.style.transform = 'scaleX(0)'; requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transform = 'scaleX(' + frac + ')'; })); }
    return row;
  });
  // Matrix: every player's points across every category.
  const matrixCols = LOTTERY_CATS;
  const matrix = el('div', { className: 'lot-matrix-wrap' },
    el('table', { className: 'lot-matrix' },
      el('thead', {}, el('tr', {},
        el('th', { className: 'nk' }, 'Gracz'),
        ...matrixCols.map(c => el('th', { className: 'ct', title: c.label }, c.icon)),
        el('th', { className: 'tot', title: 'Razem biletów' }, 'Σ'),
      )),
      el('tbody', {}, ...players.map((p, i) => el('tr', { className: (me && p.id === me.id) ? 'is-me' : '' },
        el('td', { className: 'nk' }, el('span', { className: 'mp' }, String(i + 1)), (p.nick || '—')),
        ...matrixCols.map(c => {
          const v = lotCatValue(p, c.key);
          return el('td', { className: 'ct' + (v === 0 ? ' zero' : (v >= c.cap ? ' full' : '')) }, String(v));
        }),
        el('td', { className: 'tot' }, String(+p.tickets || 0)),
      ))),
    ),
  );

  const viewBtn = (v, label) => {
    const b = el('button', { className: 'lot-view-btn' + (lotteryRankView === v ? ' is-on' : '') }, label);
    b.addEventListener('click', () => { if (lotteryRankView !== v) setLotteryRankView(v); });
    return b;
  };
  const rankSection = el('section', { className: 'lot-section' },
    el('div', { className: 'lot-section-head' },
      el('div', { className: 'lot-section-title' }, 'Ranking biletów'),
      el('div', { className: 'lot-view-toggle' }, viewBtn('list', 'Lista'), viewBtn('matrix', 'Macierz')),
    ),
    lotteryRankView === 'matrix' ? matrix : el('div', { className: 'lot-rank' }, ...rankRows),
  );

  const refresh = el('button', { className: 'lot-refresh', disabled: lotteryLoading }, lotteryLoading ? 'Odświeżanie…' : 'Odśwież');
  refresh.addEventListener('click', () => renderLottery(true));

  return el('div', { className: 'lot' },
    header, lede, ticket, buildLotteryMachineSection(d), splitSection, earnSection, rankSection, refresh, mineSection);
}

// ── 🎰 Maszyna losująca (Loteria draw) ──────────────────────────────────────
// A glass drum full of balls — one ball per ticket, so a player with 20 tickets
// physically has 20 balls in there — plus a "siła zakręcenia" control.
//
// ⚠️ The machine is THEATRE. It never decides anything: the winners come from
// supabase/lottery-draw.sql (`lottery_draw_run`), and the animation is fed the
// server's answer. What makes the draw fair is not the animation, it is the
// commit–reveal in that SQL file, which the browser can CHECK — `lotVerifyDraw`
// re-derives every roll from the revealed seed with SubtleCrypto and the panel
// says out loud whether it matched.
//
// ⚠️ PARITY CONTRACT with public.lottery_roll(): the hash input is
// `seed|public_seed|force|round`, the roll is the first 48 bits mod the tickets
// still in the drum, walked against `snapshot` in its stored order. The force
// slider is genuinely mixed into that hash — the operator moves the outcome
// without being able to aim it, because the seed was sealed before they touched
// it. Change one side and verification starts failing on every real draw.
const LOT_MACH_W = 900, LOT_MACH_H = 470;
const LOT_MACH_CX = 262, LOT_MACH_CY = 244, LOT_MACH_R = 168;
const LOT_BALL_R = 6.6;
const LOT_BALL_CAP = 300;            // rendered balls; beyond this it's a proportional sample
const LOT_SOCKET_X0 = 541, LOT_SOCKET_DX = 60, LOT_SOCKET_Y = 398, LOT_SOCKET_R = 21;
const LOT_BOARD_X = 498, LOT_BOARD_W = 386;
const LOT_PORT_X = 400, LOT_PORT_Y = 340;   // the drum's exit port (35° on the shell)
// Ceremony timings. Long on purpose — this is watched by a room, not skimmed.
// Per ball: countdown 2.4s + flight 1.5s + hold 1.7s ≈ 5.6s, and the finale
// holds 2.2× that. The operator sets the pace between balls anyway.
const LOT_EJECT_MS = 1500, LOT_HOLD_MS = 1700;
const LOT_FINALE_HOLD_MULT = 2.2;
const LOT_FORCE_DEFAULT = 62;
// Spin speeds. Deliberately calm: the first pass ran to 7.8 and the balls were a
// blur nobody could follow — you are meant to be able to WATCH a ball come out.
// `force` scales the churn between BASE and BASE+RANGE; the drumroll before each
// release briefly adds a bit more on top.
const LOT_SPIN_BASE = 1.0, LOT_SPIN_RANGE = 2.6, LOT_SPIN_IDLE = 1.05;
const LOT_SURGE_MS = 2400;   // drumroll: a 3-2-1 countdown before the ball drops
const LOT_COUNTDOWN_BEATS = 3;
// Loading: every ball pours in through a hopper above the drum before anything
// else happens, so you SEE the machine being filled with the office's tickets.
// The hopper mouth sits in the headroom above the drum — tight enough that the
// funnel is not clipped by the canvas, high enough that the fall is visible.
const LOT_HOPPER_Y = LOT_MACH_CY - LOT_MACH_R - 24;
const LOT_LOAD_MS = 2600;

// RAF handle is module-level, NOT a field on lotMach — a stale callback must not
// be able to re-arm itself against a machine that has already been replaced.
let lotMach = null;
let lotMachRaf = 0;
// „NA ŻYWO" vs „TEST": test spins the whole ceremony on the REAL ticket table but
// draws the winners in the browser and never calls the server — nothing is
// written and nobody is paid. Admin-only, because a fake winner on a public
// screen would be indistinguishable from a real one to everyone else.
let lotMode = 'live';   // 'live' | 'test'

let lotAutoPlay = null;   // draw id whose result should animate as soon as it renders
let lotteryRtReady = false;

function lotMachineStop() {
  if (lotMachRaf) cancelAnimationFrame(lotMachRaf);
  lotMachRaf = 0;
  if (lotMach && lotMach._ro) { try { lotMach._ro.disconnect(); } catch (_e) {} }
  lotMach = null;
}

// ── Verification (mirrors public.lottery_roll) ──────────────────────────────
async function lotSha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function lotRollFromHex(hex, modulus) {
  if (!modulus || modulus <= 0) return 0;
  return Number(BigInt('0x' + hex.slice(0, 12)) % BigInt(modulus));
}
// Replays the whole draw from the revealed seed. Returns {ok, why}.
async function lotVerifyDraw(row) {
  try {
    if (!row || !row.server_seed || !row.commit_hash) return { ok: false, why: 'Brak ujawnionego ziarna.' };
    if (!crypto?.subtle) return { ok: false, why: 'Ta przeglądarka nie udostępnia SubtleCrypto.' };
    if (await lotSha256Hex(row.server_seed) !== row.commit_hash)
      return { ok: false, why: 'Ziarno nie pasuje do pieczęci sprzed losowania.' };
    const snap = Array.isArray(row.snapshot) ? row.snapshot.slice() : [];
    const wins = Array.isArray(row.winners) ? row.winners : [];
    if (!snap.length || !wins.length) return { ok: false, why: 'Brak zapisu biletów.' };
    for (let k = 1; k <= wins.length; k++) {
      const total = snap.reduce((s, p) => s + (+p.tickets || 0), 0);
      const hex = await lotSha256Hex([row.server_seed, row.public_seed, row.force, k].join('|'));
      const roll = lotRollFromHex(hex, total);
      let cum = 0, idx = -1;
      for (let i = 0; i < snap.length; i++) { cum += (+snap[i].tickets || 0); if (roll < cum) { idx = i; break; } }
      if (idx < 0) idx = snap.length - 1;
      const w = wins[k - 1];
      if (snap[idx].id !== w.id || roll !== Number(w.roll))
        return { ok: false, why: 'Runda ' + k + ' nie zgadza się z zapisem serwera.' };
      snap.splice(idx, 1);
    }
    return { ok: true, why: '' };
  } catch (e) {
    return { ok: false, why: 'Weryfikacja nie przeszła: ' + (e.message || e) };
  }
}

// ── Balls ──────────────────────────────────────────────────────────────────
// ── Balls & colours ────────────────────────────────────────────────────────
// One colour per PERSON, assigned by position in the (ticket-ordered) list
// rather than by hashing their id — a hash spreads hues randomly and reliably
// hands two people near-identical colours, which makes the legend useless. The
// golden angle maximises the gap between consecutive entries, and three tone
// tiers keep them apart once the hue wheel starts wrapping.
const LOT_HUE_GOLDEN = 137.508;
const LOT_TONES = [{ s: 74, l: 52 }, { s: 62, l: 36 }, { s: 88, l: 66 }];

function lotColorAt(i) {
  const t = LOT_TONES[i % LOT_TONES.length];
  return { h: (i * LOT_HUE_GOLDEN) % 360, s: t.s, l: t.l };
}
function lotCss(col) { return 'hsl(' + col.h.toFixed(1) + ' ' + col.s + '% ' + col.l + '%)'; }

// Pure and deterministic for a given ordered list, so the drum, the legend and
// the winners list can never disagree about whose colour is whose. It does its
// own `tickets > 0` filtering because newLotteryMachine does too.
function lotHuesFor(list) {
  const map = new Map();
  (list || []).filter(p => (+p.tickets || 0) > 0).forEach((p, i) => map.set(p.id, lotColorAt(i)));
  return map;
}
function lotColorFor(m, id) {
  return (m.hueOf && m.hueOf.get(id)) || lotColorAt(0);
}

// One ball per ticket, but capped — over the cap it's a proportional sample
// (largest remainder), with every participant guaranteed at least one ball so
// nobody can be drawn out of an empty-looking drum.
function lotAllocBalls(list, cap) {
  const total = list.reduce((s, p) => s + Math.max(0, +p.tickets || 0), 0) || 1;
  const target = Math.max(list.length, Math.min(cap, total));
  const raw = list.map(p => Math.max(0, +p.tickets || 0) / total * target);
  const out = raw.map(r => Math.max(1, Math.floor(r)));
  let used = out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f);
  let g = 0;
  while (used < target && order.length) { out[order[g % order.length].i]++; used++; g++; }
  while (used > target) {
    let bi = -1, bv = 1;
    for (let i = 0; i < out.length; i++) if (out[i] > bv) { bv = out[i]; bi = i; }
    if (bi < 0) break;
    out[bi]--; used--;
  }
  return out;
}

// The backing store follows the RENDERED size, not devicePixelRatio alone —
// otherwise the board goes soft the moment the card is blown up to fullscreen.
// CSS pins the element to the 900:470 aspect, so the x and y scales stay equal.
function lotFitCanvas(m) {
  // ⚠️ In fullscreen the element size is computed HERE, not left to CSS. Letting
  // the canvas size itself (`width:auto`) makes it fall back to its width/height
  // ATTRIBUTES — which this very function just set to the previous rendered size,
  // a feedback loop that pins the board at its inline size forever. `object-fit`
  // is no good either: it letterboxes, so the element box stops being the drawn
  // box and the scale below would be wrong.
  const stage = m.canvas.parentElement;
  if (lotIsFs() && stage) {
    const sr = stage.getBoundingClientRect();
    if (sr.width && sr.height) {
      const k = Math.min(sr.width / LOT_MACH_W, sr.height / LOT_MACH_H);
      m.canvas.style.width = Math.floor(LOT_MACH_W * k) + 'px';
      m.canvas.style.height = Math.floor(LOT_MACH_H * k) + 'px';
    }
  } else if (m.canvas.style.width) {
    m.canvas.style.width = ''; m.canvas.style.height = '';
  }
  const r = m.canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (m.canvas.width === w && m.canvas.height === h) return;
  m.canvas.width = w; m.canvas.height = h;
  m._sx = w / LOT_MACH_W; m._sy = h / LOT_MACH_H;
  lotMachDraw(m);
}

function newLotteryMachine(canvas, players, opts) {
  const o = opts || {};
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(LOT_MACH_W * dpr);
  canvas.height = Math.round(LOT_MACH_H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const list = (players || []).filter(p => (+p.tickets || 0) > 0);
  const hueOf = lotHuesFor(players);
  const counts = lotAllocBalls(list, LOT_BALL_CAP);
  const reduced = plinkoReducedMotion();
  const now = performance.now();
  const balls = [];
  let seq = 0;
  list.forEach((p, pi) => {
    const col = hueOf.get(p.id) || lotColorAt(pi);
    for (let k = 0; k < counts[pi]; k++) {
      balls.push({
        x: LOT_MACH_CX + (Math.random() - 0.5) * 14, y: LOT_HOPPER_Y - 14 - Math.random() * 34,
        vx: (Math.random() - 0.5) * 20, vy: 30 + Math.random() * 40,
        col, pid: p.id, out: false, loaded: false, spawnAt: 0, _seq: seq++,
      });
    }
  });
  // Loading order is shuffled so the stream is a mix of colours rather than all
  // of one person's balls arriving in a block.
  const order = balls.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const stagger = balls.length ? LOT_LOAD_MS / balls.length : 0;
  order.forEach((bi, k) => { balls[bi].spawnAt = now + k * stagger; });

  const m = {
    canvas, ctx, balls, players: list, hueOf, _dpr: dpr, _sx: dpr, _sy: dpr,
    totalTickets: list.reduce((s, p) => s + (+p.tickets || 0), 0),
    sockets: new Array(LOTTERY_TIERS.length).fill(null),
    phase: 'load', spin: 0, targetSpin: 0, spinAngle: 0,
    flying: null, queue: [], reveal: null, revealT: 0, awaiting: false,
    confetti: [], flash: 0, shake: 0,
    trail: [], shock: [], dust: [], rayAngle: 0,
    spinUntil: 0, surgeUntil: 0, holdUntil: 0, last: 0, force: LOT_FORCE_DEFAULT,
    running: false, drawId: o.drawId || null,
    headline: o.headline || '', subline: o.subline || '',
    loadDoneAt: now + LOT_LOAD_MS + 700,
    onReveal: o.onReveal || null, onDone: o.onDone || null,
    onAwait: o.onAwait || null, onBusy: o.onBusy || null, onLoaded: o.onLoaded || null,
    _grid: new Map(),
  };
  lotMachineStop();
  lotMach = m;
  // A ResizeObserver keeps the backing store right through fullscreen and window
  // resizes without reading layout on every frame.
  if (window.ResizeObserver) {
    // observe the STAGE, never the canvas — lotFitCanvas sets the canvas's own
    // style size, which would retrigger a canvas observer on every frame
    m._ro = new ResizeObserver(() => { if (lotMach === m) lotFitCanvas(m); });
    m._ro.observe(canvas.parentElement || canvas);
  }
  if (reduced) {
    m.balls.forEach(b => { b.spawnAt = 0; b.loaded = true; });
    m.phase = 'idle'; m.loadDoneAt = 0;
    lotMachSettle(m);
    lotMachDraw(m);
    if (m.onLoaded) { const cb = m.onLoaded; m.onLoaded = null; try { cb(); } catch (_e) {} }
  } else {
    lotMachRaf = requestAnimationFrame(lotMachFrame);
  }
  return m;
}

function lotMachLoading(m) {
  return m.phase === 'load';
}

// Drop everything to the bottom without animating — the reduced-motion path and
// the "this draw already happened" resting state.
function lotMachSettle(m) {
  const cols = Math.floor((LOT_MACH_R * 2 - 20) / (LOT_BALL_R * 2.05));
  m.balls.forEach((b, i) => {
    b.loaded = true; b.spawnAt = 0;
    const row = Math.floor(i / cols), col = i % cols;
    b.x = LOT_MACH_CX - (cols / 2 - col - 0.5) * LOT_BALL_R * 2.05;
    b.y = LOT_MACH_CY + LOT_MACH_R - 14 - row * LOT_BALL_R * 1.85;
    b.vx = b.vy = 0;
    const dx = b.x - LOT_MACH_CX, dy = b.y - LOT_MACH_CY, d = Math.hypot(dx, dy);
    if (d > LOT_MACH_R - LOT_BALL_R - 3) {
      const k = (LOT_MACH_R - LOT_BALL_R - 3) / d;
      b.x = LOT_MACH_CX + dx * k; b.y = LOT_MACH_CY + dy * k;
    }
  });
  m.spin = m.targetSpin = 0;
}

// Fills the chute with an already-finished draw (page load / reload after a draw).
function lotMachShowResult(m, winners) {
  (winners || []).forEach(w => {
    const i = (+w.place || 0) - 1;
    if (i >= 0 && i < m.sockets.length) m.sockets[i] = { col: lotColorFor(m, w.id), place: +w.place };
    const b = m.balls.find(x => !x.out && x.pid === w.id);
    if (b) b.out = true;
  });
  const top = (winners || []).find(w => +w.place === 1) || (winners || [])[0];
  if (top) { m.reveal = top; m.revealT = 1; }
  m.phase = 'done';
  m.awaiting = false; m.queue = [];
  lotMachSettle(m);
  lotMachDraw(m);
}

// Start the blind spin. The result may not have arrived yet — that's the point:
// the drum tumbles while lottery_draw_run is in flight, exactly like Rakieta's
// countdown, and `lotMachDeliver` blends the server's answer in when it lands.
function lotForceSpin(force) {
  return LOT_SPIN_BASE + (Math.max(1, Math.min(100, +force || LOT_FORCE_DEFAULT)) / 100) * LOT_SPIN_RANGE;
}

function lotMachSpin(m, force) {
  m.force = Math.max(1, Math.min(100, +force || LOT_FORCE_DEFAULT));
  m.phase = 'spin';
  m.running = true;
  m.sockets.fill(null);
  m.reveal = null; m.revealT = 0;
  m.queue = [];
  m.awaiting = false;
  m.confetti = []; m.flash = 0; m.shake = 0;
  m.trail = []; m.shock = []; m.dust = []; m.rayAngle = 0;
  // Clearing `flying` matters: it points at a ball we are about to mark as back
  // in the drum, and lotMachStep processes a flight regardless of phase — so a
  // leftover one would land and fill a socket during the new spin.
  m.flying = null; m.holdUntil = 0;
  m.balls.forEach(b => { b.out = false; });
  // Force is force: a hard spin churns faster AND settles sooner; a limp one
  // rattles around for longer before the machine will give anything up.
  m.targetSpin = lotForceSpin(m.force);
  m.spinUntil = performance.now() + 2200 + (100 - m.force) * 14;
  if (plinkoReducedMotion()) m.spinUntil = performance.now() + 200;
  if (!lotMachRaf) { m.last = 0; lotMachRaf = requestAnimationFrame(lotMachFrame); }
}

// ⚠️ Reveal order is LOWEST PLACE FIRST (6 → 1) — an awards-ceremony order, and
// PRESENTATION ONLY: the server still draws round 1 = 1st place, so the biggest
// ticket holders keep the best shot at the top prize. Reversing it in SQL instead
// would break the parity contract for no gain.
function lotMachDeliver(m, winners) {
  m.queue = (winners || []).slice().sort((a, b) => (+b.place || 0) - (+a.place || 0));
}

// One click, one ball. The drum keeps turning between releases so the ceremony
// stays alive instead of freezing on a still frame while everyone looks up.
function lotMachRelease(m) {
  if (!m || !m.awaiting || !m.queue.length || m.flying) return false;
  m.awaiting = false;
  // Drop the previous winner NOW. The reveal branch in lotDrawPanel is the last
  // one checked, so a lingering `reveal` is what the panel shows for the whole
  // ~1s flight of the NEXT ball — i.e. the previous place, mid-spin.
  m.reveal = null; m.revealT = 0;
  m.phase = 'surge';
  m.surgeUntil = performance.now() + (plinkoReducedMotion() ? 1 : LOT_SURGE_MS);
  m.targetSpin = LOT_SPIN_BASE + LOT_SPIN_RANGE + 1.4;   // drumroll
  if (m.onBusy) { try { m.onBusy(m.queue[0]); } catch (_e) {} }
  if (!lotMachRaf) { m.last = 0; lotMachRaf = requestAnimationFrame(lotMachFrame); }
  return true;
}

// The force slider is live: it drives the drum WHILE you set it, so you pick a
// speed by watching the balls rather than by guessing at a number. What you set
// idling is exactly what the spin commits to (same formula as lotMachSpin).
function lotMachPreviewForce(m, force) {
  if (!m || plinkoReducedMotion()) return;
  // Live before the spin AND between balls (`awaiting`) — but never during the
  // blind spin, the drumroll or a flight. ⚠️ Once the drum is turning the result
  // is already drawn and stored, so mid-ceremony the slider changes how fast the
  // drum churns and nothing else. Leaving it live during the blind spin would
  // imply it still steers the outcome, which by then it does not.
  if (m.phase !== 'idle' && !m.awaiting) return;
  m.force = Math.max(1, Math.min(100, +force || LOT_FORCE_DEFAULT));
  m.targetSpin = lotForceSpin(m.force);
  if (!lotMachRaf) { m.last = 0; lotMachRaf = requestAnimationFrame(lotMachFrame); }
}

function lotMachAwait(m) {
  m.awaiting = true;
  m.phase = 'spin';
  m.targetSpin = lotForceSpin(m.force);   // whatever the slider currently says
  if (m.onAwait) { try { m.onAwait(m.queue[0]); } catch (_e) {} }
}

function lotMachFail(m, msg) {
  m.phase = 'done'; m.running = false; m.queue = []; m.awaiting = false;
  m.headline = msg || 'Losowanie nie doszło do skutku';
  m.targetSpin = 0;
}

function lotSocketPos(i) {
  return { x: LOT_SOCKET_X0 + i * LOT_SOCKET_DX, y: LOT_SOCKET_Y };
}

function lotMachStartEject(m, ts) {
  const win = m.queue.shift();
  if (!win) return;
  m.reveal = null; m.revealT = 0;   // belt and braces: the flight must show nothing
  const ball = m.balls.find(b => !b.out && b.loaded && b.pid === win.id)
            || m.balls.find(b => !b.out && b.loaded);
  if (!ball) { m.phase = 'done'; m.running = false; return; }
  ball.out = true;
  ball.col = lotColorFor(m, win.id);
  const sock = lotSocketPos(Math.max(0, (+win.place || 1) - 1));
  m.flying = {
    ball, win, place: +win.place || 1, t: 0, dur: plinkoReducedMotion() ? 1 : LOT_EJECT_MS,
    x0: ball.x, y0: ball.y, x1: sock.x, y1: sock.y,
    c1x: LOT_PORT_X, c1y: LOT_PORT_Y, c2x: 506, c2y: 428,
  };
  m.trail = [];
  m.phase = 'eject';
  m.targetSpin = LOT_SPIN_IDLE + 0.8;
}

function lotSpawnConfetti(m, x, y, n, spread) {
  if (plinkoReducedMotion()) return;
  const arc = spread || 2.4;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * arc;
    const sp = 220 + Math.random() * 520;
    m.confetti.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      rot: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 16,
      w: 4 + Math.random() * 6, h: 7 + Math.random() * 9,
      col: lotColorAt(Math.floor(Math.random() * 12)), life: 1,
    });
  }
}

// Expanding ring where a ball lands.
function lotSpawnShock(m, x, y, big) {
  if (plinkoReducedMotion()) return;
  m.shock.push({ x, y, t: 0, dur: big ? 1100 : 700, max: big ? 420 : 190 });
}

// Golden dust drifting up behind the winner's name — finale only.
function lotSpawnDust(m, n) {
  if (plinkoReducedMotion()) return;
  for (let i = 0; i < n; i++) {
    m.dust.push({
      x: LOT_BOARD_X + 10 + Math.random() * (LOT_BOARD_W - 20),
      y: LOT_MACH_H * 0.55 + Math.random() * 120,
      vx: (Math.random() - 0.5) * 22, vy: -(14 + Math.random() * 46),
      r: 1 + Math.random() * 2.6, life: 1, tw: Math.random() * 6.283,
    });
  }
}

function lotMachFrame(ts) {
  const m = lotMach;
  if (!m || !m.canvas.isConnected) { lotMachineStop(); return; }
  lotMachRaf = requestAnimationFrame(lotMachFrame);
  const dt = Math.min(0.05, m.last ? (ts - m.last) / 1000 : 0.016);
  m.last = ts;
  lotMachStep(m, dt, ts);
  lotMachDraw(m);
}

function lotMachStep(m, dt, ts) {
  // ── loading: balls pour in from the hopper before anything else happens ──
  if (m.phase === 'load' && ts >= m.loadDoneAt && m.balls.every(b => b.loaded)) {
    m.phase = 'idle';
    m.targetSpin = LOT_SPIN_IDLE * 0.7;
    // onLoaded may call lotMachPreviewForce, which needs phase to be 'idle' already
    if (m.onLoaded) { const cb = m.onLoaded; m.onLoaded = null; try { cb(); } catch (_e) {} }
  }

  // blind spin finished and the server's answer is in → hand over to the operator
  if (m.phase === 'spin' && !m.awaiting && ts >= m.spinUntil && m.queue.length) lotMachAwait(m);
  if (m.phase === 'surge' && ts >= m.surgeUntil) lotMachStartEject(m, ts);

  if (m.flying) {
    const f = m.flying;
    f.t += dt * 1000;
    const p = Math.min(1, f.t / f.dur), e = 1 - Math.pow(1 - p, 3), u = 1 - e;
    f.ball.x = u * u * u * f.x0 + 3 * u * u * e * f.c1x + 3 * u * e * e * f.c2x + e * e * e * f.x1;
    f.ball.y = u * u * u * f.y0 + 3 * u * u * e * f.c1y + 3 * u * e * e * f.c2y + e * e * e * f.y1;
    if (p >= 1) {
      const first = f.place === 1;
      m.sockets[f.place - 1] = { col: f.ball.col, place: f.place, at: ts };
      m.reveal = f.win; m.revealT = 0;
      m.flying = null;
      m.flash = first ? 1 : 0.6;
      m.shake = first ? 1.25 : 0.45;
      m.trail = [];
      lotSpawnShock(m, f.x1, f.y1, first);
      if (first) {
        lotSpawnConfetti(m, f.x1, f.y1, 90);
        lotSpawnConfetti(m, LOT_BOARD_X + LOT_BOARD_W * 0.5, 200, 90, 3.0);
        lotSpawnConfetti(m, LOT_BOARD_X + 30, 120, 60, 1.6);
        lotSpawnConfetti(m, LOT_BOARD_X + LOT_BOARD_W - 30, 120, 60, 1.6);
        lotSpawnDust(m, 90);
      } else {
        lotSpawnConfetti(m, f.x1, f.y1, 26, 1.7);
      }
      m.holdUntil = ts + (plinkoReducedMotion() ? 1
        : (first ? Math.round(LOT_HOLD_MS * LOT_FINALE_HOLD_MULT) : LOT_HOLD_MS));
      if (m.onReveal) { try { m.onReveal(f.win); } catch (_e) {} }
    }
  } else if (m.phase === 'eject' && ts >= m.holdUntil) {
    if (m.queue.length) lotMachAwait(m);
    else {
      m.phase = 'done'; m.running = false; m.targetSpin = 0.25;
      if (m.onDone) { const cb = m.onDone; m.onDone = null; try { cb(); } catch (_e) {} }
    }
  }

  m.now = ts;   // the draw must render the frame that was just simulated
  m.spin += (m.targetSpin - m.spin) * Math.min(1, dt * 2.4);
  m.spinAngle += m.spin * dt;
  m.rayAngle += dt * 0.25;
  if (m.reveal) m.revealT = Math.min(1, m.revealT + dt * 2.1);
  m.flash = Math.max(0, m.flash - dt * 2.1);
  m.shake = Math.max(0, m.shake - dt * 2.2);

  // motion trail behind the ball in flight
  if (m.flying) {
    m.trail.push({ x: m.flying.ball.x, y: m.flying.ball.y, life: 1 });
    if (m.trail.length > 26) m.trail.shift();
  }
  for (const t of m.trail) t.life -= dt * 1.9;
  m.trail = m.trail.filter(t => t.life > 0);

  for (const r of m.shock) r.t += dt * 1000;
  m.shock = m.shock.filter(r => r.t < r.dur);

  if (m.dust.length) {
    for (const g of m.dust) {
      g.x += g.vx * dt; g.y += g.vy * dt; g.vy -= 6 * dt;
      g.tw += dt * 7; g.life -= dt * 0.3;
    }
    m.dust = m.dust.filter(g => g.life > 0 && g.y > -20);
  }

  // a second confetti wave a beat after the finale lands, so it does not all
  // fall out of frame at once
  if (m.reveal && +m.reveal.place === 1 && !m._wave2 && m.revealT > 0.45) {
    m._wave2 = true;
    lotSpawnConfetti(m, LOT_BOARD_X + LOT_BOARD_W * 0.35, 150, 70, 2.6);
    lotSpawnConfetti(m, LOT_BOARD_X + LOT_BOARD_W * 0.65, 150, 70, 2.6);
    lotSpawnDust(m, 60);
  }
  if (!m.reveal) m._wave2 = false;
  if (m.confetti.length) {
    for (const p of m.confetti) {
      p.vy += 900 * dt; p.vx *= 0.995;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.spin * dt;
      p.life -= dt * 0.42;
    }
    m.confetti = m.confetti.filter(p => p.life > 0 && p.y < LOT_MACH_H + 40);
  }
  lotMachPhysics(m, dt, ts);
}

// Measured over a jet × spread sweep: centre-weighted, no ring, no hollow core.
// ⚠️ Tuned DOWN from jet 420 / spread 900 — that mixed beautifully but the balls
// were a blur. Speed here is a readability constraint, not just a taste one: the
// whole point is watching one ball leave the drum.
const LOT_PHYS = { jet: 300, spread: 300, tan: 22, drag: 0.982 };

function lotMachPhysics(m, dt, ts) {
  const cx = LOT_MACH_CX, cy = LOT_MACH_CY, R = LOT_MACH_R - LOT_BALL_R - 3;
  const swirl = m.spin;
  const grav = 640;                                     // never switched off
  const drag = Math.pow(LOT_PHYS.drag, dt * 60);
  const jetTop = cy - R * 0.35, jetSpan = R * 1.35;
  for (const b of m.balls) {
    if (b.out || ts < b.spawnAt) continue;
    // Still falling in through the hopper: gravity only, and NO wall — the shell
    // constraint would teleport it straight into the drum from above.
    if (!b.loaded) {
      b.vy += grav * dt;
      b.vx *= drag; b.vy *= drag;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (Math.hypot(b.x - cx, b.y - cy) <= R) b.loaded = true;
      continue;
    }
    let dx = b.x - cx, dy = b.y - cy, d = Math.hypot(dx, dy) || 1;
    // The jet: full strength along the floor, gone by the upper third, so a ball
    // thrown high falls back through the ones still coming up.
    const h = Math.min(1, (b.y - jetTop) / jetSpan);
    if (h > 0) b.vy -= swirl * LOT_PHYS.jet * h * dt;
    b.vx += (Math.random() - 0.5) * swirl * LOT_PHYS.spread * dt;
    b.vy += (Math.random() - 0.5) * swirl * LOT_PHYS.spread * 0.5 * dt;
    // a slow rotation on top, so the whole mass visibly turns with the agitator
    b.vx += (-dy / d) * swirl * LOT_PHYS.tan * dt;
    b.vy += (dx / d) * swirl * LOT_PHYS.tan * dt;
    b.vy += grav * dt;
    b.vx *= drag; b.vy *= drag;
    b.x += b.vx * dt; b.y += b.vy * dt;
    dx = b.x - cx; dy = b.y - cy; d = Math.hypot(dx, dy);
    if (d > R) {
      const nx = dx / d, ny = dy / d, vn = b.vx * nx + b.vy * ny;
      b.x = cx + nx * R; b.y = cy + ny * R;
      b.vx -= 1.45 * vn * nx; b.vy -= 1.45 * vn * ny;   // restitution ≈ .45
      b.vx *= 0.93; b.vy *= 0.93;
    }
  }
  lotMachSeparate(m, ts);
}

// Uniform-grid separation: 300 balls is 45k naive pairs per frame, which is the
// difference between a smooth drum and a slideshow on an office laptop.
function lotMachSeparate(m, ts) {
  const cell = LOT_BALL_R * 2;
  const cols = Math.ceil((LOT_MACH_R * 2) / cell) + 3;
  const ox = LOT_MACH_CX - LOT_MACH_R - cell, oy = LOT_MACH_CY - LOT_MACH_R - cell;
  const grid = m._grid;
  grid.clear();
  for (const b of m.balls) {
    if (b.out || !b.loaded || ts < b.spawnAt) continue;
    b._gx = Math.floor((b.x - ox) / cell); b._gy = Math.floor((b.y - oy) / cell);
    const k = b._gy * cols + b._gx;
    const arr = grid.get(k);
    if (arr) arr.push(b); else grid.set(k, [b]);
  }
  const min = LOT_BALL_R * 2;
  for (const b of m.balls) {
    if (b.out || !b.loaded || ts < b.spawnAt) continue;
    for (let gy = 0; gy <= 1; gy++) for (let gx = -1; gx <= 1; gx++) {
      if (gy === 0 && gx < 0) continue;
      const arr = grid.get((b._gy + gy) * cols + (b._gx + gx));
      if (!arr) continue;
      for (const o of arr) {
        if (o === b || (gy === 0 && gx === 0 && o._seq <= b._seq)) continue;
        const dx = o.x - b.x, dy = o.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 === 0) continue;
        const d = Math.sqrt(d2), push = (min - d) / 2, nx = dx / d, ny = dy / d;
        b.x -= nx * push; b.y -= ny * push;
        o.x += nx * push; o.y += ny * push;
        const rel = (o.vx - b.vx) * nx + (o.vy - b.vy) * ny;
        if (rel < 0) {
          const j = rel * 0.5;
          b.vx += j * nx; b.vy += j * ny; o.vx -= j * nx; o.vy -= j * ny;
        }
      }
    }
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────
function lotRoundRect(c, x, y, w, h, r) {
  c.beginPath();
  if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function lotFitText(c, str, maxW) {
  let s = String(str || '');
  if (c.measureText(s).width <= maxW) return s;
  while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

function lotMachDraw(m) {
  const c = m.ctx;
  const now = m.now || (m.now = performance.now());
  c.setTransform(m._sx, 0, 0, m._sy, 0, 0);   // also resets last frame's shake
  c.clearRect(0, 0, LOT_MACH_W, LOT_MACH_H);
  // Camera shake: a landing thump, plus a rumble that BUILDS through the
  // countdown so the room can feel the ball coming.
  let shake = m.shake * m.shake * 8;
  if (m.phase === 'surge') {
    const left = Math.max(0, m.surgeUntil - now);
    shake += 2.2 * (1 - left / LOT_SURGE_MS);
  }
  if (shake > 0.05) c.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  const finale = (m.queue.length === 1 && m.queue[0] && +m.queue[0].place === 1)
    || (m.flying && m.flying.place === 1);
  lotDrawStand(c, m);
  lotDrawHopper(c, m, now);
  lotDrawDrum(c, m, now);
  lotDrawBoard(c, m);   // before the chute, so the tube reads as feeding into it
  if (finale) lotDrawVignette(c, m);
  if (m.reveal && +m.reveal.place === 1) lotDrawRays(c, m);
  lotDrawChute(c, m, now);
  lotDrawShock(c, m);
  lotDrawPanel(c, m, now);
  lotDrawDust(c, m);
  lotDrawCountdown(c, m, now);
  lotDrawConfetti(c, m);
  if (m.flash > 0.01) {
    c.fillStyle = 'rgba(255,255,255,' + (m.flash * 0.55).toFixed(3) + ')';
    c.fillRect(-20, -20, LOT_MACH_W + 40, LOT_MACH_H + 40);
  }
}

function lotDrawVignette(c, m) {
  const g = c.createRadialGradient(LOT_BOARD_X + LOT_BOARD_W / 2, 200, 90,
                                   LOT_BOARD_X + LOT_BOARD_W / 2, 200, 620);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(40,30,10,.30)');
  c.fillStyle = g;
  c.fillRect(0, 0, LOT_MACH_W, LOT_MACH_H);
}

function lotDrawShock(c, m) {
  for (const r of m.shock) {
    const k = r.t / r.dur;
    c.save();
    c.globalAlpha = (1 - k) * 0.7;
    c.strokeStyle = '#b7791f';
    c.lineWidth = 5 * (1 - k) + 1;
    c.beginPath(); c.arc(r.x, r.y, 10 + k * r.max, 0, Math.PI * 2); c.stroke();
    c.restore();
  }
}

// Slow rotating light rays behind the winner's name — finale only.
function lotDrawRays(c, m) {
  const cx = LOT_BOARD_X + LOT_BOARD_W * 0.5, cy = 165;
  c.save();
  c.beginPath();
  lotRoundRect(c, LOT_BOARD_X, 34, LOT_BOARD_W, LOT_MACH_H - 70, 14);
  c.clip();
  c.translate(cx, cy);
  c.rotate(m.rayAngle);
  c.globalAlpha = 0.16 * Math.min(1, m.revealT * 1.6);
  c.fillStyle = '#e0a83c';
  for (let i = 0; i < 12; i++) {
    c.rotate(Math.PI / 6);
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(560, -34);
    c.lineTo(560, 34);
    c.closePath();
    c.fill();
  }
  c.restore();
}

function lotDrawDust(c, m) {
  for (const g of m.dust) {
    c.save();
    c.globalAlpha = Math.max(0, Math.min(1, g.life)) * (0.45 + 0.55 * Math.abs(Math.sin(g.tw)));
    c.fillStyle = '#e0a83c';
    c.beginPath(); c.arc(g.x, g.y, g.r, 0, Math.PI * 2); c.fill();
    c.restore();
  }
}

// 3 - 2 - 1 across the drumroll. The hero of the surge; the panel keeps only
// the small "which place is coming" label so the two do not fight.
function lotDrawCountdown(c, m, now) {
  if (m.phase !== 'surge') return;
  const left = Math.max(0, m.surgeUntil - now);
  const per = LOT_SURGE_MS / LOT_COUNTDOWN_BEATS;
  const beat = Math.min(LOT_COUNTDOWN_BEATS, Math.max(1, Math.ceil(left / per)));
  const k = 1 - ((left % per) / per);          // 0 → 1 within this beat
  const pop = k < 0.25 ? k / 0.25 : 1;
  c.save();
  c.translate(LOT_BOARD_X + LOT_BOARD_W * 0.5, 262);
  c.scale(0.55 + 0.75 * pop, 0.55 + 0.75 * pop);
  c.globalAlpha = 0.22 + 0.78 * (1 - k) * pop;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = '800 132px system-ui, sans-serif';
  c.lineWidth = 8; c.strokeStyle = 'rgba(255,255,255,.9)';
  c.strokeText(String(beat), 0, 0);
  c.fillStyle = '#b7791f';
  c.fillText(String(beat), 0, 0);
  c.restore();
}

function lotDrawConfetti(c, m) {
  for (const p of m.confetti) {
    c.save();
    c.globalAlpha = Math.max(0, Math.min(1, p.life));
    c.translate(p.x, p.y);
    c.rotate(p.rot);
    c.fillStyle = lotCss(p.col);
    c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    c.restore();
  }
}

// The hopper the balls pour out of while the machine loads.
function lotDrawHopper(c, m, now) {
  const cx = LOT_MACH_CX, loading = m.phase === 'load';
  c.save();
  c.fillStyle = loading ? 'rgba(150,138,112,.55)' : 'rgba(150,138,112,.26)';
  c.beginPath();
  c.moveTo(cx - 50, LOT_HOPPER_Y - 30);
  c.lineTo(cx + 50, LOT_HOPPER_Y - 30);
  c.lineTo(cx + 10, LOT_HOPPER_Y + 5);
  c.lineTo(cx - 10, LOT_HOPPER_Y + 5);
  c.closePath();
  c.fill();
  c.fillStyle = 'rgba(255,255,255,.5)';
  c.beginPath();
  c.moveTo(cx - 44, LOT_HOPPER_Y - 26);
  c.lineTo(cx - 5, LOT_HOPPER_Y + 2);
  c.lineTo(cx + 2, LOT_HOPPER_Y + 2);
  c.lineTo(cx - 37, LOT_HOPPER_Y - 26);
  c.closePath();
  c.fill();
  c.restore();
}

// The results board the chute empties into. Without it the right half is just
// empty canvas whenever nothing is being revealed.
function lotDrawBoard(c, m) {
  lotRoundRect(c, LOT_BOARD_X, 34, LOT_BOARD_W, LOT_MACH_H - 70, 14);
  c.fillStyle = 'rgba(255,255,255,.55)';
  c.fill();
  c.strokeStyle = 'rgba(150,138,112,.28)'; c.lineWidth = 1;
  c.stroke();
  const y = LOT_SOCKET_Y - LOT_SOCKET_R - 20;
  c.strokeStyle = 'rgba(150,138,112,.22)';
  c.beginPath(); c.moveTo(LOT_BOARD_X + 18, y); c.lineTo(LOT_BOARD_X + LOT_BOARD_W - 18, y); c.stroke();
  c.fillStyle = '#a39d8d';
  c.font = '800 9.5px system-ui, sans-serif';
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillText('WYLOSOWANE KULE', LOT_BOARD_X + 18, y - 9);
}

function lotDrawStand(c, m) {
  c.save();
  c.globalAlpha = 0.16;
  c.fillStyle = '#8a7a5c';
  c.beginPath();
  c.ellipse(LOT_MACH_CX, LOT_MACH_CY + LOT_MACH_R + 34, LOT_MACH_R * 0.78, 15, 0, 0, Math.PI * 2);
  c.fill();
  c.restore();
  const top = LOT_MACH_CY + LOT_MACH_R - 6, bot = LOT_MACH_CY + LOT_MACH_R + 36;
  const g = c.createLinearGradient(LOT_MACH_CX - 60, 0, LOT_MACH_CX + 60, 0);
  g.addColorStop(0, '#9a8a6d'); g.addColorStop(.45, '#cbbb98'); g.addColorStop(1, '#8d7d61');
  c.fillStyle = g;
  c.beginPath();
  c.moveTo(LOT_MACH_CX - 34, top); c.lineTo(LOT_MACH_CX + 34, top);
  c.lineTo(LOT_MACH_CX + 62, bot); c.lineTo(LOT_MACH_CX - 62, bot);
  c.closePath(); c.fill();
}

function lotDrawDrum(c, m, now) {
  const cx = LOT_MACH_CX, cy = LOT_MACH_CY, R = LOT_MACH_R;

  // chrome rim
  const rim = c.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  rim.addColorStop(0, '#e8e2d3'); rim.addColorStop(.35, '#b7a98c');
  rim.addColorStop(.6, '#efeadd'); rim.addColorStop(1, '#9c8f74');
  c.strokeStyle = rim; c.lineWidth = 9;
  c.beginPath(); c.arc(cx, cy, R + 5, 0, Math.PI * 2); c.stroke();

  // drumroll ring: the wind-up between the click and the ball dropping
  if (m.phase === 'surge') {
    const pulse = 0.5 + 0.5 * Math.sin(now / 70);
    c.strokeStyle = 'rgba(183,121,31,' + (0.35 + pulse * 0.5).toFixed(3) + ')';
    c.lineWidth = 3 + pulse * 4;
    c.beginPath(); c.arc(cx, cy, R + 13, 0, Math.PI * 2); c.stroke();
  }

  // glass body
  const glass = c.createRadialGradient(cx - R * .35, cy - R * .45, R * .1, cx, cy, R);
  glass.addColorStop(0, 'rgba(255,255,255,.96)');
  glass.addColorStop(.62, 'rgba(246,244,238,.9)');
  glass.addColorStop(1, 'rgba(214,208,193,.92)');
  c.fillStyle = glass;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();

  // agitator arms — the only thing that shows the drum is actually turning
  c.save();
  c.beginPath(); c.arc(cx, cy, R - 1, 0, Math.PI * 2); c.clip();
  c.translate(cx, cy); c.rotate(m.spinAngle);
  c.strokeStyle = 'rgba(150,138,112,.30)'; c.lineWidth = 5; c.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    c.rotate((Math.PI * 2) / 3);
    c.beginPath(); c.moveTo(0, 0); c.lineTo(R - 22, 0); c.stroke();
  }
  c.fillStyle = 'rgba(150,138,112,.35)';
  c.beginPath(); c.arc(0, 0, 11, 0, Math.PI * 2); c.fill();
  c.restore();

  // the balls (including any still falling in from the hopper)
  for (const b of m.balls) {
    if (b.out || now < b.spawnAt) continue;
    lotDrawBall(c, b.x, b.y, LOT_BALL_R, b.col);
  }
  if (m.flying) {
    for (const t of m.trail) {
      c.save();
      c.globalAlpha = Math.max(0, t.life) * 0.5;
      lotDrawBall(c, t.x, t.y, LOT_BALL_R * (0.35 + 0.6 * t.life), m.flying.ball.col);
      c.restore();
    }
    lotDrawBall(c, m.flying.ball.x, m.flying.ball.y, LOT_BALL_R + 2.2, m.flying.ball.col, true);
  }

  // exit port
  c.fillStyle = '#7d7360';
  c.beginPath(); c.arc(LOT_PORT_X, LOT_PORT_Y, 12, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#3f3a31';
  c.beginPath(); c.arc(LOT_PORT_X, LOT_PORT_Y, 8.5, 0, Math.PI * 2); c.fill();

  // specular highlight, drawn last so it reads as glass in front of the balls
  c.save();
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();
  const spec = c.createLinearGradient(cx - R, cy - R, cx + R * .3, cy + R * .5);
  spec.addColorStop(0, 'rgba(255,255,255,.72)');
  spec.addColorStop(.42, 'rgba(255,255,255,.06)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = spec;
  c.beginPath(); c.ellipse(cx - R * .3, cy - R * .32, R * .72, R * .5, -0.5, 0, Math.PI * 2); c.fill();
  c.restore();
  c.strokeStyle = 'rgba(255,255,255,.75)'; c.lineWidth = 2;
  c.beginPath(); c.arc(cx, cy, R - 1.5, 0, Math.PI * 2); c.stroke();

  // caption under the drum
  c.fillStyle = '#8b8577';
  c.font = '700 11px system-ui, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  const shown = m.balls.length, tot = m.totalTickets;
  let cap;
  if (m.phase === 'load') {
    const inside = m.balls.filter(b => b.loaded).length;
    cap = 'Ładowanie kul… ' + inside + ' / ' + shown;
  } else {
    cap = shown < tot
      ? shown + ' kul (próbka z ' + lotNum(tot) + ' biletów)'
      : lotNum(tot) + (tot === 1 ? ' bilet' : ' biletów') + ' w bębnie';
  }
  c.fillText(cap, cx, LOT_MACH_CY + LOT_MACH_R + 50);
}

function lotDrawBall(c, x, y, r, col, glow) {
  const cc = col || lotColorAt(0);
  if (glow) {
    c.save(); c.globalAlpha = .35;
    c.fillStyle = lotCss(cc);
    c.beginPath(); c.arc(x, y, r * 2.1, 0, Math.PI * 2); c.fill();
    c.restore();
  }
  const g = c.createRadialGradient(x - r * .4, y - r * .45, r * .12, x, y, r);
  g.addColorStop(0, 'hsl(' + cc.h.toFixed(1) + ' ' + Math.min(100, cc.s + 18) + '% ' + Math.min(92, cc.l + 26) + '%)');
  g.addColorStop(.55, lotCss(cc));
  g.addColorStop(1, 'hsl(' + cc.h.toFixed(1) + ' ' + cc.s + '% ' + Math.max(14, cc.l - 16) + '%)');
  c.fillStyle = g;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.fillStyle = 'rgba(255,255,255,.75)';
  c.beginPath(); c.arc(x - r * .34, y - r * .38, r * .26, 0, Math.PI * 2); c.fill();
}

function lotDrawChute(c, m, now) {
  // tube from the port down to the socket row
  c.save();
  c.lineCap = 'round';
  for (const pass of [{ s: 'rgba(150,138,112,.34)', w: 17 }, { s: 'rgba(255,255,255,.6)', w: 9 }]) {
    c.strokeStyle = pass.s; c.lineWidth = pass.w;
    c.beginPath();
    c.moveTo(LOT_PORT_X, LOT_PORT_Y);
    c.bezierCurveTo(LOT_PORT_X + 44, LOT_PORT_Y + 48, 470, 428, LOT_SOCKET_X0 - 30, LOT_SOCKET_Y);
    c.stroke();
  }
  c.restore();

  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (let i = 0; i < m.sockets.length; i++) {
    const p = lotSocketPos(i), s = m.sockets[i];
    c.fillStyle = 'rgba(0,0,0,.05)';
    c.beginPath(); c.arc(p.x, p.y + 2, LOT_SOCKET_R, 0, Math.PI * 2); c.fill();
    // the ball that just arrived keeps a pulsing halo for a moment
    // ⚠️ CLAMP: this radius comes from a time delta, and canvas `arc` THROWS on a
    // negative radius — which aborts the rest of the frame, blanking the chute and
    // the result panel. Any clock hiccup (a backgrounded tab resuming, a stepped
    // clock in a test harness) is otherwise enough to break rendering.
    if (s && s.at && now - s.at < 1400) {
      const k = Math.max(0, Math.min(1, 1 - (now - s.at) / 1400));
      c.strokeStyle = 'rgba(183,121,31,' + (k * 0.75).toFixed(3) + ')';
      c.lineWidth = 2 + k * 5;
      c.beginPath(); c.arc(p.x, p.y, LOT_SOCKET_R + 4 + (1 - k) * 7, 0, Math.PI * 2); c.stroke();
    }
    c.strokeStyle = s ? 'rgba(183,121,31,.55)' : 'rgba(150,138,112,.38)';
    c.lineWidth = s ? 2 : 1.5;
    c.setLineDash(s ? [] : [3, 3]);
    c.beginPath(); c.arc(p.x, p.y, LOT_SOCKET_R, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    if (s) lotDrawBall(c, p.x, p.y, LOT_SOCKET_R - 5, s.col);
    c.fillStyle = s ? '#b7791f' : '#b8b2a4';
    c.font = '800 10px system-ui, sans-serif';
    c.fillText((i + 1) + '.', p.x, p.y + LOT_SOCKET_R + 11);
  }
}

// The right-hand readout: what the machine is doing, and who just came out.
function lotDrawPanel(c, m, now) {
  const x = LOT_BOARD_X + 18, w = LOT_BOARD_W - 36;
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';

  c.fillStyle = '#a39d8d';
  c.font = '800 10px system-ui, sans-serif';
  c.fillText('WYNIK LOSOWANIA', x, 54);
  c.strokeStyle = 'rgba(150,138,112,.3)'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(x, 64); c.lineTo(x + w, 64); c.stroke();

  // Everything between the click and the landing: the drumroll, then the flight.
  // The pending place lives on the queue during the surge and on the flight once
  // the ball is out (lotMachStartEject has shifted it off the queue by then).
  const pending = m.phase === 'surge' ? m.queue[0] : (m.flying ? m.flying.win : null);
  if (pending) {
    const pulse = 0.55 + 0.45 * Math.sin(now / 90);
    c.fillStyle = 'rgba(183,121,31,' + pulse.toFixed(3) + ')';
    c.font = '800 12px system-ui, sans-serif';
    c.fillText((+pending.place === 1 ? '★ ' : '') + 'KULA NA ' + (+pending.place) + '. MIEJSCE', x, 104);
    c.fillStyle = '#2d2a24';
    c.font = '800 30px system-ui, sans-serif';
    c.fillText(m.phase === 'surge' ? 'Uwaga…' : 'Kula w drodze…', x, 144);
    c.fillStyle = '#b7791f';
    c.font = '800 20px system-ui, sans-serif';
    c.fillText(lotNum(pending.prize) + ' 🪙', x, 174);
    return;
  }

  // waiting for the operator to release the next ball
  if (m.awaiting && m.queue.length) {
    const nxt = m.queue[0], first = +nxt.place === 1;
    c.fillStyle = '#b7791f';
    c.font = '800 11px system-ui, sans-serif';
    c.fillText(first ? '★ NAGRODA GŁÓWNA' : 'NASTĘPNA KULA', x, 104);
    c.fillStyle = '#2d2a24';
    c.font = '800 30px system-ui, sans-serif';
    c.fillText((+nxt.place) + '. miejsce', x, 144);
    c.fillStyle = '#b7791f';
    c.font = '800 20px system-ui, sans-serif';
    c.fillText(lotNum(nxt.prize) + ' 🪙', x, 174);
    c.fillStyle = '#8b8577';
    c.font = '600 12px system-ui, sans-serif';
    c.fillText('Kliknij „Wypuść kulę”, żeby ją wylosować.', x, 200);
    return;
  }

  if (m.phase === 'spin' || (m.phase === 'eject' && !m.reveal)) {
    const dots = '.'.repeat(1 + (Math.floor(now / 320) % 3));
    c.fillStyle = '#4a4438';
    c.font = '800 30px system-ui, sans-serif';
    c.fillText('Kręcimy' + dots, x, 132);
    c.fillStyle = '#8b8577'; c.font = '600 13px system-ui, sans-serif';
    c.fillText('Siła zakręcenia: ' + m.force + '%', x, 160);
    c.fillText(m.queue.length ? 'Wynik dotarł — zaraz wypuszczamy kule.' : 'Czekamy na wynik z serwera…', x, 182);
    return;
  }

  if (m.reveal) {
    const r = m.reveal, first = +r.place === 1;
    const ease = 1 - Math.pow(1 - m.revealT, 3);
    c.save();
    c.globalAlpha = 0.25 + 0.75 * ease;
    c.translate(0, (1 - ease) * 14);
    c.fillStyle = '#b7791f';
    c.font = '800 11px system-ui, sans-serif';
    c.fillText((first ? '★ ' : '') + (+r.place || 1) + '. MIEJSCE', x, 104);
    c.fillStyle = '#2d2a24';
    // the winner's name lands with a little overshoot, biggest for 1st place
    const size = first ? 42 : 34;
    c.font = '800 ' + Math.round(size * (0.82 + 0.18 * ease)) + 'px system-ui, sans-serif';
    c.fillText(lotFitText(c, r.nick || '—', w), x, first ? 152 : 146);
    c.fillStyle = '#b7791f';
    c.font = '800 ' + (first ? 28 : 24) + 'px system-ui, sans-serif';
    // prize counts up rather than just appearing
    c.fillText(lotNum(Math.round((+r.prize || 0) * ease)) + ' 🪙', x, first ? 190 : 182);
    c.fillStyle = '#8b8577';
    c.font = '600 12px system-ui, sans-serif';
    c.fillText((+r.tickets || 0) + ' bil. · los ' + lotNum(r.roll) + ' z ' + lotNum(r.pool_tickets),
      x, first ? 214 : 206);
    c.restore();
    return;
  }

  c.fillStyle = '#4a4438';
  c.font = '800 22px system-ui, sans-serif';
  c.fillText(lotFitText(c, m.phase === 'load' ? 'Ładujemy bęben…' : (m.headline || 'Bęben gotowy'), w), x, 112);
  c.fillStyle = '#8b8577';
  c.font = '600 12.5px system-ui, sans-serif';
  const words = String(m.phase === 'load' ? 'Każdy bilet to jedna kula. Za chwilę wszystkie wpadną do bębna.' : (m.subline || '')).split(' ');
  let line = '', ly = 140;
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (c.measureText(test).width > w && line) { c.fillText(line, x, ly); ly += 19; line = word; }
    else line = test;
  }
  if (line) c.fillText(line, x, ly);
}

// The briefing that sits on TOP of the machine: the rules, what the six places
// pay, and how many tickets everyone holds. The detailed „Podział puli" /
// „Za co zdobywasz bilety" / „Ranking" sections below stay as the long form —
// this is the version you can read out loud before pressing spin.
function buildLotteryBriefing(d, latest, source) {
  // A finished draw quotes the pool it actually paid, not today's live one.
  const pool = latest ? Math.max(0, +latest.pool || 0) : Math.max(0, +d.prize_pool || 0);
  // Ticket totals are DERIVED from the same list that fills the drum, not read
  // off the RPC's top-level fields — that way the headline count can never
  // disagree with the balls and the legend the player is looking at.
  const holders = (source || []).filter(p => (+p.tickets || 0) > 0);
  const total = holders.reduce((a, p) => a + (+p.tickets || 0), 0);
  const pc = holders.length;
  const live = pool > 0;
  const players = Array.isArray(d.players) ? d.players : [];
  const mine = me ? players.find(p => p.id === me.id) : null;
  const divTotal = Math.floor(pool * LOTTERY_DIVIDEND_PCT);
  const divEach = pc ? Math.floor(divTotal / pc) : 0;
  const divPct = Math.round(LOTTERY_DIVIDEND_PCT * 100);

  const rule = (icon, txt) => el('div', { className: 'lot-brief-rule' },
    el('i', {}, icon), el('span', {}, txt));

  const rules = el('div', {},
    el('div', { className: 'lot-brief-h' }, 'Jak to działa'),
    rule('🎟️', 'Każdy bilet to jedna kula w bębnie — więcej biletów, więcej kul, większa szansa.'),
    rule('🎯', 'Losujemy 6 nagród, ważonych liczbą biletów i bez powtórzeń: jedna osoba nie zajmie dwóch miejsc.'),
    rule('🪙', live
      ? 'Pula to ' + lotMult(d) + '× zysk Banku z Mundialu — dziś ' + lotNum(pool) + ' 🪙.'
      : 'Pula to ' + lotMult(d) + '× zysk Banku z Mundialu i rośnie z każdym przegranym zakładem gracza.'),
    rule('🤝', divEach
      ? 'Dywidenda: ' + divPct + '% puli po równo dla każdego z biletem — ok. '
        + lotNum(divEach) + ' 🪙 na osobę, niezależnie od losowania.'
      : divPct + '% puli dzielimy po równo między wszystkich z biletem — dostajesz to niezależnie od losowania.'),
    rule('🎬', 'Kule wypadają po jednej, od 6. miejsca do zwycięzcy.'),
    rule('🔒', 'Wynik jest pieczętowany przed losowaniem — po nim każdy może go przeliczyć w swojej przeglądarce.'),
  );

  const prizeRows = LOTTERY_TIERS.map((t, i) => el('tr', { className: i === 0 ? 'is-top' : '' },
    el('td', { className: 'pl' }, (i === 0 ? '🏆 ' : '') + t.place + ' miejsce'),
    el('td', { className: 'pc' }, Math.round(t.pct * 100) + '%'),
    el('td', { className: 'am' }, live ? lotNum(Math.floor(pool * t.pct)) + ' 🪙' : '—'),
  ));
  prizeRows.push(el('tr', { className: 'is-div' },
    el('td', { className: 'pl' }, 'Dywidenda — każdy z biletem'),
    el('td', { className: 'pc' }, divPct + '%'),
    el('td', { className: 'am' }, live ? lotNum(divEach) + ' 🪙' : '—'),
  ));
  const prizes = el('div', {},
    el('div', { className: 'lot-brief-h' }, 'Nagrody'),
    el('table', { className: 'lot-brief-prizes' }, el('tbody', {}, ...prizeRows)),
  );

  const stat = (label, val) => el('div', { className: 'lot-brief-stat' },
    el('span', { className: 'lot-brief-stat-l' }, label),
    el('b', {}, val));
  const pct = mine && total ? (+mine.tickets || 0) / total * 100 : 0;
  const stats = el('div', { className: 'lot-brief-stats' },
    stat('Biletów w bębnie', lotNum(total)),
    stat('Graczy', String(pc)),
    mine ? stat('Twoje bilety', String(+mine.tickets || 0)) : '',
    mine && total ? stat('Twoja szansa', (pct < 1 ? pct.toFixed(1) : Math.round(pct)) + '%') : '',
  );

  return el('div', { className: 'lot-brief' }, rules, prizes, stats);
}

// ── The section ────────────────────────────────────────────────────────────
// Who owns which colour. Sits ABOVE the drum so you can follow your own balls
// while it churns — without it the colours are decoration.
function buildLotteryLegend(list, hues, winners) {
  const placeOf = new Map((winners || []).map(w => [w.id, +w.place]));
  const wrap = el('div', { className: 'lot-legend' });
  wrap.append(el('div', { className: 'lot-legend-head' }, 'Kto ma ile bilet\u00f3w (i jaki kolor kul)'));
  (list || []).filter(p => (+p.tickets || 0) > 0).forEach(p => {
    const col = hues.get(p.id);
    const place = placeOf.get(p.id);
    const dot = el('span', { className: 'lot-legend-dot' });
    dot.style.background = col ? lotCss(col) : '#ccc';
    wrap.append(el('div', {
      className: 'lot-legend-item' + (me && p.id === me.id ? ' is-me' : '') + (place ? ' is-won' : ''),
      title: (p.nick || '—') + ' — ' + (+p.tickets || 0) + ' biletów' + (place ? ' — ' + place + '. miejsce' : ''),
    },
      dot,
      el('span', { className: 'lot-legend-nick' }, p.nick || '—'),
      el('span', { className: 'lot-legend-tk' }, String(+p.tickets || 0)),
      place ? el('span', { className: 'lot-legend-place' }, place + '.') : '',
    ));
  });
  return wrap;
}

function buildLotteryWinnerList(row) {
  const wins = Array.isArray(row.winners) ? row.winners : [];
  const hues = lotHuesFor(Array.isArray(row.snapshot) ? row.snapshot : []);
  const wrap = el('div', { className: 'lot-win' });
  wins.slice().sort((a, b) => (+a.place || 0) - (+b.place || 0)).forEach(w => {
    const isMe = me && w.id === me.id;
    const dot = el('span', { className: 'lot-win-dot' });
    const col = hues.get(w.id);
    dot.style.background = col ? lotCss(col) : '#ccc';
    wrap.append(el('div', {
      className: 'lot-win-row' + (+w.place === 1 ? ' is-top' : '') + (isMe ? ' is-me' : ''),
      'data-place': String(w.place),
    },
      el('span', { className: 'lot-win-pl' }, w.place + '.'),
      dot,
      el('span', { className: 'lot-win-nick' }, w.nick || '—'),
      el('span', { className: 'lot-win-tk' }, (+w.tickets || 0) + ' bil.'),
      el('span', { className: 'lot-win-spacer' }),
      el('span', { className: 'lot-win-amt' }, lotNum(w.prize) + ' 🪙'),
    ));
  });
  if (+row.dividend_each > 0) {
    wrap.append(el('div', { className: 'lot-win-row' },
      el('span', { className: 'lot-win-pl' }, '＝'),
      el('span', { className: 'lot-win-nick' }, 'Dywidenda dla wszystkich'),
      el('span', { className: 'lot-win-tk' }, (+row.player_count || 0) + ' graczy'),
      el('span', { className: 'lot-win-spacer' }),
      el('span', { className: 'lot-win-amt' }, lotNum(row.dividend_each) + ' 🪙 / os.'),
    ));
  }
  return wrap;
}

function lotReleaseLabel(w) {
  const p = +w.place || 1;
  return p === 1 ? '🏆 Wypuść kulę — 1. MIEJSCE' : 'Wypuść kulę — ' + p + '. miejsce';
}

// Drives the one-click-per-ball ceremony: the release button, the winners list
// filling in bottom-up, and whatever should happen at the end.
function lotWireCeremony(m, btn, rows, onFinish, force) {
  m.onAwait = w => {
    btn.style.display = '';
    btn.disabled = false;
    btn.textContent = lotReleaseLabel(w);
    btn.classList.toggle('is-final', +w.place === 1);
    if (force) force.disabled = false;   // re-tune the churn between balls
  };
  m.onBusy = () => {
    btn.disabled = true;
    btn.textContent = 'Kula w drodze…';
    if (force) force.disabled = true;
  };
  m.onReveal = w => { const r = rows[(+w.place || 1) - 1]; if (r) r.style.visibility = ''; };
  m.onDone = () => {
    btn.style.display = 'none';
    rows.forEach(r => { r.style.visibility = ''; });
    if (force) force.disabled = true;
    if (onFinish) onFinish();
  };
  btn.onclick = () => lotMachRelease(m);
}

// Fullscreen. Two mechanisms on purpose: the `.is-fs` class is a fixed overlay
// and is what ACTUALLY drives the layout, so this works identically on iOS
// Safari, which has no element Fullscreen API; the native request is a bonus
// that also hides the browser chrome. ⚠️ requestFullscreen needs a live user
// gesture, so it is called straight from the click handler, before any await.
let lotFsCard = null;

function lotIsFs() { return !!lotFsCard; }

function lotEnterFs(card) {
  lotFsCard = card;
  card.classList.add('is-fs');
  document.documentElement.classList.add('lot-fs-open');
  const el0 = card;
  const req = el0.requestFullscreen || el0.webkitRequestFullscreen;
  if (req) { try { req.call(el0); } catch (_e) {} }
  if (lotMach) lotFitCanvas(lotMach);
}

function lotExitFs() {
  if (lotFsCard) lotFsCard.classList.remove('is-fs');
  lotFsCard = null;
  document.documentElement.classList.remove('lot-fs-open');
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (ex) { try { ex.call(document); } catch (_e) {} }
  }
  if (lotMach) lotFitCanvas(lotMach);
}

function lotToggleFs(card) { if (lotIsFs()) lotExitFs(); else lotEnterFs(card); }

// Leaving fullscreen by Esc or the browser's own chrome must also drop the
// class, or the card stays a fixed overlay with no way out.
(function lotFsHooks() {
  const onChange = () => {
    if (!document.fullscreenElement && !document.webkitFullscreenElement && lotIsFs()) lotExitFs();
  };
  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && lotIsFs()) lotExitFs(); });
})();

function lotFsButton(card) {
  const b = el('button', { className: 'lot-fs-btn', title: 'Pełny ekran (Esc, aby wyjść)' }, '⛶');
  b.addEventListener('click', () => {
    lotToggleFs(card);
    b.textContent = lotIsFs() ? '✕' : '⛶';
  });
  return b;
}

function lotModeToggle() {
  const wrap = el('div', { className: 'lot-view-toggle' });
  const btn = (mode, label) => {
    const b = el('button', { className: 'lot-view-btn' + (lotMode === mode ? ' is-on' : '') }, label);
    b.addEventListener('click', () => {
      if (lotMode === mode) return;
      lotMode = mode;
      renderLottery();          // rebuild from cache; lotMachineStop() runs in buildLotteryPanel
    });
    return b;
  };
  wrap.append(btn('live', 'Na żywo'), btn('test', '🧪 Test'));
  return wrap;
}

function lotRandomHex(bytes) {
  const b = new Uint8Array(bytes);
  if (crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < bytes; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b).map(v => v.toString(16).padStart(2, '0')).join('');
}

// A throwaway draw computed in the browser with the SAME rule as
// lottery_draw_run(): random seed, weighted, without replacement, snapshot
// ordered tickets DESC then id ASC. Faithful on purpose — a rehearsal that used
// different maths would not be a rehearsal. Returns a row shaped like a real
// `lottery_draws` row so the ceremony code needs no special case.
async function lotTestDraw(source, pool, force) {
  const seed = lotRandomHex(32), pub = lotRandomHex(8);
  const snap = (source || [])
    .filter(p => (+p.tickets || 0) > 0)
    .map(p => ({ id: p.id, nick: p.nick, tickets: +p.tickets || 0 }))
    .sort((a, b) => (b.tickets - a.tickets) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const remaining = snap.slice();
  const winners = [];
  for (let k = 1; k <= LOTTERY_TIERS.length && remaining.length; k++) {
    const total = remaining.reduce((x, p) => x + p.tickets, 0);
    if (total <= 0) break;
    const roll = lotRollFromHex(await lotSha256Hex([seed, pub, force, k].join('|')), total);
    let cum = 0, idx = -1;
    for (let i = 0; i < remaining.length; i++) { cum += remaining[i].tickets; if (roll < cum) { idx = i; break; } }
    if (idx < 0) idx = remaining.length - 1;
    const w = remaining[idx];
    winners.push({
      place: k, id: w.id, nick: w.nick, tickets: w.tickets, pct: LOTTERY_TIERS[k - 1].pct,
      prize: Math.floor(pool * LOTTERY_TIERS[k - 1].pct), roll, pool_tickets: total,
    });
    remaining.splice(idx, 1);
  }
  const pc = snap.length;
  const divTotal = Math.floor(pool * LOTTERY_DIVIDEND_PCT);
  return {
    id: 'test', status: 'test', pool, snapshot: snap, winners,
    total_tickets: snap.reduce((x, p) => x + p.tickets, 0), player_count: pc,
    dividend_total: divTotal, dividend_each: pc ? Math.floor(divTotal / pc) : 0,
  };
}

function buildLotteryMachineSection(d) {
  const sec = el('section', { className: 'lot-section' });
  const drawn = lotteryDraws.filter(r => r.status === 'drawn');
  const open = lotteryDraws.find(r => r.status === 'committed') || null;
  const latest = drawn[0] || null;
  const admin = isAdmin();

  sec.append(el('div', { className: 'lot-section-head' },
    el('div', { className: 'lot-section-title' }, 'Maszyna losująca'),
    admin ? lotModeToggle() : el('div', { className: 'lot-section-hint' },
      latest ? 'wylosowano ' + new Date(latest.drawn_at).toLocaleDateString('pl-PL')
        : open ? 'zapieczętowana, czeka na start' : 'losowanie 1 sierpnia'),
  ));

  if (lotteryDrawsMissing) {
    sec.append(el('p', { className: 'lot-mach-hint' },
      'Maszyna losująca nie jest jeszcze uruchomiona na serwerze' +
      (admin ? ' — wgraj supabase/lottery-draw.sql w SQL Editorze.' : '. Wróć tu w dniu losowania.')));
    return sec;
  }

  // Balls: a finished draw shows the exact table it drew from, otherwise the
  // machine previews the live standings so you can see your own weight in it.
  // TEST always uses the live standings — the point is a dry run of THIS draw.
  const testing = admin && lotMode === 'test';
  const source = latest && !open && !testing
    ? (Array.isArray(latest.snapshot) ? latest.snapshot : [])
    : (Array.isArray(d.players) ? d.players : []);
  const hues = lotHuesFor(source);

  const canvas = el('canvas', { className: 'lot-mach-canvas' });
  const stage = el('div', { className: 'lot-mach-stage' }, canvas,
    el('div', { className: 'lot-mach-tag' }, 'Loteria po Mundialu'));
  const card = el('div', { className: 'lot-mach' + (testing ? ' is-test' : '') },
    testing ? el('div', { className: 'lot-test-banner' },
      el('b', {}, '🧪 TRYB TESTOWY'),
      ' — próba generalna na prawdziwych biletach. Zwycięzcy są losowani w Twojej ' +
      'przeglądarce, nic nie zapisuje się na serwerze i nikt nie dostaje ani jednej monety.') : '',
    buildLotteryBriefing(d, latest && !open && !testing ? latest : null, source),
    buildLotteryLegend(source, hues, latest && !open && !testing ? latest.winners : null),
    stage);
  stage.append(lotFsButton(card));
  sec.append(card);

  const ctl = el('div', { className: 'lot-mach-ctl' });
  card.append(ctl);

  const forceVal = el('span', { className: 'lot-force-val' }, String(LOT_FORCE_DEFAULT));
  const forceIn = el('input', {
    type: 'range', min: '1', max: '100', step: '1',
    value: String(LOT_FORCE_DEFAULT), className: 'lot-force',
  });
  forceIn.addEventListener('input', () => {
    setText(forceVal, forceIn.value);
    lotMachPreviewForce(lotMach, forceIn.value);
  });

  const release = el('button', { className: 'lot-btn lot-release' }, 'Wypuść kulę');
  release.style.display = 'none';
  const winWrap = el('div', {});

  const hiddenRows = list => {
    const rows = Array.from(list.querySelectorAll('.lot-win-row[data-place]'));
    rows.forEach(r => { r.style.visibility = 'hidden'; });
    return rows;
  };

  if (testing) {
    // ── Dry run: the real ceremony, a browser-drawn result, no server call ──
    const pool = Math.max(0, +d.prize_pool || 0);
    const spin = el('button', { className: 'lot-btn is-gold' }, 'Ładowanie kul…');
    spin.disabled = true;
    const machine = newLotteryMachine(canvas, source, {
      headline: 'Próba generalna',
      subline: 'Ten sam przebieg co na żywo: zakręć, potem wypuszczaj kule po jednej od 6. miejsca. Wynik jest udawany.',
      onLoaded: () => {
        spin.disabled = false;
        spin.textContent = '🧪 Zakręć (test)';
        lotMachPreviewForce(lotMach, forceIn.value);
      },
    });
    spin.addEventListener('click', async () => {
      spin.disabled = true; spin.style.display = 'none'; forceIn.disabled = true;
      lotMachSpin(machine, forceIn.value);
      try {
        const row = await lotTestDraw(source, pool, Number(forceIn.value) || LOT_FORCE_DEFAULT);
        const list = buildLotteryWinnerList(row);
        const rows = hiddenRows(list);
        winWrap.replaceChildren(list);
        lotWireCeremony(machine, release, rows, () => {
          spin.style.display = ''; spin.disabled = false;
          spin.textContent = '🧪 Zakręć ponownie (test)';
        }, forceIn);
        lotMachDeliver(machine, row.winners);
      } catch (e) {
        lotMachFail(machine, 'Test nie doszedł do skutku');
        spin.style.display = ''; spin.disabled = false; forceIn.disabled = false;
        showToast(e.message || 'Błąd testu.');
      }
    });
    ctl.append(
      el('div', { className: 'lot-force-row' },
        el('span', { className: 'lot-ctl-lbl' }, 'Siła zakręcenia'), forceIn, forceVal),
      el('div', { className: 'lot-mach-btns' }, spin, release),
      el('div', { className: 'lot-mach-hint' },
        'Możesz to powtarzać do woli — za każdym razem wypadną inni zwycięzcy, bo ziarno jest losowane od nowa. ' +
        'Prawdziwe losowanie odbywa się tylko w trybie „Na żywo”.'),
      winWrap,
    );
    lotAppendDrawHistory(sec, drawn);
    return sec;
  }

  if (latest && !open) {
    // ── A draw has happened: replay it on demand, same click-per-ball ceremony ──
    const replay = el('button', { className: 'lot-btn' }, '▶ Odtwórz losowanie');
    const playIt = () => {
      replay.disabled = true;
      const list = buildLotteryWinnerList(latest);
      const rows = hiddenRows(list);
      winWrap.replaceChildren(list);
      const m = newLotteryMachine(canvas, source, {
        drawId: latest.id, headline: 'Losowanie zakończone',
        onLoaded: () => {
          lotMachSpin(lotMach, latest.force || LOT_FORCE_DEFAULT);
          lotMachDeliver(lotMach, latest.winners);
        },
      });
      lotWireCeremony(m, release, rows, () => { replay.disabled = false; }, forceIn);
    };
    replay.addEventListener('click', playIt);

    if (lotAutoPlay === latest.id) {
      lotAutoPlay = null;
      playIt();
    } else {
      const m = newLotteryMachine(canvas, source, { drawId: latest.id, headline: 'Losowanie zakończone' });
      lotMachShowResult(m, latest.winners);
      winWrap.append(buildLotteryWinnerList(latest));
    }

    ctl.append(
      el('div', { className: 'lot-force-row' },
        el('span', { className: 'lot-ctl-lbl' }, 'Siła zakręcenia'), forceIn, forceVal),
      el('div', { className: 'lot-mach-btns' }, release, replay),
      el('div', { className: 'lot-mach-hint' },
        'Wynik policzył serwer przed animacją — maszyna tylko go pokazuje, od 6. miejsca do zwycięzcy.'),
      winWrap,
    );
    if (admin) ctl.append(lotAdminNewDrawRow());
    sec.append(lotVerdictLine(latest));
    lotAppendDrawHistory(sec, drawn.slice(1));
    return sec;
  }

  if (open) {
    // ── Sealed, waiting for the spin ──
    const spin = el('button', { className: 'lot-btn is-gold' }, 'Ładowanie kul…');
    spin.disabled = true;
    const machine = newLotteryMachine(canvas, source, {
      drawId: open.id,
      headline: admin ? 'Bęben gotowy' : 'Losowanie zapieczętowane',
      subline: admin
        ? 'Ustaw siłę zakręcenia i kręć. Potem wypuszczasz kule po jednej — od 6. miejsca do zwycięzcy.'
        : 'Wynik jest już przypieczętowany. Nikt — także admin — nie zna go, dopóki bęben nie ruszy.',
      onLoaded: () => {
        if (!admin) return;
        spin.disabled = false;
        spin.textContent = '🎲 Zakręć bębnem';
        lotMachPreviewForce(lotMach, forceIn.value);
      },
    });

    if (admin) {
      spin.addEventListener('click', () => lotRunDraw(open, machine, {
        spin, force: forceIn, release, winWrap, hiddenRows,
      }));
      ctl.append(
        el('div', { className: 'lot-force-row' },
          el('span', { className: 'lot-ctl-lbl' }, 'Siła zakręcenia'), forceIn, forceVal),
        el('div', { className: 'lot-mach-btns' }, spin, release),
        el('div', { className: 'lot-mach-hint' },
          el('b', {}, 'Jednorazowo i nieodwracalnie. '),
          'Siła zakręcenia wchodzi do losowania, więc naprawdę zmienia wynik — ale nie da się nią wycelować. ' +
          'Kule wypuszczasz ręcznie, jedna po jednej, od 6. miejsca do zwycięzcy; między kulami możesz ' +
          'przekręcić suwak, ale wtedy zmienia on już tylko tempo bębna — wynik jest wylosowany przy pierwszym zakręceniu.'),
        winWrap,
      );
    } else {
      ctl.append(el('div', { className: 'lot-mach-hint' },
        el('b', {}, 'Losowanie jest zapieczętowane. '),
        'Wynik zostanie wylosowany na oczach wszystkich — kula po kuli, od 6. miejsca do zwycięzcy.'));
    }
    lotAppendDrawHistory(sec, drawn);
    return sec;
  }

  // ── Nothing sealed yet: idle preview of the live standings ──
  newLotteryMachine(canvas, source, {
    headline: 'Bęben nabity',
    subline: 'Każdy bilet to jedna kula. Losowanie odbędzie się 1 sierpnia — sześć nagród, ważonych liczbą biletów, bez powtórzeń.',
    onLoaded: () => {},
  });
  ctl.append(el('div', { className: 'lot-mach-hint' },
    'Losujemy sześć nagród ważnie liczbą biletów i bez powtórzeń. Kule wypadają po jednej — ' +
    'od 6. miejsca do zwycięzcy.'));
  if (admin) ctl.append(lotAdminNewDrawRow());
  lotAppendDrawHistory(sec, drawn);
  return sec;
}

function lotAdminNewDrawRow() {
  const btn = el('button', { className: 'lot-btn' }, '🔒 Zapieczętuj nowe losowanie');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const { data, error } = await sb.rpc('lottery_draw_commit', { p_label: null });
      if (error) throw error;
      if (!data || data.ok !== true) throw new Error('commit_failed');
      showToast('Losowanie zapieczętowane — można kręcić.');
      await renderLottery(true);
    } catch (e) {
      btn.disabled = false;
      showToast(lotDrawError(e));
    }
  });
  return el('div', { className: 'lot-mach-btns' }, btn,
    el('span', { className: 'lot-mach-hint' }, 'Tylko admin. Pieczęć przypina wynik, zanim ktokolwiek go pozna.'));
}

const LOT_DRAW_ERR = {
  not_authenticated: 'Musisz być zalogowany.',
  not_admin: 'Tylko admin może prowadzić losowanie.',
  draw_already_open: 'Jedno losowanie jest już zapieczętowane.',
  draw_already_done: 'To losowanie zostało już rozstrzygnięte.',
  no_draw: 'Nie znaleziono losowania.',
  no_seed: 'Brak zapieczętowanego ziarna.',
  no_participants: 'Nikt nie ma biletów.',
};
function lotDrawError(e) {
  const raw = (e && (e.message || e.error_description || e.details)) || '';
  for (const k in LOT_DRAW_ERR) if (raw.includes(k)) return LOT_DRAW_ERR[k];
  return raw || 'Coś poszło nie tak.';
}

async function lotRunDraw(open, m, ui) {
  ui.spin.disabled = true; ui.force.disabled = true;
  ui.spin.style.display = 'none';
  // Spin FIRST, ask the server WHILE it spins: the drum must not sit still
  // waiting on a round trip, and the animation has nothing to reveal until the
  // trusted result lands anyway.
  lotMachSpin(m, ui.force.value);
  try {
    // p_public_seed is left to the server, which rolls its own random value —
    // there is no operator text field for it any more. `force` is the operator's
    // contribution; the sealed seed is still what makes it unaimable.
    const { data, error } = await sb.rpc('lottery_draw_run', {
      p_draw_id: open.id,
      p_public_seed: null,
      p_force: Number(ui.force.value) || LOT_FORCE_DEFAULT,
    });
    if (error) throw error;
    if (!data || data.ok !== true || !data.draw) throw new Error('draw_failed');
    const row = data.draw;
    const i = lotteryDraws.findIndex(x => x.id === row.id);
    if (i >= 0) lotteryDraws[i] = row; else lotteryDraws.unshift(row);
    const list = buildLotteryWinnerList(row);
    const rows = ui.hiddenRows(list);
    ui.winWrap.replaceChildren(list);
    lotWireCeremony(m, ui.release, rows, () => {
      showToast('Losowanie rozstrzygnięte — nagrody wypłacone.');
      // Coins moved for everyone holding a ticket, this player included — the
      // header would otherwise keep showing the pre-payout balance.
      refreshMeCoins();
      renderLottery(true);
    }, ui.force);
    lotMachDeliver(m, row.winners);
  } catch (e) {
    lotMachFail(m, 'Losowanie nie doszło do skutku');
    ui.spin.style.display = '';
    ui.spin.disabled = false; ui.force.disabled = false;
    showToast(lotDrawError(e));
  }
}

// One quiet line, not a panel of hashes. The draw is still commit–reveal in SQL
// and the browser still replays every roll — but the only thing worth putting on
// screen is the verdict, and the ⚠ case must never be silent.
function lotVerdictLine(row) {
  const v = el('div', { className: 'lot-verdict wait' }, 'Sprawdzam wynik w Twojej przeglądarce…');
  lotVerifyDraw(row).then(res => {
    if (!v.isConnected) return;
    v.className = 'lot-verdict ' + (res.ok ? 'ok' : 'bad');
    v.textContent = res.ok
      ? '✓ Wynik zweryfikowany w Twojej przeglądarce — losowanie było przypieczętowane, zanim ktokolwiek znał wynik.'
      : '⚠ Weryfikacja NIE przeszła: ' + res.why;
  });
  return v;
}

function lotAppendDrawHistory(sec, list) {
  if (!list || !list.length) return;
  const box = el('details', { className: 'lot-note' },
    el('summary', {}, 'Wcześniejsze losowania (' + list.length + ')'));
  list.forEach(r => {
    const top = (Array.isArray(r.winners) ? r.winners : []).find(w => +w.place === 1);
    box.append(el('div', { className: 'lot-fair-row' },
      el('div', { className: 'lot-fair-k' }, new Date(r.drawn_at).toLocaleDateString('pl-PL')),
      el('div', { className: 'lot-fair-v is-dim' },
        (top ? '1. ' + (top.nick || '—') + ' · ' + lotNum(top.prize) + ' 🪙' : 'brak zwycięzców')
        + ' · pula ' + lotNum(r.pool) + ' 🪙')));
  });
  sec.append(box);
}

function setupLotteryRealtime() {
  if (lotteryRtReady) return;
  lotteryRtReady = true;
  sb.channel('lottery-draws')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lottery_draws' }, payload => {
      const r = payload.new;
      if (!r || !r.id) return;
      const i = lotteryDraws.findIndex(x => x.id === r.id);
      const wasDrawn = i >= 0 && lotteryDraws[i].status === 'drawn';
      if (i >= 0) lotteryDraws[i] = r; else lotteryDraws.unshift(r);
      // The dividend pays every ticket holder, so a draw landing anywhere in the
      // app changes this player's balance — refresh even off-tab.
      if (r.status === 'drawn' && !wasDrawn) refreshMeCoins();
      if (activeTab !== 'lottery') return;
      // Never yank the canvas out from under a spin we are already playing.
      if (lotMach && lotMach.running) return;
      lotAutoPlay = (r.status === 'drawn' && !wasDrawn) ? r.id : null;
      renderLottery(true);
    })
    .subscribe();
}
