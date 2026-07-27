// ── „Uzdrowiciel G6" (healer_dungeon) — WoW Classic resto-druid dungeon ──────
//
// You are the healer. Three-man party (tank / you / dps) walks an endless
// dungeon; every pull is harder than the last and the run ends the moment
// anyone hits 0 HP. Score = pulls cleared.
//
// The whole game is CLASSIC MANA MANAGEMENT — there is deliberately no dungeon
// timer. The pressure comes from the rest window between pulls SHRINKING with
// depth (hdRestTicks): pull 1 gives 15 s to sit and drink, pull 20+ gives 5 s.
// So you enter late pulls progressively more drained while the damage climbs,
// and whether you survive was decided by how efficiently you healed ten pulls
// ago. Three mechanics feed that, all straight out of Classic:
//   • 5-second rule — spirit regen is ZERO for 5 s after any mana spend.
//   • spell efficiency — Odnowa 2.44 HP/mana vs Uzdrawiający Dotyk 1.75.
//   • drinking is slow, and casting stands you up.
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
const HD_MAX_EVENTS = 4000;
const HD_MAX_SCORE = 100;        // mirrors the arcade.sql score cap

// Party slots.
const HD_TANK = 0, HD_HEAL = 1, HD_DPS = 2;
const HD_BASE_HP = [1400, 800, 900];

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
// and the healer was decorative. At 8‰/s a rest gives back a fraction, which is
// what forces the real decision — top the tank up, or sit and drink?
const HD_OOC_REGEN_PERMIL = 3;

// Spells. The HP-per-mana spread is the whole skill test: Odnowa is the
// efficient filler, Dziki Wzrost answers the AoE pulse, Uzdrawiający Dotyk is
// the panic button you cannot afford to lean on.
const HD_SP_REJUV = 0, HD_SP_WG = 1, HD_SP_HT = 2;
const HD_GCD_TICKS = 15;         // 1.5 s
const HD_COST = [90, 280, 240];
const HD_HT_CAST_TICKS = 25;     // 2.5 s
const HD_HT_HEAL = 420;
const HD_REJUV_PERIOD = 30;      // a tick every 3 s
const HD_REJUV_AMOUNTS = [55, 55, 55, 55];
const HD_WG_PERIOD = 20;         // a tick every 2 s
const HD_WG_AMOUNTS = [60, 50, 40, 30];   // decaying, like the real spell
const HD_WG_CD_TICKS = 80;       // 8 s

// Encounter script for pull n. Fixed shape; only the damage jitter and the
// spike target roll off the RNG.
// Party damage scales with the pull alongside pack HP, which holds fight length
// at a near-constant ~10 s all the way down. Difficulty must come from incoming
// damage vs your mana, not from fights that grind on for half a minute — the
// first tuning pass had pull 10 taking 35 s and a whole run over ten minutes.
const HD_PACK_HP_BASE = 900, HD_PACK_HP_PER_PULL = 240;
const HD_DPS_BASE = 90, HD_DPS_PER_PULL = 22, HD_DPS_PER_STR = 8;   // per second
// Incoming damage has to make healing mandatory from the very first pull. The
// first pass was far too soft: standing there casting NOTHING still cleared
// 7-10 pulls (against 16-18 for an active healer), because a pull only took
// ~13% of the tank's health. A pull now costs the tank ~25% of its pool while
// out-of-combat regen gives back almost nothing, so the deficit compounds and a
// no-heal run dies in a few pulls — but the load stays inside what Odnowa +
// Dziki Wzrost can actually sustain early, which a stiffer pass did not.
const HD_MELEE_PERIOD = 15;      // tank auto-attack every 1.5 s
const HD_MELEE_BASE = 42, HD_MELEE_PER_PULL = 5;
const HD_AOE_PERIOD = 70;        // raid pulse every 7 s
const HD_AOE_BASE = 18, HD_AOE_PER_PULL = 5;
const HD_SPIKE_PERIOD = 110;     // spike on a non-tank every 11 s
const HD_SPIKE_BASE = 60, HD_SPIKE_PER_PULL = 13;
// ~15 s to sit and drink at pull 1, down to 5 s past pull 20. This shrinking
// window IS the difficulty curve — no dungeon timer needed.
const HD_REST_BASE = 150, HD_REST_PER_PULL = 5, HD_REST_MIN = 50;

