// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://inlineskater.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
const db = databaseUrl
  ? postgres(databaseUrl, { prepare: false, max: 4, idle_timeout: 20 })
  : null;

// ─────────────────────────────────────────────────────────────────────────────
// „Uzdrowiciel G6" (healer_dungeon) — endless WoW-Classic-style dungeon healer.
//
// PARITY CONTRACT: everything between PARITY BLOCK START/END below must stay
// byte-for-byte equivalent to the fenced block of the same name in
// games/healer-dungeon.js. The client plays this exact deterministic
// simulation (100 ms ticks, a seeded LCG, a class chosen before the round
// starts) and logs only the actions it took per tick — {tick, a, t} — the
// server replays seed + class + events to derive the trusted score, so a
// client cannot claim depth or healing it never earned.
//
// Unlike Tetris/Snake/etc., the class is not a rendering-only choice: every
// HD_CLASSES-indexed spell table changes the numbers the sim computes, so it
// is threaded through hdInitState exactly like the seed is, and stored on the
// round row so start/submit agree on it even if two rounds race.
// ─────────────────────────────────────────────────────────────────────────────

// ╔═══ PARITY BLOCK START — keep byte-identical with games/healer-dungeon.js ═╗
const HD_TICK_MS = 100;
const HD_MAX_TICKS = 12000;      // 20 min — replay-cost safety cap, NOT a game timer
const HD_MAX_EVENTS = 6000;
const HD_MAX_SCORE = 999;        // mirrors the arcade.sql score cap

const HD_PARTY = 5;
const HD_TANK = 0, HD_HEAL = 1;
const HD_BASE_HP = [1500, 820, 900, 860, 780];

const HD_BASE_MANA = 2900;
const HD_MANA_PER_HEAL_PT = 20;
const HD_HEAL_PCT_PER_PT = 4;
const HD_HP_PCT_PER_PT = 3;
const HD_DPS_PER_PT = 11;
const HD_REGEN_BASE = 40;
const HD_FSR_TICKS = 50;
const HD_FSR_MIN = 25;

const HD_SP_FILL = 0, HD_SP_RAID = 1, HD_SP_BIG = 2;
const HD_SPELL_SLOTS = 3;
const HD_K_HOT = 0, HD_K_DIRECT = 1, HD_K_SHIELD = 2;

const HD_GCD_TICKS = 11;
const HD_GCD_MIN = 7;

const HD_CLASSES = [
  {
    id: 'druid', name: 'Druid', icon: '🌿', portrait: '💚', color: '#16a34a',
    spells: [
      { key: '1', icon: '🌿', name: 'Odnowa', kind: HD_K_HOT, all: false,
        cost: 90, cast: 0, cd: 0, period: 20, amounts: [55, 55, 55, 55] },
      { key: '2', icon: '🌳', name: 'Dziki Wzrost', kind: HD_K_HOT, all: true,
        cost: 330, cast: 0, cd: 80, period: 15, amounts: [60, 50, 40, 30] },
      { key: '3', icon: '✋', name: 'Uzdrawiający Dotyk', kind: HD_K_DIRECT, all: false,
        cost: 240, cast: 16, cd: 0, amount: 420 },
    ],
  },
  {
    id: 'priest', name: 'Kapłan', icon: '✨', portrait: '🙏', color: '#2563eb',
    spells: [
      { key: '1', icon: '🛡️', name: 'Tarcza Słowa', kind: HD_K_SHIELD, all: false,
        cost: 95, cast: 0, cd: 0, amount: 230, dur: 120 },
      { key: '2', icon: '✨', name: 'Modlitwa Uzdrowienia', kind: HD_K_DIRECT, all: true,
        cost: 320, cast: 0, cd: 80, amount: 175 },
      { key: '3', icon: '🕊️', name: 'Wielkie Leczenie', kind: HD_K_DIRECT, all: false,
        cost: 265, cast: 20, cd: 0, amount: 470 },
    ],
  },
  {
    id: 'paladin', name: 'Paladyn', icon: '🔨', portrait: '⚜️', color: '#d97706',
    spells: [
      { key: '1', icon: '☀️', name: 'Święte Światło', kind: HD_K_DIRECT, all: false,
        cost: 125, cast: 14, cd: 0, amount: 300 },
      { key: '2', icon: '🔔', name: 'Błogosławieństwo', kind: HD_K_DIRECT, all: true,
        cost: 315, cast: 0, cd: 80, amount: 170 },
      { key: '3', icon: '🤲', name: 'Ręka Opatrzności', kind: HD_K_DIRECT, all: false,
        cost: 320, cast: 0, cd: 150, amount: 560 },
    ],
  },
  {
    id: 'shaman', name: 'Szaman', icon: '🌊', portrait: '⚡', color: '#0891b2',
    spells: [
      { key: '1', icon: '🌊', name: 'Przypływ', kind: HD_K_HOT, all: false,
        cost: 90, cast: 0, cd: 0, period: 13, amounts: [37, 37, 36, 36, 36, 36] },
      { key: '2', icon: '💧', name: 'Łańcuch Uzdrowienia', kind: HD_K_DIRECT, all: true,
        cost: 325, cast: 0, cd: 80, amount: 176 },
      { key: '3', icon: '🛡️', name: 'Tarcza Ziemi', kind: HD_K_SHIELD, all: false,
        cost: 300, cast: 0, cd: 100, amount: 525, dur: 130 },
    ],
  },
];

const HD_PK_REGEN = 0, HD_PK_GCD = 1, HD_PK_CHEAP = 2, HD_PK_PHOENIX = 3;
const HD_PK_CDR = 4, HD_PK_WARD = 5, HD_PK_CRIT = 6, HD_PK_FURY = 7;
const HD_PK_FSR = 8, HD_PK_RAID = 9, HD_PK_HASTE = 10, HD_PK_REVIVE = 11;
const HD_PERK_COUNT = 12;
const HD_PK_REGEN_STEP = 10;
const HD_PK_CHEAP_STEP = 7;
const HD_PK_CHEAP_FLOOR = 60;
const HD_PK_CDR_STEP = 15;
const HD_PK_CDR_FLOOR = 30;
const HD_PK_WARD_STEP = 6;
const HD_PK_CRIT_STEP = 10;
const HD_PK_CRIT_MULT = 165;
const HD_PK_FURY_DPS = 25;
const HD_PK_FURY_DMG = 8;
const HD_PK_FSR_STEP = 5;
const HD_PK_RAID_STEP = 18;
const HD_PK_HASTE_STEP = 12;
const HD_PK_HASTE_FLOOR = 50;
const HD_REVIVE_TICKS = 70;
const HD_REVIVE_PCT = 35;
const HD_DMG_TAKEN_FLOOR = 50;

