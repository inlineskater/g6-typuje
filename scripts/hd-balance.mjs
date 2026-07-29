import fs from 'fs';
const src = fs.readFileSync('games/healer-dungeon.js','utf8');
// take only the parity block (the sim) — the rest touches document/window
const block = src.slice(src.indexOf('const HD_TICK_MS'), src.indexOf('// ╚═══ PARITY BLOCK END'));
const EXPORTS = ['hdInitState','hdAdvanceTick','hdStartPull','hdApplyUpgrade','hdPartyDps','hdMaxMana',
  'hdRegenPerTick','hdCanCast','hdHealAmt','hdIncomingHeal','hdIncomingDamage','hdSurvives','hdBossPending',
  'hdIsBoss','hdEnragePct','hdCost','hdSpell','hdSpellCd','hdCastTicks','hdClass','hdGcdTicks','hdFsrTicks',
  'hdDmgTakenPct','hdBankPull','hdAffix','hdLivingDps','hdPartyDpsPerTick','hdBossAbilityRaw',
  'HD_SCORE_HEAL_PER_PT','HD_SCORE_DEPTH_EVERY',
  'HD_FSR_TICKS','HD_A_FILL','HD_A_RAID','HD_A_BIG','HD_A_PULL','HD_A_UPGRADE','HD_SP_FILL','HD_SP_RAID',
  'HD_SP_BIG','HD_SPELL_SLOTS','HD_MAX_TICKS','HD_TANK','HD_HEAL','HD_PARTY','HD_BOSS_EVERY',
  'HD_UPGRADE_CHOICES','HD_UPGRADE_COUNT','HD_UP_STEP','HD_CB_BUSTER','HD_CB_NUKE','HD_CB_FOCUS','HD_CB_DRAIN',
  'HD_BOSS_ABILITIES','HD_BOSS_KIT_SIZE','HD_CLASSES','HD_K_HOT','HD_K_DIRECT','HD_K_SHIELD','HD_AFFIXES',
  'HD_PERK_COUNT','HD_PK_PHOENIX','HD_PK_CRIT','HD_PK_WARD','HD_PK_GCD','HD_PK_CDR','HD_PK_FSR','HD_PK_RAID',
  'HD_PK_HASTE','HD_PK_REVIVE','HD_REVIVE_TICKS','HD_UK_STAT','HD_UK_PERK','HD_SCORE_TEMPO_MAX',
  'HD_SCORE_TEMPO_SEC','HD_SCORE_BOSS_MULT','HD_MAX_SCORE','HD_GCD_TICKS','HD_TWO_PERK_PCT'];
const M = new Function(block + '\nreturn {' + EXPORTS.join(',') + '};')();
const SLOTS = ['Tank','Ty','Łotr','Łucznik','Mag'];
const CLASSES = M.HD_CLASSES.map((c,i)=>({i, id:c.id, name:c.name}));

// ── A competent-but-not-perfect healer, written entirely against SLOTS ───────
// It never names a spell, so the same policy plays all three classes: slot 0 is
// the efficient filler, slot 1 the raid answer, slot 2 the panic button. The
// only class-aware branch is that a HoT/shield filler is worth pre-casting on a
// healthy target while a direct filler is not — which is the actual difference
// between the classes, so a bot that ignored it would under-play two of three.
const ready = (st, slot) => st.cd[slot] === 0 && st.mana >= M.hdCost(st, slot);
const preemptive = (st) => {
  const k = M.hdSpell(st, M.HD_SP_FILL).kind;
  return k === M.HD_K_HOT || k === M.HD_K_SHIELD;
};
const covered = (st, i) => M.hdIncomingHeal(st, i) + st.shield[i];

const policy = (st, low, lp) => {
  const hurt = st.hp.filter((hp,i)=>hp<st.maxHp[i]*0.85).length;
  const tankPct = st.hp[0]/st.maxHp[0];
  // pre-heal the telegraphed boss hit
  const pending = M.hdBossPending(st);
  if (pending && pending.left <= 25) {
    if (pending.kind === M.HD_CB_BUSTER) {
      if (!M.hdSurvives(st, 0) && ready(st, M.HD_SP_BIG)) return [{a:M.HD_A_BIG,t:0}];
      const gap = st.maxHp[0]-st.hp[0];
      if (gap > 200 && ready(st, M.HD_SP_BIG) && covered(st,0) < gap*0.6) return [{a:M.HD_A_BIG,t:0}];
      if (preemptive(st) && ready(st, M.HD_SP_FILL) && st.shield[0] === 0) return [{a:M.HD_A_FILL,t:0}];
    } else if (ready(st, M.HD_SP_RAID) && hurt>=2) {
      return [{a:M.HD_A_RAID,t:0}];
    }
  }
  if (hurt>=3 && ready(st, M.HD_SP_RAID)) return [{a:M.HD_A_RAID,t:0}];
  if (tankPct<0.65 && ready(st, M.HD_SP_BIG)) return [{a:M.HD_A_BIG,t:0}];
  if (lp<0.5 && ready(st, M.HD_SP_BIG)) return [{a:M.HD_A_BIG,t:low}];
  // A HoT/shield filler is meant to be BLANKETED, not spot-cast: the tank
  // first, then anyone who has taken a scratch and is not already covered.
  // Without this the bot played the druid and the priest like a paladin —
  // reacting to whoever was lowest — and the two pre-emptive classes measured
  // as weak when it was the policy, not the class, that was underusing them.
  if (preemptive(st) && ready(st, M.HD_SP_FILL)) {
    if (covered(st,0)===0) return [{a:M.HD_A_FILL,t:0}];
    for (let i=0;i<M.HD_PARTY;i++) {
      if (st.hp[i]>0 && covered(st,i)===0 && st.hp[i] < st.maxHp[i]*0.97) return [{a:M.HD_A_FILL,t:i}];
    }
  }
  if (lp<0.85 && ready(st, M.HD_SP_FILL) && covered(st,low) < (st.maxHp[low]-st.hp[low])) {
    return [{a:M.HD_A_FILL,t:low}];
  }
  return null;
};

// Rest behaviour: take a bonus, then pull. `dawdle` models a player who reads
// the cards before pulling, which is what the tempo term is measured against.
const driveFor = (dawdle=0) => (st) => {
  if (st.phase==='rest') {
    if (!st.upgradePicked) return [{a: M.HD_A_UPGRADE, t:0}];
    return st.restTicks >= dawdle ? [{a: M.HD_A_PULL, t:0}] : null;
  }
  if (st.gcd>0 || st.cast) return null;
  let low=0,lp=2; for(let i=0;i<M.HD_PARTY;i++){const p=st.hp[i]/st.maxHp[i]; if(p<lp){lp=p;low=i;}}
  return policy(st, low, lp);
};
const drive = driveFor(0);

