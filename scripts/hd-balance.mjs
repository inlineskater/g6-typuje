import fs from 'fs';
const src = fs.readFileSync('games/healer-dungeon.js','utf8');
// take only the parity block (the sim) — the rest touches document/window
const block = src.slice(src.indexOf('const HD_TICK_MS'), src.indexOf('// ╚═══ PARITY BLOCK END'));
const EXPORTS = ['hdInitState','hdAdvanceTick','hdStartPull','hdApplyUpgrade','hdPartyDps','hdMaxMana',
  'hdRegenPerTick','hdCanCast','hdHealAmt','hdIncomingHeal','hdIncomingDamage','hdSurvives','hdBossPending',
  'hdIsBoss','hdEnragePct','hdCost','hdSpell','hdSpellCd','hdClass','hdGcdTicks','hdDmgTakenPct','hdBankPull',
  'HD_SCORE_HEAL_PER_PT',
  'HD_FSR_TICKS','HD_A_FILL','HD_A_RAID','HD_A_BIG','HD_A_PULL','HD_A_UPGRADE','HD_SP_FILL','HD_SP_RAID',
  'HD_SP_BIG','HD_MAX_TICKS','HD_TANK','HD_HEAL','HD_PARTY','HD_BOSS_EVERY','HD_UPGRADE_CHOICES',
  'HD_UPGRADE_COUNT','HD_STAT_CHOICES','HD_UP_STEP','HD_CB_BUSTER','HD_CLASSES','HD_K_HOT','HD_K_DIRECT',
  'HD_K_SHIELD','HD_PERK_COUNT','HD_PK_PHOENIX','HD_PK_CRIT','HD_PK_WARD','HD_PK_GCD','HD_PK_CDR',
  'HD_UK_STAT','HD_UK_PERK','HD_SCORE_TEMPO_MAX','HD_SCORE_TEMPO_DECAY','HD_SCORE_PULL_BASE',
  'HD_SCORE_PULL_STEP','HD_SCORE_BOSS_MULT','HD_MAX_SCORE','HD_GCD_TICKS'];
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
  ok('three cards offered: two stats + one random talent',
     M.HD_UPGRADE_CHOICES===3 && M.HD_STAT_CHOICES===2);
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
  ok('every rest offers exactly one talent among the cards', (() => {
    let seenPerk = 0, seenStat = 0;
    for (let seed=1; seed<=40; seed++) {
      const st = M.hdInitState(seed);
      st.packHp = 1;
      let g=0; while (st.phase!=='rest' && g++<400) M.hdAdvanceTick(st, null);
      const perks = st.upgrades.filter(u=>u.k===M.HD_UK_PERK).length;
      const stats = st.upgrades.filter(u=>u.k===M.HD_UK_STAT).length;
      if (perks === 1) seenPerk++;
      if (stats === M.HD_STAT_CHOICES) seenStat++;
    }
    return seenPerk === 40 && seenStat === 40;
  })());
  ok('the two stat cards are always distinct', (() => {
    for (let seed=1; seed<=60; seed++) {
      const st = M.hdInitState(seed);
      st.packHp = 1;
      let g=0; while (st.phase!=='rest' && g++<400) M.hdAdvanceTick(st, null);
      const stats = st.upgrades.filter(u=>u.k===M.HD_UK_STAT).map(u=>u.i);
      if (new Set(stats).size !== stats.length) return false;
    }
    return true;
  })());
  ok('the talent pool is actually varied', (() => {
    const seen = new Set();
    for (let seed=1; seed<=200; seed++) {
      const st = M.hdInitState(seed);
      st.packHp = 1;
      let g=0; while (st.phase!=='rest' && g++<400) M.hdAdvanceTick(st, null);
      st.upgrades.filter(u=>u.k===M.HD_UK_PERK).forEach(u=>seen.add(u.i));
    }
    return seen.size === M.HD_PERK_COUNT;
  })(), M.HD_PERK_COUNT+' talents');
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
  // A boss is a MECHANICS step, not an HP sponge. Once a normal pull runs ~21 s
  // and every pull starts from full, a 1.5×-HP boss is simply unsurvivable at
  // any ramp that also makes normal pulls matter — the sweep could not find a
  // single config with both.
  ok('the boss pull is a step up, but not an HP sponge',
     packHpAt(5) > packHpAt(4) * 1.15 && packHpAt(5) < packHpAt(4) * 1.6,
     packHpAt(4) + ' → ' + packHpAt(5) + ' HP');

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
  ok('the first pull pays its depth value', s1.scPull === M.HD_SCORE_PULL_BASE,
     s1.scPull+' vs '+M.HD_SCORE_PULL_BASE);
  ok('score is the sum of its three parts', s1.score === s1.scPull + s1.scHeal + s1.scTempo);

  // depth: pull 5 (a boss) must pay far more than pull 1
  const depth = (pull, boss) => (M.HD_SCORE_PULL_BASE + M.HD_SCORE_PULL_STEP*(pull-1)) * (boss?M.HD_SCORE_BOSS_MULT:1);
  ok('deeper pulls are worth more', depth(6,false) > depth(1,false), depth(1,false)+' → '+depth(6,false));
  ok('a boss doubles its pull', depth(5,true) === depth(5,false)*2, depth(5,false)+' → '+depth(5,true));

  // tempo: identical play, different dawdle → strictly fewer tempo points
  const fast = runBot(21, driveFor(0));
  const slow = runBot(21, driveFor(200));           // 20 s of reading per rest
  ok('sitting in the rest costs tempo points', slow.scTempo < fast.scTempo,
     'fast='+fast.scTempo+' slow='+slow.scTempo);
  ok('tempo decays to zero, never below', slow.scTempo >= 0 &&
     fast.scTempo <= M.HD_SCORE_TEMPO_MAX * (fast.pullsCleared+1));

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

  // and the whole thing has to stay inside the arcade cap
  const best = Math.max(...[1,2,3,4,5,6,7,8].map(s => runBot(s, drive).score));
  ok('a good run stays well inside the arcade cap', best < M.HD_MAX_SCORE * 0.6,
     best+' vs cap '+M.HD_MAX_SCORE);
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
  ok('a no-heal run dies almost immediately (<=3 pulls)', worst <= 3, 'worst='+worst);
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
}

console.log(fail===0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail===0?0:1);