const HD_SCORE_DEPTH_EVERY = 2;
const HD_SCORE_BOSS_MULT = 2;
const HD_SCORE_HEAL_PER_PT = 3000;
const HD_SCORE_FLAWLESS_PTS = 1;
const HD_SCORE_TEMPO_MAX = 2;
const HD_SCORE_TEMPO_SEC = 5;

const HD_PACK_HP_BASE = 1800, HD_PACK_HP_PER_PULL = 470;
const HD_DPS_BASE = 58, HD_DPS_PER_PULL = 15;
const HD_MELEE_PERIOD = 18;
const HD_MELEE_BASE = 77, HD_MELEE_PER_PULL = 19;
const HD_AOE_PERIOD = 80;
const HD_AOE_BASE = 28, HD_AOE_PER_PULL = 17;
const HD_SPIKE_PERIOD = 105;
const HD_SPIKE_BASE = 91, HD_SPIKE_PER_PULL = 36;
const HD_CLEAVE_PERIOD = 70;
const HD_CLEAVE_BASE = 58, HD_CLEAVE_PER_PULL = 22;
const HD_NO_TANK_MELEE_PCT = 135;

const HD_AFFIX2_MIN_PULL = 8;
const HD_AFFIX2_CHANCE_PCT = 30;
const HD_AFFIXES = [
  { id: 'none' },
  { id: 'furious', dmg: 122, hp: 85 },
  { id: 'many', hp: 138 },
  { id: 'swift', meleePeriod: 72, cleavePeriod: 78 },
  { id: 'draining', drain: 55 },
  { id: 'explosive', aoePeriod: 60, aoe: 88 },
  { id: 'brutal', melee: 142 },
  { id: 'frail', hp: 74, dmg: 118 },
  { id: 'focused', spikePeriod: 65, spike: 118 },
];
const HD_AFFIX_DRAIN_PERIOD = 60;

const HD_BOSS_EVERY = 5;
const HD_BOSS_HP_MULT_PCT = 100;
const HD_BOSS_MELEE_PCT = 100;
const HD_BOSS_AOE_PCT = 110;
const HD_BOSS_CAST_FIRST = 55;
const HD_BOSS_CAST_PERIOD = 90;
const HD_BOSS_CAST_TICKS = 35;
const HD_CB_BUSTER = 0, HD_CB_NUKE = 1, HD_CB_FOCUS = 2, HD_CB_DRAIN = 3;
const HD_BOSS_ABILITIES = 4;
const HD_BOSS_KIT_SIZE = 2;
const HD_BOSS_KIT_DEEP_PULL = 20;
const HD_BOSS_KIT_SIZE_DEEP = 3;
const HD_BOSS_BUSTER_BASE = 310, HD_BOSS_BUSTER_PER_PULL = 46;
const HD_BOSS_NUKE_BASE = 115, HD_BOSS_NUKE_PER_PULL = 16;
const HD_BOSS_FOCUS_BASE = 245, HD_BOSS_FOCUS_PER_PULL = 40;
const HD_BOSS_DRAIN_BASE = 70, HD_BOSS_DRAIN_PER_PULL = 12;
const HD_BOSS_DRAIN_MANA = 420;
const HD_BOSS_ENRAGE_TICKS = 280;
const HD_BOSS_ENRAGE_PER_SEC = 4;

const HD_UP_HEAL = 0, HD_UP_HP = 1, HD_UP_DMG = 2;
const HD_UPGRADE_COUNT = 3;
const HD_UPGRADE_CHOICES = 3;
const HD_UP_STEP = [2, 2, 2];
const HD_UK_STAT = 0, HD_UK_PERK = 1;
const HD_TWO_PERK_PCT = 35;

const HD_A_FILL = 0, HD_A_RAID = 1, HD_A_BIG = 2;
const HD_A_PULL = 3, HD_A_UPGRADE = 4;

function hdRng(st) {
  st.rngState = (Math.imul(st.rngState, 1664525) + 1013904223) >>> 0;
  return st.rngState;
}
function hdRnd(st, n) { return hdRng(st) % n; }

function hdJitter(st, base) {
  return Math.max(1, Math.floor(base * (90 + hdRnd(st, 21)) / 100));
}

function hdClass(st) { return HD_CLASSES[st.cls] || HD_CLASSES[0]; }
function hdSpell(st, slot) { return hdClass(st).spells[slot]; }
function hdAffixList(st) {
  const out = [];
  for (let i = 0; i < st.affixes.length; i += 1) out.push(HD_AFFIXES[st.affixes[i]]);
  return out;
}
function hdAff(st, key) {
  let pct = 100;
  const list = hdAffixList(st);
  for (let i = 0; i < list.length; i += 1) {
    const v = list[i][key];
    if (v !== undefined) pct = Math.floor(pct * v / 100);
  }
  return pct;
}
function hdAffixDrain(st) {
  let sum = 0;
  const list = hdAffixList(st);
  for (let i = 0; i < list.length; i += 1) if (list[i].drain) sum += list[i].drain;
  return sum;
}

function hdCost(st, slot) {
  const pct = Math.max(HD_PK_CHEAP_FLOOR, 100 - HD_PK_CHEAP_STEP * st.perks[HD_PK_CHEAP]);
  return Math.max(1, Math.floor(hdSpell(st, slot).cost * pct / 100));
}
function hdHastePct(st) {
  return Math.max(HD_PK_HASTE_FLOOR, 100 - HD_PK_HASTE_STEP * st.perks[HD_PK_HASTE]);
}
function hdCastTicks(st, slot) {
  const base = hdSpell(st, slot).cast;
  if (!base) return 0;
  return Math.max(1, Math.floor(base * hdHastePct(st) / 100));
}
function hdCastSlot(st) {
  for (let i = 0; i < HD_SPELL_SLOTS; i += 1) if (hdSpell(st, i).cast > 0) return i;
  return -1;
}
function hdHasAnyCast(st) {
  return hdCastSlot(st) >= 0;
}
function hdSpellCd(st, slot) {
  const sp = hdSpell(st, slot);
  if (!sp.cd) return 0;
  if (slot === HD_SP_RAID) return Math.max(HD_PK_CDR_FLOOR, sp.cd - HD_PK_CDR_STEP * st.perks[HD_PK_CDR]);
  if (slot === HD_SP_BIG && !hdHasAnyCast(st)) {
    return Math.max(1, Math.floor(sp.cd * hdHastePct(st) / 100));
  }
  return sp.cd;
}
function hdGcdTicks(st) { return Math.max(HD_GCD_MIN, HD_GCD_TICKS - st.perks[HD_PK_GCD]); }
function hdFsrTicks(st) { return Math.max(HD_FSR_MIN, HD_FSR_TICKS - HD_PK_FSR_STEP * st.perks[HD_PK_FSR]); }

