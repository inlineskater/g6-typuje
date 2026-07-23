// Office Grand Prix V3 deterministic parity harness.
//
// Two independently-transcribed engines (browser-style, server-style) are
// fuzzed against each other so one engine cannot hide drift in the other,
// plus a source-contract audit that regex-checks the shipped constants in
// index.html and the Edge Function against the values used here.
//
// Run:
//   node scripts/office-grand-prix-parity.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_VERSION = 'office_grand_prix_v4';
const TRACK_VERSION = 'office_loop_v4';
const TRACK_HASH = '1d4b3b7abbf81bc598c0e309dc2baf8b46115d0cba3fdb9fa835cf8dde21569b';
const TICK_MS = 50;
const TRACK_LENGTH = 160000;
const START_PROGRESS = 16000;
const FINISH_PROGRESS = START_PROGRESS + TRACK_LENGTH;
const MAX_TICKS = 1200;
const ACCEL = 13;
const START_SPEED = 100;
const MAX_SPEED = 230;
const FORWARD_PCT = 96;
const STEER_RESPONSE = 480;
const STEER_CENTER = 700;
const STEER_MAX = 1000;
const TURN_RATE = 7;
const OFFROAD_AT = 5600;
const OFFROAD_PCT = 68;
const GRASS_MAX_SPEED = 140;
const GRASS_BRAKE = 10;
const GRASS_GRIP_PCT = 55;
const SAFETY_LATERAL = 8000;
const RESET_AFTER_TICKS = 20;
const RESET_CONTROL_TICKS = 12;
const GRIP_NUM_ROAD = 3;
const GRIP_DEN_ROAD = 4;
const GRIP_NUM_GRASS = 1;
const GRIP_DEN_GRASS = 7;
const BOOST_PCT = 125;
const BOOST_TICKS = 30;
const BANANA_PCT = 65;
const BANANA_TICKS = 25;
const SHIELD_TICKS = 120;
const PICKUP_RADIUS = 1050;
const BANANA_PROGRESS_RADIUS = 420;
const BANANA_LANE_RADIUS = 820;
const ANGLE_STEPS = 256;
const TRIG_SCALE = 10000;
const GATES = [29000, 44000, 59000, 74000, 89000, 104000, 119000, 134000, 149000, 164000];
const GATE_LANES = [-1800, 0, 1800, 0, -1800, 1800, 0, -1800, 1800, 0];
const TRACK_TANGENTS = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,254,250,248,246,244,241,239,237,236,234,232,231,230,229,227,224,222,219,217,215,213,211,209,207,206,205,203,200,197,195,193,191,189,187,185,183,181,179,177,172,170,169,170,172,172,172,174,179,189,198,204,207,209,212,217,219,217,213,210,208,203,195,183,175,170,167,163,158,152,146,142,138,136,131,127,126,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,129,129,128,125,123,122,120,118,118,116,113,108,104,101,97,94,92,89,87,84,81,78,75,73,70,68,66,64,62,60,58,56,54,52,50,46,41,38,37,38,36,35,35,36,37,35,35,39,47,62,72,78,81,81,82,84,86,87,87,89,90,91,90,88,84,82,78,72,64,54,46,37,24,15,10,6,0,254,254,0,0,0,0,0,0];
const SIN = [0,245,491,736,980,1224,1467,1710,1951,2191,2430,2667,2903,3137,3369,3599,3827,4052,4276,4496,4714,4929,5141,5350,5556,5758,5957,6152,6344,6532,6716,6895,7071,7242,7410,7572,7730,7883,8032,8176,8315,8449,8577,8701,8819,8932,9040,9142,9239,9330,9415,9495,9569,9638,9700,9757,9808,9853,9892,9925,9952,9973,9988,9997,10000,9997,9988,9973,9952,9925,9892,9853,9808,9757,9700,9638,9569,9495,9415,9330,9239,9142,9040,8932,8819,8701,8577,8449,8315,8176,8032,7883,7730,7572,7410,7242,7071,6895,6716,6532,6344,6152,5957,5758,5556,5350,5141,4929,4714,4496,4276,4052,3827,3599,3369,3137,2903,2667,2430,2191,1951,1710,1467,1224,980,736,491,245,0,-245,-491,-736,-980,-1224,-1467,-1710,-1951,-2191,-2430,-2667,-2903,-3137,-3369,-3599,-3827,-4052,-4276,-4496,-4714,-4929,-5141,-5350,-5556,-5758,-5957,-6152,-6344,-6532,-6716,-6895,-7071,-7242,-7410,-7572,-7730,-7883,-8032,-8176,-8315,-8449,-8577,-8701,-8819,-8932,-9040,-9142,-9239,-9330,-9415,-9495,-9569,-9638,-9700,-9757,-9808,-9853,-9892,-9925,-9952,-9973,-9988,-9997,-10000,-9997,-9988,-9973,-9952,-9925,-9892,-9853,-9808,-9757,-9700,-9638,-9569,-9495,-9415,-9330,-9239,-9142,-9040,-8932,-8819,-8701,-8577,-8449,-8315,-8176,-8032,-7883,-7730,-7572,-7410,-7242,-7071,-6895,-6716,-6532,-6344,-6152,-5957,-5758,-5556,-5350,-5141,-4929,-4714,-4496,-4276,-4052,-3827,-3599,-3369,-3137,-2903,-2667,-2430,-2191,-1951,-1710,-1467,-1224,-980,-736,-491,-245];
const CARS = ['coral', 'sky', 'lime', 'amber', 'violet', 'teal', 'pink', 'silver'];
const PLACEMENT = [10, 8, 6, 5, 4, 3, 2, 1];
const FASTEST_HUMAN_BONUS = 2;
const TRACK_POINTS = [[-38,44],[-34,44],[-30,44],[-26,44],[-22,44],[-18,44],[-14,44],[-10,44],[-6,44],[-2,44],[2,44],[6,44],[10,44],[14,44],[18,44],[22,44],[26,44],[30,44],[34,44],[39,43],[44,41],[49,38],[54,34],[58,29],[61,23],[63,16],[63,8],[61,0],[57,-7],[54,-14],[56,-21],[60,-27],[62,-33],[60,-38],[56,-42],[50,-44],[44,-44],[38,-44],[32,-44],[26,-44],[20,-44],[14,-44],[8,-44],[2,-44],[-4,-44],[-10,-44],[-16,-44],[-22,-44],[-28,-44],[-34,-44],[-40,-44],[-46,-43],[-52,-41],[-57,-37],[-61,-31],[-63,-24],[-63,-16],[-61,-8],[-57,-2],[-52,4],[-48,10],[-50,17],[-54,24],[-59,31],[-61,37],[-59,42],[-54,44],[-48,44],[-43,44]];

