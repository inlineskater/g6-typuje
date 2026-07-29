// ── „Uzdrowiciel G6" (healer_dungeon) — WoW Classic resto-druid dungeon ──────
//
// You are the healer. A FIVE-man party (tank / you / three dps) walks an endless
// dungeon; every pull is harder than the last, EVERY FIFTH PULL IS A BOSS, and
// the run ends the moment anyone hits 0 HP. Score = pulls cleared. A pull runs
// until the pack is dead — it is never on a clock.
//
// ALL the pressure is INSIDE a single pull (2026-07-28 rework). There is no
// dungeon timer, no rest timer and no drinking: between pulls you sit as long
// as you like, health and mana come back to full, you pick a bonus, and you
// pull when YOU are ready. Removing drinking while making the rest window
// unlimited leaves no third option — out-of-combat regen would refill the bar
// anyway, so making the player watch it tick up is tedium, not a decision.
//
// What that buys is a clean per-pull skill check: one mana bar has to cover one
// fight. A pull runs ~21 s and spamming the cheap heal costs 60 mana/s, so a
// full 1200-mana bar is almost exactly one fight's worth — you get deeper only
// by healing more efficiently than that, not by healing more.
//   • 5-second rule — regen is ZERO for 5 s after any mana spend, so the gaps
//     you leave inside a fight are where your next fight's mana comes from.
//   • spell efficiency — Odnowa 2.44 HP/mana vs Uzdrawiający Dotyk 1.75.
//   • the party's own health pool is a buffer you are allowed to spend.
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
const HD_MAX_SCORE = 999;        // mirrors the arcade.sql score cap

// Party slots. Five, not three: three health bars is a party, five is a raid
// frame — and it makes the AoE pulse hit five targets, which is what turns the
// raid-wide spell from a nice-to-have into the spell the run is built around.
const HD_PARTY = 5;
const HD_TANK = 0, HD_HEAL = 1;
const HD_BASE_HP = [1500, 820, 900, 860, 780];

// Your resources. Every stat starts at 0 and only upgrades move it, so the
// opening pull is always identical whichever class you took.
const HD_BASE_MANA = 1500;
const HD_MANA_PER_HEAL_PT = 20;  // Moc leczenia widens the pool as well
const HD_HEAL_PCT_PER_PT = 4;    // ... and raises every heal
const HD_HP_PCT_PER_PT = 3;      // Życie: max HP for the WHOLE party, not just the tank
const HD_DPS_PER_PT = 11;        // Obrażenia: how fast the pack dies
const HD_REGEN_BASE = 40;        // mana per SECOND outside the 5 s window
const HD_FSR_TICKS = 50;         // the 5-second rule, in ticks
const HD_FSR_MIN = 25;           // ... which the Medytacja talent can shorten

// ── Spells ──────────────────────────────────────────────────────────────────
// THREE CLASSES (2026-07-29), each with the same three ROLES in the same three
// slots, so every readout, every keybind and every bot policy is class-generic:
//   slot 0 (Q) — the efficient filler you cast most of the time
//   slot 1 (W) — the raid-wide answer to the AoE pulse, on a cooldown
//   slot 2 (E) — the expensive panic button you cannot afford to lean on
// "Same power" is a HARD constraint and it is enforced numerically, not by
// feel: every class's filler sits at ~2.4 HP per mana, its raid spell at ~2.7
// across five targets, and its panic button at ~1.75. What differs is WHEN the
// healing lands, which is the entire identity of a healing class.
const HD_SP_FILL = 0, HD_SP_RAID = 1, HD_SP_BIG = 2;
const HD_SPELL_SLOTS = 3;
const HD_K_HOT = 0, HD_K_DIRECT = 1, HD_K_SHIELD = 2;

const HD_GCD_TICKS = 11;         // 1.1 s
const HD_GCD_MIN = 7;            // the Skupienie talent can shave it to 0.7 s

const HD_CLASSES = [
  {
    id: 'druid', name: 'Druid', icon: '🌿', portrait: '💚', color: '#16a34a',
    tag: 'HoT-y · lecz z wyprzedzeniem',
    blurb: 'Leczenie sączy się w czasie. Nic się nie marnuje, ale nic nie dzieje się od razu — rzucaj, zanim zaboli.',
    spells: [
      // The tick RATE is the druid's balance knob, not the totals: at one tick
      // every 3 s the HoT delivered the same HP per mana as the other two
      // fillers but arrived so late that spike damage killed the target first,
      // and the class measured ~20% behind on identical numbers. Ticking every
      // 2 s keeps the power promise byte-for-byte and closes the gap, because
      // what was wrong was LATENCY, never throughput.
      { key: 'Q', icon: '🌿', name: 'Odnowa', kind: HD_K_HOT, all: false,
        cost: 90, cast: 0, cd: 0, period: 20, amounts: [55, 55, 55, 55],
        hint: 'HoT · 1 cel · 4 tyknięcia co 2 s',
        does: 'Leczy powoli, ale nic się nie marnuje. Rzuć ZANIM cel oberwie — na pełnym pasku tyknięcia przelewają się w próżnię. Ponowne rzucenie na ten sam cel zaczyna HoT od nowa, nie dokłada drugiego.' },
      { key: 'W', icon: '🌳', name: 'Dziki Wzrost', kind: HD_K_HOT, all: true,
        cost: 330, cast: 0, cd: 80, period: 15, amounts: [60, 50, 40, 30],
        hint: 'HoT · CAŁA piątka · słabnie z każdym tyknięciem',
        does: 'Odpowiedź na falę obszarową: jeden rzut kryje wszystkich pięciu. Tyknięcia maleją (60→30), więc rzucaj go TUŻ PO fali, nie przed nią.' },
      { key: 'E', icon: '✋', name: 'Uzdrawiający Dotyk', kind: HD_K_DIRECT, all: false,
        cost: 240, cast: 16, cd: 0, amount: 420,
        hint: 'rzucanie 1,6 s · 1 cel · duże leczenie',
        does: 'Przycisk paniki. Najgorszy stosunek leczenia do many w całej księdze — trzymaj go na moment, w którym ktoś NIE PRZEŻYJE następnego ciosu. W trakcie rzucania nie zrobisz nic innego.' },
    ],
  },
  {
    id: 'priest', name: 'Kapłan', icon: '✨', portrait: '🙏', color: '#2563eb',
    tag: 'Tarcze · zatrzymaj cios, zanim padnie',
    blurb: 'Tarcza pochłania obrażenia zamiast je naprawiać — idealna na zapowiedziany czar bossa, zmarnowana, gdy nic nie przyjdzie.',
    spells: [
      { key: 'Q', icon: '🛡️', name: 'Tarcza Słowa', kind: HD_K_SHIELD, all: false,
        cost: 95, cast: 0, cd: 0, amount: 230, dur: 120,
        hint: 'pochłania 230 obrażeń · 1 cel · 12 s',
        does: 'Nie leczy — POCHŁANIA. Cios zdejmuje tarczę zamiast życia, więc na pełnym pasku nie jest zmarnowana. Ale tarcza, w którą nikt nie uderzy, znika po 12 s i liczy się jak przelanie. Nowa zastępuje starą.' },
      { key: 'W', icon: '✨', name: 'Modlitwa Uzdrowienia', kind: HD_K_DIRECT, all: true,
        cost: 320, cast: 0, cd: 80, amount: 175,
        hint: 'natychmiast · CAŁA piątka · leczy od ręki',
        does: 'Natychmiastowe leczenie całej piątki — w przeciwieństwie do HoT-ów działa OD RAZU, więc ratuje po fali, która już spadła. Na pełnych paskach przelewa się w całości.' },
      { key: 'E', icon: '🕊️', name: 'Wielkie Leczenie', kind: HD_K_DIRECT, all: false,
        cost: 265, cast: 20, cd: 0, amount: 470,
        hint: 'rzucanie 2 s · 1 cel · największe leczenie',
        does: 'Największe pojedyncze leczenie w grze i najdroższe za manę. Dwie sekundy rzucania to wieczność — zaczynaj je, PATRZĄC na pasek rzucania bossa, nie po fakcie.' },
    ],
  },
  {
    id: 'paladin', name: 'Paladyn', icon: '🔨', portrait: '⚜️', color: '#d97706',
    tag: 'Leczenie wprost · reaguj na to, co widzisz',
    blurb: 'Żadnych opóźnień i żadnych zapowiedzi: leczysz dokładnie tyle, ile trzeba, dokładnie wtedy, kiedy trzeba — jeśli zdążysz.',
    spells: [
      { key: 'Q', icon: '☀️', name: 'Święte Światło', kind: HD_K_DIRECT, all: false,
        cost: 125, cast: 14, cd: 0, amount: 300,
        hint: 'rzucanie 1,4 s · 1 cel · leczy od ręki',
        does: 'Zwykłe leczenie, ale z czasem rzucania dłuższym niż globalny cooldown — to ONO, a nie GCD, ogranicza Twoje tempo. Za to trafia dokładnie tam, gdzie brakuje życia, bez czekania na tyknięcia.' },
      { key: 'W', icon: '🔔', name: 'Błogosławieństwo', kind: HD_K_DIRECT, all: true,
        cost: 315, cast: 0, cd: 80, amount: 170,
        hint: 'natychmiast · CAŁA piątka · leczy od ręki',
        does: 'Natychmiastowe leczenie całej piątki, bez czasu rzucania — jedyny czar, którym odpowiesz na falę obszarową w tej samej sekundzie, w której spadła.' },
      { key: 'E', icon: '🤲', name: 'Ręka Opatrzności', kind: HD_K_DIRECT, all: false,
        cost: 320, cast: 0, cd: 150, amount: 560,
        hint: 'natychmiast · 1 cel · odnowienie 15 s',
        does: 'Ogromne leczenie BEZ czasu rzucania — jedyny ratunek, który zdąży po zapowiedzianym ciosie bossa. Płacisz za to 15-sekundowym odnowieniem: raz na walkę, więc wybierz moment.' },
    ],
  },
];

// ── Random talents ──────────────────────────────────────────────────────────
// The talent cards in every rest are drawn from this pool, so no two runs build
// the same healer. They stack, and every one changes something you feel at the
// keyboard rather than a background number.
const HD_PK_REGEN = 0, HD_PK_GCD = 1, HD_PK_CHEAP = 2, HD_PK_PHOENIX = 3;
const HD_PK_CDR = 4, HD_PK_WARD = 5, HD_PK_CRIT = 6, HD_PK_FURY = 7;
const HD_PK_FSR = 8, HD_PK_RAID = 9, HD_PK_HASTE = 10, HD_PK_REVIVE = 11;
const HD_PERK_COUNT = 12;
const HD_PK_REGEN_STEP = 10;     // +10 mana/s outside the 5 s window
const HD_PK_CHEAP_STEP = 7;      // −7% mana cost, floored at 60%
const HD_PK_CHEAP_FLOOR = 60;
const HD_PK_CDR_STEP = 15;       // raid spell cooldown −1,5 s, floored at 3 s
const HD_PK_CDR_FLOOR = 30;
const HD_PK_WARD_STEP = 6;       // −6% damage taken
const HD_PK_CRIT_STEP = 10;      // +10% chance a heal crits
const HD_PK_CRIT_MULT = 165;     // ... for +65%
const HD_PK_FURY_DPS = 25;       // +25 party dps
const HD_PK_FURY_DMG = 8;        // ... at +8% damage taken
const HD_PK_FSR_STEP = 5;        // the 5-second rule shortens by 0.5 s
const HD_PK_RAID_STEP = 18;      // the raid spell heals +18% more
const HD_PK_HASTE_STEP = 12;     // the panic button casts 12% faster
const HD_PK_HASTE_FLOOR = 50;
const HD_REVIVE_TICKS = 70;      // a fallen ally gets back up after 7 s
const HD_REVIVE_PCT = 35;        // ... at 35% health
const HD_DMG_TAKEN_FLOOR = 50;   // no stack of wards can halve the game twice

// ── Score ───────────────────────────────────────────────────────────────────
// Deliberately SMALL numbers (2026-07-29 rev 2): a four-digit score reads like
// a pinball machine and makes a one-pull difference invisible. Dozens, so the
// gap between a good run and a great one is a number you can hold in your head.
//   • DEPTH  — every second pull is worth one more point, bosses double.
//   • HEALING — effective healing only, then scaled by PRECISION: overhealing
//     is the healer's cardinal sin, so a wasted heal costs its own points.
//     Absorbed damage counts as effective; a shield that expires unused does
//     not (it lands in overheal, exactly like a heal into a full bar).
//   • TEMPO  — the rest is free and unlimited, which is right for the mechanic
//     and terrible for pace. So time pressure comes back as SCORE: pull within
//     5 s for both points, 10 s for one, later for none. Nobody is ever forced
//     to pull early; you just get paid for confidence.
const HD_SCORE_DEPTH_EVERY = 2;     // +1 point every second pull
const HD_SCORE_BOSS_MULT = 2;
const HD_SCORE_HEAL_PER_PT = 3000;  // 1 point per 3000 HP of effective healing
const HD_SCORE_TEMPO_MAX = 2;
const HD_SCORE_TEMPO_SEC = 5;       // ... losing one per 5 s spent resting