function hdMaxMana(st) { return HD_BASE_MANA + HD_MANA_PER_HEAL_PT * st.stats.heal; }
function hdHealAmt(st, base, slot) {
  let pct = 100 + HD_HEAL_PCT_PER_PT * st.stats.heal;
  if (slot === HD_SP_RAID) pct += HD_PK_RAID_STEP * st.perks[HD_PK_RAID];
  return Math.floor(base * pct / 100);
}
function hdHealRoll(st, base, slot) {
  const amt = hdHealAmt(st, base, slot);
  const chance = HD_PK_CRIT_STEP * st.perks[HD_PK_CRIT];
  if (chance > 0 && hdRnd(st, 100) < chance) {
    return { amt: Math.floor(amt * HD_PK_CRIT_MULT / 100), crit: true };
  }
  return { amt: amt, crit: false };
}
function hdRegenPerTick(st) {
  return Math.floor((HD_REGEN_BASE + HD_PK_REGEN_STEP * st.perks[HD_PK_REGEN]) / 10);
}
function hdPartyDps(st) {
  return HD_DPS_BASE + HD_DPS_PER_PULL * st.pull + HD_DPS_PER_PT * st.stats.dmg
    + HD_PK_FURY_DPS * st.perks[HD_PK_FURY];
}
function hdLivingDps(st) {
  let n = 0;
  for (let i = 0; i < HD_PARTY; i += 1) if (i !== HD_HEAL && st.hp[i] > 0) n += 1;
  return n;
}
function hdPartyDpsPerTick(st) {
  return Math.floor(hdPartyDps(st) * hdLivingDps(st) / (HD_PARTY - 1) / 10);
}
function hdMaxHpFor(st, slot) {
  return Math.floor(HD_BASE_HP[slot] * (100 + HD_HP_PCT_PER_PT * st.stats.hp) / 100);
}
function hdIsBoss(pull) { return pull % HD_BOSS_EVERY === 0; }

function hdDmgTakenPct(st) {
  return Math.max(HD_DMG_TAKEN_FLOOR,
    100 - HD_PK_WARD_STEP * st.perks[HD_PK_WARD] + HD_PK_FURY_DMG * st.perks[HD_PK_FURY]);
}

function hdEnragePct(st) {
  if (!st.isBoss) return 100;
  const over = st.fightTick - HD_BOSS_ENRAGE_TICKS;
  if (over <= 0) return 100;
  return 100 + HD_BOSS_ENRAGE_PER_SEC * Math.floor(over / 10);
}
function hdScaleDmg(st, amt, pct) {
  return Math.max(1, Math.floor(
    amt * pct / 100 * hdEnragePct(st) / 100 * hdDmgTakenPct(st) / 100 * hdAff(st, 'dmg') / 100));
}

function hdPickLiving(st, skipTank, skipSlot) {
  const pool = [];
  for (let i = 0; i < HD_PARTY; i += 1) {
    if (st.hp[i] <= 0) continue;
    if (skipTank && i === HD_TANK) continue;
    if (i === skipSlot) continue;
    pool.push(i);
  }
  if (!pool.length) return -1;
  return pool[hdRnd(st, pool.length)];
}
function hdMeleeTarget(st) {
  if (st.hp[HD_TANK] > 0) return HD_TANK;
  return hdPickLiving(st, false, -1);
}

function hdInitState(seed, cls) {
  const st = {
    rngState: (Number(seed) >>> 0) || 1,
    seed: (Number(seed) >>> 0) || 1,
    cls: Math.max(0, Math.min(HD_CLASSES.length - 1, Number(cls) || 0)),
    tick: 0,
    phase: 'fight',
    pull: 1,
    pullsCleared: 0,
    bossesKilled: 0,
    deaths: 0,
    deathPulls: 0,
    pullDeaths: 0,
    hp: [], maxHp: [],
    shield: [], shieldT: [],
    mana: 0,
    fsr: HD_FSR_TICKS,
    gcd: 0,
    cast: null,
    cd: [0, 0, 0],
    hots: [],
    packHp: 0, packMax: 0,
    isBoss: false,
    affixes: [],
    bossKit: [],
    fightTick: 0,
    bossCast: null,
    bossCastT: 0,
    drainT: HD_AFFIX_DRAIN_PERIOD,
    upgrades: [], upgradePicked: false, pickedIdx: -1,
    stats: { heal: 0, hp: 0, dmg: 0 },
    perks: [],
    phoenix: 0,
    reviveCharges: 0,
    revives: [],
    dead: false, deadWho: -1,
    meleeT: HD_MELEE_PERIOD, aoeT: HD_AOE_PERIOD, spikeT: HD_SPIKE_PERIOD, cleaveT: HD_CLEAVE_PERIOD,
    healingDone: 0, manaSpent: 0, overheal: 0, absorbed: 0,
    score: 0, scPull: 0, scHeal: 0, scFlawless: 0, scTempo: 0,
    pullHealed: 0, pullOverheal: 0, pullTempo: HD_SCORE_TEMPO_MAX,
    restTicks: 0,
    fx: [],
  };
  for (let i = 0; i < HD_PERK_COUNT; i += 1) st.perks[i] = 0;
  for (let i = 0; i < HD_PARTY; i += 1) {
    st.maxHp[i] = hdMaxHpFor(st, i);
    st.hp[i] = st.maxHp[i];
    st.shield[i] = 0;
    st.shieldT[i] = 0;
  }
  st.mana = hdMaxMana(st);
  hdStartPull(st);
  return st;
}

