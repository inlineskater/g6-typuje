// Office Grand Prix deterministic parity and release harness.
//
// The browser-style and server-style engines below are intentionally separate
// transcriptions. Shared code is limited to fixtures, assertions, source-file
// inspection, and fuzz generation so one engine cannot hide drift in the other.
//
// Run:
//   node scripts/office-grand-prix-parity.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Browser-style engine (mirrors index.html) ───────────────────────────────

const C_ENGINE_VERSION = 'office_grand_prix_v2';
const C_TRACK_VERSION = 'office_loop_v2';
const C_TRACK_HASH = '4c6fe6372d604110d5b0fdbe9c23ac35d6bcf1d8aeb9fbb9737c44c5226daeb8';
const C_TICK_MS = 50;
const C_TRACK_LENGTH = 160000;
const C_START_PROGRESS = 16000;
const C_FINISH_PROGRESS = C_START_PROGRESS + C_TRACK_LENGTH;
const C_MAX_TICKS = 1800;
const C_ACCEL = 5;
const C_START_SPEED = 84;
const C_MAX_SPEED = 180;
const C_FORWARD_PCT = 96;
const C_STEER_RESPONSE = 300;
const C_STEER_CENTER = 360;
const C_STEER_MAX = 1000;
const C_TURN_RATE = 4;
const C_OFFROAD_AT = 3400;
const C_OFFROAD_PCT = 70;
const C_GRASS_MAX_SPEED = 115;
const C_GRASS_BRAKE = 8;
const C_GRASS_GRIP_PCT = 62;
const C_SAFETY_LATERAL = 6500;
const C_RESET_AFTER_TICKS = 20;
const C_RESET_CONTROL_TICKS = 12;
const C_BOOST_PCT = 125;
const C_BOOST_TICKS = 30;
const C_BANANA_PCT = 65;
const C_SLOW_TICKS = 25;
const C_SHIELD_TICKS = 160;
const C_PICKUP_RADIUS = 1050;
const C_BANANA_PROGRESS_RADIUS = 420;
const C_BANANA_LANE_RADIUS = 820;
const C_ANGLE_STEPS = 256;
const C_TRIG_SCALE = 10000;
const C_GATES = [29000, 44000, 59000, 74000, 89000, 104000, 119000, 134000, 149000, 164000];
const C_GATE_LANES = [-1800, 0, 1800, 0, -1800, 1800, 0, -1800, 1800, 0];
const C_TRACK_TANGENTS = [209,237,240,241,242,243,243,244,244,244,245,245,245,246,246,248,253,255,0,0,0,1,1,1,1,1,1,2,2,2,3,3,5,11,16,18,18,19,19,19,20,20,20,21,21,21,22,23,24,34,44,46,47,48,49,49,50,50,50,51,52,53,54,65,72,74,75,75,75,76,76,76,77,77,78,78,79,81,93,97,98,99,99,100,100,101,101,101,102,103,104,106,117,120,121,121,122,122,122,122,123,123,123,123,124,124,125,126,130,137,138,139,139,140,140,140,141,141,141,141,142,142,143,144,151,160,161,162,163,163,164,164,164,165,165,166,166,167,170,186,194,196,197,198,199,199,200,201,202,203,205,220,237,239,240,241,241,242,242,243,243,244,245,247,4,9,11,11,12,12,12,13,13,13,13,14,14,17,18,19,19,19,19,19,19,20,20,20,21,21,23,26,57,67,69,71,72,73,74,76,78,82,110,116,118,119,119,120,120,120,121,121,121,122,123,124,129,144,147,148,149,149,150,150,151,151,152,153,155,172,185,188,189,190,190,190,190,190,189,189,185,175,173,173,173,172,172,173,173,173,173,173,174,175,176,179];
const C_SIN = [0,245,491,736,980,1224,1467,1710,1951,2191,2430,2667,2903,3137,3369,3599,3827,4052,4276,4496,4714,4929,5141,5350,5556,5758,5957,6152,6344,6532,6716,6895,7071,7242,7410,7572,7730,7883,8032,8176,8315,8449,8577,8701,8819,8932,9040,9142,9239,9330,9415,9495,9569,9638,9700,9757,9808,9853,9892,9925,9952,9973,9988,9997,10000,9997,9988,9973,9952,9925,9892,9853,9808,9757,9700,9638,9569,9495,9415,9330,9239,9142,9040,8932,8819,8701,8577,8449,8315,8176,8032,7883,7730,7572,7410,7242,7071,6895,6716,6532,6344,6152,5957,5758,5556,5350,5141,4929,4714,4496,4276,4052,3827,3599,3369,3137,2903,2667,2430,2191,1951,1710,1467,1224,980,736,491,245,0,-245,-491,-736,-980,-1224,-1467,-1710,-1951,-2191,-2430,-2667,-2903,-3137,-3369,-3599,-3827,-4052,-4276,-4496,-4714,-4929,-5141,-5350,-5556,-5758,-5957,-6152,-6344,-6532,-6716,-6895,-7071,-7242,-7410,-7572,-7730,-7883,-8032,-8176,-8315,-8449,-8577,-8701,-8819,-8932,-9040,-9142,-9239,-9330,-9415,-9495,-9569,-9638,-9700,-9757,-9808,-9853,-9892,-9925,-9952,-9973,-9988,-9997,-10000,-9997,-9988,-9973,-9952,-9925,-9892,-9853,-9808,-9757,-9700,-9638,-9569,-9495,-9415,-9330,-9239,-9142,-9040,-8932,-8819,-8701,-8577,-8449,-8315,-8176,-8032,-7883,-7730,-7572,-7410,-7242,-7071,-6895,-6716,-6532,-6344,-6152,-5957,-5758,-5556,-5350,-5141,-4929,-4714,-4496,-4276,-4052,-3827,-3599,-3369,-3137,-2903,-2667,-2430,-2191,-1951,-1710,-1467,-1224,-980,-736,-491,-245];
const C_CARS = ['coral', 'sky', 'lime', 'amber', 'violet', 'teal', 'pink', 'silver'];
const C_PLACEMENT = [10, 8, 6, 5, 4, 3, 2, 1];
const C_FASTEST_HUMAN_BONUS = 2;
const C_TRACK_POINTS = [
  [-42,-31],[-15,-40],[17,-39],[43,-25],[52,-1],[44,25],
  [24,41],[-6,45],[-34,36],[-51,15],[-47,-7],[-25,-15],
  [-2,-8],[22,5],[18,23],[-8,28],[-28,16],[-30,-5],
];

function cClamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function cApproach(value, target, amount) {
  if (value < target) return Math.min(target, value + amount);
  if (value > target) return Math.max(target, value - amount);
  return target;
}

function cWrapAngle(value) {
  return ((Math.trunc(value) % C_ANGLE_STEPS) + C_ANGLE_STEPS) % C_ANGLE_STEPS;
}

function cAngleDelta(target, current) {
  const delta = cWrapAngle(target - current);
  return delta > C_ANGLE_STEPS / 2 ? delta - C_ANGLE_STEPS : delta;
}

function cSin(angle) {
  return C_SIN[cWrapAngle(angle)];
}

function cCos(angle) {
  return C_SIN[cWrapAngle(angle + C_ANGLE_STEPS / 4)];
}

function cTrackHeading(progress) {
  const wrapped = ((Math.trunc(progress) % C_TRACK_LENGTH) + C_TRACK_LENGTH) % C_TRACK_LENGTH;
  const index = Math.floor(wrapped * C_TRACK_TANGENTS.length / C_TRACK_LENGTH);
  return C_TRACK_TANGENTS[index];
}

function cGridPose(seed, slot) {
  const gridIndex = (slot + (seed >>> 0)) % 8;
  const row = Math.floor(gridIndex / 2);
  const column = gridIndex % 2;
  const progress = C_START_PROGRESS - row * 700;
  return {
    progress,
    lateral: column === 0 ? -1050 : 1050,
    heading: cTrackHeading(progress),
  };
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
    captureBotInputs: !!spec.captureBotInputs,
    cars: spec.racers.map((source, slot) => {
      const pose = cGridPose(seed, slot);
      return {
        slot,
        userId: source.userId ?? null,
        nick: source.nick,
        isBot: source.isBot === true,
        carId: C_CARS.includes(source.carId) ? source.carId : C_CARS[slot],
        cosmetic: C_CARS.indexOf(C_CARS.includes(source.carId) ? source.carId : C_CARS[slot]),
        progress: pose.progress,
        lateral: pose.lateral,
        heading: pose.heading,
        steering: 0,
        speed: C_START_SPEED,
        item: null,
        itemHeldTicks: 0,
        nextGate: 0,
        lastCheckpoint: C_START_PROGRESS,
        gateLog: [],
        boostTicks: 0,
        slowTicks: 0,
        slowAppliedTick: 0,
        shieldTicks: 0,
        outsideTicks: 0,
        resetTicks: 0,
        resetCount: 0,
        finishedTick: null,
        dnf: false,
        lastInput: { steer: 0, useItem: false },
        events: Array.isArray(source.events) ? source.events : [],
        eventIndex: 0,
        inputEvents: Array.isArray(source.events) ? source.events.length : 0,
        capturedEvents: [],
        capturedSteer: 0,
        bananasHit: 0,
        shieldsUsed: 0,
        boostsUsed: 0,
        bananasDropped: 0,
      };
    }),
  };
}

function cBotInput(race, car) {
  let targetLane = 0;
  const nextGate = C_GATES[car.nextGate];
  if (car.item == null && nextGate != null && nextGate >= car.progress && nextGate - car.progress <= 15000) {
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

  const lookAhead = 1800 + car.speed * 6;
  const laneCorrection = cClamp(Math.trunc((targetLane - car.lateral) / 240), -14, 14);
  const targetHeading = cWrapAngle(cTrackHeading(car.progress + lookAhead) - laneCorrection);
  const headingError = cAngleDelta(targetHeading, car.heading);
  const steer = Math.abs(headingError) <= 2 ? 0 : (headingError < 0 ? -1 : 1);
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
      progress: car.progress - 320,
      lane: car.lateral,
      lateral: car.lateral,
    });
  }
}

