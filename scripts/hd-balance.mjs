import fs from 'fs';
const src = fs.readFileSync('games/healer-dungeon.js','utf8');
// take only the parity block (the sim) — the rest touches document/window
const block = src.slice(src.indexOf('const HD_TICK_MS'), src.indexOf('// ╚═══ PARITY BLOCK END'));
const mod = new Function(block + '\nreturn {hdInitState,hdAdvanceTick,hdMaxMana,hdRestTicks,hdRegenPerTick,hdCanCast,hdHealAmt,HD_FSR_TICKS,HD_COST,HD_A_REJUV,HD_A_WG,HD_A_HT,HD_A_DRINK,HD_A_PULL,HD_A_UPGRADE,HD_SP_REJUV,HD_SP_WG,HD_SP_HT,HD_MAX_TICKS,HD_TANK,HD_HEAL,HD_DPS};')();
const M = mod;

// A competent-but-not-perfect healer: Rejuv rolling on the tank, Wild Growth on
// cooldown when the AoE has landed, Healing Touch to hold the tank up.
const policy = (st, low, lp) => {
  const hurt = st.hp.filter((hp,i)=>hp<st.maxHp[i]*0.85).length;
  const tankPct = st.hp[0]/st.maxHp[0];
  if (hurt>=2 && st.wgCd===0 && st.mana>=M.HD_COST[1]) return [{a:M.HD_A_WG,t:0}];
  if (tankPct<0.7 && st.mana>=M.HD_COST[2]) return [{a:M.HD_A_HT,t:0}];
  if (lp<0.55 && st.mana>=M.HD_COST[2]) return [{a:M.HD_A_HT,t:low}];
  if (!st.hots.some(h=>h.tgt===0&&h.kind===M.HD_SP_REJUV) && st.mana>=M.HD_COST[0]) return [{a:M.HD_A_REJUV,t:0}];
  if (lp<0.9 && st.mana>=M.HD_COST[0]) return [{a:M.HD_A_REJUV,t:low}];
  return null;
};

let fail = 0;
const ok = (name, cond, extra='') => { console.log((cond?'  PASS ':'  FAIL ')+name+(extra?'  '+extra:'')); if(!cond) fail++; };

console.log('— 5-second rule —');
{
  const st = M.hdInitState(123);
  st.mana = 500;
  // cast rejuv, then watch mana for 60 ticks
  M.hdAdvanceTick(st, [{a:M.HD_A_REJUV, t:0}]);
  const afterCast = st.mana;
  let flatFor = 0, prev = st.mana;
  for (let i=0;i<80;i++){ M.hdAdvanceTick(st,null); if (st.mana===prev) flatFor++; else break; prev=st.mana; }
  ok('mana flat for exactly 49 further ticks; regen on the 50th (5.0 s)', flatFor===49, 'flatFor='+flatFor);
  ok('regen resumes after the window', st.mana>afterCast-M.HD_COST[0]+1, 'mana='+st.mana);
}

console.log('— spell efficiency ordering —');
{
  const st = M.hdInitState(1);
  const rejuv = M.hdHealAmt(st,55)*4 / M.HD_COST[0];
  const wg    = M.hdHealAmt(st,60+50+40+30)*3 / M.HD_COST[1];  // 3 targets
  const ht    = M.hdHealAmt(st,420) / M.HD_COST[2];
  ok('Odnowa is the most efficient single-target', rejuv > ht, 'rejuv='+rejuv.toFixed(2)+' ht='+ht.toFixed(2));
  ok('Wild Growth beats HT per target too', wg > ht, 'wg='+wg.toFixed(2));
}

console.log('— Wild Growth hits all three —');
{
  const st = M.hdInitState(7);
  st.mana = 2000;
  M.hdAdvanceTick(st, [{a:M.HD_A_WG, t:0}]);
  const tgts = new Set(st.hots.map(h=>h.tgt));
  ok('a HoT on each of the 3 slots', tgts.size===3 && st.hots.length===3, 'hots='+st.hots.length);
  ok('Wild Growth went on cooldown', st.wgCd>0);
}

