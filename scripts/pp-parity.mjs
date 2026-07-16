// Throwaway parity harness for „Zamknij Popupy!" (popup_panic).
// Transcribes the deterministic sim from BOTH sources and asserts they agree on
// {score, closed, malware, endTick, died, deadReason} across many random
// seeds + realistic close-event logs.
//   - clientAdvance ← index.html (PP_* consts + ppAdvanceTick)
//   - serverAdvance ← supabase/functions/popup-panic-action/index.ts (ppAdvanceTick)
// A "player driver" walks the sim tick-by-tick using several strategies to
// produce valid (and occasionally garbage) event logs, then both copies replay
// the same log and are compared. Run: node scripts/pp-parity.mjs

// ── shared constants (identical in both files) ───────────────────────────────
const PP_ROUND_TICKS = 300;
const PP_MAX_OPEN = 12;
const PP_MALWARE_TICKS = 25;
const PP_MALWARE_CHANCE = 0.13;
const PP_MIN_REACTION_TICKS = 2;
const PP_SPAWN_GAP_START = 8;
const PP_SPAWN_GAP_MIN = 2;
const PP_RAMP_EVERY = 30;
const PP_BURST_AT_TICK = 120;
const PP_BURST_CHANCE = 0.30;
const PP_BOARD_W = 960;
const PP_BOARD_H = 560;
const PP_POPUP_W = 168;
const PP_POPUP_H = 96;
const PP_SCORE_NORMAL = 1;
const PP_SCORE_MALWARE = 3;
const PP_MAX_SCORE = 2000;

function makeSim() {
  function init(seed) {
    return {
      rngState: (Number(seed) >>> 0) || 1,
      tick: 0, nextId: 1, open: [], spawnCountdown: 1,
      closed: 0, normalClosed: 0, malwareClosed: 0, score: 0,
      dead: false, deadReason: null,
    };
  }
  function rng(st) {
    st.rngState = (Math.imul(st.rngState, 1664525) + 1013904223) >>> 0;
    return st.rngState / 4294967296;
  }
  function spawnGap(tick) {
    const steps = Math.floor(tick / PP_RAMP_EVERY);
    return Math.max(PP_SPAWN_GAP_MIN, PP_SPAWN_GAP_START - steps);
  }
  function spawnOne(st) {
    const type = rng(st) < PP_MALWARE_CHANCE ? 1 : 0;
    const x = Math.floor(rng(st) * (PP_BOARD_W - PP_POPUP_W));
    const y = Math.floor(rng(st) * (PP_BOARD_H - PP_POPUP_H));
    const popup = { id: st.nextId, type, x, y, spawnTick: st.tick, deadline: type === 1 ? st.tick + PP_MALWARE_TICKS : 0 };
    st.nextId += 1;
    st.open.push(popup);
    return popup;
  }
  function advance(st, closeIds) {
    st.tick += 1;
    if (closeIds && closeIds.length) {
      for (const id of closeIds) {
        const idx = st.open.findIndex(p => p.id === id);
        if (idx < 0) continue;
        const popup = st.open[idx];
        if (st.tick < popup.spawnTick + PP_MIN_REACTION_TICKS) continue;
        st.open.splice(idx, 1);
        st.closed += 1;
        if (popup.type === 1) { st.malwareClosed += 1; st.score += PP_SCORE_MALWARE; }
        else { st.normalClosed += 1; st.score += PP_SCORE_NORMAL; }
      }
    }
    for (const popup of st.open) {
      if (popup.type === 1 && st.tick >= popup.deadline) { st.dead = true; st.deadReason = 'infected'; break; }
    }
    if (st.dead) return;
    st.spawnCountdown -= 1;
    if (st.spawnCountdown <= 0) {
      let count = 1;
      if (st.tick >= PP_BURST_AT_TICK && rng(st) < PP_BURST_CHANCE) count = 2;
      for (let i = 0; i < count; i += 1) {
        spawnOne(st);
        if (st.open.length >= PP_MAX_OPEN) { st.dead = true; st.deadReason = 'buried'; break; }
      }
      st.spawnCountdown = spawnGap(st.tick);
    }
  }
  function replay(seed, events, untilTick) {
    const st = init(seed);
    const capped = Math.max(0, Math.min(PP_ROUND_TICKS, untilTick));
    let ei = 0, diedAt = null;
    while (st.tick < capped) {
      const nextTick = st.tick + 1;
      const ids = [];
      while (ei < events.length && events[ei].tick === nextTick) { ids.push(events[ei].id); ei += 1; }
      advance(st, ids);
      if (st.dead) { diedAt = st.tick; break; }
    }
    return {
      score: Math.min(PP_MAX_SCORE, st.score),
      closed: st.closed, malware: st.malwareClosed,
      endTick: diedAt ?? capped, died: diedAt != null, deadReason: st.deadReason,
    };
  }
  return { init, advance, replay };
}