// Upgrades — 3 of these 5 are offered after every pull.
const HD_UP_INT = 0, HD_UP_SPIRIT = 1, HD_UP_STAM = 2, HD_UP_STR = 3, HD_UP_HASTE = 4;
const HD_UPGRADE_COUNT = 5;
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
function hdPartyDpsPerTick(st) {
  return Math.floor((HD_DPS_BASE + HD_DPS_PER_PULL * st.pull + HD_DPS_PER_STR * st.stats.str) / 10);
}
function hdGcdTicks(st) { return Math.max(9, HD_GCD_TICKS - st.stats.haste); }
function hdCastTicks(st) { return Math.max(15, HD_HT_CAST_TICKS - st.stats.haste); }
function hdRestTicks(pull) {
  return Math.max(HD_REST_MIN, HD_REST_BASE - HD_REST_PER_PULL * pull);
}
function hdMaxHpFor(st, slot) {
  return slot === HD_TANK ? HD_BASE_HP[HD_TANK] + 60 * st.stats.stam : HD_BASE_HP[slot];
}

function hdInitState(seed) {
  const st = {
    rngState: (Number(seed) >>> 0) || 1,
    tick: 0,
    phase: 'fight',          // 'fight' | 'rest' | 'dead'
    pull: 1,
    pullsCleared: 0,
    hp: [0, 0, 0],
    maxHp: [0, 0, 0],
    mana: 0,
    fsr: HD_FSR_TICKS,       // starts fully regenerating
    gcd: 0,
    cast: null,              // { spell, target, left }
    wgCd: 0,
    hots: [],                // { tgt, kind, left, next, idx }
    packHp: 0, packMax: 0,
    restLeft: 0,
    drinking: false,
    upgrades: [], upgradePicked: false,
    stats: { int: 0, spirit: 0, stam: 0, str: 0, haste: 0 },
    dead: false, deadWho: -1,
    meleeT: HD_MELEE_PERIOD, aoeT: HD_AOE_PERIOD, spikeT: HD_SPIKE_PERIOD,
    healingDone: 0, manaSpent: 0, overheal: 0,
  };
  for (let i = 0; i < 3; i += 1) { st.maxHp[i] = hdMaxHpFor(st, i); st.hp[i] = st.maxHp[i]; }
  st.mana = hdMaxMana(st);
  hdStartPull(st);
  return st;
}

function hdStartPull(st) {
  st.phase = 'fight';
  st.packMax = HD_PACK_HP_BASE + HD_PACK_HP_PER_PULL * st.pull;
  st.packHp = st.packMax;
  st.meleeT = HD_MELEE_PERIOD;
  st.aoeT = HD_AOE_PERIOD;
  st.spikeT = HD_SPIKE_PERIOD;
  st.drinking = false;
}

