// Office Grand Prix deterministic parity and release harness.
//
// The browser-style and server-style engines below are intentionally separate
// transcriptions. Shared code is limited to fixtures, assertions, source-file
// inspection, and fuzz generation so one engine cannot hide drift in the other.
//
// Run:
//   node scripts/office-grand-prix-parity.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Browser-style engine (mirrors index.html) ───────────────────────────────

const C_ENGINE_VERSION = 'office_grand_prix_v1';
const C_TICK_MS = 50;
const C_TRACK_LENGTH = 160000;
const C_MAX_TICKS = 1800;
const C_ACCEL = 4;
const C_START_SPEED = 70;
const C_MAX_SPEED = 150;
const C_FORWARD_PCT = 95;
const C_STEER_STEP = 180;
const C_NEUTRAL_STEP = 40;
const C_LANE_LIMIT = 4400;
const C_OFFROAD_AT = 3400;
const C_OFFROAD_PCT = 70;
const C_BOOST_PCT = 125;
const C_BOOST_TICKS = 30;
const C_BANANA_PCT = 65;
const C_SLOW_TICKS = 25;
const C_SHIELD_TICKS = 160;
const C_PICKUP_RADIUS = 1050;
const C_BANANA_PROGRESS_RADIUS = 420;
const C_BANANA_LANE_RADIUS = 820;
const C_GATES = [13000, 28000, 43000, 58000, 73000, 88000, 103000, 118000, 133000, 148000];
const C_GATE_LANES = [-1800, 0, 1800, 0, -1800, 1800, 0, -1800, 1800, 0];
const C_CARS = ['coral', 'sky', 'lime', 'amber', 'violet', 'teal', 'pink', 'silver'];
const C_PLACEMENT = [10, 8, 6, 5, 4, 3, 2, 1];
const C_FASTEST_HUMAN_BONUS = 2;

function cClamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function cApproachZero(value, amount) {
  if (value > 0) return Math.max(0, value - amount);
  if (value < 0) return Math.min(0, value + amount);
  return 0;
}