function hdStartPull(st) {
  st.phase = 'fight';
  st.isBoss = hdIsBoss(st.pull);
  st.affixes = [];
  if (st.pull !== 1 && !st.isBoss) {
    const first = hdRnd(st, HD_AFFIXES.length);
    st.affixes.push(first);
    if (first !== 0 && st.pull >= HD_AFFIX2_MIN_PULL && hdRnd(st, 100) < HD_AFFIX2_CHANCE_PCT) {
      const pool = [];
      for (let i = 1; i < HD_AFFIXES.length; i += 1) if (i !== first) pool.push(i);
      st.affixes.push(pool[hdRnd(st, pool.length)]);
    }
  }
  const base = Math.floor((HD_PACK_HP_BASE + HD_PACK_HP_PER_PULL * st.pull) * hdAff(st, 'hp') / 100);
  st.packMax = st.isBoss ? Math.floor(base * HD_BOSS_HP_MULT_PCT / 100) : base;
  st.packHp = st.packMax;
  st.meleeT = Math.max(4, Math.floor(HD_MELEE_PERIOD * hdAff(st, 'meleePeriod') / 100));
  st.aoeT = Math.max(10, Math.floor(HD_AOE_PERIOD * hdAff(st, 'aoePeriod') / 100));
  st.spikeT = Math.max(15, Math.floor(HD_SPIKE_PERIOD * hdAff(st, 'spikePeriod') / 100));
  st.cleaveT = Math.max(15, Math.floor(HD_CLEAVE_PERIOD * hdAff(st, 'cleavePeriod') / 100));
  st.drainT = HD_AFFIX_DRAIN_PERIOD;
  st.fightTick = 0;
  st.bossCast = null;
  st.bossCastT = HD_BOSS_CAST_FIRST;
  st.bossKit = [];
  if (st.isBoss) {
    const kitSize = st.pull >= HD_BOSS_KIT_DEEP_PULL ? HD_BOSS_KIT_SIZE_DEEP : HD_BOSS_KIT_SIZE;
    const pool = [];
    for (let i = 0; i < HD_BOSS_ABILITIES; i += 1) pool.push(i);
    for (let i = 0; i < kitSize; i += 1) st.bossKit.push(pool.splice(hdRnd(st, pool.length), 1)[0]);
  }
  st.phoenix = st.perks[HD_PK_PHOENIX];
  st.reviveCharges = st.perks[HD_PK_REVIVE];
  st.revives.length = 0;
  st.pullHealed = 0;
  st.pullOverheal = 0;
  st.pullDeaths = 0;
  st.pullTempo = Math.max(0, HD_SCORE_TEMPO_MAX - Math.floor(st.restTicks / (10 * HD_SCORE_TEMPO_SEC)));
}

function hdBeginRest(st) {
  st.phase = 'rest';
  st.upgradePicked = false;
  st.pickedIdx = -1;
  st.bossCast = null;
  st.cast = null;
  st.hots.length = 0;
  st.revives.length = 0;
  st.gcd = 0;
  st.cd = [0, 0, 0];
  st.fsr = hdFsrTicks(st);
  st.restTicks = 0;
  for (let i = 0; i < HD_PARTY; i += 1) { st.shield[i] = 0; st.shieldT[i] = 0; }
  for (let i = 0; i < HD_PARTY; i += 1) st.hp[i] = st.maxHp[i];
  st.mana = hdMaxMana(st);
  const twoPerks = hdRnd(st, 100) < HD_TWO_PERK_PCT;
  const statPicks = twoPerks ? 1 : 2;
  const perkPicks = HD_UPGRADE_CHOICES - statPicks;
  const statPool = [];
  for (let i = 0; i < HD_UPGRADE_COUNT; i += 1) statPool.push(i);
  const perkPool = [];
  for (let i = 0; i < HD_PERK_COUNT; i += 1) perkPool.push(i);
  st.upgrades = [];
  for (let i = 0; i < statPicks; i += 1) {
    st.upgrades.push({ k: HD_UK_STAT, i: statPool.splice(hdRnd(st, statPool.length), 1)[0] });
  }
  for (let i = 0; i < perkPicks; i += 1) {
    st.upgrades.push({ k: HD_UK_PERK, i: perkPool.splice(hdRnd(st, perkPool.length), 1)[0] });
  }
}

function hdApplyUpgrade(st, up) {
  if (up.k === HD_UK_PERK) {
    st.perks[up.i] += 1;
    if (up.i === HD_PK_PHOENIX) st.phoenix += 1;
    if (up.i === HD_PK_REVIVE) st.reviveCharges += 1;
    st.upgradePicked = true;
    return;
  }
  const step = HD_UP_STEP[up.i];
  if (up.i === HD_UP_HEAL) {
    st.stats.heal += step;
  } else if (up.i === HD_UP_HP) {
    st.stats.hp += step;
    for (let i = 0; i < HD_PARTY; i += 1) {
      const before = st.maxHp[i];
      st.maxHp[i] = hdMaxHpFor(st, i);
      if (st.hp[i] > 0) st.hp[i] += st.maxHp[i] - before;
    }
  } else {
    st.stats.dmg += step;
  }
  st.upgradePicked = true;
}

function hdDamage(st, slot, amount, src) {
  if (st.dead || slot < 0 || st.hp[slot] <= 0) return;
  let amt = amount;
  if (st.shield[slot] > 0) {
    const abs = Math.min(st.shield[slot], amt);
    st.shield[slot] -= abs;
    amt -= abs;
    st.absorbed += abs;
    st.healingDone += abs;
    st.pullHealed += abs;
    st.fx.push({ k: 'absorb', slot: slot, amt: abs });
    if (st.shield[slot] <= 0) { st.shield[slot] = 0; st.shieldT[slot] = 0; }
    if (amt <= 0) return;
  }
  st.hp[slot] -= amt;
  st.fx.push({ k: 'dmg', slot: slot, amt: amt, src: src });
  if (st.hp[slot] > 0) return;

  if (st.phoenix > 0) {
    st.phoenix -= 1;
    st.hp[slot] = 1;
    st.fx.push({ k: 'phoenix', slot: slot });
    return;
  }
  st.hp[slot] = 0;
  st.deaths += 1;
  st.pullDeaths += 1;
  st.fx.push({ k: 'death', slot: slot });
  for (let i = st.hots.length - 1; i >= 0; i -= 1) if (st.hots[i].tgt === slot) st.hots.splice(i, 1);
  st.shield[slot] = 0; st.shieldT[slot] = 0;
  if (st.cast && st.cast.target === slot) st.cast = null;

  if (slot === HD_HEAL) {
    st.dead = true;
    st.deadWho = slot;
    st.phase = 'dead';
    return;
  }
  if (st.reviveCharges > 0) {
    st.reviveCharges -= 1;
    st.revives.push({ slot: slot, left: HD_REVIVE_TICKS });
  }
}

