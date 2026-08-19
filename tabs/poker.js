// Lazy-loaded tab module — see ensureTabModule() in index.html.
// Moved out of index.html's inline <script> so it is fetched only when
// this tab is actually opened. Owns its own top-level const/let; reads
// shared globals from index.html, which always runs first.
'use strict';

// ── Poker ─────────────────────────────────────────────────────────────────
function setupPokerRealtime() {
  if (pokerRealtimeReady) return;
  pokerRealtimeReady = true;
  const reload = () => {
    if (activeTab !== 'poker') return;
    // Skip if we just got fresh state from an action response (avoids double fetch).
    if (Date.now() - lastPokerStateMs < 1500) return;
    loadPokerState(false);
  };
  const ch = sb.channel('poker-db-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'poker_tables' }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'poker_seats' }, reload)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'poker_events' }, reload)
    .subscribe();
  realtimeChannels.push(ch);
}

async function invokePoker(payload) {
  const { data, error } = await sb.functions.invoke('poker-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z funkcją pokerową.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Nie udało się wykonać akcji pokerowej.');
  return data;
}

async function loadPokerState(showSpinner = true) {
  if (showSpinner && !pokerState) pokerWrap.replaceChildren(makeSpinner());
  try {
    const data = await invokePoker({ action: 'state' });
    applyPokerState(data);
  } catch (err) {
    stopPokerClock();
    // Transient backend error — show toast and auto-retry once instead of breaking the panel.
    if (err.message === 'Nie udało się wykonać akcji pokerowej.') {
      showToast('⚠️ Chwilowy błąd połączenia — ponawiam...');
      setTimeout(() => loadPokerState(false), 2000);
    } else {
      pokerWrap.replaceChildren(buildPokerError(err.message));
    }
  }
}

async function pokerAction(payload, opts = {}) {
  try {
    const data = await invokePoker(payload);
    applyPokerState(data);
  } catch (err) {
    if (!opts.silent) showToast('❌ ' + err.message);
  }
}

function applyPokerState(data) {
  lastPokerStateMs = Date.now();
  pokerState = data;
  if (data.profile) {
    me.coins = data.profile.coins;
    setText(headerCoins, me.coins);
  }
  if (data.table) {
    setText(pokerBuyIn, data.table.buyInCost || data.table.buyIn);
    setText(pokerBlinds, data.table.smallBlind + '/' + data.table.bigBlind);
  }
  renderPoker();
  startPokerClock();
}

function buildPokerError(message) {
  const isInfraError = !message || message.includes('nie jest skonfigurowany') || message.includes('not configured') || message.includes('unavailable');
  return el('div', { className: 'poker-table-panel' },
    el('div', { className: 'poker-status-main' },
      el('strong', {}, isInfraError ? 'Poker nie jest jeszcze aktywny.' : 'Błąd połączenia z pokerem.'),
      el('div', {}, message || 'Nie udało się wczytać stołu.'),
      isInfraError ? el('div', {}, 'Wdróż SQL z supabase/poker.sql i funkcję supabase/functions/poker-action, a potem odśwież stronę.') : el('div', {}, 'Odśwież stronę, żeby spróbować ponownie.')
    )
  );
}

function phaseLabel(phase) {
  const labels = {
    waiting: 'oczekiwanie',
    preflop: 'preflop',
    flop: 'flop',
    turn: 'turn',
    river: 'river',
    showdown: 'showdown',
  };
  return labels[phase] || phase;
}

function actionLabel(action) {
  if (!action) return '';
  return String(action)
    .replace('timeout fold', 'czas: fold')
    .replace('timeout check', 'czas: check')
    .replace('fold', 'fold')
    .replace('check', 'check')
    .replace('call', 'call')
    .replace('raise', 'raise')
    .replace('all-in', 'all-in');
}

function cardText(code) {
  if (!code) return '';
  const rank = code[0] === 'T' ? '10' : code[0];
  const suit = { s: '♠', h: '♥', d: '♦', c: '♣' }[code[1]] || '';
  return rank + suit;
}

function isRedCard(code) {
  return code && (code[1] === 'h' || code[1] === 'd');
}

function buildPlayingCard(code, opts = {}) {
  if (opts.back) return el('div', { className: 'playing-card back', title: 'Karta zakryta' }, '');
  if (!code) return el('div', { className: 'playing-card empty', title: 'Puste miejsce' }, '');
  return el('div', {
    className: 'playing-card' + (isRedCard(code) ? ' red' : ''),
    title: code,
  }, cardText(code));
}

function buildPokerGuide(state, legal) {
  const phase = state.table.phase;
  const mySeat = state.seats.find(s => s.isMe);
  const currentSeat = state.seats.find(s => s.seatNo === state.table.currentSeat);

  const PHASE_DESC = {
    waiting:  'Poczekaj — rozdanie zacznie się gdy przy stole siedzą ≥2 graczy.',
    preflop:  'Każdy dostał 2 zakryte karty. Pierwsza runda zakładów.',
    flop:     '3 wspólne karty na stole. Połącz je ze swoją ręką.',
    turn:     '4. wspólna karta. Oceń siłę swojego układu.',
    river:    '5. i ostatnia wspólna karta. Ostatnia runda zakładów.',
    showdown: 'Gracze odkrywają karty. Wygrywa najlepszy układ z 5 kart.',
  };

  const PHASE_NAMES = {
    waiting: 'Oczekiwanie', preflop: 'Preflop', flop: 'Flop',
    turn: 'Turn', river: 'River', showdown: 'Showdown',
  };

  let head, body, myTurn = false;

  if (legal.canAct) {
    myTurn = true;
    head = '⚡ Twoja kolej!';
    body = legal.canCheck
      ? 'Możesz sprawdzić za darmo (Check) albo podbić (Raise).'
      : 'Wyrównaj ' + legal.callAmount + ' 🪙 (Call), podbij (Raise) lub spasuj (Fold).';
  } else if (mySeat?.folded) {
    head = 'Spasowałeś';
    body = 'Poczekaj na kolejne rozdanie.';
  } else if (phase !== 'waiting' && currentSeat) {
    head = (PHASE_NAMES[phase] || phase) + ' · Ruch: ' + currentSeat.nick;
    body = PHASE_DESC[phase] || '';
  } else {
    head = PHASE_NAMES[phase] || phase;
    body = PHASE_DESC[phase] || '';
  }

  return el('div', { className: 'poker-guide' + (myTurn ? ' my-turn' : '') },
    el('div', { className: 'poker-guide-head' }, head),
    body ? el('div', { className: 'poker-guide-body' }, body) : null
  );
}

function buildPhaseBar(phase) {
  const phases = ['preflop', 'flop', 'turn', 'river', 'showdown'];
  if (phase === 'waiting') return null;
  const cur = phases.indexOf(phase);
  return el('div', { className: 'poker-phase-bar' },
    ...phases.map((p, i) => el('div', {
      className: 'poker-phase-step' + (p === phase ? ' active' : i < cur ? ' done' : ''),
    }, p.charAt(0).toUpperCase() + p.slice(1)))
  );
}

function renderPoker() {
  if (!pokerState) {
    pokerWrap.replaceChildren(makeSpinner());
    return;
  }
  const legal = pokerState.me.legalActions || { canAct: false };
  pokerWrap.replaceChildren(
    buildPokerGuide(pokerState, legal),
    el('div', { className: 'poker-shell' },
      buildPokerTablePanel(pokerState),
      buildPokerSidePanel(pokerState)
    )
  );
}

function buildPokerTablePanel(state) {
  const lastMsg = state.events && state.events.length > 0 ? state.events[state.events.length - 1].message : null;
  const phaseBar = buildPhaseBar(state.table.phase);

  const boardCards = [];
  for (let i = 0; i < 5; i += 1) boardCards.push(buildPlayingCard(state.table.board[i]));

  const parts = [
    el('div', { className: 'poker-status-line' },
      el('div', { className: 'poker-status-main' },
        el('strong', {}, 'Rozdanie #' + state.table.handNo),
        lastMsg ? el('div', {}, el('span', { className: 'poker-last-action' }, lastMsg)) : null
      ),
      state.table.pot > 0 ? el('div', { className: 'poker-pot' }, 'Pula ' + state.table.pot + ' 🪙') : null
    ),
  ];
  if (phaseBar) parts.push(phaseBar);
  parts.push(
    el('div', { className: 'poker-board' }, ...boardCards),
    el('div', { className: 'poker-seats-grid' }, ...buildSeatNodes(state))
  );

  return el('section', { className: 'poker-table-panel' }, ...parts);
}

function buildSeatNodes(state) {
  const nodes = [];
  for (let seatNo = 0; seatNo < state.table.maxSeats; seatNo += 1) {
    const seat = state.seats.find(s => s.seatNo === seatNo);
    nodes.push(seat ? buildPokerSeat(state, seat) : buildEmptyPokerSeat(seatNo));
  }
  return nodes;
}

function buildEmptyPokerSeat(seatNo) {
  return el('div', { className: 'poker-seat empty' },
    el('div', { className: 'poker-nick' }, 'Miejsce ' + (seatNo + 1)),
    el('div', { className: 'poker-note' }, 'wolne')
  );
}

function buildPokerSeat(state, seat) {
  const legal = state.me.legalActions || {};
  const classes = ['poker-seat'];
  if (seat.isMe) classes.push('me');
  if (seat.isBot) classes.push('bot');
  const isTurn = state.table.currentSeat === seat.seatNo && state.table.phase !== 'waiting';
  if (state.table.currentSeat === seat.seatNo) {
    classes.push(seat.isMe && legal.canAct ? 'acting' : 'current');
  }
  const showWinners = state.table.phase === 'showdown' || state.table.phase === 'waiting';
  const winnerSeatNos = new Set((state.lastResult?.winners || []).map(w => w.seatNo));
  if (showWinners && winnerSeatNos.has(seat.seatNo)) classes.push('winner');
  const actionClass = seat.folded ? ' folded' : seat.allIn ? ' allin' : '';
  const cards = seat.cards
    ? seat.cards.map(c => buildPlayingCard(c))
    : seat.inHand && !seat.folded
      ? [buildPlayingCard(null, { back: true }), buildPlayingCard(null, { back: true })]
      : [];
  const displayNick = (seat.isBot ? '🤖 ' : '') + seat.nick + (seat.isMe ? ' (Ty)' : '');

  const statusLabel = seat.folded ? 'fold' : seat.allIn ? 'all-in' : actionLabel(seat.lastAction) || (seat.inHand ? 'w grze' : 'czeka');
  return el('div', { className: classes.join(' ') },
    el('div', { className: 'poker-seat-top' },
      el('span', { className: 'poker-nick', title: seat.nick }, displayNick),
      state.table.dealerSeat === seat.seatNo ? el('span', { className: 'dealer-chip', title: 'Dealer' }, 'D') : null
    ),
    el('div', { className: 'poker-seat-cards' }, ...cards),
    el('div', { className: 'poker-seat-meta' },
      el('span', {}, 'Stack'), el('strong', {}, seat.stack + ' 🪙'),
      seat.roundBet > 0 ? el('span', {}, 'Zakład') : null,
      seat.roundBet > 0 ? el('strong', {}, seat.roundBet + ' 🪙') : null,
      el('span', {}), el('span', { className: 'poker-action-pill' + actionClass }, statusLabel)
    ),
    isTurn ? el('div', { className: 'poker-turn-bar' }) : null
  );
}

function buildPokerBotSelector(state) {
  // Mirror the server's setBots permission: any player, between hands only.
  // Don't gate on canSit/canStand/canStart — otherwise a player who isn't
  // seated (or can't afford the buy-in) loses the only control that can
  // remove a leftover bot occupying a seat.
  if (state.table.phase !== 'waiting') return null;
  const currentBotCount = state.seats.filter(s => s.isBot).length;

  const row = el('div', { className: 'poker-bot-row' },
    el('span', { className: 'poker-stat-label' }, 'Boty')
  );
  const btns = el('div', { className: 'poker-bot-btns' });
  for (let n = 0; n <= 4; n++) {
    const btn = el('button', {
      className: 'poker-bot-btn' + (currentBotCount === n ? ' active' : ''),
      type: 'button',
      title: n === 0 ? 'Bez botów' : `${n} bot${n > 1 ? 'y' : ''}`,
    }, String(n));
    const count = n;
    btn.addEventListener('click', () => pokerAction({ action: 'set_bots', count }));
    btns.appendChild(btn);
  }
  row.appendChild(btns);
  return row;
}

function buildPokerSidePanel(state) {
  const mySeat = state.seats.find(s => s.isMe);
  const legal = state.me.legalActions || { canAct: false };

  const holeCardNodes = mySeat?.cards
    ? mySeat.cards.map(c => buildPlayingCard(c))
    : mySeat?.inHand
      ? [buildPlayingCard(null, { back: true }), buildPlayingCard(null, { back: true })]
      : null;

  const holeSection = el('div', { className: 'poker-hole-section' },
    el('div', { className: 'poker-hole-label' }, 'Twoje karty'),
    holeCardNodes
      ? el('div', { className: 'poker-hole-cards' + (legal.canAct && mySeat?.cards ? ' glow' : '') }, ...holeCardNodes)
      : el('span', { className: 'poker-note' }, mySeat ? 'Czekasz na rozdanie.' : 'Usiądź przy stole, żeby grać.'),
    state.adminHint != null
      ? el('div', { className: 'poker-admin-hint' }, '🎯 Szansa: ' + state.adminHint + '%')
      : null
  );

  const botSelector = buildPokerBotSelector(state);
  const panel = el('aside', { className: 'poker-side-panel' },
    el('div', { className: 'poker-panel-title' }, 'Twój stół'),
    el('div', { className: 'poker-stack-summary' },
      el('div', { className: 'poker-stat' },
        el('div', { className: 'poker-stat-label' }, 'Gotówka'),
        el('div', { className: 'poker-stat-value' }, state.profile.coins + ' 🪙')
      ),
      el('div', { className: 'poker-stat' },
        el('div', { className: 'poker-stat-label' }, 'Stack'),
        el('div', { className: 'poker-stat-value' }, state.me.stack + ' 🪙')
      )
    ),
    holeSection,
    buildPokerControls(state, legal),
    buildPokerResult(state.lastResult),
    buildPokerEvents(state.events)
  );
  if (botSelector) panel.insertBefore(botSelector, panel.querySelector('.poker-actions') || panel.lastChild);
  return panel;
}

function buildPokerControls(state, legal) {
  const controls = el('div', { className: 'poker-actions' });

  if (state.me.canSit) {
    const sitCost = state.table.buyInCost || state.table.buyIn;
    const label = state.table.buyInBonus > 0
      ? 'Siądź za ' + sitCost + ' 🪙'
      : 'Siądź za ' + state.table.buyIn + ' 🪙';
    const sitBtn = el('button', {
      className: 'poker-action-btn primary',
      type: 'button',
      title: state.table.buyInBonus > 0 ? 'Stack powiększony o ' + state.table.buyInBonus + ' 🪙 z przedmiotu' : '',
    }, label);
    sitBtn.addEventListener('click', () => pokerAction({ action: 'sit' }));
    controls.appendChild(sitBtn);
  }

  if (state.me.canStart) {
    const startBtn = el('button', { className: 'poker-action-btn good', type: 'button' }, 'Rozdaj karty');
    startBtn.addEventListener('click', () => pokerAction({ action: 'start_hand' }));
    controls.appendChild(startBtn);
  }

  if (state.me.canStand) {
    const standBtn = el('button', { className: 'poker-action-btn', type: 'button' }, 'Odejdź od stołu');
    standBtn.addEventListener('click', () => pokerAction({ action: 'stand' }));
    controls.appendChild(standBtn);
  }

  if (legal.canAct) {
    const foldBtn = el('button', { className: 'poker-action-btn danger', type: 'button' },
      el('span', { className: 'poker-btn-label' }, 'Fold'),
      el('span', { className: 'poker-btn-sub' }, 'Porzuć rękę')
    );
    foldBtn.addEventListener('click', () => pokerAction({ action: 'act', move: 'fold' }));

    const checkCallLabel = legal.canCheck ? 'Check' : 'Call ' + legal.callAmount + ' 🪙';
    const checkCallSub   = legal.canCheck ? 'Sprawdź bez kosztów' : 'Wyrównaj stawkę';
    const checkCallBtn = el('button', { className: 'poker-action-btn good', type: 'button' },
      el('span', { className: 'poker-btn-label' }, checkCallLabel),
      el('span', { className: 'poker-btn-sub' }, checkCallSub)
    );
    checkCallBtn.addEventListener('click', () => pokerAction({
      action: 'act',
      move: legal.canCheck ? 'check' : 'call',
    }));

    const allInBtn = el('button', { className: 'poker-action-btn', type: 'button' },
      el('span', { className: 'poker-btn-label' }, 'All-in'),
      el('span', { className: 'poker-btn-sub' }, 'Postaw wszystko')
    );
    allInBtn.addEventListener('click', () => pokerAction({ action: 'act', move: 'all_in' }));

    controls.appendChild(el('div', { className: 'poker-actions-row' }, foldBtn, checkCallBtn, allInBtn));
    controls.appendChild(buildRaiseControls(legal, state));
  } else if (!state.me.canSit && state.table.phase !== 'waiting') {
    controls.appendChild(el('p', { className: 'poker-note' }, 'Czekasz na akcję innych graczy.'));
  }

  if (!state.me.canSit && !state.me.canStand && state.table.phase === 'waiting' && !state.me.canStart) {
    const sitCost = state.table.buyInCost || state.table.buyIn;
    const note = (state.profile?.coins || 0) < sitCost
      ? 'Potrzebujesz ' + sitCost + ' 🪙, żeby usiąść przy stole.'
      : 'Do startu potrzeba co najmniej dwóch graczy przy stole.';
    controls.appendChild(el('p', { className: 'poker-note' }, note));
  }

  return controls;
}

function buildRaiseControls(legal, state) {
  const min = legal.canRaise ? legal.minRaiseTo : 0;
  const max = legal.canRaise ? legal.maxRaiseTo : 0;
  const value = legal.canRaise ? min : 0;
  const input = el('input', {
    className: 'poker-raise-input',
    type: 'number',
    min,
    max,
    step: 1,
    value,
    inputMode: 'numeric',
    disabled: !legal.canRaise,
    ariaLabel: 'Kwota przebicia',
  });
  const slider = el('input', {
    type: 'range',
    min,
    max: Math.max(max, min),
    step: 1,
    value,
    disabled: !legal.canRaise,
  });
  slider.addEventListener('input', () => { input.value = slider.value; });
  input.addEventListener('input', () => { slider.value = input.value; });

  function setRaiseTo(v) {
    const clamped = Math.max(min, Math.min(max, Math.round(v)));
    input.value = clamped;
    slider.value = clamped;
  }

  // Pot-relative presets: raiseTo = currentBet + fraction · (pot + callAmount)
  const pot = (state?.table?.pot) || 0;
  const currentBet = (state?.table?.currentBet) || 0;
  const callAmount = legal.callAmount || 0;
  const potBase = pot + callAmount;
  const presets = el('div', { className: 'poker-raise-presets' });
  [['½ puli', 0.5], ['¾ puli', 0.75], ['Pula', 1]].forEach(([label, frac]) => {
    const btn = el('button', { className: 'poker-preset-btn', type: 'button', disabled: !legal.canRaise }, label);
    btn.addEventListener('click', () => setRaiseTo(currentBet + frac * potBase));
    presets.appendChild(btn);
  });
  const allInPreset = el('button', { className: 'poker-preset-btn', type: 'button', disabled: !legal.canRaise }, 'All-in');
  allInPreset.addEventListener('click', () => setRaiseTo(max));
  presets.appendChild(allInPreset);

  const raiseBtn = el('button', {
    className: 'poker-action-btn primary',
    type: 'button',
    disabled: !legal.canRaise,
  },
    el('span', { className: 'poker-btn-label' }, 'Raise'),
    el('span', { className: 'poker-btn-sub' }, 'Podbij stawkę')
  );
  raiseBtn.addEventListener('click', () => pokerAction({
    action: 'act',
    move: 'raise',
    raiseTo: Math.round(Number(input.value) || 0),
  }));

  return el('div', { className: 'poker-raise-box' },
    presets,
    el('div', { className: 'poker-raise-main' },
      el('div', {}, slider),
      el('div', {}, input, raiseBtn)
    )
  );
}

function buildPokerResult(result) {
  if (!result?.winners?.length) return null;
  const text = result.winners
    .map(w => w.nick + ' +' + w.amount + ' 🪙' + (w.description ? ' · ' + w.description : ''))
    .join(' | ');
  return el('div', { className: 'info-banner poker-info' },
    el('strong', {}, result.type === 'showdown' ? 'Ostatni showdown' : 'Ostatnie rozdanie'),
    el('div', {}, text)
  );
}

function buildPokerEvents(events) {
  if (!events || events.length === 0) {
    return el('div', { className: 'poker-events' }, el('p', { className: 'poker-note' }, 'Brak historii stołu.'));
  }
  const recent = events.slice(-4).reverse();
  return el('div', { className: 'poker-events' },
    ...recent.map(evt =>
      el('div', { className: 'poker-event-inline' },
        evt.message,
        ' ',
        el('span', { className: 'poker-event-time' }, '· ' + relTime(evt.created_at))
      )
    )
  );
}

function startPokerClock() {
  stopPokerClock(false);
  updatePokerClock();
  pokerClockTimer = setInterval(updatePokerClock, 1000);
}

function stopPokerClock(clearText = true) {
  if (pokerClockTimer) clearInterval(pokerClockTimer);
  pokerClockTimer = null;
  if (clearText && pokerClock) pokerClock.textContent = '--';
}

function updatePokerClock() {
  if (!pokerState?.table) {
    if (pokerClock) pokerClock.textContent = '--';
    return;
  }
  const deadline = pokerState.table.actionDeadline;
  if (!deadline || pokerState.table.phase === 'waiting') {
    pokerClock.textContent = phaseLabel(pokerState.table.phase);
    return;
  }
  const ms = new Date(deadline).getTime() - Date.now();
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  pokerClock.textContent = seconds > 0 ? 'czas ' + seconds + 's' : 'czas minął';
  const turnBar = document.querySelector('.poker-seat.turn .poker-turn-bar')
    || document.querySelector('.poker-turn-bar');
  if (turnBar) {
    const total = (pokerState.table.actionSeconds || 30) * 1000;
    turnBar.style.transform = `scaleX(${Math.max(0, Math.min(1, ms / total))})`;
  }
  if (ms <= 0 && activeTab === 'poker' && !pokerTimeoutClaiming) {
    pokerTimeoutClaiming = true;
    pokerAction({ action: 'claim_timeout' }, { silent: true }).finally(() => {
      pokerTimeoutClaiming = false;
    });
  }
}