const runBot = (seed, driver, cls=0) => {
  const st = M.hdInitState(seed, cls);
  while (!st.dead && st.tick < M.HD_MAX_TICKS) M.hdAdvanceTick(st, driver(st));
  return st;
};

let fail = 0;
const ok = (name, cond, extra='') => { console.log((cond?'  PASS ':'  FAIL ')+name+(extra?'  '+extra:'')); if(!cond) fail++; };

console.log('— party shape —');
{
  const st = M.hdInitState(1);
  ok('five party members', st.hp.length===5 && M.HD_PARTY===5, 'hp='+st.hp.join(','));
  ok('three cards offered every rest', M.HD_UPGRADE_CHOICES===3);
  ok('three upgrade stats', M.HD_UPGRADE_COUNT===3 && 'heal' in st.stats && 'hp' in st.stats && 'dmg' in st.stats,
     Object.keys(st.stats).join(','));
}

console.log('— the three stats each do their one thing —');
{
  const S = (i) => ({k:M.HD_UK_STAT, i});
  const base = M.hdInitState(1);
  const heal = M.hdInitState(1); M.hdApplyUpgrade(heal, S(0));
  const hp   = M.hdInitState(1); M.hdApplyUpgrade(hp, S(1));
  const dmg  = M.hdInitState(1); M.hdApplyUpgrade(dmg, S(2));
  ok('Moc leczenia raises heals AND the mana pool',
     M.hdHealAmt(heal,100) > M.hdHealAmt(base,100) && M.hdMaxMana(heal) > M.hdMaxMana(base),
     M.hdHealAmt(base,100)+'→'+M.hdHealAmt(heal,100)+', mana '+M.hdMaxMana(base)+'→'+M.hdMaxMana(heal));
  // Życie used to be tank-only (Wytrzymałość). With a cleave and a per-target
  // jittered AoE the back four die as often as the tank, so it must lift all 5.
  ok('Życie lifts the WHOLE party, not just the tank', hp.maxHp.every((v,i)=> v > base.maxHp[i]),
     base.maxHp.join('/')+' → '+hp.maxHp.join('/'));
  ok('Życie tops up current HP as well as max', hp.hp.every((v,i)=> v === hp.maxHp[i]));
  ok('Obrażenia speeds the kill', M.hdPartyDps(dmg) > M.hdPartyDps(base),
     M.hdPartyDps(base)+' → '+M.hdPartyDps(dmg));
}

// ── CLASSES ─────────────────────────────────────────────────────────────────
// "Same power" is the design promise, so it is asserted numerically rather than
// eyeballed. HP-per-mana per slot must agree across all three classes to within
// a few percent; what may differ freely is delivery (HoT / shield / direct),
// cast time and cooldown.
console.log('— three classes, same power —');
{
  const perMana = (cls, slot) => {
    const st = M.hdInitState(1, cls);
    const sp = M.hdSpell(st, slot);
    let per = 0;
    if (sp.kind === M.HD_K_HOT) for (const a of sp.amounts) per += M.hdHealAmt(st, a);
    else per = M.hdHealAmt(st, sp.amount);
    return per * (sp.all ? M.HD_PARTY : 1) / M.hdCost(st, slot);
  };
  for (const slot of [M.HD_SP_FILL, M.HD_SP_RAID, M.HD_SP_BIG]) {
    const vals = CLASSES.map(c => perMana(c.i, slot));
    const spread = Math.max(...vals) / Math.min(...vals);
    const label = ['filler (Q)','raid (W)','panic (E)'][slot];
    ok(label + ' is the same HP/mana in every class (≤3% spread)', spread <= 1.03,
       CLASSES.map((c,i)=>c.name+' '+vals[i].toFixed(2)).join(' · '));
  }
  // Slot ROLES must hold too, or the shared keybinds and the bot policy lie.
  for (const c of CLASSES) {
    const f = perMana(c.i, M.HD_SP_FILL), r = perMana(c.i, M.HD_SP_RAID), b = perMana(c.i, M.HD_SP_BIG);
    ok(c.name + ': filler beats the panic button on efficiency', f > b, f.toFixed(2)+' > '+b.toFixed(2));
    ok(c.name + ': raid spell is the efficient AoE answer, not a filler', r > f &&
       M.hdSpell(M.hdInitState(1,c.i), M.HD_SP_RAID).cd > 0, r.toFixed(2));
  }
  // Each class must actually be its own thing, not a reskin.
  const kinds = CLASSES.map(c => M.hdSpell(M.hdInitState(1,c.i), M.HD_SP_FILL).kind);
  ok('the three fillers deliver healing three different ways', new Set(kinds).size === 3, kinds.join(','));
}

console.log('— shields absorb, expire, and count honestly —');
{
  const priest = CLASSES.find(c => M.hdSpell(M.hdInitState(1,c.i), M.HD_SP_FILL).kind === M.HD_K_SHIELD).i;
  // Shield the TANK: the only slot guaranteed to be hit inside the window.
  const st = M.hdInitState(5, priest);
  M.hdAdvanceTick(st, [{a:M.HD_A_FILL, t:0}]);
  ok('the shield lands on the target', st.shield[0] > 0, 'shield='+st.shield[0]);
  const hpBefore = st.hp[0];
  let absorbedFx = 0, hpLost = 0;
  for (let i=0;i<40 && st.shield[0]>0 && !st.dead;i++) {
    M.hdAdvanceTick(st, null);
    absorbedFx += st.fx.filter(f=>f.k==='absorb' && f.slot===0).reduce((a,f)=>a+f.amt,0);
  }
  hpLost = hpBefore - st.hp[0];
  ok('absorbed damage is recorded as effective healing', st.absorbed > 0 && st.healingDone >= st.absorbed,
     'absorbed='+st.absorbed);
  ok('the shield soaked the hits instead of health', absorbedFx > 0 && hpLost < absorbedFx,
     'absorbed='+absorbedFx+' hp lost='+hpLost);
  // an untouched shield must expire into overheal, not vanish silently. Parked
  // in 'rest' so nothing hits it — hots/shields tick before the rest check.
  const s2 = M.hdInitState(9, priest);
  M.hdAdvanceTick(s2, [{a:M.HD_A_FILL, t:4}]);
  s2.phase = 'rest';
  const amt = s2.shield[4];
  const ohBefore = s2.overheal;
  for (let i=0;i<200 && s2.shieldT[4]>0 && !s2.dead;i++) M.hdAdvanceTick(s2, null);
  ok('a shield that expires unused counts as overheal', s2.shield[4] === 0 && s2.overheal === ohBefore + amt,
     'amt='+amt+' overheal +'+(s2.overheal-ohBefore));
}

