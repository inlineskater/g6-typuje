// ── „Uzdrowiciel G6" (healer_dungeon) — WoW Classic resto-druid dungeon ──────
//
// You are the healer. A FIVE-man party (tank / you / three dps) walks an endless
// dungeon; every pull is harder than the last, EVERY FIFTH PULL IS A BOSS, and
// the run ends the moment anyone hits 0 HP. Score = pulls cleared.
//
// The whole game is CLASSIC MANA MANAGEMENT — there is deliberately no dungeon
// timer. The pressure comes from the rest window between pulls SHRINKING with
// depth (hdRestTicks): pull 1 gives 13 s to sit and drink, pull 15+ gives 4.5 s.
// So you enter late pulls progressively more drained while the damage climbs,
// and whether you survive was decided by how efficiently you healed ten pulls
// ago. Three mechanics feed that, all straight out of Classic:
//   • 5-second rule — spirit regen is ZERO for 5 s after any mana spend.
//   • spell efficiency — Odnowa 2.44 HP/mana vs Uzdrawiający Dotyk 1.75.
//   • drinking is slow, and casting stands you up.
//
// BOSSES (every 5th pull) are the one place the game telegraphs instead of
// grinding: the boss spends 3.5 s casting a named ability with a visible bar,
// and you either pre-heal through it or bury someone. That is precisely what
// the heal-prediction overlay on the raid frames is for — the two features are
// designed as one. A boss that lives too long ENRAGES, ramping all its damage
// 5% per second, so a party with no Siła investment eventually cannot out-heal
// its own slow kill.
//
// PHASE 1 (arcade only). There is no Edge Function and no seasonal table yet:
// the seed is generated client-side and the score goes through the shared
// recordArcadeScore() path. The simulation below is nevertheless written as a
// self-contained deterministic integer sim on a fixed tick, and the runtime
// logs { tick, a, t } events it never replays — so promoting this to a full
// seasonal game later is a transcription of the block between the two PARITY
// markers into supabase/functions/healer-dungeon-action, not a rewrite.

// ╔═══ PARITY BLOCK START — keep byte-identical with the future Edge Function ═╗
const HD_TICK_MS = 100;
const HD_MAX_TICKS = 12000;      // 20 min — replay-cost safety cap, NOT a game timer
const HD_MAX_EVENTS = 6000;
const HD_MAX_SCORE = 100;        // mirrors the arcade.sql score cap

// Party slots. Five, not three: three health bars is a party, five is a raid
// frame — and it makes the AoE pulse hit five targets, which is what turns
// Dziki Wzrost from a nice-to-have into the spell the run is built around.
const HD_PARTY = 5;
const HD_TANK = 0, HD_HEAL = 1;
const HD_BASE_HP = [1500, 820, 900, 860, 780];

// Your resources. Every stat starts at 0 and only upgrades move it, so the
// opening pull is always identical — the "generic, overall the same" ask.
const HD_BASE_MANA = 1200;
const HD_MANA_PER_INT = 30;
const HD_HEAL_PCT_PER_INT = 4;   // +4% healing per point of Intelekt
const HD_REGEN_BASE = 40;        // mana per SECOND outside the 5 s window
const HD_REGEN_PER_SPIRIT = 4;
const HD_FSR_TICKS = 50;         // the 5-second rule, in ticks
const HD_DRINK_PER_SEC = 120;    // ~10 s to fill an opening mana pool
// Out-of-combat health regen, per mille of max HP per SECOND. Deliberately
// small: at the first pass (3%/s) a 13.5 s rest healed ~675 HP against a pull
// that only dealt ~300, so the party survived four pulls with NO healing at all
// and the healer was decorative. At 3‰/s a rest gives back a fraction, which is
// what forces the real decision — top the party up, or sit and drink?
const HD_OOC_REGEN_PERMIL = 3;

// Spells. The HP-per-mana spread is the whole skill test: Odnowa is the
// efficient filler, Dziki Wzrost answers the AoE pulse, Uzdrawiający Dotyk is
// the panic button you cannot afford to lean on.
const HD_SP_REJUV = 0, HD_SP_WG = 1, HD_SP_HT = 2;
const HD_GCD_TICKS = 15;         // 1.5 s
const HD_COST = [90, 330, 240];
const HD_HT_CAST_TICKS = 25;     // 2.5 s
const HD_HT_HEAL = 420;
const HD_REJUV_PERIOD = 30;      // a tick every 3 s
const HD_REJUV_AMOUNTS = [55, 55, 55, 55];
const HD_WG_PERIOD = 20;         // a tick every 2 s
const HD_WG_AMOUNTS = [60, 50, 40, 30];   // decaying, like the real spell
const HD_WG_CD_TICKS = 80;       // 8 s

// Encounter script for pull n. Fixed shape; only the damage jitter, the spike
// target and the boss's choice of ability roll off the RNG.
// Party damage scales with the pull alongside pack HP, which holds fight length
// at a near-constant ~10 s all the way down. Difficulty must come from incoming
// damage vs your mana, not from fights that grind on for half a minute — the
// first tuning pass had pull 10 taking 35 s and a whole run over ten minutes.
const HD_PACK_HP_BASE = 900, HD_PACK_HP_PER_PULL = 240;
const HD_DPS_BASE = 90, HD_DPS_PER_PULL = 22, HD_DPS_PER_STR = 8;   // per second
// Incoming damage has to make healing mandatory from the very first pull, and
// the 5-man tuning pass pushed it up again: five bars to keep alive is only
// harder if the pulse actually threatens the squishy ones.
// The per-pull SLOPES matter more than the bases: with a shallow slope the bot
// cruised every normal pull and died only ever on a boss, so every score in the
// field was 4, 9 or 14 and the leaderboard was three buckets. A steeper ramp
// makes late normal pulls lethal in their own right, which is what puts scores
// in between the bosses again.
const HD_MELEE_PERIOD = 15;      // tank auto-attack every 1.5 s
const HD_MELEE_BASE = 56, HD_MELEE_PER_PULL = 10;
const HD_AOE_PERIOD = 65;        // raid pulse every 6.5 s, now on all five
const HD_AOE_BASE = 27, HD_AOE_PER_PULL = 9;
const HD_SPIKE_PERIOD = 85;      // spike on a random non-tank every 8.5 s
const HD_SPIKE_BASE = 90, HD_SPIKE_PER_PULL = 19;
// ~13 s to sit and drink at pull 1, down to 4.5 s past pull 14. This shrinking
// window IS the difficulty curve — no dungeon timer needed.
const HD_REST_BASE = 130, HD_REST_PER_PULL = 6, HD_REST_MIN = 45;

// ── Bosses: every fifth pull ────────────────────────────────────────────────
// A boss is not "a pack with more HP". It is the only encounter that tells you
// what is coming and when, which is the one thing that makes pre-healing — and
// therefore the heal-prediction overlay — a real decision instead of a readout.
const HD_BOSS_EVERY = 5;
const HD_BOSS_HP_MULT_PCT = 225;   // ~23 s fight instead of ~10 s
// Kept modest on purpose. A boss fight is ~2.3× as LONG as a normal pull, so a
// multiplier on its auto-attack is paid ~2.3× over; at 130% the very first boss
// (pull 5, when you have had four upgrades) killed half the field, which is one
// boss too early for an 8-pull target. The scary part of a boss is meant to be
// the telegraphed cast you can answer, not the autoattack you cannot.
const HD_BOSS_MELEE_PCT = 116;
const HD_BOSS_AOE_PCT = 120;
const HD_BOSS_CAST_FIRST = 55;     // first telegraph 5.5 s in
const HD_BOSS_CAST_PERIOD = 90;    // then one every 9 s
const HD_BOSS_CAST_TICKS = 35;     // 3.5 s of warning — two GCDs to react
const HD_CB_BUSTER = 0, HD_CB_NUKE = 1;
// The buster's PER-PULL slope is deliberately shallower than its base is big:
// a steep slope turned every boss into a pass/fail HP check (the whole field
// died on pull 5 or pull 10 and nowhere else), while a fat flat hit stays scary
// at every depth without becoming a wall you either clear or do not.
const HD_BOSS_BUSTER_BASE = 285, HD_BOSS_BUSTER_PER_PULL = 44;   // tank only
const HD_BOSS_NUKE_BASE = 105, HD_BOSS_NUKE_PER_PULL = 15;       // whole party
// Kill it or it kills you: past this the boss gains damage every second. Set
// just INSIDE a clean ~25 s kill, so a party that skipped Siła feels it.
const HD_BOSS_ENRAGE_TICKS = 230;  // 23 s
const HD_BOSS_ENRAGE_PER_SEC = 5;  // +5 percentage points of damage per second
const HD_BOSS_REST_BONUS = 45;     // a boss buys you 4.5 s of extra drinking

// Upgrades — 2 of these 5 are offered after every pull. Two, not three: a
// three-card hand nearly always contains the obvious pick, so the choice was
// free. Two forces a genuine trade-off.
const HD_UP_INT = 0, HD_UP_SPIRIT = 1, HD_UP_STAM = 2, HD_UP_STR = 3, HD_UP_HASTE = 4;
const HD_UPGRADE_COUNT = 5;
const HD_UPGRADE_CHOICES = 2;
const HD_UP_STEP = [3, 3, 3, 3, 2];

// Actions the runtime logs.
const HD_A_REJUV = 0, HD_A_WG = 1, HD_A_HT = 2;
const HD_A_DRINK = 3, HD_A_PULL = 4, HD_A_UPGRADE = 5;

function hdRng(st) {
  st.rngState = (Math.imul(st.rngState, 1664525) + 1013904223) >>> 0;
  return st.rngState;
}
function hdRnd(st, n) { return hdRng(st) % n; }

// ±10% on every damage event — enough that no two runs are identical, small
// enough that the encounter still reads as scripted.
function hdJitter(st, base) {
  return Math.max(1, Math.floor(base * (90 + hdRnd(st, 21)) / 100));
}