function hdBeginRest(st) {
  st.phase = 'rest';
  st.restLeft = hdRestTicks(st.pull);
  st.drinking = true;        // you sit down automatically; casting stands you up
  st.upgradePicked = false;
  // Three distinct upgrades drawn from the five. Small randomness, as asked.
  const pool = [];
  for (let i = 0; i < HD_UPGRADE_COUNT; i += 1) pool.push(i);
  st.upgrades = [];
  for (let i = 0; i < 3; i += 1) st.upgrades.push(pool.splice(hdRnd(st, pool.length), 1)[0]);
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

function hdDamage(st, slot, amount) {
  if (st.dead) return;
  st.hp[slot] -= amount;
  if (st.hp[slot] <= 0) {
    st.hp[slot] = 0;
    st.dead = true;
    st.deadWho = slot;
    st.phase = 'dead';
  }
}

function hdHeal(st, slot, amount) {
  if (st.hp[slot] <= 0) return;
  const room = st.maxHp[slot] - st.hp[slot];
  const applied = Math.min(room, amount);
  st.hp[slot] += applied;
  st.healingDone += applied;
  st.overheal += amount - applied;
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
  st.hots.push({ tgt, kind, left: len, next: period, idx: 0 });
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
  const tgt = target >= 0 && target <= 2 ? target : HD_TANK;
  if (spell === HD_SP_HT) {
    // The only cast-time spell: mana is committed up front, the heal lands when
    // the cast completes.
    hdSpend(st, HD_COST[HD_SP_HT]);
    st.cast = { spell, target: tgt, left: hdCastTicks(st) };
    st.gcd = hdGcdTicks(st);
    return true;
  }
  hdSpend(st, HD_COST[spell]);
  st.gcd = hdGcdTicks(st);
  if (spell === HD_SP_REJUV) {
    hdAddHot(st, tgt, HD_SP_REJUV);
  } else {
    for (let i = 0; i < 3; i += 1) hdAddHot(st, i, HD_SP_WG);
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
    hdHeal(st, h.tgt, hdHealAmt(st, table[h.idx]));
    h.idx += 1;
    h.left -= 1;
    h.next = h.kind === HD_SP_REJUV ? HD_REJUV_PERIOD : HD_WG_PERIOD;
    if (h.left <= 0) st.hots.splice(i, 1);
  }
}

function hdAdvanceTick(st, actions) {
  if (st.dead) return;
  st.tick += 1;

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
      hdHeal(st, st.cast.target, hdHealAmt(st, HD_HT_HEAL));
      st.cast = null;
    }
  }

  hdTickHots(st);
  if (st.dead) return;

  if (st.phase === 'rest') {
    // Out-of-combat health regen: generous early, nowhere near enough once the
    // window is down to eight seconds.
    // Applied once a second rather than every tick: the per-tick amount would
    // floor to a wildly different effective rate for each party member's pool.
    if (st.tick % 10 === 0) {
      for (let i = 0; i < 3; i += 1) {
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
  st.packHp -= hdPartyDpsPerTick(st);
  if (st.packHp <= 0) {
    st.packHp = 0;
    st.pullsCleared += 1;
    hdBeginRest(st);
    return;
  }

  st.meleeT -= 1;
  if (st.meleeT <= 0) {
    st.meleeT = HD_MELEE_PERIOD;
    hdDamage(st, HD_TANK, hdJitter(st, HD_MELEE_BASE + HD_MELEE_PER_PULL * st.pull));
    if (st.dead) return;
  }

  st.aoeT -= 1;
  if (st.aoeT <= 0) {
    st.aoeT = HD_AOE_PERIOD;
    const dmg = hdJitter(st, HD_AOE_BASE + HD_AOE_PER_PULL * st.pull);
    for (let i = 0; i < 3; i += 1) { hdDamage(st, i, dmg); if (st.dead) return; }
  }

  st.spikeT -= 1;
  if (st.spikeT <= 0) {
    st.spikeT = HD_SPIKE_PERIOD;
    const tgt = hdRnd(st, 2) === 0 ? HD_HEAL : HD_DPS;
    hdDamage(st, tgt, hdJitter(st, HD_SPIKE_BASE + HD_SPIKE_PER_PULL * st.pull));
  }
}
// ╚═══ PARITY BLOCK END ══════════════════════════════════════════════════════╝

// ── Presentation ────────────────────────────────────────────────────────────
const HD_SLOT_NAMES = ['Tank', 'Ty (Uzdrowiciel)', 'DPS'];
const HD_SLOT_SHORT = ['Tank', 'Ty', 'DPS'];
const HD_SLOT_ICONS = ['🛡️', '💚', '⚔️'];
const HD_SPELL_META = [
  { key: '1', icon: '🌿', name: 'Odnowa',              hint: 'HoT · 12 s' },
  { key: '2', icon: '🌳', name: 'Dziki Wzrost',        hint: 'cała drużyna' },
  { key: '3', icon: '✋', name: 'Uzdrawiający Dotyk',  hint: 'kanał 2,5 s' },
];
const HD_UPGRADE_META = [
  { icon: '🧠', name: 'Intelekt',      desc: 'Większa mana i mocniejsze leczenie.' },
  { icon: '💧', name: 'Duch',          desc: 'Szybsza regeneracja many poza walką.' },
  { icon: '🛡️', name: 'Wytrzymałość', desc: 'Tank ma więcej życia.' },
  { icon: '⚔️', name: 'Siła',          desc: 'Drużyna szybciej zabija — krótsze walki.' },
  { icon: '⚡', name: 'Pośpiech',      desc: 'Krótsze GCD i szybsze rzucanie.' },
];
// Office monsters, because the rest of the portal is an office.
const HD_PACK_NAMES = [
  'Stos faktur', 'Audyt Q4', 'Deadline', 'Ticket CF', 'Zebranie statusowe',
  'Korekta VAT', 'Nadgodziny', 'Excel bez formuł', 'Kontrola skarbowa', 'Poniedziałek',
];

function hdPackName(pull) {
  return HD_PACK_NAMES[(pull - 1) % HD_PACK_NAMES.length] + (pull > HD_PACK_NAMES.length ? ' +' + Math.floor((pull - 1) / HD_PACK_NAMES.length) : '');
}

function hdEl(id) { return document.getElementById(id); }
function hdPct(cur, max) { return max > 0 ? Math.max(0, Math.min(100, cur / max * 100)) : 0; }

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
  };
}