function hdHeal(st, slot, amount, slotSpell, crit) {
  if (st.hp[slot] <= 0) return;
  const room = st.maxHp[slot] - st.hp[slot];
  const applied = Math.min(room, amount);
  st.hp[slot] += applied;
  st.healingDone += applied;
  st.pullHealed += applied;
  st.overheal += amount - applied;
  st.pullOverheal += amount - applied;
  if (applied > 0) st.fx.push({ k: 'heal', slot: slot, amt: applied, spell: slotSpell, crit: !!crit });
}

function hdAddShield(st, slot, amount, dur, crit) {
  if (st.hp[slot] <= 0) return;
  if (st.shield[slot] > 0) {
    st.overheal += st.shield[slot];
    st.pullOverheal += st.shield[slot];
  }
  st.shield[slot] = amount;
  st.shieldT[slot] = dur;
  st.fx.push({ k: 'shield', slot: slot, amt: amount, crit: !!crit });
}

function hdSpend(st, cost) {
  st.mana -= cost;
  if (st.mana < 0) st.mana = 0;
  st.manaSpent += cost;
  st.fsr = 0;
}
function hdBurnMana(st, amount) {
  const lost = Math.min(st.mana, amount);
  st.mana -= lost;
  if (lost > 0) st.fx.push({ k: 'drain', amt: lost });
}

function hdAddHot(st, tgt, slot) {
  if (st.hp[tgt] <= 0) return;
  for (let i = st.hots.length - 1; i >= 0; i -= 1) {
    if (st.hots[i].tgt === tgt && st.hots[i].slot === slot) st.hots.splice(i, 1);
  }
  const sp = hdSpell(st, slot);
  st.hots.push({ tgt: tgt, slot: slot, left: sp.amounts.length, next: sp.period, idx: 0 });
}

function hdIncomingHeal(st, slot) {
  let sum = 0;
  if (st.cast) {
    const sp = hdSpell(st, st.cast.slot);
    if (sp.kind === HD_K_DIRECT && (sp.all || st.cast.target === slot)) {
      sum += hdHealAmt(st, sp.amount, st.cast.slot);
    }
  }
  for (let i = 0; i < st.hots.length; i += 1) {
    const h = st.hots[i];
    if (h.tgt !== slot) continue;
    const table = hdSpell(st, h.slot).amounts;
    for (let j = h.idx; j < table.length; j += 1) sum += hdHealAmt(st, table[j], h.slot);
  }
  return sum;
}

function hdBossAbilityRaw(st, kind) {
  if (kind === HD_CB_BUSTER) return HD_BOSS_BUSTER_BASE + HD_BOSS_BUSTER_PER_PULL * st.pull;
  if (kind === HD_CB_NUKE) return HD_BOSS_NUKE_BASE + HD_BOSS_NUKE_PER_PULL * st.pull;
  if (kind === HD_CB_FOCUS) return HD_BOSS_FOCUS_BASE + HD_BOSS_FOCUS_PER_PULL * st.pull;
  return HD_BOSS_DRAIN_BASE + HD_BOSS_DRAIN_PER_PULL * st.pull;
}
function hdBossPending(st) {
  if (!st.bossCast) return null;
  return {
    kind: st.bossCast.kind,
    tgt: st.bossCast.tgt,
    amt: hdScaleDmg(st, hdBossAbilityRaw(st, st.bossCast.kind), 100),
    left: st.bossCast.left,
    total: st.bossCast.total,
  };
}
function hdIncomingDamage(st, slot) {
  const p = hdBossPending(st);
  if (!p) return 0;
  if (p.tgt >= 0) return p.tgt === slot ? p.amt : 0;
  return p.amt;
}
function hdSurvives(st, slot) {
  const dmg = hdIncomingDamage(st, slot);
  if (dmg <= 0) return true;
  return st.hp[slot] + hdIncomingHeal(st, slot) + st.shield[slot] > dmg;
}

function hdCanCast(st, slot) {
  if (st.dead || st.cast) return false;
  if (st.gcd > 0) return false;
  if (st.cd[slot] > 0) return false;
  if (st.mana < hdCost(st, slot)) return false;
  return true;
}

function hdResolveSpell(st, slot, target) {
  const sp = hdSpell(st, slot);
  const from = sp.all ? 0 : target;
  const to = sp.all ? HD_PARTY - 1 : target;
  for (let i = from; i <= to; i += 1) {
    if (st.hp[i] <= 0) continue;
    if (sp.kind === HD_K_HOT) {
      hdAddHot(st, i, slot);
    } else if (sp.kind === HD_K_SHIELD) {
      const r = hdHealRoll(st, sp.amount, slot);
      hdAddShield(st, i, r.amt, sp.dur, r.crit);
    } else {
      const r = hdHealRoll(st, sp.amount, slot);
      hdHeal(st, i, r.amt, slot, r.crit);
    }
  }
}

function hdCast(st, slot, target) {
  if (!hdCanCast(st, slot)) return false;
  let tgt = target >= 0 && target < HD_PARTY ? target : HD_TANK;
  const sp = hdSpell(st, slot);
  if (!sp.all && st.hp[tgt] <= 0) return false;
  hdSpend(st, hdCost(st, slot));
  st.gcd = hdGcdTicks(st);
  if (sp.cd) st.cd[slot] = hdSpellCd(st, slot);
  const cast = hdCastTicks(st, slot);
  if (cast > 0) {
    st.cast = { slot: slot, target: tgt, left: cast, total: cast };
    return true;
  }
  hdResolveSpell(st, slot, tgt);
  return true;
}

function hdApplyAction(st, a, t) {
  if (st.dead) return;
  if (a === HD_A_FILL || a === HD_A_RAID || a === HD_A_BIG) hdCast(st, a, t);
  else if (a === HD_A_PULL) { if (st.phase === 'rest' && st.upgradePicked) hdNextPull(st); }
  else if (a === HD_A_UPGRADE) {
    if (st.phase === 'rest' && !st.upgradePicked && t >= 0 && t < st.upgrades.length) {
      st.pickedIdx = t;
      hdApplyUpgrade(st, st.upgrades[t]);
    }
  }
}

