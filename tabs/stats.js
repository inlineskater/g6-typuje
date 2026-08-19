// Lazy-loaded tab module — see ensureTabModule() in index.html.
// Moved out of index.html's inline <script> so it is fetched only when
// this tab is actually opened. Owns its own top-level const/let; reads
// shared globals from index.html, which always runs first.
'use strict';

// ── Leaderboard ───────────────────────────────────────────────────────────
let _seasonHistory = null;

function normalizeSeasonAwardWeekStart(weekStart, gameType) {
  const date = parseWeekStartDate(weekStart);
  if (!date || date.getUTCDay() !== 0) return weekStart;

  const mondayWeekStart = addDaysStr(weekStart, 1);
  const mondaySeason = seasonalEntryForWeekStart(mondayWeekStart);
  return mondaySeason.gameType === gameType ? mondayWeekStart : weekStart;
}

// ── Per-game query shapes for loadSeasonHistory() ──────────────────────────
// Both maps hold ONLY the games that deviate from the default; the game list
// itself comes from SEASONAL_ROTATION. That is deliberate — these used to be
// hand-maintained parallel lists, and `healer_dungeon` + `filler` were never
// added to them, so their payouts ran and then showed up nowhere in the UI.

// Settled awards. Every seasonal game exposes `<gameType>_recent_awards` with
// the same columns, so only two games need an entry.
const SEASON_AWARD_DEFAULT_COLS = 'week_start,user_id,nick,rank,score,prize_coins,awarded_at';
const SEASON_AWARD_SOURCES = {
  // Reads the raw awards table (not the view) because `course_id` distinguishes
  // the legacy/hard/dynamic course eras.
  bug_jumper: {
    table: 'bug_jumper_weekly_awards',
    cols: 'week_start,user_id,nick_snapshot,rank,score,prize_coins,awarded_at,course_id',
  },
  // Ranks on progress then time, so the finish time has to come along.
  super_mariusz: {
    cols: 'week_start,user_id,nick,rank,score,completion_ms,prize_coins,awarded_at',
  },
};

// The live „na żywo" pending podium, read straight off `<gameType>_scores`.
// The default tiebreak is `accuracy`, which every seasonal scores table carries
// EXCEPT filler_scores — Filler ranks on score then submission time, and its
// extra stats are tiles/won. ⚠️ Selecting a column that does not exist makes
// postgrest return an error rather than rows, and loadSeasonHistory() reads a
// null payload as "nobody has played yet" — so a wrong entry here silently
// blanks that game's podium for its entire week instead of failing loudly.
const SEASON_LIVE_DEFAULT = { extra: 'accuracy', tiebreak: 'accuracy', opts: { ascending: false } };
const SEASON_LIVE_SOURCES = {
  super_mariusz: {
    extra: 'completion_ms,completed',
    tiebreak: 'completion_ms',
    opts: { ascending: true, nullsFirst: false },
  },
};

// Games whose weekly ranking is NOT "one row per run, take the best" and so
// cannot be derived by ordering the raw scores table — their `_current_week`
// view already returns one ranked row per user and is read as-is.
//   bug_jumper — averages each player's top 5 rounds.
//   filler     — a PvP LEAGUE: accumulated points with repeat-opponent decay
//                and a distinct-opponent bonus (supabase/filler-seasonal.sql).
// This used to be a hardcoded `isBugJumper` branch; filler is the second such
// game, and a third would otherwise mean a third branch.
const SEASON_LIVE_VIEW_SOURCES = {
  bug_jumper: 'user_id,nick,score,rounds_played,completion_ms,submitted_at',
  filler: 'user_id,nick,score,matches_played,wins,opponents,submitted_at',
};

function mapSeasonAwardRows(rows, gameType) {
  return (rows || []).map(r => ({
    ...r,
    nick: r.nick || r.nick_snapshot,
    week_start: normalizeSeasonAwardWeekStart(r.week_start, gameType),
    gameType,
  }));
}

function buildSeasonHistorySections(container, compact) {
  const medals = ['🥇', '🥈', '🥉'];
  const current = getCurrentSeasonalEntry();
  const seasons = recentSeasonalEntries(compact ? 2 : null);

  seasons.forEach(entry => {
    const seasonNum = entry.seasonNum;
    const isCurrent = current.weekStart === entry.weekStart;
    const awards = (_seasonHistory || []).filter(a => a.gameType === entry.gameType && a.week_start === entry.weekStart);
    const range = seasonDateFmt(entry.weekStart);

    const head = el('div', { className: 'season-history-head' },
      el('span', { className: 'season-history-title' }, 'Sezon ' + seasonNum + ' · ' + entry.displayName),
      el('span', { className: 'season-history-range' }, range),
      isCurrent ? el('span', { className: 'seasonal-chip active' }, 'aktywny') : null
    );
    const section = el('div', { className: 'season-history-section' }, head);

    const hasPending = awards.some(a => a.isPending);
    if (awards.length === 0) {
      section.append(el('p', { className: 'season-history-pending' },
        isCurrent ? '⏳ Sezon trwa — brak zapisanych wyników.' : 'Brak zapisanych wyników i nagród dla tego sezonu.'
      ));
    } else {
      const table = el('table', { className: 'lb-table-compact' });
      awards.slice(0, compact ? 3 : 10).forEach(a => {
        const tr = el('tr', {},
          el('td', { className: 'lb-rank' }, medals[a.rank - 1] || String(a.rank)),
          el('td', { className: 'lb-nick' + (a.nick === me?.nick ? ' me' : '') }, a.nick + (a.nick === me?.nick ? ' (Ty)' : ''))
        );
        if (hasPending) tr.append(lbScoreCell(a));
        tr.append(el('td', { className: 'lb-coins' }, (a.isPending ? '~' : '+') + a.prize_coins + ' 🪙'));
        table.append(tr);
      });
      section.append(table);
      if (hasPending) {
        const [py, pm, pd] = addDaysStr(entry.weekStart, 7).split('-').map(Number);
        section.append(el('p', { className: 'season-history-pending' },
          '⏳ Wyniki wstępne — nagrody zostaną wypłacone po zakończeniu tygodnia, w poniedziałek ' + pd + '.' + String(pm).padStart(2, '0') + '.'
        ));
      }
    }
    container.append(section);
  });
}

async function loadSeasonHistory() {
  const wrap = document.getElementById('seasons-preview-wrap');
  try {
    const current = getCurrentSeasonalEntry();
    const currentDbWeekStart = current.weekStart; // DB now also Monday-start
    const isSuperMariusz = current.gameType === 'super_mariusz';
    const viewCols = SEASON_LIVE_VIEW_SOURCES[current.gameType];
    let liveScoresQuery;
    if (viewCols) {
      // Pre-aggregated ranking: the view already returns one ranked row per
      // user, so there is nothing to order or dedup client-side.
      liveScoresQuery = sb.from(current.gameType + '_current_week')
        .select(viewCols)
        .order('rank')
        .limit(20);
    } else {
      const live = SEASON_LIVE_SOURCES[current.gameType] || SEASON_LIVE_DEFAULT;
      liveScoresQuery = sb.from(current.gameType + '_scores')
        .select('user_id,nick_snapshot,score,submitted_at,client_meta,' + live.extra)
        .eq('week_start', currentDbWeekStart)
        .order('score', { ascending: false });
      if (live.tiebreak) {
        liveScoresQuery = liveScoresQuery.order(live.tiebreak, live.opts);
      }
      liveScoresQuery = liveScoresQuery
        .order('submitted_at', { ascending: true })
        .limit(20);
    }

    // Award sources are DERIVED FROM SEASONAL_ROTATION, not hand-listed.
    // This used to be three parallel 10-element lists (queries, destructured
    // result names, mapSeasonAwardRows calls) that all had to be edited
    // together, and `healer_dungeon` + `filler` were simply never added — so
    // their payouts ran and then never appeared anywhere in the UI. Deriving
    // the list means a new seasonal game shows up here the moment it joins the
    // rotation. A game whose *_recent_awards view does not exist yet just
    // yields `data: null` (postgrest resolves rather than rejects), and
    // mapSeasonAwardRows already treats that as "no rows".
    const awardGames = SEASONAL_ROTATION.map(e => e.gameType);
    const awardRes = await Promise.all([
      ...awardGames.map(g => {
        const src = SEASON_AWARD_SOURCES[g] || {};
        return sb.from(src.table || (g + '_recent_awards'))
          .select(src.cols || SEASON_AWARD_DEFAULT_COLS)
          .order('week_start', { ascending: false })
          .order('rank');
      }),
      liveScoresQuery,
    ]);
    const liveRes = awardRes[awardRes.length - 1];

    // Build pending entries from live scores (dedup by user, keep best score)
    const PENDING_PRIZES = [1000, 500, 200];
    const seen = new Set();
    const pendingEntries = [];
    for (const r of (liveRes.data || [])) {
      if (seen.has(r.user_id)) continue;
      seen.add(r.user_id);
      const rank = pendingEntries.length + 1;
      const cm = r.client_meta || {};
      // View-backed rankings aggregate many runs into one row, so a single
      // run's base/bonus split is meaningless for them (and client_meta isn't
      // even selected) — show the aggregate as-is.
      const baseScore = !viewCols && !isSuperMariusz && cm.base_score != null ? Math.max(0, parseInt(cm.base_score) || 0) : r.score;
      const itemBonus = !viewCols && !isSuperMariusz && cm.item_effect?.bonus != null ? Math.max(0, parseInt(cm.item_effect.bonus) || 0) : 0;
      pendingEntries.push({
        user_id: r.user_id, nick: r.nick || r.nick_snapshot,
        week_start: current.weekStart, rank,
        score: r.score, base_score: baseScore, item_bonus: itemBonus,
        completion_ms: r.completion_ms, completed: r.completed,
        prize_coins: PENDING_PRIZES[rank - 1] || 0,
        isPending: true, gameType: current.gameType,
      });
    }

    _seasonHistory = [
      ...awardGames.flatMap((g, i) => mapSeasonAwardRows(awardRes[i].data, g)),
      ...pendingEntries,
    ];
    if (wrap) {
      wrap.replaceChildren();
      buildSeasonHistorySections(wrap, true);
    }
    renderMedalsPreview(document.getElementById('medals-wrap'));
  } catch {
    if (wrap) wrap.replaceChildren(el('p', { style: { color: 'var(--muted)', fontSize: '12px' } }, 'Błąd ładowania.'));
  }
}

async function loadLeaderboard() {
  const cashWrap = document.getElementById('leaderboard-cash-wrap');
  const netWrap = document.getElementById('leaderboard-net-wrap');
  const historyWrap = document.getElementById('transaction-history-wrap');
  const hazardHistWrap = document.getElementById('hazard-history-wrap');
  const hazardistaWrap = document.getElementById('hazardista-wrap');
  cashWrap.replaceChildren(makeSpinner());
  netWrap.replaceChildren(makeSpinner());
  historyWrap.replaceChildren(makeSpinner());
  hazardHistWrap.replaceChildren(makeSpinner());
  hazardistaWrap.replaceChildren(makeSpinner());
  showAllTransactions = false;
  showAllHazard = false;
  const seasonPromise = loadSeasonHistory();
  loadCoinRace(seasonPromise);

  const [leaderboardRes, leaderboardNetRes, tradesRes, marketsRes, allTradesRes, gameRes, hazardRes, playersRes] = await Promise.all([
    sb.from('leaderboard').select('*').neq('is_admin', true).order('coins', { ascending: false }).limit(20),
    sb.from('leaderboard').select('*').neq('is_admin', true).order('net_worth', { ascending: false }).limit(20),
    sb.from('trades').select('id, created_at, market_id, nick_snapshot, side, amount, shares, p_yes_after').order('created_at', { ascending: false }).limit(500),
    sb.from('markets').select('id, icon, title, resolved, resolution, yes_shares, no_shares'),
    // PostgREST caps a response at 1000 rows whatever .limit() asks for, so this
    // has to page — it feeds both the resolved-market payout math AND the
    // Trafność prognoz hit rate, and a truncated slice silently skews both.
    sbFetchAll(() => sb.from('trades').select('market_id, user_id, side, amount, shares')
      .order('created_at', { ascending: true }).order('id', { ascending: true })),
    sb.from('game_transactions').select('*').neq('is_admin', true).order('created_at', { ascending: false }).limit(500),
    sb.from('hazard_stats').select('*').neq('is_admin', true).order('total_pl', { ascending: false }),
    // Every player, not just a top-20 slice: Trafność and Medale need nicks for
    // people who may rank outside both money lists, plus the staff flag.
    sb.from('leaderboard').select('id, nick, is_admin'),
  ]);
  _playerIndex = new Map((playersRes.data || []).map(r => [r.id, { nick: r.nick, isAdmin: !!r.is_admin }]));
  // loadSeasonHistory() runs concurrently and may have rendered the medal table
  // before the index existed (falling back to nick snapshots, and unable to drop
  // staff). Now that it's here, repaint with the real names + admin filter.
  renderMedalsPreview(document.getElementById('medals-wrap'));

  if (leaderboardRes.error) {
    const errNode = () => el('p', { style: { color: 'var(--no)', fontSize: '14px', padding: '24px' } }, DB_ERROR_MESSAGE);
    cashWrap.replaceChildren(errNode());
    netWrap.replaceChildren(errNode());
  } else {
    const calibByUser = buildCalibrationByUser(allTradesRes.data || [], marketsRes.data || []);
    const cashData = leaderboardRes.data || [];
    const netData = leaderboardNetRes.data || [];
    // The detail modal (renderFullLeaderboard) re-sorts _lbData by either metric,
    // so seed it with the union of both top-20 lists (deduped by id).
    const byId = new Map();
    [...cashData, ...netData].forEach(r => { if (!byId.has(r.id)) byId.set(r.id, r); });
    _lbData = [...byId.values()];
    _lbCalib = calibByUser;
    _lbCashOrder = cashData.map(r => r.id);
    _lbNetOrder = netData.map(r => r.id);
    renderLeaderboardTable(cashWrap, cashData, 'coins');
    renderLeaderboardTable(netWrap, netData, 'net');
    renderCalibrationPreview(document.getElementById('calibration-wrap'));
    renderStatsHero();
  }

  renderHazardista(hazardistaWrap, hazardRes.data || []);

  if (tradesRes.error || marketsRes.error || allTradesRes.error) {
    historyWrap.replaceChildren(el('p', { style: { color: 'var(--no)', fontSize: '14px', padding: '24px' } }, DB_ERROR_MESSAGE));
  } else {
    marketHistoryRows = buildMarketHistoryRows(tradesRes.data || [], marketsRes.data || [], allTradesRes.data || []);
    renderMarketHistory(historyWrap, getFilteredMarketRows());
  }

  hazardHistoryRows = buildHazardHistoryRows(gameRes.data || []);
  renderHazardHistory(hazardHistWrap, getFilteredHazardRows());

  loadCoinInflowStats();
  loadActivityStats();
  loadEconomyStats();
}

// ── Skarbiec G6 — server-wide economy stats ───────────────────────────────

let _economyStats = null;

async function loadEconomyStats() {
  const wrap = document.getElementById('economy-preview-wrap');
  if (!wrap) return;
  try {
    const { data, error } = await sb.rpc('economy_stats');
    if (error || !data) {
      wrap.replaceChildren(el('p', { style: { color: 'var(--no)', fontSize: '13px', padding: '12px' } }, 'Błąd ładowania danych.'));
      return;
    }
    _economyStats = data;
    renderEconomyPreview(wrap, data);
  } catch {
    wrap.replaceChildren(el('p', { style: { color: 'var(--no)', fontSize: '13px', padding: '12px' } }, 'Błąd ładowania danych.'));
  }
}

function renderEconomyPreview(wrap, s) {
  const locked = s.total_supply - s.total_cash;
  const cashPct = s.total_supply > 0 ? Math.round(s.total_cash / s.total_supply * 100) : 0;
  const lockedPct = 100 - cashPct;

  // Two-segment supply bar
  const barWrap = el('div', { style: { display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden', margin: '8px 0 14px', background: 'var(--border)' } },
    el('div', { style: { width: cashPct + '%', background: 'var(--yes)', transition: 'width .4s' } }),
    el('div', { style: { width: lockedPct + '%', background: 'var(--accent)', transition: 'width .4s' } })
  );

  const row = (label, val, pct) => el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '1px 0' } },
    el('span', { style: { color: 'var(--muted)', fontWeight: 600 } }, label),
    el('span', { style: { fontWeight: 700 } }, fmtNum(val) + ' 🪙' + (pct !== undefined ? ' (' + pct + '%)' : ''))
  );

  const bankNet = (s.total_house_net || 0);
  const bankLabel = bankNet >= 0 ? '📈 Bank zarobił' : '📉 Bank stracił';

  wrap.replaceChildren(
    row('Łączna podaż', s.total_supply),
    barWrap,
    row('W obiegu (gotówka)', s.total_cash, cashPct),
    row('Zablokowane (w grze)', locked, lockedPct),
    row('📈 Wyemitowano (łącznie)', s.total_minted || 0),
    row('🔥 Spalono w sklepach i opłatach', s.shop_burned || 0),
    row(bankLabel + ' (net)', Math.abs(bankNet)),
    el('div', { style: { fontSize: '11px', color: 'var(--dim)', marginTop: '8px', fontWeight: 600 } },
      'Graczy: ' + s.players + ' · śr. ' + fmtNum(Math.round(s.total_supply / (s.players || 1))) + ' · Kliknij po szczegóły →')
  );
}