function cMix32(value) {
  let x = Number(value) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function cRandom(seed, slot, salt) {
  return cMix32(
    (Number(seed) >>> 0) ^
    Math.imul((Number(slot) + 1) >>> 0, 0x9e3779b1) ^
    Math.imul((Number(salt) + 1) >>> 0, 0x85ebca6b),
  );
}

function cRankOrder(race) {
  return race.cars.slice().sort((a, b) => {
    const af = a.finishedTick == null ? Number.MAX_SAFE_INTEGER : a.finishedTick;
    const bf = b.finishedTick == null ? Number.MAX_SAFE_INTEGER : b.finishedTick;
    if (a.finishedTick != null || b.finishedTick != null) {
      if (a.finishedTick != null && b.finishedTick == null) return -1;
      if (a.finishedTick == null && b.finishedTick != null) return 1;
      if (af !== bf) return af - bf;
    }
    return b.progress - a.progress || a.slot - b.slot;
  });
}

function cRollItem(seed, slot, gateIndex, place) {
  const roll = cRandom(seed, slot, 1000 + gateIndex) % 100;
  const weights = place <= 2 ? [20, 50, 30] : (place <= 5 ? [40, 35, 25] : [60, 25, 15]);
  if (roll < weights[0]) return 'turbo';
  if (roll < weights[0] + weights[1]) return 'banana';
  return 'shield';
}

function cCreateRace(spec) {
  const seed = Number.isFinite(Number(spec.seed)) ? (Number(spec.seed) >>> 0) : 0x6d2b79f5;
  return {
    seed,
    tick: 0,
    finished: false,
    bananas: [],
    cars: spec.racers.map((source, slot) => ({
      slot,
      userId: source.userId ?? null,
      nick: source.nick,
      isBot: source.isBot === true,
      carId: C_CARS.includes(source.carId) ? source.carId : C_CARS[slot],
      cosmetic: C_CARS.indexOf(C_CARS.includes(source.carId) ? source.carId : C_CARS[slot]),
      progress: 0,
      lateral: 0,
      speed: C_START_SPEED,
      item: null,
      itemHeldTicks: 0,
      nextGate: 0,
      gateLog: [],
      boostTicks: 0,
      slowTicks: 0,
      slowAppliedTick: 0,
      shieldTicks: 0,
      finishedTick: null,
      dnf: false,
      lastInput: { steer: 0, useItem: false },
      events: Array.isArray(source.events) ? source.events : [],
      eventIndex: 0,
      inputEvents: Array.isArray(source.events) ? source.events.length : 0,
      bananasHit: 0,
      shieldsUsed: 0,
      boostsUsed: 0,
      bananasDropped: 0,
    })),
  };
}

function cBotInput(race, car) {
  let targetLane = 0;
  const nextGate = C_GATES[car.nextGate];
  if (car.item == null && nextGate != null && nextGate >= car.progress && nextGate - car.progress <= 14000) {
    targetLane = C_GATE_LANES[car.nextGate];
  } else {
    const phase = Math.floor((race.tick + 1) / 120);
    targetLane = ((cRandom(race.seed, car.slot, 5000 + phase) % 3) - 1) * 900;
  }

  for (const banana of race.bananas) {
    const bananaLane = banana.lane ?? banana.lateral;
    const ahead = banana.progress - car.progress;
    if (
      banana.active !== false &&
      banana.ownerSlot !== car.slot &&
      ahead > 0 &&
      ahead < 6500 &&
      Math.abs(bananaLane - targetLane) < 1100
    ) {
      targetLane = bananaLane >= 0 ? -2200 : 2200;
      break;
    }
  }

  let steer = 0;
  if (Math.abs(targetLane - car.lateral) > C_STEER_STEP) steer = targetLane > car.lateral ? 1 : -1;
  let useItem = false;
  if (car.item === 'turbo' && car.itemHeldTicks >= 8) useItem = true;
  else if (car.item === 'shield' && car.shieldTicks === 0 && car.itemHeldTicks >= 3) useItem = true;
  else if (car.item === 'banana') {
    const follower = race.cars.some((other) =>
      other.slot !== car.slot &&
      other.finishedTick == null &&
      car.progress > other.progress &&
      car.progress - other.progress < 9000 &&
      Math.abs(car.lateral - other.lateral) < 1500
    );
    useItem = follower || car.itemHeldTicks >= 70;
  }
  return { steer, useItem };
}

function cHumanInput(car, tick) {
  let steer = car.lastInput.steer;
  let useItem = false;
  while (car.eventIndex < car.events.length && Number(car.events[car.eventIndex].tick) === tick) {
    const event = car.events[car.eventIndex];
    steer = cClamp(Math.trunc(Number(event.steer) || 0), -1, 1);
    useItem = event.useItem === true || event.use === true;
    car.eventIndex += 1;
  }
  return { steer, useItem };
}

function cUseItem(race, car) {
  if (!car.item || car.finishedTick != null) return;
  const item = car.item;
  car.item = null;
  car.itemHeldTicks = 0;
  if (item === 'turbo') {
    car.boostTicks = C_BOOST_TICKS;
    car.boostsUsed += 1;
  }
  if (item === 'shield') {
    car.shieldTicks = C_SHIELD_TICKS;
    car.shieldsUsed += 1;
  }
  if (item === 'banana') {
    car.bananasDropped += 1;
    race.bananas.push({
      id: `${car.slot}:${race.tick}`,
      active: true,
      ownerSlot: car.slot,
      createdTick: race.tick + 1,
      progress: Math.max(0, car.progress - 320),
      lane: car.lateral,
      lateral: car.lateral,
    });
  }
}

function cStepRace(race) {
  if (!race || race.finished) return;
  const tick = race.tick + 1;
  const order = cRankOrder(race);
  const placeBySlot = new Map(order.map((car, index) => [car.slot, index + 1]));
  const inputs = new Map();

  for (const car of race.cars) {
    if (car.finishedTick != null) continue;
    const input = car.isBot ? cBotInput(race, car) : cHumanInput(car, tick);
    inputs.set(car.slot, {
      steer: cClamp(Math.trunc(input.steer || 0), -1, 1),
      useItem: !!input.useItem,
    });
  }

  for (const car of race.cars) {
    if (car.finishedTick != null) continue;
    const input = inputs.get(car.slot);
    car.lastInput = { steer: input.steer, useItem: false };
    if (input.useItem) cUseItem(race, car);

    if (input.steer) {
      car.lateral = cClamp(car.lateral + input.steer * C_STEER_STEP, -C_LANE_LIMIT, C_LANE_LIMIT);
    } else {
      car.lateral = cApproachZero(car.lateral, C_NEUTRAL_STEP);
    }

    car.speed = Math.min(C_MAX_SPEED, car.speed + C_ACCEL);
    let delta = Math.floor(car.speed * C_FORWARD_PCT / 100);
    if (Math.abs(car.lateral) > C_OFFROAD_AT) delta = Math.floor(delta * C_OFFROAD_PCT / 100);
    if (car.boostTicks > 0) delta = Math.floor(delta * C_BOOST_PCT / 100);
    if (car.slowTicks > 0) delta = Math.floor(delta * C_BANANA_PCT / 100);
    const previousProgress = car.progress;
    car.progress += Math.max(0, delta);

    while (
      car.nextGate < C_GATES.length &&
      previousProgress < C_GATES[car.nextGate] &&
      car.progress >= C_GATES[car.nextGate]
    ) {
      const gateIndex = car.nextGate;
      car.gateLog.push(gateIndex);
      if (!car.item && Math.abs(car.lateral - C_GATE_LANES[gateIndex]) <= C_PICKUP_RADIUS) {
        car.item = cRollItem(race.seed, car.slot, gateIndex, placeBySlot.get(car.slot) || 8);
        car.itemHeldTicks = 0;
      }
      car.nextGate += 1;
    }
    if (car.item) car.itemHeldTicks += 1;

    if (car.progress >= C_TRACK_LENGTH && car.nextGate === C_GATES.length) {
      car.progress = C_TRACK_LENGTH;
      car.finishedTick = tick;
      car.speed = 0;
    }
  }

  for (const banana of race.bananas) {
    if (banana.active === false) continue;
    const bananaLane = banana.lane ?? banana.lateral;
    for (const car of race.cars) {
      if (car.slot === banana.ownerSlot || car.finishedTick != null || tick <= banana.createdTick) continue;
      if (
        Math.abs(car.progress - banana.progress) <= C_BANANA_PROGRESS_RADIUS &&
        Math.abs(car.lateral - bananaLane) <= C_BANANA_LANE_RADIUS
      ) {
        banana.active = false;
        if (car.shieldTicks > 0) car.shieldTicks = 0;
        else {
          car.slowTicks = C_SLOW_TICKS;
          car.slowAppliedTick = tick;
          car.bananasHit += 1;
        }
        break;
      }
    }
  }

  for (const car of race.cars) {
    if (car.boostTicks > 0) car.boostTicks -= 1;
    if (car.slowTicks > 0 && car.slowAppliedTick !== tick) car.slowTicks -= 1;
    if (car.shieldTicks > 0) car.shieldTicks -= 1;
  }
  race.tick = tick;
  if (race.tick >= C_MAX_TICKS) {
    for (const car of race.cars) if (car.finishedTick == null) car.dnf = true;
    race.finished = true;
  } else if (race.cars.every((car) => car.finishedTick != null)) {
    race.finished = true;
  }
}

function cRaceResults(race) {
  const ordered = cRankOrder(race);
  const placeBySlot = new Map(ordered.map((car, index) => [car.slot, index + 1]));
  const fastestHuman = ordered
    .filter((car) => !car.isBot && car.finishedTick != null)
    .sort((a, b) => a.finishedTick - b.finishedTick || a.slot - b.slot)[0] ?? null;

  return race.cars.map((car) => {
    const place = placeBySlot.get(car.slot) ?? 8;
    const finished = car.finishedTick != null;
    const placementPoints = !car.isBot && finished ? C_PLACEMENT[place - 1] ?? 0 : 0;
    const fastestBonus = !car.isBot && finished && fastestHuman?.slot === car.slot
      ? C_FASTEST_HUMAN_BONUS
      : 0;
    return {
      slot: car.slot,
      userId: car.userId,
      nick: car.nick,
      cosmetic: car.cosmetic,
      cosmeticId: car.carId,
      isBot: car.isBot,
      place,
      finished,
      finishTick: car.finishedTick,
      completionMs: finished ? car.finishedTick * C_TICK_MS : null,
      progress: car.progress,
      placementPoints,
      fastestBonus,
      totalPoints: placementPoints + fastestBonus,
      inputEvents: car.inputEvents,
      bananasHit: car.bananasHit,
      shieldsUsed: car.shieldsUsed,
      boostsUsed: car.boostsUsed,
      bananasDropped: car.bananasDropped,
    };
  }).sort((a, b) => a.place - b.place);
}

function browserReplayRace(spec) {
  const race = cCreateRace(spec);
  while (!race.finished) cStepRace(race);
  const results = cRaceResults(race);
  return {
    engineVersion: C_ENGINE_VERSION,
    seed: race.seed,
    ticks: Math.max(...results.map((row) => row.finishTick ?? C_MAX_TICKS)),
    results,
  };
}

// ── Server-style engine (mirrors office-grand-prix-action) ──────────────────

const S_ENGINE_VERSION = 'office_grand_prix_v1';
const S_TICK_MS = 50;
const S_TRACK_LENGTH = 160000;
const S_MAX_TICKS = 1800;
const S_ACCELERATION = 4;
const S_INITIAL_SPEED = 70;
const S_TOP_SPEED = 150;
const S_FORWARD_PERCENT = 95;
const S_STEER_PER_TICK = 180;
const S_RETURN_PER_TICK = 40;
const S_LANE_BOUND = 4400;
const S_OFFROAD_BOUND = 3400;
const S_OFFROAD_PERCENT = 70;
const S_TURBO_PERCENT = 125;
const S_TURBO_DURATION = 30;
const S_BANANA_PERCENT = 65;
const S_BANANA_DURATION = 25;
const S_SHIELD_DURATION = 160;
const S_ITEM_RADIUS = 1050;
const S_HAZARD_PROGRESS_RADIUS = 420;
const S_HAZARD_LANE_RADIUS = 820;
const S_CHECKPOINTS = [13000, 28000, 43000, 58000, 73000, 88000, 103000, 118000, 133000, 148000];
const S_CHECKPOINT_LANES = [-1800, 0, 1800, 0, -1800, 1800, 0, -1800, 1800, 0];
const S_COSMETICS = ['coral', 'sky', 'lime', 'amber', 'violet', 'teal', 'pink', 'silver'];
const S_PLACE_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
const S_FAST_BONUS = 2;

function sInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function sMix32(value) {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function sRandom(seed, slot, salt) {
  const input =
    (seed >>> 0) ^
    Math.imul((slot + 1) >>> 0, 0x9e3779b1) ^
    Math.imul((salt + 1) >>> 0, 0x85ebca6b);
  return sMix32(input);
}

function sItemAtGate(seed, slot, checkpoint, place) {
  const roll = sRandom(seed, slot, 1000 + checkpoint) % 100;
  const turboWeight = place <= 2 ? 20 : place <= 5 ? 40 : 60;
  const bananaWeight = place <= 2 ? 50 : place <= 5 ? 35 : 25;
  if (roll < turboWeight) return 'turbo';
  if (roll < turboWeight + bananaWeight) return 'banana';
  return 'shield';
}

function sSlotsByPlace(cars) {
  return cars
    .slice()
    .sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished && a.finishTick !== b.finishTick) return a.finishTick - b.finishTick;
      if (a.progress !== b.progress) return b.progress - a.progress;
      return a.slot - b.slot;
    })
    .map((car) => car.slot);
}