console.log('— rest window shrinks with depth —');
{
  const r1=M.hdRestTicks(1), r10=M.hdRestTicks(10), r27=M.hdRestTicks(27), r60=M.hdRestTicks(60);
  ok('pull 1 = 14.5 s', r1===145, 'r1='+r1);
  ok('shrinks monotonically', r1>r10 && r10>r27, `${r1} > ${r10} > ${r27}`);
  ok('floors at 50 ticks (5 s)', r60===50, 'r60='+r60);
}

console.log('— drinking —');
{
  const st = M.hdInitState(5);
  st.phase='rest'; st.restLeft=200; st.drinking=true; st.mana=100; st.upgrades=[0,1,2];
  M.hdAdvanceTick(st,null);
  ok('drinking regens fast', st.mana===112, 'mana='+st.mana);
  M.hdAdvanceTick(st, [{a:M.HD_A_REJUV, t:0}]);
  ok('casting stands you up (drinking stops)', st.drinking===false);
  M.hdAdvanceTick(st, [{a:M.HD_A_DRINK, t:0}]);
  ok('R sits you back down', st.drinking===true);
}

console.log('— determinism —');
{
  const run = (seed) => {
    const st = M.hdInitState(seed);
    const acts = [];
    while (!st.dead && st.tick < 3000) {
      let a = null;
      if (st.phase==='rest' && !st.upgradePicked) a=[{a:M.HD_A_UPGRADE,t:0}];
      else if (st.gcd===0 && !st.cast && st.mana>=M.HD_COST[0]) {
        let low=0,lp=2; for(let i=0;i<3;i++){const p=st.hp[i]/st.maxHp[i]; if(p<lp){lp=p;low=i;}}
        if (lp<0.9) a=[{a:M.HD_A_REJUV,t:low}];
      }
      M.hdAdvanceTick(st, a);
      acts.push(st.mana + ':' + st.hp.join(','));
    }
    return {pulls: st.pullsCleared, tick: st.tick, sig: acts.join('|').length, dead: st.deadWho};
  };
  const a = run(42), b = run(42), c = run(43);
  ok('same seed → identical run', JSON.stringify(a)===JSON.stringify(b), JSON.stringify(a));
  ok('different seed → different run', JSON.stringify(a)!==JSON.stringify(c), JSON.stringify(c));
}

console.log('— difficulty curve (bot that only spams Rejuv on the lowest) —');
{
  for (const seed of [1,2,3,4,5]) {
    const st = M.hdInitState(seed);
    while (!st.dead && st.tick < M.HD_MAX_TICKS) {
      let a = null;
      if (st.phase==='rest' && !st.upgradePicked) a=[{a:M.HD_A_UPGRADE,t:0}];
      else if (st.gcd===0 && !st.cast) {
        let low=0,lp=2; for(let i=0;i<3;i++){const p=st.hp[i]/st.maxHp[i]; if(p<lp){lp=p;low=i;}}
        a = policy(st, low, lp);
      }
      M.hdAdvanceTick(st, a);
    }
    console.log(`  seed ${seed}: ${st.pullsCleared} pulls, died=${['Tank','Heal','DPS'][st.deadWho]||'-'}, t=${(st.tick/10).toFixed(0)}s, healed=${st.healingDone}, spent=${st.manaSpent}`);
  }
}

console.log('— fight length stays ~constant with depth —');
{
  for (const n of [1,5,10,20,40]) {
    const st = M.hdInitState(1); st.pull=n;
    let ticks=0, hp=900+240*n;
    const dps=Math.floor((90+22*n)/10);
    while(hp>0){hp-=dps;ticks++;}
    console.log(`  pull ${String(n).padStart(2)}: ${(ticks/10).toFixed(1)}s fight, ${(M.hdRestTicks(n)/10).toFixed(1)}s rest`);
  }
}