function hdMaxMana(st) { return HD_BASE_MANA + HD_MANA_PER_INT * st.stats.int; }
function hdHealAmt(st, base) {
  return Math.floor(base * (100 + HD_HEAL_PCT_PER_INT * st.stats.int) / 100);
}
function hdRegenPerTick(st) {
  return Math.floor((HD_REGEN_BASE + HD_REGEN_PER_SPIRIT * st.stats.spirit) / 10);
}
function hdPartyDps(st) {
  return HD_DPS_BASE + HD_DPS_PER_PULL * st.pull + HD_DPS_PER_STR * st.stats.str;
}
function hdPartyDpsPerTick(st) { return Math.floor(hdPartyDps(st) / 10); }
function hdGcdTicks(st) { return Math.max(9, HD_GCD_TICKS - st.stats.haste); }
function hdCastTicks(st) { return Math.max(15, HD_HT_CAST_TICKS - st.stats.haste); }
function hdRestTicks(pull) {
  const base = Math.max(HD_REST_MIN, HD_REST_BASE - HD_REST_PER_PULL * pull);
  return hdIsBoss(pull) ? base + HD_BOSS_REST_BONUS : base;
}
function hdMaxHpFor(st, slot) {
  return slot === HD_TANK ? HD_BASE_HP[HD_TANK] + 60 * st.stats.stam : HD_BASE_HP[slot];
}
function hdIsBoss(pull) { return pull % HD_BOSS_EVERY === 0; }

// Enrage: a flat percentage on top of EVERY point of boss damage, growing once
// the fight has run past HD_BOSS_ENRAGE_TICKS.
function hdEnragePct(st) {
  if (!st.isBoss) return 100;
  const over = st.fightTick - HD_BOSS_ENRAGE_TICKS;
  if (over <= 0) return 100;
  return 100 + HD_BOSS_ENRAGE_PER_SEC * Math.floor(over / 10);
}
function hdScaleDmg(st, amt, pct) {
  return Math.max(1, Math.floor(amt * pct / 100 * hdEnragePct(st) / 100));
}

function hdInitState(seed) {
  const st = {
    rngState: (Number(seed) >>> 0) || 1,
    tick: 0,
    phase: 'fight',          // 'fight' | 'rest' | 'dead'
    pull: 1,
    pullsCleared: 0,
    bossesKilled: 0,
    hp: [], maxHp: [],
    mana: 0,
    fsr: HD_FSR_TICKS,       // starts fully regenerating
    gcd: 0,
    cast: null,              // { spell, target, left }
    wgCd: 0,
    hots: [],                // { tgt, kind, left, next, idx }
    packHp: 0, packMax: 0,
    isBoss: false,
    fightTick: 0,
    bossCast: null,          // { kind, left, total }
    bossCastT: 0,
    restLeft: 0, restMax: 0,
    drinking: false,
    upgrades: [], upgradePicked: false,
    stats: { int: 0, spirit: 0, stam: 0, str: 0, haste: 0 },
    dead: false, deadWho: -1,
    meleeT: HD_MELEE_PERIOD, aoeT: HD_AOE_PERIOD, spikeT: HD_SPIKE_PERIOD,
    healingDone: 0, manaSpent: 0, overheal: 0,
    // Cosmetic event feed for the battlefield renderer. Cleared every tick and
    // NEVER read by the simulation, so a server transcription can drop it (or
    // keep it — it changes nothing).
    fx: [],
  };
  for (let i = 0; i < HD_PARTY; i += 1) { st.maxHp[i] = hdMaxHpFor(st, i); st.hp[i] = st.maxHp[i]; }
  st.mana = hdMaxMana(st);
  hdStartPull(st);
  return st;
}

function hdStartPull(st) {
  st.phase = 'fight';
  st.isBoss = hdIsBoss(st.pull);
  const base = HD_PACK_HP_BASE + HD_PACK_HP_PER_PULL * st.pull;
  st.packMax = st.isBoss ? Math.floor(base * HD_BOSS_HP_MULT_PCT / 100) : base;
  st.packHp = st.packMax;
  st.meleeT = HD_MELEE_PERIOD;
  st.aoeT = HD_AOE_PERIOD;
  st.spikeT = HD_SPIKE_PERIOD;
  st.fightTick = 0;
  st.bossCast = null;
  st.bossCastT = HD_BOSS_CAST_FIRST;
  st.drinking = false;
}

function hdBeginRest(st) {
  st.phase = 'rest';
  st.restMax = hdRestTicks(st.pull);
  st.restLeft = st.restMax;
  st.drinking = true;        // you sit down automatically; casting stands you up
  st.upgradePicked = false;
  st.bossCast = null;
  // Two distinct upgrades drawn from the five.
  const pool = [];
  for (let i = 0; i < HD_UPGRADE_COUNT; i += 1) pool.push(i);
  st.upgrades = [];
  for (let i = 0; i < HD_UPGRADE_CHOICES; i += 1) st.upgrades.push(pool.splice(hdRnd(st, pool.length), 1)[0]);
}

function hdApplyUpgrade(st, up) {
  const step = HD_UP_STEP[up];
  if (up === HD_UP_INT) {
    st.stats.int += step;                       // bigger pool + stronger heals
  } else if (up === HD_UP_SPIRIT) {
    st.stats.spirit += step;
  } else if (up === HD_UP_STAM) {
    const before = st.maxHp[HD_TANK];
    st.stats.stam += step;
    st.maxHp[HD_TANK] = hdMaxHpFor(st, HD_TANK);
    st.hp[HD_TANK] += st.maxHp[HD_TANK] - before;   // new HP arrives filled
  } else if (up === HD_UP_STR) {
    st.stats.str += step;
  } else {
    st.stats.haste += step;
  }
  st.upgradePicked = true;
}

function hdDamage(st, slot, amount, src) {
  if (st.dead || st.hp[slot] <= 0) return;
  st.hp[slot] -= amount;
  st.fx.push({ k: 'dmg', slot: slot, amt: amount, src: src });
  if (st.hp[slot] <= 0) {
    st.hp[slot] = 0;
    st.dead = true;
    st.deadWho = slot;
    st.phase = 'dead';
  }
}

function hdHeal(st, slot, amount, spell) {
  if (st.hp[slot] <= 0) return;
  const room = st.maxHp[slot] - st.hp[slot];
  const applied = Math.min(room, amount);
  st.hp[slot] += applied;
  st.healingDone += applied;
  st.overheal += amount - applied;
  if (applied > 0) st.fx.push({ k: 'heal', slot: slot, amt: applied, spell: spell });
}

function hdSpend(st, cost) {
  st.mana -= cost;
  if (st.mana < 0) st.mana = 0;
  st.manaSpent += cost;
  st.fsr = 0;                 // the 5-second rule restarts on every spend
  st.drinking = false;        // casting stands you up
}

// Refreshing a HoT of the same kind on the same target replaces it, exactly
// like re-applying Rejuvenation in game.
function hdAddHot(st, tgt, kind) {
  for (let i = st.hots.length - 1; i >= 0; i -= 1) {
    if (st.hots[i].tgt === tgt && st.hots[i].kind === kind) st.hots.splice(i, 1);
  }
  const period = kind === HD_SP_REJUV ? HD_REJUV_PERIOD : HD_WG_PERIOD;
  const len = kind === HD_SP_REJUV ? HD_REJUV_AMOUNTS.length : HD_WG_AMOUNTS.length;
  st.hots.push({ tgt: tgt, kind: kind, left: len, next: period, idx: 0 });
}

// ── Heal prediction ─────────────────────────────────────────────────────────
// Everything already in flight toward a target: the direct cast you are mid-way
// through plus every remaining tick of every HoT on them. This is what the
// green ghost segment on the raid frame draws, and it is the readout that tells
// you "they look low but they are already covered — spend the GCD elsewhere".
function hdIncomingHeal(st, slot) {
  let sum = 0;
  if (st.cast && st.cast.target === slot) sum += hdHealAmt(st, HD_HT_HEAL);
  for (let i = 0; i < st.hots.length; i += 1) {
    const h = st.hots[i];
    if (h.tgt !== slot) continue;
    const table = h.kind === HD_SP_REJUV ? HD_REJUV_AMOUNTS : HD_WG_AMOUNTS;
    for (let j = h.idx; j < table.length; j += 1) sum += hdHealAmt(st, table[j]);
  }
  return sum;
}

// The mirror image: the boss ability currently on its cast bar, as an estimate
// (the ±10% jitter has not been rolled yet, so this is the pre-jitter number).
function hdBossPending(st) {
  if (!st.bossCast) return null;
  const raw = st.bossCast.kind === HD_CB_BUSTER
    ? HD_BOSS_BUSTER_BASE + HD_BOSS_BUSTER_PER_PULL * st.pull
    : HD_BOSS_NUKE_BASE + HD_BOSS_NUKE_PER_PULL * st.pull;
  return { kind: st.bossCast.kind, amt: hdScaleDmg(st, raw, 100), left: st.bossCast.left, total: st.bossCast.total };
}
function hdIncomingDamage(st, slot) {
  const p = hdBossPending(st);
  if (!p) return 0;
  if (p.kind === HD_CB_BUSTER) return slot === HD_TANK ? p.amt : 0;
  return p.amt;
}

function hdCanCast(st, spell) {
  if (st.dead || st.cast) return false;
  if (st.gcd > 0) return false;
  if (st.mana < HD_COST[spell]) return false;
  if (spell === HD_SP_WG && st.wgCd > 0) return false;
  return true;
}

function hdCast(st, spell, target) {
  if (!hdCanCast(st, spell)) return false;
  const tgt = target >= 0 && target < HD_PARTY ? target : HD_TANK;
  if (spell === HD_SP_HT) {
    // The only cast-time spell: mana is committed up front, the heal lands when
    // the cast completes.
    hdSpend(st, HD_COST[HD_SP_HT]);
    st.cast = { spell: spell, target: tgt, left: hdCastTicks(st) };
    st.gcd = hdGcdTicks(st);
    return true;
  }
  hdSpend(st, HD_COST[spell]);
  st.gcd = hdGcdTicks(st);
  if (spell === HD_SP_REJUV) {
    hdAddHot(st, tgt, HD_SP_REJUV);
  } else {
    for (let i = 0; i < HD_PARTY; i += 1) hdAddHot(st, i, HD_SP_WG);
    st.wgCd = HD_WG_CD_TICKS;
  }
  return true;
}

function hdApplyAction(st, a, t) {
  if (st.dead) return;
  if (a === HD_A_REJUV) hdCast(st, HD_SP_REJUV, t);
  else if (a === HD_A_WG) hdCast(st, HD_SP_WG, t);
  else if (a === HD_A_HT) hdCast(st, HD_SP_HT, t);
  else if (a === HD_A_DRINK) { if (st.phase === 'rest') st.drinking = true; }
  else if (a === HD_A_PULL) { if (st.phase === 'rest') { hdAutoPickUpgrade(st); hdNextPull(st); } }
  else if (a === HD_A_UPGRADE) {
    if (st.phase === 'rest' && !st.upgradePicked && t >= 0 && t < st.upgrades.length) {
      hdApplyUpgrade(st, st.upgrades[t]);
    }
  }
}