function healerQueueAction(a, t) {
  const rt = healerRuntime;
  if (!rt?.playing || rt.sim.dead) return;
  if (rt.eventLog.length >= HD_MAX_EVENTS) return;
  const tick = rt.sim.tick + 1;
  if (rt.queuedTick !== tick) { rt.queued = []; rt.queuedTick = tick; }
  rt.queued.push({ a, t: t | 0 });
  rt.eventLog.push({ tick, a, t: t | 0 });
}

function healerSetTarget(slot) {
  const rt = healerRuntime;
  if (!rt) return;
  rt.target = slot;
  healerRenderFrames();
}

function healerBuildFrames() {
  const wrap = hdEl('hd-frames');
  if (!wrap) return;
  wrap.replaceChildren();
  for (let i = 0; i < 3; i += 1) {
    const frame = document.createElement('button');
    frame.type = 'button';
    frame.className = 'hd-frame';
    frame.dataset.slot = String(i);
    frame.innerHTML =
      // Both labels ship; CSS picks one. Three frames across a phone cannot fit
      // „Ty (Uzdrowiciel)" and it ellipsised down to bare icons.
      '<div class="hd-frame-head"><span class="hd-frame-name">' + HD_SLOT_ICONS[i] +
      ' <span class="hd-name-long">' + HD_SLOT_NAMES[i] + '</span>' +
      '<span class="hd-name-short">' + HD_SLOT_SHORT[i] + '</span></span>' +
      '<span class="hd-frame-hp" data-hp></span></div>' +
      '<div class="hd-bar hd-bar-hp"><div class="hd-bar-fill" data-fill></div></div>' +
      '<div class="hd-hots" data-hots></div>';
    frame.addEventListener('click', () => healerSetTarget(i));
    wrap.appendChild(frame);
  }
  healerRuntime.builtFrames = true;
}

function healerRenderFrames() {
  const rt = healerRuntime;
  const st = rt?.sim;
  if (!st) return;
  const frames = document.querySelectorAll('#hd-frames .hd-frame');
  frames.forEach((frame, i) => {
    const pct = hdPct(st.hp[i], st.maxHp[i]);
    frame.classList.toggle('is-target', rt.target === i);
    frame.classList.toggle('is-dead', st.hp[i] <= 0);
    frame.classList.toggle('is-low', st.hp[i] > 0 && pct < 35);
    const fill = frame.querySelector('[data-fill]');
    if (fill) {
      fill.style.width = pct + '%';
      fill.className = 'hd-bar-fill' + (pct < 35 ? ' is-crit' : pct < 65 ? ' is-warn' : '');
    }
    const hp = frame.querySelector('[data-hp]');
    if (hp) hp.textContent = st.hp[i] + ' / ' + st.maxHp[i];
    const hots = frame.querySelector('[data-hots]');
    if (hots) {
      const mine = st.hots.filter(h => h.tgt === i);
      hots.replaceChildren();
      mine.forEach(h => {
        const pip = document.createElement('span');
        pip.className = 'hd-hot hd-hot-' + (h.kind === HD_SP_REJUV ? 'rejuv' : 'wg');
        pip.textContent = h.kind === HD_SP_REJUV ? '🌿' : '🌳';
        pip.title = (h.kind === HD_SP_REJUV ? 'Odnowa' : 'Dziki Wzrost') + ' — zostało ' + h.left;
        hots.appendChild(pip);
      });
    }
  });
}