function sReturnLane(lane) {
  if (lane > 0) return Math.max(0, lane - S_RETURN_PER_TICK);
  if (lane < 0) return Math.min(0, lane + S_RETURN_PER_TICK);
  return 0;
}

function sBotControl(car, cars, bananas, seed, tick) {
  let targetLane = 0;
  const nextCheckpoint = S_CHECKPOINTS[car.nextGate];
  if (
    car.item == null &&
    nextCheckpoint != null &&
    nextCheckpoint >= car.progress &&
    nextCheckpoint - car.progress <= 14000
  ) {
    targetLane = S_CHECKPOINT_LANES[car.nextGate];
  } else {
    const phase = Math.floor(tick / 120);
    targetLane = ((sRandom(seed, car.slot, 5000 + phase) % 3) - 1) * 900;
  }

  for (const peel of bananas) {
    if (
      peel.active &&
      peel.ownerSlot !== car.slot &&
      peel.progress > car.progress &&
      peel.progress - car.progress < 6500 &&
      Math.abs(peel.lane - targetLane) < 1100
    ) {
      targetLane = peel.lane >= 0 ? -2200 : 2200;
      break;
    }
  }

  const delta = targetLane - car.lane;
  const steer = Math.abs(delta) <= S_STEER_PER_TICK ? 0 : delta > 0 ? 1 : -1;
  let useItem = false;
  if (car.item === 'turbo' && car.itemHeldTicks >= 8) useItem = true;
  else if (car.item === 'shield' && car.shieldTicks === 0 && car.itemHeldTicks >= 3) useItem = true;
  else if (car.item === 'banana') {
    const follower = cars.some((other) =>
      other.slot !== car.slot &&
      !other.finished &&
      car.progress > other.progress &&
      car.progress - other.progress < 9000 &&
      Math.abs(car.lane - other.lane) < 1500
    );
    useItem = follower || car.itemHeldTicks >= 70;
  }
  return { steer, useItem };
}

function sUseItem(car, bananas, tick) {
  if (car.item === 'turbo') {
    car.boostTicks = S_TURBO_DURATION;
  } else if (car.item === 'shield') {
    car.shieldTicks = S_SHIELD_DURATION;
  } else if (car.item === 'banana') {
    bananas.push({
      active: true,
      ownerSlot: car.slot,
      progress: Math.max(0, car.progress - 320),
      lane: car.lane,
      createdTick: tick,
    });
  }
  car.item = null;
  car.itemHeldTicks = 0;
}

function sAdvance(car) {
  car.speed = Math.min(S_TOP_SPEED, car.speed + S_ACCELERATION);
  let forward = Math.floor(car.speed * S_FORWARD_PERCENT / 100);
  if (Math.abs(car.lane) > S_OFFROAD_BOUND) forward = Math.floor(forward * S_OFFROAD_PERCENT / 100);
  if (car.boostTicks > 0) forward = Math.floor(forward * S_TURBO_PERCENT / 100);
  if (car.slowTicks > 0) forward = Math.floor(forward * S_BANANA_PERCENT / 100);
  car.progress += Math.max(0, forward);
}