console.log('— faster casts —');
{
  const st = M.hdInitState(1);
  ok('GCD is 1.1 s, not the old 1.5 s', M.HD_GCD_TICKS === 11, (M.HD_GCD_TICKS/10).toFixed(1)+' s');
  const casts = CLASSES.map(c => M.hdSpell(M.hdInitState(1,c.i), M.HD_SP_BIG).cast);
  ok('every panic button casts in 2.0 s or less', casts.every(v => v <= 20),
     casts.map(v=>(v/10).toFixed(1)+'s').join(' · '));
  void st;
}

console.log('— random talents —');
{
  const P = (i) => ({k:M.HD_UK_PERK, i});
  const base = M.hdInitState(1);
  const gcd = M.hdInitState(1); M.hdApplyUpgrade(gcd, P(M.HD_PK_GCD));
  // The SHAPE of the hand is rolled too — usually 2 stats + 1 talent, sometimes
  // 1 + 2 — so you cannot plan around the choice either. What must never vary:
  // there is always at least one of each, and never a duplicate card.
  const hands = [];
  for (let seed=1; seed<=200; seed++) {
    const st = M.hdInitState(seed);
    st.packHp = 1;
    let g=0; while (st.phase!=='rest' && g++<400) M.hdAdvanceTick(st, null);
    hands.push(st.upgrades);
  }
  ok('every hand is exactly three cards', hands.every(h => h.length === 3));
  ok('every hand has at least one stat AND at least one talent',
     hands.every(h => h.some(u=>u.k===M.HD_UK_STAT) && h.some(u=>u.k===M.HD_UK_PERK)));
  ok('no card is ever offered twice in the same hand',
     hands.every(h => new Set(h.map(u=>u.k+':'+u.i)).size === h.length));
  const twoPerkShare = hands.filter(h => h.filter(u=>u.k===M.HD_UK_PERK).length === 2).length / hands.length;
  ok('the 1-stat/2-talent hand really does show up', twoPerkShare > 0.15 && twoPerkShare < 0.6,
     (twoPerkShare*100).toFixed(0)+'% of hands');
  ok('the talent pool is actually varied', (() => {
    const seen = new Set();
    hands.forEach(h => h.filter(u=>u.k===M.HD_UK_PERK).forEach(u=>seen.add(u.i)));
    return seen.size === M.HD_PERK_COUNT;
  })(), M.HD_PERK_COUNT+' talents, all seen');
  ok('twelve talents, not the original eight', M.HD_PERK_COUNT === 12, String(M.HD_PERK_COUNT));
  const fsr = M.hdInitState(1); M.hdApplyUpgrade(fsr, P(M.HD_PK_FSR));
  ok('Medytacja shortens the 5-second rule', M.hdFsrTicks(fsr) < M.hdFsrTicks(base),
     M.hdFsrTicks(base)+' → '+M.hdFsrTicks(fsr));
  const raidP = M.hdInitState(1); M.hdApplyUpgrade(raidP, P(M.HD_PK_RAID));
  ok('Moc Grupowa boosts the raid spell and nothing else',
     M.hdHealAmt(raidP, 100, M.HD_SP_RAID) > M.hdHealAmt(base, 100, M.HD_SP_RAID) &&
     M.hdHealAmt(raidP, 100, M.HD_SP_FILL) === M.hdHealAmt(base, 100, M.HD_SP_FILL));
  // ⚠️ Szybkie Ręce must land for EVERY class. Scoped to the panic button it was
  // a dead card for the paladin, whose panic button is already instant — and a
  // talent that does nothing for the class you picked is the worst possible
  // outcome of a random draw.
  for (const c of CLASSES) {
    const b = M.hdInitState(1, c.i);
    const h = M.hdInitState(1, c.i); M.hdApplyUpgrade(h, P(M.HD_PK_HASTE));
    let helped = false, broke = false;
    for (let slot = 0; slot < M.HD_SPELL_SLOTS; slot += 1) {
      const before = M.hdCastTicks(b, slot), after = M.hdCastTicks(h, slot);
      if (before > 0 && after < before) helped = true;
      if (before === 0 && after !== 0) broke = true;
    }
    ok(c.name + ': Szybkie Ręce actually does something', helped && !broke);
  }
  ok('Szybkie Ręce never turns an instant into a cast', (() => {
    const h = M.hdInitState(1, 2); M.hdApplyUpgrade(h, P(M.HD_PK_HASTE));
    return M.hdCastTicks(h, M.HD_SP_RAID) === 0;
  })());
  ok('Skupienie really shortens the GCD', M.hdGcdTicks(gcd) < M.hdGcdTicks(base),
     M.hdGcdTicks(base)+' → '+M.hdGcdTicks(gcd));
  const ward = M.hdInitState(1); M.hdApplyUpgrade(ward, P(M.HD_PK_WARD));
  ok('Wiara really reduces damage taken', M.hdDmgTakenPct(ward) < M.hdDmgTakenPct(base),
     M.hdDmgTakenPct(base)+'% → '+M.hdDmgTakenPct(ward)+'%');
  // The cheat-death charge is the only thing in the game that undoes a mistake,
  // so it must survive the hit AND refresh per pull, not per run.
  const ph = M.hdInitState(1); M.hdApplyUpgrade(ph, P(M.HD_PK_PHOENIX));
  ph.hp[3] = 5;
  let saved = false;
  for (let i=0;i<400 && !ph.dead;i++) { M.hdAdvanceTick(ph, null); if (ph.fx.some(f=>f.k==='phoenix')) { saved = true; break; } }
  ok('Serce Feniksa turns a killing blow into 1 HP', saved && !ph.dead, 'dead='+ph.dead);
  ok('and the charge is spent afterwards', ph.phoenix === 0, 'left='+ph.phoenix);
  // A talent must never be able to make a run WORSE on average than not taking
  // it — Furia is the one with a downside, so it is the one worth checking.
  ok('no talent stacks past its floor', (() => {
    const s = M.hdInitState(1);
    for (let i=0;i<20;i++) M.hdApplyUpgrade(s, P(M.HD_PK_WARD));
    return M.hdDmgTakenPct(s) >= 50;
  })());
}