// If the rest window runs out (or you pull early) without a pick, the first
// card is taken for you — deterministic, and never silently skips a level.
function hdAutoPickUpgrade(st) {
  if (!st.upgradePicked && st.upgrades.length) hdApplyUpgrade(st, st.upgrades[0]);
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
    const table = h.kind === HD_SP_REJUV ? HD_REJUV_AMOUNTS : HD_WG_AMOUNTS;
    hdHeal(st, h.tgt, hdHealAmt(st, table[h.idx]), h.kind);
    h.idx += 1;
    h.left -= 1;
    h.next = h.kind === HD_SP_REJUV ? HD_REJUV_PERIOD : HD_WG_PERIOD;
    if (h.left <= 0) st.hots.splice(i, 1);
  }
}

function hdAdvanceTick(st, actions) {
  if (st.dead) return;
  st.tick += 1;
  st.fx.length = 0;

  if (actions) for (let i = 0; i < actions.length; i += 1) hdApplyAction(st, actions[i].a, actions[i].t);
  if (st.dead) return;

  // ── resources ──
  if (st.gcd > 0) st.gcd -= 1;
  if (st.wgCd > 0) st.wgCd -= 1;
  const maxMana = hdMaxMana(st);
  if (st.drinking && st.phase === 'rest') {
    st.mana = Math.min(maxMana, st.mana + Math.floor(HD_DRINK_PER_SEC / 10));
  } else if (st.fsr >= HD_FSR_TICKS) {
    // Spirit regen only OUTSIDE the five-second window — the whole point.
    st.mana = Math.min(maxMana, st.mana + hdRegenPerTick(st));
  }
  // Counted AFTER the check, so the spend tick itself is inside the window and
  // regen resumes on exactly the 50th tick (5.0 s), not the 49th.
  if (st.fsr < HD_FSR_TICKS) st.fsr += 1;

  // ── cast bar ──
  if (st.cast) {
    st.cast.left -= 1;
    if (st.cast.left <= 0) {
      hdHeal(st, st.cast.target, hdHealAmt(st, HD_HT_HEAL), HD_SP_HT);
      st.cast = null;
    }
  }

  hdTickHots(st);
  if (st.dead) return;

  if (st.phase === 'rest') {
    // Out-of-combat health regen: nowhere near enough once the window is down
    // to five seconds.
    // Applied once a second rather than every tick: the per-tick amount would
    // floor to a wildly different effective rate for each party member's pool.
    if (st.tick % 10 === 0) {
      for (let i = 0; i < HD_PARTY; i += 1) {
        if (st.hp[i] > 0 && st.hp[i] < st.maxHp[i]) {
          st.hp[i] = Math.min(st.maxHp[i], st.hp[i] + Math.max(1, Math.floor(st.maxHp[i] * HD_OOC_REGEN_PERMIL / 1000)));
        }
      }
    }
    st.restLeft -= 1;
    if (st.restLeft <= 0) { hdAutoPickUpgrade(st); hdNextPull(st); }
    return;
  }

  // ── the pull ──
  st.fightTick += 1;
  st.packHp -= hdPartyDpsPerTick(st);
  if (st.packHp <= 0) {
    st.packHp = 0;
    st.pullsCleared += 1;
    if (st.isBoss) st.bossesKilled += 1;
    hdBeginRest(st);
    return;
  }

  const meleePct = st.isBoss ? HD_BOSS_MELEE_PCT : 100;
  const aoePct = st.isBoss ? HD_BOSS_AOE_PCT : 100;

  // ── boss telegraph ── resolved before the auto-attacks so a buster and a
  // melee swing in the same tick land in the order the cast bar promised.
  if (st.isBoss) {
    if (st.bossCast) {
      st.bossCast.left -= 1;
      if (st.bossCast.left <= 0) {
        const kind = st.bossCast.kind;
        st.bossCast = null;
        st.bossCastT = HD_BOSS_CAST_PERIOD;
        if (kind === HD_CB_BUSTER) {
          hdDamage(st, HD_TANK,
            hdScaleDmg(st, hdJitter(st, HD_BOSS_BUSTER_BASE + HD_BOSS_BUSTER_PER_PULL * st.pull), 100), 'buster');
        } else {
          const dmg = hdScaleDmg(st, hdJitter(st, HD_BOSS_NUKE_BASE + HD_BOSS_NUKE_PER_PULL * st.pull), 100);
          for (let i = 0; i < HD_PARTY; i += 1) { hdDamage(st, i, dmg, 'nuke'); if (st.dead) return; }
        }
        if (st.dead) return;
      }
    } else {
      st.bossCastT -= 1;
      if (st.bossCastT <= 0) {
        const kind = hdRnd(st, 2);
        st.bossCast = { kind: kind, left: HD_BOSS_CAST_TICKS, total: HD_BOSS_CAST_TICKS };
        st.fx.push({ k: 'cast', kind: kind });
      }
    }
  }

  st.meleeT -= 1;
  if (st.meleeT <= 0) {
    st.meleeT = HD_MELEE_PERIOD;
    hdDamage(st, HD_TANK, hdScaleDmg(st, hdJitter(st, HD_MELEE_BASE + HD_MELEE_PER_PULL * st.pull), meleePct), 'melee');
    if (st.dead) return;
  }

  st.aoeT -= 1;
  if (st.aoeT <= 0) {
    st.aoeT = HD_AOE_PERIOD;
    const dmg = hdScaleDmg(st, hdJitter(st, HD_AOE_BASE + HD_AOE_PER_PULL * st.pull), aoePct);
    for (let i = 0; i < HD_PARTY; i += 1) { hdDamage(st, i, dmg, 'aoe'); if (st.dead) return; }
  }

  st.spikeT -= 1;
  if (st.spikeT <= 0) {
    st.spikeT = HD_SPIKE_PERIOD;
    const tgt = 1 + hdRnd(st, HD_PARTY - 1);
    hdDamage(st, tgt, hdScaleDmg(st, hdJitter(st, HD_SPIKE_BASE + HD_SPIKE_PER_PULL * st.pull), 100), 'spike');
  }
}
// ╚═══ PARITY BLOCK END ══════════════════════════════════════════════════════╝

// ── Presentation ────────────────────────────────────────────────────────────
const HD_SLOT_NAMES = ['Tank', 'Ty (Druid)', 'Łotr', 'Łucznik', 'Mag'];
const HD_SLOT_SHORT = ['Tank', 'Ty', 'Łotr', 'Łucz.', 'Mag'];
const HD_SLOT_ICONS = ['🛡️', '💚', '🗡️', '🏹', '🔮'];
const HD_SLOT_COLORS = ['#94a3b8', '#4ade80', '#facc15', '#a3e635', '#60a5fa'];
const HD_TARGET_KEYS = ['Q', 'W', 'E', 'R', 'T'];

const HD_SPELL_META = [
  { key: '1', icon: '🌿', name: 'Odnowa',             hint: 'HoT · 12 s · 1 cel' },
  { key: '2', icon: '🌳', name: 'Dziki Wzrost',       hint: 'HoT · 8 s · CAŁA drużyna' },
  { key: '3', icon: '✋', name: 'Uzdrawiający Dotyk', hint: 'kanał 2,5 s · duże leczenie' },
];

const HD_UPGRADE_META = [
  { icon: '🧠', name: 'Intelekt',     desc: 'Większa pula many i mocniejszy każdy czar.' },
  { icon: '💧', name: 'Duch',         desc: 'Szybsza regeneracja many poza zasadą 5 sekund.' },
  { icon: '🛡️', name: 'Wytrzymałość', desc: 'Tank ma większy bufor życia na cios bossa.' },
  { icon: '⚔️', name: 'Siła',         desc: 'Drużyna szybciej zabija — krótsze walki, mniej obrażeń.' },
  { icon: '⚡', name: 'Pośpiech',     desc: 'Krótsze GCD i szybsze rzucanie — więcej czarów.' },
];

// Office monsters, because the rest of the portal is an office.
const HD_PACK_NAMES = [
  'Stos faktur', 'Audyt Q4', 'Deadline', 'Ticket CF', 'Zebranie statusowe',
  'Korekta VAT', 'Nadgodziny', 'Excel bez formuł', 'Kontrola skarbowa', 'Poniedziałek',
];
const HD_PACK_GLYPHS = ['🧾', '📊', '⏰', '🎫', '💬', '📉', '🌙', '📗', '🏛️', '☕'];

const HD_BOSS_NAMES = ['Prezes Zarządu', 'Audytor Zewnętrzny', 'Zamknięcie Roku', 'Migracja ERP', 'Rada Nadzorcza'];
const HD_BOSS_GLYPHS = ['👔', '🕵️', '📕', '🖥️', '⚖️'];
const HD_CAST_META = [
  { name: 'Cios Decyzyjny', desc: 'ogromne obrażenia w Tanka', icon: '💥' },
  { name: 'Reorganizacja',  desc: 'obrażenia w CAŁĄ drużynę',  icon: '🌪️' },
];

function hdBossIndex(pull) { return (Math.floor(pull / HD_BOSS_EVERY) - 1) % HD_BOSS_NAMES.length; }
function hdPackName(pull) {
  if (hdIsBoss(pull)) return HD_BOSS_NAMES[hdBossIndex(pull)];
  return HD_PACK_NAMES[(pull - 1) % HD_PACK_NAMES.length] +
    (pull > HD_PACK_NAMES.length ? ' +' + Math.floor((pull - 1) / HD_PACK_NAMES.length) : '');
}
function hdPackGlyph(pull) {
  return hdIsBoss(pull) ? HD_BOSS_GLYPHS[hdBossIndex(pull)] : HD_PACK_GLYPHS[(pull - 1) % HD_PACK_GLYPHS.length];
}