// Encounter script for pull n. Fixed shape; the damage jitter, the spike
// target, the pull's affix and the boss's kit roll off the RNG.
const HD_PACK_HP_BASE = 1800, HD_PACK_HP_PER_PULL = 470;
const HD_DPS_BASE = 90, HD_DPS_PER_PULL = 22;   // per second, at full strength
const HD_MELEE_PERIOD = 18;      // tank auto-attack every 1.8 s
const HD_MELEE_BASE = 86, HD_MELEE_PER_PULL = 21;
const HD_AOE_PERIOD = 80;        // raid pulse every 8 s, on all five
const HD_AOE_BASE = 31, HD_AOE_PER_PULL = 19;
const HD_SPIKE_PERIOD = 105;     // spike on a random non-tank every 10.5 s
const HD_SPIKE_BASE = 101, HD_SPIKE_PER_PULL = 40;
const HD_CLEAVE_PERIOD = 70;     // two different heroes every 7 s
const HD_CLEAVE_BASE = 64, HD_CLEAVE_PER_PULL = 24;
// With the tank down the pack turns on whoever is left, and a squishy is not
// built for it. This is the teeth of the "keep playing after a death" rule.
const HD_NO_TANK_MELEE_PCT = 135;

// ── Pull affixes ────────────────────────────────────────────────────────────
// One rolled per pull (never on pull 1, so the opening is always identical and
// the game can be learned). This is where "no two pulls are the same" comes
// from: the same four damage beats, re-weighted, so you have to re-read the
// fight instead of replaying a rotation.
// Fields are PERCENTAGES with 100 = unchanged; `period` fields scale the timer.
const HD_AFFIXES = [
  { id: 'none', name: 'Zwykła grupa', icon: '·', desc: 'Bez modyfikatora.' },
  { id: 'furious', name: 'Wściekła', icon: '😤', dmg: 122, hp: 85,
    desc: 'Bije o 22% mocniej, ale ma 15% mniej życia.' },
  { id: 'many', name: 'Liczna', icon: '👥', hp: 138,
    desc: 'Dużo więcej życia — walka trwa dłużej, a Twoja mana musi wystarczyć.' },
  { id: 'swift', name: 'Szybka', icon: '💨', meleePeriod: 72, cleavePeriod: 78,
    desc: 'Ciosy w tanka i przecięcia padają wyraźnie częściej.' },
  { id: 'draining', name: 'Wysysająca', icon: '🩸', drain: 55,
    desc: 'Co 6 s wysysa Ci 55 many — leczenie oszczędne przestaje być opcją.' },
  { id: 'explosive', name: 'Wybuchowa', icon: '💥', aoePeriod: 60, aoe: 88,
    desc: 'Fala obszarowa co 4,8 s zamiast co 8 s (za to nieco słabsza).' },
  { id: 'brutal', name: 'Brutalna', icon: '🗡️', melee: 142,
    desc: 'Same ciosy w tanka bolą o 42% mocniej — reszta bez zmian.' },
  { id: 'frail', name: 'Wątła', icon: '🍂', hp: 74, dmg: 118,
    desc: 'Ginie szybko, ale w tym czasie bije mocniej.' },
  { id: 'focused', name: 'Skupiona', icon: '🎯', spikePeriod: 65, spike: 118,
    desc: 'Znacznie częstsze i mocniejsze ciosy w losowego bohatera z tyłu.' },
];
const HD_AFFIX_DRAIN_PERIOD = 60;   // 6 s

// ── Bosses: every fifth pull ────────────────────────────────────────────────
// A boss is not "a pack with more HP". It is the only encounter that tells you
// what is coming and when, which is the one thing that makes pre-healing — and
// therefore the heal-prediction overlay — a real decision instead of a readout.
// Each boss draws a KIT of two abilities out of four at pull start, so the same
// named boss plays differently every time you meet it.
const HD_BOSS_EVERY = 5;
// ⚠️ NO HP BONUS AT ALL (2026-07-29 rev 2), down from 110%. Once a death stops
// ending the run, a longer fight is not just "more damage to heal" — it is more
// chances for a dps to fall, and every one that falls stretches the fight
// further. A boss with even a 10% HP bonus therefore became the wall the whole
// field died on: 88% of measured runs ended on a boss and the leaderboard held
// four distinct scores. At 100% it ended half of them, across seven depths.
// The boss is its telegraphed kit and its enrage, never its health pool.
const HD_BOSS_HP_MULT_PCT = 100;
const HD_BOSS_MELEE_PCT = 100;
const HD_BOSS_AOE_PCT = 110;
const HD_BOSS_CAST_FIRST = 55;     // first telegraph 5.5 s in
const HD_BOSS_CAST_PERIOD = 90;    // then one every 9 s
const HD_BOSS_CAST_TICKS = 35;     // 3.5 s of warning — three GCDs to react
const HD_CB_BUSTER = 0, HD_CB_NUKE = 1, HD_CB_FOCUS = 2, HD_CB_DRAIN = 3;
const HD_BOSS_ABILITIES = 4;
const HD_BOSS_KIT_SIZE = 2;
const HD_BOSS_BUSTER_BASE = 310, HD_BOSS_BUSTER_PER_PULL = 46;   // tank
const HD_BOSS_NUKE_BASE = 115, HD_BOSS_NUKE_PER_PULL = 16;       // whole party
const HD_BOSS_FOCUS_BASE = 245, HD_BOSS_FOCUS_PER_PULL = 40;     // one squishy
const HD_BOSS_DRAIN_BASE = 70, HD_BOSS_DRAIN_PER_PULL = 12;      // party + mana
const HD_BOSS_DRAIN_MANA = 420;
const HD_BOSS_ENRAGE_TICKS = 280;  // 28 s — just past a clean kill
const HD_BOSS_ENRAGE_PER_SEC = 5;  // +5 percentage points of damage per second

// Upgrades after every pull: THREE cards. The split between stats and random
// talents is itself rolled (2 + 1 or 1 + 2), so even the shape of the choice
// is not something you can plan around.
const HD_UP_HEAL = 0, HD_UP_HP = 1, HD_UP_DMG = 2;
const HD_UPGRADE_COUNT = 3;
const HD_UPGRADE_CHOICES = 3;
const HD_UP_STEP = [2, 2, 2];
const HD_UK_STAT = 0, HD_UK_PERK = 1;
const HD_TWO_PERK_PCT = 35;        // chance the hand is 1 stat + 2 talents

// Actions the runtime logs.
const HD_A_FILL = 0, HD_A_RAID = 1, HD_A_BIG = 2;
const HD_A_PULL = 3, HD_A_UPGRADE = 4;

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

function hdClass(st) { return HD_CLASSES[st.cls] || HD_CLASSES[0]; }
function hdSpell(st, slot) { return hdClass(st).spells[slot]; }
function hdAffix(st) { return HD_AFFIXES[st.affix] || HD_AFFIXES[0]; }
// Affix fields are optional; everything reads through this so a missing field
// is always "unchanged" and adding an affix can never need a call-site edit.
function hdAff(st, key) { const v = hdAffix(st)[key]; return v === undefined ? 100 : v; }

function hdCost(st, slot) {
  const pct = Math.max(HD_PK_CHEAP_FLOOR, 100 - HD_PK_CHEAP_STEP * st.perks[HD_PK_CHEAP]);
  return Math.max(1, Math.floor(hdSpell(st, slot).cost * pct / 100));
}
function hdSpellCd(st, slot) {
  const sp = hdSpell(st, slot);
  if (!sp.cd) return 0;
  if (slot !== HD_SP_RAID) return sp.cd;
  return Math.max(HD_PK_CDR_FLOOR, sp.cd - HD_PK_CDR_STEP * st.perks[HD_PK_CDR]);
}
// Szybkie Ręce shortens EVERY cast, not just the panic button's. Scoped to the
// panic button it was a dead card for the paladin, whose panic button is
// already instant — and a talent that does nothing for the class you picked is
// the worst thing a random card can be. Scoped to all casts it lands somewhere
// for everyone: the druid's and the priest's big heal, the paladin's filler.
function hdCastTicks(st, slot) {
  const base = hdSpell(st, slot).cast;
  if (!base) return 0;
  const pct = Math.max(HD_PK_HASTE_FLOOR, 100 - HD_PK_HASTE_STEP * st.perks[HD_PK_HASTE]);
  return Math.max(1, Math.floor(base * pct / 100));
}
// The slot this class actually casts, for the talent card's before → after.
function hdCastSlot(st) {
  for (let i = 0; i < HD_SPELL_SLOTS; i += 1) if (hdSpell(st, i).cast > 0) return i;
  return -1;
}
function hdGcdTicks(st) { return Math.max(HD_GCD_MIN, HD_GCD_TICKS - st.perks[HD_PK_GCD]); }
function hdFsrTicks(st) { return Math.max(HD_FSR_MIN, HD_FSR_TICKS - HD_PK_FSR_STEP * st.perks[HD_PK_FSR]); }

function hdMaxMana(st) { return HD_BASE_MANA + HD_MANA_PER_HEAL_PT * st.stats.heal; }
function hdHealAmt(st, base, slot) {
  let pct = 100 + HD_HEAL_PCT_PER_PT * st.stats.heal;
  if (slot === HD_SP_RAID) pct += HD_PK_RAID_STEP * st.perks[HD_PK_RAID];
  return Math.floor(base * pct / 100);
}
// The actual roll, as opposed to the predicted baseline: only this one may
// consume RNG, and only when the crit talent is held — so a player without it
// sees a bit-identical run to the one they would have seen before the talent
// existed, and hdIncomingHeal (which the raid frames call every frame) stays
// free of side effects.
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
// Full-strength party damage. What actually lands on the pack is scaled by how
// many of the four combatants are still standing — see hdPartyDpsPerTick.
function hdPartyDps(st) {
  return HD_DPS_BASE + HD_DPS_PER_PULL * st.pull + HD_DPS_PER_PT * st.stats.dmg
    + HD_PK_FURY_DPS * st.perks[HD_PK_FURY];
}
function hdLivingDps(st) {
  let n = 0;
  for (let i = 0; i < HD_PARTY; i += 1) if (i !== HD_HEAL && st.hp[i] > 0) n += 1;
  return n;
}
// A death is not the end of the run any more — it is a DPS LOSS. The pack keeps
// hitting just as hard while the fight it takes to kill gets longer, which is
// the death spiral that replaces the old instant game-over.
function hdPartyDpsPerTick(st) {
  return Math.floor(hdPartyDps(st) * hdLivingDps(st) / (HD_PARTY - 1) / 10);
}
function hdMaxHpFor(st, slot) {
  return Math.floor(HD_BASE_HP[slot] * (100 + HD_HP_PCT_PER_PT * st.stats.hp) / 100);
}
function hdIsBoss(pull) { return pull % HD_BOSS_EVERY === 0; }

// Everything that changes how hard the party is hit, in one place, so the boss
// telegraph's estimate and the hit it eventually lands agree exactly.
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

// ── Who is still standing ───────────────────────────────────────────────────
// Every random target picks out of the LIVING, so a corpse never soaks a hit
// that was meant to pressure the party. Returns -1 (and consumes no RNG) when
// there is nobody eligible, so the caller can skip the event cleanly.
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
// The pack's melee target: the tank while he stands, otherwise whoever is left
// — and it hurts more, because nobody else is built to eat it.
function hdMeleeTarget(st) {
  if (st.hp[HD_TANK] > 0) return HD_TANK;
  return hdPickLiving(st, false, -1);
}

function hdInitState(seed, cls) {
  const st = {
    rngState: (Number(seed) >>> 0) || 1,
    cls: Math.max(0, Math.min(HD_CLASSES.length - 1, Number(cls) || 0)),
    tick: 0,
    phase: 'fight',          // 'fight' | 'rest' | 'dead'
    pull: 1,
    pullsCleared: 0,
    bossesKilled: 0,
    deaths: 0,
    hp: [], maxHp: [],
    shield: [], shieldT: [],
    mana: 0,
    fsr: HD_FSR_TICKS,       // starts fully regenerating
    gcd: 0,
    cast: null,              // { slot, target, left, total }
    cd: [0, 0, 0],
    hots: [],                // { tgt, slot, left, next, idx }
    packHp: 0, packMax: 0,
    isBoss: false,
    affix: 0,
    bossKit: [],
    fightTick: 0,
    bossCast: null,          // { kind, tgt, left, total }
    bossCastT: 0,
    drainT: HD_AFFIX_DRAIN_PERIOD,
    upgrades: [], upgradePicked: false, pickedIdx: -1,
    stats: { heal: 0, hp: 0, dmg: 0 },
    perks: [],
    phoenix: 0,
    reviveCharges: 0,
    revives: [],             // { slot, left }
    dead: false, deadWho: -1,
    meleeT: HD_MELEE_PERIOD, aoeT: HD_AOE_PERIOD, spikeT: HD_SPIKE_PERIOD, cleaveT: HD_CLEAVE_PERIOD,
    healingDone: 0, manaSpent: 0, overheal: 0, absorbed: 0,
    score: 0, scPull: 0, scHeal: 0, scTempo: 0,
    pullHealed: 0, pullOverheal: 0, pullTempo: HD_SCORE_TEMPO_MAX,
    restTicks: 0,
    // Cosmetic event feed for the battlefield renderer. Cleared every tick and
    // NEVER read by the simulation, so a server transcription can drop it.
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
  // Pull 1 is never modified: the opening has to be identical every run or the
  // game cannot be learned.
  // ⚠️ NEITHER IS A BOSS. A boss already carries its own randomness (it draws
  // two abilities out of four), and stacking an affix on top double-dips: the
  // measured field died on pull 5 in almost every run that rolled „Brutalna"
  // (+42% melee) onto a boss whose fight is already twice as long, so the whole
  // leaderboard bucketed at 4 and 9. Affixes are for the pulls in between.
  st.affix = (st.pull === 1 || st.isBoss) ? 0 : hdRnd(st, HD_AFFIXES.length);
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
  // A boss draws two of its four abilities, so the same named boss is a
  // different fight every time you meet it.
  st.bossKit = [];
  if (st.isBoss) {
    const pool = [];
    for (let i = 0; i < HD_BOSS_ABILITIES; i += 1) pool.push(i);
    for (let i = 0; i < HD_BOSS_KIT_SIZE; i += 1) st.bossKit.push(pool.splice(hdRnd(st, pool.length), 1)[0]);
  }
  st.phoenix = st.perks[HD_PK_PHOENIX];       // cheat-death charges refresh per pull
  st.reviveCharges = st.perks[HD_PK_REVIVE];  // ... and so does the resurrection
  st.revives.length = 0;
  st.pullHealed = 0;
  st.pullOverheal = 0;
  // The tempo bonus for THIS pull is locked in the moment you pull, from how
  // long the rest before it lasted. Nothing decays once the fight starts.
  st.pullTempo = Math.max(0, HD_SCORE_TEMPO_MAX - Math.floor(st.restTicks / (10 * HD_SCORE_TEMPO_SEC)));
}

// The rest has NO timer. It ends when the player says so, and only after they
// have taken a bonus. What it does have is a price: every 5 s here costs a
// tempo point on the next pull.
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
  // Full restore — and that is also what picks the fallen back up. A death
  // costs you the rest of THAT pull, never the run.
  for (let i = 0; i < HD_PARTY; i += 1) st.hp[i] = st.maxHp[i];
  st.mana = hdMaxMana(st);
  // The hand's SHAPE is rolled too: usually two stats and a talent, sometimes
  // one stat and two talents, so you cannot plan around the choice either.
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
    st.stats.heal += step;                      // bigger pool + stronger heals
  } else if (up.i === HD_UP_HP) {
    st.stats.hp += step;
    for (let i = 0; i < HD_PARTY; i += 1) {
      const before = st.maxHp[i];
      st.maxHp[i] = hdMaxHpFor(st, i);
      if (st.hp[i] > 0) st.hp[i] += st.maxHp[i] - before;   // new HP arrives filled
    }
  } else {
    st.stats.dmg += step;
  }
  st.upgradePicked = true;
}