function healerRenderSpells() {
  const st = healerRuntime?.sim;
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
  });
}

function healerRenderBars() {
  const st = healerRuntime?.sim;
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
      : regenning ? '💧 regeneracja'
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
      if (label) label.textContent = 'Uzdrawiający Dotyk → ' + HD_SLOT_SHORT[st.cast.target];
    } else {
      cast.classList.remove('is-on');
      const fill = cast.querySelector('[data-fill]');
      if (fill) fill.style.width = '0%';
    }
  }

  const packFill = hdEl('hd-pack-fill');
  if (packFill) packFill.style.width = hdPct(st.packHp, st.packMax) + '%';
  const packText = hdEl('hd-pack-text');
  if (packText) packText.textContent = st.phase === 'rest' ? 'przerwa' : st.packHp + ' / ' + st.packMax;
  const packName = hdEl('hd-pack-name');
  if (packName) packName.textContent = hdPackName(st.pull);

  const setStat = (id, v) => { const e = hdEl(id); if (e) e.textContent = v; };
  setStat('hd-score', String(st.pullsCleared));
  setStat('hd-pull', String(st.pull));
  setStat('hd-mana-stat', String(st.mana));
  setStat('hd-stats', '🧠' + st.stats.int + ' 💧' + st.stats.spirit + ' 🛡️' + st.stats.stam + ' ⚔️' + st.stats.str + ' ⚡' + st.stats.haste);
}

function healerRenderRest() {
  const st = healerRuntime?.sim;
  const panel = hdEl('hd-rest');
  if (!st || !panel) return;
  if (st.phase !== 'rest') { panel.classList.remove('is-on'); return; }
  panel.classList.add('is-on');

  const bar = hdEl('hd-rest-fill');
  if (bar) bar.style.width = hdPct(st.restLeft, hdRestTicks(st.pull)) + '%';
  const label = hdEl('hd-rest-label');
  if (label) label.textContent = 'Następna grupa za ' + (st.restLeft / 10).toFixed(1) + ' s';

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
      '<span class="hd-up-desc">' + meta.desc + '</span>';
    card.addEventListener('click', () => { healerQueueAction(HD_A_UPGRADE, i); });
    cards.appendChild(card);
  });
}

function healerRender() {
  healerRenderFrames();
  healerRenderSpells();
  healerRenderBars();
  healerRenderRest();
}

function healerTick() {
  const rt = healerRuntime;
  if (!rt?.playing) return;
  const st = rt.sim;

  const nextTick = st.tick + 1;
  let acts = null;
  if (rt.queued.length && rt.queuedTick === nextTick) {
    acts = rt.queued;
    rt.queued = [];
    rt.queuedTick = 0;
  }
  hdAdvanceTick(st, acts);
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
  if (rt?.timer) clearTimeout(rt.timer);
  const archive = rt?.archiveMode || false;
  healerRuntime = newHealerRuntime();
  healerRuntime.archiveMode = archive;
  healerRuntime.sim = hdInitState(1);
  const arena = hdEl('hd-arena');
  if (arena) arena.classList.remove('is-playing');
  const startBtn = hdEl('hd-start');
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Wejdź do lochu'; }
  const rest = hdEl('hd-rest');
  if (rest) rest.classList.remove('is-on');
  if (!healerRuntime.builtFrames) healerBuildFrames();
  healerRender();
}

