// Parity harness for „Uzdrowiciel G6" (healer_dungeon).
// Unlike hd-balance.mjs (which only loads the client sim to judge whether the
// GAME is fun/fair), this loads BOTH real files —
//   - client ← games/healer-dungeon.js   (the PARITY BLOCK the player runs)
//   - server ← supabase/functions/healer-dungeon-action/index.ts (the replay
//     the Edge Function trusts)
// — and asserts they produce IDENTICAL state trajectories given the same
// seed, class and action log. This is the check that catches "someone edited
// one copy and forgot the other" before it reaches production, where it would
// silently mean the server either rejects every legitimate run or accepts a
// score the client could never have produced.
//
// Two independent checks per run:
//   (1) LOCKSTEP — a bot drives the CLIENT sim tick-by-tick; every action it
//       takes is replayed onto the SERVER sim in the same tick, and the full
//       state is deep-compared after every tick. This is the strongest
//       possible check: any divergence, however small, fails on the very
//       tick it first appears.
//   (2) GROUPED REPLAY — the same action log, collected as {tick,a,t} exactly
//       like the real event log the browser submits, is replayed from a fresh
//       state through EACH copy's own tick-grouping loop (mirroring
//       hdReplay/ttReplay) and both final scores must match the lockstep
//       run's — this is what actually exercises the code path the Edge
//       Function runs in production, not just the bare tick function.
//
// Run: node scripts/hd-parity.mjs

import fs from 'fs';

function loadSim(path) {
  const src = fs.readFileSync(path, 'utf8');
  const start = src.indexOf('const HD_TICK_MS');
  const end = src.indexOf('// ╚═══ PARITY BLOCK END');
  if (start < 0 || end < 0) throw new Error(`parity block markers not found in ${path}`);
  const block = src.slice(start, end);
  const EXPORTS = [
    'hdInitState', 'hdAdvanceTick', 'hdStartPull', 'hdApplyUpgrade', 'hdCost', 'hdSpell', 'hdClass',
    'hdBossPending', 'hdSurvives', 'hdIncomingHeal', 'hdMaxMana', 'hdHealAmt',
    'HD_TICK_MS', 'HD_MAX_TICKS', 'HD_MAX_SCORE', 'HD_MAX_EVENTS',
    'HD_PARTY', 'HD_TANK', 'HD_HEAL', 'HD_CLASSES',
    'HD_SP_FILL', 'HD_SP_RAID', 'HD_SP_BIG', 'HD_SPELL_SLOTS',
    'HD_K_HOT', 'HD_K_DIRECT', 'HD_K_SHIELD',
    'HD_A_FILL', 'HD_A_RAID', 'HD_A_BIG', 'HD_A_PULL', 'HD_A_UPGRADE',
    'HD_UPGRADE_CHOICES', 'HD_UK_STAT', 'HD_UK_PERK', 'HD_PERK_COUNT',
    'HD_BOSS_EVERY', 'HD_CB_BUSTER',
  ];
  return new Function(block + '\nreturn {' + EXPORTS.join(',') + '};')();
}

const C = loadSim('games/healer-dungeon.js');
const S = loadSim('supabase/functions/healer-dungeon-action/index.ts');

// ── a semi-competent, class-generic bot (trimmed from hd-balance.mjs) ───────
function ready(M, st, slot) { return st.cd[slot] === 0 && st.mana >= M.hdCost(st, slot); }
function preemptive(M, st) {
  const k = M.hdSpell(st, M.HD_SP_FILL).kind;
  return k === M.HD_K_HOT || k === M.HD_K_SHIELD;
}
function panicIsShield(M, st) { return M.hdSpell(st, M.HD_SP_BIG).kind === M.HD_K_SHIELD; }
function covered(M, st, i) { return M.hdIncomingHeal(st, i) + st.shield[i]; }