// Damage lands on the shield first. Absorbed damage counts as EFFECTIVE healing
// (it is the priest's entire output), which is also what keeps the precision
// term in the score honest across classes.
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

  // Serce Feniksa: one charge per stack, refreshed every pull, turns the
  // killing blow into 1 HP. It is the only thing in the game that undoes a
  // mistake, which is why it is a talent and not a stat.
  if (st.phoenix > 0) {
    st.phoenix -= 1;
    st.hp[slot] = 1;
    st.fx.push({ k: 'phoenix', slot: slot });
    return;
  }
  st.hp[slot] = 0;
  st.deaths += 1;
  st.fx.push({ k: 'death', slot: slot });
  // A corpse keeps nothing.
  for (let i = st.hots.length - 1; i >= 0; i -= 1) if (st.hots[i].tgt === slot) st.hots.splice(i, 1);
  st.shield[slot] = 0; st.shieldT[slot] = 0;
  if (st.cast && st.cast.target === slot) st.cast = null;

  // THE RUN ONLY ENDS WHEN THE HEALER DIES (2026-07-29). Losing an ally used to
  // be an instant game-over, which made one unlucky spike erase a whole run;
  // now it costs you their damage for the rest of the pull — the fight gets
  // longer while the incoming damage does not, so a death still hurts, it just
  // hurts as a spiral you can try to heal your way out of.
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

// A shield REPLACES whatever was on that target, exactly like Power Word:
// Shield. What is left when it expires is counted as overheal — a shield that
// never got hit was wasted mana in precisely the same way a heal into a full
// health bar was.
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
  st.fsr = 0;                 // the 5-second rule restarts on every spend
}
// Mana taken FROM you (the draining affix, the boss's budget cut). It does not
// restart the five-second rule — you did not cast anything.
function hdBurnMana(st, amount) {
  const lost = Math.min(st.mana, amount);
  st.mana -= lost;
  if (lost > 0) st.fx.push({ k: 'drain', amt: lost });
}

// Refreshing a HoT from the same slot on the same target replaces it, exactly
// like re-applying Rejuvenation in game.
function hdAddHot(st, tgt, slot) {
  if (st.hp[tgt] <= 0) return;
  for (let i = st.hots.length - 1; i >= 0; i -= 1) {
    if (st.hots[i].tgt === tgt && st.hots[i].slot === slot) st.hots.splice(i, 1);
  }
  const sp = hdSpell(st, slot);
  st.hots.push({ tgt: tgt, slot: slot, left: sp.amounts.length, next: sp.period, idx: 0 });
}

// ── Heal prediction ─────────────────────────────────────────────────────────
// Everything already in flight toward a target: the direct cast you are mid-way
// through plus every remaining tick of every HoT on them. This is what the
// green ghost segment on the raid frame draws, and it is the readout that tells
// you "they look low but they are already covered — spend the GCD elsewhere".
// Shields are NOT in here: they are already applied, and the frame paints them
// as their own block over the health bar.
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

// The raw (pre-jitter) size of a boss ability, so the telegraph and the hit it
// eventually lands agree. One function, so a new ability cannot be added to the
// cast bar without also being predictable.
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
  if (p.tgt >= 0) return p.tgt === slot ? p.amt : 0;   // single-target ability
  return p.amt;                                        // whole party
}
// Does this bar survive the telegraphed cast? Health plus what is already
// flying at them plus what their shield will eat, against the pending hit.
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

// What a spell actually does once it goes off — shared by the instant path and
// by the cast bar completing, so a cast and an instant of the same kind can
// never drift apart.
function hdResolveSpell(st, slot, target) {
  const sp = hdSpell(st, slot);
  const from = sp.all ? 0 : target;
  const to = sp.all ? HD_PARTY - 1 : target;
  for (let i = from; i <= to; i += 1) {
    if (st.hp[i] <= 0) continue;              // never spend output on a corpse
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
  // Single-target spells refuse to go off on a corpse — that is a wasted GCD
  // and a wasted cast bar, and the player never means it.
  if (!sp.all && st.hp[tgt] <= 0) return false;
  // Mana is committed up front on a cast, exactly as it is on an instant.
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
  // Pulling is BLOCKED until a bonus has been taken — „always allow to select
  // the bonus" means it can never be auto-picked out from under the player.
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
    // expired unused — that was wasted mana, and the score says so
    st.overheal += st.shield[i];
    st.pullOverheal += st.shield[i];
    st.shield[i] = 0;
  }
}

// Wskrzeszenie: the fallen ally gets back up part-way through the fight.
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

// Bank the points for a pull the moment it is cleared, so the live score is
// always the score you would submit if you died right now.
function hdBankPull(st) {
  const depth = (1 + Math.floor((st.pull - 1) / HD_SCORE_DEPTH_EVERY))
    * (st.isBoss ? HD_SCORE_BOSS_MULT : 1);
  const total = st.pullHealed + st.pullOverheal;
  const precision = total > 0 ? Math.floor(st.pullHealed * 100 / total) : 100;
  const healPts = Math.floor(Math.floor(st.pullHealed / HD_SCORE_HEAL_PER_PT) * precision / 100);
  st.scPull += depth;
  st.scHeal += healPts;
  st.scTempo += st.pullTempo;
  st.score = st.scPull + st.scHeal + st.scTempo;
  st.fx.push({ k: 'clear', depth: depth, heal: healPts, tempo: st.pullTempo, precision: precision });
}