function cAdvancePose(car, steer) {
  const offroad = Math.abs(car.lateral) > C_OFFROAD_AT;
  const steeringStep = offroad
    ? Math.max(1, Math.floor(C_STEER_RESPONSE * C_GRASS_GRIP_PCT / 100))
    : C_STEER_RESPONSE;
  car.steering = cApproach(
    car.steering,
    steer * C_STEER_MAX,
    steer === 0 ? C_STEER_CENTER : steeringStep,
  );
  const gripPct = offroad ? C_GRASS_GRIP_PCT : 100;
  const turn = Math.trunc(
    car.steering * car.speed * C_TURN_RATE * gripPct /
    (C_STEER_MAX * C_MAX_SPEED * 100),
  );
  car.heading = cWrapAngle(car.heading + turn);

  const surfaceMaxSpeed = offroad ? C_GRASS_MAX_SPEED : C_MAX_SPEED;
  if (car.speed > surfaceMaxSpeed) {
    car.speed = Math.max(surfaceMaxSpeed, car.speed - C_GRASS_BRAKE);
  } else {
    car.speed = Math.min(surfaceMaxSpeed, car.speed + C_ACCEL);
  }
  let velocity = Math.floor(car.speed * C_FORWARD_PCT / 100);
  if (offroad) velocity = Math.floor(velocity * C_OFFROAD_PCT / 100);
  if (car.boostTicks > 0) velocity = Math.floor(velocity * C_BOOST_PCT / 100);
  if (car.slowTicks > 0) velocity = Math.floor(velocity * C_BANANA_PCT / 100);
  const relativeHeading = cAngleDelta(car.heading, cTrackHeading(car.progress));
  car.progress += Math.trunc(velocity * cCos(relativeHeading) / C_TRIG_SCALE);
  car.lateral += Math.trunc(velocity * cSin(-relativeHeading) / C_TRIG_SCALE);

  if (Math.abs(car.lateral) > C_SAFETY_LATERAL) car.outsideTicks += 1;
  else car.outsideTicks = 0;
  if (car.outsideTicks < C_RESET_AFTER_TICKS) return false;

  car.progress = Math.max(C_START_PROGRESS, car.lastCheckpoint - 800);
  car.lateral = 0;
  car.heading = cTrackHeading(car.progress);
  car.steering = 0;
  car.speed = C_START_SPEED;
  car.outsideTicks = 0;
  car.resetTicks = C_RESET_CONTROL_TICKS;
  car.resetCount += 1;
  return true;
}

function cStepRace(race) {
  if (!race || race.finished) return;
  const tick = race.tick + 1;
  const order = cRankOrder(race);
  const placeBySlot = new Map(order.map((car, index) => [car.slot, index + 1]));
  const inputs = new Map();

  for (const car of race.cars) {
    if (car.finishedTick != null) continue;
    let input = car.isBot ? cBotInput(race, car) : cHumanInput(car, tick);
    if (car.resetTicks > 0) {
      input = { steer: 0, useItem: false };
      car.resetTicks -= 1;
    }
    const normalized = {
      steer: cClamp(Math.trunc(input.steer || 0), -1, 1),
      useItem: !!input.useItem,
    };
    if (
      race.captureBotInputs &&
      car.isBot &&
      (normalized.steer !== car.capturedSteer || normalized.useItem)
    ) {
      car.capturedEvents.push({ tick, ...normalized });
      car.capturedSteer = normalized.steer;
    }
    inputs.set(car.slot, normalized);
  }

  for (const car of race.cars) {
    if (car.finishedTick != null) continue;
    const input = inputs.get(car.slot);
    car.lastInput = { steer: input.steer, useItem: false };
    if (input.useItem) cUseItem(race, car);

    const previousProgress = car.progress;
    if (cAdvancePose(car, input.steer)) continue;

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
      car.lastCheckpoint = C_GATES[gateIndex];
      car.nextGate += 1;
    }
    if (car.item) car.itemHeldTicks += 1;

    if (car.progress >= C_FINISH_PROGRESS && car.nextGate === C_GATES.length) {
      car.progress = C_FINISH_PROGRESS;
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
      lateral: car.lateral,
      heading: car.heading,
      steering: car.steering,
      resetCount: car.resetCount,
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
    trackVersion: C_TRACK_VERSION,
    trackHash: C_TRACK_HASH,
    seed: race.seed,
    ticks: Math.max(...results.map((row) => row.finishTick ?? C_MAX_TICKS)),
    results,
  };
}

// ── Server-style engine (mirrors office-grand-prix-action) ──────────────────