function hdNextPull(st) {
  st.pull += 1;
  hdStartPull(st);
}

function hdTickHots(st) {
  for (let i = st.hots.length - 1; i >= 0; i -= 1) {
    const h = st.hots[i];
    h.next -= 1;
    if (h.next > 0) continue;
    const sp = hdSpell(st, h.slot);
    const r = hdHealRoll(st, sp.amounts[h.idx], h.slot);
    hdHeal(st, h.tgt, r.amt, h.slot, r.crit);
    h.idx += 1;
    h.left -= 1;
    h.next = sp.period;
    if (h.left <= 0) st.hots.splice(i, 1);
  }
}

function hdTickShields(st) {
  for (let i = 0; i < HD_PARTY; i += 1) {
    if (st.shieldT[i] <= 0) continue;
    st.shieldT[i] -= 1;
    if (st.shieldT[i] > 0) continue;
    st.overheal += st.shield[i];
    st.pullOverheal += st.shield[i];
    st.shield[i] = 0;
  }
}

function hdTickRevives(st) {
  for (let i = st.revives.length - 1; i >= 0; i -= 1) {
    const r = st.revives[i];
    r.left -= 1;
    if (r.left > 0) continue;
    st.revives.splice(i, 1);
    if (st.hp[r.slot] > 0) continue;
    st.hp[r.slot] = Math.max(1, Math.floor(st.maxHp[r.slot] * HD_REVIVE_PCT / 100));
    st.fx.push({ k: 'revive', slot: r.slot });
  }
}

function hdBankPull(st) {
  const depth = (1 + Math.floor((st.pull - 1) / HD_SCORE_DEPTH_EVERY))
    * (st.isBoss ? HD_SCORE_BOSS_MULT : 1);
  const total = st.pullHealed + st.pullOverheal;
  const precision = total > 0 ? Math.floor(st.pullHealed * 100 / total) : 100;
  const healPts = Math.floor(Math.floor(st.pullHealed / HD_SCORE_HEAL_PER_PT) * precision / 100);
  const flawless = st.pullDeaths === 0 ? HD_SCORE_FLAWLESS_PTS : 0;
  if (st.pullDeaths > 0) st.deathPulls += 1;
  st.scPull += depth;
  st.scHeal += healPts;
  st.scFlawless += flawless;
  st.scTempo += st.pullTempo;
  st.score = st.scPull + st.scHeal + st.scFlawless + st.scTempo;
  st.fx.push({ k: 'clear', depth: depth, heal: healPts, flawless: flawless, tempo: st.pullTempo, precision: precision });
}

function hdAdvanceTick(st, actions) {
  if (st.dead) return;
  st.tick += 1;
  st.fx.length = 0;

  if (actions) for (let i = 0; i < actions.length; i += 1) hdApplyAction(st, actions[i].a, actions[i].t);
  if (st.dead) return;

  if (st.gcd > 0) st.gcd -= 1;
  for (let i = 0; i < HD_SPELL_SLOTS; i += 1) if (st.cd[i] > 0) st.cd[i] -= 1;
  const maxMana = hdMaxMana(st);
  const fsrMax = hdFsrTicks(st);
  if (st.fsr >= fsrMax) {
    st.mana = Math.min(maxMana, st.mana + hdRegenPerTick(st));
  }
  if (st.fsr < fsrMax) st.fsr += 1;

  if (st.cast) {
    st.cast.left -= 1;
    if (st.cast.left <= 0) {
      const c = st.cast;
      st.cast = null;
      hdResolveSpell(st, c.slot, c.target);
    }
  }

  hdTickHots(st);
  hdTickShields(st);
  if (st.dead) return;

  if (st.phase === 'rest') { st.restTicks += 1; return; }

  hdTickRevives(st);

  st.fightTick += 1;
  st.packHp -= hdPartyDpsPerTick(st);
  if (st.packHp <= 0) {
    st.packHp = 0;
    st.pullsCleared += 1;
    if (st.isBoss) st.bossesKilled += 1;
    hdBankPull(st);
    hdBeginRest(st);
    return;
  }

  const tankUp = st.hp[HD_TANK] > 0;
  const meleePct = Math.floor((st.isBoss ? HD_BOSS_MELEE_PCT : 100)
    * hdAff(st, 'melee') / 100 * (tankUp ? 100 : HD_NO_TANK_MELEE_PCT) / 100);
  const aoePct = Math.floor((st.isBoss ? HD_BOSS_AOE_PCT : 100) * hdAff(st, 'aoe') / 100);

  if (st.isBoss) {
    if (st.bossCast) {
      st.bossCast.left -= 1;
      if (st.bossCast.left <= 0) {
        const kind = st.bossCast.kind;
        const tgt = st.bossCast.tgt;
        st.bossCast = null;
        st.bossCastT = HD_BOSS_CAST_PERIOD;
        const raw = hdBossAbilityRaw(st, kind);
        if (kind === HD_CB_DRAIN) hdBurnMana(st, HD_BOSS_DRAIN_MANA);
        if (tgt >= 0) {
          hdDamage(st, tgt, hdScaleDmg(st, hdJitter(st, raw), 100), kind === HD_CB_BUSTER ? 'buster' : 'focus');
        } else {
          const dmg = hdScaleDmg(st, hdJitter(st, raw), 100);
          for (let i = 0; i < HD_PARTY; i += 1) {
            hdDamage(st, i, dmg, kind === HD_CB_DRAIN ? 'drain' : 'nuke');
            if (st.dead) return;
          }
        }
        if (st.dead) return;
      }
    } else {
      st.bossCastT -= 1;
      if (st.bossCastT <= 0) {
        const kind = st.bossKit.length ? st.bossKit[hdRnd(st, st.bossKit.length)] : HD_CB_BUSTER;
        let tgt = -1;
        if (kind === HD_CB_BUSTER) tgt = hdMeleeTarget(st);
        else if (kind === HD_CB_FOCUS) tgt = hdPickLiving(st, true, -1);
        if ((kind === HD_CB_BUSTER || kind === HD_CB_FOCUS) && tgt < 0) tgt = HD_HEAL;
        st.bossCast = { kind: kind, tgt: tgt, left: HD_BOSS_CAST_TICKS, total: HD_BOSS_CAST_TICKS };
        st.fx.push({ k: 'cast', kind: kind, tgt: tgt });
      }
    }
  }

  const drainAmt = hdAffixDrain(st);
  if (drainAmt > 0) {
    st.drainT -= 1;
    if (st.drainT <= 0) {
      st.drainT = HD_AFFIX_DRAIN_PERIOD;
      hdBurnMana(st, drainAmt);
    }
  }

  st.meleeT -= 1;
  if (st.meleeT <= 0) {
    st.meleeT = Math.max(4, Math.floor(HD_MELEE_PERIOD * hdAff(st, 'meleePeriod') / 100));
    hdDamage(st, hdMeleeTarget(st),
      hdScaleDmg(st, hdJitter(st, HD_MELEE_BASE + HD_MELEE_PER_PULL * st.pull), meleePct), 'melee');
    if (st.dead) return;
  }

  st.aoeT -= 1;
  if (st.aoeT <= 0) {
    st.aoeT = Math.max(10, Math.floor(HD_AOE_PERIOD * hdAff(st, 'aoePeriod') / 100));
    const base = HD_AOE_BASE + HD_AOE_PER_PULL * st.pull;
    for (let i = 0; i < HD_PARTY; i += 1) {
      hdDamage(st, i, hdScaleDmg(st, hdJitter(st, base), aoePct), 'aoe');
      if (st.dead) return;
    }
  }

  st.spikeT -= 1;
  if (st.spikeT <= 0) {
    st.spikeT = Math.max(15, Math.floor(HD_SPIKE_PERIOD * hdAff(st, 'spikePeriod') / 100));
    const tgt = hdPickLiving(st, true, -1);
    hdDamage(st, tgt, hdScaleDmg(st, hdJitter(st, HD_SPIKE_BASE + HD_SPIKE_PER_PULL * st.pull),
      hdAff(st, 'spike')), 'spike');
    if (st.dead) return;
  }

  st.cleaveT -= 1;
  if (st.cleaveT <= 0) {
    st.cleaveT = Math.max(15, Math.floor(HD_CLEAVE_PERIOD * hdAff(st, 'cleavePeriod') / 100));
    const base = HD_CLEAVE_BASE + HD_CLEAVE_PER_PULL * st.pull;
    const a = hdPickLiving(st, false, -1);
    const b = hdPickLiving(st, false, a);
    hdDamage(st, a, hdScaleDmg(st, hdJitter(st, base), 100), 'cleave');
    if (st.dead) return;
    hdDamage(st, b, hdScaleDmg(st, hdJitter(st, base), 100), 'cleave');
  }
}
// ╚═══ PARITY BLOCK END ══════════════════════════════════════════════════════╝