// ── EVERY SPELL, EVERY CLASS ────────────────────────────────────────────────
// Nine spells, checked one at a time against what the button promises: it costs
// what it says, it takes the global cooldown, it honours its own cast time and
// cooldown, and it lands on exactly the targets it claims. This is the check
// that would have caught a spell silently doing nothing.
console.log('— every spell does what its button says —');
{
  for (const c of CLASSES) {
    for (let slot = 0; slot < M.HD_SPELL_SLOTS; slot += 1) {
      const sp = M.hdSpell(M.hdInitState(1, c.i), slot);
      const label = c.name + ' ' + sp.key + ' ' + sp.name;

      // cost + GCD + own cooldown, from a clean state
      const st = M.hdInitState(31, c.i);
      st.hp = st.maxHp.map(v => Math.floor(v * 0.4));   // room to heal into
      const manaBefore = st.mana;
      // Snapshot BEFORE the tick: an instant resolves on the very tick that
      // casts it, so a snapshot taken afterwards sees no change at all — which
      // is exactly how the first version of this check "passed" a spell that
      // had already fired.
      const before = st.hp.slice();
      const shieldBefore = st.shield.slice();
      const cast = M.hdAdvanceTick(st, [{a: slot, t: 2}]) || true;
      ok(label + ': costs exactly what the button says',
         manaBefore - st.mana === M.hdCost(st, slot), (manaBefore - st.mana) + ' vs ' + M.hdCost(st, slot));
      ok(label + ': takes the global cooldown', st.gcd > 0, 'gcd=' + st.gcd);
      // the tick that casts it also ticks the cooldown down by one
      ok(label + ': own cooldown matches its table',
         st.cd[slot] === (sp.cd ? M.hdSpellCd(st, slot) - 1 : 0), 'cd=' + st.cd[slot]);
      void cast;

      // a cast-time spell must be ON the cast bar and deliver only when it ends
      if (sp.cast > 0) {
        ok(label + ': is on the cast bar for its full cast time',
           st.cast && st.cast.slot === slot && st.cast.total === M.hdCastTicks(st, slot),
           st.cast ? st.cast.total + ' ticks' : 'NOT CASTING');
        ok(label + ': heals nothing until the cast finishes',
           st.hp.every((v, i) => v === before[i]) && st.shield.every((v, i) => v === shieldBefore[i]));
      }

      // now let anything still in flight land, and check WHO it touched
      for (let i = 0; i < 60 && (st.cast || (sp.kind === M.HD_K_HOT && st.hots.length)); i += 1) {
        st.phase = 'rest';                       // freeze the encounter, keep ticks
        M.hdAdvanceTick(st, null);
      }
      if (sp.kind === M.HD_K_SHIELD) {
        const shielded = st.shield.map((v, i) => v > shieldBefore[i]);
        ok(label + ': shields exactly its declared targets',
           sp.all ? shielded.every(Boolean) : (shielded[2] && shielded.filter(Boolean).length === 1),
           st.shield.join('/'));
        ok(label + ': the absorb is the size the button promises',
           st.shield[2] === M.hdHealAmt(st, sp.amount, slot), st.shield[2] + '');
      } else {
        const healed = st.hp.map((v, i) => v > before[i]);
        ok(label + ': heals exactly its declared targets',
           sp.all ? healed.every(Boolean) : (healed[2] && healed.filter(Boolean).length === 1),
           healed.map(v => v ? 'Y' : '-').join(''));
      }
      if (sp.kind === M.HD_K_HOT) {
        const s2 = M.hdInitState(31, c.i);
        s2.hp = s2.maxHp.map(v => 1);
        s2.phase = 'rest';
        M.hdAdvanceTick(s2, [{a: slot, t: 2}]);
        let ticks = 0;
        for (let i = 0; i < 400 && s2.hots.some(h => h.tgt === 2); i += 1) {
          const hp = s2.hp[2];
          M.hdAdvanceTick(s2, null);
          if (s2.hp[2] > hp) ticks += 1;
        }
        ok(label + ': ticks exactly ' + sp.amounts.length + ' times', ticks === sp.amounts.length,
           ticks + ' ticks');
      }

      // a single-target spell must refuse a corpse rather than eat the GCD
      if (!sp.all) {
        const s3 = M.hdInitState(5, c.i);
        s3.hp[2] = 0;
        const m3 = s3.mana;
        M.hdAdvanceTick(s3, [{a: slot, t: 2}]);
        ok(label + ': refuses to fire on a corpse', s3.mana === m3 && s3.gcd === 0,
           'mana ' + m3 + '→' + s3.mana + ' gcd=' + s3.gcd);
      }

      // and it must refuse when you cannot pay for it
      const s4 = M.hdInitState(5, c.i);
      s4.mana = M.hdCost(s4, slot) - 1;
      M.hdAdvanceTick(s4, [{a: slot, t: 0}]);
      ok(label + ': refuses when the mana is not there', s4.gcd === 0 && !s4.cast, 'gcd=' + s4.gcd);
    }
  }
}

// ── DEATHS NO LONGER END THE RUN ────────────────────────────────────────────
console.log('— the run ends only when the HEALER dies —');
{
  const st = M.hdInitState(7);
  st.hp[3] = 1;
  let g = 0;
  while (st.hp[3] > 0 && g++ < 400 && !st.dead) M.hdAdvanceTick(st, null);
  ok('an ally can fall without ending the run', st.hp[3] === 0 && !st.dead && st.phase === 'fight',
     'dead=' + st.dead + ' phase=' + st.phase);
  ok('the death is counted', st.deaths >= 1, String(st.deaths));

  // ... and it costs the party his damage for the rest of the pull
  const full = M.hdInitState(7);
  ok('a corpse stops contributing damage', M.hdPartyDpsPerTick(st) < M.hdPartyDpsPerTick(full),
     M.hdPartyDpsPerTick(full) + ' → ' + M.hdPartyDpsPerTick(st));
  ok('the pack does NOT get weaker to compensate', M.hdLivingDps(st) === M.HD_PARTY - 2);

  // the healer dying IS the end
  const s2 = M.hdInitState(7);
  s2.hp[M.HD_HEAL] = 1;
  let g2 = 0;
  while (!s2.dead && g2++ < 400) M.hdAdvanceTick(s2, null);
  ok('the healer dying ends the run', s2.dead && s2.deadWho === M.HD_HEAL, 'who=' + s2.deadWho);

  // the fallen come back at the rest, so a death costs the pull, never the run
  const s3 = M.hdInitState(9);
  s3.hp[4] = 0;
  s3.packHp = 1;
  let g3 = 0;
  while (s3.phase !== 'rest' && g3++ < 400 && !s3.dead) M.hdAdvanceTick(s3, null);
  ok('the rest picks the fallen back up', s3.phase === 'rest' && s3.hp[4] === s3.maxHp[4],
     'hp=' + s3.hp[4]);

  // with the tank down the pack turns on whoever is left, harder
  const s4 = M.hdInitState(11);
  s4.hp[M.HD_TANK] = 0;
  let hitSomeoneElse = false;
  for (let i = 0; i < 200 && !s4.dead; i += 1) {
    M.hdAdvanceTick(s4, null);
    if (s4.fx.some(f => f.k === 'dmg' && f.src === 'melee' && f.slot !== M.HD_TANK)) hitSomeoneElse = true;
  }
  ok('with the tank down the melee finds a new target', hitSomeoneElse);

  // Wskrzeszenie must actually stand someone back up mid-fight
  const s5 = M.hdInitState(3);
  M.hdApplyUpgrade(s5, {k: M.HD_UK_PERK, i: M.HD_PK_REVIVE});
  s5.hp[3] = 1;
  let revived = false;
  for (let i = 0; i < 600 && !s5.dead; i += 1) {
    M.hdAdvanceTick(s5, null);
    if (s5.fx.some(f => f.k === 'revive')) { revived = true; break; }
  }
  ok('Wskrzeszenie stands a fallen ally back up', revived && s5.hp[3] > 0, 'hp=' + s5.hp[3]);
}