function renderEconomyDetail(container) {
  if (_economyStats) {
    _buildEconomyDetailContent(container, _economyStats);
    return;
  }
  container.replaceChildren(makeSpinner());
  sb.rpc('economy_stats').then(({ data, error }) => {
    if (error || !data) { container.replaceChildren(el('p', {}, 'Błąd ładowania danych.')); return; }
    _economyStats = data;
    container.replaceChildren();
    _buildEconomyDetailContent(container, data);
  });
}

function _buildEconomyDetailContent(container, s) {
  const locked = s.total_supply - s.total_cash;
  const pct = v => s.total_supply > 0 ? (v / s.total_supply * 100).toFixed(1) + '%' : '0%';

  // ── Section helper ─────────────────────────────────────────────────────
  const section = (title) => {
    const h = el('div', { style: { fontSize: '11px', fontWeight: 800, textTransform: 'uppercase',
      letterSpacing: '.05em', color: 'var(--muted)', margin: '20px 0 8px' } }, title);
    return h;
  };

  // ── 1. Podaż pieniądza ─────────────────────────────────────────────────
  const cashPct = s.total_supply > 0 ? Math.round(s.total_cash / s.total_supply * 100) : 0;
  const lockedPct = 100 - cashPct;

  const bonkCell = (label, valText, sub, cls) => el('div', { className: 'fb-bonk-cell' },
    el('span', { className: 'fb-bonk-label' }, label),
    el('span', { className: 'fb-bonk-val ' + (cls || '') }, valText),
    sub ? el('span', { className: 'fb-bonk-sub' }, sub) : ''
  );

  const supplyBar = el('div', { style: { display: 'flex', height: '12px', borderRadius: '6px', overflow: 'hidden',
    margin: '12px 0 4px', background: 'var(--border)' } },
    el('div', { style: { width: cashPct + '%', background: 'var(--yes)', transition: 'width .4s' } }),
    el('div', { style: { width: lockedPct + '%', background: 'var(--accent)', transition: 'width .4s' } })
  );
  const barLegend = el('div', { style: { display: 'flex', gap: '14px', fontSize: '11px', color: 'var(--dim)', marginBottom: '4px' } },
    el('span', {}, '🟢 Gotówka ' + cashPct + '%'),
    el('span', {}, '🔵 W grze ' + lockedPct + '%')
  );

  // ── 2. Breakdown chips ─────────────────────────────────────────────────
  const chipRow = (icon, label, val) => el('div', { className: 'fb-stat-chip' },
    el('span', { className: 'fb-stat-label' }, icon + ' ' + label),
    el('span', { className: 'fb-stat-nick' }, fmtNum(val) + ' 🪙'),
    el('span', { className: 'fb-stat-val' }, pct(val) + ' podaży')
  );

  const chips = el('div', { className: 'fb-stats-chips' },
    chipRow('📈', 'Rynki (pozycje)', s.market_positions),
    chipRow('⚽', 'Mundial (zakłady)', s.football_open),
    chipRow('🃏', 'Poker (stosy)', s.poker_stacks),
    chipRow('🎒', 'Przedmioty', s.hero_items),
    chipRow('🌱', 'Akcesoria', s.accessories),
    chipRow('🏷️', 'Aukcje+Targowisko', s.marketplace_escrow + s.hero_auction_escrow)
  );

  // ── 3. Koncentracja majątku ────────────────────────────────────────────
  const holdings = (s.holdings || []).map(Number).filter(v => !isNaN(v) && v >= 0);
  const totalNW = holdings.reduce((a, b) => a + b, 0);
  let concentrationSection = '';
  if (holdings.length > 0) {
    const richestPct = totalNW > 0 ? (holdings[0] / totalNW * 100).toFixed(1) : '0';
    const top3 = holdings.slice(0, 3).reduce((a, b) => a + b, 0);
    const top3Pct = totalNW > 0 ? (top3 / totalNW * 100).toFixed(1) : '0';

    // Gini coefficient
    const sorted = [...holdings].sort((a, b) => a - b);
    const n = sorted.length;
    let giniNum = 0;
    sorted.forEach((v, i) => { giniNum += (2 * (i + 1) - n - 1) * v; });
    const gini = n > 1 ? (giniNum / (n * sorted.reduce((a, b) => a + b, 0))).toFixed(2) : '0';

    concentrationSection = el('div', { className: 'fb-stats-chips' },
      el('div', { className: 'fb-stat-chip' },
        el('span', { className: 'fb-stat-label' }, '🥇 Najbogatszy'),
        el('span', { className: 'fb-stat-nick' }, s.richest ? s.richest.nick : '—'),
        el('span', { className: 'fb-stat-val' }, fmtNum(holdings[0]) + ' 🪙 · ' + richestPct + '% majątku')
      ),
      el('div', { className: 'fb-stat-chip' },
        el('span', { className: 'fb-stat-label' }, '🏅 Top-3 gracze'),
        el('span', { className: 'fb-stat-nick' }, top3Pct + '%'),
        el('span', { className: 'fb-stat-val' }, 'majątku w rękach top 3')
      ),
      el('div', { className: 'fb-stat-chip' },
        el('span', { className: 'fb-stat-label' }, '📐 Współczynnik Giniego'),
        el('span', { className: 'fb-stat-nick' }, gini),
        el('span', { className: 'fb-stat-val' }, '0 = pełna równość · 1 = max nierówność')
      )
    );
  }

  // ── 4. Rozkład (distribution) ──────────────────────────────────────────
  let distributionSection = '';
  if (holdings.length > 0) {
    const avg = Math.round(totalNW / holdings.length);
    const mid = Math.floor(holdings.length / 2);
    const median = holdings.length % 2 === 0
      ? Math.round((holdings[mid - 1] + holdings[mid]) / 2)
      : holdings[mid];
    const minV = holdings[holdings.length - 1];
    const maxV = holdings[0];

    // Histogram: 5 brackets
    const brackets = [];
    const step = Math.ceil((maxV - minV + 1) / 5) || 1;
    for (let i = 0; i < 5; i++) {
      const lo = minV + i * step, hi = lo + step - 1;
      const count = holdings.filter(v => v >= lo && v <= hi).length;
      brackets.push({ lo, hi, count });
    }
    const maxCount = Math.max(...brackets.map(b => b.count)) || 1;

    const histBars = brackets.map(b => {
      const barH = Math.max(4, Math.round(b.count / maxCount * 48));
      return el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px', flex: 1 } },
        el('span', { style: { fontSize: '10px', fontWeight: 700, color: 'var(--text)' } }, String(b.count)),
        el('div', { style: { width: '100%', height: barH + 'px', background: 'var(--accent)', borderRadius: '3px 3px 0 0', opacity: .75 } }),
        el('span', { style: { fontSize: '9px', color: 'var(--dim)', textAlign: 'center', lineHeight: 1.2 } },
          fmtNum(b.lo) + '–' + fmtNum(b.hi))
      );
    });

    const histogram = el('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '4px', height: '72px',
      padding: '8px 0 0', margin: '8px 0 0' } }, ...histBars);

    const statRow = (label, val) => el('div', { style: { display: 'flex', justifyContent: 'space-between',
      fontSize: '12px', padding: '2px 0' } },
      el('span', { style: { color: 'var(--muted)', fontWeight: 600 } }, label),
      el('span', { style: { fontWeight: 700 } }, fmtNum(val) + ' 🪙')
    );

    distributionSection = el('div', { style: { background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: '10px', padding: '12px 14px' } },
      statRow('Graczy', holdings.length),
      statRow('Średnia (net worth)', avg),
      statRow('Mediana', median),
      statRow('Minimum', minV),
      statRow('Maksimum', maxV),
      histogram
    );
  }

  // ── 5. Coin flow: emission, spending, bank balance ────────────────────────
  const bankNet = s.football_house_net + s.hazard_house_net;
  const bankCls = bankNet >= 0 ? 'fb-profit-pos' : 'fb-profit-neg';
  const bankSign = bankNet >= 0 ? '+' : '';

  const flowChips = el('div', { className: 'fb-stats-chips' },
    chipRow('🌿', 'Aktywności (ogrody, admin)', s.ledger_minted),
    chipRow('🏆', 'Nagrody gier sezonowych', s.prizes_minted),
    chipRow('🛒', 'Wydano w sklepach, opłatach i pixelach', s.shop_burned),
    el('div', { className: 'fb-stat-chip' },
      el('span', { className: 'fb-stat-label' }, '⚽ Bank — Mundial (net)'),
      el('span', { className: 'fb-stat-nick ' + (s.football_house_net >= 0 ? 'fb-profit-pos' : 'fb-profit-neg') },
        (s.football_house_net >= 0 ? '+' : '') + fmtNum(s.football_house_net) + ' 🪙'),
      el('span', { className: 'fb-stat-val' }, s.football_house_net >= 0 ? 'spalone przez bank' : 'wyemitowane przez bank')
    ),
    el('div', { className: 'fb-stat-chip' },
      el('span', { className: 'fb-stat-label' }, '🎰 Bank — Hazard (net)'),
      el('span', { className: 'fb-stat-nick ' + (s.hazard_house_net >= 0 ? 'fb-profit-pos' : 'fb-profit-neg') },
        (s.hazard_house_net >= 0 ? '+' : '') + fmtNum(s.hazard_house_net) + ' 🪙'),
      el('span', { className: 'fb-stat-val' }, s.hazard_house_net >= 0 ? 'spalone przez bank' : 'wyemitowane przez bank')
    ),
    (s.farm_tax_debt || 0) > 0 ? el('div', { className: 'fb-stat-chip' },
      el('span', { className: 'fb-stat-label' }, '🏛️ Zaległy podatek od działek'),
      el('span', { className: 'fb-stat-nick fb-profit-neg' }, '−' + fmtNum(s.farm_tax_debt) + ' 🪙'),
      el('span', { className: 'fb-stat-val' }, 'dług graczy — pomniejsza ich net worth')
    ) : ''
  );

  container.replaceChildren(
    section('📦 Podaż pieniądza'),
    el('div', { className: 'fb-bonk-strip' },
      bonkCell('💰 Łączna podaż', fmtNum(s.total_supply) + ' 🪙', 'graczy: ' + s.players),
      bonkCell('💵 Gotówka', fmtNum(s.total_cash) + ' 🪙', cashPct + '% podaży — w portfelach'),
      bonkCell('🔒 W grze', fmtNum(locked) + ' 🪙', lockedPct + '% podaży — zablokowane')
    ),
    supplyBar,
    barLegend,
    section('📊 Gdzie są coiny'),
    chips,
    section('💸 Emisja, spalanie i bank'),
    el('div', { className: 'fb-bonk-strip' },
      bonkCell('📈 Wyemitowano', fmtNum(s.total_minted) + ' 🪙', 'nagrody + aktywności'),
      bonkCell('🔥 Spalono (sklepy i opłaty)', fmtNum(s.shop_burned) + ' 🪙', 'zakupy, przedmioty, pixele'),
      el('div', { className: 'fb-bonk-cell' },
        el('span', { className: 'fb-bonk-label' }, '🏦 Bank — zarobek netto'),
        el('span', { className: 'fb-bonk-val ' + bankCls }, bankSign + fmtNum(bankNet) + ' 🪙'),
        el('span', { className: 'fb-bonk-sub' }, bankNet >= 0 ? 'bank spalił więcej niż wyemitował' : 'bank wyemitował więcej niż spalił')
      )
    ),
    flowChips,
    section('💎 Koncentracja majątku'),
    concentrationSection || el('p', { style: { fontSize: '12px', color: 'var(--dim)' } }, 'Brak danych.'),
    section('📈 Rozkład majątku'),
    distributionSection || el('p', { style: { fontSize: '12px', color: 'var(--dim)' } }, 'Brak danych.')
  );
}

// ── end Skarbiec G6 ───────────────────────────────────────────────────────

function buildCalibrationByUser(allTrades, marketsData) {
  const resolvedMarkets = {};
  (marketsData || []).forEach(m => {
    if (m.resolved && m.resolution) resolvedMarkets[m.id] = m.resolution;
  });
  const userMarketSide = {};
  (allTrades || []).forEach(t => {
    if (!resolvedMarkets[t.market_id] || !t.user_id) return;
    const key = t.user_id + ':' + t.market_id;
    if (!userMarketSide[key]) userMarketSide[key] = { userId: t.user_id, side: t.side, marketId: t.market_id };
  });
  const result = {};
  Object.values(userMarketSide).forEach(({ userId, side, marketId }) => {
    if (!result[userId]) result[userId] = { correct: 0, total: 0 };
    result[userId].total++;
    if (side === resolvedMarkets[marketId]) result[userId].correct++;
  });
  return result;
}

function lbCoinsCell(row) {
  // Wealth held outside free cash: open market/Mundial bets + poker stack + owned items/certificates.
  const locked = Math.max(0, Math.round((+row.net_worth || 0) - (+row.coins || 0)));
  return el('td', { className: 'lb-coins' },
    el('span', {}, fmtNum(row.coins) + ' 🪙'),
    locked >= 1 ? el('span', { className: 'lb-locked' }, '+' + fmtNum(locked) + ' poza gotówką') : null
  );
}

// Renders the "Bilans Net Worth" breakdown from user_net_worth_breakdown() RPC:
// every component that sums into net_worth, with the owned hero items itemized.
function renderNetWorthBreakdown(container, b) {
  const fmt = n => fmtNum(n) + ' 🪙';
  const parts = [
    ['🪙', 'Gotówka', b.cash, true],
    ['📊', 'Pozycje na rynkach', b.market_positions, false],
    ['⚽', 'Zakłady Mundial (otwarte)', b.football_open, false],
    ['🃏', 'Stack w pokerze', b.poker_stack, false],
    ['🎒', 'Przedmioty i certyfikaty', b.hero_items, false],
    ['🌿', 'Akcesoria ogrodowe', b.accessories, false],
    ['🌱', 'Ogródek', b.farm, false],
  ];
  const fp = b.farm_parts || {};
  const farmSubs = [
    ['Działki', fp.land],
    ['Karty roślin', fp.cards],
    ['Karty NFT', fp.nft],
    ['Plony (w skupie)', fp.crops],
    ['Skrzynki i vouchery', fp.boxes],
  ];
  const rows = [];
  parts.forEach(([icon, label, val, always]) => {
    if (!always && !val) return;
    rows.push(el('tr', { className: 'nw-row' },
      el('td', { className: 'nw-label' }, icon + ' ' + label),
      el('td', { className: 'nw-val' }, fmt(+val || 0))
    ));
    if (label.startsWith('Przedmioty') && Array.isArray(b.items)) {
      b.items.forEach(it => rows.push(el('tr', { className: 'nw-subrow' },
        el('td', { className: 'nw-sublabel' }, '· ' + it.name + (it.source === 'auction' ? ' (aukcja)' : '')),
        el('td', { className: 'nw-subval' }, fmt(+it.value || 0))
      )));
    }
    if (label === 'Ogródek') {
      farmSubs.forEach(([sl, sv]) => { if (+sv) rows.push(el('tr', { className: 'nw-subrow' },
        el('td', { className: 'nw-sublabel' }, '· ' + sl),
        el('td', { className: 'nw-subval' }, fmt(+sv || 0))
      )); });
    }
  });
  const taxDebt = Math.round(+b.farm_tax_debt || 0);
  if (taxDebt > 0) {
    rows.push(el('tr', { className: 'nw-row' },
      el('td', { className: 'nw-label' }, '🏛️ Podatek od działek (dług)'),
      el('td', { className: 'nw-val', style: { color: 'var(--no)' } }, '−' + fmt(taxDebt))
    ));
  }
  rows.push(el('tr', { className: 'nw-total' },
    el('td', {}, '💎 Net Worth'),
    el('td', { className: 'nw-val' }, fmt(+b.total || 0))
  ));
  container.append(
    el('div', { className: 'user-profile-section-title' }, 'Bilans Net Worth'),
    el('table', { className: 'nw-breakdown' }, el('tbody', {}, ...rows))
  );
}

// ── „Twoja pozycja" hero strip ────────────────────────────────────────────
// Four headline numbers for the logged-in player, each opening the ranking it
// was taken from. Re-run from every loader that feeds it (leaderboard,
// hazardista, coin inflows) — it rebuilds from globals, so partial data just
// renders as „—" until the rest lands.
function renderStatsHero() {
  const wrap = document.getElementById('stats-hero');
  if (!wrap || !me) return;

  const rankOf = order => {
    const i = order.indexOf(me.id);
    return i >= 0 ? i + 1 : null;
  };
  const rankSub = rank => rank
    ? el('span', {}, 'miejsce ', el('span', { className: 'st-rank' }, '#' + rank), ' w Top 20')
    : el('span', {}, 'poza Top 20');

  const tile = (label, value, sub, detail, valueClass) => {
    const t = el('button', { className: 'st-tile', type: 'button' },
      el('span', { className: 'st-tile-label' }, label),
      el('span', { className: 'st-tile-value' + (valueClass ? ' ' + valueClass : '') }, value),
      el('span', { className: 'st-tile-sub' }, sub)
    );
    t.addEventListener('click', () => openStatsDetail && openStatsDetail(detail));
    return t;
  };

  const lbRow = (_lbData || []).find(r => r.id === me.id);
  const netWorth = lbRow ? Math.round(+lbRow.net_worth || 0) : null;
  const hz = (_hazardistaData || []).find(r => r.user_id === me.id);
  const hzPl = hz ? Math.round(+hz.total_pl || 0) : null;
  const inflow = (_coinInflowStats || []).find(r => r.user_id === me.id);

  wrap.replaceChildren(
    tile('🪙 Gotówka', fmtNum(me.coins) + ' 🪙', rankSub(rankOf(_lbCashOrder)), 'ranking-cash'),
    tile('💎 Net Worth', netWorth == null ? '—' : fmtNum(netWorth) + ' 🪙', rankSub(rankOf(_lbNetOrder)), 'ranking-net'),
    tile('🎰 Bilans kasyna',
      hzPl == null ? '—' : (hzPl > 0 ? '+' : '') + fmtNum(hzPl) + ' 🪙',
      el('span', {}, hzPl == null ? 'brak gier' : hzPl >= 0 ? 'na plusie' : 'na minusie'),
      'hazardista',
      hzPl == null ? null : hzPl >= 0 ? 'st-pos' : 'st-neg'),
    tile('💸 Zarobione coiny',
      inflow ? fmtNum(inflow.total_inflow) + ' 🪙' : '—',
      el('span', {}, 'bez startowych 1000 🪙'),
      'coin-inflows')
  );
}