const S_ENGINE_VERSION = 'office_grand_prix_v2';
const S_TRACK_VERSION = 'office_loop_v2';
const S_TRACK_HASH = '4c6fe6372d604110d5b0fdbe9c23ac35d6bcf1d8aeb9fbb9737c44c5226daeb8';
const S_TICK_MS = 50;
const S_TRACK_LENGTH = 160000;
const S_START_PROGRESS = 16000;
const S_FINISH_PROGRESS = S_START_PROGRESS + S_TRACK_LENGTH;
const S_MAX_TICKS = 1800;
const S_ACCELERATION = 5;
const S_INITIAL_SPEED = 84;
const S_TOP_SPEED = 180;
const S_FORWARD_PERCENT = 96;
const S_STEER_RESPONSE = 300;
const S_STEER_CENTER = 360;
const S_STEER_MAX = 1000;
const S_TURN_RATE = 4;
const S_OFFROAD_BOUND = 3400;
const S_OFFROAD_PERCENT = 70;
const S_GRASS_TOP_SPEED = 115;
const S_GRASS_BRAKE = 8;
const S_GRASS_GRIP_PERCENT = 62;
const S_SAFETY_LANE = 6500;
const S_RESET_AFTER = 20;
const S_RESET_CONTROL = 12;
const S_TURBO_PERCENT = 125;
const S_TURBO_DURATION = 30;
const S_BANANA_PERCENT = 65;
const S_BANANA_DURATION = 25;
const S_SHIELD_DURATION = 160;
const S_ITEM_RADIUS = 1050;
const S_HAZARD_PROGRESS_RADIUS = 420;
const S_HAZARD_LANE_RADIUS = 820;
const S_ANGLE_COUNT = 256;
const S_TRIG_SCALE = 10000;
const S_CHECKPOINTS = [29000, 44000, 59000, 74000, 89000, 104000, 119000, 134000, 149000, 164000];
const S_CHECKPOINT_LANES = [-1800, 0, 1800, 0, -1800, 1800, 0, -1800, 1800, 0];
const S_TRACK_DIRECTIONS = [209,237,240,241,242,243,243,244,244,244,245,245,245,246,246,248,253,255,0,0,0,1,1,1,1,1,1,2,2,2,3,3,5,11,16,18,18,19,19,19,20,20,20,21,21,21,22,23,24,34,44,46,47,48,49,49,50,50,50,51,52,53,54,65,72,74,75,75,75,76,76,76,77,77,78,78,79,81,93,97,98,99,99,100,100,101,101,101,102,103,104,106,117,120,121,121,122,122,122,122,123,123,123,123,124,124,125,126,130,137,138,139,139,140,140,140,141,141,141,141,142,142,143,144,151,160,161,162,163,163,164,164,164,165,165,166,166,167,170,186,194,196,197,198,199,199,200,201,202,203,205,220,237,239,240,241,241,242,242,243,243,244,245,247,4,9,11,11,12,12,12,13,13,13,13,14,14,17,18,19,19,19,19,19,19,20,20,20,21,21,23,26,57,67,69,71,72,73,74,76,78,82,110,116,118,119,119,120,120,120,121,121,121,122,123,124,129,144,147,148,149,149,150,150,151,151,152,153,155,172,185,188,189,190,190,190,190,190,189,189,185,175,173,173,173,172,172,173,173,173,173,173,174,175,176,179];
const S_SINE = [0,245,491,736,980,1224,1467,1710,1951,2191,2430,2667,2903,3137,3369,3599,3827,4052,4276,4496,4714,4929,5141,5350,5556,5758,5957,6152,6344,6532,6716,6895,7071,7242,7410,7572,7730,7883,8032,8176,8315,8449,8577,8701,8819,8932,9040,9142,9239,9330,9415,9495,9569,9638,9700,9757,9808,9853,9892,9925,9952,9973,9988,9997,10000,9997,9988,9973,9952,9925,9892,9853,9808,9757,9700,9638,9569,9495,9415,9330,9239,9142,9040,8932,8819,8701,8577,8449,8315,8176,8032,7883,7730,7572,7410,7242,7071,6895,6716,6532,6344,6152,5957,5758,5556,5350,5141,4929,4714,4496,4276,4052,3827,3599,3369,3137,2903,2667,2430,2191,1951,1710,1467,1224,980,736,491,245,0,-245,-491,-736,-980,-1224,-1467,-1710,-1951,-2191,-2430,-2667,-2903,-3137,-3369,-3599,-3827,-4052,-4276,-4496,-4714,-4929,-5141,-5350,-5556,-5758,-5957,-6152,-6344,-6532,-6716,-6895,-7071,-7242,-7410,-7572,-7730,-7883,-8032,-8176,-8315,-8449,-8577,-8701,-8819,-8932,-9040,-9142,-9239,-9330,-9415,-9495,-9569,-9638,-9700,-9757,-9808,-9853,-9892,-9925,-9952,-9973,-9988,-9997,-10000,-9997,-9988,-9973,-9952,-9925,-9892,-9853,-9808,-9757,-9700,-9638,-9569,-9495,-9415,-9330,-9239,-9142,-9040,-8932,-8819,-8701,-8577,-8449,-8315,-8176,-8032,-7883,-7730,-7572,-7410,-7242,-7071,-6895,-6716,-6532,-6344,-6152,-5957,-5758,-5556,-5350,-5141,-4929,-4714,-4496,-4276,-4052,-3827,-3599,-3369,-3137,-2903,-2667,-2430,-2191,-1951,-1710,-1467,-1224,-980,-736,-491,-245];
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

function sApproach(value, target, amount) {
  if (value < target) return Math.min(target, value + amount);
  if (value > target) return Math.max(target, value - amount);
  return target;
}

function sWrapDirection(value) {
  return ((Math.trunc(value) % S_ANGLE_COUNT) + S_ANGLE_COUNT) % S_ANGLE_COUNT;
}

function sDirectionError(target, current) {
  const delta = sWrapDirection(target - current);
  return delta > S_ANGLE_COUNT / 2 ? delta - S_ANGLE_COUNT : delta;
}

function sSin(direction) {
  return S_SINE[sWrapDirection(direction)];
}

function sCos(direction) {
  return S_SINE[sWrapDirection(direction + S_ANGLE_COUNT / 4)];
}

function sTrackDirection(progress) {
  const wrapped = ((Math.trunc(progress) % S_TRACK_LENGTH) + S_TRACK_LENGTH) % S_TRACK_LENGTH;
  const index = Math.floor(wrapped * S_TRACK_DIRECTIONS.length / S_TRACK_LENGTH);
  return S_TRACK_DIRECTIONS[index];
}