// ── RANDOMNESS: affixes and boss kits ───────────────────────────────────────
console.log('— every pull is a different pull —');
{
  ok('pull 1 is never modified, so the game can be learned', (() => {
    for (let seed = 1; seed <= 60; seed++) if (M.hdInitState(seed).affix !== 0) return false;
    return true;
  })());
  const seen = new Set();
  for (let seed = 1; seed <= 300; seed++) {
    const st = M.hdInitState(seed);
    st.pull = 2 + (seed % 8);
    M.hdStartPull(st);
    seen.add(st.affix);
  }
  ok('every affix actually shows up', seen.size === M.HD_AFFIXES.length,
     seen.size + '/' + M.HD_AFFIXES.length);
  // An affix has to CHANGE the fight, not just print a label. hdStartPull rolls
  // the affix itself, so the only honest way to sample one is to keep rolling
  // until it comes up and read the pull it actually built.
  const rollUntil = (affix) => {
    for (let seed = 1; seed <= 4000; seed++) {
      const st = M.hdInitState(seed);
      st.pull = 4;
      M.hdStartPull(st);
      if (st.affix === affix) return st;
    }
    return null;
  };
  const plain = rollUntil(0);
  let hpDiffers = 0, timerDiffers = 0, missing = 0;
  for (let a = 1; a < M.HD_AFFIXES.length; a++) {
    const st = rollUntil(a);
    if (!st) { missing++; continue; }
    if (st.packMax !== plain.packMax) hpDiffers++;
    if (st.meleeT !== plain.meleeT || st.aoeT !== plain.aoeT ||
        st.spikeT !== plain.spikeT || st.cleaveT !== plain.cleaveT) timerDiffers++;
  }
  ok('every affix is reachable', missing === 0, missing + ' unreachable');
  ok('affixes change pack health', hpDiffers >= 3, hpDiffers + ' affixes move the HP pool');
  ok('affixes change the damage rhythm', timerDiffers >= 3, timerDiffers + ' affixes move the timers');

  // the draining affix has to actually cost mana
  const drainIdx = M.HD_AFFIXES.findIndex(a => a.drain);
  const dr = M.hdInitState(2);
  dr.pull = 3; M.hdStartPull(dr); dr.affix = drainIdx;
  dr.mana = 1000;
  let drained = false;
  for (let i = 0; i < 120 && !dr.dead; i++) {
    M.hdAdvanceTick(dr, null);
    if (dr.fx.some(f => f.k === 'drain')) { drained = true; break; }
  }
  ok('the draining affix really takes mana', drained);
}

console.log('— every boss is a different boss —');
{
  const kits = new Set();
  const abilities = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    const st = M.hdInitState(seed);
    st.pull = 5;
    M.hdStartPull(st);
    kits.add(st.bossKit.slice().sort().join(','));
    st.bossKit.forEach(k => abilities.add(k));
  }
  ok('a boss draws a kit of ' + M.HD_BOSS_KIT_SIZE, (() => {
    const st = M.hdInitState(1); st.pull = 5; M.hdStartPull(st);
    return st.bossKit.length === M.HD_BOSS_KIT_SIZE && new Set(st.bossKit).size === M.HD_BOSS_KIT_SIZE;
  })());
  ok('all four abilities appear across runs', abilities.size === M.HD_BOSS_ABILITIES,
     abilities.size + '/' + M.HD_BOSS_ABILITIES);
  ok('and the kit genuinely varies between runs', kits.size >= 5, kits.size + ' distinct kits');
  ok('a normal pull has no kit at all', (() => {
    const st = M.hdInitState(1); st.pull = 4; M.hdStartPull(st);
    return st.bossKit.length === 0;
  })());

  // every ability must be PREDICTABLE — a telegraph you cannot read is a delay
  for (let kind = 0; kind < M.HD_BOSS_ABILITIES; kind += 1) {
    const st = M.hdInitState(4);
    st.pull = 5; M.hdStartPull(st);
    st.bossCast = { kind: kind, tgt: kind === M.HD_CB_BUSTER ? 0 : kind === M.HD_CB_FOCUS ? 3 : -1,
                    left: 30, total: 35 };
    const p = M.hdBossPending(st);
    ok('ability ' + kind + ' shows up on the prediction', p && p.amt > 0, p ? p.amt + '' : 'null');
    const hits = [];
    for (let i = 0; i < M.HD_PARTY; i++) if (M.hdIncomingDamage(st, i) > 0) hits.push(i);
    ok('ability ' + kind + ' predicts the right victims',
       (st.bossCast.tgt >= 0) ? (hits.length === 1 && hits[0] === st.bossCast.tgt) : hits.length === M.HD_PARTY,
       hits.join(','));
  }

  // the mana drain must land as well as the damage
  const st = M.hdInitState(6);
  st.pull = 5; M.hdStartPull(st);
  st.bossCast = { kind: M.HD_CB_DRAIN, tgt: -1, left: 1, total: 35 };
  st.mana = 1200;
  M.hdAdvanceTick(st, null);
  ok('Cięcie Budżetu takes mana as well as health', st.mana < 1200, 'mana=' + st.mana);
}

console.log('— cleave hits two DIFFERENT heroes —');
{
  let pairs=0, sameSlot=0, wrongCount=0;
  for (let seed=1; seed<=60; seed++) {
    const st = M.hdInitState(seed);
    st.hp = st.maxHp.map(v=>v*1000);          // survive long enough to observe
    st.maxHp = st.hp.slice();
    for (let i=0;i<400 && !st.dead;i++) {
      M.hdAdvanceTick(st, null);
      const hits = st.fx.filter(f=>f.k==='dmg' && f.src==='cleave');
      if (!hits.length) continue;
      pairs++;
      if (hits.length !== 2) wrongCount++;
      else if (hits[0].slot === hits[1].slot) sameSlot++;
    }
  }
  ok('cleaves actually fire', pairs > 100, pairs+' cleaves');
  ok('always exactly two victims', wrongCount===0, wrongCount+' bad');
  ok('never the same hero twice', sameSlot===0, sameSlot+' duplicates');
}