// Preview tables live outside the ranking-modal IIFE, so this is the shared way
// they hand a row off to the player wallet. `coins` comes from _lbData (the
// wallet headline needs it); rows for players outside both top-20 lists stay
// non-clickable rather than opening a profile with a wrong balance.
function makeStatsRowClickable(tr, userId, nick) {
  const row = (_lbData || []).find(r => r.id === userId);
  if (!row || !openStatsUserProfile) return tr;
  tr.classList.add('lb-row-clickable');
  tr.addEventListener('click', e => {
    e.stopPropagation();
    openStatsUserProfile(userId, nick, +row.coins || 0);
  });
  return tr;
}

function statsNick(userId, fallback) {
  return _playerIndex.get(userId)?.nick || fallback || '?';
}
function statsIsAdmin(userId) {
  return !!_playerIndex.get(userId)?.isAdmin;
}
function statsEmpty(wrap, text) {
  wrap.replaceChildren(el('p', { style: { color: 'var(--muted)', fontSize: '12px', padding: '12px' } }, text));
}

// ── 🎯 Trafność prognoz ───────────────────────────────────────────────────
// buildCalibrationByUser() has been computing this on every stats load since
// forever and nothing ever rendered it. One row per player: how many resolved
// markets they took a side on, and how often that side won. A player is counted
// once per market (their first trade's side), so spamming trades on one market
// can't inflate the sample.
// Raw hit rate always flatters a tiny sample — 1/1 is 100%. Every current
// player has already called at least 5 resolved markets, so requiring 5 to be
// ranked costs nobody a place and stops a single lucky guess taking the crown.
const CALIB_MIN_MARKETS = 5;

function calibrationRows() {
  return Object.entries(_lbCalib || {})
    .filter(([uid, c]) => c && c.total > 0 && !statsIsAdmin(uid))
    .map(([uid, c]) => ({
      user_id: uid,
      nick: statsNick(uid),
      correct: c.correct,
      total: c.total,
      pct: c.total > 0 ? (c.correct / c.total) * 100 : 0,
    }))
    // Ranked among players with a usable sample; everyone else is listed after
    // them so a 1-for-1 lucky guess never tops the table.
    .sort((a, b) => {
      const aQ = a.total >= CALIB_MIN_MARKETS, bQ = b.total >= CALIB_MIN_MARKETS;
      if (aQ !== bQ) return aQ ? -1 : 1;
      return b.pct - a.pct || b.total - a.total || a.nick.localeCompare(b.nick, 'pl');
    });
}

function calibPctCell(row) {
  const cls = row.pct >= 60 ? 'tx-pl-profit' : row.pct < 40 ? 'tx-pl-loss' : 'tx-pl-flat';
  return el('td', { className: 'tx-pl ' + cls }, Math.round(row.pct) + '%');
}

function renderCalibrationPreview(wrap) {
  if (!wrap) return;
  const rows = calibrationRows();
  if (!rows.length) { statsEmpty(wrap, 'Brak rozstrzygniętych rynków.'); return; }
  const shown = rows.slice(0, 8);
  const trs = shown.map((row, i) => makeStatsRowClickable(el('tr', {},
    el('td', { className: 'lb-rank' + (i === 0 ? ' gold' : '') }, i === 0 ? '🥇' : String(i + 1)),
    el('td', { className: 'lb-nick' + (row.user_id === me.id ? ' me' : '') },
      row.nick + (row.user_id === me.id ? ' (Ty)' : '')),
    el('td', { className: 'lb-coins' }, row.correct + '/' + row.total),
    calibPctCell(row)
  ), row.user_id, row.nick));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'), el('th', {}, 'Nick'), el('th', {}, 'Trafione'), el('th', {}, 'Skuteczność')
      )),
      el('tbody', {}, ...trs)
    ),
    el('span', { className: 'rc-more' }, 'Kto najlepiej typuje rynki ›')
  );
}

function renderCalibrationDetail(container) {
  const rows = calibrationRows();
  if (!rows.length) { container.append(el('p', {}, 'Żaden rynek nie został jeszcze rozstrzygnięty.')); return; }
  const trs = rows.map((row, i) => {
    const thin = row.total < CALIB_MIN_MARKETS;
    const tr = el('tr', { className: 'lb-row-clickable' + (thin ? ' calib-thin' : '') },
      // Thin samples are listed, not ranked — a position number next to 100%
      // would read as „worse than 38%" rather than „not enough data".
      el('td', { className: 'lb-rank' + (i === 0 && !thin ? ' gold' : '') },
        thin ? '—' : i === 0 ? '🥇' : String(i + 1)),
      el('td', { className: 'lb-nick' + (row.user_id === me.id ? ' me' : '') },
        row.nick + (row.user_id === me.id ? ' (Ty)' : '')),
      el('td', {}, String(row.total)),
      el('td', {}, String(row.correct)),
      el('td', {}, String(row.total - row.correct)),
      calibPctCell(row),
      el('td', { className: 'calib-bar-cell' },
        el('div', { className: 'calib-bar' }, el('div', {
          className: 'calib-bar-fill' + (row.pct >= 60 ? ' is-good' : row.pct < 40 ? ' is-bad' : ''),
          style: { width: Math.max(2, row.pct) + '%' },
        })))
    );
    if (openStatsUserProfile) tr.addEventListener('click', () => openStatsUserProfile(row.user_id, row.nick, +(_lbData.find(r => r.id === row.user_id)?.coins) || 0));
    return tr;
  });
  container.append(
    el('table', { className: 'lb-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'), el('th', {}, 'Nick'), el('th', {}, 'Rynków'), el('th', {}, 'Trafione'),
        el('th', {}, 'Chybione'), el('th', {}, 'Skuteczność'), el('th', {}, '')
      )),
      el('tbody', {}, ...trs)
    ),
    el('div', { className: 'lb-legend' },
      el('p', {}, el('strong', {}, 'Jak to liczymy'), ' — bierzemy tylko rynki, które zostały już rozstrzygnięte. Liczy się strona, którą obstawiłeś jako pierwszą; kolejne zakłady na tym samym rynku nic nie zmieniają, więc nie da się „nabić" statystyki.'),
      el('p', {}, el('strong', {}, 'Wyszarzone wiersze'), ' — mniej niż ' + CALIB_MIN_MARKETS + ' rozstrzygniętych rynków. Za mała próbka, żeby mówić o skuteczności (1/1 to też 100%), więc lądują na końcu tabeli.'),
      el('p', {}, 'Skuteczność to nie to samo co zysk — trafienie taniego faworyta płaci mniej niż trafienie outsidera.')
    ),
    el('p', { className: 'lb-click-hint' }, '👆 Kliknij gracza, aby zobaczyć historię coinów')
  );
}

// ── 🏅 Medale sezonowe ────────────────────────────────────────────────────
// Olympic medal table over every weekly seasonal award ever paid, across all
// ten games. Scores can't be summed across games (30 is a perfect Bug Jumper
// run and nothing in Tetris), so podium places are the only fair common unit.
function medalTable() {
  const by = new Map();
  (_seasonHistory || []).forEach(a => {
    // Pending rows are this week's LIVE standings, not awarded medals yet.
    if (a.isPending || !a.user_id || !a.rank || a.rank > 3) return;
    if (statsIsAdmin(a.user_id)) return;
    if (!by.has(a.user_id)) {
      by.set(a.user_id, { user_id: a.user_id, nick: statsNick(a.user_id, a.nick), g: 0, s: 0, b: 0, coins: 0, games: new Map() });
    }
    const row = by.get(a.user_id);
    row[a.rank === 1 ? 'g' : a.rank === 2 ? 's' : 'b']++;
    row.coins += +a.prize_coins || 0;
    row.games.set(a.gameType, (row.games.get(a.gameType) || 0) + (a.rank === 1 ? 1 : 0));
  });
  return [...by.values()].sort((x, y) =>
    y.g - x.g || y.s - x.s || y.b - x.b || y.coins - x.coins || x.nick.localeCompare(y.nick, 'pl'));
}

function medalCountsCell(row) {
  return el('td', { className: 'medal-counts' },
    el('span', { className: row.g ? '' : 'is-zero' }, '🥇' + row.g),
    el('span', { className: row.s ? '' : 'is-zero' }, '🥈' + row.s),
    el('span', { className: row.b ? '' : 'is-zero' }, '🥉' + row.b)
  );
}

function renderMedalsPreview(wrap) {
  if (!wrap) return;
  const rows = medalTable();
  if (!rows.length) { statsEmpty(wrap, 'Nikt jeszcze nie stanął na podium.'); return; }
  const shown = rows.slice(0, 8);
  const trs = shown.map((row, i) => makeStatsRowClickable(el('tr', {},
    el('td', { className: 'lb-rank' + (i === 0 ? ' gold' : '') }, i === 0 ? '🥇' : String(i + 1)),
    el('td', { className: 'lb-nick' + (row.user_id === me.id ? ' me' : '') },
      row.nick + (row.user_id === me.id ? ' (Ty)' : '')),
    medalCountsCell(row),
    el('td', { className: 'lb-net' }, fmtNum(row.coins) + ' 🪙')
  ), row.user_id, row.nick));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'), el('th', {}, 'Nick'), el('th', {}, 'Medale'), el('th', {}, 'Nagrody')
      )),
      el('tbody', {}, ...trs)
    ),
    el('span', { className: 'rc-more' }, rows.length > 8
      ? '+ ' + (rows.length - 8) + ' ' + plCount(rows.length - 8, 'gracz', 'gracze', 'graczy') + ' — cała tabela ›'
      : 'Podium tygodniowych gier sezonowych ›')
  );
}

function renderMedalsDetail(container) {
  const rows = medalTable();
  if (!rows.length) {
    container.append(el('p', {}, 'Nikt jeszcze nie stanął na podium gry sezonowej.'));
    return;
  }
  const trs = rows.map((row, i) => {
    // Which games someone actually WON — the reason a medal table beats a
    // points total: it says what you're good at, not just how much you played.
    const golds = [...row.games.entries()].filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([g, n]) => (ACT_GAME_LABELS[g] || g) + (n > 1 ? ' ×' + n : ''));
    const tr = el('tr', { className: 'lb-row-clickable' },
      el('td', { className: 'lb-rank' + (i === 0 ? ' gold' : '') }, i === 0 ? '🥇' : String(i + 1)),
      el('td', { className: 'lb-nick' + (row.user_id === me.id ? ' me' : '') },
        row.nick + (row.user_id === me.id ? ' (Ty)' : '')),
      medalCountsCell(row),
      el('td', {}, String(row.g + row.s + row.b)),
      el('td', { className: 'medal-games' }, golds.length ? golds.join(' · ') : '—'),
      el('td', { className: 'lb-net' }, fmtNum(row.coins) + ' 🪙')
    );
    if (openStatsUserProfile) tr.addEventListener('click', () => openStatsUserProfile(row.user_id, row.nick, +(_lbData.find(r => r.id === row.user_id)?.coins) || 0));
    return tr;
  });
  container.append(
    el('table', { className: 'lb-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'), el('th', {}, 'Nick'), el('th', {}, 'Medale'), el('th', {}, 'Razem'),
        el('th', {}, 'Wygrane gry 🥇'), el('th', {}, 'Nagrody')
      )),
      el('tbody', {}, ...trs)
    ),
    el('div', { className: 'lb-legend' },
      el('p', {}, el('strong', {}, 'Jedna gra na tydzień'), ' — co poniedziałek rano wypłacane jest podium poprzedniego tygodnia (🥇 1000 / 🥈 500 / 🥉 200 🪙). Tabela zbiera wszystkie takie podia ze wszystkich gier sezonowych.'),
      el('p', {}, el('strong', {}, 'Kolejność'), ' — jak na olimpiadzie: najpierw złota, potem srebrne, potem brązowe. Wyników nie da się sumować między grami, więc liczą się miejsca, nie punkty.'),
      el('p', {}, 'Bieżący, jeszcze nierozliczony tydzień się nie liczy — pojawi się tu po poniedziałkowej wypłacie.')
    ),
    el('p', { className: 'lb-click-hint' }, '👆 Kliknij gracza, aby zobaczyć historię coinów')
  );
}

// ── 📅 Aktywność ──────────────────────────────────────────────────────────
// Backed by player_activity_stats() (supabase/activity-stats.sql). It has to be
// a server-side aggregate: casino spin tables and seasonal *_scores are own-row
// RLS and canvas_paint_log has no client grants, so the browser cannot see what
// anyone else played.
const ACT_KINDS = [
  ['casino',      '🎰', 'Kasyno'],
  ['games',       '🎮', 'Gry'],
  ['farm',        '🌱', 'Ogródek'],
  ['markets',     '📊', 'Rynki'],
  ['football',    '⚽', 'Mundial'],
  ['marketplace', '🛍️', 'Targowisko'],
  ['canvas',      '🎨', 'Płótno'],
];
const ACT_KIND_BY_KEY = new Map(ACT_KINDS.map(([k, icon, label]) => [k, { icon, label }]));

function actKindLabel(kind) {
  const k = ACT_KIND_BY_KEY.get(kind);
  return k ? k.icon + ' ' + k.label : '—';
}

// „dziś" / „wczoraj" / „3 dni temu" — a bare date makes you do the arithmetic.
function actLastSeenLabel(iso) {
  if (!iso) return '—';
  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86400000);
  if (days <= 0) return 'dziś';
  if (days === 1) return 'wczoraj';
  if (days < 31) return days + ' dni temu';
  return new Date(iso).toLocaleDateString('pl-PL');
}

async function loadActivityStats() {
  const wrap = document.getElementById('activity-wrap');
  if (wrap) wrap.replaceChildren(makeSpinner());
  try {
    const { data, error } = await sb.rpc('player_activity_stats');
    _activityLoaded = true;
    if (error) {
      _activityError = error.message || 'Błąd ładowania danych.';
      if (wrap) statsEmpty(wrap, 'Brak funkcji player_activity_stats w bazie — uruchom supabase/activity-stats.sql.');
      return;
    }
    _activityError = '';
    _activityStats = data || [];
    if (wrap) renderActivityPreview(wrap);
  } catch (err) {
    _activityLoaded = true;
    _activityError = err?.message || 'Błąd ładowania danych.';
    if (wrap) statsEmpty(wrap, 'Błąd ładowania danych.');
  }
}

// Longest live streak first — that's the actual contest. Everyone who played
// today ties on „Ostatnio", so sorting by last seen alone ordered the top of the
// card by nothing a reader can see. Broken streaks fall back to recency.
function activityRows() {
  return [...(_activityStats || [])].sort((a, b) =>
    (+b.streak_days || 0) - (+a.streak_days || 0) ||
    new Date(b.last_active_at || 0) - new Date(a.last_active_at || 0) ||
    (+b.active_days || 0) - (+a.active_days || 0));
}

function actStreakCell(row) {
  const n = +row.streak_days || 0;
  return el('td', { className: 'act-streak' + (n >= 3 ? ' is-hot' : n ? '' : ' is-zero') },
    n ? '🔥 ' + n : '—');
}

function renderActivityPreview(wrap) {
  if (!wrap) return;
  const rows = activityRows();
  if (!rows.length) { statsEmpty(wrap, 'Brak aktywności.'); return; }
  const trs = rows.slice(0, 8).map(row => makeStatsRowClickable(el('tr', {},
    el('td', { className: 'lb-nick' + (row.user_id === me.id ? ' me' : '') },
      statsNick(row.user_id, row.nick) + (row.user_id === me.id ? ' (Ty)' : '')),
    el('td', { className: 'lb-coins act-seen' }, actLastSeenLabel(row.last_active_at)),
    actStreakCell(row),
    el('td', { className: 'lb-coins act-top' }, actKindLabel(row.top_kind))
  ), row.user_id, row.nick));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Nick'), el('th', {}, 'Ostatnio'), el('th', {}, 'Seria'), el('th', {}, 'Najczęściej')
      )),
      el('tbody', {}, ...trs)
    ),
    el('span', { className: 'rc-more' }, 'Dni gry, serie i pełne rozbicie ›')
  );
}