function sGridPose(seed, slot) {
  const gridIndex = (slot + (seed >>> 0)) % 8;
  const row = Math.floor(gridIndex / 2);
  const column = gridIndex % 2;
  const progress = S_START_PROGRESS - row * 700;
  return {
    progress,
    lane: column === 0 ? -1050 : 1050,
    heading: sTrackDirection(progress),
  };
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

function sBotControl(car, cars, bananas, seed, tick) {
  let targetLane = 0;
  const nextCheckpoint = S_CHECKPOINTS[car.nextGate];
  if (
    car.item == null &&
    nextCheckpoint != null &&
    nextCheckpoint >= car.progress &&
    nextCheckpoint - car.progress <= 15000
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

  const lookAhead = 1800 + car.speed * 6;
  const laneCorrection = Math.max(-14, Math.min(14, Math.trunc((targetLane - car.lane) / 240)));
  const targetDirection = sWrapDirection(sTrackDirection(car.progress + lookAhead) - laneCorrection);
  const headingError = sDirectionError(targetDirection, car.heading);
  const steer = Math.abs(headingError) <= 2 ? 0 : headingError < 0 ? -1 : 1;
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
      progress: car.progress - 320,
      lane: car.lane,
      createdTick: tick,
    });
  }
  car.item = null;
  car.itemHeldTicks = 0;
}

function sAdvance(car, steer) {
  const onGrass = Math.abs(car.lane) > S_OFFROAD_BOUND;
  const response = onGrass
    ? Math.max(1, Math.floor(S_STEER_RESPONSE * S_GRASS_GRIP_PERCENT / 100))
    : S_STEER_RESPONSE;
  car.steering = sApproach(
    car.steering,
    steer * S_STEER_MAX,
    steer === 0 ? S_STEER_CENTER : response,
  );
  const grip = onGrass ? S_GRASS_GRIP_PERCENT : 100;
  const rotation = Math.trunc(
    car.steering * car.speed * S_TURN_RATE * grip /
    (S_STEER_MAX * S_TOP_SPEED * 100),
  );
  car.heading = sWrapDirection(car.heading + rotation);

  const speedLimit = onGrass ? S_GRASS_TOP_SPEED : S_TOP_SPEED;
  if (car.speed > speedLimit) car.speed = Math.max(speedLimit, car.speed - S_GRASS_BRAKE);
  else car.speed = Math.min(speedLimit, car.speed + S_ACCELERATION);
  let movement = Math.floor(car.speed * S_FORWARD_PERCENT / 100);
  if (onGrass) movement = Math.floor(movement * S_OFFROAD_PERCENT / 100);
  if (car.boostTicks > 0) movement = Math.floor(movement * S_TURBO_PERCENT / 100);
  if (car.slowTicks > 0) movement = Math.floor(movement * S_BANANA_PERCENT / 100);
  const relative = sDirectionError(car.heading, sTrackDirection(car.progress));
  car.progress += Math.trunc(movement * sCos(relative) / S_TRIG_SCALE);
  car.lane += Math.trunc(movement * sSin(-relative) / S_TRIG_SCALE);

  if (Math.abs(car.lane) > S_SAFETY_LANE) car.outsideTicks += 1;
  else car.outsideTicks = 0;
  if (car.outsideTicks < S_RESET_AFTER) return false;
  car.progress = Math.max(S_START_PROGRESS, car.lastCheckpoint - 800);
  car.lane = 0;
  car.heading = sTrackDirection(car.progress);
  car.steering = 0;
  car.speed = S_INITIAL_SPEED;
  car.outsideTicks = 0;
  car.resetTicks = S_RESET_CONTROL;
  car.resetCount += 1;
  return true;
}