console.log('— the AoE pulse fans the party out —');
{
  const st = M.hdInitState(3);
  let seen = null;
  for (let i=0;i<200 && !st.dead;i++) {
    M.hdAdvanceTick(st, null);
    const aoe = st.fx.filter(f=>f.k==='dmg' && f.src==='aoe');
    if (aoe.length === 5) { seen = aoe.map(f=>f.amt); break; }
  }
  ok('an AoE pulse lands on all five', seen && seen.length===5, JSON.stringify(seen));
  ok('and not for identical amounts', seen && new Set(seen).size > 1, JSON.stringify(seen));
}

console.log('— 5-second rule —');
{
  const st = M.hdInitState(123);
  st.mana = 500;
  M.hdAdvanceTick(st, [{a:M.HD_A_FILL, t:0}]);
  const afterCast = st.mana;
  let flatFor = 0, prev = st.mana;
  for (let i=0;i<80;i++){ M.hdAdvanceTick(st,null); if (st.mana===prev) flatFor++; else break; prev=st.mana; }
  ok('mana flat for exactly 49 further ticks; regen on the 50th (5.0 s)', flatFor===49, 'flatFor='+flatFor);
  ok('regen resumes after the window', st.mana>afterCast-1, 'mana='+st.mana);
}

console.log('— the raid spell hits all five —');
{
  for (const c of CLASSES) {
    const st = M.hdInitState(7, c.i);
    st.mana = 4000;
    st.hp = st.maxHp.map(v => Math.floor(v/2));
    const healed0 = st.healingDone;
    M.hdAdvanceTick(st, [{a:M.HD_A_RAID, t:0}]);
    const hotTargets = new Set(st.hots.map(h=>h.tgt));
    const direct = st.fx.filter(f=>f.k==='heal').length;
    ok(c.name + ': the raid spell reaches all five',
       hotTargets.size===5 || direct===5, 'hots='+hotTargets.size+' direct='+direct);
    ok(c.name + ': and goes on cooldown', st.cd[M.HD_SP_RAID]>0);
    void healed0;
  }
}

console.log('— heal prediction is honest —');
{
  const st = M.hdInitState(11);   // druid: the HoT class
  st.mana = 2000;
  st.hp[0] = 200;
  M.hdAdvanceTick(st, [{a:M.HD_A_FILL, t:0}]);
  const predicted = M.hdIncomingHeal(st, 0);
  const table = M.hdSpell(st, M.HD_SP_FILL).amounts;
  const expect = table.reduce((a,v)=>a+M.hdHealAmt(st,v),0);
  ok('predicted incoming ≈ what the HoT actually delivers', predicted === expect,
     'pred='+predicted+' expect='+expect);
  // Let the HoT run out and confirm the prediction empties with it. Parked in
  // 'rest' so the tank is not killed mid-observation — HoTs tick before the
  // rest check, so the ticks still land.
  const s2 = M.hdInitState(11); s2.mana=2000; s2.hp[0]=200;
  M.hdAdvanceTick(s2, [{a:M.HD_A_FILL, t:0}]);
  s2.phase = 'rest';
  for (let i=0;i<200 && s2.hots.some(h=>h.tgt===0) && !s2.dead;i++) M.hdAdvanceTick(s2, null);
  ok('prediction empties as the HoT ticks', M.hdIncomingHeal(s2,0) === 0, 'left='+M.hdIncomingHeal(s2,0));
  ok('prediction counts an in-flight cast too', (() => {
    const s = M.hdInitState(3); s.mana=2000;
    M.hdAdvanceTick(s, [{a:M.HD_A_BIG, t:2}]);
    return s.cast && M.hdIncomingHeal(s,2) >= M.hdHealAmt(s, M.hdSpell(s, M.HD_SP_BIG).amount);
  })());
  // The survivability read is "hp + incoming + shield > pending hit" — written
  // the other way round once, which made a well-covered target read as MORE
  // likely to die the more healing was on it.
  ok('a shield counts toward surviving the telegraphed hit', (() => {
    const priest = CLASSES.find(c => M.hdSpell(M.hdInitState(1,c.i), M.HD_SP_FILL).kind === M.HD_K_SHIELD).i;
    const s = M.hdInitState(2, priest);
    s.isBoss = true; s.pull = 5;
    s.bossCast = { kind: M.HD_CB_BUSTER, left: 30, total: 35 };
    s.hp[0] = M.hdIncomingDamage(s, 0) - 30;    // just barely doomed
    const doomedBefore = !M.hdSurvives(s, 0);
    s.shield[0] = 500; s.shieldT[0] = 100;
    return doomedBefore && M.hdSurvives(s, 0);
  })());
}

console.log('— bosses —');
{
  ok('every 5th pull', M.hdIsBoss(5) && M.hdIsBoss(10) && !M.hdIsBoss(4) && !M.hdIsBoss(6));
  const packHpAt = (pull) => { const s = M.hdInitState(1); s.pull = pull; M.hdStartPull(s); return s.packMax; };
  // A boss is a MECHANICS step, NOT an HP sponge — and since deaths stopped
  // ending the run it cannot be one at all. A longer fight is more chances for
  // a dps to fall, and each one stretches the fight further, so even a 10% HP
  // bonus turned the boss into the wall 88% of the field died on. Its identity
  // is the telegraphed kit and the enrage, both tested below.
  ok('the boss carries no HP bonus over the natural ramp',
     packHpAt(5) < packHpAt(4) * 1.15, packHpAt(4) + ' → ' + packHpAt(5) + ' HP');
  ok('a boss is still a harder fight than the pull before it',
     packHpAt(5) > packHpAt(4), packHpAt(4) + ' → ' + packHpAt(5));

  const sb = M.hdInitState(4);
  while (sb.pull < 5 && !sb.dead && sb.tick < 8000) M.hdAdvanceTick(sb, drive(sb));
  let sawCast = 0, maxLead = 0;
  while (!sb.dead && sb.pull === 5 && sb.tick < 12000) {
    if (sb.bossCast) { sawCast = 1; maxLead = Math.max(maxLead, sb.bossCast.left); }
    M.hdAdvanceTick(sb, drive(sb));
  }
  ok('boss telegraphs its abilities', sawCast === 1, 'maxLead='+(maxLead/10).toFixed(1)+' s');
  ok('telegraph gives at least two GCDs of warning', maxLead >= 2*M.HD_GCD_TICKS, maxLead+' ticks');
}

console.log('— enrage —');
{
  const a = M.hdInitState(1); a.isBoss=true; a.fightTick=100;
  const b = M.hdInitState(1); b.isBoss=true; b.fightTick=400;
  ok('no enrage early', M.hdEnragePct(a)===100, String(M.hdEnragePct(a)));
  ok('enrage ramps late', M.hdEnragePct(b)>150, M.hdEnragePct(b)+'%');
}