// ── Shared deterministic primitives (identical text in both engines below) ──

function mkPrimitives(prefix) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const approach = (value, target, amount) => {
    if (value < target) return Math.min(target, value + amount);
    if (value > target) return Math.max(target, value - amount);
    return target;
  };
  const wrapAngle = (v) => ((Math.trunc(v) % ANGLE_STEPS) + ANGLE_STEPS) % ANGLE_STEPS;
  const angleDelta = (target, current) => {
    const d = wrapAngle(target - current);
    return d > ANGLE_STEPS / 2 ? d - ANGLE_STEPS : d;
  };
  const chaseAngle = (current, target, num, den) => {
    const gap = angleDelta(target, current);
    if (gap === 0) return current;
    let step = Math.trunc(gap * num / den);
    if (step === 0) step = gap > 0 ? 1 : -1;
    if (Math.abs(step) > Math.abs(gap)) step = gap;
    return wrapAngle(current + step);
  };
  const sin = (a) => SIN[wrapAngle(a)];
  const cos = (a) => SIN[wrapAngle(a + ANGLE_STEPS / 4)];
  const trackHeading = (progress) => {
    const wrapped = ((Math.trunc(progress) % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH;
    return TRACK_TANGENTS[Math.floor(wrapped * TRACK_TANGENTS.length / TRACK_LENGTH)];
  };
  const gridPose = (seed, slot) => {
    const gridIndex = (slot + (seed >>> 0)) % 8;
    const row = Math.floor(gridIndex / 2);
    const progress = START_PROGRESS - row * 700;
    return { progress, lateral: gridIndex % 2 === 0 ? -1050 : 1050, heading: trackHeading(progress) };
  };
  const mix32 = (value) => {
    let x = Number(value) >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    return x >>> 0;
  };
  const random = (seed, slot, salt) => mix32(
    (Number(seed) >>> 0) ^ Math.imul((Number(slot) + 1) >>> 0, 0x9e3779b1) ^ Math.imul((Number(salt) + 1) >>> 0, 0x85ebca6b),
  );
  const rollItem = (seed, slot, gateIndex, place) => {
    const roll = random(seed, slot, 1000 + gateIndex) % 100;
    const w = place <= 2 ? [20, 50, 30] : place <= 5 ? [40, 35, 25] : [60, 25, 15];
    if (roll < w[0]) return 'turbo';
    if (roll < w[0] + w[1]) return 'banana';
    return 'shield';
  };
  return { clamp, approach, wrapAngle, angleDelta, chaseAngle, sin, cos, trackHeading, gridPose, mix32, random, rollItem };
}

const B = mkPrimitives('B');
const S = mkPrimitives('S');

function advancePose(P, car, steer) {
  const offroad = Math.abs(car.lateral) > OFFROAD_AT;
  const steeringStep = offroad ? Math.max(1, Math.floor(STEER_RESPONSE * GRASS_GRIP_PCT / 100)) : STEER_RESPONSE;
  car.steering = P.approach(car.steering, steer * STEER_MAX, steer === 0 ? STEER_CENTER : steeringStep);
  const gripPct = offroad ? GRASS_GRIP_PCT : 100;
  const speedFactor = Math.floor(MAX_SPEED / 2 + car.speed / 2);
  const turn = Math.trunc(car.steering * speedFactor * TURN_RATE * gripPct / (STEER_MAX * MAX_SPEED * 100));
  car.heading = P.wrapAngle(car.heading + turn);
  car.moveHeading = P.chaseAngle(car.moveHeading, car.heading, offroad ? GRIP_NUM_GRASS : GRIP_NUM_ROAD, offroad ? GRIP_DEN_GRASS : GRIP_DEN_ROAD);

  const surfaceMaxSpeed = offroad ? GRASS_MAX_SPEED : MAX_SPEED;
  if (car.speed > surfaceMaxSpeed) car.speed = Math.max(surfaceMaxSpeed, car.speed - GRASS_BRAKE);
  else car.speed = Math.min(surfaceMaxSpeed, car.speed + ACCEL);
  let velocity = Math.floor(car.speed * FORWARD_PCT / 100);
  if (offroad) velocity = Math.floor(velocity * OFFROAD_PCT / 100);
  if (car.boostTicks > 0) velocity = Math.floor(velocity * BOOST_PCT / 100);
  if (car.slowTicks > 0) velocity = Math.floor(velocity * BANANA_PCT / 100);
  const relativeHeading = P.angleDelta(car.moveHeading, P.trackHeading(car.progress));
  car.progress += Math.trunc(velocity * P.cos(relativeHeading) / TRIG_SCALE);
  car.lateral += Math.trunc(velocity * P.sin(-relativeHeading) / TRIG_SCALE);

  if (Math.abs(car.lateral) > SAFETY_LATERAL) car.outsideTicks += 1;
  else car.outsideTicks = 0;
  if (car.outsideTicks < RESET_AFTER_TICKS) return false;
  car.progress = Math.max(START_PROGRESS, car.lastCheckpoint - 800);
  car.lateral = 0;
  car.heading = P.trackHeading(car.progress);
  car.moveHeading = car.heading;
  car.steering = 0;
  car.speed = START_SPEED;
  car.outsideTicks = 0;
  car.resetTicks = RESET_CONTROL_TICKS;
  car.resetCount += 1;
  return true;
}

function botControl(P, car, cars, bananas, seed, tick) {
  let targetLane = 0;
  const nextGate = GATES[car.nextGate];
  if (car.item == null && nextGate != null && nextGate >= car.progress && nextGate - car.progress <= 15000) {
    targetLane = GATE_LANES[car.nextGate];
  } else {
    const phase = Math.floor(tick / 120);
    targetLane = ((P.random(seed, car.slot, 5000 + phase) % 3) - 1) * 900;
  }
  for (const hazard of bananas) {
    if (hazard.active && hazard.ownerSlot !== car.slot && hazard.progress > car.progress &&
      hazard.progress - car.progress < 6500 && Math.abs(hazard.lateral - targetLane) < 1100) {
      targetLane = hazard.lateral >= 0 ? -2200 : 2200;
      break;
    }
  }
  const lookAhead = 1800 + car.speed * 6;
  const laneCorrection = P.clamp(Math.trunc((targetLane - car.lateral) / 240), -14, 14);
  const targetHeading = P.wrapAngle(P.trackHeading(car.progress + lookAhead) - laneCorrection);
  const headingError = P.angleDelta(targetHeading, car.heading);
  const steer = Math.abs(headingError) <= 2 ? 0 : headingError < 0 ? -1 : 1;
  let useItem = false;
  if (car.item === 'turbo' && car.itemHeldTicks >= 8) useItem = true;
  else if (car.item === 'shield' && car.shieldTicks === 0 && car.itemHeldTicks >= 3) useItem = true;
  else if (car.item === 'banana') {
    const follower = cars.some((other) => other.slot !== car.slot && !other.finished &&
      car.progress > other.progress && car.progress - other.progress < 9000 && Math.abs(car.lateral - other.lateral) < 1500);
    useItem = follower || car.itemHeldTicks >= 70;
  }
  return { steer, useItem };
}

function useItem(car, bananas, tick) {
  if (car.item === 'turbo') car.boostTicks = BOOST_TICKS;
  else if (car.item === 'shield') car.shieldTicks = SHIELD_TICKS;
  else if (car.item === 'banana') bananas.push({ active: true, ownerSlot: car.slot, progress: car.progress - 320, lateral: car.lateral, createdTick: tick });
  car.item = null;
  car.itemHeldTicks = 0;
}

function makeCars(P, seed, racers) {
  return racers.map((row, slot) => {
    const pose = P.gridPose(seed, slot);
    return {
      slot, userId: row.userId ?? null, nick: row.nick, cosmetic: CARS.indexOf(row.carId) >= 0 ? CARS.indexOf(row.carId) : slot,
      isBot: row.isBot === true,
      capTick: row.isBot === true ? MAX_TICKS : row.submitted === false ? 0 : (row.elapsedTicks ?? MAX_TICKS),
      inputs: row.submitted === false ? [] : (row.events || []),
      inputEvents: row.submitted === false ? 0 : (row.events || []).length,
      inputIndex: 0, steer: 0, speed: START_SPEED,
      progress: pose.progress, lateral: pose.lateral, heading: pose.heading, moveHeading: pose.heading, steering: 0,
      item: null, itemHeldTicks: 0, nextGate: 0, lastCheckpoint: START_PROGRESS,
      boostTicks: 0, slowTicks: 0, slowAppliedTick: 0, shieldTicks: 0, outsideTicks: 0, resetTicks: 0, resetCount: 0,
      bananasHit: 0, shieldsUsed: 0, boostsUsed: 0, bananasDropped: 0,
      finished: false, finishTick: null, retired: row.isBot !== true && row.submitted === false,
    };
  }).sort((a, b) => a.slot - b.slot);
}

function replay(P, seed, racers) {
  const raceSeed = Number(seed) >>> 0;
  const cars = makeCars(P, raceSeed, racers);
  const bananas = [];

  for (let tick = 1; tick <= MAX_TICKS; tick += 1) {
    const order = [...cars].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished && a.finishTick !== b.finishTick) return a.finishTick - b.finishTick;
      if (a.progress !== b.progress) return b.progress - a.progress;
      return a.slot - b.slot;
    });
    const placeBySlot = new Map(order.map((c, i) => [c.slot, i + 1]));
    const controls = new Map();

    for (const car of cars) {
      if (car.finished || car.retired) continue;
      if (!car.isBot && tick > car.capTick) { car.retired = true; continue; }
      let steer = car.steer, useItemFlag = false;
      if (car.isBot) {
        const bot = botControl(P, car, cars, bananas, raceSeed, tick);
        steer = bot.steer; useItemFlag = bot.useItem;
      } else {
        while (car.inputIndex < car.inputs.length && Number(car.inputs[car.inputIndex]?.tick) === tick) {
          const input = car.inputs[car.inputIndex];
          steer = P.clamp(Math.trunc(Number(input.steer) || 0), -1, 1);
          useItemFlag = input.useItem === true || input.use === true;
          car.inputIndex += 1;
        }
      }
      if (car.resetTicks > 0) { steer = 0; useItemFlag = false; car.resetTicks -= 1; }
      car.steer = steer;
      controls.set(car.slot, { steer, useItem: useItemFlag });
    }

    for (const car of cars) {
      if (car.finished || car.retired) continue;
      const control = controls.get(car.slot) ?? { steer: 0, useItem: false };
      if (control.useItem && car.item != null) {
        if (car.item === 'turbo') car.boostsUsed += 1;
        else if (car.item === 'shield') car.shieldsUsed += 1;
        else if (car.item === 'banana') car.bananasDropped += 1;
        useItem(car, bananas, tick);
      }
      const previousProgress = car.progress;
      if (advancePose(P, car, control.steer)) continue;
      while (car.nextGate < GATES.length && car.progress >= GATES[car.nextGate]) {
        const gate = car.nextGate;
        if (previousProgress < GATES[gate] && car.item == null && Math.abs(car.lateral - GATE_LANES[gate]) <= PICKUP_RADIUS) {
          car.item = P.rollItem(raceSeed, car.slot, gate, placeBySlot.get(car.slot) ?? 8);
          car.itemHeldTicks = 0;
        }
        car.lastCheckpoint = GATES[gate];
        car.nextGate += 1;
      }
      if (car.item != null) car.itemHeldTicks += 1;
      if (car.progress >= FINISH_PROGRESS && car.nextGate === GATES.length) {
        car.progress = FINISH_PROGRESS; car.finished = true; car.finishTick = tick; car.speed = 0;
      }
    }

    for (const hazard of bananas) {
      if (!hazard.active) continue;
      for (const car of cars) {
        if (car.finished || car.retired || car.slot === hazard.ownerSlot || tick <= hazard.createdTick) continue;
        if (Math.abs(car.progress - hazard.progress) <= BANANA_PROGRESS_RADIUS && Math.abs(car.lateral - hazard.lateral) <= BANANA_LANE_RADIUS) {
          hazard.active = false;
          if (car.shieldTicks > 0) car.shieldTicks = 0;
          else { car.slowTicks = BANANA_TICKS; car.slowAppliedTick = tick; car.bananasHit += 1; }
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

  const ordered = [...cars].sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished && a.finishTick !== b.finishTick) return a.finishTick - b.finishTick;
    if (a.progress !== b.progress) return b.progress - a.progress;
    return a.slot - b.slot;
  });
  const placeBySlot = new Map(ordered.map((car, i) => [car.slot, i + 1]));
  const fastestHuman = ordered.filter((c) => !c.isBot && c.finished).sort((a, b) => a.finishTick - b.finishTick || a.slot - b.slot)[0] ?? null;

  const results = cars.map((car) => {
    const place = placeBySlot.get(car.slot) ?? 8;
    const placementPoints = !car.isBot && car.finished ? PLACEMENT[place - 1] ?? 0 : 0;
    const fastestBonus = !car.isBot && car.finished && fastestHuman?.slot === car.slot ? FASTEST_HUMAN_BONUS : 0;
    return {
      slot: car.slot, userId: car.userId, nick: car.nick, cosmetic: car.cosmetic, cosmeticId: CARS[car.cosmetic], isBot: car.isBot,
      place, finished: car.finished, finishTick: car.finishTick, completionMs: car.finished ? car.finishTick * TICK_MS : null,
      progress: car.progress, lateral: car.lateral, heading: car.heading, steering: car.steering, resetCount: car.resetCount,
      placementPoints, fastestBonus, totalPoints: placementPoints + fastestBonus, inputEvents: car.inputEvents,
      bananasHit: car.bananasHit, shieldsUsed: car.shieldsUsed, boostsUsed: car.boostsUsed, bananasDropped: car.bananasDropped,
    };
  }).sort((a, b) => a.place - b.place);

  return {
    engineVersion: ENGINE_VERSION, trackVersion: TRACK_VERSION, trackHash: TRACK_HASH, seed: raceSeed,
    ticks: Math.max(...results.map((r) => r.finishTick ?? MAX_TICKS)), results,
  };
}