function serverReplayRace(spec) {
  const raceSeed = Number(spec.seed) >>> 0;
  const cars = spec.racers
    .map((row, slot) => ({
      slot,
      userId: row.userId ?? null,
      nick: row.nick,
      cosmetic: S_COSMETICS.includes(row.carId) ? S_COSMETICS.indexOf(row.carId) : slot,
      isBot: row.isBot === true,
      capTick: row.isBot === true
        ? S_MAX_TICKS
        : row.submitted === false
          ? 0
          : sInteger(row.elapsedTicks, S_MAX_TICKS),
      inputs: row.submitted === false ? [] : (Array.isArray(row.events) ? row.events : []),
      inputEvents: row.submitted === false ? 0 : (Array.isArray(row.events) ? row.events.length : 0),
      inputIndex: 0,
      steer: 0,
      speed: S_INITIAL_SPEED,
      progress: 0,
      lane: 0,
      item: null,
      itemHeldTicks: 0,
      nextGate: 0,
      gateLog: [],
      boostTicks: 0,
      slowTicks: 0,
      slowAppliedTick: 0,
      shieldTicks: 0,
      bananasHit: 0,
      shieldsUsed: 0,
      boostsUsed: 0,
      bananasDropped: 0,
      finished: false,
      finishTick: null,
      retired: row.isBot !== true && row.submitted === false,
    }))
    .sort((a, b) => a.slot - b.slot);
  const bananas = [];

  for (let tick = 1; tick <= S_MAX_TICKS; tick += 1) {
    const progressOrder = sSlotsByPlace(cars);
    const placeBySlot = new Map(progressOrder.map((slot, index) => [slot, index + 1]));
    const controls = new Map();

    for (const car of cars) {
      if (car.finished || car.retired) continue;
      if (!car.isBot && tick > car.capTick) {
        car.retired = true;
        continue;
      }

      let steer = car.steer;
      let useItem = false;
      if (car.isBot) {
        const bot = sBotControl(car, cars, bananas, raceSeed, tick);
        steer = bot.steer;
        useItem = bot.useItem;
      } else {
        while (car.inputIndex < car.inputs.length && sInteger(car.inputs[car.inputIndex]?.tick) === tick) {
          const input = car.inputs[car.inputIndex];
          steer = sInteger(input.steer);
          useItem = input.useItem === true || input.use === true;
          car.inputIndex += 1;
        }
      }
      car.steer = steer;
      controls.set(car.slot, { steer, useItem });
    }

    for (const car of cars) {
      if (car.finished || car.retired) continue;
      const control = controls.get(car.slot) ?? { steer: 0, useItem: false };
      if (control.useItem && car.item != null) {
        if (car.item === 'turbo') car.boostsUsed += 1;
        else if (car.item === 'shield') car.shieldsUsed += 1;
        else if (car.item === 'banana') car.bananasDropped += 1;
        sUseItem(car, bananas, tick);
      }

      if (control.steer === 0) {
        car.lane = sReturnLane(car.lane);
      } else {
        car.lane = Math.max(-S_LANE_BOUND, Math.min(S_LANE_BOUND, car.lane + control.steer * S_STEER_PER_TICK));
      }

      const previousProgress = car.progress;
      sAdvance(car);
      while (car.nextGate < S_CHECKPOINTS.length && car.progress >= S_CHECKPOINTS[car.nextGate]) {
        const gate = car.nextGate;
        car.gateLog.push(gate);
        if (
          previousProgress < S_CHECKPOINTS[gate] &&
          car.item == null &&
          Math.abs(car.lane - S_CHECKPOINT_LANES[gate]) <= S_ITEM_RADIUS
        ) {
          car.item = sItemAtGate(raceSeed, car.slot, gate, placeBySlot.get(car.slot) ?? 8);
          car.itemHeldTicks = 0;
        }
        car.nextGate += 1;
      }

      if (car.item != null) car.itemHeldTicks += 1;
      if (car.progress >= S_TRACK_LENGTH && car.nextGate === S_CHECKPOINTS.length) {
        car.progress = S_TRACK_LENGTH;
        car.finished = true;
        car.finishTick = tick;
        car.speed = 0;
      }
    }

    for (const hazard of bananas) {
      if (!hazard.active) continue;
      for (const car of cars) {
        if (
          car.finished ||
          car.retired ||
          car.slot === hazard.ownerSlot ||
          tick <= hazard.createdTick
        ) continue;
        if (
          Math.abs(car.progress - hazard.progress) <= S_HAZARD_PROGRESS_RADIUS &&
          Math.abs(car.lane - hazard.lane) <= S_HAZARD_LANE_RADIUS
        ) {
          hazard.active = false;
          if (car.shieldTicks > 0) car.shieldTicks = 0;
          else {
            car.slowTicks = S_BANANA_DURATION;
            car.slowAppliedTick = tick;
            car.bananasHit += 1;
          }
          break;
        }
      }
    }

    for (const car of cars) {
      if (car.boostTicks > 0) car.boostTicks -= 1;
      if (car.slowTicks > 0 && car.slowAppliedTick !== tick) car.slowTicks -= 1;
      if (car.shieldTicks > 0) car.shieldTicks -= 1;
    }
    if (cars.every((car) => car.finished || car.retired)) break;
  }

  const ordered = cars.slice().sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished && a.finishTick !== b.finishTick) return a.finishTick - b.finishTick;
    if (a.progress !== b.progress) return b.progress - a.progress;
    return a.slot - b.slot;
  });
  const placeBySlot = new Map(ordered.map((car, index) => [car.slot, index + 1]));
  const fastestHuman = ordered
    .filter((car) => !car.isBot && car.finished)
    .sort((a, b) => a.finishTick - b.finishTick || a.slot - b.slot)[0] ?? null;

  const results = cars.map((car) => {
    const place = placeBySlot.get(car.slot) ?? 8;
    const placementPoints = !car.isBot && car.finished ? S_PLACE_POINTS[place - 1] ?? 0 : 0;
    const fastestBonus = !car.isBot && car.finished && fastestHuman?.slot === car.slot ? S_FAST_BONUS : 0;
    return {
      slot: car.slot,
      userId: car.userId,
      nick: car.nick,
      cosmetic: car.cosmetic,
      cosmeticId: S_COSMETICS[car.cosmetic],
      isBot: car.isBot,
      place,
      finished: car.finished,
      finishTick: car.finishTick,
      completionMs: car.finished ? car.finishTick * S_TICK_MS : null,
      progress: car.progress,
      placementPoints,
      fastestBonus,
      totalPoints: placementPoints + fastestBonus,
      inputEvents: car.inputEvents,
      bananasHit: car.bananasHit,
      shieldsUsed: car.shieldsUsed,
      boostsUsed: car.boostsUsed,
      bananasDropped: car.bananasDropped,
    };
  }).sort((a, b) => a.place - b.place);

  return {
    engineVersion: S_ENGINE_VERSION,
    seed: raceSeed,
    ticks: Math.max(...results.map((row) => row.finishTick ?? S_MAX_TICKS)),
    results,
  };
}

// ── Best-five and leaderboard tie contracts ─────────────────────────────────

function cBestFiveLeaderboard(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.userId)) grouped.set(row.userId, []);
    grouped.get(row.userId).push(row);
  }
  const rollups = [];
  for (const [userId, races] of grouped) {
    races.sort((a, b) =>
      b.totalPoints - a.totalPoints ||
      Number(b.finished) - Number(a.finished) ||
      (a.completionMs ?? Number.MAX_SAFE_INTEGER) - (b.completionMs ?? Number.MAX_SAFE_INTEGER) ||
      a.submittedAt - b.submittedAt ||
      String(a.sessionId).localeCompare(String(b.sessionId))
    );
    const counted = races.slice(0, 5);
    rollups.push({
      userId,
      score: counted.reduce((sum, race) => sum + race.totalPoints, 0),
      wins: counted.filter((race) => race.finishPlace === 1).length,
      combinedTimeMs: counted.reduce((sum, race) => sum + (race.completionMs ?? 90000), 0),
      racesCounted: counted.length,
      firstResultAt: Math.min(...counted.map((race) => race.submittedAt)),
      countedSessionIds: counted.map((race) => race.sessionId),
    });
  }
  rollups.sort((a, b) =>
    b.score - a.score ||
    b.wins - a.wins ||
    a.combinedTimeMs - b.combinedTimeMs ||
    a.firstResultAt - b.firstResultAt ||
    String(a.userId).localeCompare(String(b.userId))
  );
  return rollups.map((row, index) => ({ rank: index + 1, ...row }));
}