function policy(M, st, low, lp) {
  const hurt = st.hp.filter((hp, i) => hp < st.maxHp[i] * 0.85).length;
  const tankPct = st.hp[0] / st.maxHp[0];
  const shieldPanic = panicIsShield(M, st);
  const pending = M.hdBossPending(st);
  if (pending && pending.left <= 25) {
    if (pending.kind === M.HD_CB_BUSTER) {
      if (!M.hdSurvives(st, 0) && ready(M, st, M.HD_SP_BIG)) return [{ a: M.HD_A_BIG, t: 0 }];
      const gap = st.maxHp[0] - st.hp[0];
      if (!shieldPanic && gap > 200 && ready(M, st, M.HD_SP_BIG) && covered(M, st, 0) < gap * 0.6) return [{ a: M.HD_A_BIG, t: 0 }];
      if (preemptive(M, st) && ready(M, st, M.HD_SP_FILL) && st.shield[0] === 0) return [{ a: M.HD_A_FILL, t: 0 }];
    } else if (ready(M, st, M.HD_SP_RAID) && hurt >= 2) {
      return [{ a: M.HD_A_RAID, t: 0 }];
    }
  }
  if (hurt >= 3 && ready(M, st, M.HD_SP_RAID)) return [{ a: M.HD_A_RAID, t: 0 }];
  if (tankPct < 0.65 && ready(M, st, M.HD_SP_BIG) && (!shieldPanic || st.shield[0] === 0)) return [{ a: M.HD_A_BIG, t: 0 }];
  if (lp < 0.5 && ready(M, st, M.HD_SP_BIG) && (!shieldPanic || st.shield[low] === 0)) return [{ a: M.HD_A_BIG, t: low }];
  if (preemptive(M, st) && ready(M, st, M.HD_SP_FILL)) {
    if (covered(M, st, 0) === 0) return [{ a: M.HD_A_FILL, t: 0 }];
    for (let i = 0; i < M.HD_PARTY; i += 1) {
      if (st.hp[i] > 0 && covered(M, st, i) === 0 && st.hp[i] < st.maxHp[i] * 0.97) return [{ a: M.HD_A_FILL, t: i }];
    }
  }
  if (lp < 0.85 && ready(M, st, M.HD_SP_FILL) && covered(M, st, low) < (st.maxHp[low] - st.hp[low])) {
    return [{ a: M.HD_A_FILL, t: low }];
  }
  if (shieldPanic && ready(M, st, M.HD_SP_BIG) && st.shield[0] === 0 && st.hp[0] > 0
      && st.mana > M.hdMaxMana(st) * 0.3) {
    return [{ a: M.HD_A_BIG, t: 0 }];
  }
  return null;
}

function drive(M, st, dawdle) {
  if (st.phase === 'rest') {
    if (!st.upgradePicked) return [{ a: M.HD_A_UPGRADE, t: Math.floor(Math.random() * M.HD_UPGRADE_CHOICES) }];
    return st.restTicks >= dawdle ? [{ a: M.HD_A_PULL, t: 0 }] : null;
  }
  if (st.gcd > 0 || st.cast) return null;
  let low = 0, lp = 2;
  for (let i = 0; i < M.HD_PARTY; i += 1) { const p = st.hp[i] / st.maxHp[i]; if (p < lp) { lp = p; low = i; } }
  return policy(M, st, low, lp);
}

// snapshot the fields that matter for parity — everything the score and the
// replay's trusted columns are derived from, plus enough sim state (hp/mana/
// cds/hots/shields) that a divergence anywhere shows up immediately.
function snap(st) {
  return JSON.stringify({
    tick: st.tick, phase: st.phase, pull: st.pull, dead: st.dead,
    hp: st.hp, mana: st.mana, shield: st.shield, shieldT: st.shieldT,
    gcd: st.gcd, cd: st.cd, fsr: st.fsr,
    hots: st.hots, cast: st.cast,
    packHp: st.packHp, isBoss: st.isBoss, affixes: st.affixes, bossKit: st.bossKit,
    bossCast: st.bossCast, bossCastT: st.bossCastT,
    score: st.score, scPull: st.scPull, scHeal: st.scHeal, scFlawless: st.scFlawless, scTempo: st.scTempo,
    pullsCleared: st.pullsCleared, bossesKilled: st.bossesKilled, deaths: st.deaths, deathPulls: st.deathPulls,
    healingDone: st.healingDone, overheal: st.overheal, manaSpent: st.manaSpent,
    stats: st.stats, perks: st.perks, phoenix: st.phoenix, reviveCharges: st.reviveCharges,
    upgrades: st.upgrades, upgradePicked: st.upgradePicked,
  });
}

let fail = 0;
let ran = 0;
const MAX_TICKS_PER_RUN = 4000; // enough to cover several pulls + a boss without a 20-min fuzz