function renderActivityDetail(container) {
  if (!_activityLoaded) {
    container.replaceChildren(makeSpinner());
    loadActivityStats().then(() => { container.replaceChildren(); renderActivityDetail(container); });
    return;
  }
  if (_activityError) {
    container.append(
      el('p', {}, 'Nie udało się wczytać aktywności.'),
      el('p', { style: { color: 'var(--muted)', fontSize: '12px' } },
        'Uruchom supabase/activity-stats.sql w Supabase SQL Editor, aby włączyć ten panel.')
    );
    return;
  }
  const rows = activityRows();
  if (!rows.length) { container.append(el('p', {}, 'Brak aktywności.')); return; }

  const trs = rows.map(row => {
    const total = Math.max(1, +row.total_events || 0);
    // A stacked bar reads faster than seven numbers: the shape IS the answer to
    // „co ten ktoś właściwie robi".
    const bar = el('div', { className: 'act-bar' });
    ACT_KINDS.forEach(([key, , label]) => {
      const n = +row[key] || 0;
      if (!n) return;
      bar.append(el('div', {
        className: 'act-bar-seg act-' + key,
        style: { width: (n / total * 100) + '%' },
        title: label + ': ' + fmtNum(n),
      }));
    });
    const tr = el('tr', { className: 'lb-row-clickable' },
      el('td', { className: 'lb-nick' + (row.user_id === me.id ? ' me' : '') },
        statsNick(row.user_id, row.nick) + (row.user_id === me.id ? ' (Ty)' : '')),
      el('td', { className: 'lb-coins act-seen' }, actLastSeenLabel(row.last_active_at)),
      el('td', {}, fmtNum(row.active_days)),
      actStreakCell(row),
      el('td', { className: 'lb-coins' }, fmtNum(row.best_streak)),
      el('td', {}, fmtNum(row.total_events)),
      el('td', { className: 'lb-coins' }, fmtNum(row.events_30d)),
      el('td', { className: 'act-bar-cell' }, bar, el('span', { className: 'act-top' }, actKindLabel(row.top_kind)))
    );
    if (openStatsUserProfile) tr.addEventListener('click', () => openStatsUserProfile(row.user_id, row.nick, +(_lbData.find(r => r.id === row.user_id)?.coins) || 0));
    return tr;
  });

  container.append(
    el('table', { className: 'lb-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Nick'), el('th', {}, 'Ostatnio'), el('th', {}, 'Dni gry'), el('th', {}, 'Seria'),
        el('th', {}, 'Rekord serii'), el('th', {}, 'Akcji'), el('th', {}, 'Ost. 30 dni'), el('th', {}, 'Co gra')
      )),
      el('tbody', {}, ...trs)
    ),
    el('div', { className: 'act-legend' },
      ...ACT_KINDS.map(([key, icon, label]) => el('span', { className: 'act-legend-item' },
        el('i', { className: 'act-swatch act-' + key }), icon + ' ' + label))
    ),
    el('div', { className: 'lb-legend' },
      el('p', {}, el('strong', {}, 'Dni gry'), ' — liczba różnych dni, w których cokolwiek zrobiłeś w portalu. ', el('strong', {}, 'Seria'), ' — ile dni z rzędu trwa to teraz (liczy się dziś albo wczoraj, inaczej seria jest przerwana).'),
      el('p', {}, el('strong', {}, 'Akcji'), ' — pojedyncze zdarzenia: każdy spin w kasynie, każda runda gry, każdy zakład, sprzedaż plonów czy postawiony piksel.'),
      el('p', {}, 'Doby liczymy według czasu warszawskiego, tak jak nagrody tygodniowe i podlewanie.')
    ),
    el('p', { className: 'lb-click-hint' }, '👆 Kliknij gracza, aby zobaczyć historię coinów')
  );
}

// Compact single-metric preview table. `mode`: 'coins' → Gotówka column,
// 'net' → Net Worth column. `data` is expected pre-sorted for that metric.
function renderLeaderboardTable(wrap, data, mode = 'coins') {
  if (!data || data.length === 0) {
    wrap.replaceChildren(el('p', { style: { color: 'var(--muted)', fontSize: '12px', padding: '12px' } }, 'Brak graczy.'));
    return;
  }
  const isNet = mode === 'net';
  // The card is a preview — a full 20-row table made these two cards several
  // times taller than every other one in the grid. The rest is in the modal.
  const LIMIT = 8;
  const shown = data.slice(0, LIMIT);
  const rows = shown.map((row, i) => makeStatsRowClickable(el('tr', {},
    el('td', { className: 'lb-rank' + (i === 0 ? ' gold' : '') }, i === 0 ? '🥇' : String(i + 1)),
    el('td', { className: 'lb-nick' + (row.id === me.id ? ' me' : '') }, row.nick + (row.id === me.id ? ' (Ty)' : '')),
    // One line per player here — the „+N poza gotówką" split doubles every row's
    // height, and the Net Worth card sitting next to this one already shows the
    // with-holdings figure. The full breakdown stays in the modal.
    isNet
      ? el('td', { className: 'lb-net' }, fmtNum(row.net_worth) + ' 🪙')
      : el('td', { className: 'lb-coins' }, fmtNum(row.coins) + ' 🪙')
  ), row.id, row.nick));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Nick'), el('th', {}, isNet ? 'Net Worth' : 'Gotówka'))),
      el('tbody', {}, ...rows)
    ),
    el('span', { className: 'rc-more' }, data.length > LIMIT
      ? '+ ' + (data.length - LIMIT) + ' ' + plCount(data.length - LIMIT, 'gracz', 'gracze', 'graczy') + ' — pełny ranking ›'
      : 'Kliknij gracza, aby zobaczyć jego portfel ›')
  );
}

function buildTradeStatsByMarket(trades) {
  const stats = {};
  trades.forEach(t => {
    if (!t?.market_id || (t.side !== 'YES' && t.side !== 'NO')) return;
    if (!stats[t.market_id]) {
      stats[t.market_id] = {
        YES: { amount: 0, shares: 0 },
        NO:  { amount: 0, shares: 0 },
      };
    }
    const amount = +t.amount || 0;
    const shares = +t.shares || 0;
    stats[t.market_id][t.side].amount += amount;
    stats[t.market_id][t.side].shares += shares;
  });
  return stats;
}

function getTransactionProfit(row, market, marketStats) {
  const amount = +row.amount || 0;
  const shares = +row.shares || 0;
  if (!market) {
    return { profit: 0, approx: true, title: 'Brak danych rynku.' };
  }

  if (market.resolved) {
    if (row.side !== market.resolution) {
      return { profit: -amount, approx: false, title: 'Rynek zamknięty: przegrana strona.' };
    }
    const losingSide = row.side === 'YES' ? 'NO' : 'YES';
    const totalWinningShares = marketStats?.[row.side]?.shares || 0;
    const losingPot = marketStats?.[losingSide]?.amount || 0;
    const payout = totalWinningShares > 0
      ? amount + losingPot * (shares / totalWinningShares)
      : amount;
    return { profit: payout - amount, approx: false, title: 'Rynek zamknięty: szacowany zysk po podziale puli.' };
  }

  const p = pYes(market);
  const currentValue = shares * (row.side === 'YES' ? p : (1 - p));
  return { profit: currentValue - amount, approx: true, title: 'Rynek aktywny: szacowana wartość pozycji minus stawka.' };
}

function profitClassName(profit) {
  if (profit > 0.005) return 'tx-pl-profit';
  if (profit < -0.005) return 'tx-pl-loss';
  return 'tx-pl-flat';
}

function buildMarketHistoryRows(trades, marketsData, allTrades) {
  const marketsById = {};
  marketsData.forEach(m => { marketsById[m.id] = m; });
  const tradeStatsByMarket = buildTradeStatsByMarket(allTrades);

  return trades
    .filter(row => row.nick_snapshot !== 'admin')
    .map(row => {
      const market = marketsById[row.market_id];
      const sideYes = row.side === 'YES';
      const sideLabel = sideYes ? 'TAK' : 'NIE';
      const title = market ? market.title : 'Usunięty rynek';
      const resolvedText = market?.resolved
        ? 'zamknięty: ' + (market.resolution === 'YES' ? 'TAK' : 'NIE')
        : 'aktywny';
      const profitInfo = getTransactionProfit(row, market, tradeStatsByMarket[row.market_id]);

      return {
        ...row,
        title,
        icon: market?.icon || '🎲',
        sideYes,
        sideLabel,
        status: market?.resolved ? 'closed' : 'open',
        resolvedText,
        profit: profitInfo.profit,
        profitApprox: profitInfo.approx,
        profitTitle: profitInfo.title,
        searchText: ((row.nick_snapshot || '') + ' ' + title).toLowerCase(),
      };
    });
}

function buildHazardHistoryRows(gameTransactions) {
  const GAME_META = {
    roulette: { icon: '🎰', title: 'Ruletka', sideLabel: 'Spin' },
    slots: { icon: '🎰', title: 'Jednoręki bandyta', sideLabel: 'Spin' },
    plinko: { icon: '📌', title: 'Plinko G6', sideLabel: 'Drop' },
    mines: { icon: '💣', title: 'Miny G6', sideLabel: 'Runda' },
    crash: { icon: '🚀', title: 'Rakieta', sideLabel: 'Lot' },
    wheel: { icon: '🦬', title: 'Koło Żubra G6', sideLabel: 'Spin' },
    poker_buy_in: { icon: '🃏', title: 'Poker', sideLabel: 'Buy-in' },
    poker_cashout: { icon: '🃏', title: 'Poker', sideLabel: 'Cashout' },
  };

  return (gameTransactions || []).map(row => {
    const meta = GAME_META[row.game] || { icon: '🎲', title: row.game, sideLabel: row.game };
    const bet = +row.bet || 0;
    const won = +row.won || 0;
    const isPokerBuyIn = row.game === 'poker_buy_in';
    const isPokerCashout = row.game === 'poker_cashout';
    const profit = isPokerBuyIn ? -bet : isPokerCashout ? +won : won - bet;
    const baseGame = row.game.startsWith('poker') ? 'poker' : row.game;

    return {
      id: row.id,
      created_at: row.created_at,
      nick_snapshot: row.nick_snapshot,
      title: meta.title,
      icon: meta.icon,
      sideLabel: meta.sideLabel,
      gameType: baseGame,
      amount: bet,
      profit,
      searchText: ((row.nick_snapshot || '') + ' ' + meta.title).toLowerCase(),
    };
  });
}

function getFilteredMarketRows() {
  const q = (txFilterSearch?.value || '').trim().toLowerCase();
  const side = txFilterSide?.value || '';
  const status = txFilterStatus?.value || '';
  return marketHistoryRows.filter(row => {
    if (q && !row.searchText.includes(q)) return false;
    if (side && row.side !== side) return false;
    if (status && row.status !== status) return false;
    return true;
  });
}

function getFilteredHazardRows() {
  return hazardHistoryRows;
}

function applyTransactionFilters() {
  const historyWrap = document.getElementById('transaction-history-wrap');
  if (historyWrap) renderMarketHistory(historyWrap, getFilteredMarketRows());
}

function applyHazardFilters() {
  const wrap = document.getElementById('hazard-history-wrap');
  if (wrap) renderHazardHistory(wrap, getFilteredHazardRows());
}

function renderHazardista(wrap, data) {
  _hazardistaData = data;
  if (!data || data.length === 0) {
    wrap.replaceChildren(el('p', { style: { color: 'var(--muted)', fontSize: '12px', padding: '12px' } }, 'Brak danych.'));
    return;
  }
  const searchEl = document.getElementById('coin-race-search-input');
  const query = searchEl ? searchEl.value.trim().toLowerCase() : '';
  const filteredData = query ? data.filter(r => r.nick.toLowerCase().includes(query)) : data;

  const winners = filteredData.filter(r => r.total_pl > 0).slice(0, 3);
  const losers = filteredData.filter(r => r.total_pl < 0).sort((a, b) => a.total_pl - b.total_pl).slice(0, 3);
  const items = [...winners.map(r => ({ nick: r.nick, pl: r.total_pl, pos: true, uid: r.user_id })),
                 ...losers.map(r => ({ nick: r.nick, pl: r.total_pl, pos: false, uid: r.user_id }))];
  const rows = items.map(r => makeStatsRowClickable(el('tr', {},
    el('td', { className: 'lb-nick' + (r.uid === me.id ? ' me' : '') }, r.nick),
    el('td', { className: 'tx-pl ' + (r.pos ? 'tx-pl-profit' : 'tx-pl-loss') }, (r.pos ? '+' : '') + r.pl + ' 🪙')
  ), r.uid, r.nick));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Nick'), el('th', {}, 'Bilans'))),
      el('tbody', {}, ...rows)
    ),
    el('span', { className: 'rc-more' }, 'Najwięksi wygrani i przegrani — pełna tabela ›')
  );
  renderStatsHero();
}

function normalizeCoinInflowRow(row) {
  const n = key => Math.round(+(row?.[key] || 0));
  return {
    user_id: row?.user_id,
    nick: row?.nick || '?',
    total_inflow: n('total_inflow'),
    garden: n('garden'),
    markets: n('markets'),
    football: n('football'),
    hazard: n('hazard'),
    seasonal_games: n('seasonal_games'),
    marketplace: n('marketplace'),
    passive: n('passive'),
    topups: n('topups'),
    returns_cashouts: n('returns_cashouts'),
    other: n('other'),
    inflow_count: n('inflow_count'),
    last_inflow_at: row?.last_inflow_at || null,
  };
}

async function loadCoinInflowStats() {
  const wrap = document.getElementById('coin-inflows-wrap');
  if (wrap) wrap.replaceChildren(makeSpinner());
  try {
    const { data, error } = await sb.rpc('coin_inflow_stats');
    _coinInflowLoaded = true;
    if (error) {
      _coinInflowError = error.message || 'Błąd ładowania danych.';
      if (wrap) wrap.replaceChildren(el('p', { style: { color: 'var(--no)', fontSize: '12px', padding: '12px' } },
        'Brak funkcji coin_inflow_stats w bazie.'));
      return;
    }
    _coinInflowError = '';
    _coinInflowStats = (data || []).map(normalizeCoinInflowRow);
    if (wrap) renderCoinInflowPreview(wrap, _coinInflowStats);
  } catch (err) {
    _coinInflowLoaded = true;
    _coinInflowError = err?.message || 'Błąd ładowania danych.';
    if (wrap) wrap.replaceChildren(el('p', { style: { color: 'var(--no)', fontSize: '12px', padding: '12px' } }, 'Błąd ładowania danych.'));
  }
}

function renderCoinInflowPreview(wrap, data) {
  const ranked = (data || [])
    .filter(row => row.total_inflow > 0)
    .sort((a, b) => b.total_inflow - a.total_inflow || a.nick.localeCompare(b.nick, 'pl'));
  if (!ranked.length) {
    wrap.replaceChildren(el('p', { style: { color: 'var(--muted)', fontSize: '12px', padding: '12px' } }, 'Brak dodatnich wpływów po rejestracji.'));
    return;
  }

  const rows = ranked.slice(0, 8).map((row, i) => makeStatsRowClickable(el('tr', {},
    el('td', { className: 'lb-rank' + (i === 0 ? ' gold' : '') }, i === 0 ? '🥇' : String(i + 1)),
    el('td', { className: 'lb-nick' + (row.user_id === me?.id ? ' me' : '') }, row.nick + (row.user_id === me?.id ? ' (Ty)' : '')),
    el('td', { className: 'lb-net' }, fmtNum(row.total_inflow) + ' 🪙'),
    el('td', { className: 'lb-coins' }, fmtNum(row.returns_cashouts) + ' zwrotów')
  ), row.user_id, row.nick));

  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'), el('th', {}, 'Nick'), el('th', {}, 'Wpływy'), el('th', {}, 'Zwroty')
      )),
      el('tbody', {}, ...rows)
    ),
    el('span', { className: 'rc-more' }, 'Bez startowych 1000 🪙 — rozbicie na źródła ›')
  );
  renderStatsHero();
}

const COIN_INFLOW_SORTS = [
  ['total_inflow', 'Suma'],
  ['garden', 'Podlewanie'],
  ['markets', 'Rynki'],
  ['football', 'Mundial'],
  ['hazard', 'Hazard'],
  ['seasonal_games', 'Sezony'],
  ['returns_cashouts', 'Zwroty'],
];