function hdEl(id) { return document.getElementById(id); }
function hdPct(cur, max) { return max > 0 ? Math.max(0, Math.min(100, cur / max * 100)) : 0; }
function hdReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ── Battlefield: a Heroes-of-Might-and-Magic-3 hex field, seen from above ────
// Pointy-top hexes laid out in true hex space, then squashed vertically so the
// floor reads as a table you are looking down at rather than a flat tile map —
// which is exactly the trick HoMM3's battlefield uses.
const HD_CS_W = 760, HD_CS_H = 400, HD_MAX_DPR = 2;
const HD_HEX_COLS = 11, HD_HEX_ROWS = 7;
const HD_HEX_W = 62;
const HD_HEX_R = HD_HEX_W / Math.sqrt(3);      // circumradius of a pointy-top hex
const HD_HEX_SQUASH = 0.85;                    // the top-down foreshortening
const HD_HEX_VSTEP = HD_HEX_R * 1.5 * HD_HEX_SQUASH;
const HD_HEX_X0 = 44, HD_HEX_Y0 = 66;

// Formation. Tank alone on the front line, the two casters in the back column,
// the melee/ranged dps fanned out between them — the same "who is exposed" read
// as a real battlefield. Cells are spaced at least two grid steps apart in one
// axis: sprites are 42 px wide on a 62 px column with rows only 33 px apart, so
// diagonal neighbours (an earlier [0,3]+[1,4] pairing) visibly overlap.
const HD_PARTY_CELL = [[4, 3], [0, 2], [2, 1], [2, 5], [0, 4]];
const HD_MOB_CELL = [[7, 3], [9, 1], [9, 5], [8, 2], [8, 4], [10, 3]];
const HD_BOSS_CELL = [8, 3];

function hdHexXY(col, row) {
  return [
    HD_HEX_X0 + col * HD_HEX_W + (row % 2 ? HD_HEX_W / 2 : 0),
    HD_HEX_Y0 + row * HD_HEX_VSTEP,
  ];
}
function hdPartyXY(slot) { const c = HD_PARTY_CELL[slot]; return hdHexXY(c[0], c[1]); }
function hdMobXY(idx, isBoss) {
  if (isBoss) return hdHexXY(HD_BOSS_CELL[0], HD_BOSS_CELL[1]);
  const c = HD_MOB_CELL[idx % HD_MOB_CELL.length];
  return hdHexXY(c[0], c[1]);
}

// How many enemy stacks stand on the field, and how many creatures each still
// has. The pack is one HP pool in the sim; splitting it across stacks purely
// for display is what makes a pull visibly *shrink* as the dps chew through it.
function hdMobStacks(pull) { return Math.min(HD_MOB_CELL.length, 3 + Math.floor((pull - 1) / 3)); }
function hdMobCounts(st) {
  if (st.isBoss) return [1];
  const n = hdMobStacks(st.pull);
  const per = st.packMax / n;
  const lost = st.packMax - st.packHp;
  const unitsPer = 3 + Math.floor(st.pull / 2);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const stackLost = Math.max(0, Math.min(per, lost - i * per));
    const frac = 1 - stackLost / per;
    out.push(frac > 0 ? Math.max(1, Math.ceil(frac * unitsPer)) : 0);
  }
  return out;
}

let hdCtx = null;