// hdReplay is deliberately OUTSIDE the parity block: it drives the sim from a
// server-trusted seed+class+event log, mirroring ttReplay in tetris-action.
function hdReplay(seed, cls, events, untilTick) {
  const st = hdInitState(seed, cls);
  const capped = Math.max(0, Math.min(HD_MAX_TICKS, untilTick));
  let ei = 0;
  let diedAtTick = null;
  while (st.tick < capped) {
    const nextTick = st.tick + 1;
    const acts = [];
    while (ei < events.length && events[ei].tick === nextTick) { acts.push({ a: events[ei].a, t: events[ei].t }); ei += 1; }
    hdAdvanceTick(st, acts);
    if (st.dead) { diedAtTick = st.tick; break; }
  }
  return {
    score: Math.max(0, Math.min(HD_MAX_SCORE, st.score)),
    scPull: st.scPull, scHeal: st.scHeal, scFlawless: st.scFlawless, scTempo: st.scTempo,
    pullsCleared: st.pullsCleared,
    bossesKilled: st.bossesKilled,
    deaths: st.deaths,
    deathPulls: st.deathPulls,
    healingDone: st.healingDone,
    overheal: st.overheal,
    manaSpent: st.manaSpent,
    endTick: diedAtTick ?? capped,
    died: diedAtTick != null,
    // A healer dungeon run has no "completed" state the way a bounded round
    // does — it only ends on death or the replay-cost safety cap.
    completed: diedAtTick == null && capped >= HD_MAX_TICKS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const ROUND_EXPIRES_SECONDS = 2400; // 40 min — generous over the 20 min HD_MAX_TICKS cap
const PRIZES = [1000, 500, 200];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function gameError(message) {
  const err = new Error(message);
  err.isGame = true;
  return err;
}

function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Action codes are 0-4 (HD_A_FILL..HD_A_UPGRADE); the `t` payload is always a
// small non-negative index (a party slot 0-4, or an upgrade-card index 0-2) —
// hdApplyAction itself bounds-checks upgrade indices against the live
// st.upgrades length, so this is a coarse sanity gate, not the real check.
function parseEvents(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu akcji rundy.");
  if (value.length > HD_MAX_EVENTS) throw gameError("Za dużo akcji w rundzie.");
  let previousTick = 0;
  return value.map((entry) => {
    const tick = asInt(entry?.tick, NaN);
    const a = asInt(entry?.a, NaN);
    const t = asInt(entry?.t, NaN);
    if (!Number.isFinite(tick) || tick < 1 || tick > HD_MAX_TICKS) throw gameError("Nieprawidłowa akcja.");
    if (!Number.isFinite(a) || a < HD_A_FILL || a > HD_A_UPGRADE) throw gameError("Nieznana akcja.");
    if (!Number.isFinite(t) || t < 0 || t > HD_PARTY - 1) throw gameError("Nieprawidłowy cel akcji.");
    if (tick < previousTick) throw gameError("Akcje nie są uporządkowane.");
    previousTick = tick;
    return { tick, a, t };
  });
}

async function requireUser(req) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) throw gameError("Musisz być zalogowany.");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) throw new Error("Missing Supabase environment.");

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) throw gameError("Sesja wygasła. Zaloguj się ponownie.");
  return data.user;
}

function mapRows(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    cls: asInt(row.cls),
    pulls_cleared: asInt(row.pulls_cleared),
    bosses_killed: asInt(row.bosses_killed),
    deaths: asInt(row.deaths),
    healing_done: asInt(row.healing_done),
    moves: asInt(row.moves),
    duration_ms: asInt(row.duration_ms),
    rounds_played: asInt(row.rounds_played),
    accuracy: asNumber(row.accuracy),
  }));
}