function sBestFiveLeaderboard(rows) {
  const users = new Map();
  rows.forEach((race) => {
    const bucket = users.get(race.userId) ?? [];
    bucket.push(race);
    users.set(race.userId, bucket);
  });
  const totals = [];
  users.forEach((userRaces, userId) => {
    const eligible = userRaces.slice();
    eligible.sort((left, right) => {
      if (left.totalPoints !== right.totalPoints) return right.totalPoints - left.totalPoints;
      if (left.finished !== right.finished) return left.finished ? -1 : 1;
      const leftTime = left.completionMs == null ? Infinity : left.completionMs;
      const rightTime = right.completionMs == null ? Infinity : right.completionMs;
      if (leftTime !== rightTime) return leftTime - rightTime;
      if (left.submittedAt !== right.submittedAt) return left.submittedAt - right.submittedAt;
      return String(left.sessionId).localeCompare(String(right.sessionId));
    });
    const selected = eligible.slice(0, 5);
    let points = 0;
    let wins = 0;
    let combined = 0;
    let first = Infinity;
    for (const race of selected) {
      points += race.totalPoints;
      if (race.finishPlace === 1) wins += 1;
      combined += race.completionMs == null ? 90000 : race.completionMs;
      first = Math.min(first, race.submittedAt);
    }
    totals.push({
      userId,
      score: points,
      wins,
      combinedTimeMs: combined,
      racesCounted: selected.length,
      firstResultAt: first,
      countedSessionIds: selected.map((race) => race.sessionId),
    });
  });
  totals.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.wins !== right.wins) return right.wins - left.wins;
    if (left.combinedTimeMs !== right.combinedTimeMs) return left.combinedTimeMs - right.combinedTimeMs;
    if (left.firstResultAt !== right.firstResultAt) return left.firstResultAt - right.firstResultAt;
    return String(left.userId).localeCompare(String(right.userId));
  });
  return totals.map((total, index) => ({ rank: index + 1, ...total }));
}

function cValidGateFinish(progress, finishTick, gates) {
  if (progress < C_TRACK_LENGTH || finishTick < 1 || finishTick > C_MAX_TICKS) return false;
  return Array.isArray(gates) && gates.length === C_GATES.length && gates.every((gate, index) => gate === index);
}

function sValidGateFinish(progress, finishTick, gates) {
  if (Number(progress) < S_TRACK_LENGTH) return false;
  if (!Number.isInteger(finishTick) || finishTick <= 0 || finishTick > S_MAX_TICKS) return false;
  if (!Array.isArray(gates) || gates.length !== S_CHECKPOINTS.length) return false;
  for (let expected = 0; expected < S_CHECKPOINTS.length; expected += 1) {
    if (gates[expected] !== expected) return false;
  }
  return true;
}

// ── Source-contract audit ───────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

function compact(source) {
  return source.replace(/\s+/g, ' ').trim();
}

function numericConst(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*(-?\\d+)\\s*;`));
  assert.ok(match, `source contract missing numeric constant ${name}`);
  return Number(match[1]);
}

function stringConst(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]\\s*;`));
  assert.ok(match, `source contract missing string constant ${name}`);
  return match[1];
}