function renderCoinInflowDetail(container) {
  if (!_coinInflowLoaded) {
    container.replaceChildren(makeSpinner());
    loadCoinInflowStats().then(() => {
      container.replaceChildren();
      renderCoinInflowDetail(container);
    });
    return;
  }
  if (_coinInflowError) {
    container.append(el('p', { style: { color: 'var(--no)' } },
      'Nie udało się załadować statystyki. Uruchom w bazie supabase/coin-inflow-stats.sql i odśwież stronę.'));
    return;
  }
  if (!_coinInflowStats.length) {
    container.append(el('p', { style: { color: 'var(--muted)' } }, 'Brak graczy.'));
    return;
  }

  const sortBar = el('div', { className: 'fb-sort-bar' },
    el('span', { className: 'fb-sort-label' }, 'Sortuj:')
  );
  const tableWrap = el('div', { className: 'history-wrap coin-inflow-table-wrap' });

  const sortBtn = (key, label) => {
    const b = el('button', { className: 'fb-sort-btn' + (_coinInflowSort === key ? ' active' : '') }, label);
    b.addEventListener('click', () => {
      if (_coinInflowSort === key) return;
      _coinInflowSort = key;
      sortBar.querySelectorAll('.fb-sort-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      renderTable();
    });
    return b;
  };
  COIN_INFLOW_SORTS.forEach(([key, label]) => sortBar.append(sortBtn(key, label)));

  const moneyCell = value => fmtNum(value) + ' 🪙';
  function renderTable() {
    const rowsData = [..._coinInflowStats]
      .sort((a, b) => (b[_coinInflowSort] || 0) - (a[_coinInflowSort] || 0) || b.total_inflow - a.total_inflow || a.nick.localeCompare(b.nick, 'pl'));
    const rows = rowsData.map((row, i) => el('tr', {},
      el('td', { className: 'lb-rank' + (i === 0 ? ' gold' : '') }, i === 0 ? '🥇' : String(i + 1)),
      el('td', { className: 'lb-nick' + (row.user_id === me?.id ? ' me' : '') }, row.nick + (row.user_id === me?.id ? ' (Ty)' : '')),
      el('td', { className: 'lb-net' }, moneyCell(row.total_inflow)),
      el('td', { className: 'tx-amount' }, moneyCell(row.garden)),
      el('td', { className: 'tx-amount' }, moneyCell(row.markets)),
      el('td', { className: 'tx-amount' }, moneyCell(row.football)),
      el('td', { className: 'tx-amount' }, moneyCell(row.hazard)),
      el('td', { className: 'tx-amount' }, moneyCell(row.seasonal_games)),
      el('td', { className: 'tx-amount' }, moneyCell(row.marketplace)),
      el('td', { className: 'tx-amount' }, moneyCell(row.passive)),
      el('td', { className: 'tx-amount' }, moneyCell(row.topups)),
      el('td', { className: 'tx-amount' }, moneyCell(row.returns_cashouts)),
      el('td', { className: 'tx-amount' }, moneyCell(row.other)),
      el('td', { className: 'tx-prob' }, String(row.inflow_count)),
      el('td', { className: 'tx-time' }, row.last_inflow_at ? fmtDateTime(row.last_inflow_at) : '—')
    ));

    tableWrap.replaceChildren(el('table', { className: 'lb-table coin-inflow-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'),
        el('th', {}, 'Nick'),
        el('th', {}, 'Suma'),
        el('th', {}, 'Podlewanie'),
        el('th', {}, 'Rynki'),
        el('th', {}, 'Mundial'),
        el('th', {}, 'Hazard'),
        el('th', {}, 'Sezony'),
        el('th', {}, 'Targowisko'),
        el('th', {}, 'Pasywne'),
        el('th', {}, 'Doładowania'),
        el('th', {}, 'Zwroty/cashout'),
        el('th', {}, 'Inne'),
        el('th', {}, 'Zdarzeń'),
        el('th', {}, 'Ostatni wpływ')
      )),
      el('tbody', {}, ...rows)
    ));
  }

  container.append(
    el('div', { className: 'lb-legend' },
      el('p', {}, el('strong', {}, 'Co liczymy:'), ' dodatnie wpływy na konto po rejestracji, bez startowych 1000 coinów.'),
      el('p', {}, el('strong', {}, 'Zwroty/cashout:'), ' techniczne powroty coinów, np. void Mundialu, poker cashout oraz zwroty z aukcji.')
    ),
    sortBar,
    tableWrap
  );
  renderTable();
}

function renderMarketHistory(wrap, rowsData) {
  if (!rowsData || rowsData.length === 0) {
    wrap.replaceChildren(el('p', { style: { color: 'var(--muted)', fontSize: '12px', padding: '12px' } }, 'Brak transakcji.'));
    return;
  }
  const visible = rowsData.slice(0, 5);
  const rows = visible.map(row => el('tr', {},
    el('td', { className: 'tx-time' }, fmtDateTime(row.created_at)),
    el('td', { className: 'lb-nick' }, row.nick_snapshot || '?'),
    el('td', {}, el('span', { className: 'tx-side ' + (row.sideYes ? 'tx-side-yes' : 'tx-side-no') }, row.sideLabel)),
    el('td', { className: 'tx-pl ' + profitClassName(row.profit) }, fmtSignedCoins(row.profit, row.profitApprox))
  ));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Czas'), el('th', {}, 'Gracz'), el('th', {}, 'Typ'), el('th', {}, 'P/L'))),
      el('tbody', {}, ...rows)
    )
  );
}

function renderHazardHistory(wrap, rowsData) {
  if (!rowsData || rowsData.length === 0) {
    wrap.replaceChildren(el('p', { style: { color: 'var(--muted)', fontSize: '12px', padding: '12px' } }, 'Brak transakcji.'));
    return;
  }
  const visible = rowsData.slice(0, 5);
  const rows = visible.map(row => el('tr', {},
    el('td', { className: 'tx-time' }, fmtDateTime(row.created_at)),
    el('td', { className: 'lb-nick' }, row.nick_snapshot || '?'),
    el('td', {}, el('span', { className: 'tx-side tx-side-game' }, row.sideLabel)),
    el('td', { className: 'tx-pl ' + profitClassName(row.profit) }, fmtSignedCoins(row.profit, false))
  ));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Czas'), el('th', {}, 'Gracz'), el('th', {}, 'Typ'), el('th', {}, 'P/L'))),
      el('tbody', {}, ...rows)
    )
  );
}

// ── Coin history chart ────────────────────────────────────────────────────
function drawCoinChart(canvas, points) {
  // points: [{ts, bal}] sorted ascending, starting at registration (1000 coins)
  if (!points || points.length < 2) return;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.offsetWidth || 400, H = canvas.offsetHeight || 160;
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  const LPAD = 48, RPAD = 10, TPAD = 14, BPAD = 22;
  const CW = W - LPAD - RPAD, CH = H - TPAD - BPAD;

  const tMin = points[0].ts, tMax = points[points.length - 1].ts;
  const balMin = Math.min(...points.map(p => p.bal));
  const balMax = Math.max(...points.map(p => p.bal));
  // Give a bit of padding so the line doesn't hug edges
  const padV = Math.max(50, (balMax - balMin) * 0.08);
  const yLo = balMin - padV, yHi = balMax + padV;
  const scX = ts => LPAD + ((tMax === tMin) ? CW / 2 : ((ts - tMin) / (tMax - tMin)) * CW);
  const scY = b => TPAD + (1 - (b - yLo) / (yHi - yLo)) * CH;

  // Background
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, W, H);

  // Y-axis: 4 evenly spaced grid lines with labels
  const yStep = (yHi - yLo) / 3;
  for (let i = 0; i <= 3; i++) {
    const v = yLo + yStep * i;
    const y = scY(v);
    ctx.strokeStyle = i === 0 ? '#cbd5e1' : '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.setLineDash(i === 0 ? [] : [3, 3]);
    ctx.beginPath(); ctx.moveTo(LPAD, y); ctx.lineTo(W - RPAD, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(fmtNum(Math.round(v)), LPAD - 4, y + 3);
  }

  // 1000-coin baseline (starting level) — subtle dashed line
  const baseLine = scY(1000);
  if (baseLine > TPAD && baseLine < TPAD + CH) {
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(LPAD, baseLine); ctx.lineTo(W - RPAD, baseLine); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Determine if overall gain or loss for color
  const isGain = points[points.length - 1].bal >= points[0].bal;
  const lineColor = isGain ? '#22c55e' : '#f87171';
  const areaColor0 = isGain ? 'rgba(34,197,94,0.22)' : 'rgba(248,113,113,0.18)';
  const areaColor1 = isGain ? 'rgba(34,197,94,0.02)' : 'rgba(248,113,113,0.02)';

  // Area fill
  const grad = ctx.createLinearGradient(0, TPAD, 0, TPAD + CH);
  grad.addColorStop(0, areaColor0);
  grad.addColorStop(1, areaColor1);
  ctx.beginPath();
  ctx.moveTo(scX(points[0].ts), scY(points[0].bal));
  for (let i = 1; i < points.length; i++) ctx.lineTo(scX(points[i].ts), scY(points[i].bal));
  ctx.lineTo(scX(points[points.length - 1].ts), TPAD + CH);
  ctx.lineTo(scX(points[0].ts), TPAD + CH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Balance line
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  points.forEach((p, i) => i === 0 ? ctx.moveTo(scX(p.ts), scY(p.bal)) : ctx.lineTo(scX(p.ts), scY(p.bal)));
  ctx.stroke();

  // Start dot
  ctx.fillStyle = '#94a3b8';
  ctx.beginPath();
  ctx.arc(scX(points[0].ts), scY(points[0].bal), 3, 0, Math.PI * 2);
  ctx.fill();

  // End dot
  const lp = points[points.length - 1];
  ctx.fillStyle = lineColor;
  ctx.beginPath();
  ctx.arc(scX(lp.ts), scY(lp.bal), 4, 0, Math.PI * 2);
  ctx.fill();
  // White center
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(scX(lp.ts), scY(lp.bal), 2, 0, Math.PI * 2);
  ctx.fill();

  // X-axis date labels — up to 5, evenly spaced, no overlap
  const dateLabel = ts => new Date(ts).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' });
  ctx.fillStyle = '#94a3b8';
  ctx.font = '9px system-ui, sans-serif';
  const labelCount = Math.min(5, points.length);
  const step = (points.length - 1) / (labelCount - 1);
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.round(i * step);
    const p = points[idx];
    const x = scX(p.ts);
    ctx.textAlign = i === 0 ? 'left' : i === labelCount - 1 ? 'right' : 'center';
    const lx = i === 0 ? LPAD : i === labelCount - 1 ? W - RPAD : x;
    ctx.fillText(dateLabel(p.ts), lx, H - 6);
  }
}

// Reconstruct a user's cash-balance history from their coin-affecting events.
// Returns [{ts, bal, label, delta, isGarden}] starting at 1000 at registration.
// `trades` rows must include a nested `markets(title,resolved,resolution,resolved_at)`;
// `allMarketTrades` holds every trade (any user) for the resolved markets this user won,
// needed for the pro-rata payout math.
function buildBalancePoints({ userId, coins, createdAt, trades = [], games = [], coinTxs = [], awards = [], allMarketTrades = [], footballBets = [] }) {
  const GAME_NAMES = { roulette: '🎰 Ruletka', slots: '🎰 Sloty', plinko: '📌 Plinko G6', mines: '💣 Miny G6', crash: '🚀 Rakieta', wheel: '🦬 Koło Żubra', poker_buy_in: '🃏 Poker buy-in', poker_cashout: '🃏 Poker cashout' };
  const resolvedWinningMarketIds = [...new Set(
    trades.filter(t => t.markets?.resolved && t.side === t.markets?.resolution).map(t => t.market_id)
  )];

  const events = [];

  trades.forEach(t => {
    const title = t.markets?.title || 'Rynek';
    const amount = +t.amount || 0;
    // Cash leaves but an open position of equal cost basis is acquired → net worth flat (lockDelta = +amount).
    events.push({ ts: new Date(t.created_at).getTime(), delta: -amount, lockDelta: amount, label: '📊 ' + title });
  });

  // Release locked position value when a market the user bet on resolves AGAINST them:
  // the cash already left at bet time, so resolution just zeroes the held position.
  const resolvedLosing = {};
  trades.forEach(t => {
    if (!(t.markets?.resolved && t.markets?.resolution && t.side !== t.markets.resolution)) return;
    const at = t.markets.resolved_at ? new Date(t.markets.resolved_at).getTime() : null;
    if (!at) return;
    const m = resolvedLosing[t.market_id] || (resolvedLosing[t.market_id] = { amount: 0, ts: at, title: t.markets.title || 'Rynek' });
    m.amount += (+t.amount || 0);
  });
  Object.values(resolvedLosing).forEach(m => {
    events.push({ ts: m.ts, delta: 0, lockDelta: -m.amount, label: '📉 ' + m.title + ' (przegrana)' });
  });

  // Inject per-market payout events at resolved_at time
  resolvedWinningMarketIds.forEach(marketId => {
    const market = trades.find(t => t.market_id === marketId)?.markets;
    if (!market) return;
    const resolution = market.resolution;
    const resolvedAt = market.resolved_at ? new Date(market.resolved_at).getTime() : null;
    if (!resolvedAt) return;

    const mTrades = allMarketTrades.filter(t => t.market_id === marketId);
    const totalYes = mTrades.filter(t => t.side === 'YES').reduce((s, t) => s + (+t.amount || 0), 0);
    const totalNo  = mTrades.filter(t => t.side === 'NO' ).reduce((s, t) => s + (+t.amount || 0), 0);
    const losingPot = resolution === 'YES' ? totalNo : totalYes;
    const winningTrades = mTrades.filter(t => t.side === resolution);
    const totalWinningShares = winningTrades.reduce((s, t) => s + parseFloat(t.shares || 0), 0);

    const userWinningTrades = mTrades.filter(t => t.user_id === userId && t.side === resolution);
    const userWinningAmount = userWinningTrades.reduce((s, t) => s + (+t.amount || 0), 0);
    const userWinningShares = userWinningTrades.reduce((s, t) => s + parseFloat(t.shares || 0), 0);
    const payout = Math.round(userWinningAmount + (totalWinningShares > 0 ? losingPot * userWinningShares / totalWinningShares : 0));

    if (payout > 0) {
      // Position liquidated (release the staked cost basis) and cash payout received;
      // net worth changes by payout − stake (the realised P/L).
      events.push({ ts: resolvedAt, delta: payout, lockDelta: -userWinningAmount, label: '💰 ' + market.title + ' (wypłata)' });
    }
  });

  games.forEach(g => {
    const bet = +g.bet || 0, won = +g.won || 0;
    const delta = g.game === 'poker_buy_in' ? -bet : g.game === 'poker_cashout' ? won : won - bet;
    // Poker buy-in/cash-out just moves cash to/from a held stack (net worth flat); slots/roulette are pure P/L.
    const lockDelta = (g.game === 'poker_buy_in' || g.game === 'poker_cashout') ? -delta : 0;
    events.push({ ts: new Date(g.created_at).getTime(), delta, lockDelta, label: GAME_NAMES[g.game] || g.game });
  });
  awards.forEach(a => {
    if (a.awarded_at) {
      const entry = seasonalEntryForWeekStart(a.week_start);
      const medals = ['🥇', '🥈', '🥉'];
      const gameName = entry?.gameType === a.gameType ? entry.displayName : a.gameType;
      events.push({ ts: new Date(a.awarded_at).getTime(), delta: +a.prize_coins || 0, label: (medals[a.rank - 1] || '') + ' Nagroda · ' + gameName });
    }
  });
  // Value-neutral cash↔asset conversions (held items, garden accessories/certificate,
  // auction escrow) keep net worth flat: lockDelta cancels the cash delta. Hero-item
  // purchases, accessories & the garden certificate add to net_worth assets; auction
  // reserve/refunds top up / release the escrow that becomes the won item (valued at the
  // winning bid). Farm buys convert cash into assets the live net_worth still counts —
  // land (farm_tile_buy → asset_value), sealed boxes (farm_box_buy → boxes×100), and
  // card/NFT level investment (card_levelup) — so they must be neutral too, otherwise a
  // farm-heavy player's history nosedives through every purchase and snaps back up at
  // the pinned endpoint. (farm_crop_sale stays pure income: the harvested-crop asset it
  // liquidates was minted outside the coin ledger, so it was never added to `lock`.)
  // Everything else (interest, awards, store redemptions, marketplace transfers, crop
  // sales, garden watering) is pure cash P/L that moves net worth.
  const NEUTRAL = { hero_item_purchase: 1, garden_accessory: 1, garden_certificate: 1, hero_auction_bid_reserved: 1, hero_auction_outbid_refund: 1, hero_auction_edition_refund: 1, farm_tile_buy: 1, farm_box_buy: 1, card_levelup: 1 };
  // football_bet/football_win/football_refund are audit copies of the same events already
  // reconstructed below from the `football_bets` table (with correct lockDelta handling for
  // open stakes) — counting them here too would double the P/L.
  const FOOTBALL_COIN_TX_REASONS = { football_bet: 1, football_win: 1, football_refund: 1 };
  coinTxs.forEach(t => {
    if (FOOTBALL_COIN_TX_REASONS[t.reason]) return;
    const label = t.reason === 'garden_water'
      ? '🌱 Podlewanie' + (t.meta?.streak > 1 ? ' (streak ' + t.meta.streak + ')' : '')
      : t.reason === 'garden_accessory'
      ? '🌿 Akcesorium: ' + (t.meta?.accessory_id || '?')
      : t.reason === 'store_purchase'
      ? '🎁 Sklep: ' + (t.meta?.title || '?')
      : t.reason === 'daily_interest'
      ? '💍 Odsetki dzienne'
      : t.reason === 'hero_item_purchase'
      ? '🎒 Przedmiot: ' + (t.meta?.item_name || t.meta?.item_slug || '?')
      : t.reason === 'hero_auction_bid_reserved'
      ? '🔨 Aukcja: depozyt'
      : t.reason === 'hero_auction_outbid_refund' || t.reason === 'hero_auction_edition_refund'
      ? '↩️ Aukcja: zwrot'
      : t.reason === 'garden_certificate'
      ? '📜 Certyfikat Drugiego Ogródka'
      : t.reason === 'arcade_entry'
      ? '🎮 Arcade: ' + (t.meta?.game_type || '?')
      : t.reason === 'canvas_pixel'
      ? '🎨 Wspólne Płótno: pixel (' + (t.meta?.x ?? '?') + ',' + (t.meta?.y ?? '?') + ')'
      : t.reason === 'canvas_pixel_adjustment'
      ? '🎨 Wspólne Płótno: rekord uzupełniający'
      : t.reason === 'admin_grant'
      ? '🎁 Bonus od admina' + (t.meta?.note ? ': ' + t.meta.note : '')
      : t.reason === 'zapps_topup'
      ? '💰 Doładowanie (zappsy)' + (t.meta?.note ? ': ' + t.meta.note : '')
      : t.reason === 'zapps_purchase'
      ? '💎 Kup Zappsy' + (t.meta?.note ? ': ' + t.meta.note : '')
      : '🪙 ' + t.reason;
    const delta = +t.delta;
    events.push({ ts: new Date(t.created_at).getTime(), delta, lockDelta: NEUTRAL[t.reason] ? -delta : 0, label });
  });
  // Mundial (football) bets live in football_bets, not coin_transactions: stake is
  // debited at bet time; a win credits potential_payout and a void refunds the stake.
  const FB_PICK = { '1': 'gospodarze', 'X': 'remis', '2': 'goście' };
  footballBets.forEach(b => {
    const stake = +b.stake || 0;
    const pick = FB_PICK[b.pick] || b.pick || '';
    // Open stake is a held position (net worth flat). Settlement releases the stake:
    // win = +payout/−stake (P/L), void = stake refund (flat), loss = stake forfeited.
    events.push({ ts: new Date(b.created_at).getTime(), delta: -stake, lockDelta: stake, label: '⚽ Mundial: zakład' + (pick ? ' (' + pick + ')' : '') });
    if (b.settled_at && b.status === 'won') {
      events.push({ ts: new Date(b.settled_at).getTime(), delta: +b.potential_payout || 0, lockDelta: -stake, label: '⚽ Mundial: wygrana' });
    } else if (b.settled_at && b.status === 'void') {
      events.push({ ts: new Date(b.settled_at).getTime(), delta: stake, lockDelta: -stake, label: '↩️ Mundial: zwrot' });
    } else if (b.settled_at && b.status === 'lost') {
      events.push({ ts: new Date(b.settled_at).getTime(), delta: 0, lockDelta: -stake, label: '⚽ Mundial: przegrana' });
    }
  });
  // Residual = coins that moved before coin_transactions logging was introduced (pre-2026-05-21).
  const residual = coins - (1000 + events.reduce((s, e) => s + e.delta, 0));
  if (Math.abs(residual) > 5) {
    events.push({ ts: new Date('2026-05-21T12:00:00+02:00').getTime(), delta: residual, label: '🧾 Wyrównanie — historyczne operacje bez pełnych logów transakcji', isGarden: true });
  }
  events.sort((a, b) => a.ts - b.ts);

  const startTs = createdAt ? new Date(createdAt).getTime() : (events[0]?.ts || Date.now());
  // `bal` = cash over time; `lock` = value of held assets/positions over time (starts
  // at 0). Net worth at any point = bal + lock, so it correctly starts at 1000 for all.
  const balancePoints = [{ ts: startTs, bal: 1000, lock: 0, label: 'Rejestracja', delta: null }];
  let runBal = 1000, runLock = 0;
  events.forEach(e => {
    runBal += e.delta;
    runLock += (e.lockDelta || 0);
    balancePoints.push({ ts: Math.max(e.ts, startTs + 1), bal: runBal, lock: Math.max(0, runLock), label: e.label, delta: e.delta, isGarden: e.isGarden });
  });
  const finalResidual = coins - runBal;
  if (finalResidual !== 0 && Math.abs(finalResidual) <= 5) {
    balancePoints[balancePoints.length - 1].bal += finalResidual;
  }
  return balancePoints;
}

// ── Coin race: every player's cash balance over time, animated ────────────
function _raceTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, f) => (cs.getPropertyValue(n).trim() || f);
  return { card: v('--card', '#ffffff'), border: v('--border', '#e2e8f0'), muted: v('--muted', '#94a3b8') };
}