function beginHealerDungeonRound(seed, options = {}) {
  stopHealerDungeonRound();
  healerRuntime = newHealerRuntime();
  const rt = healerRuntime;
  rt.seed = Number(seed) || 1;
  rt.sim = hdInitState(rt.seed);
  rt.playing = true;
  rt.archiveMode = !!options.archiveMode;
  rt.target = HD_TANK;
  healerBuildFrames();
  const arena = hdEl('hd-arena');
  if (arena) arena.classList.add('is-playing');
  // The rules are long and this arena is tall — together they push the party
  // frames below the fold on a laptop. Read them once, then they fold away and
  // the board scrolls into view the moment the run starts.
  const rules = hdEl('hd-rules');
  if (rules) rules.open = false;
  if (arena && arena.scrollIntoView) arena.scrollIntoView({ block: 'nearest' });
  const startBtn = hdEl('hd-start');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Loch trwa'; }
  const status = hdEl('hd-status');
  if (status) status.textContent = 'Utrzymaj drużynę przy życiu. 1 Odnowa · 2 Dziki Wzrost · 3 Uzdrawiający Dotyk · Q/W/E cel.';
  healerRender();
  rt.nextTickAt = performance.now() + HD_TICK_MS;
  rt.timer = setTimeout(healerTick, HD_TICK_MS);
}

async function startHealerDungeonRound() {
  const rt = healerRuntime;
  if (rt?.playing || rt?.submitting) return;
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
  const arena = hdEl('hd-arena');
  if (arena) arena.classList.remove('is-playing');
  const rest = hdEl('hd-rest');
  if (rest) rest.classList.remove('is-on');
  healerRender();

  const score = Math.min(HD_MAX_SCORE, rt.sim.pullsCleared);
  const startBtn = hdEl('hd-start');
  const status = hdEl('hd-status');
  const reason = rt.endedReason ? ' · ' + rt.endedReason : '';
  rt.submitting = false;
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Jeszcze raz'; }

  if (allGamesMode) {
    try {
      await recordArcadeScore('healer_dungeon', score);
      if (status) status.textContent = 'Wyczyszczone grupy: ' + score + reason + ' · zapisano w rankingu arcade!';
      loadArcadeScores('healer_dungeon');
    } catch (e) {
      if (status) status.textContent = 'Wyczyszczone grupy: ' + score + reason + ' (błąd zapisu).';
    }
    return;
  }
  if (status) status.textContent = 'Demo — wyczyszczone grupy: ' + score + reason + ' (nie zapisano).';
}

// ── Input ───────────────────────────────────────────────────────────────────
const HD_KEY_SPELL = { 1: HD_A_REJUV, 2: HD_A_WG, 3: HD_A_HT };
const HD_KEY_TARGET = { q: HD_TANK, w: HD_HEAL, e: HD_DPS };

function healerKeyDown(ev) {
  const rt = healerRuntime;
  if (!rt?.playing) return;
  const arena = hdEl('hd-arena');
  if (!arena || !arena.offsetParent) return;    // panel not on screen
  const k = ev.key;
  if (HD_KEY_SPELL[k] !== undefined) {
    ev.preventDefault();
    healerQueueAction(HD_KEY_SPELL[k], rt.target);
    return;
  }
  const low = typeof k === 'string' ? k.toLowerCase() : '';
  if (HD_KEY_TARGET[low] !== undefined) { ev.preventDefault(); healerSetTarget(HD_KEY_TARGET[low]); return; }
  if (low === 'r') { ev.preventDefault(); healerQueueAction(HD_A_DRINK, 0); return; }
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
    healerQueueAction(Number(btn.dataset.spell), healerRuntime?.target ?? HD_TANK);
  });
  const startBtn = hdEl('hd-start');
  if (startBtn) startBtn.addEventListener('click', startHealerDungeonRound);
  const drinkBtn = hdEl('hd-drink');
  if (drinkBtn) drinkBtn.addEventListener('click', () => healerQueueAction(HD_A_DRINK, 0));
  const pullBtn = hdEl('hd-pull-btn');
  if (pullBtn) pullBtn.addEventListener('click', () => healerQueueAction(HD_A_PULL, 0));
}

healerSetupOnce();
stopHealerDungeonRound();
