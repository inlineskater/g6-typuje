// Throwaway parity harness for „Najazd Ticketów" (invoice_horde).
// Transcribes the post-change deterministic sim from BOTH sources and asserts
// they agree on {score, kills, endTick, died} across many random seeds/moves.
//  - clientReplay  ← index.html (IH_* consts + ihStep sim body)
//  - serverReplay  ← supabase/functions/invoice-horde-action/index.ts (replayInvoiceHorde)
// Run: node scripts/ih-parity.mjs

// ── shared deterministic primitives (identical in both files) ────────────────
function isqrt(n) {
  if (n <= 0) return 0;
  let x = n, y = (x + 1) >> 1;
  while (y < x) { x = y; y = (x + Math.trunc(n / x)) >> 1; }
  return x;
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
const DIRS = {
  U: { x: 0, y: -1 }, D: { x: 0, y: 1 }, L: { x: -1, y: 0 }, R: { x: 1, y: 0 },
  UL: { x: -1, y: -1 }, UR: { x: 1, y: -1 }, DL: { x: -1, y: 1 }, DR: { x: 1, y: 1 },
  S: { x: 0, y: 0 },
};

// ── CLIENT side (from index.html) ────────────────────────────────────────────
const IH_ARENA = 360, IH_TICK_MS = 80, IH_DURATION_MS = 60000;
const IH_MAX_TICKS = Math.floor(IH_DURATION_MS / IH_TICK_MS);
const IH_PLAYER_SPEED = 9, IH_PLAYER_RADIUS = 10, IH_ENEMY_SPEED = 6, IH_ENEMY_RADIUS = 9;
const IH_HIT_DIST2 = (IH_PLAYER_RADIUS + IH_ENEMY_RADIUS) * (IH_PLAYER_RADIUS + IH_ENEMY_RADIUS);
const IH_FIRE_INTERVAL = 3, IH_FIRE_RANGE = 66, IH_FIRE_RANGE2 = IH_FIRE_RANGE * IH_FIRE_RANGE;
const IH_START_HP = 1, IH_ENEMY_CAP = 70, IH_MAX_SCORE = 200;
const IH_BOSS_INTERVAL = 125, IH_BOSS_HP = 5, IH_BOSS_SPEED = 4, IH_BOSS_RADIUS = 16;
const IH_BOSS_HIT_DIST2 = (IH_PLAYER_RADIUS + IH_BOSS_RADIUS) * (IH_PLAYER_RADIUS + IH_BOSS_RADIUS);
const IH_BOSS_SCORE = 5;
function ihMakeRng(seed) {
  let state = Number(seed || 1) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function ihSpawnInterval(tick) { return tick < 150 ? 10 : tick < 320 ? 7 : tick < 500 ? 5 : tick < 680 ? 3 : 2; }
function ihSpawnEnemy(rng) {
  const edge = Math.floor(rng() * 4); const t = Math.floor(rng() * (IH_ARENA + 1));
  let x, y;
  if (edge === 0) { x = t; y = 0; } else if (edge === 1) { x = t; y = IH_ARENA; }
  else if (edge === 2) { x = 0; y = t; } else { x = IH_ARENA; y = t; }
  return { x, y };
}
function ihSpawnBoss(rng) {
  const edge = Math.floor(rng() * 4); const t = Math.floor(rng() * (IH_ARENA + 1));
  let x, y;
  if (edge === 0) { x = t; y = 0; } else if (edge === 1) { x = t; y = IH_ARENA; }
  else if (edge === 2) { x = 0; y = t; } else { x = IH_ARENA; y = t; }
  return { x, y, boss: true, hp: IH_BOSS_HP };
}
function clientReplay(seed, moves, untilTick) {
  const rng = ihMakeRng(seed);
  const p = { x: 180, y: 180 };
  let dir = 'S', enemies = [], mi = 0, score = 0, hp = IH_START_HP, diedAt = null;
  const cap = Math.max(0, Math.min(IH_MAX_TICKS, untilTick));
  for (let nextTick = 1; nextTick <= cap; nextTick += 1) {
    while (mi < moves.length && moves[mi].tick < nextTick) mi += 1;
    if (mi < moves.length && moves[mi].tick === nextTick) { dir = moves[mi].dir; mi += 1; }
    const pv = DIRS[dir];
    p.x = clamp(p.x + pv.x * IH_PLAYER_SPEED, 0, IH_ARENA);
    p.y = clamp(p.y + pv.y * IH_PLAYER_SPEED, 0, IH_ARENA);
    if (nextTick % ihSpawnInterval(nextTick) === 0 && enemies.length < IH_ENEMY_CAP) enemies.push(ihSpawnEnemy(rng));
    if (nextTick % IH_BOSS_INTERVAL === 0 && enemies.length < IH_ENEMY_CAP) enemies.push(ihSpawnBoss(rng));
    for (const e of enemies) {
      const dx = p.x - e.x, dy = p.y - e.y, d = isqrt(dx * dx + dy * dy);
      if (d > 0) { const sp = e.boss ? IH_BOSS_SPEED : IH_ENEMY_SPEED; e.x += Math.trunc((dx * sp) / d); e.y += Math.trunc((dy * sp) / d); }
    }
    const survivors = []; let died = false;
    for (const e of enemies) {
      const dx = p.x - e.x, dy = p.y - e.y, hd2 = e.boss ? IH_BOSS_HIT_DIST2 : IH_HIT_DIST2;
      if (dx * dx + dy * dy <= hd2) { hp -= 1; if (hp <= 0) { died = true; break; } } else survivors.push(e);
    }
    enemies = survivors;
    if (died) { diedAt = nextTick; break; }
    if (nextTick % IH_FIRE_INTERVAL === 0 && enemies.length) {
      let bestIdx = -1, bestD2 = IH_FIRE_RANGE2 + 1;
      for (let i = 0; i < enemies.length; i += 1) {
        const dx = p.x - enemies[i].x, dy = p.y - enemies[i].y, d2 = dx * dx + dy * dy;
        if (d2 <= IH_FIRE_RANGE2 && d2 < bestD2) { bestD2 = d2; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        const target = enemies[bestIdx];
        if (target.boss) { target.hp -= 1; if (target.hp <= 0) { enemies.splice(bestIdx, 1); score = Math.min(IH_MAX_SCORE, score + IH_BOSS_SCORE); } }
        else { enemies.splice(bestIdx, 1); score = Math.min(IH_MAX_SCORE, score + 1); }
      }
    }
  }
  const endTick = diedAt ?? cap;
  return { score, kills: score, endTick, died: diedAt != null };
}

// ── SERVER side (from invoice-horde-action/index.ts) ─────────────────────────
const ARENA = 360, TICK_MS = 80, ROUND_DURATION_MS = 60000;
const MAX_TICKS = Math.floor(ROUND_DURATION_MS / TICK_MS), MAX_SCORE_PER_ROUND = 200;
const PLAYER_START = { x: 180, y: 180 }, PLAYER_SPEED = 9, PLAYER_RADIUS = 10;
const ENEMY_SPEED = 6, ENEMY_RADIUS = 9;
const HIT_DIST2 = (PLAYER_RADIUS + ENEMY_RADIUS) * (PLAYER_RADIUS + ENEMY_RADIUS);
const FIRE_INTERVAL = 3, FIRE_RANGE = 66, FIRE_RANGE2 = FIRE_RANGE * FIRE_RANGE;
const START_HP = 1, ENEMY_CAP = 70;
const BOSS_INTERVAL = 125, BOSS_HP = 5, BOSS_SPEED = 4, BOSS_RADIUS = 16;
const BOSS_HIT_DIST2 = (PLAYER_RADIUS + BOSS_RADIUS) * (PLAYER_RADIUS + BOSS_RADIUS);
const BOSS_SCORE = 5;
function makeRng(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function spawnInterval(tick) { return tick < 150 ? 10 : tick < 320 ? 7 : tick < 500 ? 5 : tick < 680 ? 3 : 2; }
function spawnEnemy(rng) {
  const edge = Math.floor(rng() * 4); const t = Math.floor(rng() * (ARENA + 1));
  if (edge === 0) return { x: t, y: 0 };
  if (edge === 1) return { x: t, y: ARENA };
  if (edge === 2) return { x: 0, y: t };
  return { x: ARENA, y: t };
}
function spawnBoss(rng) {
  const edge = Math.floor(rng() * 4); const t = Math.floor(rng() * (ARENA + 1));
  let x, y;
  if (edge === 0) { x = t; y = 0; } else if (edge === 1) { x = t; y = ARENA; }
  else if (edge === 2) { x = 0; y = t; } else { x = ARENA; y = t; }
  return { x, y, boss: true, hp: BOSS_HP };
}
function serverReplay(seed, moves, untilTick) {
  const rng = makeRng(seed);
  const player = { x: PLAYER_START.x, y: PLAYER_START.y };
  let dir = 'S', enemies = [], moveIndex = 0, kills = 0, hp = START_HP, diedAtTick = null;
  const cappedUntil = Math.max(0, Math.min(MAX_TICKS, untilTick));
  for (let tick = 1; tick <= cappedUntil; tick += 1) {
    while (moveIndex < moves.length && moves[moveIndex].tick < tick) moveIndex += 1;
    if (moveIndex < moves.length && moves[moveIndex].tick === tick) { dir = moves[moveIndex].dir; moveIndex += 1; }
    const pv = DIRS[dir];
    player.x = clamp(player.x + pv.x * PLAYER_SPEED, 0, ARENA);
    player.y = clamp(player.y + pv.y * PLAYER_SPEED, 0, ARENA);
    if (tick % spawnInterval(tick) === 0 && enemies.length < ENEMY_CAP) enemies.push(spawnEnemy(rng));
    if (tick % BOSS_INTERVAL === 0 && enemies.length < ENEMY_CAP) enemies.push(spawnBoss(rng));
    for (const e of enemies) {
      const dx = player.x - e.x, dy = player.y - e.y, d = isqrt(dx * dx + dy * dy);
      if (d > 0) { const sp = e.boss ? BOSS_SPEED : ENEMY_SPEED; e.x += Math.trunc((dx * sp) / d); e.y += Math.trunc((dy * sp) / d); }
    }
    const survivors = [];
    for (const e of enemies) {
      const dx = player.x - e.x, dy = player.y - e.y, hd2 = e.boss ? BOSS_HIT_DIST2 : HIT_DIST2;
      if (dx * dx + dy * dy <= hd2) { hp -= 1; if (hp <= 0) { diedAtTick = tick; break; } } else survivors.push(e);
    }
    enemies = survivors;
    if (diedAtTick != null) break;
    if (tick % FIRE_INTERVAL === 0 && enemies.length) {
      let bestIdx = -1, bestD2 = FIRE_RANGE2 + 1;
      for (let i = 0; i < enemies.length; i += 1) {
        const dx = player.x - enemies[i].x, dy = player.y - enemies[i].y, d2 = dx * dx + dy * dy;
        if (d2 <= FIRE_RANGE2 && d2 < bestD2) { bestD2 = d2; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        const target = enemies[bestIdx];
        if (target.boss) { target.hp -= 1; if (target.hp <= 0) { enemies.splice(bestIdx, 1); kills = Math.min(MAX_SCORE_PER_ROUND, kills + BOSS_SCORE); } }
        else { enemies.splice(bestIdx, 1); kills = Math.min(MAX_SCORE_PER_ROUND, kills + 1); }
      }
    }
  }
  const endTick = diedAtTick ?? cappedUntil;
  return { score: kills, kills, endTick, died: diedAtTick != null };
}

// ── fuzz ─────────────────────────────────────────────────────────────────────
const DIR_KEYS = Object.keys(DIRS);
function randMoves(rnd, maxTick) {
  const n = Math.floor(rnd() * 40);
  const ticks = new Set();
  while (ticks.size < n) ticks.add(1 + Math.floor(rnd() * maxTick));
  return [...ticks].sort((a, b) => a - b).map((tick) => ({ tick, dir: DIR_KEYS[Math.floor(rnd() * DIR_KEYS.length)] }));
}
let mismatches = 0, bossSeen = 0;
const N = 4000;
for (let i = 0; i < N; i += 1) {
  const seed = 1 + Math.floor(Math.random() * 2147483646);
  const rnd = Math.random;
  const moves = randMoves(rnd, MAX_TICKS);
  const a = clientReplay(seed, moves, MAX_TICKS);
  const b = serverReplay(seed, moves, MAX_TICKS);
  if (a.score >= IH_BOSS_SCORE) bossSeen += 1; // crude proxy that boss kills occur
  if (a.score !== b.score || a.kills !== b.kills || a.endTick !== b.endTick || a.died !== b.died) {
    mismatches += 1;
    if (mismatches <= 5) console.log('MISMATCH seed', seed, '\n client', a, '\n server', b);
  }
}
console.log(`ran ${N} rounds — mismatches: ${mismatches}; rounds scoring >= BOSS_SCORE: ${bossSeen}`);
process.exit(mismatches === 0 ? 0 : 1);