function hdInitCanvas() {
  const cv = hdEl('hd-stage');
  if (!cv) return null;
  // The backing store is sized from the canvas's ON-SCREEN size, not from a
  // nominal devicePixelRatio: the console is inside a CSS transform, so its
  // layout pixels are not screen pixels. getBoundingClientRect() reports the
  // post-transform box, which is exactly the number of real pixels we have to
  // fill — without this the battlefield goes soft the moment the viewport is
  // bigger than the console's virtual size (any 1920×1080 screen).
  // The element box is not the drawn box: the canvas is `object-fit: contain`,
  // so the picture is letterboxed inside it and only the binding axis is full
  // size. Sizing off rect.width alone over-allocated the backing store by the
  // letterbox ratio on any tall box.
  const rect = cv.getBoundingClientRect();
  const shown = Math.min(rect.width || HD_CS_W, (rect.height || HD_CS_H) * (HD_CS_W / HD_CS_H));
  const dpr = Math.max(1, Math.min(HD_MAX_DPR, shown / HD_CS_W * (window.devicePixelRatio || 1)));
  const w = Math.round(HD_CS_W * dpr), h = Math.round(HD_CS_H * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// ── Fit-to-viewport console ─────────────────────────────────────────────────
// Fixed virtual sizes, scaled by one transform. See the CSS block in index.html
// for why scaling beats fluid units here: the guarantee is "never scrolls, at
// any window size", and five raid frames plus a battlefield have a real minimum
// height that fluid layout can only satisfy by clipping.
const HD_VIEW_LAND = [1600, 900];
const HD_VIEW_PORT = [440, 900];

let hdViewOpen = false;

// Measure the CONTAINER, not the window. `.hd-fit` is position:fixed inset:0,
// so its own box is by definition the space the console has to fit into — no
// guessing which of innerWidth / visualViewport / clientWidth is authoritative
// in this browser, and no way for those to disagree with reality (a pane that
// reported a bogus visualViewport of 117×240 while the document was 1280 wide
// is what prompted this). Window metrics remain the fallback.
function hdViewportSize() {
  const fit = hdEl('hd-fit');
  if (fit) {
    const r = fit.getBoundingClientRect();
    if (r.width >= 200 && r.height >= 200) return [Math.round(r.width), Math.round(r.height)];
  }
  const de = document.documentElement;
  return [
    Math.max(240, de.clientWidth || window.innerWidth || 1024),
    Math.max(240, de.clientHeight || window.innerHeight || 720),
  ];
}

// Pick whichever console actually ends up BIGGER on this screen, by rendered
// area. A width/aspect rule looked obvious and was wrong for a phone held
// sideways: 812×375 is under any sane "narrow" threshold, so it chose the
// portrait console and painted a 183 px strip down the middle of an 812 px
// screen, when the landscape one would have filled 667×375. Comparing the two
// candidates directly cannot get that backwards, and needs no thresholds.
function hdPickView(vw, vh) {
  const land = Math.min(vw / HD_VIEW_LAND[0], vh / HD_VIEW_LAND[1]);
  const port = Math.min(vw / HD_VIEW_PORT[0], vh / HD_VIEW_PORT[1]);
  const areaLand = land * land * HD_VIEW_LAND[0] * HD_VIEW_LAND[1];
  const areaPort = port * port * HD_VIEW_PORT[0] * HD_VIEW_PORT[1];
  return areaPort > areaLand;
}

function hdIsHandheld() {
  return !(window.matchMedia && window.matchMedia('(min-width: 900px) and (hover: hover)').matches);
}

function hdLayout() {
  const con = hdEl('hd-console');
  if (!con) return;
  const size = hdViewportSize();
  const portrait = hdPickView(size[0], size[1]);
  const view = portrait ? HD_VIEW_PORT : HD_VIEW_LAND;
  const scale = Math.min(size[0] / view[0], size[1] / view[1]);
  con.classList.toggle('is-portrait', portrait);
  con.style.setProperty('--hd-cw', view[0] + 'px');
  con.style.setProperty('--hd-ch', view[1] + 'px');
  con.style.setProperty('--hd-scale', String(scale));
  // A phone held sideways has ~375 px of height for a 900 px console, which
  // scales the text down to about 5 px. Everything still fits and still works —
  // it is simply too small to read, so say so rather than pretend otherwise.
  const fit = hdEl('hd-fit');
  if (fit) fit.classList.toggle('is-cramped', scale < 0.55 && hdIsHandheld());
}

// requestFullscreen() needs a live user gesture, so this only succeeds when
// called straight out of a click handler. It is a bonus either way: the fixed
// .hd-fit overlay is what actually delivers the fullscreen layout, which is why
// iOS Safari — no element Fullscreen API at all — behaves identically.
function hdRequestFullscreen() {
  if (!hdIsHandheld() || document.fullscreenElement) return;
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (fn) { try { fn.call(el); } catch (e) { /* not fatal, CSS already took over */ } }
}

function hdExitFullscreen() {
  if (!document.fullscreenElement) return;
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  if (fn) { try { fn.call(document); } catch (e) { /* ignore */ } }
}

function healerEnterView() {
  if (hdViewOpen) return;
  hdViewOpen = true;
  document.documentElement.classList.add('hd-view-open');
  window.addEventListener('resize', hdLayout);
  window.addEventListener('orientationchange', hdLayout);
  document.addEventListener('fullscreenchange', hdLayout);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', hdLayout);
  hdLayout();
  healerRender();
}

function healerExitView() {
  if (!hdViewOpen) return;
  hdViewOpen = false;
  document.documentElement.classList.remove('hd-view-open');
  window.removeEventListener('resize', hdLayout);
  window.removeEventListener('orientationchange', hdLayout);
  document.removeEventListener('fullscreenchange', hdLayout);
  if (window.visualViewport) window.visualViewport.removeEventListener('resize', hdLayout);
  hdExitFullscreen();
  healerStopRaf();
}

function healerLeaveGame() {
  healerExitView();
  // Reuse the picker's own back button so there is exactly one teardown path.
  const back = document.getElementById('ag-back');
  if (back) back.click();
}

function healerToggleHelp(on) {
  const help = hdEl('hd-help');
  if (!help) return;
  const show = on === undefined ? !help.classList.contains('is-on') : !!on;
  help.classList.toggle('is-on', show);
  if (show) healerRenderHelpStats();
}

function hdHexPath(ctx, x, y, scale) {
  const r = HD_HEX_R * (scale || 1);
  ctx.beginPath();
  for (let i = 0; i < 6; i += 1) {
    const a = Math.PI / 3 * i;
    const px = x + r * Math.sin(a);
    const py = y - r * Math.cos(a) * HD_HEX_SQUASH;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function hdRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hdDrawField(ctx, rt, st) {
  // floor
  const g = ctx.createLinearGradient(0, 0, 0, HD_CS_H);
  g.addColorStop(0, '#161b26');
  g.addColorStop(0.55, '#1b2130');
  g.addColorStop(1, '#232b3c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, HD_CS_W, HD_CS_H);

  // a boss arena is lit red — you can tell what you walked into before you read
  // a single label
  if (st && st.isBoss && st.phase === 'fight') {
    const rg = ctx.createRadialGradient(HD_CS_W * 0.66, HD_CS_H * 0.5, 20, HD_CS_W * 0.66, HD_CS_H * 0.5, 330);
    rg.addColorStop(0, 'rgba(190,30,40,.26)');
    rg.addColorStop(1, 'rgba(190,30,40,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, HD_CS_W, HD_CS_H);
  }

  // hex grid
  ctx.lineWidth = 1;
  for (let r = 0; r < HD_HEX_ROWS; r += 1) {
    for (let c = 0; c < HD_HEX_COLS; c += 1) {
      const p = hdHexXY(c, r);
      if (p[0] > HD_CS_W - 12) continue;
      hdHexPath(ctx, p[0], p[1], 0.94);
      ctx.fillStyle = (c + r) % 2 ? 'rgba(255,255,255,.014)' : 'rgba(255,255,255,.03)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(148,163,184,.14)';
      ctx.stroke();
    }
  }

  // the tile the currently targeted party member stands on
  if (rt && st && st.hp[rt.target] > 0) {
    const p = hdPartyXY(rt.target);
    hdHexPath(ctx, p[0], p[1], 0.94);
    ctx.fillStyle = 'rgba(250,204,21,.16)';
    ctx.fill();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // and the tiles a boss ability is about to land on
  if (st && st.bossCast) {
    const buster = st.bossCast.kind === HD_CB_BUSTER;
    const pulse = 0.18 + 0.16 * Math.sin((rt ? rt.time : 0) / 110);
    for (let i = 0; i < HD_PARTY; i += 1) {
      if (buster && i !== HD_TANK) continue;
      if (st.hp[i] <= 0) continue;
      const p = hdPartyXY(i);
      hdHexPath(ctx, p[0], p[1], 0.94);
      ctx.fillStyle = 'rgba(239,68,68,' + pulse.toFixed(3) + ')';
      ctx.fill();
      ctx.strokeStyle = 'rgba(248,113,113,.75)';
      ctx.stroke();
    }
  }
}

// One creature stack: shadow, a colour plate, its glyph, a HoMM3 count badge
// and — for the party — a slim health pip so the battlefield alone tells you
// who is dying, without looking down at the frames.
function hdDrawUnit(ctx, o) {
  const s = o.big ? 1.75 : 1;
  const x = o.x + (o.lunge || 0);
  const y = o.y;
  const w = 42 * s, h = 34 * s;

  ctx.save();
  if (o.dead) ctx.globalAlpha = 0.28;

  ctx.fillStyle = 'rgba(0,0,0,.42)';
  ctx.beginPath();
  ctx.ellipse(x, y + 4, 21 * s, 7 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  if (o.glow > 0) {
    ctx.fillStyle = 'rgba(74,222,128,' + (0.45 * o.glow).toFixed(3) + ')';
    ctx.beginPath();
    ctx.ellipse(x, y - 16 * s, 30 * s, 26 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const top = y - 6 - h;
  const pg = ctx.createLinearGradient(0, top, 0, top + h);
  pg.addColorStop(0, o.color);
  pg.addColorStop(1, 'rgba(0,0,0,.55)');
  hdRoundRect(ctx, x - w / 2, top, w, h, 7 * s);
  ctx.fillStyle = pg;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = o.flash > 0 ? '#fecaca' : 'rgba(0,0,0,.55)';
  ctx.stroke();

  if (o.flash > 0) {
    hdRoundRect(ctx, x - w / 2, top, w, h, 7 * s);
    ctx.fillStyle = 'rgba(255,255,255,' + (0.6 * o.flash).toFixed(3) + ')';
    ctx.fill();
  }

  ctx.font = Math.round(23 * s) + 'px system-ui, "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(o.glyph, x, top + h / 2 + 1);

  if (o.count > 1) {
    const bw = 24 * s, bh = 15 * s;
    hdRoundRect(ctx, x + w / 2 - bw + 4, y - 4, bw, bh, 4);
    ctx.fillStyle = 'rgba(9,12,18,.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(148,163,184,.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '700 ' + Math.round(10 * s) + 'px system-ui, sans-serif';
    ctx.fillText(String(o.count), x + w / 2 - bw / 2 + 4, y + bh / 2 - 4);
  }

  if (o.hpPct !== undefined) {
    const bw = 40 * s;
    ctx.fillStyle = 'rgba(6,9,14,.85)';
    ctx.fillRect(x - bw / 2, top - 9, bw, 5);
    ctx.fillStyle = o.hpPct < 35 ? '#ef4444' : o.hpPct < 65 ? '#f59e0b' : '#22c55e';
    ctx.fillRect(x - bw / 2, top - 9, bw * o.hpPct / 100, 5);
    if (o.predPct > 0) {
      ctx.fillStyle = 'rgba(134,239,172,.75)';
      ctx.fillRect(x - bw / 2 + bw * o.hpPct / 100, top - 9,
        bw * Math.min(o.predPct, 100 - o.hpPct) / 100, 5);
    }
    ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - bw / 2, top - 9, bw, 5);
  }

  if (o.label) {
    ctx.fillStyle = 'rgba(226,232,240,.78)';
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.fillText(o.label, x, top - 17);
  }

  ctx.restore();
}

function hdDrawBossCast(ctx, rt, st) {
  if (!st.bossCast) return;
  const p = hdMobXY(0, true);
  const meta = HD_CAST_META[st.bossCast.kind];
  const done = 1 - st.bossCast.left / st.bossCast.total;
  const w = 168, h = 13, x = p[0] - w / 2, y = p[1] - 108;

  hdRoundRect(ctx, x - 4, y - 17, w + 8, h + 22, 5);
  ctx.fillStyle = 'rgba(9,12,18,.9)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(248,113,113,.8)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#fecaca';
  ctx.font = '800 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(meta.icon + ' ' + meta.name, p[0], y - 8);

  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fillRect(x, y, w, h);
  const cg = ctx.createLinearGradient(x, 0, x + w, 0);
  cg.addColorStop(0, '#b91c1c');
  cg.addColorStop(1, '#f87171');
  ctx.fillStyle = cg;
  ctx.fillRect(x, y, w * done, h);
  ctx.strokeStyle = 'rgba(248,113,113,.9)';
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  ctx.fillStyle = '#fff';
  ctx.font = '800 10px system-ui, sans-serif';
  ctx.fillText((st.bossCast.left / 10).toFixed(1) + ' s — ' + meta.desc, p[0], y + h / 2);
}

function hdDraw() {
  const ctx = hdCtx;
  const rt = healerRuntime;
  const st = rt && rt.sim;
  if (!ctx || !st) return;

  ctx.save();
  if (rt.shake > 0 && !hdReducedMotion()) {
    const m = rt.shake / 300 * 5;
    ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
  }

  hdDrawField(ctx, rt, st);

  const bob = hdReducedMotion() ? 0 : 1;
  const resting = st.phase === 'rest';
  const units = [];

  for (let i = 0; i < HD_PARTY; i += 1) {
    const p = hdPartyXY(i);
    const dead = st.hp[i] <= 0;
    const hpPct = hdPct(st.hp[i], st.maxHp[i]);
    units.push({
      row: HD_PARTY_CELL[i][1],
      x: p[0], y: p[1] + (dead ? 0 : bob * Math.sin((rt.time + i * 420) / 520) * 2),
      glyph: dead ? '💀' : HD_SLOT_ICONS[i],
      color: HD_SLOT_COLORS[i],
      lunge: rt.lunge[i] > 0 ? Math.sin((1 - rt.lunge[i] / 300) * Math.PI) * 18 : 0,
      flash: Math.max(0, rt.flash[i] / 260),
      glow: Math.max(0, rt.glow[i] / 320),
      dead: dead,
      count: 1,
      hpPct: hpPct,
      predPct: hdPct(hdIncomingHeal(st, i), st.maxHp[i]),
      label: HD_SLOT_SHORT[i],
    });
  }

  if (!resting) {
    const counts = hdMobCounts(st);
    for (let i = 0; i < counts.length; i += 1) {
      const p = hdMobXY(i, st.isBoss);
      const cell = st.isBoss ? HD_BOSS_CELL : HD_MOB_CELL[i % HD_MOB_CELL.length];
      const enraged = st.isBoss && hdEnragePct(st) > 100;
      units.push({
        row: cell[1],
        x: p[0], y: p[1] + bob * Math.sin((rt.time + i * 330) / 460) * 2,
        glyph: hdPackGlyph(st.pull),
        color: st.isBoss ? (enraged ? '#dc2626' : '#7f1d1d') : '#4c1d24',
        lunge: rt.mobLunge[i] > 0 ? -Math.sin((1 - rt.mobLunge[i] / 320) * Math.PI) * 20 : 0,
        flash: Math.max(0, rt.mobFlash[i] / 240),
        glow: 0,
        dead: counts[i] <= 0,
        count: counts[i],
        big: st.isBoss,
        label: st.isBoss ? (enraged ? '🔥 WŚCIEKŁOŚĆ +' + (hdEnragePct(st) - 100) + '%' : hdPackName(st.pull)) : '',
      });
    }
  }

  units.sort((a, b) => a.row - b.row);
  for (let i = 0; i < units.length; i += 1) hdDrawUnit(ctx, units[i]);

  if (!resting && st.isBoss) hdDrawBossCast(ctx, rt, st);

  // floating combat text
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < rt.num.length; i += 1) {
    const n = rt.num[i];
    const t = 1 - n.life / n.max;
    ctx.globalAlpha = Math.max(0, 1 - t * t);
    ctx.font = '800 ' + n.size + 'px system-ui, sans-serif';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.strokeText(n.text, n.x, n.y - t * 34);
    ctx.fillStyle = n.col;
    ctx.fillText(n.text, n.x, n.y - t * 34);
  }
  ctx.globalAlpha = 1;

  if (resting) {
    ctx.fillStyle = 'rgba(9,12,18,.62)';
    ctx.fillRect(0, 0, HD_CS_W, HD_CS_H);
    ctx.fillStyle = '#93c5fd';
    ctx.font = '800 20px system-ui, sans-serif';
    ctx.fillText('🍺 Przerwa — ' + (st.restLeft / 10).toFixed(1) + ' s', HD_CS_W / 2, HD_CS_H / 2 - 12);
    ctx.fillStyle = 'rgba(226,232,240,.72)';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.fillText(hdIsBoss(st.pull + 1) ? '☠️ Następny: BOSS — ' + hdPackName(st.pull + 1)
      : 'Następna grupa: ' + hdPackName(st.pull + 1), HD_CS_W / 2, HD_CS_H / 2 + 14);
  }

  if (st.dead) {
    ctx.fillStyle = 'rgba(60,6,10,.6)';
    ctx.fillRect(0, 0, HD_CS_W, HD_CS_H);
    ctx.fillStyle = '#fecaca';
    ctx.font = '800 22px system-ui, sans-serif';
    ctx.fillText('☠️ ' + HD_SLOT_NAMES[st.deadWho] + ' zginął', HD_CS_W / 2, HD_CS_H / 2);
  }

  ctx.restore();
}

// ── Runtime ─────────────────────────────────────────────────────────────────
let healerRuntime = null;

function newHealerRuntime() {
  return {
    playing: false, submitting: false, archiveMode: false,
    seed: 1,
    timer: null,
    nextTickAt: 0,
    sim: null,
    eventLog: [],
    queued: [],
    queuedTick: 0,
    target: HD_TANK,
    builtFrames: false,
    endedReason: '',
    // battlefield animation state — cosmetic only
    time: 0, shake: 0, atkT: 0,
    num: [],
    lunge: [0, 0, 0, 0, 0],
    flash: [0, 0, 0, 0, 0],
    glow: [0, 0, 0, 0, 0],
    mobLunge: [0, 0, 0, 0, 0, 0],
    mobFlash: [0, 0, 0, 0, 0, 0],
  };
}

// Turn the sim's inert fx feed into battlefield animation. Nothing here is read
// back by the simulation, so Math.random() is safe.
function hdConsumeFx(rt) {
  const st = rt.sim;
  if (!st || !st.fx.length) return;
  for (let i = 0; i < st.fx.length; i += 1) {
    const f = st.fx[i];
    if (f.k === 'dmg') {
      const p = hdPartyXY(f.slot);
      const heavy = f.src === 'buster' || f.src === 'nuke';
      rt.num.push({
        x: p[0] + (Math.random() * 20 - 10), y: p[1] - 48,
        text: '-' + f.amt, col: heavy ? '#fb7185' : '#f87171',
        size: heavy ? 18 : 13, life: heavy ? 1300 : 1000, max: heavy ? 1300 : 1000,
      });
      rt.flash[f.slot] = 260;
      if (f.src === 'melee' || f.src === 'buster') rt.mobLunge[0] = 320;
      if (f.src === 'spike') rt.mobLunge[1] = 320;
      if (f.src === 'aoe') rt.shake = Math.max(rt.shake, 220);
      if (heavy) rt.shake = Math.max(rt.shake, 380);
    } else if (f.k === 'heal') {
      const p = hdPartyXY(f.slot);
      rt.num.push({
        x: p[0] + (Math.random() * 20 - 10), y: p[1] - 56,
        text: '+' + f.amt, col: f.spell === HD_SP_HT ? '#bbf7d0' : '#86efac',
        size: f.spell === HD_SP_HT ? 17 : 12, life: 900, max: 900,
      });
      rt.glow[f.slot] = 320;
    } else if (f.k === 'cast') {
      rt.shake = Math.max(rt.shake, 140);
    }
  }
}

function hdStepFx(rt, dt) {
  rt.time += dt;
  const dec = (arr) => { for (let i = 0; i < arr.length; i += 1) if (arr[i] > 0) arr[i] = Math.max(0, arr[i] - dt); };
  dec(rt.lunge); dec(rt.flash); dec(rt.glow); dec(rt.mobLunge); dec(rt.mobFlash);
  if (rt.shake > 0) rt.shake = Math.max(0, rt.shake - dt);
  for (let i = rt.num.length - 1; i >= 0; i -= 1) {
    rt.num[i].life -= dt;
    if (rt.num[i].life <= 0) rt.num.splice(i, 1);
  }
  if (rt.num.length > 40) rt.num.splice(0, rt.num.length - 40);

  // The party swinging back. The sim has no per-attacker model — party dps is a
  // single aggregate number — so this is a rhythm, not a replay of events.
  const st = rt.sim;
  if (st && st.phase === 'fight' && !st.dead) {
    rt.atkT -= dt;
    if (rt.atkT <= 0) {
      rt.atkT = 620;
      const alive = [];
      for (let i = 0; i < HD_PARTY; i += 1) if (i !== HD_HEAL && st.hp[i] > 0) alive.push(i);
      if (alive.length) rt.lunge[alive[Math.floor(Math.random() * alive.length)]] = 300;
      const counts = hdMobCounts(st);
      const liveMobs = [];
      for (let i = 0; i < counts.length; i += 1) if (counts[i] > 0) liveMobs.push(i);
      if (liveMobs.length) rt.mobFlash[liveMobs[Math.floor(Math.random() * liveMobs.length)]] = 240;
    }
  }
}

function healerQueueAction(a, t) {
  const rt = healerRuntime;
  if (!rt || !rt.playing || rt.sim.dead) return;
  if (rt.eventLog.length >= HD_MAX_EVENTS) return;
  const tick = rt.sim.tick + 1;
  if (rt.queuedTick !== tick) { rt.queued = []; rt.queuedTick = tick; }
  rt.queued.push({ a: a, t: t | 0 });
  rt.eventLog.push({ tick: tick, a: a, t: t | 0 });
}

function healerSetTarget(slot) {
  const rt = healerRuntime;
  if (!rt) return;
  rt.target = slot;
  healerRenderFrames();
}

// ── Raid frames ─────────────────────────────────────────────────────────────
// Stacked one over the other, WoW-style. Each carries, in this order: the name,
// the health bar with the incoming-heal ghost and the incoming-boss-hit marker
// painted on it, your own mana bar (healer row only) and the buff row.
function healerBuildFrames() {
  const wrap = hdEl('hd-frames');
  if (!wrap) return;
  wrap.replaceChildren();
  for (let i = 0; i < HD_PARTY; i += 1) {
    const frame = document.createElement('button');
    frame.type = 'button';
    frame.className = 'hd-frame';
    frame.dataset.slot = String(i);
    frame.innerHTML =
      '<div class="hd-frame-head">' +
        '<span class="hd-frame-name">' + HD_SLOT_ICONS[i] +
          ' <span class="hd-name-long">' + HD_SLOT_NAMES[i] + '</span>' +
          '<span class="hd-name-short">' + HD_SLOT_SHORT[i] + '</span>' +
          '<span class="hd-frame-key">' + HD_TARGET_KEYS[i] + '</span>' +
        '</span>' +
        '<span class="hd-frame-hp" data-hp></span>' +
      '</div>' +
      '<div class="hd-bar hd-bar-hp">' +
        '<div class="hd-bar-fill" data-fill></div>' +
        '<div class="hd-pred-heal" data-pred></div>' +
        '<div class="hd-pred-dmg" data-dmg></div>' +
        '<span class="hd-pred-num" data-prednum></span>' +
      '</div>' +
      (i === HD_HEAL ? '<div class="hd-bar hd-bar-mini"><div class="hd-bar-fill" data-mana></div></div>' : '') +
      '<div class="hd-hots" data-hots></div>';
    frame.addEventListener('click', () => healerSetTarget(i));
    wrap.appendChild(frame);
  }
  healerRuntime.builtFrames = true;
}

function healerRenderFrames() {
  const rt = healerRuntime;
  const st = rt && rt.sim;
  if (!st) return;
  const frames = document.querySelectorAll('#hd-frames .hd-frame');
  frames.forEach((frame, i) => {
    const pct = hdPct(st.hp[i], st.maxHp[i]);
    const dead = st.hp[i] <= 0;
    frame.classList.toggle('is-target', rt.target === i);
    frame.classList.toggle('is-dead', dead);
    frame.classList.toggle('is-low', !dead && pct < 35);

    const fill = frame.querySelector('[data-fill]');
    if (fill) {
      fill.style.width = pct + '%';
      fill.className = 'hd-bar-fill' + (pct < 35 ? ' is-crit' : pct < 65 ? ' is-warn' : '');
    }

    // Incoming heal: a translucent ghost sitting on top of the missing health,
    // clipped to the gap, exactly like the WoW raid-frame prediction.
    const incoming = dead ? 0 : hdIncomingHeal(st, i);
    const predPct = Math.min(100 - pct, hdPct(incoming, st.maxHp[i]));
    const pred = frame.querySelector('[data-pred]');
    if (pred) {
      pred.style.left = pct + '%';
      pred.style.width = Math.max(0, predPct) + '%';
      pred.classList.toggle('is-on', incoming > 0);
    }

    // Incoming boss hit: eaten out of the RIGHT edge of the current health, so
    // you can see at a glance whether the bar survives the cast.
    const dmg = dead ? 0 : hdIncomingDamage(st, i);
    const dmgPct = Math.min(pct, hdPct(dmg, st.maxHp[i]));
    // Incoming HEALING is on the same side of the scale as current health: you
    // survive the cast when hp + incoming > dmg. (Written the other way round
    // first, which made a well-covered target read as MORE likely to die the
    // more healing you had landed on it — the exact opposite of the point.)
    const lethal = dmg > 0 && dmg >= st.hp[i] + incoming;
    const dmgEl = frame.querySelector('[data-dmg]');
    if (dmgEl) {
      dmgEl.style.left = Math.max(0, pct - dmgPct) + '%';
      dmgEl.style.width = Math.max(0, dmgPct) + '%';
      dmgEl.classList.toggle('is-on', dmg > 0);
      dmgEl.classList.toggle('is-lethal', lethal);
    }

    const num = frame.querySelector('[data-prednum]');
    if (num) {
      let txt = '';
      if (incoming > 0) txt = '+' + incoming;
      if (dmg > 0) txt = (txt ? txt + ' ' : '') + '−' + dmg;
      num.textContent = txt;
      num.className = 'hd-pred-num' + (lethal ? ' is-lethal' : incoming > 0 ? ' is-heal' : '');
    }
    frame.classList.toggle('is-doomed', lethal);

    const hp = frame.querySelector('[data-hp]');
    if (hp) hp.textContent = dead ? '☠️ 0' : st.hp[i] + ' / ' + st.maxHp[i];

    const mana = frame.querySelector('[data-mana]');
    if (mana) mana.style.width = hdPct(st.mana, hdMaxMana(st)) + '%';

    const hots = frame.querySelector('[data-hots]');
    if (hots) {
      const mine = st.hots.filter(h => h.tgt === i);
      const sig = mine.map(h => h.kind + ':' + h.left).join('|') + (st.cast && st.cast.target === i ? '|c' : '');
      if (hots.dataset.sig !== sig) {
        hots.dataset.sig = sig;
        hots.replaceChildren();
        mine.forEach(h => {
          const period = h.kind === HD_SP_REJUV ? HD_REJUV_PERIOD : HD_WG_PERIOD;
          const pip = document.createElement('span');
          pip.className = 'hd-hot hd-hot-' + (h.kind === HD_SP_REJUV ? 'rejuv' : 'wg');
          pip.textContent = (h.kind === HD_SP_REJUV ? '🌿' : '🌳') + Math.ceil(h.left * period / 10);
          pip.title = (h.kind === HD_SP_REJUV ? 'Odnowa' : 'Dziki Wzrost') + ' — ' + h.left + ' tyknięć';
          hots.appendChild(pip);
        });
        if (st.cast && st.cast.target === i) {
          const pip = document.createElement('span');
          pip.className = 'hd-hot hd-hot-cast';
          pip.textContent = '✋';
          pip.title = 'Uzdrawiający Dotyk w locie';
          hots.appendChild(pip);
        }
      }
    }
  });
}

function healerRenderSpells() {
  const st = healerRuntime && healerRuntime.sim;
  if (!st) return;
  document.querySelectorAll('#hd-spells .hd-spell').forEach(btn => {
    const spell = Number(btn.dataset.spell);
    const poor = st.mana < HD_COST[spell];
    const cd = spell === HD_SP_WG && st.wgCd > 0;
    btn.classList.toggle('is-poor', poor);
    btn.classList.toggle('is-cd', cd);
    btn.classList.toggle('is-ready', !poor && !cd && st.gcd === 0 && !st.cast);
    const cdEl = btn.querySelector('[data-cd]');
    if (cdEl) cdEl.textContent = cd ? (st.wgCd / 10).toFixed(1) + ' s' : '';
    const effEl = btn.querySelector('[data-eff]');
    if (effEl) {
      const heal = spell === HD_SP_REJUV ? hdHealAmt(st, 220)
        : spell === HD_SP_WG ? hdHealAmt(st, 180) * HD_PARTY
        : hdHealAmt(st, HD_HT_HEAL);
      effEl.textContent = heal + ' HP · ' + (heal / HD_COST[spell]).toFixed(2) + ' HP/manę';
    }
  });
}

// ── Stat legend ─────────────────────────────────────────────────────────────
// Every stat, its current value, what that value CURRENTLY buys you in real
// numbers, and one line on why you would want more. Rebuilt only when a number
// actually moves.
function hdStatLines(st) {
  return [
    { icon: '🧠', name: 'Intelekt', val: st.stats.int,
      now: hdMaxMana(st) + ' many · leczenie +' + (HD_HEAL_PCT_PER_INT * st.stats.int) + '%',
      why: 'Większa pula many i mocniejszy każdy czar — jedyna statystyka, która robi obie rzeczy naraz.' },
    { icon: '💧', name: 'Duch', val: st.stats.spirit,
      now: (HD_REGEN_BASE + HD_REGEN_PER_SPIRIT * st.stats.spirit) + ' many/s poza walką',
      why: 'Działa TYLKO poza zasadą 5 sekund — im dłuższe przerwy w rzucaniu, tym więcej z niego masz.' },
    { icon: '🛡️', name: 'Wytrzymałość', val: st.stats.stam,
      now: 'Tank ' + hdMaxHpFor(st, HD_TANK) + ' HP',
      why: 'Bufor na cios bossa: większa pula to więcej sekund na reakcję, zanim tank spadnie do zera.' },
    { icon: '⚔️', name: 'Siła', val: st.stats.str,
      now: 'Drużyna ' + hdPartyDps(st) + ' obr./s',
      why: 'Krótsze walki = mniej ciosów w drużynę i mniej wydanej many. Bossów też nie zdąży ogarnąć wściekłość.' },
    { icon: '⚡', name: 'Pośpiech', val: st.stats.haste,
      now: 'GCD ' + (hdGcdTicks(st) / 10).toFixed(1) + ' s · kanał ' + (hdCastTicks(st) / 10).toFixed(1) + ' s',
      why: 'Więcej czarów w tej samej walce — ale mana kończy się wtedy szybciej.' },
  ];
}

function healerRenderLegend() {
  const st = healerRuntime && healerRuntime.sim;
  const box = hdEl('hd-legend');
  if (!st || !box) return;
  const lines = hdStatLines(st);
  const sig = lines.map(l => l.val + l.now).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren();
  lines.forEach(l => {
    const row = document.createElement('div');
    row.className = 'hd-leg-row';
    row.title = l.name + ' — ' + l.why;
    row.innerHTML =
      '<span class="hd-leg-icon">' + l.icon + '</span>' +
      '<span class="hd-leg-name">' + l.name + '<span class="hd-leg-val">' + l.val + '</span></span>' +
      '<span class="hd-leg-now">' + l.now + '</span>';
    box.appendChild(row);
  });
  if (hdEl('hd-help') && hdEl('hd-help').classList.contains('is-on')) healerRenderHelpStats();
}

// The [?] overlay has the room the live strip does not, so the prose answer to
// „what do these statistics actually do" lives there, next to each stat's
// current value.
function healerRenderHelpStats() {
  const st = healerRuntime && healerRuntime.sim;
  const box = hdEl('hd-help-stats');
  if (!st || !box) return;
  box.replaceChildren();
  hdStatLines(st).forEach(l => {
    const cell = document.createElement('div');
    cell.className = 'hd-help-stat';
    cell.innerHTML =
      '<b>' + l.icon + ' ' + l.name + '</b> — teraz: <i>' + l.now + '</i>' +
      '<span>' + l.why + '</span>';
    box.appendChild(cell);
  });
}

function healerRenderBars() {
  const st = healerRuntime && healerRuntime.sim;
  if (!st) return;
  const maxMana = hdMaxMana(st);
  const manaFill = hdEl('hd-mana-fill');
  if (manaFill) manaFill.style.width = hdPct(st.mana, maxMana) + '%';
  const manaText = hdEl('hd-mana-text');
  if (manaText) manaText.textContent = st.mana + ' / ' + maxMana;

  // The 5-second-rule pip: the single most important readout in the game.
  const fsr = hdEl('hd-fsr');
  if (fsr) {
    const regenning = st.fsr >= HD_FSR_TICKS;
    fsr.classList.toggle('is-on', regenning || st.drinking);
    fsr.textContent = st.drinking ? '🍺 pijesz'
      : regenning ? '💧 +' + (hdRegenPerTick(st) * 10) + '/s'
      : '⏳ ' + ((HD_FSR_TICKS - st.fsr) / 10).toFixed(1) + ' s';
  }

  const cast = hdEl('hd-cast');
  if (cast) {
    if (st.cast) {
      cast.classList.add('is-on');
      const total = hdCastTicks(st);
      const done = total - st.cast.left;
      const fill = cast.querySelector('[data-fill]');
      if (fill) fill.style.width = hdPct(done, total) + '%';
      const label = cast.querySelector('[data-label]');
      if (label) label.textContent = '✋ Uzdrawiający Dotyk → ' + HD_SLOT_SHORT[st.cast.target];
    } else {
      cast.classList.remove('is-on');
      const fill = cast.querySelector('[data-fill]');
      if (fill) fill.style.width = '0%';
    }
  }

  const pack = hdEl('hd-pack');
  if (pack) pack.classList.toggle('is-boss', st.isBoss && st.phase !== 'rest');
  const packFill = hdEl('hd-pack-fill');
  if (packFill) packFill.style.width = hdPct(st.packHp, st.packMax) + '%';
  const packText = hdEl('hd-pack-text');
  if (packText) packText.textContent = st.phase === 'rest' ? 'przerwa' : st.packHp + ' / ' + st.packMax;
  const packName = hdEl('hd-pack-name');
  if (packName) {
    packName.textContent = (st.isBoss ? '☠️ BOSS — ' : hdPackGlyph(st.pull) + ' ') + hdPackName(st.pull);
  }

  const setStat = (id, v) => { const e = hdEl(id); if (e) e.textContent = v; };
  setStat('hd-score', String(st.pullsCleared));
  setStat('hd-pull', st.pull + (st.isBoss ? ' ☠️' : ''));
  setStat('hd-mana-stat', String(st.mana));
  setStat('hd-stats', '🧠' + st.stats.int + ' 💧' + st.stats.spirit + ' 🛡️' + st.stats.stam + ' ⚔️' + st.stats.str + ' ⚡' + st.stats.haste);
}

function healerRenderRest() {
  const st = healerRuntime && healerRuntime.sim;
  const panel = hdEl('hd-rest');
  if (!st || !panel) return;
  if (st.phase !== 'rest') { panel.classList.remove('is-on'); return; }
  panel.classList.add('is-on');

  const bar = hdEl('hd-rest-fill');
  if (bar) bar.style.width = hdPct(st.restLeft, st.restMax) + '%';
  const label = hdEl('hd-rest-label');
  if (label) {
    label.textContent = (hdIsBoss(st.pull + 1) ? '☠️ BOSS za ' : 'Następna grupa za ') + (st.restLeft / 10).toFixed(1) + ' s';
    label.classList.toggle('is-boss', hdIsBoss(st.pull + 1));
  }

  const cards = hdEl('hd-upgrades');
  if (!cards) return;
  const signature = st.pull + ':' + st.upgrades.join(',') + ':' + (st.upgradePicked ? 1 : 0);
  if (cards.dataset.sig === signature) return;   // don't rebuild 10×/s
  cards.dataset.sig = signature;
  cards.replaceChildren();
  st.upgrades.forEach((up, i) => {
    const meta = HD_UPGRADE_META[up];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'hd-up' + (st.upgradePicked ? ' is-locked' : '');
    card.disabled = st.upgradePicked;
    card.innerHTML =
      '<span class="hd-up-icon">' + meta.icon + '</span>' +
      '<span class="hd-up-name">' + meta.name + ' +' + HD_UP_STEP[up] + '</span>' +
      '<span class="hd-up-delta">' + hdUpgradeDelta(st, up) + '</span>' +
      '<span class="hd-up-desc">' + meta.desc + '</span>';
    card.addEventListener('click', () => { healerQueueAction(HD_A_UPGRADE, i); });
    cards.appendChild(card);
  });
}

// What this card actually buys, in the same units the legend shows — so a pick
// is never a guess about what "+3 Intelekt" means.
function hdUpgradeDelta(st, up) {
  const step = HD_UP_STEP[up];
  if (up === HD_UP_INT) return '+' + (HD_MANA_PER_INT * step) + ' many · leczenie +' + (HD_HEAL_PCT_PER_INT * step) + '%';
  if (up === HD_UP_SPIRIT) return '+' + (HD_REGEN_PER_SPIRIT * step) + ' many/s poza walką';
  if (up === HD_UP_STAM) return '+' + (60 * step) + ' HP tanka';
  if (up === HD_UP_STR) return '+' + (HD_DPS_PER_STR * step) + ' obr./s drużyny';
  const gcd = Math.max(9, HD_GCD_TICKS - st.stats.haste - step);
  return 'GCD ' + (gcd / 10).toFixed(1) + ' s (z ' + (hdGcdTicks(st) / 10).toFixed(1) + ' s)';
}

function healerRender() {
  healerRenderFrames();
  healerRenderSpells();
  healerRenderBars();
  healerRenderLegend();
  healerRenderRest();
  healerEnsureRaf();
}

// The battlefield runs on its own 60 fps loop so damage numbers and lunges are
// smooth between the 10 fps simulation ticks. It parks itself the moment the
// panel is off screen.
//
// The handle is MODULE-level, not a field on healerRuntime. It was on the
// runtime first, and every start leaked another parallel loop: stop() renders
// (arming a frame against runtime A), begin() then swaps in runtime B whose
// .raf is null and renders again (arming a second), and A's pending callback
// re-arms itself against B. Four „Jeszcze raz" presses measured 470 callbacks
// in 2 s — four chains, each stepping the animation clock, so combat text flew
// off at 4× speed and the canvas was redrawn four times a frame.
let hdRafId = null;
let hdRafLast = 0;

function healerRafLoop(ts) {
  hdRafId = null;
  const rt = healerRuntime;
  if (!rt) return;
  const arena = hdEl('hd-arena');
  if (!arena || !arena.offsetParent) return;   // panel off screen: park
  const dt = hdRafLast ? Math.min(120, ts - hdRafLast) : 16;
  hdRafLast = ts;
  hdStepFx(rt, dt);
  hdCtx = hdInitCanvas();
  hdDraw();
  hdRafId = requestAnimationFrame(healerRafLoop);
}

function healerEnsureRaf() {
  if (hdRafId != null || !healerRuntime) return;
  hdRafLast = 0;
  hdRafId = requestAnimationFrame(healerRafLoop);
}

function healerStopRaf() {
  if (hdRafId != null) { cancelAnimationFrame(hdRafId); hdRafId = null; }
  hdRafLast = 0;
}

function healerTick() {
  const rt = healerRuntime;
  if (!rt || !rt.playing) return;
  const st = rt.sim;

  const nextTick = st.tick + 1;
  let acts = null;
  if (rt.queued.length && rt.queuedTick === nextTick) {
    acts = rt.queued;
    rt.queued = [];
    rt.queuedTick = 0;
  }
  hdAdvanceTick(st, acts);
  hdConsumeFx(rt);
  healerRender();

  if (st.dead) {
    rt.endedReason = HD_SLOT_NAMES[st.deadWho] + ' zginął';
    finishHealerDungeonRound();
    return;
  }
  if (st.tick >= HD_MAX_TICKS) {
    rt.endedReason = 'limit czasu';
    finishHealerDungeonRound();
    return;
  }
  // Same self-correcting-but-no-backlog schedule as Tetris: a backgrounded tab
  // must resume in slow motion, never fire a burst of unwatched damage ticks.
  rt.nextTickAt += HD_TICK_MS;
  const behind = performance.now() - rt.nextTickAt;
  if (behind > 4 * HD_TICK_MS) rt.nextTickAt = performance.now() + HD_TICK_MS;
  rt.timer = setTimeout(healerTick, Math.max(0, rt.nextTickAt - performance.now()));
}

function stopHealerDungeonRound() {
  const rt = healerRuntime;
  if (rt && rt.timer) clearTimeout(rt.timer);
  healerStopRaf();
  const archive = (rt && rt.archiveMode) || false;
  healerRuntime = newHealerRuntime();
  healerRuntime.archiveMode = archive;
  healerRuntime.sim = hdInitState(1);
  const con = hdEl('hd-console');
  if (con) con.classList.remove('is-playing');
  const startBtn = hdEl('hd-start');
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Wejdź do lochu'; }
  const rest = hdEl('hd-rest');
  if (rest) rest.classList.remove('is-on');
  if (!healerRuntime.builtFrames) healerBuildFrames();
  healerRender();
}

function beginHealerDungeonRound(seed, options) {
  const opts = options || {};
  stopHealerDungeonRound();
  healerRuntime = newHealerRuntime();
  const rt = healerRuntime;
  rt.seed = Number(seed) || 1;
  rt.sim = hdInitState(rt.seed);
  rt.playing = true;
  rt.archiveMode = !!opts.archiveMode;
  rt.target = HD_TANK;
  healerBuildFrames();
  const con = hdEl('hd-console');
  if (con) con.classList.add('is-playing');   // hides the start/result card
  healerToggleHelp(false);
  const startBtn = hdEl('hd-start');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Loch trwa'; }
  const status = hdEl('hd-status');
  if (status) status.textContent = 'Utrzymaj piątkę przy życiu. 1 Odnowa · 2 Dziki Wzrost · 3 Uzdrawiający Dotyk · Q/W/E/R/T cel. Co 5. grupa to boss.';
  healerRender();
  rt.nextTickAt = performance.now() + HD_TICK_MS;
  rt.timer = setTimeout(healerTick, HD_TICK_MS);
}

async function startHealerDungeonRound() {
  const rt = healerRuntime;
  if (rt && (rt.playing || rt.submitting)) return;
  // Synchronously, BEFORE the first await: requestFullscreen() only works while
  // a user gesture is live, and awaiting payArcadeEntry() first would spend it.
  hdRequestFullscreen();
  // Phase 1 is arcade-only: there is no Edge Function to ask for a round, so
  // the seed is local. pay_arcade_entry still runs — it is the auth/game-type
  // check every other arcade game makes before a round.
  if (allGamesMode) {
    try { await payArcadeEntry('healer_dungeon'); }
    catch (e) { showToast('❌ Nie udało się wejść do gry.'); return; }
  }
  beginHealerDungeonRound((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0,
    { archiveMode: true });
}

async function finishHealerDungeonRound() {
  const rt = healerRuntime;
  if (!rt || rt.submitting) return;
  rt.playing = false;
  rt.submitting = true;
  if (rt.timer) clearTimeout(rt.timer);
  const con = hdEl('hd-console');
  if (con) con.classList.remove('is-playing');   // brings the result card back
  const rest = hdEl('hd-rest');
  if (rest) rest.classList.remove('is-on');
  healerRender();

  const score = Math.min(HD_MAX_SCORE, rt.sim.pullsCleared);
  const bosses = rt.sim.bossesKilled;
  const startBtn = hdEl('hd-start');
  const status = hdEl('hd-status');
  const title = hdEl('hd-startcard-title');
  const reason = rt.endedReason ? ' · ' + rt.endedReason : '';
  const bossTxt = bosses ? ' · bossów: ' + bosses : '';
  rt.submitting = false;
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Jeszcze raz'; }
  if (title) title.textContent = '☠️ ' + score + (score === 1 ? ' grupa' : score < 5 ? ' grupy' : ' grup');

  if (allGamesMode) {
    try {
      await recordArcadeScore('healer_dungeon', score);
      if (status) status.textContent = 'Wyczyszczone grupy: ' + score + bossTxt + reason + ' · zapisano w rankingu arcade!';
      loadArcadeScores('healer_dungeon');
    } catch (e) {
      if (status) status.textContent = 'Wyczyszczone grupy: ' + score + bossTxt + reason + ' (błąd zapisu).';
    }
    return;
  }
  if (status) status.textContent = 'Demo — wyczyszczone grupy: ' + score + bossTxt + reason + ' (nie zapisano).';
}

// ── Input ───────────────────────────────────────────────────────────────────
const HD_KEY_SPELL = { 1: HD_A_REJUV, 2: HD_A_WG, 3: HD_A_HT };
// R is a target key now that the party is five strong; drinking moved to D.
const HD_KEY_TARGET = { q: 0, w: 1, e: 2, r: 3, t: 4 };

function healerKeyDown(ev) {
  const rt = healerRuntime;
  const arena = hdEl('hd-arena');
  if (!arena || !arena.offsetParent) return;    // panel not on screen
  if (ev.key === 'Escape') {
    // Esc closes the help overlay first, then leaves the game — but only when
    // the browser is not in native fullscreen, where Esc is the browser's.
    if (hdEl('hd-help') && hdEl('hd-help').classList.contains('is-on')) { healerToggleHelp(false); return; }
    if (!document.fullscreenElement) healerLeaveGame();
    return;
  }
  if (!rt || !rt.playing) return;
  const k = ev.key;
  if (HD_KEY_SPELL[k] !== undefined) {
    ev.preventDefault();
    healerQueueAction(HD_KEY_SPELL[k], rt.target);
    return;
  }
  const low = typeof k === 'string' ? k.toLowerCase() : '';
  if (HD_KEY_TARGET[low] !== undefined) { ev.preventDefault(); healerSetTarget(HD_KEY_TARGET[low]); return; }
  if (low === 'd') { ev.preventDefault(); healerQueueAction(HD_A_DRINK, 0); return; }
  if (k === ' ') { ev.preventDefault(); healerQueueAction(HD_A_PULL, 0); }
}

function healerSetupOnce() {
  if (healerSetupOnce.done) return;
  healerSetupOnce.done = true;
  document.addEventListener('keydown', healerKeyDown);
  const spells = hdEl('hd-spells');
  if (spells) spells.addEventListener('click', ev => {
    const btn = ev.target.closest('.hd-spell');
    if (!btn) return;
    healerQueueAction(Number(btn.dataset.spell), (healerRuntime && healerRuntime.target) || HD_TANK);
  });
  const startBtn = hdEl('hd-start');
  if (startBtn) startBtn.addEventListener('click', startHealerDungeonRound);
  const drinkBtn = hdEl('hd-drink');
  if (drinkBtn) drinkBtn.addEventListener('click', () => healerQueueAction(HD_A_DRINK, 0));
  const pullBtn = hdEl('hd-pull-btn');
  if (pullBtn) pullBtn.addEventListener('click', () => healerQueueAction(HD_A_PULL, 0));
  const helpBtn = hdEl('hd-help-btn');
  if (helpBtn) helpBtn.addEventListener('click', () => healerToggleHelp());
  const helpClose = hdEl('hd-help-close');
  if (helpClose) helpClose.addEventListener('click', () => healerToggleHelp(false));
  const exitBtn = hdEl('hd-exit');
  if (exitBtn) exitBtn.addEventListener('click', healerLeaveGame);
}

healerSetupOnce();
stopHealerDungeonRound();