function hdAdvanceTick(st, actions) {
  if (st.dead) return;
  st.tick += 1;
  st.fx.length = 0;

  if (actions) for (let i = 0; i < actions.length; i += 1) hdApplyAction(st, actions[i].a, actions[i].t);
  if (st.dead) return;

  // ── resources ──
  if (st.gcd > 0) st.gcd -= 1;
  for (let i = 0; i < HD_SPELL_SLOTS; i += 1) if (st.cd[i] > 0) st.cd[i] -= 1;
  const maxMana = hdMaxMana(st);
  const fsrMax = hdFsrTicks(st);
  if (st.fsr >= fsrMax) {
    // Spirit regen only OUTSIDE the five-second window — the whole point.
    st.mana = Math.min(maxMana, st.mana + hdRegenPerTick(st));
  }
  // Counted AFTER the check, so the spend tick itself is inside the window and
  // regen resumes on exactly the 50th tick (5.0 s), not the 49th.
  if (st.fsr < fsrMax) st.fsr += 1;

  // ── cast bar ──
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

  // Resting: nothing ticks down and nothing advances except the clock the tempo
  // bonus is measured against.
  if (st.phase === 'rest') { st.restTicks += 1; return; }

  hdTickRevives(st);

  // ── the pull ──
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

  // ── boss telegraph ── resolved before the auto-attacks so a buster and a
  // melee swing in the same tick land in the order the cast bar promised.
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
        // The target is chosen NOW, at the start of the cast, so the raid frame
        // can show who is about to be hit for the whole 3.5 s of warning. A
        // telegraph you cannot aim at is just a delay.
        let tgt = -1;
        if (kind === HD_CB_BUSTER) tgt = hdMeleeTarget(st);
        else if (kind === HD_CB_FOCUS) tgt = hdPickLiving(st, true, -1);
        if ((kind === HD_CB_BUSTER || kind === HD_CB_FOCUS) && tgt < 0) tgt = HD_HEAL;
        st.bossCast = { kind: kind, tgt: tgt, left: HD_BOSS_CAST_TICKS, total: HD_BOSS_CAST_TICKS };
        st.fx.push({ k: 'cast', kind: kind, tgt: tgt });
      }
    }
  }

  // ── the draining affix ──
  if (hdAffix(st).drain) {
    st.drainT -= 1;
    if (st.drainT <= 0) {
      st.drainT = HD_AFFIX_DRAIN_PERIOD;
      hdBurnMana(st, hdAffix(st).drain);
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
    // Jitter is rolled PER TARGET, not once for the pulse. One shared roll left
    // all five bars in lockstep, so the party read as a single health pool and
    // the answer was always the same spell; independent rolls fan the bars out
    // and make you actually choose who is worst off.
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

  // Cleave — two DIFFERENT living party members, anyone including the tank.
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

// ── Presentation ────────────────────────────────────────────────────────────
// Slot 1 is you, and what „you" are depends on the class picked before the
// run, so the label is a function rather than a constant.
const HD_SLOT_NAMES = ['Tank', 'Ty', 'Łotr', 'Łucznik', 'Mag'];
const HD_SLOT_SHORT = ['Tank', 'Ty', 'Łotr', 'Łucz.', 'Mag'];
const HD_SLOT_ICONS = ['🛡️', '💚', '🗡️', '🏹', '🔮'];
const HD_SLOT_COLORS = ['#64748b', '#22c55e', '#eab308', '#84cc16', '#3b82f6'];
const HD_TARGET_KEYS = ['1', '2', '3', '4', '5'];

function hdSlotName(st, i) {
  if (i !== HD_HEAL) return HD_SLOT_NAMES[i];
  return 'Ty (' + (st ? hdClass(st).name : 'Druid') + ')';
}
function hdSlotIcon(st, i) {
  if (i !== HD_HEAL) return HD_SLOT_ICONS[i];
  return st ? hdClass(st).icon : HD_SLOT_ICONS[HD_HEAL];
}

const HD_UPGRADE_META = [
  { icon: '💚', name: 'Moc leczenia', desc: 'Każdy czar leczy więcej i masz większą pulę many.' },
  { icon: '❤️', name: 'Życie',        desc: 'Więcej zdrowia dla CAŁEJ drużyny — większy bufor na błąd.' },
  { icon: '⚔️', name: 'Obrażenia',    desc: 'Drużyna szybciej zabija — krótsze walki, mniej ciosów.' },
];

// The random third card. Order matches the HD_PK_* constants.
// Twelve of them, order matching the HD_PK_* constants. The pool is this big on
// purpose: with three cards a rest and a rolled stat/talent split, a twelve-deep
// pool is what stops two runs from converging on the same healer.
const HD_PERK_META = [
  { icon: '💧', name: 'Duch Lasu',     desc: 'Regeneracja many poza 5-sekundowym oknem rośnie.' },
  { icon: '⚡', name: 'Skupienie',     desc: 'Krótszy globalny cooldown — więcej czarów na sekundę.' },
  { icon: '🪙', name: 'Oszczędność',   desc: 'Wszystkie czary kosztują mniej many.' },
  { icon: '🪶', name: 'Serce Feniksa', desc: 'Raz na grupę śmiertelny cios zostawia cel przy 1 HP.' },
  { icon: '🔁', name: 'Bystrość',      desc: 'Krótsze odnowienie czaru na całą drużynę.' },
  { icon: '🛡️', name: 'Wiara',        desc: 'Cała drużyna dostaje mniej obrażeń.' },
  { icon: '✨', name: 'Iskra Życia',   desc: 'Część leczenia trafia krytycznie za +65%.' },
  { icon: '🔥', name: 'Furia',         desc: 'Drużyna bije mocniej, ale sama też obrywa mocniej.' },
  { icon: '🧘', name: 'Medytacja',     desc: 'Krótsza przerwa w regeneracji po rzuceniu czaru.' },
  { icon: '🌟', name: 'Moc Grupowa',   desc: 'Czar na całą drużynę leczy wyraźnie więcej.' },
  { icon: '🖐️', name: 'Szybkie Ręce',  desc: 'Ratunkowy czar rzuca się szybciej.' },
  { icon: '✝️', name: 'Wskrzeszenie',  desc: 'Poległy sojusznik wstaje po 7 s — raz na grupę.' },
];

// Office monsters, because the rest of the portal is an office.
const HD_PACK_NAMES = [
  'Stos faktur', 'Audyt Q4', 'Deadline', 'Ticket CF', 'Zebranie statusowe',
  'Korekta VAT', 'Nadgodziny', 'Excel bez formuł', 'Kontrola skarbowa', 'Poniedziałek',
];
const HD_PACK_GLYPHS = ['🧾', '📊', '⏰', '🎫', '💬', '📉', '🌙', '📗', '🏛️', '☕'];

const HD_BOSS_NAMES = ['Prezes Zarządu', 'Audytor Zewnętrzny', 'Zamknięcie Roku', 'Migracja ERP', 'Rada Nadzorcza'];
const HD_BOSS_GLYPHS = ['👔', '🕵️', '📕', '🖥️', '⚖️'];
// Order matches HD_CB_*. A boss draws two of these per pull, so the same named
// boss is a different fight every time.
const HD_CAST_META = [
  { name: 'Cios Decyzyjny',  desc: 'ogromny cios w jeden cel',       icon: '💥' },
  { name: 'Reorganizacja',   desc: 'obrażenia w CAŁĄ drużynę',       icon: '🌪️' },
  { name: 'Ocena Roczna',    desc: 'druzgocący cios w jednego z tyłu', icon: '📋' },
  { name: 'Cięcie Budżetu',  desc: 'zabiera manę + rani wszystkich',  icon: '✂️' },
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
// WIDE (2026-07-29 rev 2): the raid frames moved off their own column and onto
// the board as a compact WoW-style overlay, so the battlefield now gets the
// whole width. `HD_HEX_Y0` also drops the first row well down the canvas,
// reserving a clean top strip for that overlay on the left and the enemy's
// name + health bar on the right — the two things that used to be a DOM column
// and a red bar under the board.
const HD_CS_W = 1040, HD_CS_H = 480, HD_MAX_DPR = 2;
const HD_HEX_COLS = 15, HD_HEX_ROWS = 6;
const HD_HEX_W = 62;
const HD_HEX_R = HD_HEX_W / Math.sqrt(3);      // circumradius of a pointy-top hex
const HD_HEX_SQUASH = 0.85;                    // the top-down foreshortening
const HD_HEX_VSTEP = HD_HEX_R * 1.5 * HD_HEX_SQUASH;
const HD_HEX_X0 = 44, HD_HEX_Y0 = 190;
const HD_TOP_STRIP = 150;                      // everything above this belongs to the HUD

// Formation. Tank alone on the front line, the two casters in the back column,
// the melee/ranged dps fanned out between them — the same "who is exposed" read
// as a real battlefield. Cells are spaced at least two grid steps apart in one
// axis: sprites are 42 px wide on a 62 px column with rows only 33 px apart, so
// diagonal neighbours (an earlier [0,3]+[1,4] pairing) visibly overlap.
// ⚠️ The top-row cell also has to clear the raid-frame overlay: at [2,0] the
// rogue's nameplate sat under it, which is why he stands at column 3.
const HD_PARTY_CELL = [[4, 2], [0, 1], [3, 0], [2, 4], [0, 3]];
const HD_MOB_CELL = [[10, 2], [13, 0], [13, 4], [12, 1], [12, 3], [14, 2]];
const HD_BOSS_CELL = [12, 2];

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

// The same split, in HP rather than in bodies — so every enemy stack can carry
// its OWN health bar over its head instead of the party reading one pooled bar
// off in the corner. The pack is still a single pool in the sim; this only
// decides how that pool is presented, and it depletes stack by stack in exactly
// the order hdMobCounts empties them, so bar and body count never disagree.
function hdMobHpSplit(st) {
  if (st.isBoss) return [{ hp: st.packHp, max: st.packMax }];
  const n = hdMobStacks(st.pull);
  const per = st.packMax / n;
  const lost = st.packMax - st.packHp;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const stackLost = Math.max(0, Math.min(per, lost - i * per));
    out.push({ hp: Math.max(0, Math.round(per - stackLost)), max: Math.max(1, Math.round(per)) });
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
// Shorter than the 900 it started at: once the board takes its own aspect
// rather than stretching, a 900-tall portrait console had ~300 px of slack.
const HD_VIEW_PORT = [440, 780];

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
  // The column just changed size, so a dragged frame position may now be
  // outside it — re-clamp rather than stranding the frames off screen.
  hdApplyFramesPos();
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
  healerRenderClassPicker();
  healerRender();
  healerMaybeTutorial();
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
  // Pale stone floor. The whole console went light in 2026-07-28; a dark arena
  // inside white chrome read as two different apps bolted together.
  const g = ctx.createLinearGradient(0, 0, 0, HD_CS_H);
  g.addColorStop(0, '#f2f5f9');
  g.addColorStop(0.55, '#e8edf4');
  g.addColorStop(1, '#dde4ee');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, HD_CS_W, HD_CS_H);

  // a boss arena is lit red — you can tell what you walked into before you read
  // a single label
  if (st && st.isBoss && st.phase === 'fight') {
    const rg = ctx.createRadialGradient(HD_CS_W * 0.66, HD_CS_H * 0.5, 20, HD_CS_W * 0.66, HD_CS_H * 0.5, 340);
    rg.addColorStop(0, 'rgba(220,38,38,.16)');
    rg.addColorStop(1, 'rgba(220,38,38,0)');
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
      ctx.fillStyle = (c + r) % 2 ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.24)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(100,116,139,.26)';
      ctx.stroke();
    }
  }

  // the tile the currently targeted party member stands on
  if (rt && st && st.hp[rt.target] > 0) {
    const p = hdPartyXY(rt.target);
    hdHexPath(ctx, p[0], p[1], 0.94);
    ctx.fillStyle = 'rgba(217,119,6,.20)';
    ctx.fill();
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // and the tiles a boss ability is about to land on. Single-target abilities
  // carry their victim on the cast itself (chosen when the cast STARTS), so the
  // marker is always under the hero who is actually going to be hit — including
  // when the tank is down and the boss has picked someone else.
  if (st && st.bossCast) {
    const single = st.bossCast.tgt >= 0;
    const pulse = 0.20 + 0.16 * Math.sin((rt ? rt.time : 0) / 110);
    for (let i = 0; i < HD_PARTY; i += 1) {
      if (single && i !== st.bossCast.tgt) continue;
      if (st.hp[i] <= 0) continue;
      const p = hdPartyXY(i);
      hdHexPath(ctx, p[0], p[1], 0.94);
      ctx.fillStyle = 'rgba(220,38,38,' + pulse.toFixed(3) + ')';
      ctx.fill();
      ctx.strokeStyle = 'rgba(220,38,38,.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
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

  ctx.fillStyle = 'rgba(30,41,59,.22)';
  ctx.beginPath();
  ctx.ellipse(x, y + 4, 21 * s, 7 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  if (o.glow > 0) {
    ctx.fillStyle = 'rgba(34,197,94,' + (0.42 * o.glow).toFixed(3) + ')';
    ctx.beginPath();
    ctx.ellipse(x, y - 16 * s, 30 * s, 26 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const top = y - 6 - h;
  const pg = ctx.createLinearGradient(0, top, 0, top + h);
  pg.addColorStop(0, o.color);
  pg.addColorStop(1, o.color2 || 'rgba(15,23,42,.42)');
  hdRoundRect(ctx, x - w / 2, top, w, h, 7 * s);
  ctx.fillStyle = pg;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = o.flash > 0 ? '#dc2626' : 'rgba(30,41,59,.5)';
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
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(71,85,105,.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.font = '800 ' + Math.round(10 * s) + 'px system-ui, sans-serif';
    ctx.fillText(String(o.count), x + w / 2 - bw / 2 + 4, y + bh / 2 - 4);
  }

  // ── WoW-style nameplate above the head ──
  // Name, then a health bar carrying the same three readings the raid frame
  // does: current health, the incoming-heal ghost stacked on the missing part,
  // and the pending boss hit eaten out of the right edge. Being able to read
  // "who is about to die" without looking away from the battlefield is the
  // whole reason the plates exist.
  if (o.hpPct !== undefined) {
    // Enemies get one too (2026-07-29 rev 3) — one pooled bar off in the corner
    // told you the pack was dying but never WHICH stack, so the field read as
    // scenery. `o.foe` only changes the palette; everything else is shared, so
    // an enemy plate can never drift from a party plate.
    const bw = (o.barW || 66) * s, bh = (o.foe ? 9 : 7) * s, by = top - 12 * s;
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.fillRect(x - bw / 2 - 1, by - 1, bw + 2, bh + 2);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(x - bw / 2, by, bw, bh);
    const hpW = bw * o.hpPct / 100;
    if (o.foe) {
      const fg = ctx.createLinearGradient(x - bw / 2, 0, x + bw / 2, 0);
      fg.addColorStop(0, '#991b1b');
      fg.addColorStop(1, '#ef4444');
      ctx.fillStyle = fg;
    } else {
      ctx.fillStyle = o.hpPct < 35 ? '#dc2626' : o.hpPct < 65 ? '#d97706' : '#16a34a';
    }
    ctx.fillRect(x - bw / 2, by, hpW, bh);
    if (o.predPct > 0) {
      ctx.fillStyle = 'rgba(74,222,128,.78)';
      ctx.fillRect(x - bw / 2 + hpW, by, bw * Math.min(o.predPct, 100 - o.hpPct) / 100, bh);
    }
    // An absorb shield sits ON TOP of the bar, running past its right end if it
    // is bigger than the missing health — the way every game draws absorbs,
    // because a shield is extra effective health, not restored health.
    if (o.shieldPct > 0) {
      const sw = bw * Math.min(o.shieldPct, 60) / 100;
      ctx.fillStyle = 'rgba(125,211,252,.85)';
      ctx.fillRect(x - bw / 2 + Math.min(hpW, bw - sw), by, sw, bh);
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - bw / 2 + Math.min(hpW, bw - sw) + 0.5, by + 0.5, sw - 1, bh - 1);
    }
    if (o.dmgPct > 0) {
      const dw = bw * Math.min(o.dmgPct, o.hpPct) / 100;
      ctx.fillStyle = o.doomed ? 'rgba(255,255,255,.85)' : 'rgba(127,29,29,.66)';
      ctx.fillRect(x - bw / 2 + hpW - dw, by, dw, bh);
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - bw / 2 + hpW - dw, by);
      ctx.lineTo(x - bw / 2 + hpW - dw, by + bh);
      ctx.stroke();
    }
    ctx.strokeStyle = o.doomed ? '#dc2626' : o.foe ? 'rgba(127,29,29,.8)' : 'rgba(51,65,85,.6)';
    ctx.lineWidth = o.doomed ? 1.8 : 1;
    ctx.strokeRect(x - bw / 2, by, bw, bh);
    ctx.lineWidth = 1;

    // Enemies print the number inside the bar: with several stacks alive you
    // want to know which one is nearly down, and a 66 px bar cannot show that
    // difference on its own.
    if (o.foe && o.hpText) {
      ctx.fillStyle = '#0f172a';
      ctx.font = '800 ' + Math.round((o.big ? 11 : 8.5) * s) + 'px system-ui, sans-serif';
      ctx.fillText(o.hpText, x, by + bh / 2);
    }

    if (o.label) {
      ctx.fillStyle = '#1e293b';
      ctx.font = '800 ' + Math.round(11 * s) + 'px system-ui, sans-serif';
      ctx.fillText(o.label, x, by - 8 * s);
    }
  } else if (o.label) {
    ctx.fillStyle = '#334155';
    ctx.font = '800 11px system-ui, sans-serif';
    ctx.fillText(o.label, x, top - 12);
  }

  ctx.restore();
}

// ── Who you are fighting ────────────────────────────────────────────────────
// The header line only. Health moved ONTO the enemies themselves (rev 3): one
// pooled bar told you the pack was dying but never WHICH stack, so the field
// read as scenery — see the `foe` plates in hdDrawUnit. What is left here is
// the context you cannot paint on a sprite: what this pack is called, how deep
// you are, whether it enraged, and the affix making this fight awkward.
function hdDrawEnemyHeader(ctx, rt, st) {
  if (!st || st.phase === 'rest') return;
  const boss = st.isBoss;
  const cx = HD_CS_W - 250;
  const y = 62;

  const enrage = hdEnragePct(st) - 100;
  const name = (boss ? '☠️ ' : hdPackGlyph(st.pull) + ' ') + hdPackName(st.pull) +
    (enrage > 0 ? '  🔥 WŚCIEKŁOŚĆ +' + enrage + '%' : '');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = enrage > 0 ? '#dc2626' : boss ? '#991b1b' : '#334155';
  ctx.font = '800 ' + (boss ? 19 : 16) + 'px system-ui, sans-serif';
  ctx.fillText(name, cx, y);

  ctx.font = '800 12.5px system-ui, sans-serif';
  ctx.fillStyle = '#64748b';
  let sub = 'GRUPA ' + st.pull;
  const aff = hdAffix(st);
  if (aff.id !== 'none') sub += '   ' + aff.icon + ' ' + aff.name.toUpperCase();
  ctx.fillStyle = aff.id === 'none' ? '#64748b' : '#b45309';
  ctx.fillText(sub, cx, y + 20);
}

function hdDrawBossCast(ctx, rt, st) {
  if (!st.bossCast) return;
  const p = hdMobXY(0, true);
  const meta = HD_CAST_META[st.bossCast.kind];
  const done = 1 - st.bossCast.left / st.bossCast.total;
  // Wider than the old 168 px and stacked in three rows — name, bar, effect —
  // because four abilities means four descriptions and „druzgocący cios w
  // jednego z tyłu" simply does not fit inside a bar that also has to show a
  // countdown. The whole card sits clear of the enemy health bar above it.
  const w = 260, h = 14, x = p[0] - w / 2, y = p[1] - 112;

  hdRoundRect(ctx, x - 6, y - 20, w + 12, h + 38, 6);
  ctx.fillStyle = 'rgba(255,255,255,.97)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(220,38,38,.85)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineWidth = 1;

  ctx.fillStyle = '#991b1b';
  ctx.font = '800 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(meta.icon + ' ' + meta.name, p[0], y - 10);

  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(x, y, w, h);
  const cg = ctx.createLinearGradient(x, 0, x + w, 0);
  cg.addColorStop(0, '#b91c1c');
  cg.addColorStop(1, '#ef4444');
  ctx.fillStyle = cg;
  ctx.fillRect(x, y, w * done, h);
  ctx.strokeStyle = 'rgba(185,28,28,.9)';
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  ctx.fillStyle = '#0f172a';
  ctx.font = '800 11px system-ui, sans-serif';
  ctx.fillText((st.bossCast.left / 10).toFixed(1) + ' s', p[0], y + h / 2);

  ctx.fillStyle = '#7f1d1d';
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.fillText(meta.desc, p[0], y + h + 10);
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
    const incoming = dead ? 0 : hdIncomingHeal(st, i);
    const dmg = dead ? 0 : hdIncomingDamage(st, i);
    units.push({
      row: HD_PARTY_CELL[i][1],
      x: p[0], y: p[1] + (dead ? 0 : bob * Math.sin((rt.time + i * 420) / 520) * 2),
      glyph: dead ? '💀' : hdSlotIcon(st, i),
      color: HD_SLOT_COLORS[i],
      lunge: rt.lunge[i] > 0 ? Math.sin((1 - rt.lunge[i] / 300) * Math.PI) * 18 : 0,
      flash: Math.max(0, rt.flash[i] / 260),
      glow: Math.max(0, rt.glow[i] / 320),
      dead: dead,
      count: 1,
      hpPct: hpPct,
      predPct: hdPct(incoming, st.maxHp[i]),
      dmgPct: hdPct(dmg, st.maxHp[i]),
      shieldPct: dead ? 0 : hdPct(st.shield[i], st.maxHp[i]),
      doomed: dmg > 0 && !hdSurvives(st, i),
      label: HD_SLOT_SHORT[i] + (rt.target === i ? ' ◄' : ''),
    });
  }

  if (!resting) {
    const counts = hdMobCounts(st);
    const hps = hdMobHpSplit(st);
    for (let i = 0; i < counts.length; i += 1) {
      const p = hdMobXY(i, st.isBoss);
      const cell = st.isBoss ? HD_BOSS_CELL : HD_MOB_CELL[i % HD_MOB_CELL.length];
      const enraged = st.isBoss && hdEnragePct(st) > 100;
      const hp = hps[i] || { hp: 0, max: 1 };
      const alive = counts[i] > 0;
      units.push({
        row: cell[1],
        x: p[0], y: p[1] + bob * Math.sin((rt.time + i * 330) / 460) * 2,
        glyph: hdPackGlyph(st.pull),
        color: st.isBoss ? (enraged ? '#dc2626' : '#991b1b') : '#7f1d3a',
        lunge: rt.mobLunge[i] > 0 ? -Math.sin((1 - rt.mobLunge[i] / 320) * Math.PI) * 20 : 0,
        flash: Math.max(0, rt.mobFlash[i] / 240),
        glow: 0,
        dead: !alive,
        count: counts[i],
        big: st.isBoss,
        // Its OWN health bar, over its own head. A corpse gets none.
        foe: true,
        hpPct: alive ? hdPct(hp.hp, hp.max) : undefined,
        hpText: alive ? String(hp.hp) : '',
        barW: st.isBoss ? 130 : 60,
        predPct: 0, dmgPct: 0, shieldPct: 0, doomed: false,
        // No name plate over the boss's head: its name and its enrage live on
        // the header line at the top. The plate used to sit exactly where the
        // cast card is drawn, so the two overlapped every time the boss did the
        // one thing you most need to read.
        label: '',
      });
    }
  }

  units.sort((a, b) => a.row - b.row);
  for (let i = 0; i < units.length; i += 1) hdDrawUnit(ctx, units[i]);

  if (!resting) hdDrawEnemyHeader(ctx, rt, st);
  if (!resting && st.isBoss) hdDrawBossCast(ctx, rt, st);

  // floating combat text
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < rt.num.length; i += 1) {
    const n = rt.num[i];
    const t = 1 - n.life / n.max;
    ctx.globalAlpha = Math.max(0, 1 - t * t);
    ctx.font = '800 ' + n.size + 'px system-ui, sans-serif';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(255,255,255,.92)';
    ctx.strokeText(n.text, n.x, n.y - t * 34);
    ctx.fillStyle = n.col;
    ctx.fillText(n.text, n.x, n.y - t * 34);
  }
  ctx.globalAlpha = 1;

  if (resting) {
    ctx.fillStyle = 'rgba(241,245,249,.78)';
    ctx.fillRect(0, 0, HD_CS_W, HD_CS_H);
    ctx.fillStyle = '#1d4ed8';
    ctx.font = '800 20px system-ui, sans-serif';
    ctx.fillText('Przerwa — pełne życie i mana', HD_CS_W / 2, HD_CS_H / 2 - 12);
    ctx.fillStyle = '#475569';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.fillText(hdIsBoss(st.pull + 1) ? '☠️ Następny: BOSS — ' + hdPackName(st.pull + 1)
      : 'Następna grupa: ' + hdPackName(st.pull + 1), HD_CS_W / 2, HD_CS_H / 2 + 14);
  }

  if (st.dead) {
    ctx.fillStyle = 'rgba(254,226,226,.82)';
    ctx.fillRect(0, 0, HD_CS_W, HD_CS_H);
    ctx.fillStyle = '#991b1b';
    ctx.font = '800 22px system-ui, sans-serif';
    ctx.fillText('☠️ ' + hdSlotName(st, st.deadWho) + ' zginął', HD_CS_W / 2, HD_CS_H / 2);
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
    builtSpells: -1,
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
        text: '-' + f.amt, col: heavy ? '#b91c1c' : '#dc2626',
        size: heavy ? 18 : 13, life: heavy ? 1300 : 1000, max: heavy ? 1300 : 1000,
      });
      rt.flash[f.slot] = 260;
      if (f.src === 'melee' || f.src === 'buster') rt.mobLunge[0] = 320;
      if (f.src === 'spike') rt.mobLunge[1] = 320;
      if (f.src === 'cleave') rt.mobLunge[2 % rt.mobLunge.length] = 320;
      if (f.src === 'aoe') rt.shake = Math.max(rt.shake, 220);
      if (heavy) rt.shake = Math.max(rt.shake, 380);
    } else if (f.k === 'heal') {
      const p = hdPartyXY(f.slot);
      const big = f.spell === HD_SP_BIG;
      rt.num.push({
        x: p[0] + (Math.random() * 20 - 10), y: p[1] - 56,
        text: (f.crit ? '✦+' : '+') + f.amt, col: f.crit ? '#065f46' : big ? '#15803d' : '#16a34a',
        size: f.crit ? 19 : big ? 17 : 12, life: 900, max: 900,
      });
      rt.glow[f.slot] = 320;
    } else if (f.k === 'absorb') {
      // Absorbed damage reads as a heal that happened before the hit, which is
      // exactly what it is — but in the shield's own blue so you can tell the
      // priest's output from everyone else's at a glance.
      const p = hdPartyXY(f.slot);
      rt.num.push({
        x: p[0] + (Math.random() * 20 - 10), y: p[1] - 52,
        text: '⛊' + f.amt, col: '#0369a1', size: 13, life: 850, max: 850,
      });
    } else if (f.k === 'shield') {
      rt.glow[f.slot] = 260;
    } else if (f.k === 'phoenix') {
      const p = hdPartyXY(f.slot);
      rt.num.push({
        x: p[0], y: p[1] - 62, text: '🪶 1 HP!', col: '#b45309', size: 20, life: 1500, max: 1500,
      });
      rt.shake = Math.max(rt.shake, 420);
    } else if (f.k === 'death') {
      // A death is no longer the end of the run, so it needs to READ as a real
      // event rather than as a fade-out — you have to notice you just lost a
      // quarter of the party's damage.
      const p = hdPartyXY(f.slot);
      rt.num.push({
        x: p[0], y: p[1] - 58, text: '☠️ ' + HD_SLOT_SHORT[f.slot], col: '#7f1d1d',
        size: 20, life: 1700, max: 1700,
      });
      rt.shake = Math.max(rt.shake, 460);
    } else if (f.k === 'revive') {
      const p = hdPartyXY(f.slot);
      rt.num.push({
        x: p[0], y: p[1] - 58, text: '✝️ wstaje!', col: '#15803d', size: 18, life: 1400, max: 1400,
      });
      rt.glow[f.slot] = 420;
    } else if (f.k === 'drain') {
      rt.num.push({
        x: hdPartyXY(HD_HEAL)[0], y: hdPartyXY(HD_HEAL)[1] - 66,
        text: '−' + f.amt + ' many', col: '#1d4ed8', size: 15, life: 1100, max: 1100,
      });
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

// ── Clicking a hero on the battlefield ──────────────────────────────────────
// Mapping a click back into canvas coordinates has to undo TWO transforms: the
// console's CSS scale (which getBoundingClientRect already accounts for, since
// it reports the post-transform box) and the canvas's own `object-fit: contain`
// letterboxing, which getBoundingClientRect does NOT — the element box is not
// the drawn box.
function hdCanvasPoint(ev) {
  const cv = hdEl('hd-stage');
  if (!cv) return null;
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const fit = Math.min(r.width / HD_CS_W, r.height / HD_CS_H);
  const drawW = HD_CS_W * fit, drawH = HD_CS_H * fit;
  const ox = r.left + (r.width - drawW) / 2;
  const oy = r.top + (r.height - drawH) / 2;
  return [(ev.clientX - ox) / fit, (ev.clientY - oy) / fit];
}

// Nearest living party member to the click, within a generous radius — the
// sprites are small once the console scales down, so hit boxes are forgiving.
function hdHeroAt(x, y) {
  let best = -1, bestD = 58 * 58;
  for (let i = 0; i < HD_PARTY; i += 1) {
    const p = hdPartyXY(i);
    const dx = x - p[0], dy = y - (p[1] - 22);   // aim at the body, not the feet
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function healerStageClick(ev) {
  const rt = healerRuntime;
  if (!rt || !rt.sim) return;
  const pt = hdCanvasPoint(ev);
  if (!pt) return;
  const slot = hdHeroAt(pt[0], pt[1]);
  if (slot >= 0 && rt.sim.hp[slot] > 0) healerSetTarget(slot);
}

// ── Raid frames ─────────────────────────────────────────────────────────────
// Stacked one over the other, WoW-style. Each carries, in this order: the name,
// the health bar with the incoming-heal ghost and the incoming-boss-hit marker
// painted on it, your own mana bar (healer row only) and the buff row.
function healerBuildFrames() {
  const wrap = hdEl('hd-frames');
  if (!wrap) return;
  wrap.replaceChildren();
  // The drag handle. A dedicated grip rather than dragging the frames
  // themselves: a frame is a click-to-target button, and distinguishing a click
  // from a drag on it by a pixel threshold is exactly the kind of ambiguity
  // that eats a heal at the worst moment.
  const grip = document.createElement('div');
  grip.className = 'hd-frames-grip';
  grip.title = 'Przeciągnij, żeby przesunąć ramki · dwuklik = z powrotem do rogu';
  grip.innerHTML = '<span>⠿</span> ramki drużyny';
  hdSetupFramesDrag(grip);
  wrap.appendChild(grip);
  for (let i = 0; i < HD_PARTY; i += 1) {
    const frame = document.createElement('button');
    frame.type = 'button';
    frame.className = 'hd-frame';
    frame.dataset.slot = String(i);
    const st = healerRuntime && healerRuntime.sim;
    frame.innerHTML =
      '<div class="hd-frame-fill" data-fill></div>' +
      '<div class="hd-pred-heal" data-pred></div>' +
      '<div class="hd-pred-dmg" data-dmg></div>' +
      '<div class="hd-shield" data-shield></div>' +
      '<div class="hd-frame-top">' +
        '<span class="hd-frame-name">' + hdSlotIcon(st, i) +
          ' <span class="hd-name-long">' + hdSlotName(st, i) + '</span>' +
          '<span class="hd-name-short">' + HD_SLOT_SHORT[i] + '</span></span>' +
        '<span class="hd-frame-hp" data-hp></span>' +
        '<span class="hd-pred-num" data-prednum></span>' +
        '<span class="hd-hots" data-hots></span>' +
        '<span class="hd-frame-key">' + HD_TARGET_KEYS[i] + '</span>' +
      '</div>' +
      (i === HD_HEAL ? '<div class="hd-frame-mana"><i data-mana></i></div>' : '');
    frame.addEventListener('click', () => healerSetTarget(i));
    wrap.appendChild(frame);
  }
  healerRuntime.builtFrames = true;
  hdApplyFramesPos();
}

// ── Movable raid frames ─────────────────────────────────────────────────────
// Every MMO lets you drag your unit frames, because where they sit is a
// personal thing: some people want them next to the action, some want them out
// of the way of the boss. Drag the ⠿ grip; the position is remembered per
// browser, and a double-click on the grip puts them back in the corner.
//
// ⚠️ Pointer deltas must be divided by the console's CSS scale. `.hd-console`
// is a fixed virtual size squeezed into the viewport by one transform, so one
// screen pixel of mouse movement is `1 / --hd-scale` console pixels — without
// this the frames slide several times too fast on a small window and lag on a
// large one.
const HD_FRAMES_POS_KEY = 'hd_frames_pos_v1';
const HD_FRAMES_HOME = [10, 18];
let hdFramesPos = null;

function hdConsoleScale() {
  const con = hdEl('hd-console');
  const v = con && parseFloat(con.style.getPropertyValue('--hd-scale'));
  return v && v > 0.05 ? v : 1;
}

function hdLoadFramesPos() {
  if (hdFramesPos) return hdFramesPos;
  try {
    const raw = JSON.parse(localStorage.getItem(HD_FRAMES_POS_KEY) || 'null');
    if (raw && isFinite(raw.x) && isFinite(raw.y)) hdFramesPos = [raw.x, raw.y];
  } catch (e) { /* private mode */ }
  if (!hdFramesPos) hdFramesPos = HD_FRAMES_HOME.slice();
  return hdFramesPos;
}

function hdSaveFramesPos() {
  try { localStorage.setItem(HD_FRAMES_POS_KEY, JSON.stringify({ x: hdFramesPos[0], y: hdFramesPos[1] })); }
  catch (e) { /* private mode */ }
}

// Clamped so the block can never be dragged off its own column and stranded.
// ⚠️ The clamp is SKIPPED while the column has no size yet. healerBuildFrames
// runs before the panel has laid out, and clamping against a 0×0 column pinned
// the frames to 0,0 and then wrote that back as the desired position — so the
// home offset was silently eaten on every fresh load.
function hdApplyFramesPos() {
  const wrap = hdEl('hd-frames');
  const col = hdEl('hd-stagecol');
  if (!wrap || !col) return;
  const pos = hdLoadFramesPos();
  if (col.clientWidth > 0 && col.clientHeight > 0 && wrap.offsetWidth > 0) {
    const maxX = Math.max(0, col.clientWidth - wrap.offsetWidth);
    const maxY = Math.max(0, col.clientHeight - wrap.offsetHeight);
    hdFramesPos = [Math.max(0, Math.min(maxX, pos[0])), Math.max(0, Math.min(maxY, pos[1]))];
  }
  wrap.style.left = hdFramesPos[0] + 'px';
  wrap.style.top = hdFramesPos[1] + 'px';
}

function healerResetFramesPos() {
  hdFramesPos = HD_FRAMES_HOME.slice();
  hdSaveFramesPos();
  hdApplyFramesPos();
}

function hdSetupFramesDrag(grip) {
  let start = null;
  grip.addEventListener('pointerdown', ev => {
    // Portrait puts the frames back in normal flow, where there is nothing to
    // drag them to.
    const con = hdEl('hd-console');
    if (con && con.classList.contains('is-portrait')) return;
    ev.preventDefault();
    const pos = hdLoadFramesPos();
    start = { px: ev.clientX, py: ev.clientY, x: pos[0], y: pos[1], scale: hdConsoleScale() };
    // Capture is a nicety — it keeps the drag alive when the cursor outruns the
    // grip — but it throws on a pointerId the browser does not consider active,
    // and losing the whole drag to that would be a silly way to fail.
    try { grip.setPointerCapture(ev.pointerId); } catch (e) { /* drag still works */ }
    grip.classList.add('is-dragging');
  });
  grip.addEventListener('pointermove', ev => {
    if (!start) return;
    hdFramesPos = [
      start.x + (ev.clientX - start.px) / start.scale,
      start.y + (ev.clientY - start.py) / start.scale,
    ];
    hdApplyFramesPos();
  });
  const end = () => {
    if (!start) return;
    start = null;
    grip.classList.remove('is-dragging');
    hdSaveFramesPos();
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', healerResetFramesPos);
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
    if (fill) fill.style.width = pct + '%';

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
    // A shield is on that side too, so hdSurvives() owns the answer and the
    // frame just draws it.
    const lethal = dmg > 0 && !hdSurvives(st, i);
    const dmgEl = frame.querySelector('[data-dmg]');
    if (dmgEl) {
      dmgEl.style.left = Math.max(0, pct - dmgPct) + '%';
      dmgEl.style.width = Math.max(0, dmgPct) + '%';
      dmgEl.classList.toggle('is-on', dmg > 0);
      dmgEl.classList.toggle('is-lethal', lethal);
    }

    // The absorb block: laid over the bar starting at current health, and — if
    // the shield is bigger than the gap — pushed back so it always stays fully
    // visible. A shield is extra effective health, not restored health.
    const shield = dead ? 0 : st.shield[i];
    const shEl = frame.querySelector('[data-shield]');
    if (shEl) {
      const shPct = Math.min(45, hdPct(shield, st.maxHp[i]));
      shEl.style.left = Math.min(pct, 100 - shPct) + '%';
      shEl.style.width = shPct + '%';
      shEl.classList.toggle('is-on', shield > 0);
    }

    const num = frame.querySelector('[data-prednum]');
    if (num) {
      let txt = '';
      if (incoming > 0) txt = '+' + incoming;
      if (shield > 0) txt = (txt ? txt + ' ' : '') + '⛊' + shield;
      if (dmg > 0) txt = (txt ? txt + ' ' : '') + '−' + dmg;
      num.textContent = txt;
      num.className = 'hd-pred-num' + (lethal ? ' is-lethal' : incoming > 0 || shield > 0 ? ' is-heal' : '');
    }
    frame.classList.toggle('is-doomed', lethal);

    // A percentage, not "1500 / 1500": the frames are compact now and a healer
    // reads a bar's SHAPE anyway — the number is a tiebreak between two bars
    // that look equally low, which a percent answers in three characters.
    const hp = frame.querySelector('[data-hp]');
    if (hp) hp.textContent = dead ? '☠️' : Math.ceil(pct) + '%';

    const mana = frame.querySelector('[data-mana]');
    if (mana) mana.style.width = hdPct(st.mana, hdMaxMana(st)) + '%';

    const hots = frame.querySelector('[data-hots]');
    if (hots) {
      const mine = st.hots.filter(h => h.tgt === i);
      const casting = st.cast && (hdSpell(st, st.cast.slot).all || st.cast.target === i);
      const sig = mine.map(h => h.slot + ':' + h.left).join('|') + (casting ? '|c' : '');
      if (hots.dataset.sig !== sig) {
        hots.dataset.sig = sig;
        hots.replaceChildren();
        mine.forEach(h => {
          const sp = hdSpell(st, h.slot);
          const pip = document.createElement('span');
          pip.className = 'hd-hot hd-hot-' + (h.slot === HD_SP_FILL ? 'rejuv' : 'wg');
          pip.textContent = sp.icon + Math.ceil(h.left * sp.period / 10);
          pip.title = sp.name + ' — ' + h.left + ' tyknięć';
          hots.appendChild(pip);
        });
        if (casting) {
          const pip = document.createElement('span');
          pip.className = 'hd-hot hd-hot-cast';
          pip.textContent = hdSpell(st, st.cast.slot).icon;
          pip.title = hdSpell(st, st.cast.slot).name + ' w locie';
          hots.appendChild(pip);
        }
      }
    }
  });
}

// What one cast of this spell is worth, in HP, right now — summed over every
// tick and every target it touches. This is the number the „HP na manę" figure
// on the button divides by the cost, and it is also what makes „same power"
// checkable at a glance across the three classes.
function hdSpellOutput(st, slot) {
  const sp = hdSpell(st, slot);
  let per = 0;
  if (sp.kind === HD_K_HOT) {
    for (let i = 0; i < sp.amounts.length; i += 1) per += hdHealAmt(st, sp.amounts[i]);
  } else {
    per = hdHealAmt(st, sp.amount);
  }
  return per * (sp.all ? HD_PARTY : 1);
}

// The spellbook is rebuilt whenever the class changes — the buttons ARE the
// class, so nothing about them can be static markup.
function healerBuildSpells() {
  const wrap = hdEl('hd-spells');
  const st = healerRuntime && healerRuntime.sim;
  if (!wrap || !st) return;
  wrap.replaceChildren();
  for (let slot = 0; slot < HD_SPELL_SLOTS; slot += 1) {
    const sp = hdSpell(st, slot);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hd-spell';
    btn.dataset.spell = String(slot);
    // Four lines, in the order a player asks the questions: what is it called,
    // WHAT DOES IT DO, what shape is it, what does it cost. The „does" line is
    // the one that was missing — a name and a HP/mana ratio does not tell you
    // that a HoT is wasted on a full bar or that a shield is not.
    btn.title = sp.name + ' — ' + sp.does;
    btn.innerHTML =
      '<span class="hd-spell-slot">' + sp.icon +
        '<span class="hd-spell-sweep" data-sweep></span>' +
        '<span class="hd-spell-key">' + sp.key + '</span></span>' +
      '<span class="hd-spell-name">' + sp.name + '</span>' +
      '<span class="hd-spell-hint">' + sp.hint + '</span>' +
      '<span class="hd-spell-eff" data-eff>—</span><span class="hd-spell-cd" data-cd></span>';
    wrap.appendChild(btn);
  }
  healerRuntime.builtSpells = st.cls;
}

function healerRenderSpells() {
  const st = healerRuntime && healerRuntime.sim;
  if (!st) return;
  if (healerRuntime.builtSpells !== st.cls) healerBuildSpells();
  const gcdTotal = hdGcdTicks(st);
  document.querySelectorAll('#hd-spells .hd-spell').forEach(btn => {
    const slot = Number(btn.dataset.spell);
    const cost = hdCost(st, slot);
    const poor = st.mana < cost;

    // Everything that can stop this button working, as one countdown: the
    // global cooldown, the in-flight cast, and this spell's own cooldown. The
    // sweep shows whichever has longest to run — that is exactly the question
    // "can I press this right now".
    let left = st.gcd, total = gcdTotal;
    if (st.cast && st.cast.left > left) { left = st.cast.left; total = st.cast.total; }
    if (st.cd[slot] > left) { left = st.cd[slot]; total = hdSpellCd(st, slot); }

    btn.classList.toggle('is-poor', poor);
    btn.classList.toggle('is-cd', left > 0);
    btn.classList.toggle('is-ready', !poor && left <= 0);

    const sweep = btn.querySelector('[data-sweep]');
    if (sweep) sweep.style.setProperty('--sweep', (total > 0 ? left / total : 0).toFixed(3) + 'turn');

    const cdEl = btn.querySelector('[data-cd]');
    // Only the long waits get a number; a 1.1 s GCD ticking digits every frame
    // is noise, and the sweep already says "not yet".
    if (cdEl) cdEl.textContent = left > gcdTotal ? (left / 10).toFixed(1) : '';

    const effEl = btn.querySelector('[data-eff]');
    if (effEl) {
      const out = hdSpellOutput(st, slot);
      effEl.textContent = cost + ' many · ' + out + ' HP · ' + (out / cost).toFixed(2) + '/mana';
    }
  });
}

// ── Stat legend ─────────────────────────────────────────────────────────────
// Every stat, its current value, what that value CURRENTLY buys you in real
// numbers, and one line on why you would want more. Rebuilt only when a number
// actually moves.
function hdStatLines(st) {
  return [
    { icon: '💚', name: 'Moc leczenia', val: st.stats.heal,
      now: '+' + (HD_HEAL_PCT_PER_PT * st.stats.heal) + '% · ' + hdMaxMana(st) + ' many',
      why: 'Podnosi każdy czar i poszerza pulę many, więc jednocześnie leczysz mocniej i dłużej. To jedyna statystyka, która poprawia leczenie na jednostkę many.' },
    { icon: '❤️', name: 'Życie', val: st.stats.hp,
      now: '+' + (HD_HP_PCT_PER_PT * st.stats.hp) + '% HP · tank ' + hdMaxHpFor(st, HD_TANK),
      why: 'Więcej zdrowia dla całej piątki — nie leczy za Ciebie, ale daje sekundy na reakcję, zanim ktoś spadnie do zera.' },
    { icon: '⚔️', name: 'Obrażenia', val: st.stats.dmg,
      now: 'Drużyna ' + hdPartyDps(st) + ' obr./s',
      why: 'Krótsze walki to mniej ciosów w drużynę i mniej wydanej many. Bossa też nie zdąży ogarnąć wściekłość.' },
  ];
}

// What one more stack of a perk would concretely do, in the same units the
// legend prints — so the random card is never a guess.
function hdPerkNow(st, i) {
  const n = st.perks[i];
  if (i === HD_PK_REGEN) return (HD_REGEN_BASE + HD_PK_REGEN_STEP * n) + ' many/s';
  if (i === HD_PK_GCD) return 'GCD ' + (hdGcdTicks(st) / 10).toFixed(1) + ' s';
  if (i === HD_PK_CHEAP) return 'koszty ' + Math.max(HD_PK_CHEAP_FLOOR, 100 - HD_PK_CHEAP_STEP * n) + '%';
  if (i === HD_PK_PHOENIX) return n + ' × na grupę';
  if (i === HD_PK_CDR) return 'odnowienie ' + (hdSpellCd(st, HD_SP_RAID) / 10).toFixed(1) + ' s';
  if (i === HD_PK_WARD) return 'obrażenia ' + hdDmgTakenPct(st) + '%';
  if (i === HD_PK_CRIT) return HD_PK_CRIT_STEP * n + '% szansy';
  if (i === HD_PK_FSR) return 'przerwa ' + (hdFsrTicks(st) / 10).toFixed(1) + ' s';
  if (i === HD_PK_RAID) return hdSpell(st, HD_SP_RAID).icon + ' ' + hdSpellOutput(st, HD_SP_RAID) + ' HP';
  if (i === HD_PK_HASTE) {
    const cs = hdCastSlot(st);
    return cs < 0 ? 'brak czarów z rzucaniem'
      : hdSpell(st, cs).icon + ' ' + (hdCastTicks(st, cs) / 10).toFixed(1) + ' s';
  }
  if (i === HD_PK_REVIVE) return n + ' × na grupę';
  return '+' + (HD_PK_FURY_DPS * n) + ' obr./s · ' + hdDmgTakenPct(st) + '% otrzymywanych';
}

// Only the perks actually held, so an empty run shows nothing at all.
function hdPerkLines(st) {
  const out = [];
  for (let i = 0; i < HD_PERK_COUNT; i += 1) {
    if (!st.perks[i]) continue;
    out.push({ icon: HD_PERK_META[i].icon, name: HD_PERK_META[i].name, val: st.perks[i],
      now: hdPerkNow(st, i), why: HD_PERK_META[i].desc });
  }
  return out;
}

function healerRenderLegend() {
  const st = healerRuntime && healerRuntime.sim;
  const box = hdEl('hd-legend');
  if (!st || !box) return;
  const lines = hdStatLines(st).concat(hdPerkLines(st));
  const sig = lines.map(l => l.name + l.val + l.now).join('|');
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

// The full prose on each of the picked class's three spells: what it is FOR,
// not just what it costs. The button already carries a one-line shape hint and
// the numbers; this is where "why would I ever press E" gets answered.
function healerRenderHelpSpells() {
  const st = healerRuntime && healerRuntime.sim;
  const box = hdEl('hd-help-spells');
  if (!st || !box) return;
  const cl = hdClass(st);
  box.replaceChildren();
  for (let slot = 0; slot < HD_SPELL_SLOTS; slot += 1) {
    const sp = cl.spells[slot];
    const cell = document.createElement('div');
    cell.className = 'hd-help-spell';
    cell.innerHTML =
      '<b><span class="hd-help-key">' + sp.key + '</span> ' + sp.icon + ' ' + sp.name + '</b>' +
      '<i>' + sp.hint + ' · ' + hdCost(st, slot) + ' many · ' +
        (hdSpellOutput(st, slot) / hdCost(st, slot)).toFixed(2) + ' HP/manę</i>' +
      '<span>' + sp.does + '</span>';
    box.appendChild(cell);
  }
}

// The [?] overlay has the room the live strip does not, so the prose answer to
// „what do these statistics actually do" lives there, next to each stat's
// current value.
function healerRenderHelpStats() {
  const st = healerRuntime && healerRuntime.sim;
  const box = hdEl('hd-help-stats');
  if (!st || !box) return;
  healerRenderHelpSpells();
  box.replaceChildren();
  hdStatLines(st).concat(hdPerkLines(st)).forEach(l => {
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
  // The character pane names whatever class is currently seated, including
  // while you are still deciding on the start card.
  const cl = hdClass(st);
  const portrait = hdEl('hd-char-portrait');
  if (portrait && portrait.textContent !== cl.portrait) portrait.textContent = cl.portrait;
  const cname = hdEl('hd-char-name');
  if (cname) cname.textContent = 'Ty — ' + cl.name;
  const csub = hdEl('hd-char-sub');
  if (csub) csub.textContent = cl.tag;
  const brand = hdEl('hd-brand-class');
  if (brand) brand.textContent = cl.icon + ' ' + cl.name;
  const maxMana = hdMaxMana(st);
  const manaFill = hdEl('hd-mana-fill');
  if (manaFill) manaFill.style.width = hdPct(st.mana, maxMana) + '%';
  const manaText = hdEl('hd-mana-text');
  if (manaText) manaText.textContent = st.mana + ' / ' + maxMana;

  // The 5-second-rule pip: the single most important readout in the game.
  const fsr = hdEl('hd-fsr');
  if (fsr) {
    const fsrMax = hdFsrTicks(st);
    const regenning = st.fsr >= fsrMax;
    fsr.classList.toggle('is-on', regenning);
    fsr.textContent = regenning ? '+' + (hdRegenPerTick(st) * 10) + '/s'
      : '⏳ ' + ((fsrMax - st.fsr) / 10).toFixed(1) + ' s';
  }

  const cast = hdEl('hd-cast');
  if (cast) {
    cast.classList.toggle('is-on', !!st.cast);
    const fill = cast.querySelector('[data-fill]');
    const label = cast.querySelector('[data-label]');
    if (st.cast) {
      const sp = hdSpell(st, st.cast.slot);
      const total = st.cast.total;
      if (fill) fill.style.width = hdPct(total - st.cast.left, total) + '%';
      if (label) {
        label.textContent = sp.icon + ' ' + (sp.all ? 'drużyna' : HD_SLOT_SHORT[st.cast.target]) +
          ' · ' + (st.cast.left / 10).toFixed(1) + ' s';
      }
    } else {
      if (fill) fill.style.width = '0%';
      if (label) label.textContent = st.gcd > 0 ? 'GCD ' + (st.gcd / 10).toFixed(1) + ' s' : 'gotowy';
    }
  }

  // The pack's name, health, pull number and affix are painted ON the board now
  // (hdDrawEnemyHeader + a health plate over each enemy) — a red bar pinned
  // under the field was in the one place on screen you never look while
  // healing, and one pooled bar never said WHICH stack was nearly down.
  // The top bar carries no score, no pull count and no mana either: three
  // readouts competing with the five that actually matter, and the score is
  // deliberately something you see when the run ENDS. The one chip left is the
  // stat line, because the character pane that lists it is hidden in portrait.
  const statChip = hdEl('hd-stats');
  if (statChip) statChip.textContent = '💚' + st.stats.heal + '  ❤️' + st.stats.hp + '  ⚔️' + st.stats.dmg;
}

// Thousands separator, Polish style, without dragging Intl into a hot loop.
function hdNum(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

function healerRenderRest() {
  const st = healerRuntime && healerRuntime.sim;
  const panel = hdEl('hd-rest');
  if (!st || !panel) return;
  if (st.phase !== 'rest') { panel.classList.remove('is-on'); return; }
  panel.classList.add('is-on');

  const label = hdEl('hd-rest-label');
  if (label) {
    label.textContent = st.upgradePicked
      ? (hdIsBoss(st.pull + 1) ? '☠️ Następny: BOSS — gotowy?' : 'Gotowy na następną grupę?')
      : 'Wybierz ulepszenie, żeby ruszyć dalej';
    label.classList.toggle('is-boss', hdIsBoss(st.pull + 1));
  }
  // „Ruszaj" stays disabled until a bonus is taken — the sim refuses the pull
  // anyway, and a button that silently does nothing is worse than a dim one.
  const go = hdEl('hd-pull-btn');
  if (go) go.disabled = !st.upgradePicked;

  const cards = hdEl('hd-upgrades');
  if (!cards) return;
  const signature = st.pull + ':' + st.upgrades.join(',') + ':' + (st.upgradePicked ? 1 : 0) + ':' + st.pickedIdx;
  if (cards.dataset.sig === signature) return;   // don't rebuild 10×/s
  cards.dataset.sig = signature;
  cards.replaceChildren();
  st.upgrades.forEach((up, i) => {
    const perk = up.k === HD_UK_PERK;
    const meta = perk ? HD_PERK_META[up.i] : HD_UPGRADE_META[up.i];
    const card = document.createElement('button');
    card.type = 'button';
    // Once picked, the chosen card stays highlighted and the others dim — the
    // player should be able to see what they just took before pulling.
    const taken = st.upgradePicked && st.pickedIdx === i;
    card.className = 'hd-up' + (perk ? ' is-perk' : '') +
      (st.upgradePicked ? (taken ? ' is-taken' : ' is-locked') : '');
    card.disabled = st.upgradePicked;
    card.innerHTML =
      (perk ? '<span class="hd-up-tag">talent</span>' : '') +
      '<span class="hd-up-icon">' + meta.icon + '</span>' +
      '<span class="hd-up-name">' + meta.name +
        (perk ? (st.perks[up.i] ? ' ' + (st.perks[up.i] + 1) : '') : ' +' + HD_UP_STEP[up.i]) + '</span>' +
      '<span class="hd-up-delta">' + hdUpgradeDelta(st, up) + '</span>' +
      '<span class="hd-up-desc">' + meta.desc + '</span>';
    card.addEventListener('click', () => { healerQueueAction(HD_A_UPGRADE, i); });
    cards.appendChild(card);
  });
}

// What this card actually buys, in the same units the legend shows — so a pick
// is never a guess about what "+3 Intelekt" means.
function hdUpgradeDelta(st, up) {
  if (up.k === HD_UK_PERK) return hdPerkDelta(st, up.i);
  const step = HD_UP_STEP[up.i];
  if (up.i === HD_UP_HEAL) return 'leczenie +' + (HD_HEAL_PCT_PER_PT * step) + '% · +' + (HD_MANA_PER_HEAL_PT * step) + ' many';
  if (up.i === HD_UP_HP) {
    const after = Math.floor(HD_BASE_HP[HD_TANK] * (100 + HD_HP_PCT_PER_PT * (st.stats.hp + step)) / 100);
    return 'HP +' + (HD_HP_PCT_PER_PT * step) + '% · tank ' + hdMaxHpFor(st, HD_TANK) + ' → ' + after;
  }
  return '+' + (HD_DPS_PER_PT * step) + ' obr./s (' + hdPartyDps(st) + ' → ' + (hdPartyDps(st) + HD_DPS_PER_PT * step) + ')';
}

// Same idea for the random card: the before → after of the one number it
// moves. Computed against a throwaway copy of the stat rather than by
// restating the formula, so the card can never disagree with the sim.
function hdPerkDelta(st, i) {
  const before = hdPerkNow(st, i);
  st.perks[i] += 1;
  const after = hdPerkNow(st, i);
  st.perks[i] -= 1;
  return before === after ? after : before + ' → ' + after;
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
    rt.endedReason = hdSlotName(st, st.deadWho) + ' zginął';
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
  healerRuntime.sim = hdInitState(1, hdPickedClass());
  const con = hdEl('hd-console');
  if (con) con.classList.remove('is-playing');
  const startBtn = hdEl('hd-start');
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Wejdź do lochu'; }
  const rest = hdEl('hd-rest');
  if (rest) rest.classList.remove('is-on');
  healerBuildFrames();
  healerRenderClassPicker();
  healerRender();
}

function beginHealerDungeonRound(seed, options) {
  const opts = options || {};
  stopHealerDungeonRound();
  healerRuntime = newHealerRuntime();
  const rt = healerRuntime;
  rt.seed = Number(seed) || 1;
  rt.sim = hdInitState(rt.seed, opts.cls === undefined ? hdPickedClass() : opts.cls);
  rt.playing = true;
  rt.archiveMode = !!opts.archiveMode;
  rt.target = HD_TANK;
  healerBuildFrames();
  const con = hdEl('hd-console');
  if (con) con.classList.add('is-playing');   // hides the start/result card
  const result = hdEl('hd-result');
  if (result) { result.classList.remove('is-on'); result.replaceChildren(); }
  const cardTitle = hdEl('hd-startcard-title');
  if (cardTitle) cardTitle.textContent = '„Uzdrowiciel G6" 💚';
  healerToggleHelp(false);
  healerToggleTutorial(false);
  const startBtn = hdEl('hd-start');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Loch trwa'; }
  const status = hdEl('hd-status');
  const cl = hdClass(rt.sim);
  if (status) {
    status.textContent = cl.icon + ' ' + cl.name + ' — ' +
      cl.spells.map(sp => sp.key + ' ' + sp.name).join(' · ') +
      ' · 1-5 lub klik w bohatera = cel. Co 5. grupa to boss.';
  }
  healerRender();   // healerRenderBars owns the brand/portrait/class labels
  rt.nextTickAt = performance.now() + HD_TICK_MS;
  rt.timer = setTimeout(healerTick, HD_TICK_MS);
}

// ── Class selection ─────────────────────────────────────────────────────────
// Picked on the start card, before the run, and remembered between sessions —
// a healer main does not want to re-choose every time. The three are balanced
// to the same HP-per-mana, so this is a question of how you want to play, not
// of which one is better.
const HD_CLASS_KEY = 'hd_class_v1';
let hdClassChoice = null;

function hdPickedClass() {
  if (hdClassChoice != null) return hdClassChoice;
  let stored = 0;
  try { stored = Number(localStorage.getItem(HD_CLASS_KEY)) || 0; } catch (e) { stored = 0; }
  hdClassChoice = Math.max(0, Math.min(HD_CLASSES.length - 1, stored));
  return hdClassChoice;
}

function hdSetClass(idx) {
  hdClassChoice = Math.max(0, Math.min(HD_CLASSES.length - 1, idx | 0));
  try { localStorage.setItem(HD_CLASS_KEY, String(hdClassChoice)); } catch (e) { /* private mode */ }
  const rt = healerRuntime;
  // Re-seat the idle sim so the frames, spellbook and legend immediately show
  // the class you are looking at, without starting anything.
  if (rt && !rt.playing) {
    rt.sim = hdInitState(1, hdClassChoice);
    healerBuildFrames();
    healerBuildSpells();
    healerRender();
  }
  healerRenderClassPicker();
}

function healerRenderClassPicker() {
  const box = hdEl('hd-classes');
  if (!box) return;
  const cur = hdPickedClass();
  if (box.dataset.sig === String(cur) && box.childElementCount) return;
  box.dataset.sig = String(cur);
  box.replaceChildren();
  HD_CLASSES.forEach((cl, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'hd-class' + (i === cur ? ' is-on' : '');
    card.style.setProperty('--hd-clr', cl.color);
    card.innerHTML =
      '<span class="hd-class-icon">' + cl.icon + '</span>' +
      '<span class="hd-class-name">' + cl.name + '</span>' +
      '<span class="hd-class-tag">' + cl.tag + '</span>' +
      '<span class="hd-class-spells">' +
        cl.spells.map(sp => sp.icon + ' ' + sp.name).join('<br>') + '</span>';
    card.title = cl.blurb;
    card.addEventListener('click', () => hdSetClass(i));
    box.appendChild(card);
  });
  const blurb = hdEl('hd-class-blurb');
  if (blurb) blurb.textContent = HD_CLASSES[cur].blurb;
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

  const st = rt.sim;
  const score = Math.max(0, Math.min(HD_MAX_SCORE, st.score));
  const startBtn = hdEl('hd-start');
  const status = hdEl('hd-status');
  const title = hdEl('hd-startcard-title');
  const reason = rt.endedReason ? ' · ' + rt.endedReason : '';
  rt.submitting = false;
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Jeszcze raz'; }
  if (title) title.textContent = '🏆 ' + hdNum(score) + ' pkt';

  // The result card gets the whole breakdown, because a points score you
  // cannot take apart is a points score you cannot improve.
  const sub = hdEl('hd-result');
  if (sub) {
    const heals = st.healingDone + st.overheal;
    const precision = heals > 0 ? Math.floor(st.healingDone * 100 / heals) : 100;
    sub.classList.add('is-on');
    sub.replaceChildren();
    const rows = [
      ['🏅', 'Głębokość', hdNum(st.scPull), st.pullsCleared + ' grup · ' + st.bossesKilled + ' bossów'],
      ['💚', 'Leczenie', hdNum(st.scHeal), hdNum(st.healingDone) + ' HP · celność ' + precision + '%'],
      ['⏱️', 'Tempo', hdNum(st.scTempo), 'za szybkie ruszanie po przerwie'],
    ];
    rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'hd-sc-row';
      row.innerHTML = '<span class="hd-sc-icon">' + r[0] + '</span>' +
        '<span class="hd-sc-name">' + r[1] + '</span>' +
        '<span class="hd-sc-note">' + r[3] + '</span>' +
        '<b class="hd-sc-val">' + r[2] + '</b>';
      sub.appendChild(row);
    });
  }

  if (allGamesMode) {
    try {
      await recordArcadeScore('healer_dungeon', score);
      if (status) status.textContent = hdClass(st).name + reason + ' · zapisano w rankingu arcade!';
      loadArcadeScores('healer_dungeon');
    } catch (e) {
      if (status) status.textContent = hdClass(st).name + reason + ' (błąd zapisu wyniku).';
    }
    return;
  }
  if (status) status.textContent = 'Demo — ' + hdNum(score) + ' pkt' + reason + ' (nie zapisano).';
}

// ── Input ───────────────────────────────────────────────────────────────────
// Spells on Q/W/E (left hand, where the action bar lives in every MMO), targets
// on 1-5 (one digit per party slot, top to bottom in the frames). The keys map
// to SLOTS, not to named spells, so they mean the same three things whichever
// class you took.
const HD_KEY_SPELL = { q: HD_A_FILL, w: HD_A_RAID, e: HD_A_BIG };
const HD_KEY_TARGET = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4 };

function healerKeyDown(ev) {
  const rt = healerRuntime;
  const arena = hdEl('hd-arena');
  if (!arena || !arena.offsetParent) return;    // panel not on screen
  const tut = hdEl('hd-tut');
  if (tut && tut.classList.contains('is-on')) {
    // While the tutorial is up it owns the keyboard: Enter/→/space advance,
    // Esc closes. Nothing should reach the game underneath.
    if (ev.key === 'Escape') { ev.preventDefault(); healerToggleTutorial(false); return; }
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'ArrowRight') { ev.preventDefault(); healerTutorialStep(1); return; }
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); healerTutorialStep(-1); return; }
    return;
  }
  if (ev.key === 'Escape') {
    // Esc closes the help overlay first, then leaves the game — but only when
    // the browser is not in native fullscreen, where Esc is the browser's.
    if (hdEl('hd-help') && hdEl('hd-help').classList.contains('is-on')) { healerToggleHelp(false); return; }
    if (!document.fullscreenElement) healerLeaveGame();
    return;
  }
  if (!rt || !rt.playing) return;
  const k = ev.key;
  if (HD_KEY_TARGET[k] !== undefined) { ev.preventDefault(); healerSetTarget(HD_KEY_TARGET[k]); return; }
  const low = typeof k === 'string' ? k.toLowerCase() : '';
  if (HD_KEY_SPELL[low] !== undefined) {
    ev.preventDefault();
    healerQueueAction(HD_KEY_SPELL[low], rt.target);
    return;
  }
  if (k === ' ') { ev.preventDefault(); healerQueueAction(HD_A_PULL, 0); }
}

// ── First-run tutorial ──────────────────────────────────────────────────────
// Six cards, shown once on the very first visit and replayable any time from
// the [?] overlay. A healing sim has more moving parts than any other game in
// the arcade — five bars, a prediction overlay, a mana rule and a score with
// three terms — and the old answer was a wall of text behind a button nobody
// pressed. This is the same information, one idea at a time, before the first
// pull rather than after the first death.
const HD_TUT_KEY = 'hd_tutorial_v1';
const HD_TUTORIAL = [
  { icon: '💚', title: 'Jesteś jedynym uzdrowicielem',
    body: 'Pięcioosobowa drużyna sama zabija potwory — Ty tylko utrzymujesz ją przy życiu. Loch nie ma końca: każda kolejna grupa bije mocniej. <b>Runda kończy się dopiero, gdy padniesz Ty.</b>' },
  { icon: '☠️', title: 'Sojusznik może paść — i to nie koniec',
    body: 'Kto padnie, leży do końca tej walki i <b>zabiera ze sobą swoje obrażenia</b>: paczka ginie wolniej, a bije tak samo mocno. To spirala, z której da się jeszcze wyleczyć — ale kosztuje. Po walce cała drużyna wstaje z pełnym życiem. Gdy padnie <b>tank</b>, potwory rzucają się na kogokolwiek i te ciosy bolą mocniej.' },
  { icon: '🎯', title: 'Wybierz cel, potem czar',
    body: 'Cel: klawisze <b>1-5</b>, kliknięcie ramki albo kliknięcie bohatera na polu bitwy. Czary: <b>Q</b> tani i oszczędny, <b>W</b> na całą drużynę (z odnowieniem), <b>E</b> duży ratunkowy. Po każdym czarze jest <b>globalny cooldown ~1,1 s</b> — ikona odkręca się jak zegar.' },
  { icon: '👁️', title: 'Paski mówią wszystko',
    body: 'Jasny pasiasty kawałek = leczenie, które <b>już leci</b> — nie marnuj na ten cel kolejnego czaru. Czerwony kawałek zjadany z prawej = cios bossa, który zaraz wyląduje. Ramka miga na biało, gdy ten cios zabije cel <b>mimo</b> całego leczenia w drodze.' },
  { icon: '💧', title: 'Mana to cała trudność',
    body: 'Między grupami życie i mana wracają do pełna, więc jedna pula many musi wystarczyć na jedną walkę. <b>Zasada 5 sekund:</b> po każdym czarze regeneracja stoi przez 5 s — przerwy, które zostawisz w środku walki, to mana na następną. Leczysz nie <i>więcej</i>, tylko <i>oszczędniej</i>.' },
  { icon: '🏆', title: 'Wynik to punkty, nie liczba grup',
    body: '<b>Głębokość</b> — każda kolejna grupa warta więcej, boss ×2. <b>Leczenie</b> — punkty za efektywne leczenie, ale przelanie (leczenie w pełny pasek) je zjada. <b>Tempo</b> — im szybciej ruszysz po przerwie, tym większy bonus. Nikt Cię nie goni; po prostu odwaga się opłaca.' },
  { icon: '⭐', title: 'Po każdej grupie wybierasz bonus',
    body: 'Dostajesz trzy karty — statystyki (leczenie / życie drużyny / obrażenia) i <b>losowe talenty</b> z puli dwunastu: regeneracja, krótszy cooldown, tańsze czary, krytyki, wskrzeszenie, a nawet jednorazowe uniknięcie śmierci. Nawet <i>proporcja</i> kart się losuje, więc każdy przebieg buduje innego uzdrowiciela.' },
  { icon: '🎲', title: 'Żadne dwie grupy nie są takie same',
    body: 'Każda grupa (poza pierwszą) ma <b>losowy modyfikator</b> wypisany obok jej paska życia: 😤 bije mocniej, 👥 ma więcej życia, 💨 bije częściej, 🩸 wysysa Ci manę, 💥 częstsze fale… Przeczytaj go, zanim ruszysz. <b>Boss</b> losuje z kolei <b>dwie z czterech</b> zdolności, więc ten sam boss nigdy nie gra tak samo.' },
];
let hdTutStep = 0;

function hdTutorialSeen() {
  try { return localStorage.getItem(HD_TUT_KEY) === '1'; } catch (e) { return false; }
}
function hdMarkTutorialSeen() {
  try { localStorage.setItem(HD_TUT_KEY, '1'); } catch (e) { /* private mode */ }
}

function healerToggleTutorial(on) {
  const box = hdEl('hd-tut');
  if (!box) return;
  const show = on === undefined ? !box.classList.contains('is-on') : !!on;
  box.classList.toggle('is-on', show);
  if (show) { hdTutStep = 0; healerRenderTutorial(); } else { hdMarkTutorialSeen(); }
}

// Advancing past the last card closes it — „Dalej" turning into „Zaczynamy!"
// is the whole exit, so there is never a dead end.
function healerTutorialStep(delta) {
  const next = hdTutStep + delta;
  if (next < 0) return;
  if (next >= HD_TUTORIAL.length) { healerToggleTutorial(false); return; }
  hdTutStep = next;
  healerRenderTutorial();
}

function healerRenderTutorial() {
  const body = hdEl('hd-tut-body');
  const dots = hdEl('hd-tut-dots');
  const next = hdEl('hd-tut-next');
  const prev = hdEl('hd-tut-prev');
  if (!body) return;
  const step = HD_TUTORIAL[hdTutStep];
  body.innerHTML =
    '<div class="hd-tut-icon">' + step.icon + '</div>' +
    '<h4>' + step.title + '</h4>' +
    '<p>' + step.body + '</p>';
  if (dots) {
    dots.replaceChildren();
    HD_TUTORIAL.forEach((_, i) => {
      const dot = document.createElement('i');
      dot.className = 'hd-tut-dot' + (i === hdTutStep ? ' is-on' : '');
      dots.appendChild(dot);
    });
  }
  if (prev) prev.disabled = hdTutStep === 0;
  if (next) next.textContent = hdTutStep === HD_TUTORIAL.length - 1 ? '✔ Zaczynamy!' : 'Dalej →';
}

// Called when the panel opens. Only the very first visit gets it unprompted.
function healerMaybeTutorial() {
  if (hdTutorialSeen()) return;
  healerToggleTutorial(true);
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
  const pullBtn = hdEl('hd-pull-btn');
  if (pullBtn) pullBtn.addEventListener('click', () => healerQueueAction(HD_A_PULL, 0));
  const helpBtn = hdEl('hd-help-btn');
  if (helpBtn) helpBtn.addEventListener('click', () => healerToggleHelp());
  const helpClose = hdEl('hd-help-close');
  if (helpClose) helpClose.addEventListener('click', () => healerToggleHelp(false));
  const tutBtn = hdEl('hd-tut-btn');
  if (tutBtn) tutBtn.addEventListener('click', () => { healerToggleHelp(false); healerToggleTutorial(true); });
  const tutNext = hdEl('hd-tut-next');
  if (tutNext) tutNext.addEventListener('click', () => healerTutorialStep(1));
  const tutPrev = hdEl('hd-tut-prev');
  if (tutPrev) tutPrev.addEventListener('click', () => healerTutorialStep(-1));
  const tutSkip = hdEl('hd-tut-skip');
  if (tutSkip) tutSkip.addEventListener('click', () => healerToggleTutorial(false));
  const exitBtn = hdEl('hd-exit');
  if (exitBtn) exitBtn.addEventListener('click', healerLeaveGame);
  const stage = hdEl('hd-stage');
  if (stage) {
    stage.addEventListener('click', healerStageClick);
    // Hover feedback: the cursor tells you a hero is clickable before you click.
    stage.addEventListener('mousemove', ev => {
      const rt = healerRuntime;
      const pt = rt && rt.sim ? hdCanvasPoint(ev) : null;
      const slot = pt ? hdHeroAt(pt[0], pt[1]) : -1;
      stage.style.cursor = (slot >= 0 && rt.sim.hp[slot] > 0) ? 'pointer' : 'default';
    });
  }
}

healerSetupOnce();
stopHealerDungeonRound();
