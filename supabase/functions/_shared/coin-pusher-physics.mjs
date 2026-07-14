import Matter from "matter-js";

const { Body, Bodies, Composite, Engine } = Matter;

export const COIN_PUSHER_PHYSICS_VERSION = 2;
export const COIN_PUSHER_BET = 100;
export const COIN_PUSHER_LANES = 5;
export const COIN_PUSHER_BASE_DURATION_MS = 6400;
export const COIN_PUSHER_START_DELAY_MS = 650;
export const COIN_PUSHER_MIN_STOCK = 24;
export const COIN_PUSHER_REFILL_TARGET = 40;
export const COIN_PUSHER_COIN_RADIUS = 25;
export const COIN_PUSHER_PUSHER_CYCLE_MS = 2300;

const WORLD_H = 780;
const FIXED_DT = 1000 / 60;
const CHUTE_STEPS = 54;
const SHELF_STEPS = 330;
const FRAME_EVERY = 4;
const REFILL_DURATION_MS = 1600;
const FRONT_Y = 728;
const PAYOUT_LEFT = 150;
const PAYOUT_RIGHT = 850;
const SIDE_LEFT = 66;
const SIDE_RIGHT = 934;
const LANE_X = [180, 340, 500, 660, 820];

function round1(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function makeRng(seed) {
  let value = (Number(seed) >>> 0) || 1;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function coinOptions(label) {
  return {
    label,
    restitution: 0.035,
    friction: 0.34,
    frictionStatic: 0.62,
    frictionAir: 0.052,
    density: 0.0037,
    slop: 0.015,
  };
}

export function coinPusherPusherYAt(elapsedMs, phaseMs = 0) {
  const phase = ((Math.max(0, elapsedMs) + phaseMs) % COIN_PUSHER_PUSHER_CYCLE_MS)
    / COIN_PUSHER_PUSHER_CYCLE_MS;
  const eased = (1 - Math.cos(phase * Math.PI * 2)) / 2;
  return 326 + eased * 84;
}

function newCoinId(revision, index) {
  return `r${Math.max(0, Number(revision) || 0) + 1}c${index}`;
}

function stockCandidates() {
  const positions = [];
  for (let row = 0; row < 5; row += 1) {
    const y = 432 + row * 48;
    const offset = row % 2 ? 24 : 0;
    for (let col = 0; col < 9; col += 1) {
      positions.push({ x: 190 + col * 76 + offset, y });
    }
  }
  return positions;
}

function canPlace(coins, x, y) {
  const minDistSq = (COIN_PUSHER_COIN_RADIUS * 2 + 3) ** 2;
  return !coins.some((coin) => ((coin.x - x) ** 2 + (coin.y - y) ** 2) < minDistSq);
}

export function createInitialCoinPusherState(revision = 0) {
  const candidates = stockCandidates();
  const coins = candidates.slice(0, COIN_PUSHER_REFILL_TARGET).map((position, index) => ({
    id: newCoinId(revision, index + 1),
    x: position.x,
    y: position.y,
  }));
  return { version: COIN_PUSHER_PHYSICS_VERSION, coins };
}

export function sanitizeCoinPusherState(raw, revision = 0) {
  if (!raw || Number(raw.version) !== COIN_PUSHER_PHYSICS_VERSION || !Array.isArray(raw.coins)) {
    return createInitialCoinPusherState(revision);
  }
  const seen = new Set();
  const coins = [];
  for (const item of raw.coins.slice(0, 160)) {
    const id = String(item?.id || "");
    const x = Number(item?.x);
    const y = Number(item?.y);
    if (!id || seen.has(id) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 50 || x > 950 || y < 220 || y > FRONT_Y + 1) continue;
    seen.add(id);
    coins.push({
      id,
      x: round1(Math.max(80, Math.min(920, x))),
      y: round1(Math.max(312, Math.min(FRONT_Y - 0.5, y))),
    });
  }
  return { version: COIN_PUSHER_PHYSICS_VERSION, coins };
}

function shelfWorld(state, dropX, entryVelocityX, initialPusherY) {
  const engine = Engine.create({ enableSleeping: false });
  engine.gravity.y = 1;
  engine.gravity.scale = 0.0000135;
  const bodies = new Map();
  for (const coin of state.coins) {
    const body = Bodies.circle(coin.x, coin.y, COIN_PUSHER_COIN_RADIUS, coinOptions(coin.id));
    bodies.set(coin.id, body);
  }
  const dropId = "__drop__";
  const drop = Bodies.circle(Math.max(125, Math.min(875, dropX)), 348, COIN_PUSHER_COIN_RADIUS, coinOptions(dropId));
  Body.setVelocity(drop, { x: entryVelocityX, y: 0.25 });
  bodies.set(dropId, drop);
  const pusher = Bodies.rectangle(500, initialPusherY, 770, 42, {
    isStatic: true,
    label: "pusher",
    friction: 0.92,
    restitution: 0,
  });
  const geometry = [
    Bodies.rectangle(82, 455, 28, 350, { isStatic: true, label: "left-wall", friction: 0.2 }),
    Bodies.rectangle(918, 455, 28, 350, { isStatic: true, label: "right-wall", friction: 0.2 }),
    Bodies.rectangle(500, 286, 850, 24, { isStatic: true, label: "rear-wall" }),
    pusher,
  ];
  Composite.add(engine.world, [...geometry, ...bodies.values()]);
  return { engine, bodies, dropId, pusher };
}

function compactCoins(bodies, active) {
  const out = [];
  for (const [id, body] of bodies) {
    if (!active.has(id)) continue;
    out.push(id, round1(body.position.x), round1(body.position.y));
  }
  return out;
}

function addMaintenanceCoins(coins, revision) {
  if (coins.length >= COIN_PUSHER_MIN_STOCK) return [];
  const candidates = stockCandidates();
  const added = [];
  let index = 1;
  for (const position of candidates) {
    if (coins.length >= COIN_PUSHER_REFILL_TARGET) break;
    if (!canPlace(coins, position.x, position.y)) continue;
    let id;
    do {
      id = `m${Math.max(0, Number(revision) || 0) + 1}c${index++}`;
    } while (coins.some((coin) => coin.id === id));
    const coin = { id, x: position.x, y: position.y };
    coins.push(coin);
    added.push(coin);
  }
  return added;
}

function addRefillFrames(frames, baseCoins, addedCoins, baseTime, phaseMs) {
  if (!addedCoins.length) return baseTime;
  const batchSize = Math.max(1, Math.ceil(addedCoins.length / 6));
  const visible = [...baseCoins];
  for (let offset = 0; offset < addedCoins.length; offset += batchSize) {
    visible.push(...addedCoins.slice(offset, offset + batchSize));
    const progress = Math.min(1, visible.length === baseCoins.length
      ? 0
      : (offset + batchSize) / addedCoins.length);
    frames.push({
      t: Math.round(baseTime + progress * REFILL_DURATION_MS),
      p: round1(coinPusherPusherYAt(baseTime + progress * REFILL_DURATION_MS, phaseMs)),
      d: null,
      c: visible.flatMap((coin) => [coin.id, coin.x, coin.y]),
      m: Math.min(addedCoins.length, offset + batchSize),
    });
  }
  return baseTime + REFILL_DURATION_MS;
}

export function simulateCoinPusherDrop({ state: rawState, lane, seed, revision = 0, phaseMs = 0 }) {
  const laneNumber = Math.trunc(Number(lane));
  if (!Number.isInteger(laneNumber) || laneNumber < 0 || laneNumber >= COIN_PUSHER_LANES) {
    throw new Error("Invalid coin pusher lane");
  }

  const state = sanitizeCoinPusherState(rawState, revision);
  const rng = makeRng(seed);
  const frames = [];
  const chuteDuration = CHUTE_STEPS * FIXED_DT;
  const laneJitter = (rng() - 0.5) * 38;
  const landingX = LANE_X[laneNumber] + laneJitter;
  const entryVelocityX = (rng() - 0.5) * 1.5;

  for (let step = 0; step < CHUTE_STEPS; step += 1) {
    if (step % FRAME_EVERY !== 0 && step !== CHUTE_STEPS - 1) continue;
    const progress = step / Math.max(1, CHUTE_STEPS - 1);
    const smooth = progress * progress * (3 - 2 * progress);
    const y = 74 + smooth * 254;
    const sway = Math.sin(progress * Math.PI * 1.7) * (1 - progress) * 9;
    frames.push({
      t: Math.round(step * FIXED_DT),
      p: round1(coinPusherPusherYAt(step * FIXED_DT, phaseMs)),
      d: [round1(landingX + sway), round1(y), round1(Math.sin(progress * Math.PI) * 82), round1(progress * 720)],
      c: state.coins.flatMap((coin) => [coin.id, coin.x, coin.y]),
    });
  }

  const firstPusherY = coinPusherPusherYAt(chuteDuration, phaseMs);
  const shelf = shelfWorld(state, landingX, entryVelocityX, firstPusherY);
  const active = new Set(shelf.bodies.keys());
  const won = [];
  const sideLost = [];

  for (let step = 0; step < SHELF_STEPS; step += 1) {
    const elapsed = chuteDuration + step * FIXED_DT;
    const nextY = coinPusherPusherYAt(elapsed, phaseMs);
    const previousY = shelf.pusher.position.y;
    Body.setPosition(shelf.pusher, { x: 500, y: nextY });
    Body.setVelocity(shelf.pusher, { x: 0, y: (nextY - previousY) / (FIXED_DT / 16.6667) });
    Engine.update(shelf.engine, FIXED_DT);

    for (const [id, body] of shelf.bodies) {
      if (!active.has(id)) continue;
      const { x, y } = body.position;
      let result = null;
      if (y >= FRONT_Y) result = x >= PAYOUT_LEFT && x <= PAYOUT_RIGHT ? won : sideLost;
      else if (x <= SIDE_LEFT || x >= SIDE_RIGHT || y > WORLD_H) result = sideLost;
      if (result) {
        result.push(id);
        active.delete(id);
        Composite.remove(shelf.engine.world, body);
      }
    }

    if (step % FRAME_EVERY === 0 || step === SHELF_STEPS - 1) {
      frames.push({
        t: Math.round(elapsed),
        p: round1(nextY),
        d: null,
        c: compactCoins(shelf.bodies, active),
      });
    }
  }

  const nextCoins = [];
  for (const [id, body] of shelf.bodies) {
    if (!active.has(id)) continue;
    const storedId = id === shelf.dropId ? newCoinId(revision, state.coins.length + 1) : id;
    nextCoins.push({
      id: storedId,
      x: round1(Math.max(80, Math.min(920, body.position.x))),
      y: round1(Math.max(312, Math.min(FRONT_Y - 0.5, body.position.y))),
    });
  }
  const coinsBeforeRefill = [...nextCoins];
  const maintenanceCoins = addMaintenanceCoins(nextCoins, revision);
  const baseDuration = Math.max(COIN_PUSHER_BASE_DURATION_MS, Math.round(chuteDuration + SHELF_STEPS * FIXED_DT));
  const durationMs = addRefillFrames(frames, coinsBeforeRefill, maintenanceCoins, baseDuration, phaseMs);
  if (!maintenanceCoins.length && frames.at(-1)?.t !== durationMs) {
    frames.push({
      t: durationMs,
      p: round1(coinPusherPusherYAt(durationMs, phaseMs)),
      d: null,
      c: nextCoins.flatMap((coin) => [coin.id, coin.x, coin.y]),
    });
  }

  return {
    beforeCount: state.coins.length,
    state: { version: COIN_PUSHER_PHYSICS_VERSION, coins: nextCoins },
    replay: {
      version: COIN_PUSHER_PHYSICS_VERSION,
      durationMs,
      phases: {
        chuteEndMs: Math.round(chuteDuration),
        refillStartMs: maintenanceCoins.length ? baseDuration : null,
      },
      frames,
    },
    coinsWon: won.length,
    sideLost: sideLost.length,
    maintenanceAdded: maintenanceCoins.length,
    inserted: 1,
    seed: Number(seed) >>> 0,
  };
}

export function coinPusherConservation(beforeCount, result) {
  return Number(beforeCount) + 1 + Number(result.maintenanceAdded || 0)
    - Number(result.state?.coins?.length || 0)
    - Number(result.coinsWon || 0)
    - Number(result.sideLost || 0);
}