function serverReplayRace(spec) {
  const raceSeed = Number(spec.seed) >>> 0;
  const cars = spec.racers
    .map((row, slot) => {
      const pose = sGridPose(raceSeed, slot);
      return {
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
        progress: pose.progress,
        lane: pose.lane,
        heading: pose.heading,
        steering: 0,
        item: null,
        itemHeldTicks: 0,
        nextGate: 0,
        lastCheckpoint: S_START_PROGRESS,
        gateLog: [],
        boostTicks: 0,
        slowTicks: 0,
        slowAppliedTick: 0,
        shieldTicks: 0,
        outsideTicks: 0,
        resetTicks: 0,
        resetCount: 0,
        bananasHit: 0,
        shieldsUsed: 0,
        boostsUsed: 0,
        bananasDropped: 0,
        finished: false,
        finishTick: null,
        retired: row.isBot !== true && row.submitted === false,
      };
    })
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
      if (car.resetTicks > 0) {
        steer = 0;
        useItem = false;
        car.resetTicks -= 1;
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

      const previousProgress = car.progress;
      if (sAdvance(car, control.steer)) continue;
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
        car.lastCheckpoint = S_CHECKPOINTS[gate];
        car.nextGate += 1;
      }

      if (car.item != null) car.itemHeldTicks += 1;
      if (car.progress >= S_FINISH_PROGRESS && car.nextGate === S_CHECKPOINTS.length) {
        car.progress = S_FINISH_PROGRESS;
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
      lateral: car.lane,
      heading: car.heading,
      steering: car.steering,
      resetCount: car.resetCount,
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
    trackVersion: S_TRACK_VERSION,
    trackHash: S_TRACK_HASH,
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
  if (progress < C_FINISH_PROGRESS || finishTick < 1 || finishTick > C_MAX_TICKS) return false;
  return Array.isArray(gates) && gates.length === C_GATES.length && gates.every((gate, index) => gate === index);
}

function sValidGateFinish(progress, finishTick, gates) {
  if (Number(progress) < S_FINISH_PROGRESS) return false;
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
  assert.equal(stringConst(clientSource, 'OGP_TRACK_VERSION'), C_TRACK_VERSION);
  assert.equal(stringConst(serverSource, 'OGP_TRACK_VERSION'), S_TRACK_VERSION);
  assert.equal(stringConst(clientSource, 'OGP_TRACK_HASH'), C_TRACK_HASH);
  assert.equal(stringConst(serverSource, 'OGP_TRACK_HASH'), S_TRACK_HASH);

  const clientNumbers = {
    OGP_TICK_MS: C_TICK_MS,
    OGP_TRACK_LENGTH: C_TRACK_LENGTH,
    OGP_START_PROGRESS: C_START_PROGRESS,
    OGP_HARD_LIMIT_TICKS: C_MAX_TICKS,
    OGP_ACCEL: C_ACCEL,
    OGP_START_SPEED: C_START_SPEED,
    OGP_MAX_SPEED: C_MAX_SPEED,
    OGP_FORWARD_PCT: C_FORWARD_PCT,
    OGP_STEER_RESPONSE: C_STEER_RESPONSE,
    OGP_STEER_CENTER: C_STEER_CENTER,
    OGP_STEER_MAX: C_STEER_MAX,
    OGP_TURN_RATE: C_TURN_RATE,
    OGP_OFFROAD_AT: C_OFFROAD_AT,
    OGP_OFFROAD_PCT: C_OFFROAD_PCT,
    OGP_GRASS_MAX_SPEED: C_GRASS_MAX_SPEED,
    OGP_GRASS_BRAKE: C_GRASS_BRAKE,
    OGP_GRASS_GRIP_PCT: C_GRASS_GRIP_PCT,
    OGP_SAFETY_LATERAL: C_SAFETY_LATERAL,
    OGP_RESET_AFTER_TICKS: C_RESET_AFTER_TICKS,
    OGP_RESET_CONTROL_TICKS: C_RESET_CONTROL_TICKS,
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
    OGP_START_PROGRESS: S_START_PROGRESS,
    OGP_MAX_TICKS: S_MAX_TICKS,
    OGP_ACCEL: S_ACCELERATION,
    OGP_START_SPEED: S_INITIAL_SPEED,
    OGP_MAX_SPEED: S_TOP_SPEED,
    OGP_FORWARD_PCT: S_FORWARD_PERCENT,
    OGP_STEER_RESPONSE: S_STEER_RESPONSE,
    OGP_STEER_CENTER: S_STEER_CENTER,
    OGP_STEER_MAX: S_STEER_MAX,
    OGP_TURN_RATE: S_TURN_RATE,
    OGP_OFFROAD_THRESHOLD: S_OFFROAD_BOUND,
    OGP_OFFROAD_PCT: S_OFFROAD_PERCENT,
    OGP_GRASS_MAX_SPEED: S_GRASS_TOP_SPEED,
    OGP_GRASS_BRAKE: S_GRASS_BRAKE,
    OGP_GRASS_GRIP_PCT: S_GRASS_GRIP_PERCENT,
    OGP_SAFETY_LATERAL: S_SAFETY_LANE,
    OGP_RESET_AFTER_TICKS: S_RESET_AFTER,
    OGP_RESET_CONTROL_TICKS: S_RESET_CONTROL,
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
  assert.deepEqual(numberArray(clientSource, 'OGP_TRACK_TANGENTS'), C_TRACK_TANGENTS);
  assert.deepEqual(numberArray(clientSource, 'OGP_SIN'), C_SIN);
  assert.deepEqual(numberArray(serverSource, 'OGP_GATES'), S_CHECKPOINTS);
  assert.deepEqual(numberArray(serverSource, 'OGP_GATE_LANES'), S_CHECKPOINT_LANES);
  assert.deepEqual(numberArray(serverSource, 'OGP_TRACK_TANGENTS'), S_TRACK_DIRECTIONS);
  assert.deepEqual(numberArray(serverSource, 'OGP_SIN'), S_SINE);
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
    'const raceSeed = Number.isFinite(Number(seed)) ? (Number(seed) >>> 0) : 0x6d2b79f5;',
    'client preserves seed zero',
  );
  assertContains(serverSource, 'const raceSeed = seed >>> 0;', 'server preserves seed zero');
  assertContains(clientSource, 'if (car.boostTicks > 0) velocity = Math.floor(velocity * 125 / 100);', 'client turbo floor order');
  assertContains(clientSource, 'if (car.slowTicks > 0) velocity = Math.floor(velocity * 65 / 100);', 'client banana floor order');
  assertContains(clientSource, 'car.heading = ogpWrapAngle(car.heading + turn);', 'client manual heading');
  assertContains(clientSource, 'car.lateral += lateralDelta;', 'client projected lateral motion');
  assertContains(serverSource, 'car.heading = ogpWrapAngle(car.heading + turn);', 'server manual heading');
  assertContains(serverSource, 'car.lane += Math.trunc(velocity * ogpSin(-relativeHeading) / OGP_TRIG_SCALE);', 'server projected lateral motion');
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
  for (const field of [
    'sessionId:', 'engineVersion:', 'trackVersion:', 'trackHash:', 'sessionVersion:',
    'idempotencyKey:', 'inputs:', 'elapsedTicks,', 'clientMeta:',
  ]) {
    assert.ok(submitClient[0].includes(field), `client submit API field drift: ${field}`);
  }
  const submitServer = serverSource.slice(
    serverSource.indexOf('async function submitRace'),
    serverSource.indexOf('async function', serverSource.indexOf('async function submitRace') + 20),
  );
  for (const field of [
    'body.sessionId',
    'requireV2ClientContract(body)',
    'requireCurrentSessionVersion(body, session)',
    'body.elapsedTicks',
    'body.inputs ?? body.inputLog',
    'body.idempotencyKey',
    'body.clientMeta',
  ]) {
    assert.ok(submitServer.includes(field), `server submit API field drift: ${field}`);
  }
  assertContains(serverSource, 'String(body.engineVersion ?? "") !== OGP_ENGINE_VERSION', 'server engine rejection');
  assertContains(serverSource, 'String(body.trackVersion ?? "") !== OGP_TRACK_VERSION', 'server track-version rejection');
  assertContains(serverSource, 'String(body.trackHash ?? "") !== OGP_TRACK_HASH', 'server track-hash rejection');
  assertContains(serverSource, 'const expected = asInt(body.sessionVersion, -1);', 'server stale-session rejection');
  for (const [clientField, serverField] of [
    ['heading', 'heading'],
    ['steering', 'steering'],
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
  for (const snapshotField of [
    'engineVersion: OGP_CLIENT_VERSION',
    'trackVersion: OGP_TRACK_VERSION',
    'trackHash: OGP_TRACK_HASH',
    'heading: car.heading',
    'steering: car.steering',
    'effects:',
  ]) {
    assert.ok(clientSource.includes(snapshotField), `snapshot contract drift: ${snapshotField}`);
  }
  assertContains(clientSource, 'runtime.accumulator / OGP_TICK_MS', 'local pose interpolation');
  assertContains(clientSource, 'const targetTick = race.tick - 3 + alpha;', 'remote snapshot buffer');
  assertContains(clientSource, 'mesh.rotation.y = -(headingRadians + Math.PI / 2);', 'kart forward axis');
  assertContains(clientSource, 'new THREE.MeshStandardMaterial({ color: 0x303642', 'uniform asphalt material');
  assert.ok(
    !clientSource.includes('mesh.position.y += .05 + Math.sin'),
    'sinusoidal kart bobbing returned',
  );
  assert.ok(
    !clientSource.includes('mesh.scale.setScalar(.82'),
    'whole-kart shield scaling returned',
  );
  assertContains(serverSource, 'const OGP_SESSIONS_ENABLED = false;', 'maintenance session gate');
  assertContains(
    sqlSource,
    "engine_version = 'office_grand_prix_v1'",
    'historical session V1 backfill',
  );
  assertContains(
    sqlSource,
    "engine_version           text NOT NULL DEFAULT 'office_grand_prix_v2'",
    'new session V2 default',
  );

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

function makeBotDrivenHumanSpec(seed, userIds = []) {
  const captureSpec = {
    seed,
    captureBotInputs: true,
    racers: C_CARS.map((carId, slot) => ({
      userId: null,
      nick: `Pilot ${slot}`,
      isBot: true,
      carId,
      elapsedTicks: C_MAX_TICKS,
      events: [],
    })),
  };
  const captureRace = cCreateRace(captureSpec);
  while (!captureRace.finished) cStepRace(captureRace);
  return {
    seed,
    racers: captureRace.cars.map((car, slot) => ({
      userId: userIds[slot] ?? `pilot-${slot}`,
      nick: userIds[slot] ?? `Pilot ${slot}`,
      isBot: false,
      carId: C_CARS[slot],
      elapsedTicks: C_MAX_TICKS,
      events: car.capturedEvents.map((event) => ({ ...event })),
    })),
  };
}

function runGoldenTests() {
  assertSourceContracts();
  assert.equal(C_ENGINE_VERSION, S_ENGINE_VERSION);
  assert.deepEqual(C_GATES, S_CHECKPOINTS);
  assert.deepEqual(C_GATE_LANES, S_CHECKPOINT_LANES);
  assert.deepEqual(C_CARS, S_COSMETICS);

  const trackPayload = {
    version: C_TRACK_VERSION,
    steps: C_ANGLE_STEPS,
    scale: C_TRIG_SCALE,
    points: C_TRACK_POINTS,
    tangents: C_TRACK_TANGENTS,
    sin: C_SIN,
  };
  const verifiedTrackHash = createHash('sha256')
    .update(JSON.stringify(trackPayload))
    .digest('hex');
  assert.equal(verifiedTrackHash, C_TRACK_HASH, 'checked-in track hash drift');
  assert.equal(verifiedTrackHash, S_TRACK_HASH, 'server track hash drift');

  const steeringSpec = {
    seed: 0x13572468,
    racers: C_CARS.map((carId, slot) => ({
      userId: `steer-${slot}`,
      nick: `Steer ${slot}`,
      isBot: false,
      carId,
      elapsedTicks: C_MAX_TICKS,
      events: [],
    })),
  };
  const steeringRace = cCreateRace(steeringSpec);
  const baseCar = steeringRace.cars[0];
  baseCar.progress = C_START_PROGRESS;
  baseCar.lateral = 0;
  baseCar.heading = cTrackHeading(baseCar.progress);
  baseCar.steering = 0;
  baseCar.speed = C_MAX_SPEED;
  const leftCar = structuredClone(baseCar);
  const rightCar = structuredClone(baseCar);
  for (let tick = 0; tick < 12; tick += 1) {
    cAdvancePose(leftCar, -1);
    cAdvancePose(rightCar, 1);
  }
  assert.ok(cAngleDelta(leftCar.heading, baseCar.heading) < 0, 'left input did not turn heading left');
  assert.ok(cAngleDelta(rightCar.heading, baseCar.heading) > 0, 'right input did not turn heading right');
  assert.ok(leftCar.lateral > 0, 'left input moved to the wrong side of the track');
  assert.ok(rightCar.lateral < 0, 'right input moved to the wrong side of the track');
  const neutralHeading = leftCar.heading;
  const neutralLateral = leftCar.lateral;
  for (let tick = 0; tick < 8; tick += 1) cAdvancePose(leftCar, 0);
  assert.equal(leftCar.steering, 0, 'neutral input did not center the wheels');
  assert.notEqual(leftCar.heading, cTrackHeading(leftCar.progress), 'neutral input recentered kart heading');
  assert.notEqual(leftCar.lateral, neutralLateral, 'neutral input recentered the lane');
  assert.ok(
    Math.abs(cAngleDelta(leftCar.heading, neutralHeading)) <= C_TURN_RATE * 4,
    'wheel-centering produced an implausible heading snap',
  );

  const gridPoses = C_CARS.map((_, slot) => cGridPose(0x2468ace0, slot));
  assert.equal(
    new Set(gridPoses.map((pose) => `${pose.progress}:${pose.lateral}`)).size,
    8,
    'starting grid poses overlap',
  );
  const unattendedRace = cCreateRace(steeringSpec);
  let unattendedMaxLateral = 0;
  let unattendedReset = false;
  for (let tick = 0; tick < 500 && !unattendedReset; tick += 1) {
    cStepRace(unattendedRace);
    const unattended = unattendedRace.cars[0];
    unattendedMaxLateral = Math.max(unattendedMaxLateral, Math.abs(unattended.lateral));
    unattendedReset = unattended.resetCount > 0;
  }
  assert.ok(unattendedMaxLateral > C_OFFROAD_AT, 'unattended kart stayed on the road through a bend');
  assert.equal(unattendedReset, true, 'out-of-envelope kart did not reset deterministically');

  for (const frameRate of [30, 60, 120]) {
    const samples = [];
    for (let frame = 0; frame < frameRate; frame += 1) {
      const elapsed = frame * 1000 / frameRate;
      const tick = Math.floor(elapsed / C_TICK_MS);
      const alpha = (elapsed - tick * C_TICK_MS) / C_TICK_MS;
      samples.push(tick * 100 + alpha * 100);
    }
    assert.ok(
      samples.slice(1).every((value, index) => value > samples[index]),
      `${frameRate}Hz interpolation contains a fixed-tick plateau`,
    );
  }

  const cleanSpec = {
    seed: 0x12345678,
    racers: C_CARS.map((carId, slot) => ({
      userId: null,
      nick: `Clean ${slot}`,
      isBot: true,
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
    cleanClient.results[0].completionMs >= 55_000 && cleanClient.results[0].completionMs <= 65_000,
    `clean lap ${cleanClient.results[0].completionMs}ms is outside 55–65 seconds: ${JSON.stringify(cleanClient.results)}`,
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
  assert.equal(
    retiredResult.results.find((row) => row.slot === 0).progress,
    sGridPose(retiredFixture.seed, 0).progress,
    'missing submission moved',
  );
  assert.ok(
    retiredResult.results.filter((row) => row.slot !== 0).every((row) =>
      row.progress > sGridPose(retiredFixture.seed, row.slot).progress
    ),
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
    assert.equal(validator(C_FINISH_PROGRESS, 1200, orderedGates), true);
    assert.equal(validator(C_FINISH_PROGRESS, 1200, missingGate), false, 'missing gate accepted');
    assert.equal(validator(C_FINISH_PROGRESS, 1200, outOfOrder), false, 'out-of-order gates accepted');
    assert.equal(validator(C_FINISH_PROGRESS, C_MAX_TICKS + 1, orderedGates), false, 'post-90s finish accepted');
    assert.equal(validator(C_FINISH_PROGRESS - 1, 1200, orderedGates), false, 'shortcut accepted');
  }

  const scoringFixture = makeBotDrivenHumanSpec(
    0xfeedbeef,
    C_CARS.map((_, slot) => slot === 0 ? 'alice' : slot === 1 ? 'bob' : `scorer-${slot}`),
  );
  const scoredClient = browserReplayRace(scoringFixture);
  const scoredServer = serverReplayRace(scoringFixture);
  assert.deepEqual(scoredClient, scoredServer, 'fixed score fixture parity');
  const firstHuman = scoredClient.results.find((row) => row.place === 1);
  const secondHuman = scoredClient.results.find((row) => row.place === 2);
  assert.equal(firstHuman.placementPoints, 10);
  assert.equal(firstHuman.fastestBonus, 2);
  assert.equal(firstHuman.totalPoints, 12);
  assert.equal(secondHuman.placementPoints, 8);
  assert.equal(secondHuman.fastestBonus, 0);

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