function numberArray(source, name) {
  const patterns = [
    new RegExp(`const\\s+${name}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)\\s*;`),
    new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`),
  ];
  const match = patterns.map((pattern) => source.match(pattern)).find(Boolean);
  assert.ok(match, `source contract missing array ${name}`);
  return [...match[1].matchAll(/-?\d+/g)].map((item) => Number(item[0]));
}

function assertContains(source, fragment, label) {
  assert.ok(compact(source).includes(compact(fragment)), `source contract drift: ${label}`);
}

function assertSourceContracts() {
  const clientSource = readFileSync(resolve(REPO_ROOT, 'index.html'), 'utf8');
  const serverSource = readFileSync(
    resolve(REPO_ROOT, 'supabase/functions/office-grand-prix-action/index.ts'),
    'utf8',
  );
  const sqlSource = readFileSync(resolve(REPO_ROOT, 'supabase/office-grand-prix.sql'), 'utf8');

  assert.equal(stringConst(clientSource, 'OGP_CLIENT_VERSION'), C_ENGINE_VERSION);
  assert.equal(stringConst(serverSource, 'OGP_ENGINE_VERSION'), S_ENGINE_VERSION);

  const clientNumbers = {
    OGP_TICK_MS: C_TICK_MS,
    OGP_TRACK_LENGTH: C_TRACK_LENGTH,
    OGP_HARD_LIMIT_TICKS: C_MAX_TICKS,
    OGP_ACCEL: C_ACCEL,
    OGP_START_SPEED: C_START_SPEED,
    OGP_MAX_SPEED: C_MAX_SPEED,
    OGP_FORWARD_PCT: C_FORWARD_PCT,
    OGP_STEER_STEP: C_STEER_STEP,
    OGP_NEUTRAL_STEP: C_NEUTRAL_STEP,
    OGP_LANE_LIMIT: C_LANE_LIMIT,
    OGP_OFFROAD_AT: C_OFFROAD_AT,
    OGP_OFFROAD_PCT: C_OFFROAD_PCT,
    OGP_BOOST_TICKS: C_BOOST_TICKS,
    OGP_SLOW_TICKS: C_SLOW_TICKS,
    OGP_SHIELD_TICKS: C_SHIELD_TICKS,
  };
  for (const [name, expected] of Object.entries(clientNumbers)) {
    assert.equal(numericConst(clientSource, name), expected, `client ${name}`);
  }

  const serverNumbers = {
    OGP_TICK_MS: S_TICK_MS,
    OGP_TRACK_LENGTH: S_TRACK_LENGTH,
    OGP_MAX_TICKS: S_MAX_TICKS,
    OGP_ACCEL: S_ACCELERATION,
    OGP_START_SPEED: S_INITIAL_SPEED,
    OGP_MAX_SPEED: S_TOP_SPEED,
    OGP_FORWARD_PCT: S_FORWARD_PERCENT,
    OGP_STEER_PER_TICK: S_STEER_PER_TICK,
    OGP_NEUTRAL_RETURN: S_RETURN_PER_TICK,
    OGP_LANE_LIMIT: S_LANE_BOUND,
    OGP_OFFROAD_THRESHOLD: S_OFFROAD_BOUND,
    OGP_OFFROAD_PCT: S_OFFROAD_PERCENT,
    OGP_BOOST_PCT: S_TURBO_PERCENT,
    OGP_BOOST_TICKS: S_TURBO_DURATION,
    OGP_BANANA_PCT: S_BANANA_PERCENT,
    OGP_BANANA_TICKS: S_BANANA_DURATION,
    OGP_SHIELD_TICKS: S_SHIELD_DURATION,
    OGP_GATE_PICKUP_RADIUS: S_ITEM_RADIUS,
    OGP_BANANA_HIT_PROGRESS: S_HAZARD_PROGRESS_RADIUS,
    OGP_BANANA_HIT_LANE: S_HAZARD_LANE_RADIUS,
  };
  for (const [name, expected] of Object.entries(serverNumbers)) {
    assert.equal(numericConst(serverSource, name), expected, `server ${name}`);
  }

  assert.deepEqual(numberArray(clientSource, 'OGP_GATE_PROGRESS'), C_GATES);
  assert.deepEqual(numberArray(clientSource, 'OGP_GATE_LANES'), C_GATE_LANES);
  assert.deepEqual(numberArray(serverSource, 'OGP_GATES'), S_CHECKPOINTS);
  assert.deepEqual(numberArray(serverSource, 'OGP_GATE_LANES'), S_CHECKPOINT_LANES);
  assert.deepEqual(numberArray(serverSource, 'OGP_PLACEMENT_POINTS'), S_PLACE_POINTS);

  const clientCarsBlock = clientSource.match(/const\s+OGP_CARS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(clientCarsBlock, 'source contract missing OGP_CARS');
  assert.deepEqual([...clientCarsBlock[1].matchAll(/id:\s*'([^']+)'/g)].map((match) => match[1]), C_CARS);
  const serverCosmeticsBlock = serverSource.match(/const\s+OGP_COSMETICS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(serverCosmeticsBlock, 'source contract missing OGP_COSMETICS');
  assert.deepEqual([...serverCosmeticsBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]), S_COSMETICS);

  assertContains(clientSource, "{ turbo: '☕ Espresso', banana: '🍌 Banan', shield: '🛡️ Tarcza' }", 'client item names');
  assertContains(serverSource, 'type OGPItem = "turbo" | "banana" | "shield" | null;', 'server item names');
  assertContains(clientSource, 'const roll = ogpRandom(seed, slot, 1000 + gateIndex) % 100;', 'client stateless item RNG');
  assertContains(serverSource, 'const roll = ogpRandom(seed, slot, 1000 + gate) % 100;', 'server stateless item RNG');
  assertContains(
    clientSource,
    'seed: Number.isFinite(Number(seed)) ? (Number(seed) >>> 0) : 0x6d2b79f5,',
    'client preserves seed zero',
  );
  assertContains(serverSource, 'const raceSeed = seed >>> 0;', 'server preserves seed zero');
  assertContains(clientSource, 'if (car.boostTicks > 0) delta = Math.floor(delta * 125 / 100);', 'client turbo floor order');
  assertContains(clientSource, 'if (car.slowTicks > 0) delta = Math.floor(delta * 65 / 100);', 'client banana floor order');
  assertContains(clientSource, "Math.abs(car.lateral - OGP_GATE_LANES[gateIndex]) <= 1050", 'client pickup radius');
  assertContains(clientSource, 'Math.abs(car.progress - banana.progress) <= 420', 'client banana progress radius');
  assertContains(clientSource, 'Math.abs(car.lateral - bananaLane) <= 820', 'client banana lane radius');
  assertContains(serverSource, 'if (car.slowTicks > 0 && car.slowAppliedTick !== tick) car.slowTicks -= 1;', 'server slow timer timing');
  assertContains(clientSource, 'if (car.slowTicks > 0 && car.slowAppliedTick !== tick) car.slowTicks -= 1;', 'client slow timer timing');
  assertContains(clientSource, 'const neutralTick = terminalTick + 1;', 'client post-finish neutral tick');
  assertContains(
    clientSource,
    'const elapsedTicks = Math.max(terminalTick, Math.min(OGP_HARD_LIMIT_TICKS, wallTicks));',
    'client elapsed tick cap',
  );
  assertContains(serverSource, 'if (!car.isBot && tick > car.capTick)', 'server cap tick is inclusive');
  assertContains(serverSource, 'retired: !row.is_bot && !submission,', 'server missing-submission retirement');

  const submitClient = clientSource.match(/invokeOfficeGrandPrix\(\{\s*action:\s*'submit'([\s\S]*?)\n\s*\}\);/);
  assert.ok(submitClient, 'source contract missing client submit API');
  for (const field of ['sessionId:', 'engineVersion:', 'idempotencyKey:', 'inputs:', 'elapsedTicks,', 'clientMeta:']) {
    assert.ok(submitClient[0].includes(field), `client submit API field drift: ${field}`);
  }
  const submitServer = serverSource.slice(
    serverSource.indexOf('async function submitRace'),
    serverSource.indexOf('async function', serverSource.indexOf('async function submitRace') + 20),
  );
  for (const field of [
    'body.sessionId',
    'body.engineVersion',
    'body.elapsedTicks',
    'body.inputs ?? body.inputLog',
    'body.idempotencyKey',
    'body.clientMeta',
  ]) {
    assert.ok(submitServer.includes(field), `server submit API field drift: ${field}`);
  }
  for (const [clientField, serverField] of [
    ['itemHeldTicks', 'itemHeldTicks'],
    ['nextGate', 'nextGate'],
    ['boostTicks', 'boostTicks'],
    ['slowTicks', 'slowTicks'],
    ['slowAppliedTick', 'slowAppliedTick'],
    ['shieldTicks', 'shieldTicks'],
    ['finishedTick', 'finishTick'],
  ]) {
    assert.ok(clientSource.includes(clientField), `client race state field drift: ${clientField}`);
    assert.ok(serverSource.includes(serverField), `server race state field drift: ${serverField}`);
  }

  assertContains(
    sqlSource,
    'ORDER BY s.total_points DESC, s.finished DESC, s.completion_ms ASC NULLS LAST, s.submitted_at ASC, s.session_id',
    'best-five race tie order',
  );
  assertContains(sqlSource, 'SELECT * FROM eligible WHERE race_number <= 5', 'best-five count');
  assertContains(
    sqlSource,
    'ORDER BY score DESC, wins DESC, combined_time_ms ASC, first_result_at ASC, user_id',
    'weekly leaderboard tie order',
  );
}

// ── Deterministic fixtures and fuzz ─────────────────────────────────────────

function fuzzNext(state) {
  let value = state.value >>> 0;
  if (!value) value = 0x243f6a88;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value >>> 0;
  return state.value;
}

function makeInputLog(random, slot) {
  const events = [];
  let tick = 1 + (fuzzNext(random) % 20);
  while (tick <= C_MAX_TICKS) {
    const steerRoll = fuzzNext(random) % 10;
    const steer = steerRoll < 3 ? -1 : steerRoll < 6 ? 1 : 0;
    events.push({
      tick,
      steer,
      useItem: (fuzzNext(random) + slot) % 4 === 0,
    });
    tick += 10 + (fuzzNext(random) % 72);
  }
  return events;
}

function makeRaceSpec(random, raceNumber) {
  const seed = raceNumber === 0 ? 0 : fuzzNext(random);
  const humanCount = 1 + (fuzzNext(random) % 4);
  const racers = Array.from({ length: 8 }, (_, slot) => {
    const isBot = slot >= humanCount;
    return {
      userId: isBot ? null : `human-${slot}`,
      nick: isBot ? `Bot ${slot}` : `Human ${slot}`,
      isBot,
      carId: C_CARS[slot],
      elapsedTicks: C_MAX_TICKS,
      events: isBot ? [] : makeInputLog(random, slot),
    };
  });
  return { seed, racers };
}

function withoutCosmetic(result) {
  const copy = structuredClone(result);
  for (const row of copy.results) {
    delete row.cosmetic;
    delete row.cosmeticId;
  }
  return copy;
}

function withoutInputAccounting(result) {
  const copy = structuredClone(result);
  for (const row of copy.results) delete row.inputEvents;
  return copy;
}

function collectStats(replay, totals) {
  for (const row of replay.results) {
    totals.racers += 1;
    if (!row.finished) totals.dnfs += 1;
    totals.turbos += row.boostsUsed;
    totals.bananas += row.bananasDropped;
    totals.shields += row.shieldsUsed;
    totals.hits += row.bananasHit;
  }
}

function runGoldenTests() {
  assertSourceContracts();
  assert.equal(C_ENGINE_VERSION, S_ENGINE_VERSION);
  assert.deepEqual(C_GATES, S_CHECKPOINTS);
  assert.deepEqual(C_GATE_LANES, S_CHECKPOINT_LANES);
  assert.deepEqual(C_CARS, S_COSMETICS);

  const cleanSpec = {
    seed: 0x12345678,
    racers: C_CARS.map((carId, slot) => ({
      userId: `clean-${slot}`,
      nick: `Clean ${slot}`,
      isBot: false,
      carId,
      elapsedTicks: C_MAX_TICKS,
      events: [],
    })),
  };
  const cleanClient = browserReplayRace(cleanSpec);
  const cleanServer = serverReplayRace(cleanSpec);
  assert.deepEqual(cleanClient, cleanServer, 'clean-race browser/server parity');
  assert.ok(cleanClient.results.every((row) => row.finished), 'clean racers must finish');
  assert.ok(
    cleanClient.results[0].completionMs >= 55_000 && cleanClient.results[0].completionMs <= 70_000,
    `clean lap ${cleanClient.results[0].completionMs}ms is outside 55–70 seconds`,
  );

  const zeroSeedSpec = structuredClone(cleanSpec);
  zeroSeedSpec.seed = 0;
  const zeroSeedClient = browserReplayRace(zeroSeedSpec);
  const zeroSeedServer = serverReplayRace(zeroSeedSpec);
  assert.equal(zeroSeedClient.seed, 0, 'browser replaced seed zero');
  assert.equal(zeroSeedServer.seed, 0, 'server replaced seed zero');
  assert.deepEqual(zeroSeedClient, zeroSeedServer, 'seed-zero parity');

  const finishTick = cleanClient.results[0].finishTick;
  const neutralSpec = structuredClone(cleanSpec);
  for (const racer of neutralSpec.racers) {
    racer.elapsedTicks = finishTick + 5;
    racer.events = [{ tick: finishTick + 1, steer: 0, useItem: false }];
  }
  const neutralClient = browserReplayRace(neutralSpec);
  const neutralServer = serverReplayRace(neutralSpec);
  assert.deepEqual(neutralClient, neutralServer, 'post-finish neutral input parity');
  assert.deepEqual(
    withoutInputAccounting(neutralClient),
    withoutInputAccounting(cleanClient),
    'post-finish neutral input changed the result',
  );

  const retiredFixture = {
    seed: 0,
    racers: C_CARS.map((carId, slot) => ({
      userId: `retired-${slot}`,
      nick: `Retired ${slot}`,
      isBot: false,
      carId,
      submitted: slot !== 0,
      elapsedTicks: 1,
      events: [],
    })),
  };
  const retiredResult = serverReplayRace(retiredFixture);
  assert.equal(retiredResult.results.find((row) => row.slot === 0).progress, 0, 'missing submission moved');
  assert.ok(
    retiredResult.results.filter((row) => row.slot !== 0).every((row) => row.progress === 70),
    'cap tick must be simulated inclusively before DNF',
  );
  assert.ok(retiredResult.results.every((row) => !row.finished && row.totalPoints === 0), 'retired racers scored');

  const cosmeticRandom = { value: 0xabcdef01 };
  const cosmeticBase = makeRaceSpec(cosmeticRandom, 0);
  let cosmeticPhysics = null;
  for (const carId of C_CARS) {
    const spec = structuredClone(cosmeticBase);
    spec.racers[0].carId = carId;
    const client = browserReplayRace(spec);
    const server = serverReplayRace(spec);
    assert.deepEqual(client, server, `cosmetic parity for ${carId}`);
    const physics = withoutCosmetic(client);
    if (cosmeticPhysics == null) cosmeticPhysics = physics;
    else assert.deepEqual(physics, cosmeticPhysics, `${carId} entered physics or RNG`);
  }

  const orderedGates = C_GATES.map((_, index) => index);
  const missingGate = orderedGates.slice(0, -1);
  const outOfOrder = orderedGates.slice();
  [outOfOrder[4], outOfOrder[5]] = [outOfOrder[5], outOfOrder[4]];
  for (const validator of [cValidGateFinish, sValidGateFinish]) {
    assert.equal(validator(C_TRACK_LENGTH, 1200, orderedGates), true);
    assert.equal(validator(C_TRACK_LENGTH, 1200, missingGate), false, 'missing gate accepted');
    assert.equal(validator(C_TRACK_LENGTH, 1200, outOfOrder), false, 'out-of-order gates accepted');
    assert.equal(validator(C_TRACK_LENGTH, C_MAX_TICKS + 1, orderedGates), false, 'post-90s finish accepted');
    assert.equal(validator(C_TRACK_LENGTH - 1, 1200, orderedGates), false, 'shortcut accepted');
  }

  const scoringFixture = {
    seed: 0xfeedbeef,
    racers: C_CARS.map((carId, slot) => ({
        userId: slot === 0 ? 'alice' : slot === 1 ? 'bob' : `scorer-${slot}`,
        nick: slot === 0 ? 'Alice' : slot === 1 ? 'Bob' : `Scorer ${slot}`,
        isBot: false,
        carId,
        elapsedTicks: 1800,
        events: [],
    })),
  };
  const scoredClient = browserReplayRace(scoringFixture);
  const scoredServer = serverReplayRace(scoringFixture);
  assert.deepEqual(scoredClient, scoredServer, 'fixed score fixture parity');
  const byId = new Map(scoredClient.results.map((row) => [row.userId ?? row.nick, row]));
  assert.equal(byId.get('alice').placementPoints, 10);
  assert.equal(byId.get('alice').fastestBonus, 2);
  assert.equal(byId.get('alice').totalPoints, 12);
  assert.equal(byId.get('bob').placementPoints, 8);
  assert.equal(byId.get('bob').fastestBonus, 0);

  const botScoringFixture = {
    seed: 0xfeedbeef,
    racers: C_CARS.map((carId, slot) => ({
      userId: null,
      nick: `Bot ${slot}`,
      isBot: true,
      carId,
      elapsedTicks: 1800,
      events: [],
    })),
  };
  const botScoredClient = browserReplayRace(botScoringFixture);
  const botScoredServer = serverReplayRace(botScoringFixture);
  assert.deepEqual(botScoredClient, botScoredServer, 'bot score fixture parity');
  assert.ok(botScoredClient.results.every((row) => row.totalPoints === 0), 'bots must never score');

  const weeklyFixture = [
    { userId: 'alice', sessionId: 'a-12', totalPoints: 12, finished: true, completionMs: 62000, submittedAt: 1200, finishPlace: 1 },
    { userId: 'alice', sessionId: 'a-10', totalPoints: 10, finished: true, completionMs: 61000, submittedAt: 1100, finishPlace: 2 },
    { userId: 'alice', sessionId: 'a-8-fast', totalPoints: 8, finished: true, completionMs: 60000, submittedAt: 1400, finishPlace: 2 },
    { userId: 'alice', sessionId: 'a-8-slow', totalPoints: 8, finished: true, completionMs: 65000, submittedAt: 900, finishPlace: 2 },
    { userId: 'alice', sessionId: 'a-8-dnf', totalPoints: 8, finished: false, completionMs: null, submittedAt: 800, finishPlace: 8 },
    { userId: 'alice', sessionId: 'a-7-early', totalPoints: 7, finished: true, completionMs: 63000, submittedAt: 700, finishPlace: 3 },
    { userId: 'alice', sessionId: 'a-7-late', totalPoints: 7, finished: true, completionMs: 63000, submittedAt: 750, finishPlace: 3 },
    { userId: 'bob', sessionId: 'b-1', totalPoints: 12, finished: true, completionMs: 62000, submittedAt: 1000, finishPlace: 1 },
    { userId: 'bob', sessionId: 'b-2', totalPoints: 10, finished: true, completionMs: 61000, submittedAt: 1050, finishPlace: 2 },
    { userId: 'bob', sessionId: 'b-3', totalPoints: 8, finished: true, completionMs: 60000, submittedAt: 1100, finishPlace: 2 },
    { userId: 'bob', sessionId: 'b-4', totalPoints: 8, finished: true, completionMs: 65000, submittedAt: 1150, finishPlace: 2 },
    { userId: 'bob', sessionId: 'b-5', totalPoints: 8, finished: true, completionMs: 63000, submittedAt: 1200, finishPlace: 3 },
  ];
  const weeklyClient = cBestFiveLeaderboard(structuredClone(weeklyFixture));
  const weeklyServer = sBestFiveLeaderboard(structuredClone(weeklyFixture));
  assert.deepEqual(weeklyClient, weeklyServer, 'best-five tie parity');
  const alice = weeklyClient.find((row) => row.userId === 'alice');
  assert.deepEqual(
    alice.countedSessionIds,
    ['a-12', 'a-10', 'a-8-fast', 'a-8-slow', 'a-8-dnf'],
    'best-five race tie order drift',
  );
  assert.equal(alice.score, 46);
  assert.equal(alice.combinedTimeMs, 338000);
  assert.equal(weeklyClient[0].userId, 'bob', 'leaderboard combined-time tie must rank Bob first');

  const repeatRandom = { value: 0xcafef00d };
  const repeatSpec = makeRaceSpec(repeatRandom, 1);
  const clientOne = browserReplayRace(repeatSpec);
  const clientTwo = browserReplayRace(repeatSpec);
  const serverOne = serverReplayRace(repeatSpec);
  const serverTwo = serverReplayRace(repeatSpec);
  assert.deepEqual(clientOne, clientTwo, 'browser repeatability');
  assert.deepEqual(serverOne, serverTwo, 'server repeatability');
  assert.deepEqual(clientOne, serverOne, 'repeatability fixture parity');

  return cleanClient.results[0].completionMs;
}

function main() {
  const cleanLapMs = runGoldenTests();
  const random = { value: 0x0ff1ce42 };
  const totals = { racers: 0, dnfs: 0, turbos: 0, bananas: 0, shields: 0, hits: 0 };
  const fuzzRaces = 5000;

  for (let index = 0; index < fuzzRaces; index += 1) {
    const spec = makeRaceSpec(random, index);
    const client = browserReplayRace(spec);
    const server = serverReplayRace(spec);
    try {
      assert.deepEqual(client, server);
    } catch (error) {
      throw new Error(
        `parity mismatch at fuzz race ${index}, seed ${spec.seed}\n` +
        JSON.stringify({ client, server }, null, 2),
        { cause: error },
      );
    }
    collectStats(client, totals);
  }

  assert.ok(totals.turbos > 0, 'fuzz did not exercise turbo');
  assert.ok(totals.bananas > 0, 'fuzz did not exercise banana drops');
  assert.ok(totals.shields > 0, 'fuzz did not exercise shields');
  assert.ok(totals.hits > 0, 'fuzz did not exercise banana hits');
  console.log(
    `PASS office-grand-prix parity: source contracts + golden tests + ${fuzzRaces} fuzz races, ` +
    `${totals.racers} racer replays, 0 mismatches; clean lap ${(cleanLapMs / 1000).toFixed(2)}s; ` +
    `turbo/banana/shield ${totals.turbos}/${totals.bananas}/${totals.shields}, hits ${totals.hits}.`,
  );
}

try {
  main();
} catch (error) {
  console.error('FAIL office-grand-prix parity:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