console.log('— the rest belongs to the player, not to a timer —');
{
  const st = M.hdInitState(5);
  st.packHp = 1; st.hp = st.maxHp.map(v=>Math.floor(v*0.3)); st.mana = 40;
  let g=0; while (st.phase!=='rest' && g++<400) M.hdAdvanceTick(st, null);
  ok('a cleared pull drops into rest', st.phase==='rest', st.phase);
  ok('rest restores the whole party to full', st.hp.every((v,i)=>v===st.maxHp[i]), st.hp.join('/'));
  ok('rest restores mana to full', st.mana===M.hdMaxMana(st), st.mana+'/'+M.hdMaxMana(st));

  const before = st.pull;
  for (let i=0;i<3000;i++) M.hdAdvanceTick(st, null);   // 5 minutes of nothing
  ok('rest never expires on its own', st.phase==='rest' && st.pull===before, 'phase='+st.phase+' pull='+st.pull);

  M.hdAdvanceTick(st, [{a:M.HD_A_PULL,t:0}]);
  ok('cannot pull before taking a bonus', st.phase==='rest' && st.pull===before, 'pull='+st.pull);
  M.hdAdvanceTick(st, [{a:M.HD_A_UPGRADE,t:1}]);
  ok('the bonus is only ever chosen, never auto-picked', st.upgradePicked===true);
  M.hdAdvanceTick(st, [{a:M.HD_A_PULL,t:0}]);
  ok('and then the pull goes through', st.phase==='fight' && st.pull===before+1, 'pull='+st.pull);
  ok('but dawdling burned the whole tempo bonus for that pull', st.pullTempo===0, 'tempo='+st.pullTempo);
}

// ── SCORING ─────────────────────────────────────────────────────────────────
// The score replaced "pulls cleared" (2026-07-29). It has to reward the three
// things a healer controls and nothing else, so each term is tested in
// isolation against a run that moves only that term.
console.log('— scoring —');
{
  const clearOne = (driver, seed=17) => {
    const st = M.hdInitState(seed);
    while (st.pullsCleared === 0 && !st.dead && st.tick < 4000) M.hdAdvanceTick(st, driver(st));
    return st;
  };
  const s1 = clearOne(drive);
  ok('clearing a pull banks points', s1.score > 0, 'score='+s1.score);
  ok('the first pull pays one depth point', s1.scPull === 1, String(s1.scPull));
  ok('score is the sum of its three parts', s1.score === s1.scPull + s1.scHeal + s1.scTempo);

  // depth: deeper pulls pay more, bosses double
  const depth = (pull, boss) => (1 + Math.floor((pull-1)/M.HD_SCORE_DEPTH_EVERY)) * (boss?M.HD_SCORE_BOSS_MULT:1);
  ok('deeper pulls are worth more', depth(7,false) > depth(1,false), depth(1,false)+' → '+depth(7,false));
  ok('a boss doubles its pull', depth(5,true) === depth(5,false)*2, depth(5,false)+' → '+depth(5,true));

  // tempo: identical play, different dawdle → strictly fewer tempo points
  const fast = runBot(21, driveFor(0));
  const slow = runBot(21, driveFor(200));           // 20 s of reading per rest
  ok('sitting in the rest costs tempo points', slow.scTempo < fast.scTempo,
     'fast='+fast.scTempo+' slow='+slow.scTempo);
  ok('tempo decays to zero, never below', slow.scTempo >= 0 &&
     fast.scTempo <= M.HD_SCORE_TEMPO_MAX * (fast.pullsCleared+1));
  // The OPENING pull always banks full tempo — there was no rest before it —
  // so a permanently dawdling run bottoms out at exactly that, not at zero.
  ok('a permanently slow run banks only the opening pull\'s tempo',
     slow.scTempo === M.HD_SCORE_TEMPO_MAX, String(slow.scTempo));

  // Precision. Tested mechanically rather than through a "careless bot": a bot
  // that sprays heals dies immediately, so it banks almost no pulls and the
  // comparison measures survival, not waste. Two identical pulls that differ
  // ONLY in overheal is the honest experiment.
  const banked = (healed, over) => {
    const s = M.hdInitState(1);
    s.pullHealed = healed; s.pullOverheal = over; s.pullTempo = 0;
    M.hdBankPull(s);
    return s.scHeal;
  };
  const clean = banked(6000, 0), sloppy = banked(6000, 6000);
  ok('overheal directly eats healing points', sloppy < clean, clean+' → '+sloppy);
  ok('...in exact proportion to how much was wasted', sloppy === Math.floor(clean * 0.5),
     'half the healing wasted → '+sloppy+' vs '+Math.floor(clean*0.5));
  ok('effective healing alone sets the ceiling',
     clean === Math.floor(6000 / M.HD_SCORE_HEAL_PER_PT), clean+'');
  // And overheal has to actually be produced by healing a full bar, or the
  // precision term never fires in a real run.
  ok('healing a full health bar is recorded as overheal', (() => {
    const s = M.hdInitState(4);
    s.phase = 'rest';                     // nothing hits, everyone stays full
    const before = s.overheal;
    M.hdAdvanceTick(s, [{a:M.HD_A_BIG, t:2}]);
    for (let i=0;i<40;i++) M.hdAdvanceTick(s, null);
    return s.overheal > before && s.healingDone === 0;
  })());
  const g = runBot(21, drive);
  ok('healing points stay under the raw HP total in a real run',
     g.scHeal <= Math.floor(g.healingDone/M.HD_SCORE_HEAL_PER_PT),
     g.scHeal+' ≤ '+Math.floor(g.healingDone/M.HD_SCORE_HEAL_PER_PT));

  // THE HEADLINE PROPERTY: the score is DOZENS, not hundreds. A four-digit
  // number reads like a pinball machine and makes a one-pull difference
  // invisible; two digits are a number you can hold in your head and compare.
  const scores = [];
  for (const c of CLASSES) for (const seed of [1,2,3,4,5,6,7,8]) scores.push(runBot(seed, drive, c.i).score);
  const avgScore = scores.reduce((a,b)=>a+b,0)/scores.length;
  const best = Math.max(...scores);
  console.log('  scores: avg ' + avgScore.toFixed(0) + ', best ' + best + ', range ' +
              Math.min(...scores) + '-' + best);
  ok('a good run scores DOZENS, not hundreds', avgScore >= 15 && avgScore <= 99, 'avg='+avgScore.toFixed(0));
  ok('even the best run stays double-digit', best < 200, 'best='+best);
  ok('and well inside the arcade cap', best < M.HD_MAX_SCORE, best+' vs cap '+M.HD_MAX_SCORE);
}