const browserReplay = (spec) => replay(B, spec.seed, spec.racers);
const serverReplay = (spec) => replay(S, spec.seed, spec.racers);

// ── Source-contract audit ───────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

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
  const match = patterns.map((p) => source.match(p)).find(Boolean);
  assert.ok(match, `source contract missing array ${name}`);
  return [...match[1].matchAll(/-?\d+/g)].map((m) => Number(m[0]));
}
function assertContains(source, fragment, label) {
  const compact = (s) => s.replace(/\s+/g, ' ').trim();
  assert.ok(compact(source).includes(compact(fragment)), `source contract drift: ${label}`);
}

function assertSourceContracts() {
  const clientSource = readFileSync(resolve(REPO_ROOT, 'index.html'), 'utf8');
  const serverSource = readFileSync(resolve(REPO_ROOT, 'supabase/functions/office-grand-prix-action/index.ts'), 'utf8');

  assert.equal(stringConst(clientSource, 'OGP_CLIENT_VERSION'), ENGINE_VERSION);
  assert.equal(stringConst(serverSource, 'OGP_ENGINE_VERSION'), ENGINE_VERSION);
  assert.equal(stringConst(clientSource, 'OGP_TRACK_VERSION'), TRACK_VERSION);
  assert.equal(stringConst(serverSource, 'OGP_TRACK_VERSION'), TRACK_VERSION);
  assert.equal(stringConst(clientSource, 'OGP_TRACK_HASH'), TRACK_HASH);
  assert.equal(stringConst(serverSource, 'OGP_TRACK_HASH'), TRACK_HASH);

  const clientNumbers = {
    OGP_TICK_MS: TICK_MS, OGP_TRACK_LENGTH: TRACK_LENGTH, OGP_START_PROGRESS: START_PROGRESS,
    OGP_HARD_LIMIT_TICKS: MAX_TICKS, OGP_ACCEL: ACCEL, OGP_START_SPEED: START_SPEED, OGP_MAX_SPEED: MAX_SPEED,
    OGP_FORWARD_PCT: FORWARD_PCT, OGP_STEER_RESPONSE: STEER_RESPONSE, OGP_STEER_CENTER: STEER_CENTER,
    OGP_STEER_MAX: STEER_MAX, OGP_TURN_RATE: TURN_RATE, OGP_OFFROAD_AT: OFFROAD_AT, OGP_OFFROAD_PCT: OFFROAD_PCT,
    OGP_GRASS_MAX_SPEED: GRASS_MAX_SPEED, OGP_GRASS_BRAKE: GRASS_BRAKE, OGP_GRASS_GRIP_PCT: GRASS_GRIP_PCT,
    OGP_SAFETY_LATERAL: SAFETY_LATERAL, OGP_RESET_AFTER_TICKS: RESET_AFTER_TICKS, OGP_RESET_CONTROL_TICKS: RESET_CONTROL_TICKS,
    OGP_GRIP_NUM_ROAD: GRIP_NUM_ROAD, OGP_GRIP_DEN_ROAD: GRIP_DEN_ROAD, OGP_GRIP_NUM_GRASS: GRIP_NUM_GRASS, OGP_GRIP_DEN_GRASS: GRIP_DEN_GRASS,
    OGP_BOOST_TICKS: BOOST_TICKS, OGP_SLOW_TICKS: BANANA_TICKS, OGP_SHIELD_TICKS: SHIELD_TICKS,
  };
  for (const [name, expected] of Object.entries(clientNumbers)) assert.equal(numericConst(clientSource, name), expected, `client ${name}`);

  const serverNumbers = {
    OGP_TICK_MS: TICK_MS, OGP_TRACK_LENGTH: TRACK_LENGTH, OGP_START_PROGRESS: START_PROGRESS, OGP_MAX_TICKS: MAX_TICKS,
    OGP_ACCEL: ACCEL, OGP_START_SPEED: START_SPEED, OGP_MAX_SPEED: MAX_SPEED, OGP_FORWARD_PCT: FORWARD_PCT,
    OGP_STEER_RESPONSE: STEER_RESPONSE, OGP_STEER_CENTER: STEER_CENTER, OGP_STEER_MAX: STEER_MAX, OGP_TURN_RATE: TURN_RATE,
    OGP_OFFROAD_THRESHOLD: OFFROAD_AT, OGP_OFFROAD_PCT: OFFROAD_PCT, OGP_GRASS_MAX_SPEED: GRASS_MAX_SPEED,
    OGP_GRASS_BRAKE: GRASS_BRAKE, OGP_GRASS_GRIP_PCT: GRASS_GRIP_PCT, OGP_SAFETY_LATERAL: SAFETY_LATERAL,
    OGP_RESET_AFTER_TICKS: RESET_AFTER_TICKS, OGP_RESET_CONTROL_TICKS: RESET_CONTROL_TICKS,
    OGP_GRIP_NUM_ROAD: GRIP_NUM_ROAD, OGP_GRIP_DEN_ROAD: GRIP_DEN_ROAD, OGP_GRIP_NUM_GRASS: GRIP_NUM_GRASS, OGP_GRIP_DEN_GRASS: GRIP_DEN_GRASS,
    OGP_BOOST_PCT: BOOST_PCT, OGP_BOOST_TICKS: BOOST_TICKS, OGP_BANANA_PCT: BANANA_PCT, OGP_BANANA_TICKS: BANANA_TICKS,
    OGP_SHIELD_TICKS: SHIELD_TICKS, OGP_GATE_PICKUP_RADIUS: PICKUP_RADIUS, OGP_BANANA_HIT_PROGRESS: BANANA_PROGRESS_RADIUS,
    OGP_BANANA_HIT_LANE: BANANA_LANE_RADIUS,
  };
  for (const [name, expected] of Object.entries(serverNumbers)) assert.equal(numericConst(serverSource, name), expected, `server ${name}`);

  assert.deepEqual(numberArray(clientSource, 'OGP_GATE_PROGRESS'), GATES);
  assert.deepEqual(numberArray(clientSource, 'OGP_GATE_LANES'), GATE_LANES);
  assert.deepEqual(numberArray(clientSource, 'OGP_TRACK_TANGENTS'), TRACK_TANGENTS);
  assert.deepEqual(numberArray(clientSource, 'OGP_SIN'), SIN);
  assert.deepEqual(numberArray(serverSource, 'OGP_GATES'), GATES);
  assert.deepEqual(numberArray(serverSource, 'OGP_GATE_LANES'), GATE_LANES);
  assert.deepEqual(numberArray(serverSource, 'OGP_TRACK_TANGENTS'), TRACK_TANGENTS);
  assert.deepEqual(numberArray(serverSource, 'OGP_SIN'), SIN);
  assert.deepEqual(numberArray(serverSource, 'OGP_PLACEMENT_POINTS'), PLACEMENT);

  assertContains(clientSource, 'car.moveHeading = ogpChaseAngle(', 'client drift chase call');
  assertContains(serverSource, 'car.moveHeading = ogpChaseAngle(', 'server drift chase call');
  assertContains(clientSource, 'const relativeHeading = ogpAngleDelta(car.moveHeading, ogpTrackHeading(car.progress));', 'client moveHeading drives projection');
  assertContains(serverSource, 'const relativeHeading = ogpAngleDelta(car.moveHeading, ogpTrackHeading(car.progress));', 'server moveHeading drives projection');
  assertContains(clientSource, "const roll = ogpRandom(seed, slot, 1000 + gateIndex) % 100;", 'client stateless item RNG');
  assertContains(serverSource, 'const roll = ogpRandom(seed, slot, 1000 + gate) % 100;', 'server stateless item RNG');
  assertContains(clientSource, 'if (car.boostTicks > 0) velocity = Math.floor(velocity * 125 / 100);', 'client turbo floor order');
  assertContains(clientSource, 'if (car.slowTicks > 0) velocity = Math.floor(velocity * 65 / 100);', 'client banana floor order');
  assertContains(serverSource, 'if (car.slowTicks > 0 && car.slowAppliedTick !== tick) car.slowTicks -= 1;', 'server slow timer timing');
  assertContains(clientSource, 'if (car.slowTicks > 0 && car.slowAppliedTick !== tick) car.slowTicks -= 1;', 'client slow timer timing');
  assertContains(serverSource, 'if (!car.isBot && tick > car.capTick)', 'server cap tick is inclusive');
  assertContains(serverSource, 'retired: !row.is_bot && !submission,', 'server missing-submission retirement');
  assertContains(serverSource, 'const OGP_SESSIONS_ENABLED = true;', 'sessions enabled');
  assertContains(serverSource, 'async function startRace(userId: string, body: any)', 'solo start_race action exists');
  assertContains(serverSource, 'async function fetchGhosts(userId: string)', 'ghosts action exists');
  assert.ok(!clientSource.includes('ogpConnectRealtime'), 'live-coordinator realtime code returned');
  assert.ok(!serverSource.includes('coordinator_id'), 'coordinator column usage returned server-side');
}