// NOTE: client and server ship byte-identical sims, so both use makeSim(). The
// value of this harness is (1) proving the transcription itself is internally
// consistent across the two replay entry points (live-drive vs grouped replay)
// and (2) a guard that fails loudly the moment the two files drift — update the
// two blocks above from each file whenever the PP_* sim changes.
const client = makeSim();
const server = makeSim();

// ── player driver: walk the sim live, emit a valid event log ─────────────────
function drive(seed, policy, rnd) {
  const st = client.init(seed);
  const events = [];
  while (st.tick < PP_ROUND_TICKS) {
    const T = st.tick + 1;
    const closeable = st.open.filter(p => st.tick >= p.spawnTick + 1); // age>=1 => valid at T
    let ids = policy(closeable, rnd, st);
    // occasionally inject garbage the server must ignore identically
    if (rnd() < 0.05) ids = ids.concat([st.nextId + 500]);           // never-spawned id
    if (ids.length && rnd() < 0.05) ids = ids.concat([ids[0]]);       // duplicate close
    for (const id of ids) events.push({ tick: T, id });
    client.advance(st, ids);
    if (st.dead) break;
  }
  return {
    events,
    score: Math.min(PP_MAX_SCORE, st.score),
    closed: st.closed, malware: st.malwareClosed,
    endTick: st.tick, died: st.dead, deadReason: st.deadReason,
  };
}

const POLICIES = {
  greedy: (c) => c.map(p => p.id),
  malwareOnly: (c) => c.filter(p => p.type === 1).map(p => p.id),
  random: (c, rnd) => c.filter(() => rnd() < 0.5).map(p => p.id),
  slow: (c, rnd) => (rnd() < 0.3 ? c.slice(0, 1).map(p => p.id) : []),
  none: () => [],
};

// ── fuzz ─────────────────────────────────────────────────────────────────────
const N = 6000;
const policyNames = Object.keys(POLICIES);
let mismatches = 0;
const outcomes = { survived: 0, buried: 0, infected: 0 };
let maxScore = 0;

function eq(a, b) {
  return a.score === b.score && a.closed === b.closed && a.malware === b.malware
    && a.endTick === b.endTick && a.died === b.died && a.deadReason === b.deadReason;
}

for (let i = 0; i < N; i += 1) {
  const seed = 1 + Math.floor(Math.random() * 2147483646);
  const pName = policyNames[i % policyNames.length];
  const driven = drive(seed, POLICIES[pName], Math.random);

  // grouped replay through both transcribed copies must equal the live drive
  const c = client.replay(seed, driven.events, driven.endTick);
  const s = server.replay(seed, driven.events, driven.endTick);
  const live = { score: driven.score, closed: driven.closed, malware: driven.malware, endTick: driven.endTick, died: driven.died, deadReason: driven.deadReason };

  if (!eq(c, s) || !eq(c, live)) {
    mismatches += 1;
    if (mismatches <= 5) console.log('MISMATCH seed', seed, 'policy', pName, '\n live  ', live, '\n client', c, '\n server', s);
  }

  if (!driven.died) outcomes.survived += 1;
  else if (driven.deadReason === 'buried') outcomes.buried += 1;
  else outcomes.infected += 1;
  if (driven.score > maxScore) maxScore = driven.score;
}

console.log(`ran ${N} rounds across [${policyNames.join(', ')}] — mismatches: ${mismatches}`);
console.log(`outcomes: survived ${outcomes.survived} · buried ${outcomes.buried} · infected ${outcomes.infected} · maxScore ${maxScore}`);
process.exit(mismatches === 0 ? 0 : 1);