// Draw all series up to progressTs on a fixed Y scale. Lines are colored per
// player; the moving front holds each player's last balance and (optionally)
// shows their nick so you can watch positions change.
function drawCoinRace(canvas, series, progressTs, bounds, opts = {}) {
  if (!canvas || !series || !series.length || !bounds) return;
  const showLabels = opts.showLabels !== false;
  const W = canvas.offsetWidth || 400;
  const H = opts.height || canvas.offsetHeight || 160;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * DPR; canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const th = _raceTheme();
  const LPAD = 46, RPAD = showLabels ? 66 : 12, TPAD = 12, BPAD = 20;
  const CW = W - LPAD - RPAD, CH = H - TPAD - BPAD;
  const { tMin, tMax, yLo, yHi } = bounds;
  const scX = ts => LPAD + (tMax === tMin ? CW / 2 : ((ts - tMin) / (tMax - tMin)) * CW);
  const scY = b => TPAD + (1 - (b - yLo) / (yHi - yLo)) * CH;

  ctx.fillStyle = th.card; ctx.fillRect(0, 0, W, H);

  // Y grid + labels
  ctx.font = '9px system-ui, sans-serif';
  for (let i = 0; i <= 3; i++) {
    const val = yLo + (yHi - yLo) / 3 * i, y = scY(val);
    ctx.strokeStyle = th.border; ctx.lineWidth = 1; ctx.setLineDash(i === 0 ? [] : [3, 3]);
    ctx.beginPath(); ctx.moveTo(LPAD, y); ctx.lineTo(W - RPAD, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = th.muted; ctx.textAlign = 'right';
    ctx.fillText(fmtNum(Math.round(val)), LPAD - 4, y + 3);
  }
  // 1000 baseline
  if (1000 >= yLo && 1000 <= yHi) {
    const yb = scY(1000);
    ctx.strokeStyle = th.muted; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(LPAD, yb); ctx.lineTo(W - RPAD, yb); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  // X date labels
  ctx.fillStyle = th.muted;
  const dlabel = ts => new Date(ts).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' });
  for (let i = 0; i <= 3; i++) {
    const ts = tMin + (tMax - tMin) / 3 * i;
    ctx.textAlign = i === 0 ? 'left' : i === 3 ? 'right' : 'center';
    ctx.fillText(dlabel(ts), Math.max(LPAD, Math.min(W - RPAD, scX(ts))), H - 6);
  }

  // Lines
  const frontX = scX(progressTs);
  const tips = [];
  series.forEach(s => {
    const pts = s.points;
    if (!pts.length) return;
    let curBal = pts[0].bal, started = false;
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    for (const p of pts) {
      if (p.ts > progressTs) break;
      const x = scX(p.ts), y = scY(p.bal);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      curBal = p.bal;
    }
    const frontY = scY(curBal);
    if (started) ctx.lineTo(frontX, frontY); else ctx.moveTo(frontX, frontY);
    ctx.stroke();
    ctx.fillStyle = s.color;
    ctx.beginPath(); ctx.arc(frontX, frontY, 2.5, 0, Math.PI * 2); ctx.fill();
    tips.push({ y: frontY, color: s.color, nick: s.nick });
  });

  // Tip nick labels with light vertical de-overlap
  if (showLabels && tips.length) {
    tips.sort((a, b) => a.y - b.y);
    const gap = 11;
    for (let i = 1; i < tips.length; i++) {
      if (tips[i].y - tips[i - 1].y < gap) tips[i].y = tips[i - 1].y + gap;
    }
    ctx.textAlign = 'left'; ctx.font = '9px system-ui, sans-serif';
    tips.forEach(t => {
      ctx.fillStyle = t.color;
      ctx.fillText(t.nick, W - RPAD + 5, Math.min(H - 3, Math.max(9, t.y)) + 3);
    });
  }

  // Remember the layout so the hover tooltip can map cursor → nearest player.
  canvas._raceLayout = { LPAD, RPAD, TPAD, CW, CH, W, H, tMin, tMax, yLo, yHi, series, progressTs };
}

// Linear-interpolated balance of a series at time t (matches the drawn line).
function _raceValueAt(points, t) {
  if (!points || !points.length) return null;
  if (t <= points[0].ts) return points[0].bal;
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].ts) {
      const a = points[i - 1], b = points[i];
      return a.bal + (b.bal - a.bal) * ((t - a.ts) / ((b.ts - a.ts) || 1));
    }
  }
  return points[points.length - 1].bal;
}

let _raceTooltipEl = null;
function _hideRaceTooltip() { if (_raceTooltipEl) _raceTooltipEl.style.display = 'none'; }
function _showRaceTooltip(cx, cy, s, bal, t) {
  if (!_raceTooltipEl) { _raceTooltipEl = el('div', { className: 'coin-race-tooltip' }); document.body.appendChild(_raceTooltipEl); }
  _raceTooltipEl.replaceChildren(
    el('div', { className: 'coin-race-tooltip-row' },
      el('span', { className: 'coin-race-legend-swatch', style: { background: s.color } }),
      el('span', {}, s.nick + ' · ' + fmtNum(Math.round(bal)) + ' 🪙')),
    el('div', { className: 'coin-race-tooltip-date' }, new Date(t).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: '2-digit' }))
  );
  _raceTooltipEl.style.display = 'flex';
  const pad = 14, w = _raceTooltipEl.offsetWidth, h = _raceTooltipEl.offsetHeight;
  let x = cx + pad, y = cy + pad;
  if (x + w > window.innerWidth - 8) x = cx - w - pad;
  if (y + h > window.innerHeight - 8) y = cy - h - pad;
  _raceTooltipEl.style.left = Math.max(8, x) + 'px';
  _raceTooltipEl.style.top = Math.max(8, y) + 'px';
}

// Wire mouse hover on a race canvas to the nearest-line tooltip (idempotent).
function attachRaceTooltip(canvas) {
  if (canvas._raceTipBound) return;
  canvas._raceTipBound = true;
  canvas.addEventListener('mousemove', ev => {
    const L = canvas._raceLayout;
    if (!L) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    if (mx < L.LPAD || mx > L.W - L.RPAD || my < L.TPAD || my > L.TPAD + L.CH) { _hideRaceTooltip(); return; }
    const t = Math.min(L.progressTs, L.tMin + (mx - L.LPAD) / L.CW * (L.tMax - L.tMin));
    let best = null, bestDy = Infinity;
    L.series.forEach(s => {
      const bal = _raceValueAt(s.points, t);
      if (bal == null) return;
      const y = L.TPAD + (1 - (bal - L.yLo) / (L.yHi - L.yLo)) * L.CH;
      const dy = Math.abs(y - my);
      if (dy < bestDy) { bestDy = dy; best = { s, bal }; }
    });
    if (!best || bestDy > 16) { _hideRaceTooltip(); return; }
    _showRaceTooltip(ev.clientX, ev.clientY, best.s, best.bal, t);
  });
  canvas.addEventListener('mouseleave', _hideRaceTooltip);
}

function animateCoinRace(canvas, series, bounds, opts = {}) {
  if (!canvas || !series || !series.length || !bounds) return;
  const prev = _coinRaceRAF.get(canvas);
  if (prev) cancelAnimationFrame(prev);
  const dur = opts.duration || 6000, span = bounds.tMax - bounds.tMin, t0 = performance.now();
  function frame(now) {
    const e = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - e, 3);
    drawCoinRace(canvas, series, bounds.tMin + span * eased, bounds, opts);
    if (e < 1) _coinRaceRAF.set(canvas, requestAnimationFrame(frame));
    else _coinRaceRAF.delete(canvas);
  }
  _coinRaceRAF.set(canvas, requestAnimationFrame(frame));
}

// Start the animation once the canvas actually has width (the tab may be hidden).
function playCoinRace(canvas, opts = {}) {
  const series = opts.series || _coinRaceSeries;
  const bounds = opts.bounds || _coinRaceBounds;
  if (!canvas || !series || !series.length || !bounds) return;
  attachRaceTooltip(canvas);
  if (canvas.offsetWidth > 0) { animateCoinRace(canvas, series, bounds, opts); return; }
  const ro = new ResizeObserver(() => {
    if (canvas.offsetWidth > 0) { ro.disconnect(); animateCoinRace(canvas, series, bounds, opts); }
  });
  ro.observe(canvas);
}


// Bulk-reconstruct every non-admin player's balance history and animate the
// preview card. `seasonPromise` is loadSeasonHistory()'s promise so awards are
// included in the reconstruction.
async function loadCoinRace(seasonPromise) {
  const cashWrap = document.getElementById('coin-race-cash-wrap');
  const netWrap = document.getElementById('coin-race-net-wrap');
  if (!cashWrap && !netWrap) return;
  try { await (seasonPromise || loadSeasonHistory()); } catch {}

  const [profRes, tradesRes, coinTxRes, gameRes, footballRes, lbRes] = await Promise.all([
    sb.from('profiles').select('id,nick,is_admin,coins,created_at').neq('is_admin', true),
    sbFetchAll(() => sb.from('trades').select('user_id,created_at,amount,shares,side,market_id,markets(title,resolved,resolution,resolved_at)').order('created_at', { ascending: true }).order('id', { ascending: true })),
    sbFetchAll(() => sb.from('coin_transactions').select('user_id,created_at,delta,reason,meta').order('created_at', { ascending: true }).order('id', { ascending: true })),
    sbFetchAll(() => sb.from('game_transactions').select('user_id,created_at,game,bet,won,is_admin').neq('is_admin', true).order('created_at', { ascending: true }).order('id', { ascending: true })),
    sbFetchAll(() => sb.from('football_bets').select('user_id,created_at,settled_at,pick,stake,potential_payout,status').order('created_at', { ascending: true }).order('id', { ascending: true })),
    sb.from('leaderboard').select('id,coins,net_worth'),
  ]);

  const profiles = profRes.data || [];
  const allTrades = tradesRes.data || [];
  const byUser = arr => { const m = {}; (arr || []).forEach(r => { (m[r.user_id] = m[r.user_id] || []).push(r); }); return m; };
  const tradesByUser = byUser(allTrades), txByUser = byUser(coinTxRes.data), gamesByUser = byUser(gameRes.data);
  const footballByUser = byUser(footballRes.data);
  const awardsByUser = byUser(_seasonHistory || []);
  // Per-user current "poza gotówką" offset (net_worth − coins). Used only to pin the
  // net-worth curve's endpoint to the live leaderboard value; the rest of the curve
  // uses the time-varying `lock` track reconstructed in buildBalancePoints.
  const offsetByUser = {};
  (lbRes.data || []).forEach(r => { offsetByUser[r.id] = Math.max(0, Math.round((+r.net_worth || 0) - (+r.coins || 0))); });

  const n = profiles.length;
  const series = [];
  profiles.forEach((p, i) => {
    const points = buildBalancePoints({
      userId: p.id, coins: p.coins, createdAt: p.created_at,
      trades: tradesByUser[p.id] || [], games: gamesByUser[p.id] || [],
      coinTxs: txByUser[p.id] || [], awards: awardsByUser[p.id] || [], allMarketTrades: allTrades,
      footballBets: footballByUser[p.id] || [],
    });
    if (points.length < 2) return;
    points.forEach(pt => { pt.balCash = pt.bal; pt.balNet = pt.bal + (pt.lock || 0); });
    // Pin the final net-worth point to the live leaderboard value: the reconstructed
    // lock values open positions at cost basis, while net_worth marks them to market,
    // so the present-moment snapshot may differ slightly. Earlier points keep the
    // time-varying reconstruction (net worth starts at 1000, no constant offset).
    const last = points[points.length - 1];
    last.balNet = last.balCash + (offsetByUser[p.id] || 0);
    series.push({ userId: p.id, nick: p.nick, color: `hsl(${Math.round(i * 360 / Math.max(1, n))}, 70%, 55%)`, points });
  });

  _coinRaceRaw = series;
  updateCoinRaceCharts();
}

let _coinRaceTimeFilter = 'all';
let _coinRacePlayerFilter = 'all';
let _coinRaceCashSeries = [];
let _coinRaceCashBounds = null;
let _coinRaceNetSeries = [];
let _coinRaceNetBounds = null;

function _interpolateField(points, t, field) {
  if (!points || !points.length) return 0;
  if (t <= points[0].ts) return points[0][field];
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].ts) {
      const a = points[i - 1], b = points[i];
      const valA = a[field] || 0, valB = b[field] || 0;
      return valA + (valB - valA) * ((t - a.ts) / ((b.ts - a.ts) || 1));
    }
  }
  return points[points.length - 1][field];
}