function mapAwards(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    cls: asInt(row.cls),
    duration_ms: asInt(row.duration_ms),
    prize_coins: asInt(row.prize_coins),
  }));
}

async function loadState(userId) {
  if (!db) throw new Error("Database is not configured.");

  const [profile] = await db`
    select id, nick, coins
    from public.profiles
    where id = ${userId}
  `;
  if (!profile) throw gameError("Profil nie istnieje.");

  const [weekRow] = await db`select public.healer_dungeon_week_start(now()) as week_start`;
  const weekly = await db`
    select *
    from public.healer_dungeon_current_week
    order by rank
    limit 20
  `;
  const allTime = await db`
    select *
    from public.healer_dungeon_all_time
    order by rank
    limit 20
  `;
  const awards = await db`
    select *
    from public.healer_dungeon_recent_awards
    order by week_start desc, rank asc
    limit 12
  `;
  const [myWeekly] = await db`
    select *
    from public.healer_dungeon_current_week
    where user_id = ${userId}
  `;
  const [myAllTime] = await db`
    select *
    from public.healer_dungeon_all_time
    where user_id = ${userId}
  `;

  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    weekStart: weekRow?.week_start,
    tickMs: HD_TICK_MS,
    prizes: PRIZES,
    weekly: mapRows(weekly),
    allTime: mapRows(allTime),
    awards: mapAwards(awards),
    myWeekly: myWeekly ? mapRows([myWeekly])[0] : null,
    myAllTime: myAllTime ? mapRows([myAllTime])[0] : null,
  };
}

async function startRound(userId, body) {
  if (!db) throw new Error("Database is not configured.");

  const [profile] = await db`
    select id, nick, coins
    from public.profiles
    where id = ${userId}
  `;
  if (!profile) throw gameError("Profil nie istnieje.");

  const cls = asInt(body?.cls, 0);
  if (cls < 0 || cls >= HD_CLASSES.length) throw gameError("Nieprawidłowa klasa.");

  const seed = Math.floor(Math.random() * 2147483647) + 1;
  const [round] = await db`
    insert into public.healer_dungeon_rounds
      (user_id, nick_snapshot, seed, cls, expires_at)
    values
      (${userId}, ${profile.nick}, ${seed}, ${cls}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
    returning id, seed, cls, started_at, expires_at
  `;

  return {
    ...(await loadState(userId)),
    round: {
      id: round.id,
      seed: asInt(round.seed),
      cls: asInt(round.cls),
      tickMs: HD_TICK_MS,
      startedAt: round.started_at,
      serverNow: new Date().toISOString(),
      expiresAt: round.expires_at,
    },
  };
}

async function submitRound(userId, body) {
  if (!db) throw new Error("Database is not configured.");
  const roundId = String(body.roundId ?? "");
  if (!roundId) throw gameError("Brak rundy do zapisania.");
  const events = parseEvents(body.events);
  const requestedTick = asInt(body.elapsedTicks, 0);
  if (requestedTick < 1 || requestedTick > HD_MAX_TICKS) throw gameError("Nieprawidłowy koniec rundy.");

  // No hero-item score_bonus integration: unlike the raw-count seasonal games,
  // Uzdrowiciel's score is four weighted components (depth/healing/flawless/
  // tempo) that a flat "+N points" bonus does not map onto cleanly — a future
  // pass could add a dedicated effect_game, but none exists yet.

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.healer_dungeon_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");

    const actualElapsed = Date.now() - new Date(round.started_at).getTime();
    const actualTickCap = Math.floor((actualElapsed + 1500) / HD_TICK_MS);
    const endTick = requestedTick;
    if (events.some((entry) => entry.tick > endTick)) throw gameError("Akcja po końcu rundy.");
    if (endTick > actualTickCap) throw gameError("Runda jeszcze trwa.");

    const replay = hdReplay(asInt(round.seed), asInt(round.cls), events, endTick);
    if (replay.endTick !== endTick) throw gameError("Runda zakończyła się wcześniej.");
    // A healer dungeon run only ever ends on death or the safety-cap tick —
    // there is no other "clean" end state — so accept either, exactly what
    // hdReplay's died/completed pair already distinguishes.
    if (!replay.died && !replay.completed) throw gameError("Runda jeszcze trwa.");

    const scoreValue = replay.score;
    const heals = replay.healingDone + replay.overheal;
    const precision = heals > 0 ? Math.round((replay.healingDone / heals) * 10000) / 100 : 0;

    await tx`
      update public.healer_dungeon_rounds
         set submitted_at = now()
       where id = ${round.id}
    `;

    const [inserted] = await tx`
      insert into public.healer_dungeon_scores
        (round_id, user_id, nick_snapshot, week_start, score, cls, pulls_cleared, bosses_killed,
         deaths, healing_done, moves, duration_ms, accuracy, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.healer_dungeon_week_start(now()),
          ${scoreValue},
          ${asInt(round.cls)},
          ${replay.pullsCleared},
          ${replay.bossesKilled},
          ${replay.deaths},
          ${replay.healingDone},
          ${events.length},
          ${replay.endTick * HD_TICK_MS},
          ${precision},
          ${JSON.stringify({
            seed: asInt(round.seed),
            tick_ms: HD_TICK_MS,
            elapsed_ticks: replay.endTick,
            client_score: asInt(body.score, 0),
            server_validated: true,
            died: replay.died,
            completed: replay.completed,
            sc_pull: replay.scPull,
            sc_heal: replay.scHeal,
            sc_flawless: replay.scFlawless,
            sc_tempo: replay.scTempo,
            death_pulls: replay.deathPulls,
            overheal: replay.overheal,
            mana_spent: replay.manaSpent,
          })}::jsonb
        )
      returning *
    `;

    return { inserted, replay };
  });

  return {
    ...(await loadState(userId)),
    score: {
      id: score.inserted.id,
      score: asInt(score.inserted.score),
      cls: asInt(score.inserted.cls),
      pulls_cleared: asInt(score.inserted.pulls_cleared),
      bosses_killed: asInt(score.inserted.bosses_killed),
      deaths: asInt(score.inserted.deaths),
      died: score.replay.died,
      completed: score.replay.completed,
      submitted_at: score.inserted.submitted_at,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "state");

    let result;
    if (action === "state") result = await loadState(user.id);
    else if (action === "start") result = await startRound(user.id, body);
    else if (action === "submit") result = await submitRound(user.id, body);
    else throw gameError("Nieznana akcja.");

    return json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