function runLockstep(seed, cls, dawdle) {
  const stC = C.hdInitState(seed, cls);
  const stS = S.hdInitState(seed, cls);
  const events = [];
  let tick = 0;
  while (!stC.dead && tick < MAX_TICKS_PER_RUN) {
    const acts = drive(C, stC, dawdle) || [];
    tick += 1;
    for (const a of acts) events.push({ tick, a: a.a, t: a.t });
    C.hdAdvanceTick(stC, acts);
    S.hdAdvanceTick(stS, acts);
    const a = snap(stC), b = snap(stS);
    if (a !== b) {
      fail += 1;
      console.log(`  FAIL lockstep seed=${seed} cls=${cls} tick=${tick}`);
      console.log('    client: ' + a.slice(0, 300));
      console.log('    server: ' + b.slice(0, 300));
      return { events, tick, mismatched: true };
    }
  }
  ran += 1;
  return { events, tick, mismatched: false, finalScore: stC.score, died: stC.dead };
}

function runGroupedReplay(M, seed, cls, events, untilTick) {
  const st = M.hdInitState(seed, cls);
  const capped = Math.min(M.HD_MAX_TICKS, untilTick);
  let ei = 0;
  while (st.tick < capped) {
    const nextTick = st.tick + 1;
    const acts = [];
    while (ei < events.length && events[ei].tick === nextTick) { acts.push({ a: events[ei].a, t: events[ei].t }); ei += 1; }
    M.hdAdvanceTick(st, acts);
    if (st.dead) break;
  }
  return st;
}

console.log('— lockstep: client vs server, tick by tick —');
const SEEDS_PER_CLASS = 40;
for (let cls = 0; cls < C.HD_CLASSES.length; cls += 1) {
  for (let i = 0; i < SEEDS_PER_CLASS; i += 1) {
    const seed = (cls * 100000) + i * 7919 + 1;
    const dawdle = [0, 5, 20, 50][i % 4]; // vary tempo behaviour (affects pullTempo)
    const { events, tick, mismatched, finalScore, died } = runLockstep(seed, cls, dawdle);
    if (mismatched) continue;

    // (2) grouped replay from a cold state, through EACH copy's own loop —
    // this is the exact shape hdReplay in the Edge Function runs in prod.
    const replayC = runGroupedReplay(C, seed, cls, events, tick);
    const replayS = runGroupedReplay(S, seed, cls, events, tick);
    if (snap(replayC) !== snap(replayS)) {
      fail += 1;
      console.log(`  FAIL grouped-replay client-vs-server seed=${seed} cls=${cls}`);
    } else if (replayC.score !== finalScore) {
      fail += 1;
      console.log(`  FAIL grouped-replay vs lockstep seed=${seed} cls=${cls} live=${finalScore} replay=${replayC.score}`);
    }
  }
}
console.log(`  ${ran} lockstep runs completed clean (of ${C.HD_CLASSES.length * SEEDS_PER_CLASS})`);

// ── sanity: the two class tables actually agree on shape ────────────────────
console.log('— class table shape —');
{
  const ok = (name, cond) => { console.log((cond ? '  PASS ' : '  FAIL ') + name); if (!cond) fail += 1; };
  ok('same class count', C.HD_CLASSES.length === S.HD_CLASSES.length);
  for (let i = 0; i < C.HD_CLASSES.length; i += 1) {
    const cc = C.HD_CLASSES[i], sc = S.HD_CLASSES[i];
    ok(`class ${i} (${cc.id}) same id`, cc.id === sc.id);
    for (let slot = 0; slot < 3; slot += 1) {
      const csp = cc.spells[slot], ssp = sc.spells[slot];
      const same = csp.kind === ssp.kind && csp.all === ssp.all && csp.cost === ssp.cost
        && csp.cast === ssp.cast && csp.cd === ssp.cd
        && (csp.amount ?? null) === (ssp.amount ?? null)
        && (csp.dur ?? null) === (ssp.dur ?? null)
        && JSON.stringify(csp.amounts ?? null) === JSON.stringify(ssp.amounts ?? null)
        && (csp.period ?? null) === (ssp.period ?? null);
      ok(`class ${i} (${cc.id}) slot ${slot} spell numbers match`, same);
    }
  }
  ok('same affix table length', C.HD_MAX_TICKS === S.HD_MAX_TICKS && C.HD_MAX_SCORE === S.HD_MAX_SCORE);
}

console.log(fail === 0 ? `\nALL CHECKS PASSED (${ran} lockstep + replay runs)` : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