console.log('— is mana actually the binding constraint? —');
{
  let starvedTotal=0, ticksTotal=0, oomDeaths=0;
  for (const seed of [1,2,3,4,5,6,7,8]) {
    const st = M.hdInitState(seed);
    let starved=0;
    while (!st.dead && st.tick < M.HD_MAX_TICKS) {
      let a = null;
      if (st.phase==='rest' && !st.upgradePicked) a=[{a:M.HD_A_UPGRADE,t:0}];
      else if (st.gcd===0 && !st.cast) {
        let low=0,lp=2; for(let i=0;i<3;i++){const p=st.hp[i]/st.maxHp[i]; if(p<lp){lp=p;low=i;}}
        a = policy(st, low, lp);
        // wanted to heal but could not afford the cheapest spell
        if (!a && lp<0.9 && st.phase==='fight' && st.mana < M.HD_COST[0]) starved++;
      }
      M.hdAdvanceTick(st, a);
      ticksTotal++;
    }
    starvedTotal+=starved;
    if (starved>50) oomDeaths++;
  }
  const pct = starvedTotal/ticksTotal*100;
  console.log(`  bot was mana-starved while someone needed healing on ${pct.toFixed(1)}% of ticks`);
  ok('mana genuinely bites (>2% starved ticks)', pct > 2, pct.toFixed(1)+'%');
  ok('most runs end mana-pressured', oomDeaths >= 6, oomDeaths+'/8 runs');
}

console.log('— the healer must actually matter —');
{
  const runs=[];
  for (const seed of [1,2,3,4,5,6]) {
    const st = M.hdInitState(seed);
    // cast NOTHING at all; just take the free upgrade so the run can progress
    while (!st.dead && st.tick < M.HD_MAX_TICKS) {
      M.hdAdvanceTick(st, st.phase==='rest' && !st.upgradePicked ? [{a:M.HD_A_UPGRADE,t:0}] : null);
    }
    runs.push(st.pullsCleared);
  }
  const worst = Math.max(...runs);
  const avgNoHeal = runs.reduce((a,b)=>a+b,0)/runs.length;
  console.log('  pulls cleared with ZERO healing: ' + runs.join(', '));
  // The absolute number is a weak proxy; the ratio check below is the real one.
  ok('a no-heal run dies quickly (<=5 pulls)', worst <= 5, 'worst='+worst);
  globalThis.__avgNoHeal = avgNoHeal;
}

console.log('— healing has to be worth a lot —');
{
  const runs=[];
  for (const seed of [1,2,3,4,5,6]) {
    const st = M.hdInitState(seed);
    while (!st.dead && st.tick < M.HD_MAX_TICKS) {
      let a=null;
      if (st.phase==='rest' && !st.upgradePicked) a=[{a:M.HD_A_UPGRADE,t:0}];
      else if (st.gcd===0 && !st.cast) {
        let low=0,lp=2; for(let i=0;i<3;i++){const p=st.hp[i]/st.maxHp[i]; if(p<lp){lp=p;low=i;}}
        a = policy(st, low, lp);
      }
      M.hdAdvanceTick(st, a);
    }
    runs.push(st.pullsCleared);
  }
  const avg = runs.reduce((a,b)=>a+b,0)/runs.length;
  const ratio = avg / Math.max(0.5, globalThis.__avgNoHeal);
  console.log('  competent healer: ' + runs.join(', ') + '  (avg ' + avg.toFixed(1) + ')');
  console.log('  vs no healing at all: avg ' + globalThis.__avgNoHeal.toFixed(1) + '  →  ' + ratio.toFixed(1) + '× further');
  ok('skill is worth at least 3x', ratio >= 3, ratio.toFixed(1)+'x');
  ok('a good run lands in a sane arcade range (8-40 pulls)', avg >= 8 && avg <= 40, 'avg='+avg.toFixed(1));
}

console.log(fail===0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail===0?0:1);