function updateCoinRaceCharts() {
  if (!_coinRaceRaw || !_coinRaceRaw.length) return;
  // The preview cards always show the last 7 days; the detail modal keeps its
  // own selectable period via _coinRaceTimeFilter (getFilteredRaceData).
  const tMax = Date.now();
  let tMin = tMax - 7 * 24 * 3600 * 1000;
  if (!isFinite(tMin) || tMin >= tMax) tMin = tMax - 86400000;

  const searchEl = document.getElementById('coin-race-search-input');
  const query = searchEl ? searchEl.value.trim().toLowerCase() : '';

  let filteredRaw = [..._coinRaceRaw];
  if (query) {
    filteredRaw = filteredRaw.filter(s => s.nick.toLowerCase().includes(query));
  } else {
    if (_coinRacePlayerFilter === 'me') {
      filteredRaw = filteredRaw.filter(s => s.userId === me?.id);
    } else if (_coinRacePlayerFilter === 'top5') {
      const sorted = [..._coinRaceRaw].sort((a, b) => {
        const aVal = a.points[a.points.length - 1].balNet || 0;
        const bVal = b.points[b.points.length - 1].balNet || 0;
        return bVal - aVal;
      });
      const top5 = sorted.slice(0, 5);
      if (me && !top5.some(s => s.userId === me.id)) {
        const mySeries = _coinRaceRaw.find(s => s.userId === me.id);
        if (mySeries) top5.push(mySeries);
      }
      filteredRaw = top5;
    }
  }

  const cashSeries = [];
  const netSeries = [];
  filteredRaw.forEach(s => {
    const cashPts = [];
    const netPts = [];
    if (s.points.length && s.points[0].ts < tMin) {
      cashPts.push({ ts: tMin, bal: _interpolateField(s.points, tMin, 'balCash') });
      netPts.push({ ts: tMin, bal: _interpolateField(s.points, tMin, 'balNet') });
    }
    s.points.forEach(pt => {
      if (pt.ts >= tMin && pt.ts <= tMax) {
        cashPts.push({ ts: pt.ts, bal: pt.balCash });
        netPts.push({ ts: pt.ts, bal: pt.balNet });
      }
    });
    if (s.points.length) {
      const last = s.points[s.points.length - 1];
      cashPts.push({ ts: tMax, bal: last.balCash });
      netPts.push({ ts: tMax, bal: last.balNet });
    }
    if (cashPts.length >= 2) {
      cashSeries.push({ userId: s.userId, nick: s.nick, color: s.color, points: cashPts });
    }
    if (netPts.length >= 2) {
      netSeries.push({ userId: s.userId, nick: s.nick, color: s.color, points: netPts });
    }
  });

  const getBounds = (sArr) => {
    let yLo = Infinity, yHi = -Infinity;
    sArr.forEach(s => {
      s.points.forEach(pt => {
        yLo = Math.min(yLo, pt.bal);
        yHi = Math.max(yHi, pt.bal);
      });
    });
    if (!isFinite(yLo)) { yLo = 0; yHi = 2000; }
    const pad = Math.max(50, (yHi - yLo) * 0.08);
    return { tMin, tMax, yLo: yLo - pad, yHi: yHi + pad };
  };

  _coinRaceCashSeries = cashSeries;
  _coinRaceCashBounds = getBounds(cashSeries);
  _coinRaceNetSeries = netSeries;
  _coinRaceNetBounds = getBounds(netSeries);

  const cashWrap = document.getElementById('coin-race-cash-wrap');
  if (cashWrap) {
    let canvas = cashWrap.querySelector('.coin-race-canvas');
    if (!canvas) { canvas = el('canvas', { className: 'coin-race-canvas' }); cashWrap.replaceChildren(canvas); }
    if (cashSeries.length) {
      playCoinRace(canvas, { showLabels: true, series: cashSeries, bounds: _coinRaceCashBounds });
    } else {
      cashWrap.replaceChildren(el('p', { style: { color: 'var(--muted)', fontSize: '12px', padding: '12px' } }, 'Brak danych.'));
    }
  }

  const netWrap = document.getElementById('coin-race-net-wrap');
  if (netWrap) {
    let canvas = netWrap.querySelector('.coin-race-canvas');
    if (!canvas) { canvas = el('canvas', { className: 'coin-race-canvas' }); netWrap.replaceChildren(canvas); }
    if (netSeries.length) {
      playCoinRace(canvas, { showLabels: true, series: netSeries, bounds: _coinRaceNetBounds });
    } else {
      netWrap.replaceChildren(el('p', { style: { color: 'var(--muted)', fontSize: '12px', padding: '12px' } }, 'Brak danych.'));
    }
  }
}

// Switch the coin-race between cash ('coins') and net worth ('net') by pointing
// each series' active `bal` at balCash/balNet, then recomputing bounds.
function applyCoinRaceMode(mode) {
  _coinRaceMode = mode;
  const series = _coinRaceRaw || [];
  let tMin = Infinity, balMin = Infinity, balMax = -Infinity;
  series.forEach(s => {
    tMin = Math.min(tMin, s.points[0].ts);
    s.points.forEach(p => {
      p.bal = mode === 'net' ? p.balNet : p.balCash;
      balMin = Math.min(balMin, p.bal); balMax = Math.max(balMax, p.bal);
    });
  });
  const tMax = Date.now();
  if (!isFinite(tMin)) tMin = tMax - 86400000;
  const padV = Math.max(50, (balMax - balMin) * 0.08);
  _coinRaceSeries = series;
  _coinRaceBounds = { tMin, tMax, yLo: balMin - padV, yHi: balMax + padV };
}

let _coinRaceSearchQuery = '';

function getFilteredRaceData(mode) {
  const tMax = Date.now();
  let tMin = Infinity;
  if (_coinRaceTimeFilter === '3d') {
    tMin = tMax - 3 * 24 * 3600 * 1000;
  } else if (_coinRaceTimeFilter === '7d') {
    tMin = tMax - 7 * 24 * 3600 * 1000;
  } else if (_coinRaceTimeFilter === '30d') {
    tMin = tMax - 30 * 24 * 3600 * 1000;
  } else {
    _coinRaceRaw.forEach(s => {
      if (s.points.length) tMin = Math.min(tMin, s.points[0].ts);
    });
  }
  if (!isFinite(tMin) || tMin >= tMax) tMin = tMax - 86400000;

  // Filter players
  let filteredRaw = [..._coinRaceRaw];
  const query = (_coinRaceSearchQuery || '').trim().toLowerCase();
  if (query) {
    filteredRaw = filteredRaw.filter(s => s.nick.toLowerCase().includes(query));
  } else {
    if (_coinRacePlayerFilter === 'me') {
      filteredRaw = filteredRaw.filter(s => s.userId === me?.id);
    } else if (_coinRacePlayerFilter === 'top5') {
      const sorted = [..._coinRaceRaw].sort((a, b) => {
        const valA = a.points[a.points.length - 1][mode === 'net' ? 'balNet' : 'balCash'] || 0;
        const valB = b.points[b.points.length - 1][mode === 'net' ? 'balNet' : 'balCash'] || 0;
        return valB - valA;
      });
      const top5 = sorted.slice(0, 5);
      if (me && !top5.some(s => s.userId === me.id)) {
        const mySeries = _coinRaceRaw.find(s => s.userId === me.id);
        if (mySeries) top5.push(mySeries);
      }
      filteredRaw = top5;
    }
  }

  // Construct series points for the active mode
  const series = [];
  filteredRaw.forEach(s => {
    const pts = [];
    const field = mode === 'net' ? 'balNet' : 'balCash';

    if (s.points.length && s.points[0].ts < tMin) {
      pts.push({ ts: tMin, bal: _interpolateField(s.points, tMin, field) });
    }
    s.points.forEach(pt => {
      if (pt.ts >= tMin && pt.ts <= tMax) {
        pts.push({ ts: pt.ts, bal: pt[field] });
      }
    });
    if (s.points.length) {
      const last = s.points[s.points.length - 1];
      pts.push({ ts: tMax, bal: last[field] });
    }

    if (pts.length >= 2) {
      series.push({ userId: s.userId, nick: s.nick, color: s.color, points: pts });
    }
  });

  // Calculate bounds
  let yLo = Infinity, yHi = -Infinity;
  series.forEach(s => {
    s.points.forEach(pt => {
      yLo = Math.min(yLo, pt.bal);
      yHi = Math.max(yHi, pt.bal);
    });
  });
  if (!isFinite(yLo)) { yLo = 0; yHi = 2000; }
  const pad = Math.max(50, (yHi - yLo) * 0.08);
  const bounds = { tMin, tMax, yLo: yLo - pad, yHi: yHi + pad };

  return { series, bounds };
}

// Larger coin-race view for the ranking detail modal: big chart, replay button,
// and a legend sorted by current balance.
function renderCoinRaceDetail(container) {
  if (!_coinRaceRaw.length) {
    container.append(el('p', { style: { color: 'var(--muted)' } }, 'Brak danych.'));
    return;
  }

  const canvas = el('canvas', { className: 'coin-race-detail-canvas' });
  const replayBtn = el('button', { className: 'btn-ghost', style: { marginTop: '8px' } }, '▶ Odtwórz ponownie');
  const legend = el('div', { className: 'coin-race-legend' });

  // Function to calculate and redraw
  const redraw = () => {
    const { series, bounds } = getFilteredRaceData(_coinRaceMode);
    
    // Sort legend by current balance
    const ranked = [...series].sort((a, b) => b.points[b.points.length - 1].bal - a.points[a.points.length - 1].bal);
    legend.replaceChildren(...ranked.map(s => el('div', { className: 'coin-race-legend-item' },
      el('span', { className: 'coin-race-legend-swatch', style: { background: s.color } }),
      s.nick + ' · ' + fmtNum(Math.round(s.points[s.points.length - 1].bal)) + ' 🪙'
    )));

    if (series.length) {
      playCoinRace(canvas, { showLabels: true, series, bounds });
    } else {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      legend.replaceChildren(el('p', { style: { color: 'var(--muted)', padding: '12px' } }, 'Brak danych dla wybranych filtrów.'));
    }
  };

  replayBtn.addEventListener('click', () => {
    const { series, bounds } = getFilteredRaceData(_coinRaceMode);
    if (series.length) {
      animateCoinRace(canvas, series, bounds, { showLabels: true });
    }
  });

  // Construct filters elements
  const filterBar = el('div', { className: 'fb-sort-bar', style: { marginBottom: '16px', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', justifyContent: 'space-between', padding: '12px', background: 'var(--surface)', borderRadius: '12px' } },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
      el('span', { className: 'fb-sort-label' }, 'Okres:'),
      ...['all', '30d', '7d', '3d'].map(time => {
        const label = time === 'all' ? 'Wszystko' : time === '30d' ? '30 dni' : time === '7d' ? '7 dni' : '3 dni';
        const btn = el('button', { className: 'fb-sort-btn' + (_coinRaceTimeFilter === time ? ' active' : '') }, label);
        btn.addEventListener('click', () => {
          filterBar.querySelectorAll('[data-time]').forEach(x => x.classList.remove('active'));
          btn.classList.add('active');
          _coinRaceTimeFilter = time;
          redraw();
        });
        btn.dataset.time = time;
        return btn;
      })
    ),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        el('span', { className: 'fb-sort-label' }, 'Gracze:'),
        ...['all', 'top5', 'me'].map(players => {
          const label = players === 'all' ? 'Wszyscy' : players === 'top5' ? 'Top 5' : 'Tylko Ja';
          const btn = el('button', { className: 'fb-sort-btn' + (_coinRacePlayerFilter === players ? ' active' : '') }, label);
          btn.addEventListener('click', () => {
            filterBar.querySelectorAll('[data-players]').forEach(x => x.classList.remove('active'));
            btn.classList.add('active');
            _coinRacePlayerFilter = players;
            redraw();
          });
          btn.dataset.players = players;
          return btn;
        })
      ),
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        el('span', { className: 'fb-sort-label' }, 'Szukaj:'),
        (() => {
          const inp = el('input', { type: 'text', placeholder: 'Wpisz nick...', value: _coinRaceSearchQuery, style: { width: '120px', height: '26px', padding: '2px 8px', border: '1.5px solid rgba(15,23,42,.15)', borderRadius: '6px', fontSize: '12px', background: 'var(--card)', color: 'var(--text)', fontWeight: 600, outline: 'none' } });
          inp.addEventListener('input', () => {
            _coinRaceSearchQuery = inp.value;
            redraw();
          });
          return inp;
        })()
      )
    )
  );

  container.append(filterBar, replayBtn, canvas, legend);
  redraw();
}