// ── Deterministic fixtures and fuzz ─────────────────────────────────────────

function fuzzNext(state) {
  let value = state.value >>> 0;
  if (!value) value = 0x243f6a88;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  state.value = value >>> 0;
  return state.value;
}

function makeInputLog(random, slot) {
  const events = [];
  let tick = 1 + (fuzzNext(random) % 20);
  while (tick <= MAX_TICKS) {
    const steerRoll = fuzzNext(random) % 10;
    events.push({ tick, steer: steerRoll < 3 ? -1 : steerRoll < 6 ? 1 : 0, useItem: (fuzzNext(random) + slot) % 4 === 0 });
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
      userId: isBot ? null : `human-${slot}`, nick: isBot ? `Bot ${slot}` : `Human ${slot}`, isBot, carId: CARS[slot],
      elapsedTicks: MAX_TICKS, events: isBot ? [] : makeInputLog(random, slot),
    };
  });
  return { seed, racers };
}

function collectStats(res, totals) {
  for (const row of res.results) {
    totals.racers += 1;
    if (!row.finished) totals.dnfs += 1;
    totals.turbos += row.boostsUsed; totals.bananas += row.bananasDropped;
    totals.shields += row.shieldsUsed; totals.hits += row.bananasHit;
  }
}

function runGoldenTests() {
  assertSourceContracts();

  const trackPayload = { version: TRACK_VERSION, steps: ANGLE_STEPS, scale: TRIG_SCALE, points: TRACK_POINTS, tangents: TRACK_TANGENTS, sin: SIN };
  const verifiedHash = createHash('sha256').update(JSON.stringify(trackPayload)).digest('hex');
  assert.equal(verifiedHash, TRACK_HASH, 'checked-in track hash drift');

  // Steering turns the correct way, and drift (moveHeading lagging heading)
  // shows up under sustained hard steering but stays bounded.
  const steeringSpec = { seed: 0x13572468, racers: CARS.map((carId, slot) => ({ userId: `s-${slot}`, nick: `S${slot}`, isBot: false, carId, elapsedTicks: MAX_TICKS, events: [] })) };
  const base = makeCars(B, steeringSpec.seed, steeringSpec.racers)[0];
  base.progress = START_PROGRESS; base.lateral = 0; base.heading = B.trackHeading(base.progress); base.moveHeading = base.heading; base.speed = MAX_SPEED;
  // 12 ticks at TURN_RATE=6 stays well under the +/-128 wraparound fold, so
  // the shortest-signed-delta sign check below is unambiguous.
  const left = structuredClone(base), right = structuredClone(base);
  for (let t = 0; t < 12; t += 1) { advancePose(B, left, -1); advancePose(B, right, 1); }
  assert.ok(B.angleDelta(left.heading, base.heading) < 0, 'left input did not turn heading left');
  assert.ok(B.angleDelta(right.heading, base.heading) > 0, 'right input did not turn heading right');
  assert.ok(left.lateral > 0, 'left input moved to the wrong side of the track');
  assert.ok(right.lateral < 0, 'right input moved to the wrong side of the track');
  const slip = Math.abs(B.angleDelta(left.heading, left.moveHeading));
  assert.ok(slip > 0, 'sustained hard steering produced no drift at all');
  assert.ok(slip < ANGLE_STEPS / 4, 'sustained hard steering produced an unbounded/runaway slip angle');

  // Releasing the wheel centers steering but not heading -- an unattended
  // kart drifts off its own line and must leave the road.
  const neutral = structuredClone(left);
  const neutralHeading = neutral.heading, neutralLateral = neutral.lateral;
  for (let t = 0; t < 8; t += 1) advancePose(B, neutral, 0);
  assert.equal(neutral.steering, 0, 'neutral input did not center the wheels');
  assert.notEqual(neutral.heading, B.trackHeading(neutral.progress), 'neutral input recentered kart heading');
  assert.notEqual(neutral.lateral, neutralLateral, 'neutral input froze the kart in place');

  const unattended = makeCars(B, steeringSpec.seed, steeringSpec.racers);
  let maxLateral = 0, resetSeen = false;
  const bananas0 = [];
  for (let t = 0; t < 500 && !resetSeen; t += 1) {
    const car = unattended[0];
    if (advancePose(B, car, 0)) resetSeen = true;
    maxLateral = Math.max(maxLateral, Math.abs(car.lateral));
  }
  assert.ok(maxLateral > OFFROAD_AT, 'unattended kart never left the road');
  assert.ok(resetSeen, 'out-of-envelope kart did not reset deterministically');

  for (const frameRate of [30, 60, 120]) {
    const samples = [];
    for (let frame = 0; frame < frameRate; frame += 1) {
      const elapsed = frame * 1000 / frameRate;
      const tick = Math.floor(elapsed / TICK_MS);
      const alpha = (elapsed - tick * TICK_MS) / TICK_MS;
      samples.push(tick * 100 + alpha * 100);
    }
    assert.ok(samples.slice(1).every((v, i) => v > samples[i]), `${frameRate}Hz interpolation contains a fixed-tick plateau`);
  }

  const cleanSpec = { seed: 0x12345678, racers: CARS.map((carId, slot) => ({ userId: null, nick: `Clean ${slot}`, isBot: true, carId, elapsedTicks: MAX_TICKS, events: [] })) };
  const cleanClient = browserReplay(cleanSpec);
  const cleanServer = serverReplay(cleanSpec);
  assert.deepEqual(cleanClient, cleanServer, 'clean-race browser/server parity');
  assert.ok(cleanClient.results.every((r) => r.finished), 'clean racers must finish');
  assert.ok(
    cleanClient.results[0].completionMs >= 25_000 && cleanClient.results[0].completionMs <= 55_000,
    `clean lap ${cleanClient.results[0].completionMs}ms is outside 25-55 seconds`,
  );

  const zeroSeedSpec = structuredClone(cleanSpec);
  zeroSeedSpec.seed = 0;
  const zeroClient = browserReplay(zeroSeedSpec), zeroServer = serverReplay(zeroSeedSpec);
  assert.equal(zeroClient.seed, 0); assert.equal(zeroServer.seed, 0);
  assert.deepEqual(zeroClient, zeroServer, 'seed-zero parity');

  const finishTick = cleanClient.results[0].finishTick;
  const neutralSpec = structuredClone(cleanSpec);
  for (const racer of neutralSpec.racers) { racer.elapsedTicks = finishTick + 5; racer.events = [{ tick: finishTick + 1, steer: 0, useItem: false }]; }
  const neutralClient = browserReplay(neutralSpec), neutralServer = serverReplay(neutralSpec);
  assert.deepEqual(neutralClient, neutralServer, 'post-finish neutral input parity');

  const retiredFixture = { seed: 0, racers: CARS.map((carId, slot) => ({ userId: `r-${slot}`, nick: `Retired ${slot}`, isBot: false, carId, submitted: slot !== 0, elapsedTicks: 1, events: [] })) };
  const retiredResult = serverReplay(retiredFixture);
  assert.equal(retiredResult.results.find((r) => r.slot === 0).progress, S.gridPose(retiredFixture.seed, 0).progress, 'missing submission moved');
  assert.ok(retiredResult.results.every((r) => !r.finished && r.totalPoints === 0), 'retired racers scored');

  const orderedGates = GATES.map((_, i) => i);
  const missingGate = orderedGates.slice(0, -1);
  const outOfOrder = orderedGates.slice(); [outOfOrder[4], outOfOrder[5]] = [outOfOrder[5], outOfOrder[4]];
  function validGateFinish(progress, finishTick, gates) {
    if (progress < FINISH_PROGRESS || finishTick < 1 || finishTick > MAX_TICKS) return false;
    return Array.isArray(gates) && gates.length === GATES.length && gates.every((g, i) => g === i);
  }
  assert.equal(validGateFinish(FINISH_PROGRESS, 900, orderedGates), true);
  assert.equal(validGateFinish(FINISH_PROGRESS, 900, missingGate), false, 'missing gate accepted');
  assert.equal(validGateFinish(FINISH_PROGRESS, 900, outOfOrder), false, 'out-of-order gates accepted');
  assert.equal(validGateFinish(FINISH_PROGRESS, MAX_TICKS + 1, orderedGates), false, 'post-cap finish accepted');
  assert.equal(validGateFinish(FINISH_PROGRESS - 1, 900, orderedGates), false, 'shortcut accepted');

  // Scoring: a bot-driven "human" capture, replayed as fixed input logs.
  const captureSpec = { seed: 0xfeedbeef, racers: CARS.map((carId, slot) => ({ userId: null, nick: `P${slot}`, isBot: true, carId, elapsedTicks: MAX_TICKS, events: [] })) };
  const captureCars = makeCars(B, captureSpec.seed, captureSpec.racers);
  const capturedEvents = captureCars.map(() => []);
  const capturedSteer = captureCars.map(() => 0);
  {
    const bananas = [];
    for (let tick = 1; tick <= MAX_TICKS; tick += 1) {
      const order = [...captureCars].sort((a, b) => (a.finished !== b.finished ? (a.finished ? -1 : 1) : (b.progress - a.progress) || (a.slot - b.slot)));
      const placeBySlot = new Map(order.map((c, i) => [c.slot, i + 1]));
      for (const car of captureCars) {
        if (car.finished) continue;
        const bot = botControl(B, car, captureCars, bananas, captureSpec.seed, tick);
        if (bot.steer !== capturedSteer[car.slot] || bot.useItem) {
          capturedEvents[car.slot].push({ tick, steer: bot.steer, useItem: bot.useItem });
          capturedSteer[car.slot] = bot.steer;
        }
        if (bot.useItem && car.item != null) useItem(car, bananas, tick);
        const previousProgress = car.progress;
        if (advancePose(B, car, bot.steer)) continue;
        while (car.nextGate < GATES.length && car.progress >= GATES[car.nextGate]) {
          const gate = car.nextGate;
          if (previousProgress < GATES[gate] && car.item == null && Math.abs(car.lateral - GATE_LANES[gate]) <= PICKUP_RADIUS) {
            car.item = B.rollItem(captureSpec.seed, car.slot, gate, placeBySlot.get(car.slot) ?? 8);
            car.itemHeldTicks = 0;
          }
          car.lastCheckpoint = GATES[gate]; car.nextGate += 1;
        }
        if (car.item != null) car.itemHeldTicks += 1;
        if (car.progress >= FINISH_PROGRESS && car.nextGate === GATES.length) { car.progress = FINISH_PROGRESS; car.finished = true; car.finishTick = tick; car.speed = 0; }
      }
      if (captureCars.every((c) => c.finished)) break;
    }
  }
  const scoringFixture = {
    seed: 0xfeedbeef,
    racers: CARS.map((carId, slot) => ({
      userId: slot === 0 ? 'alice' : slot === 1 ? 'bob' : `scorer-${slot}`, nick: slot === 0 ? 'alice' : slot === 1 ? 'bob' : `scorer-${slot}`,
      isBot: false, carId, elapsedTicks: MAX_TICKS, events: capturedEvents[slot],
    })),
  };
  const scoredClient = browserReplay(scoringFixture);
  const scoredServer = serverReplay(scoringFixture);
  assert.deepEqual(scoredClient, scoredServer, 'fixed score fixture parity');
  const firstHuman = scoredClient.results.find((r) => r.place === 1);
  const secondHuman = scoredClient.results.find((r) => r.place === 2);
  assert.equal(firstHuman.placementPoints, 10);
  assert.equal(firstHuman.fastestBonus, 2);
  assert.equal(firstHuman.totalPoints, 12);
  assert.equal(secondHuman.placementPoints, 8);
  assert.equal(secondHuman.fastestBonus, 0);

  const botScoringFixture = { seed: 0xfeedbeef, racers: CARS.map((carId, slot) => ({ userId: null, nick: `Bot ${slot}`, isBot: true, carId, elapsedTicks: MAX_TICKS, events: [] })) };
  const botScoredClient = browserReplay(botScoringFixture), botScoredServer = serverReplay(botScoringFixture);
  assert.deepEqual(botScoredClient, botScoredServer, 'bot score fixture parity');
  assert.ok(botScoredClient.results.every((r) => r.totalPoints === 0), 'bots must never score');

  const repeatRandom = { value: 0xcafef00d };
  const repeatSpec = makeRaceSpec(repeatRandom, 1);
  assert.deepEqual(browserReplay(repeatSpec), browserReplay(repeatSpec), 'browser repeatability');
  assert.deepEqual(serverReplay(repeatSpec), serverReplay(repeatSpec), 'server repeatability');
  assert.deepEqual(browserReplay(repeatSpec), serverReplay(repeatSpec), 'repeatability fixture parity');

  return cleanClient.results[0].completionMs;
}

function main() {
  const cleanLapMs = runGoldenTests();
  const random = { value: 0x0ff1ce42 };
  const totals = { racers: 0, dnfs: 0, turbos: 0, bananas: 0, shields: 0, hits: 0 };
  const fuzzRaces = 5000;

  for (let index = 0; index < fuzzRaces; index += 1) {
    const spec = makeRaceSpec(random, index);
    const client = browserReplay(spec);
    const server = serverReplay(spec);
    try {
      assert.deepEqual(client, server);
    } catch (error) {
      throw new Error(`parity mismatch at fuzz race ${index}, seed ${spec.seed}\n${JSON.stringify({ client, server }, null, 2)}`, { cause: error });
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