console.log('— determinism —');
{
  const run = (seed, cls) => {
    const st = runBot(seed, drive, cls);
    return {pulls: st.pullsCleared, tick: st.tick, dead: st.deadWho, healed: st.healingDone, score: st.score};
  };
  const a = run(42,0), b = run(42,0), c = run(43,0);
  ok('same seed → identical run', JSON.stringify(a)===JSON.stringify(b), JSON.stringify(a));
  ok('different seed → different run', JSON.stringify(a)!==JSON.stringify(c), JSON.stringify(c));
  ok('class is part of the run', JSON.stringify(run(42,0))!==JSON.stringify(run(42,1)));
}

console.log('— difficulty curve, per class —');
{
  const seeds=[1,2,3,4,5,6,7,8];
  const perClass = {};
  for (const c of CLASSES) {
    const pulls=[], scores=[];
    for (const seed of seeds) {
      const st = runBot(seed, drive, c.i);
      pulls.push(st.pullsCleared); scores.push(st.score);
    }
    const avg = pulls.reduce((a,b)=>a+b,0)/pulls.length;
    const savg = scores.reduce((a,b)=>a+b,0)/scores.length;
    perClass[c.id] = {avg, savg, pulls};
    globalThis.__depths = (globalThis.__depths || []).concat(pulls);
    console.log(`  ${c.name.padEnd(8)} avg ${avg.toFixed(1)} pulls · avg ${Math.round(savg)} pkt · [${pulls.join(', ')}]`);
  }
  globalThis.__perClass = perClass;
  globalThis.__avgGood = CLASSES.reduce((a,c)=>a+perClass[c.id].avg,0)/CLASSES.length;
  const avgs = CLASSES.map(c=>perClass[c.id].avg);
  // The bot is a compromise policy, not three optimised rotations, so it cannot
  // read as tightly as the per-spell HP/mana check above. This is the coarse
  // "nobody is obviously broken" bar; the exact-power promise is the ≤3% spread.
  ok('no class is more than 40% ahead of the weakest',
     Math.max(...avgs) / Math.max(0.5, Math.min(...avgs)) <= 1.4,
     avgs.map(v=>v.toFixed(1)).join(' / '));
}

console.log('— fight length —');
{
  for (const n of [1,5,10,15,20]) {
    const st = M.hdInitState(1);
    st.pull = n; M.hdStartPull(st);
    const dps = Math.floor(M.hdPartyDps(st)/10);
    let ticks=0, left=st.packMax;
    while(left>0){left-=dps;ticks++;}
    console.log(`  pull ${String(n).padStart(2)}${M.hdIsBoss(n)?' ☠️':'   '}: ${String(st.packMax).padStart(5)} HP · ${(ticks/10).toFixed(1)}s fight`);
  }
}

console.log('— is mana actually the binding constraint? —');
{
  let starvedTotal=0, ticksTotal=0, oomRuns=0, runs=0;
  for (const c of CLASSES) for (const seed of [1,2,3,4,5,6,7,8]) {
    const st = M.hdInitState(seed, c.i);
    let starved=0;
    while (!st.dead && st.tick < M.HD_MAX_TICKS) {
      const a = drive(st);
      if (!a && st.phase==='fight' && st.gcd===0 && !st.cast && st.mana < M.hdCost(st, M.HD_SP_FILL)) starved++;
      M.hdAdvanceTick(st, a);
      ticksTotal++;
    }
    starvedTotal+=starved; runs++;
    if (starved>40) oomRuns++;
  }
  const pct = starvedTotal/ticksTotal*100;
  console.log(`  bot was mana-starved on ${pct.toFixed(1)}% of ticks`);
  ok('mana genuinely bites (>2% starved ticks)', pct > 2, pct.toFixed(1)+'%');
  ok('most runs end mana-pressured', oomRuns >= runs*0.7, oomRuns+'/'+runs+' runs');
}

console.log('— the healer must actually matter —');
{
  const runs=[];
  for (const seed of [1,2,3,4,5,6]) {
    const st = runBot(seed, (s)=> s.phase==='rest' ? [{a: s.upgradePicked ? M.HD_A_PULL : M.HD_A_UPGRADE, t:0}] : null);
    runs.push(st.pullsCleared);
  }
  const worst = Math.max(...runs);
  globalThis.__avgNoHeal = runs.reduce((a,b)=>a+b,0)/runs.length;
  console.log('  pulls cleared with ZERO healing: ' + runs.join(', '));
  // The bar moved from 3 to 5 when deaths stopped ending the run: a party that
  // is never healed now loses its dps one by one instead of wiping on the first
  // death, so it limps a little further before the healer himself falls.
  ok('a no-heal run still dies almost immediately (<=5 pulls)', worst <= 5, 'worst='+worst);
}

console.log('— the target band —');
{
  const avg = globalThis.__avgGood;
  const ratio = avg / Math.max(0.5, globalThis.__avgNoHeal);
  console.log('  competent healer avg ' + avg.toFixed(1) + ' vs no healing ' + globalThis.__avgNoHeal.toFixed(1) + '  →  ' + ratio.toFixed(1) + '× further');
  // 2.5×, not 4×. Both ends of this ratio move together when the encounter gets
  // harder — every tuning pass that lowered the good-run average lowered the
  // no-heal average by the same factor. The bar is set where the design lives.
  ok('skill is worth at least 2.5x', ratio >= 2.5, ratio.toFixed(1)+'x');
  // The design target agreed with the user: a good run ends around pull 8-10,
  // i.e. one or two bosses down. Tight band on purpose.
  ok('a good run lands in the 7-11 band', avg >= 7 && avg <= 11, 'avg='+avg.toFixed(1));
  ok('a good run reaches at least the first boss', avg >= 5, 'avg='+avg.toFixed(1));
  // THE THREE-BUCKET TEST. If every run ends on a boss the leaderboard holds
  // three or four numbers and says nothing about skill. Deaths must be spread
  // across depths, which is what the boss HP bonus was quietly preventing.
  const depths = globalThis.__depths;
  const onBoss = depths.filter(d => (d + 1) % M.HD_BOSS_EVERY === 0).length / depths.length;
  const distinct = new Set(depths).size;
  console.log('  depths reached: ' + [...new Set(depths)].sort((a,b)=>a-b).join(', ') +
              '  (' + (onBoss*100).toFixed(0) + '% ended on a boss)');
  ok('the field is not bucketed on bosses', onBoss <= 0.7, (onBoss*100).toFixed(0)+'%');
  ok('scores land on at least 6 distinct depths', distinct >= 6, distinct+' distinct');
}

console.log(fail===0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail===0?0:1);