// ── Ranking Detail Modal ──────────────────────────────────────────────────
(function initRankingModal() {
  const overlay = document.getElementById('ranking-detail-overlay');
  const body = document.getElementById('ranking-detail-body');
  const title = document.getElementById('ranking-detail-title');
  const closeBtn = document.getElementById('ranking-detail-close');
  let _lbQuery = '';

  // The Gotówka and Net Worth cards open the SAME table, pre-sorted by the
  // metric that was clicked — the sort toggle inside then swaps between them.
  function rankingTitle() {
    return _lbSort === 'coins' ? '🪙 Ranking — Gotówka' : '💎 Ranking — Net Worth';
  }

  function openModal(detail) {
    body.replaceChildren();
    if (detail === 'ranking' || detail === 'ranking-cash' || detail === 'ranking-net') {
      if (detail === 'ranking-cash') _lbSort = 'coins';
      else if (detail === 'ranking-net') _lbSort = 'net_worth';
      title.textContent = rankingTitle();
      renderFullLeaderboard(body);
    } else if (detail === 'calibration') {
      title.textContent = '🎯 Trafność prognoz';
      renderCalibrationDetail(body);
    } else if (detail === 'medals') {
      title.textContent = '🏅 Medale sezonowe';
      renderMedalsDetail(body);
    } else if (detail === 'activity') {
      title.textContent = '📅 Aktywność graczy';
      renderActivityDetail(body);
    } else if (detail === 'hazardista') {
      title.textContent = '🎰 Hazardista';
      renderFullHazardista(body);
    } else if (detail === 'coin-inflows') {
      title.textContent = '💸 Łączne wpływy coinów';
      renderCoinInflowDetail(body);
    } else if (detail === 'market-history') {
      title.textContent = '📈 Historia — Rynki';
      renderFullMarketHistory(body);
    } else if (detail === 'hazard-history') {
      title.textContent = '🎰 Historia — Hazard';
      renderFullHazardHistory(body);
    } else if (detail === 'seasons') {
      title.textContent = '🎮 Historia sezonów gier';
      buildSeasonHistorySections(body, false);
    } else if (detail === 'coin-race-cash') {
      title.textContent = '📈 Wyścig gotówki — stan gotówki w czasie';
      _coinRaceMode = 'coins';
      _coinRaceTimeFilter = 'all';
      _coinRacePlayerFilter = 'all';
      _coinRaceSearchQuery = '';
      applyCoinRaceMode('coins');
      renderCoinRaceDetail(body);
    } else if (detail === 'coin-race-net') {
      title.textContent = '📈 Wyścig Net Worth — stan majątku w czasie';
      _coinRaceMode = 'net';
      _coinRaceTimeFilter = 'all';
      _coinRacePlayerFilter = 'all';
      _coinRaceSearchQuery = '';
      applyCoinRaceMode('net');
      renderCoinRaceDetail(body);
    } else if (detail === 'economy') {
      title.textContent = '🏦 Skarbiec G6 — bank coinów';
      renderEconomyDetail(body);
    }
    overlay.classList.remove('hidden');
  }

  function closeModal() { overlay.classList.add('hidden'); body.replaceChildren(); }
  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  document.querySelectorAll('.ranking-card[data-detail]').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.detail));
  });

  // Reachable from the preview tables / hero tiles in the Statystyki grid.
  openStatsDetail = openModal;
  openStatsUserProfile = (userId, nick, coins, opts) => {
    overlay.classList.remove('hidden');
    openUserProfile(userId, nick, coins, opts);
  };

  const walletBtn = document.getElementById('wallet-btn');
  if (walletBtn) walletBtn.addEventListener('click', async () => {
    if (!me) return;
    overlay.classList.remove('hidden');
    if (!_seasonHistory || !_seasonHistory.length) {
      body.replaceChildren(makeSpinner());
      try { await loadSeasonHistory(); } catch {}
    }
    openUserProfile(me.id, me.nick, me.coins, { wallet: true });
  });

  const documentsBtn = document.getElementById('documents-btn');
  if (documentsBtn) documentsBtn.addEventListener('click', () => { if (DOCUMENTS_ENABLED && me) openMyDocuments(); });

  function renderFullLeaderboard(container) {
    const data = _lbData;
    if (!data || !data.length) { container.append(el('p', {}, 'Brak graczy.')); return; }
    const isCash = _lbSort === 'coins';
    // Rank is assigned before filtering so searching for a nick still shows that
    // player's real position, not their position among the search hits.
    const ranked = [...data]
      .sort((a, b) => (+b[_lbSort] || 0) - (+a[_lbSort] || 0))
      .map((row, i) => ({ row, rank: i + 1 }));

    const tbody = el('tbody', {});
    const empty = el('p', { className: 'lb-click-hint hidden' }, 'Nikt taki nie gra w Top 20.');
    const fillRows = () => {
      const q = _lbQuery.trim().toLowerCase();
      const hits = q ? ranked.filter(({ row }) => (row.nick || '').toLowerCase().includes(q)) : ranked;
      empty.classList.toggle('hidden', hits.length > 0);
      tbody.replaceChildren(...hits.map(({ row, rank }) => {
        const cash = lbCoinsCell(row);
        const net = el('td', { className: 'lb-net' }, fmtNum(row.net_worth) + ' 🪙');
        (isCash ? cash : net).classList.add('is-sorted');
        const tr = el('tr', { className: 'lb-row-clickable' },
          el('td', { className: 'lb-rank' + (rank === 1 ? ' gold' : '') }, rank === 1 ? '🥇' : String(rank)),
          el('td', { className: 'lb-nick' + (row.id === me.id ? ' me' : '') }, row.nick + (row.id === me.id ? ' (Ty)' : '')),
          cash, net
        );
        tr.addEventListener('click', () => openUserProfile(row.id, row.nick, row.coins));
        return tr;
      }));
    };

    const search = el('input', {
      type: 'search', className: 'lb-search', placeholder: '🔍 Szukaj gracza…', value: _lbQuery,
    });
    search.addEventListener('input', () => { _lbQuery = search.value; fillRows(); });

    const sortBtn = (key, label) => {
      const b = el('button', { className: 'fb-sort-btn' + (_lbSort === key ? ' active' : '') }, label);
      b.addEventListener('click', () => {
        if (_lbSort === key) return;
        _lbSort = key;
        title.textContent = rankingTitle();
        container.replaceChildren();
        renderFullLeaderboard(container);
      });
      return b;
    };
    const thCash = el('th', {}, '🪙 Gotówka');
    const thNet = el('th', {}, '💎 Net Worth');
    (isCash ? thCash : thNet).classList.add('is-sorted');
    container.append(
      el('div', { className: 'fb-sort-bar lb-toolbar' },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
          el('span', { className: 'fb-sort-label' }, 'Sortuj:'),
          sortBtn('net_worth', '💎 Net Worth'),
          sortBtn('coins', '🪙 Gotówka')
        ),
        search
      ),
      el('table', { className: 'lb-table' },
        el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Nick'), thCash, thNet)),
        tbody
      ),
      empty,
      el('div', { className: 'lb-legend' },
        el('p', {}, el('strong', {}, '🪙 Gotówka'), ' — wolne coiny, którymi możesz teraz obracać.'),
        el('p', {}, el('strong', {}, '💎 Net Worth'), ' — cały majątek: gotówka + coiny w otwartych zakładach (Mundial, rynki), stack w pokerze oraz wartość Twoich przedmiotów i certyfikatów.'),
        el('p', {}, el('strong', {}, '„poza gotówką"'), ' — różnica między nimi: postawione coiny plus wartość przedmiotów. To nie są stracone coiny.')
      ),
      el('p', { className: 'lb-click-hint' }, '👆 Kliknij gracza, aby zobaczyć historię coinów')
    );
    fillRows();
  }

  async function openUserProfile(userId, nick, coins, opts = {}) {
    title.textContent = opts.wallet ? '💼 Portfel — ' + nick : '👤 ' + nick;
    body.replaceChildren();

    // Wallet mode has no back target — the modal's own ✕ closes it.
    let backBtn = null;
    if (!opts.wallet) {
      backBtn = el('button', { className: 'btn-ghost user-profile-back' }, '← Wróć do rankingu');
      backBtn.addEventListener('click', () => { body.replaceChildren(); title.textContent = rankingTitle(); renderFullLeaderboard(body); });
      body.append(backBtn);
    }
    body.append(makeSpinner());

    try {
      const [gamesRes, tradesRes, profileRes, coinTxRes, footballRes, breakdownRes] = await Promise.all([
        sbFetchAll(() => sb.from('game_transactions').select('created_at,game,bet,won,id').eq('user_id', userId).order('created_at', { ascending: true }).order('id', { ascending: true })),
        sbFetchAll(() => sb.from('trades').select('created_at,amount,shares,side,market_id,markets(title,resolved,resolution,resolved_at),id').eq('user_id', userId).order('created_at', { ascending: true }).order('id', { ascending: true })),
        sb.from('profiles').select('created_at').eq('id', userId).single(),
        sbFetchAll(() => sb.from('coin_transactions').select('created_at,delta,reason,meta,id').eq('user_id', userId).order('created_at', { ascending: true }).order('id', { ascending: true })),
        sbFetchAll(() => sb.from('football_bets').select('created_at,settled_at,pick,stake,potential_payout,status,id').eq('user_id', userId).order('created_at', { ascending: true }).order('id', { ascending: true })),
        sb.rpc('user_net_worth_breakdown', { p_uid: userId }),
      ]);
      const games = gamesRes.data || [];
      const trades = tradesRes.data || [];
      const coinTxs = coinTxRes.data || [];
      const footballBets = footballRes.data || [];
      const breakdown = breakdownRes && !breakdownRes.error ? breakdownRes.data : null;
      const userAwards = (_seasonHistory || []).filter(a => a.user_id === userId);
      const profileCreatedAt = profileRes.data?.created_at;

      // For resolved markets where this user bet on the winning side, compute payouts
      // using the same formula as resolve_market(): bet_back + pro_rata_losing_pot
      const resolvedWinningMarketIds = [...new Set(
        trades.filter(t => t.markets?.resolved && t.side === t.markets?.resolution).map(t => t.market_id)
      )];

      let allMarketTrades = [];
      if (resolvedWinningMarketIds.length > 0) {
        const { data } = await sb.from('trades').select('market_id,user_id,side,amount,shares')
          .in('market_id', resolvedWinningMarketIds);
        allMarketTrades = data || [];
      }

      // Replay every coin-affecting event into a running balance (shared helper).
      const balancePoints = buildBalancePoints({
        userId, coins, createdAt: profileCreatedAt,
        trades, games, coinTxs, awards: userAwards, allMarketTrades, footballBets,
      });

      body.replaceChildren(...(backBtn ? [backBtn] : []));

      // ── Portfolio header: one headline value + change since the 1 000-coin
      // start. The segmented toggle switches both the headline and the chart
      // between cash and net worth (cash curve + current "poza gotówką" offset,
      // i.e. holdings treated as constant over time).
      const lbRow = (_lbData || []).find(r => r.id === userId);
      const nwTotal = breakdown ? Math.round(+breakdown.total || 0) : (lbRow ? Math.round(+lbRow.net_worth || 0) : null);
      const offset = nwTotal != null ? Math.max(0, nwTotal - Math.round(+coins || 0)) : 0;
      // Net-worth points: time-varying bal+lock (same as wyścig coinów),
      // with the final point pinned to the live value.
      const netPoints = balancePoints.map(p => ({ ...p, bal: p.bal + (p.lock || 0) }));
      if (netPoints.length > 0) netPoints[netPoints.length - 1].bal = balancePoints[balancePoints.length - 1].bal + offset;

      const fmtPl = n => Math.round(+n || 0).toLocaleString('pl-PL');
      const opsCount = Math.max(0, balancePoints.length - 1);
      const opsWord = opsCount === 1 ? 'operacja'
        : (opsCount % 10 >= 2 && opsCount % 10 <= 4 && (opsCount % 100 < 12 || opsCount % 100 > 14)) ? 'operacje' : 'operacji';

      let chartMode = offset > 0 ? 'net' : 'coins';
      const chartCanvas = el('canvas', { className: 'user-profile-chart' });
      const drawMode = () => drawCoinChart(chartCanvas, chartMode === 'net' ? netPoints : balancePoints);

      const headLabel = el('div', { className: 'pf-label' });
      const headValue = el('div', { className: 'pf-value' });
      const headDelta = el('div', { className: 'pf-delta' });
      const headMeta = el('div', { className: 'pf-meta' },
        (profileCreatedAt ? 'Konto od ' + new Date(profileCreatedAt).toLocaleDateString('pl-PL') + ' · ' : '') + opsCount + ' ' + opsWord);
      const applyHead = () => {
        const cur = chartMode === 'net' && nwTotal != null ? nwTotal : Math.round(+coins || 0);
        headLabel.textContent = chartMode === 'net' ? 'Wartość portfela (Net Worth)' : 'Dostępna gotówka';
        headValue.textContent = fmtPl(cur) + ' 🪙';
        const d = cur - 1000;
        headDelta.textContent = (d >= 0 ? '▲ +' : '▼ −') + fmtPl(Math.abs(d)) + ' 🪙 od startu (' + (d >= 0 ? '+' : '−') + fmtPl(Math.abs(d) / 10) + '%)';
        headDelta.style.color = d >= 0 ? 'var(--yes)' : 'var(--no)';
      };
      const segBtn = (key, label) => {
        const b = el('button', { className: key === chartMode ? 'active' : '', type: 'button' }, label);
        b.addEventListener('click', () => {
          if (chartMode === key) return;
          chartMode = key;
          seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
          applyHead();
          drawMode();
        });
        return b;
      };
      const seg = offset > 0
        ? el('div', { className: 'pf-seg' }, segBtn('net', 'Net Worth'), segBtn('coins', 'Gotówka'))
        : null;
      body.append(el('div', { className: 'pf-head' },
        el('div', {}, headLabel, headValue, headDelta, headMeta),
        seg
      ));
      applyHead();

      // Chart — append first so offsetWidth resolves, then draw.
      if (balancePoints.length >= 2) {
        body.append(chartCanvas, el('p', { className: 'user-profile-chart-label' }, '— — — poziom startowy 1 000 🪙'));
        drawMode();
      }

      // Net Worth breakdown — what counts toward this player's net worth
      if (breakdown) renderNetWorthBreakdown(body, breakdown);

      // Transaction history table (all events, newest first)
      body.append(el('div', { className: 'user-profile-section-title' }, 'Historia transakcji',
        opsCount > 0 ? el('span', { className: 'pf-count' }, String(opsCount)) : ''));
      if (balancePoints.length <= 1) {
        body.append(el('p', { style: { color: 'var(--muted)', marginTop: '6px' } }, 'Brak historii transakcji.'));
      } else {
        const rows = [...balancePoints].reverse().map(p => {
          const isStart = p.delta === null;
          const isGarden = p.isGarden;
          const deltaStr = isStart ? '—' : (p.delta >= 0 ? '+' + p.delta : String(p.delta));
          const deltaClass = isStart ? 'tx-delta-zero' : p.delta > 0 ? 'tx-delta-pos' : 'tx-delta-neg';
          const rowStyle = isGarden ? { color: 'var(--muted)', fontStyle: 'italic' } : {};
          return el('tr', { style: rowStyle },
            el('td', { className: 'tx-time' }, fmtDateTime(new Date(p.ts).toISOString())),
            el('td', { className: isStart ? 'tx-start' : '' }, p.label),
            el('td', { className: deltaClass }, deltaStr + (isStart ? '' : ' 🪙')),
            el('td', { className: 'tx-bal' }, fmtNum(p.bal) + ' 🪙')
          );
        });
        body.append(el('div', { className: 'tx-history-scroll' },
          el('table', { className: 'tx-history-table' },
            el('thead', {}, el('tr', {},
              el('th', {}, 'Data'), el('th', {}, 'Opis'), el('th', {}, 'Zmiana'), el('th', {}, 'Saldo')
            )),
            el('tbody', {}, ...rows)
          )
        ));
      }
    } catch {
      body.replaceChildren(...(backBtn ? [backBtn] : []), el('p', {}, 'Błąd ładowania profilu.'));
    }
  }

  function renderFullHazardista(container) {
    const data = _hazardistaData;
    if (!data || !data.length) { container.append(el('p', {}, 'Brak danych.')); return; }
    const winners = data.filter(r => r.total_pl > 0).slice(0, 10);
    const losers = data.filter(r => r.total_pl < 0).sort((a, b) => a.total_pl - b.total_pl).slice(0, 10);
    function makeT(items, pos, ttl) {
      if (!items.length) return el('div', {}, el('strong', {}, ttl), el('p', {}, 'Brak.'));
      const rows = items.map((r, i) => el('tr', {},
        el('td', { className: 'lb-rank' + (i === 0 && pos ? ' gold' : '') }, i === 0 && pos ? '🥇' : String(i + 1)),
        el('td', { className: 'lb-nick' + (r.user_id === me.id ? ' me' : '') }, r.nick),
        el('td', {}, (r.roulette_pl || 0) + ' 🪙'),
        el('td', {}, (r.slots_pl || 0) + ' 🪙'),
        el('td', {}, (r.plinko_pl || 0) + ' 🪙'),
        el('td', {}, (r.mines_pl || 0) + ' 🪙'),
        el('td', {}, (r.crash_pl || 0) + ' 🪙'),
        el('td', {}, (r.wheel_pl || 0) + ' 🪙'),
        el('td', {}, (r.poker_pl || 0) + ' 🪙'),
        el('td', { className: 'tx-pl ' + (pos ? 'tx-pl-profit' : 'tx-pl-loss') }, (pos ? '+' : '') + r.total_pl + ' 🪙')
      ));
      return el('div', { style: { marginBottom: '16px' } },
        el('div', { className: 'hazardista-col-title' }, ttl),
        el('table', { className: 'lb-table' },
          el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Nick'), el('th', {}, 'Ruletka'), el('th', {}, 'Sloty'), el('th', {}, 'Plinko'), el('th', {}, 'Miny'), el('th', {}, 'Rakieta'), el('th', {}, 'Żubr'), el('th', {}, 'Poker'), el('th', {}, 'Suma'))),
          el('tbody', {}, ...rows)
        )
      );
    }
    container.append(makeT(winners, true, '🏆 Najwięksi wygrani'), makeT(losers, false, '💸 Najwięksi przegrani'));
  }

  function renderFullMarketHistory(container) {
    // Filters
    const fSearch = el('input', { className: 'history-filter-input', type: 'search', placeholder: 'Gracz lub rynek' });
    const fSide = el('select', { className: 'history-filter-select' });
    fSide.innerHTML = '<option value="">Typ: wszystkie</option><option value="YES">TAK</option><option value="NO">NIE</option>';
    const fStatus = el('select', { className: 'history-filter-select' });
    fStatus.innerHTML = '<option value="">Status: wszystkie</option><option value="open">Aktywne</option><option value="closed">Zamknięte</option>';
    const fClear = el('button', { className: 'btn-ghost history-clear', type: 'button' }, 'Wyczyść');
    const filters = el('div', { className: 'history-filters' }, fSearch, fSide, fStatus, fClear);
    const tableWrap = el('div', { className: 'history-wrap' });
    container.append(filters, tableWrap);

    function render() {
      const q = fSearch.value.trim().toLowerCase();
      const side = fSide.value;
      const status = fStatus.value;
      const filtered = marketHistoryRows.filter(row => {
        if (q && !row.searchText.includes(q)) return false;
        if (side && row.side !== side) return false;
        if (status && row.status !== status) return false;
        return true;
      });
      if (!filtered.length) { tableWrap.replaceChildren(el('p', { style: { padding: '12px', color: 'var(--muted)' } }, 'Brak transakcji.')); return; }
      const rows = filtered.slice(0, 200).map(row => el('tr', {},
        el('td', { className: 'tx-time' }, fmtDateTime(row.created_at)),
        el('td', { className: 'lb-nick' }, row.nick_snapshot || '?'),
        el('td', { className: 'tx-market' }, el('span', { className: 'tx-market-title', title: row.title }, row.icon + ' ' + row.title), el('span', { className: 'tx-status' }, row.resolvedText)),
        el('td', {}, el('span', { className: 'tx-side ' + (row.sideYes ? 'tx-side-yes' : 'tx-side-no') }, row.sideLabel)),
        el('td', { className: 'tx-amount' }, fmtCoins(row.amount) + ' 🪙'),
        el('td', { className: 'tx-pl ' + profitClassName(row.profit) }, fmtSignedCoins(row.profit, row.profitApprox)),
        el('td', { className: 'tx-prob' }, 'TAK ' + fmtPct(+row.p_yes_after || 0))
      ));
      tableWrap.replaceChildren(el('table', { className: 'lb-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Czas'), el('th', {}, 'Gracz'), el('th', {}, 'Rynek'), el('th', {}, 'Typ'), el('th', {}, 'Kwota'), el('th', {}, 'P/L'), el('th', {}, 'Po trans.'))),
        el('tbody', {}, ...rows)
      ));
    }
    fSearch.addEventListener('input', render);
    fSide.addEventListener('change', render);
    fStatus.addEventListener('change', render);
    fClear.addEventListener('click', () => { fSearch.value = ''; fSide.value = ''; fStatus.value = ''; render(); });
    render();
  }

  function renderFullHazardHistory(container) {
    const fSearch = el('input', { className: 'history-filter-input', type: 'search', placeholder: 'Gracz lub gra' });
    const fGame = el('select', { className: 'history-filter-select' });
    fGame.innerHTML = '<option value="">Gra: wszystkie</option><option value="roulette">Ruletka</option><option value="slots">Sloty</option><option value="plinko">Plinko G6</option><option value="mines">Miny G6</option><option value="crash">Rakieta</option><option value="wheel">Koło Żubra</option><option value="poker">Poker</option>';
    const fClear = el('button', { className: 'btn-ghost history-clear', type: 'button' }, 'Wyczyść');
    const filters = el('div', { className: 'history-filters', style: { gridTemplateColumns: '1fr 160px auto' } }, fSearch, fGame, fClear);
    const tableWrap = el('div', { className: 'history-wrap' });
    container.append(filters, tableWrap);

    function render() {
      const q = fSearch.value.trim().toLowerCase();
      const game = fGame.value;
      const filtered = hazardHistoryRows.filter(row => {
        if (q && !row.searchText.includes(q)) return false;
        if (game && row.gameType !== game) return false;
        return true;
      });
      if (!filtered.length) { tableWrap.replaceChildren(el('p', { style: { padding: '12px', color: 'var(--muted)' } }, 'Brak transakcji.')); return; }
      const rows = filtered.slice(0, 200).map(row => el('tr', {},
        el('td', { className: 'tx-time' }, fmtDateTime(row.created_at)),
        el('td', { className: 'lb-nick' }, row.nick_snapshot || '?'),
        el('td', { className: 'tx-market' }, el('span', { className: 'tx-market-title' }, row.icon + ' ' + row.title)),
        el('td', {}, el('span', { className: 'tx-side tx-side-game' }, row.sideLabel)),
        el('td', { className: 'tx-amount' }, fmtCoins(row.amount) + ' 🪙'),
        el('td', { className: 'tx-pl ' + profitClassName(row.profit) }, fmtSignedCoins(row.profit, false))
      ));
      tableWrap.replaceChildren(el('table', { className: 'lb-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Czas'), el('th', {}, 'Gracz'), el('th', {}, 'Gra'), el('th', {}, 'Typ'), el('th', {}, 'Kwota'), el('th', {}, 'P/L'))),
        el('tbody', {}, ...rows)
      ));
    }
    fSearch.addEventListener('input', render);
    fGame.addEventListener('change', render);
    fClear.addEventListener('click', () => { fSearch.value = ''; fGame.value = ''; render(); });
    render();
  }
})();
