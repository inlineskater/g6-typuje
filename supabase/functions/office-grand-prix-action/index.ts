// @ts-nocheck
// Office Grand Prix G6 authoritative lobby and deterministic race verifier.
//
// Deployment:
//   supabase functions deploy office-grand-prix-action
// `supabase/config.toml` keeps verify_jwt=true. SUPABASE_DB_URL, SUPABASE_URL,
// and SUPABASE_ANON_KEY are supplied by the hosted Supabase environment.

import { createClient } from "npm:@supabase/supabase-js@2.107.0";
import postgres from "npm:postgres@3.4.5";

const PRODUCTION_ORIGIN = "https://inlineskater.github.io";
const ALLOWED_ORIGINS = new Set([
  PRODUCTION_ORIGIN,
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
const db = databaseUrl
  ? postgres(databaseUrl, {
    prepare: false,
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
  })
  : null;

// PARITY CONTRACT: these constants and the deterministic functions from
// ogpMix32 through replayOfficeGrandPrix must stay equivalent to the OGP
// engine in index.html and scripts/office-grand-prix-parity.mjs.
const OGP_ENGINE_VERSION = "office_grand_prix_v2";
const OGP_TRACK_VERSION = "office_loop_v2";
const OGP_TRACK_HASH = "4c6fe6372d604110d5b0fdbe9c23ac35d6bcf1d8aeb9fbb9737c44c5226daeb8";
const OGP_TICK_MS = 50;
const OGP_TRACK_LENGTH = 160000;
const OGP_START_PROGRESS = 16000;
const OGP_FINISH_PROGRESS = OGP_START_PROGRESS + OGP_TRACK_LENGTH;
const OGP_MAX_TICKS = 1800;
const OGP_MAX_INPUT_EVENTS = 1800;
const OGP_ACCEL = 5;
const OGP_START_SPEED = 84;
const OGP_MAX_SPEED = 180;
const OGP_FORWARD_PCT = 96;
const OGP_STEER_RESPONSE = 300;
const OGP_STEER_CENTER = 360;
const OGP_STEER_MAX = 1000;
const OGP_TURN_RATE = 4;
const OGP_OFFROAD_THRESHOLD = 3400;
const OGP_OFFROAD_PCT = 70;
const OGP_GRASS_MAX_SPEED = 115;
const OGP_GRASS_BRAKE = 8;
const OGP_GRASS_GRIP_PCT = 62;
const OGP_SAFETY_LATERAL = 6500;
const OGP_RESET_AFTER_TICKS = 20;
const OGP_RESET_CONTROL_TICKS = 12;
const OGP_BOOST_PCT = 125;
const OGP_BOOST_TICKS = 30;
const OGP_BANANA_PCT = 65;
const OGP_BANANA_TICKS = 25;
const OGP_SHIELD_TICKS = 160;
const OGP_GATE_PICKUP_RADIUS = 1050;
const OGP_BANANA_HIT_PROGRESS = 420;
const OGP_BANANA_HIT_LANE = 820;
const OGP_ANGLE_STEPS = 256;
const OGP_TRIG_SCALE = 10000;
const OGP_GATES = [
  29000, 44000, 59000, 74000, 89000,
  104000, 119000, 134000, 149000, 164000,
];
const OGP_GATE_LANES = [
  -1800, 0, 1800, 0, -1800,
  1800, 0, -1800, 1800, 0,
];
const OGP_TRACK_TANGENTS = [209,237,240,241,242,243,243,244,244,244,245,245,245,246,246,248,253,255,0,0,0,1,1,1,1,1,1,2,2,2,3,3,5,11,16,18,18,19,19,19,20,20,20,21,21,21,22,23,24,34,44,46,47,48,49,49,50,50,50,51,52,53,54,65,72,74,75,75,75,76,76,76,77,77,78,78,79,81,93,97,98,99,99,100,100,101,101,101,102,103,104,106,117,120,121,121,122,122,122,122,123,123,123,123,124,124,125,126,130,137,138,139,139,140,140,140,141,141,141,141,142,142,143,144,151,160,161,162,163,163,164,164,164,165,165,166,166,167,170,186,194,196,197,198,199,199,200,201,202,203,205,220,237,239,240,241,241,242,242,243,243,244,245,247,4,9,11,11,12,12,12,13,13,13,13,14,14,17,18,19,19,19,19,19,19,20,20,20,21,21,23,26,57,67,69,71,72,73,74,76,78,82,110,116,118,119,119,120,120,120,121,121,121,122,123,124,129,144,147,148,149,149,150,150,151,151,152,153,155,172,185,188,189,190,190,190,190,190,189,189,185,175,173,173,173,172,172,173,173,173,173,173,174,175,176,179];
const OGP_SIN = [0,245,491,736,980,1224,1467,1710,1951,2191,2430,2667,2903,3137,3369,3599,3827,4052,4276,4496,4714,4929,5141,5350,5556,5758,5957,6152,6344,6532,6716,6895,7071,7242,7410,7572,7730,7883,8032,8176,8315,8449,8577,8701,8819,8932,9040,9142,9239,9330,9415,9495,9569,9638,9700,9757,9808,9853,9892,9925,9952,9973,9988,9997,10000,9997,9988,9973,9952,9925,9892,9853,9808,9757,9700,9638,9569,9495,9415,9330,9239,9142,9040,8932,8819,8701,8577,8449,8315,8176,8032,7883,7730,7572,7410,7242,7071,6895,6716,6532,6344,6152,5957,5758,5556,5350,5141,4929,4714,4496,4276,4052,3827,3599,3369,3137,2903,2667,2430,2191,1951,1710,1467,1224,980,736,491,245,0,-245,-491,-736,-980,-1224,-1467,-1710,-1951,-2191,-2430,-2667,-2903,-3137,-3369,-3599,-3827,-4052,-4276,-4496,-4714,-4929,-5141,-5350,-5556,-5758,-5957,-6152,-6344,-6532,-6716,-6895,-7071,-7242,-7410,-7572,-7730,-7883,-8032,-8176,-8315,-8449,-8577,-8701,-8819,-8932,-9040,-9142,-9239,-9330,-9415,-9495,-9569,-9638,-9700,-9757,-9808,-9853,-9892,-9925,-9952,-9973,-9988,-9997,-10000,-9997,-9988,-9973,-9952,-9925,-9892,-9853,-9808,-9757,-9700,-9638,-9569,-9495,-9415,-9330,-9239,-9142,-9040,-8932,-8819,-8701,-8577,-8449,-8315,-8176,-8032,-7883,-7730,-7572,-7410,-7242,-7071,-6895,-6716,-6532,-6344,-6152,-5957,-5758,-5556,-5350,-5141,-4929,-4714,-4496,-4276,-4052,-3827,-3599,-3369,-3137,-2903,-2667,-2430,-2191,-1951,-1710,-1467,-1224,-980,-736,-491,-245];
const OGP_PLACEMENT_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
const OGP_FASTEST_HUMAN_BONUS = 2;
const OGP_COSMETICS = [
  "coral", "sky", "lime", "amber", "violet", "teal", "pink", "silver",
];
const OGP_BOT_NAMES = [
  "Bot Kadry",
  "Bot Księgowość",
  "Bot IT",
  "Bot Sprzedaż",
  "Bot Audyt",
  "Bot Sekretariat",
  "Bot Podatki",
  "Bot Zarząd",
];

const OGP_COUNTDOWN_SECONDS = 15;
const OGP_ROSTER_LOCK_SECONDS = 10;
const OGP_RACE_SECONDS = 90;
const OGP_SUBMISSION_GRACE_SECONDS = 10;
const OGP_COORDINATOR_STALE_MS = 6000;
const OGP_MAX_REQUEST_BYTES = 300000;
// Production session creation, opened 2026-07-23 by explicit override of the
// V2 mobile/multiplayer acceptance gate (manual QA rows were not signed off;
// see docs/office-grand-prix-v2-release-gate.md). Existing completed rows
// remain queryable as immutable test-race audit history.
const OGP_SESSIONS_ENABLED = true;

type OGPItem = "turbo" | "banana" | "shield" | null;
type OGPInput = { tick: number; steer: -1 | 0 | 1; useItem: boolean };

function corsHeaders(req: Request) {
  const requested = req.headers.get("Origin") ?? "";
  const origin = ALLOWED_ORIGINS.has(requested) ? requested : PRODUCTION_ORIGIN;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

function gameError(code: string, message: string, status = 200) {
  const error = new Error(message);
  error.isGame = true;
  error.code = code;
  error.status = status;
  return error;
}

function asInt(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function requireV2ClientContract(body: any) {
  if (String(body.engineVersion ?? "") !== OGP_ENGINE_VERSION) {
    throw gameError(
      "engine_version_mismatch",
      "Wersja gry zmieniła się. Odśwież portal.",
    );
  }
  if (
    String(body.trackVersion ?? "") !== OGP_TRACK_VERSION
    || String(body.trackHash ?? "") !== OGP_TRACK_HASH
  ) {
    throw gameError(
      "track_version_mismatch",
      "Trasa gry zmieniła się. Odśwież portal.",
    );
  }
}

function requireCurrentSessionVersion(body: any, session: any) {
  const expected = asInt(body.sessionVersion, -1);
  if (expected < 1 || expected !== asInt(session?.version, -2)) {
    throw gameError(
      "stale_session",
      "Stan lobby zmienił się. Odświeżono dane — spróbuj ponownie.",
    );
  }
}

function validUuid(value: unknown) {
  const text = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw gameError("bad_session", "Nieprawidłowa sesja wyścigu.");
  }
  return text;
}

function safeClientMeta(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = {};
  for (const key of ["platform", "renderer", "fps", "viewport", "connection"]) {
    const item = value[key];
    if (typeof item === "string") allowed[key] = item.slice(0, 120);
    else if (typeof item === "number" && Number.isFinite(item)) allowed[key] = item;
  }
  return JSON.stringify(allowed).length <= 2048 ? allowed : {};
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseInputs(raw: unknown, elapsedTicks: number): OGPInput[] {
  if (!Array.isArray(raw)) {
    throw gameError("bad_inputs", "Brak zapisu sterowania.");
  }
  if (raw.length > OGP_MAX_INPUT_EVENTS) {
    throw gameError("too_many_inputs", "Za dużo zdarzeń sterowania.");
  }

  let previousTick = 0;
  return raw.map((entry) => {
    const tick = asInt(entry?.tick, NaN);
    const steer = asInt(entry?.steer, NaN);
    const useItem = entry?.useItem === true
      || entry?.useItem === 1
      || entry?.use === true
      || entry?.use === 1;
    if (!Number.isFinite(tick) || tick < 1 || tick > elapsedTicks || tick > OGP_MAX_TICKS) {
      throw gameError("bad_input_tick", "Nieprawidłowy moment sterowania.");
    }
    if (tick <= previousTick) {
      throw gameError("unordered_inputs", "Sterowanie nie jest uporządkowane.");
    }
    if (steer !== -1 && steer !== 0 && steer !== 1) {
      throw gameError("bad_steer", "Nieprawidłowy kierunek sterowania.");
    }
    previousTick = tick;
    return { tick, steer, useItem };
  });
}

function ogpMix32(value: number) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function ogpRandom(seed: number, slot: number, salt: number) {
  return ogpMix32(
    (seed >>> 0)
    ^ Math.imul((slot + 1) >>> 0, 0x9e3779b1)
    ^ Math.imul((salt + 1) >>> 0, 0x85ebca6b),
  );
}

function ogpApproach(value: number, target: number, amount: number) {
  if (value < target) return Math.min(target, value + amount);
  if (value > target) return Math.max(target, value - amount);
  return target;
}

function ogpWrapAngle(value: number) {
  return ((Math.trunc(value) % OGP_ANGLE_STEPS) + OGP_ANGLE_STEPS) % OGP_ANGLE_STEPS;
}

function ogpAngleDelta(target: number, current: number) {
  const delta = ogpWrapAngle(target - current);
  return delta > OGP_ANGLE_STEPS / 2 ? delta - OGP_ANGLE_STEPS : delta;
}

function ogpSin(angle: number) {
  return OGP_SIN[ogpWrapAngle(angle)];
}

function ogpCos(angle: number) {
  return OGP_SIN[ogpWrapAngle(angle + OGP_ANGLE_STEPS / 4)];
}

function ogpTrackHeading(progress: number) {
  const wrapped = ((Math.trunc(progress) % OGP_TRACK_LENGTH) + OGP_TRACK_LENGTH) % OGP_TRACK_LENGTH;
  const index = Math.floor(wrapped * OGP_TRACK_TANGENTS.length / OGP_TRACK_LENGTH);
  return OGP_TRACK_TANGENTS[index];
}

function ogpGridPose(seed: number, slot: number) {
  const gridIndex = (slot + (seed >>> 0)) % 8;
  const row = Math.floor(gridIndex / 2);
  const column = gridIndex % 2;
  const progress = OGP_START_PROGRESS - row * 700;
  return {
    progress,
    lane: column === 0 ? -1050 : 1050,
    heading: ogpTrackHeading(progress),
  };
}

function ogpItemForGate(seed: number, slot: number, gate: number, place: number): OGPItem {
  const roll = ogpRandom(seed, slot, 1000 + gate) % 100;
  // Leaders: 20/50/30; middle: 40/35/25; back: 60/25/15.
  const turbo = place <= 2 ? 20 : place <= 5 ? 40 : 60;
  const banana = place <= 2 ? 50 : place <= 5 ? 35 : 25;
  if (roll < turbo) return "turbo";
  if (roll < turbo + banana) return "banana";
  return "shield";
}

function ogpRankByProgress(cars: any[]) {
  return [...cars]
    .sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished && a.finishTick !== b.finishTick) {
        return a.finishTick - b.finishTick;
      }
      if (a.progress !== b.progress) return b.progress - a.progress;
      return a.slot - b.slot;
    })
    .map((car) => car.slot);
}

function ogpBotControl(car: any, cars: any[], bananas: any[], seed: number, tick: number) {
  let targetLane = 0;
  const nextGate = OGP_GATES[car.nextGate];
  if (
    car.item == null
    && nextGate != null
    && nextGate >= car.progress
    && nextGate - car.progress <= 15000
  ) {
    targetLane = OGP_GATE_LANES[car.nextGate];
  } else {
    const phase = Math.floor(tick / 120);
    targetLane = ((ogpRandom(seed, car.slot, 5000 + phase) % 3) - 1) * 900;
  }

  for (const hazard of bananas) {
    if (
      hazard.active
      && hazard.ownerSlot !== car.slot
      && hazard.progress > car.progress
      && hazard.progress - car.progress < 6500
      && Math.abs(hazard.lane - targetLane) < 1100
    ) {
      targetLane = hazard.lane >= 0 ? -2200 : 2200;
      break;
    }
  }

  const lookAhead = 1800 + car.speed * 6;
  const laneCorrection = Math.max(
    -14,
    Math.min(14, Math.trunc((targetLane - car.lane) / 240)),
  );
  const targetHeading = ogpWrapAngle(
    ogpTrackHeading(car.progress + lookAhead) - laneCorrection,
  );
  const headingError = ogpAngleDelta(targetHeading, car.heading);
  const steer = Math.abs(headingError) <= 2 ? 0 : headingError < 0 ? -1 : 1;

  let useItem = false;
  if (car.item === "turbo" && car.itemHeldTicks >= 8) useItem = true;
  else if (car.item === "shield" && car.shieldTicks === 0 && car.itemHeldTicks >= 3) useItem = true;
  else if (car.item === "banana") {
    const hasFollower = cars.some((other) =>
      other.slot !== car.slot
      && !other.finished
      && car.progress > other.progress
      && car.progress - other.progress < 9000
      && Math.abs(car.lane - other.lane) < 1500
    );
    useItem = hasFollower || car.itemHeldTicks >= 70;
  }
  return { steer, useItem };
}

function ogpUseItem(car: any, bananas: any[], tick: number) {
  if (car.item === "turbo") {
    car.boostTicks = OGP_BOOST_TICKS;
  } else if (car.item === "shield") {
    car.shieldTicks = OGP_SHIELD_TICKS;
  } else if (car.item === "banana") {
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

function ogpAdvancePose(car: any, steer: number) {
  const offroad = Math.abs(car.lane) > OGP_OFFROAD_THRESHOLD;
  const steeringStep = offroad
    ? Math.max(1, Math.floor(OGP_STEER_RESPONSE * OGP_GRASS_GRIP_PCT / 100))
    : OGP_STEER_RESPONSE;
  car.steering = ogpApproach(
    car.steering,
    steer * OGP_STEER_MAX,
    steer === 0 ? OGP_STEER_CENTER : steeringStep,
  );
  const gripPct = offroad ? OGP_GRASS_GRIP_PCT : 100;
  const turn = Math.trunc(
    car.steering * car.speed * OGP_TURN_RATE * gripPct /
    (OGP_STEER_MAX * OGP_MAX_SPEED * 100),
  );
  car.heading = ogpWrapAngle(car.heading + turn);

  const surfaceMaxSpeed = offroad ? OGP_GRASS_MAX_SPEED : OGP_MAX_SPEED;
  if (car.speed > surfaceMaxSpeed) {
    car.speed = Math.max(surfaceMaxSpeed, car.speed - OGP_GRASS_BRAKE);
  } else {
    car.speed = Math.min(surfaceMaxSpeed, car.speed + OGP_ACCEL);
  }
  let velocity = Math.floor(car.speed * OGP_FORWARD_PCT / 100);
  if (offroad) velocity = Math.floor(velocity * OGP_OFFROAD_PCT / 100);
  if (car.boostTicks > 0) velocity = Math.floor(velocity * OGP_BOOST_PCT / 100);
  if (car.slowTicks > 0) velocity = Math.floor(velocity * OGP_BANANA_PCT / 100);
  const relativeHeading = ogpAngleDelta(car.heading, ogpTrackHeading(car.progress));
  car.progress += Math.trunc(velocity * ogpCos(relativeHeading) / OGP_TRIG_SCALE);
  car.lane += Math.trunc(velocity * ogpSin(-relativeHeading) / OGP_TRIG_SCALE);

  if (Math.abs(car.lane) > OGP_SAFETY_LATERAL) car.outsideTicks += 1;
  else car.outsideTicks = 0;
  if (car.outsideTicks < OGP_RESET_AFTER_TICKS) return false;

  car.progress = Math.max(OGP_START_PROGRESS, car.lastCheckpoint - 800);
  car.lane = 0;
  car.heading = ogpTrackHeading(car.progress);
  car.steering = 0;
  car.speed = OGP_START_SPEED;
  car.outsideTicks = 0;
  car.resetTicks = OGP_RESET_CONTROL_TICKS;
  car.resetCount += 1;
  return true;
}

function replayOfficeGrandPrix(seed: number, roster: any[], submissionRows: any[]) {
  const raceSeed = seed >>> 0;
  const submissionByUser = new Map(
    submissionRows.map((row) => [String(row.user_id), {
      elapsedTicks: asInt(row.elapsed_ticks),
      inputs: Array.isArray(row.input_log) ? row.input_log : [],
      inputEvents: asInt(row.input_events),
    }]),
  );
  const cars = roster
    .map((row) => {
      const submission = row.is_bot ? null : submissionByUser.get(String(row.user_id));
      const slot = asInt(row.slot);
      const pose = ogpGridPose(raceSeed, slot);
      return {
        slot,
        userId: row.user_id == null ? null : String(row.user_id),
        nick: String(row.nick_snapshot),
        cosmetic: asInt(row.cosmetic),
        isBot: !!row.is_bot,
        capTick: row.is_bot ? OGP_MAX_TICKS : submission?.elapsedTicks ?? 0,
        inputs: submission?.inputs ?? [],
        inputEvents: submission?.inputEvents ?? 0,
        inputIndex: 0,
        steer: 0,
        speed: OGP_START_SPEED,
        progress: pose.progress,
        lane: pose.lane,
        heading: pose.heading,
        steering: 0,
        item: null,
        itemHeldTicks: 0,
        nextGate: 0,
        lastCheckpoint: OGP_START_PROGRESS,
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
        retired: !row.is_bot && !submission,
      };
    })
    .sort((a, b) => a.slot - b.slot);
  const bananas: any[] = [];

  for (let tick = 1; tick <= OGP_MAX_TICKS; tick += 1) {
    const progressOrder = ogpRankByProgress(cars);
    const placeBySlot = new Map(progressOrder.map((slot, index) => [slot, index + 1]));
    const controls = new Map<number, { steer: number; useItem: boolean }>();

    for (const car of cars) {
      if (car.finished || car.retired) continue;
      if (!car.isBot && tick > car.capTick) {
        car.retired = true;
        continue;
      }

      let steer = car.steer;
      let useItem = false;
      if (car.isBot) {
        const bot = ogpBotControl(car, cars, bananas, raceSeed, tick);
        steer = bot.steer;
        useItem = bot.useItem;
      } else {
        while (
          car.inputIndex < car.inputs.length
          && asInt(car.inputs[car.inputIndex]?.tick) === tick
        ) {
          const input = car.inputs[car.inputIndex];
          steer = asInt(input.steer);
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
        if (car.item === "turbo") car.boostsUsed += 1;
        else if (car.item === "shield") car.shieldsUsed += 1;
        else if (car.item === "banana") car.bananasDropped += 1;
        ogpUseItem(car, bananas, tick);
      }

      const previousProgress = car.progress;
      if (ogpAdvancePose(car, control.steer)) continue;

      while (
        car.nextGate < OGP_GATES.length
        && car.progress >= OGP_GATES[car.nextGate]
      ) {
        const gate = car.nextGate;
        if (
          previousProgress < OGP_GATES[gate]
          && car.item == null
          && Math.abs(car.lane - OGP_GATE_LANES[gate]) <= OGP_GATE_PICKUP_RADIUS
        ) {
          car.item = ogpItemForGate(
            raceSeed,
            car.slot,
            gate,
            placeBySlot.get(car.slot) ?? 8,
          );
          car.itemHeldTicks = 0;
        }
        car.lastCheckpoint = OGP_GATES[gate];
        car.nextGate += 1;
      }

      if (car.item != null) car.itemHeldTicks += 1;
      if (car.progress >= OGP_FINISH_PROGRESS && car.nextGate === OGP_GATES.length) {
        car.progress = OGP_FINISH_PROGRESS;
        car.finished = true;
        car.finishTick = tick;
        car.speed = 0;
      }
    }

    for (const hazard of bananas) {
      if (!hazard.active) continue;
      for (const car of cars) {
        if (
          car.finished
          || car.retired
          || car.slot === hazard.ownerSlot
          || tick <= hazard.createdTick
        ) continue;
        if (
          Math.abs(car.progress - hazard.progress) <= OGP_BANANA_HIT_PROGRESS
          && Math.abs(car.lane - hazard.lane) <= OGP_BANANA_HIT_LANE
        ) {
          hazard.active = false;
          if (car.shieldTicks > 0) car.shieldTicks = 0;
          else {
            car.slowTicks = OGP_BANANA_TICKS;
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

  const ordered = [...cars].sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished && a.finishTick !== b.finishTick) {
      return a.finishTick - b.finishTick;
    }
    if (a.progress !== b.progress) return b.progress - a.progress;
    return a.slot - b.slot;
  });
  const placeBySlot = new Map(ordered.map((car, index) => [car.slot, index + 1]));
  const fastestHuman = ordered
    .filter((car) => !car.isBot && car.finished)
    .sort((a, b) => a.finishTick - b.finishTick || a.slot - b.slot)[0] ?? null;

  const results = cars.map((car) => {
    const place = placeBySlot.get(car.slot) ?? 8;
    const placementPoints = !car.isBot && car.finished
      ? OGP_PLACEMENT_POINTS[place - 1] ?? 0
      : 0;
    const fastestBonus = !car.isBot
      && car.finished
      && fastestHuman?.slot === car.slot
      ? OGP_FASTEST_HUMAN_BONUS
      : 0;
    return {
      slot: car.slot,
      userId: car.userId,
      nick: car.nick,
      cosmetic: car.cosmetic,
      cosmeticId: OGP_COSMETICS[car.cosmetic],
      isBot: car.isBot,
      place,
      finished: car.finished,
      finishTick: car.finishTick,
      completionMs: car.finished ? car.finishTick * OGP_TICK_MS : null,
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
  });

  return {
    engineVersion: OGP_ENGINE_VERSION,
    trackVersion: OGP_TRACK_VERSION,
    trackHash: OGP_TRACK_HASH,
    seed: raceSeed,
    ticks: Math.max(...results.map((row) => row.finishTick ?? OGP_MAX_TICKS)),
    results: results.sort((a, b) => a.place - b.place),
  };
}

async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    throw gameError("not_authenticated", "Musisz być zalogowany.");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) throw new Error("Missing Supabase environment.");

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) {
    throw gameError("session_expired", "Sesja wygasła. Zaloguj się ponownie.");
  }
  return data.user;
}

async function profileForUser(sql: any, userId: string, forUpdate = false) {
  const rows = forUpdate
    ? await sql`
      SELECT id, nick, coins
      FROM public.profiles
      WHERE id = ${userId}
      FOR UPDATE
    `
    : await sql`
      SELECT id, nick, coins
      FROM public.profiles
      WHERE id = ${userId}
    `;
  if (!rows[0]) throw gameError("profile_not_found", "Profil nie istnieje.");
  return rows[0];
}

async function sessionForUpdate(tx: any, sessionId?: string | null) {
  const rows = sessionId
    ? await tx`
      SELECT *
      FROM public.office_grand_prix_sessions
      WHERE id = ${sessionId}
      FOR UPDATE
    `
    : await tx`
      SELECT *
      FROM public.office_grand_prix_sessions
      WHERE status IN ('lobby', 'countdown', 'racing')
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE
    `;
  return rows[0] ?? null;
}

async function lockRoster(tx: any, session: any) {
  if (session.roster_locked_at) return session;

  await tx`
    DELETE FROM public.office_grand_prix_participants
    WHERE session_id = ${session.id}
      AND NOT is_bot
      AND NOT is_ready
  `;

  if (session.game_mode === "arcade") {
    const entrants = await tx`
      SELECT p.id, p.user_id
      FROM public.office_grand_prix_participants p
      WHERE p.session_id = ${session.id}
        AND NOT p.is_bot
        AND p.is_ready
        AND NOT p.entry_fee_charged
      ORDER BY p.slot
      FOR UPDATE
    `;
    for (const entrant of entrants) {
      const charged = await tx`
        UPDATE public.profiles
        SET coins = coins - 1
        WHERE id = ${entrant.user_id}
          AND coins >= 1
        RETURNING coins
      `;
      if (!charged[0]) {
        await tx`
          DELETE FROM public.office_grand_prix_participants
          WHERE id = ${entrant.id}
        `;
        continue;
      }
      await tx`
        INSERT INTO public.coin_transactions(user_id, delta, reason, meta)
        VALUES (
          ${entrant.user_id},
          -1,
          'arcade_entry',
          ${JSON.stringify({
            game_type: "office_grand_prix",
            session_id: session.id,
            charged_at: new Date().toISOString(),
          })}::jsonb
        )
      `;
      await tx`
        UPDATE public.office_grand_prix_participants
        SET entry_fee_charged = true,
            entry_fee_charged_at = now()
        WHERE id = ${entrant.id}
      `;
    }
  }

  const humans = await tx`
    SELECT *
    FROM public.office_grand_prix_participants
    WHERE session_id = ${session.id}
      AND NOT is_bot
      AND is_ready
    ORDER BY slot
  `;

  if (humans.length === 0) {
    const cancelled = await tx`
      UPDATE public.office_grand_prix_sessions
      SET status = 'cancelled',
          coordinator_id = NULL,
          coordinator_heartbeat_at = NULL,
          finished_at = now(),
          updated_at = now(),
          version = version + 1
      WHERE id = ${session.id}
      RETURNING *
    `;
    return cancelled[0];
  }

  const occupied = await tx`
    SELECT slot, cosmetic
    FROM public.office_grand_prix_participants
    WHERE session_id = ${session.id}
    ORDER BY slot
  `;
  const usedSlots = new Set(occupied.map((row) => asInt(row.slot)));
  const usedCosmetics = new Set(occupied.map((row) => asInt(row.cosmetic)));
  let botNumber = 0;
  for (let slot = 0; slot < 8; slot += 1) {
    if (usedSlots.has(slot)) continue;
    const cosmetic = Array.from({ length: 8 }, (_, index) => index)
      .find((index) => !usedCosmetics.has(index));
    if (cosmetic == null) throw new Error("No cosmetic available for bot.");
    await tx`
      INSERT INTO public.office_grand_prix_participants (
        session_id,
        slot,
        user_id,
        nick_snapshot,
        cosmetic,
        is_bot,
        is_ready,
        ready_at
      )
      VALUES (
        ${session.id},
        ${slot},
        NULL,
        ${OGP_BOT_NAMES[botNumber] ?? `Bot ${botNumber + 1}`},
        ${cosmetic},
        true,
        true,
        now()
      )
    `;
    usedSlots.add(slot);
    usedCosmetics.add(cosmetic);
    botNumber += 1;
  }

  const coordinatorStillPresent = humans.some((row) =>
    String(row.user_id) === String(session.coordinator_id)
  );
  const coordinatorId = coordinatorStillPresent
    ? session.coordinator_id
    : humans[0].user_id;
  const updated = await tx`
    UPDATE public.office_grand_prix_sessions
    SET roster_locked_at = now(),
        coordinator_id = ${coordinatorId},
        coordinator_claimed_at = CASE
          WHEN coordinator_id IS DISTINCT FROM ${coordinatorId}
            THEN now()
          ELSE coordinator_claimed_at
        END,
        coordinator_heartbeat_at = CASE
          WHEN coordinator_id IS DISTINCT FROM ${coordinatorId}
            THEN now()
          ELSE coordinator_heartbeat_at
        END,
        updated_at = now(),
        version = version + 1
    WHERE id = ${session.id}
    RETURNING *
  `;
  return updated[0];
}

async function finalizeSession(tx: any, session: any) {
  if (session.status === "finished" || session.finished_at) return session;
  if (session.engine_version !== OGP_ENGINE_VERSION) {
    throw gameError(
      "session_engine_mismatch",
      "Sesja nie może zostać odtworzona przez aktywny silnik.",
    );
  }

  const roster = await tx`
    SELECT *
    FROM public.office_grand_prix_participants
    WHERE session_id = ${session.id}
    ORDER BY slot
    FOR UPDATE
  `;
  const submissions = await tx`
    SELECT *
    FROM public.office_grand_prix_submissions
    WHERE session_id = ${session.id}
    ORDER BY received_at, user_id
  `;
  const replay = replayOfficeGrandPrix(asInt(session.seed), roster, submissions);
  const resultBySlot = new Map(replay.results.map((row) => [row.slot, row]));
  const weekRows = await tx`
    SELECT public.office_grand_prix_week_start(${session.race_started_at}::timestamptz)
      AS week_start
  `;
  const weekStart = weekRows[0].week_start;

  for (const participant of roster) {
    const result = resultBySlot.get(asInt(participant.slot));
    if (!result) throw new Error("Missing deterministic result.");
    const resultJson = {
      engine_version: OGP_ENGINE_VERSION,
      seed: asInt(session.seed),
      slot: result.slot,
      cosmetic: result.cosmeticId,
      finish_tick: result.finishTick,
      progress: result.progress,
      bananas_hit: result.bananasHit,
      shields_used: result.shieldsUsed,
      boosts_used: result.boostsUsed,
      bananas_dropped: result.bananasDropped,
    };

    await tx`
      UPDATE public.office_grand_prix_participants
      SET finished = ${result.finished},
          finish_place = ${result.place},
          completion_ms = ${result.completionMs},
          points = ${result.totalPoints},
          result_json = ${JSON.stringify(resultJson)}::jsonb,
          result_finalized_at = now()
      WHERE id = ${participant.id}
    `;

    if (participant.is_bot) continue;
    await tx`
      INSERT INTO public.office_grand_prix_scores (
        session_id,
        user_id,
        nick_snapshot,
        week_start,
        game_mode,
        finish_place,
        placement_points,
        fastest_bonus,
        total_points,
        finished,
        completion_ms,
        input_events,
        server_meta
      )
      VALUES (
        ${session.id},
        ${participant.user_id},
        ${participant.nick_snapshot},
        ${weekStart},
        ${session.game_mode},
        ${result.place},
        ${result.placementPoints},
        ${result.fastestBonus},
        ${result.totalPoints},
        ${result.finished},
        ${result.completionMs},
        ${result.inputEvents},
        ${JSON.stringify(resultJson)}::jsonb
      )
      ON CONFLICT (session_id, user_id) DO NOTHING
    `;

    if (session.game_mode === "arcade" && !participant.arcade_score_recorded_at) {
      const encodedScore = result.finished
        ? result.totalPoints * 1000000 + Math.max(0, 100000 - result.completionMs)
        : 0;
      await tx`
        INSERT INTO public.arcade_scores(user_id, game_type, score, coins_paid)
        VALUES (
          ${participant.user_id},
          'office_grand_prix',
          ${encodedScore},
          1
        )
      `;
      await tx`
        UPDATE public.office_grand_prix_participants
        SET arcade_score_recorded_at = now()
        WHERE id = ${participant.id}
      `;
    }
  }

  const finished = await tx`
    UPDATE public.office_grand_prix_sessions
    SET status = 'finished',
        finished_at = now(),
        updated_at = now(),
        version = version + 1
    WHERE id = ${session.id}
      AND status = 'racing'
    RETURNING *
  `;
  return finished[0] ?? session;
}

async function advanceSession(tx: any, requestedSessionId?: string | null) {
  let session = await sessionForUpdate(tx, requestedSessionId);
  if (!session) return null;
  const nowMs = Date.now();

  if (
    session.status === "countdown"
    && !session.roster_locked_at
    && session.roster_locks_at
    && nowMs >= new Date(session.roster_locks_at).getTime()
  ) {
    session = await lockRoster(tx, session);
  }

  if (
    session.status === "countdown"
    && session.roster_locked_at
    && session.race_starts_at
    && nowMs >= new Date(session.race_starts_at).getTime()
  ) {
    const started = await tx`
      UPDATE public.office_grand_prix_sessions
      SET status = 'racing',
          race_started_at = race_starts_at,
          race_ends_at = race_starts_at + interval '90 seconds',
          submissions_due_at = race_starts_at + interval '100 seconds',
          updated_at = now(),
          version = version + 1
      WHERE id = ${session.id}
        AND status = 'countdown'
      RETURNING *
    `;
    session = started[0] ?? session;
  }

  if (session.status === "racing") {
    const counts = await tx`
      SELECT
        COUNT(*) FILTER (WHERE NOT p.is_bot)::integer AS humans,
        COUNT(s.id)::integer AS submissions
      FROM public.office_grand_prix_participants p
      LEFT JOIN public.office_grand_prix_submissions s
        ON s.session_id = p.session_id
       AND s.user_id = p.user_id
      WHERE p.session_id = ${session.id}
    `;
    const humans = asInt(counts[0]?.humans);
    const submissions = asInt(counts[0]?.submissions);
    const deadlinePassed = session.submissions_due_at
      && nowMs >= new Date(session.submissions_due_at).getTime();
    if (humans > 0 && (submissions >= humans || deadlinePassed)) {
      session = await finalizeSession(tx, session);
    }
  }

  return session;
}

function mapSession(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    mode: row.game_mode,
    engineVersion: row.engine_version,
    engine_version: row.engine_version,
    seed: asInt(row.seed),
    maxPlayers: asInt(row.max_players),
    coordinatorId: row.coordinator_id,
    coordinatorUserId: row.coordinator_id,
    coordinator_user_id: row.coordinator_id,
    coordinatorHeartbeatAt: row.coordinator_heartbeat_at,
    countdownStartedAt: row.countdown_started_at,
    rosterLocksAt: row.roster_locks_at,
    rosterLockedAt: row.roster_locked_at,
    raceStartsAt: row.race_starts_at,
    startsAt: row.race_starts_at,
    starts_at: row.race_starts_at,
    raceStartedAt: row.race_started_at,
    raceEndsAt: row.race_ends_at,
    submissionsDueAt: row.submissions_due_at,
    finishedAt: row.finished_at,
    version: asInt(row.version),
    createdAt: row.created_at,
  };
}

function mapParticipant(row: any) {
  return {
    id: row.id,
    slot: asInt(row.slot),
    userId: row.user_id,
    nick: row.nick_snapshot,
    cosmetic: asInt(row.cosmetic),
    cosmeticId: OGP_COSMETICS[asInt(row.cosmetic)],
    carId: OGP_COSMETICS[asInt(row.cosmetic)],
    car_id: OGP_COSMETICS[asInt(row.cosmetic)],
    isBot: !!row.is_bot,
    ready: !!row.is_ready,
    joinedAt: row.joined_at,
    readyAt: row.ready_at,
    submitted: !!row.submitted,
    submissionReceivedAt: row.submission_received_at,
    finished: row.finished == null ? null : !!row.finished,
    place: row.finish_place == null ? null : asInt(row.finish_place),
    completionMs: row.completion_ms == null ? null : asInt(row.completion_ms),
    points: row.points == null ? null : asInt(row.points),
    result: row.result_json ?? {},
  };
}

function mapLeaderboard(rows: any[]) {
  return rows.map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    wins: asInt(row.wins),
    combined_time_ms: asInt(row.combined_time_ms),
    races_counted: asInt(row.races_counted),
    weeks_played: row.weeks_played == null ? undefined : asInt(row.weeks_played),
  }));
}

async function loadState(userId: string, preferredSessionId?: string | null) {
  if (!db) throw new Error("Database is not configured.");
  const profile = await profileForUser(db, userId);
  let sessionRows;
  if (preferredSessionId) {
    sessionRows = await db`
      SELECT *
      FROM public.office_grand_prix_sessions
      WHERE id = ${preferredSessionId}
    `;
  } else {
    sessionRows = await db`
      SELECT *
      FROM public.office_grand_prix_sessions
      ORDER BY
        (status IN ('lobby', 'countdown', 'racing')) DESC,
        created_at DESC
      LIMIT 1
    `;
  }
  const session = sessionRows[0] ?? null;
  const participants = session
    ? await db`
      SELECT
        p.*,
        (s.id IS NOT NULL) AS submitted
      FROM public.office_grand_prix_participants p
      LEFT JOIN public.office_grand_prix_submissions s
        ON s.session_id = p.session_id
       AND s.user_id = p.user_id
      WHERE p.session_id = ${session.id}
      ORDER BY p.slot
    `
    : [];
  const [modeRows, weekly, allTime, testStandings, awards] = await Promise.all([
    db`SELECT public.office_grand_prix_mode(now()) AS mode`,
    db`SELECT * FROM public.office_grand_prix_current_week ORDER BY rank LIMIT 20`,
    db`SELECT * FROM public.office_grand_prix_all_time ORDER BY rank LIMIT 20`,
    db`SELECT * FROM public.office_grand_prix_test_standings ORDER BY rank LIMIT 20`,
    db`SELECT * FROM public.office_grand_prix_recent_awards ORDER BY week_start DESC, rank LIMIT 12`,
  ]);
  const mappedParticipants = participants.map(mapParticipant);
  const myParticipant = mappedParticipants.find((row) => row.userId === userId) ?? null;
  const mappedSession = mapSession(session);
  const channels = mappedSession && myParticipant
    ? {
      race: `ogp:${mappedSession.id}`,
      input: `ogp-input:${mappedSession.id}:${myParticipant.slot}`,
      coordinatorInputs: mappedSession.coordinatorId === userId
        ? mappedParticipants
          .filter((row) => !row.isBot)
          .map((row) => `ogp-input:${mappedSession.id}:${row.slot}`)
        : [],
      private: true,
      inputBatchHz: 10,
    }
    : null;
  const heartbeatMs = mappedSession?.coordinatorHeartbeatAt
    ? new Date(mappedSession.coordinatorHeartbeatAt).getTime()
    : 0;

  const mappedWeekly = mapLeaderboard(weekly);
  const mappedTestStandings = testStandings.map((row) => ({
    ...row,
    rank: asInt(row.rank),
    finish_place: asInt(row.finish_place),
    completion_ms: asInt(row.completion_ms),
    score: OGP_PLACEMENT_POINTS[asInt(row.finish_place) - 1] ?? 0,
  }));
  const currentMode = modeRows[0]?.mode ?? "arcade";

  return {
    serverNow: new Date().toISOString(),
    maintenance: !OGP_SESSIONS_ENABLED,
    sessionsEnabled: OGP_SESSIONS_ENABLED,
    engineVersion: OGP_ENGINE_VERSION,
    trackVersion: OGP_TRACK_VERSION,
    trackHash: OGP_TRACK_HASH,
    tickMs: OGP_TICK_MS,
    tickHz: 1000 / OGP_TICK_MS,
    snapshotHz: 10,
    mode: currentMode,
    profile: {
      id: profile.id,
      nick: profile.nick,
      coins: asInt(profile.coins),
    },
    session: mappedSession,
    participants: mappedParticipants,
    myParticipant,
    channels,
    canClaimCoordinator: !!(
      mappedSession
      && myParticipant?.ready
      && (
        !mappedSession.coordinatorId
        || Date.now() - heartbeatMs > OGP_COORDINATOR_STALE_MS
      )
    ),
    physics: {
      engineVersion: OGP_ENGINE_VERSION,
      trackVersion: OGP_TRACK_VERSION,
      trackHash: OGP_TRACK_HASH,
      tickMs: OGP_TICK_MS,
      trackLength: OGP_TRACK_LENGTH,
      startProgress: OGP_START_PROGRESS,
      finishProgress: OGP_FINISH_PROGRESS,
      maxTicks: OGP_MAX_TICKS,
      accel: OGP_ACCEL,
      startSpeed: OGP_START_SPEED,
      maxSpeed: OGP_MAX_SPEED,
      forwardPct: OGP_FORWARD_PCT,
      steerResponse: OGP_STEER_RESPONSE,
      steerCenter: OGP_STEER_CENTER,
      steerMax: OGP_STEER_MAX,
      turnRate: OGP_TURN_RATE,
      offroadThreshold: OGP_OFFROAD_THRESHOLD,
      offroadPct: OGP_OFFROAD_PCT,
      grassMaxSpeed: OGP_GRASS_MAX_SPEED,
      grassBrake: OGP_GRASS_BRAKE,
      grassGripPct: OGP_GRASS_GRIP_PCT,
      safetyLateral: OGP_SAFETY_LATERAL,
      resetAfterTicks: OGP_RESET_AFTER_TICKS,
      resetControlTicks: OGP_RESET_CONTROL_TICKS,
      angleSteps: OGP_ANGLE_STEPS,
      trigScale: OGP_TRIG_SCALE,
      boostPct: OGP_BOOST_PCT,
      boostTicks: OGP_BOOST_TICKS,
      bananaPct: OGP_BANANA_PCT,
      bananaTicks: OGP_BANANA_TICKS,
      shieldTicks: OGP_SHIELD_TICKS,
      gates: OGP_GATES,
      gateLanes: OGP_GATE_LANES,
      cosmetics: OGP_COSMETICS,
    },
    scoring: {
      placement: OGP_PLACEMENT_POINTS,
      fastestHumanBonus: OGP_FASTEST_HUMAN_BONUS,
      weeklyRacesCounted: 5,
      prizes: [500, 250, 100],
    },
    weekly: mappedWeekly,
    leaderboard: currentMode === "test" ? mappedTestStandings : mappedWeekly,
    allTime: mapLeaderboard(allTime),
    testStandings: mappedTestStandings,
    awards: awards.map((row) => ({
      ...row,
      rank: asInt(row.rank),
      score: asInt(row.score),
      wins: asInt(row.wins),
      combined_time_ms: asInt(row.combined_time_ms),
      races_counted: asInt(row.races_counted),
      prize_coins: asInt(row.prize_coins),
    })),
  };
}

async function progressThenState(userId: string, sessionId?: string | null) {
  if (!db) throw new Error("Database is not configured.");
  let progressedId = sessionId ?? null;
  await db.begin(async (tx) => {
    const session = await advanceSession(tx, sessionId);
    if (session) progressedId = session.id;
  });
  return loadState(userId, progressedId);
}

async function joinLobby(userId: string, body: any) {
  if (!db) throw new Error("Database is not configured.");
  if (!OGP_SESSIONS_ENABLED) {
    throw gameError(
      "maintenance",
      "Office Grand Prix jest przebudowywany. Nowe sesje są chwilowo wyłączone.",
      503,
    );
  }
  requireV2ClientContract(body);
  let joinedSessionId: string | null = null;
  let waiting = false;
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('office_grand_prix_active'))`;
    const profile = await profileForUser(tx, userId);
    let session = await advanceSession(tx, null);

    if (!session || session.status === "finished" || session.status === "cancelled") {
      const modeRows = await tx`
        SELECT public.office_grand_prix_mode(now()) AS mode
      `;
      const seedBytes = crypto.getRandomValues(new Uint32Array(1));
      const seed = seedBytes[0] & 0x7fffffff;
      const inserted = await tx`
        INSERT INTO public.office_grand_prix_sessions (
          game_mode,
          engine_version,
          seed,
          created_by
        )
        VALUES (
          ${modeRows[0]?.mode ?? "arcade"},
          ${OGP_ENGINE_VERSION},
          ${seed},
          ${userId}
        )
        RETURNING *
      `;
      session = inserted[0];
    } else {
      requireCurrentSessionVersion(body, session);
    }
    joinedSessionId = session.id;

    const existing = await tx`
      SELECT id
      FROM public.office_grand_prix_participants
      WHERE session_id = ${session.id}
        AND user_id = ${userId}
    `;
    if (existing[0]) return;

    const lockReached = session.roster_locks_at
      && Date.now() >= new Date(session.roster_locks_at).getTime();
    if (
      session.status === "racing"
      || session.roster_locked_at
      || lockReached
    ) {
      waiting = true;
      return;
    }

    const occupied = await tx`
      SELECT slot, cosmetic
      FROM public.office_grand_prix_participants
      WHERE session_id = ${session.id}
      ORDER BY slot
      FOR UPDATE
    `;
    if (occupied.length >= 8) {
      waiting = true;
      return;
    }
    const usedSlots = new Set(occupied.map((row) => asInt(row.slot)));
    const usedCosmetics = new Set(occupied.map((row) => asInt(row.cosmetic)));
    const slot = Array.from({ length: 8 }, (_, index) => index)
      .find((index) => !usedSlots.has(index));
    const requestedCosmetic = body.cosmetic == null
      ? OGP_COSMETICS.indexOf(String(body.carId ?? body.car_id ?? ""))
      : asInt(body.cosmetic, -1);
    const cosmetic = requestedCosmetic >= 0
      && requestedCosmetic <= 7
      && !usedCosmetics.has(requestedCosmetic)
      ? requestedCosmetic
      : Array.from({ length: 8 }, (_, index) => index)
        .find((index) => !usedCosmetics.has(index));
    if (slot == null || cosmetic == null) {
      waiting = true;
      return;
    }

    await tx`
      INSERT INTO public.office_grand_prix_participants (
        session_id,
        slot,
        user_id,
        nick_snapshot,
        cosmetic,
        is_bot,
        is_ready
      )
      VALUES (
        ${session.id},
        ${slot},
        ${profile.id},
        ${profile.nick},
        ${cosmetic},
        false,
        false
      )
    `;
    await tx`
      UPDATE public.office_grand_prix_sessions
      SET updated_at = now(),
          version = version + 1
      WHERE id = ${session.id}
    `;
  });
  return {
    ...(await loadState(userId, joinedSessionId)),
    waiting,
  };
}

async function setReady(userId: string, body: any) {
  if (!db) throw new Error("Database is not configured.");
  requireV2ClientContract(body);
  const sessionId = validUuid(body.sessionId);
  const ready = asBoolean(body.ready, true);
  await db.begin(async (tx) => {
    let session = await advanceSession(tx, sessionId);
    if (!session) throw gameError("session_not_found", "Sesja nie istnieje.");
    if (session.engine_version !== OGP_ENGINE_VERSION) {
      throw gameError("session_engine_mismatch", "Ta sesja używa innego silnika wyścigu.");
    }
    requireCurrentSessionVersion(body, session);
    if (!["lobby", "countdown"].includes(session.status) || session.roster_locked_at) {
      throw gameError("roster_locked", "Lista startowa jest już zamknięta.");
    }
    if (
      session.roster_locks_at
      && Date.now() >= new Date(session.roster_locks_at).getTime()
    ) {
      session = await lockRoster(tx, session);
      throw gameError("roster_locked", "Lista startowa jest już zamknięta.");
    }

    const participant = await tx`
      UPDATE public.office_grand_prix_participants
      SET is_ready = ${ready},
          ready_at = CASE WHEN ${ready} THEN now() ELSE NULL END
      WHERE session_id = ${session.id}
        AND user_id = ${userId}
        AND NOT is_bot
      RETURNING *
    `;
    if (!participant[0]) {
      throw gameError("not_in_lobby", "Najpierw dołącz do wyścigu.");
    }

    const readyRows = await tx`
      SELECT user_id, slot
      FROM public.office_grand_prix_participants
      WHERE session_id = ${session.id}
        AND NOT is_bot
        AND is_ready
      ORDER BY slot
    `;
    if (readyRows.length === 0) {
      await tx`
        UPDATE public.office_grand_prix_sessions
        SET status = 'lobby',
            coordinator_id = NULL,
            coordinator_claimed_at = NULL,
            coordinator_heartbeat_at = NULL,
            countdown_started_at = NULL,
            roster_locks_at = NULL,
            race_starts_at = NULL,
            updated_at = now(),
            version = version + 1
        WHERE id = ${session.id}
      `;
      return;
    }

    const coordinatorPresent = readyRows.some((row) =>
      String(row.user_id) === String(session.coordinator_id)
    );
    const coordinatorId = coordinatorPresent
      ? session.coordinator_id
      : readyRows[0].user_id;
    if (session.status === "lobby") {
      await tx`
        UPDATE public.office_grand_prix_sessions
        SET status = 'countdown',
            countdown_started_at = now(),
            roster_locks_at = now() + interval '10 seconds',
            race_starts_at = now() + interval '15 seconds',
            coordinator_id = ${coordinatorId},
            coordinator_claimed_at = now(),
            coordinator_heartbeat_at = now(),
            updated_at = now(),
            version = version + 1
        WHERE id = ${session.id}
      `;
    } else {
      await tx`
        UPDATE public.office_grand_prix_sessions
        SET coordinator_id = ${coordinatorId},
            coordinator_claimed_at = CASE
              WHEN coordinator_id IS DISTINCT FROM ${coordinatorId}
                THEN now()
              ELSE coordinator_claimed_at
            END,
            coordinator_heartbeat_at = CASE
              WHEN coordinator_id IS DISTINCT FROM ${coordinatorId}
                THEN now()
              ELSE coordinator_heartbeat_at
            END,
            updated_at = now(),
            version = version + 1
        WHERE id = ${session.id}
      `;
    }
  });
  return loadState(userId, sessionId);
}

async function leaveLobby(userId: string, body: any) {
  if (!db) throw new Error("Database is not configured.");
  const sessionId = validUuid(body.sessionId);
  await db.begin(async (tx) => {
    const session = await advanceSession(tx, sessionId);
    if (!session) throw gameError("session_not_found", "Sesja nie istnieje.");
    if (
      session.roster_locked_at
      || session.status === "racing"
      || session.status === "finished"
      || (
        session.roster_locks_at
        && Date.now() >= new Date(session.roster_locks_at).getTime()
      )
    ) {
      throw gameError("roster_locked", "Nie można opuścić zamkniętej listy startowej.");
    }
    const removed = await tx`
      DELETE FROM public.office_grand_prix_participants
      WHERE session_id = ${session.id}
        AND user_id = ${userId}
        AND NOT is_bot
      RETURNING id
    `;
    if (!removed[0]) return;

    const remaining = await tx`
      SELECT user_id, is_ready, slot
      FROM public.office_grand_prix_participants
      WHERE session_id = ${session.id}
        AND NOT is_bot
      ORDER BY slot
    `;
    if (remaining.length === 0) {
      await tx`
        UPDATE public.office_grand_prix_sessions
        SET status = 'cancelled',
            coordinator_id = NULL,
            coordinator_heartbeat_at = NULL,
            finished_at = now(),
            updated_at = now(),
            version = version + 1
        WHERE id = ${session.id}
      `;
      return;
    }
    const ready = remaining.filter((row) => row.is_ready);
    if (ready.length === 0) {
      await tx`
        UPDATE public.office_grand_prix_sessions
        SET status = 'lobby',
            coordinator_id = NULL,
            coordinator_claimed_at = NULL,
            coordinator_heartbeat_at = NULL,
            countdown_started_at = NULL,
            roster_locks_at = NULL,
            race_starts_at = NULL,
            updated_at = now(),
            version = version + 1
        WHERE id = ${session.id}
      `;
    } else {
      const coordinatorId = ready.some((row) =>
          String(row.user_id) === String(session.coordinator_id)
        )
        ? session.coordinator_id
        : ready[0].user_id;
      await tx`
        UPDATE public.office_grand_prix_sessions
        SET coordinator_id = ${coordinatorId},
            coordinator_claimed_at = CASE
              WHEN coordinator_id IS DISTINCT FROM ${coordinatorId}
                THEN now()
              ELSE coordinator_claimed_at
            END,
            coordinator_heartbeat_at = CASE
              WHEN coordinator_id IS DISTINCT FROM ${coordinatorId}
                THEN now()
              ELSE coordinator_heartbeat_at
            END,
            updated_at = now(),
            version = version + 1
        WHERE id = ${session.id}
      `;
    }
  });
  return loadState(userId, sessionId);
}

async function coordinatorHeartbeat(userId: string, body: any) {
  if (!db) throw new Error("Database is not configured.");
  const sessionId = validUuid(body.sessionId);
  await db.begin(async (tx) => {
    let session = await advanceSession(tx, sessionId);
    if (!session) throw gameError("session_not_found", "Sesja nie istnieje.");
    if (!["countdown", "racing"].includes(session.status)) return;
    const heartbeat = await tx`
      UPDATE public.office_grand_prix_sessions
      SET coordinator_heartbeat_at = now(),
          updated_at = now()
      WHERE id = ${session.id}
        AND coordinator_id = ${userId}
      RETURNING id
    `;
    if (!heartbeat[0]) {
      throw gameError("not_coordinator", "Inny gracz koordynuje ten wyścig.");
    }
    session = await advanceSession(tx, sessionId);
  });
  return loadState(userId, sessionId);
}

async function claimCoordinator(userId: string, body: any) {
  if (!db) throw new Error("Database is not configured.");
  const sessionId = validUuid(body.sessionId);
  await db.begin(async (tx) => {
    const session = await advanceSession(tx, sessionId);
    if (!session) throw gameError("session_not_found", "Sesja nie istnieje.");
    if (!["lobby", "countdown", "racing"].includes(session.status)) {
      throw gameError("race_closed", "Wyścig jest już zakończony.");
    }
    const participant = await tx`
      SELECT id, is_ready
      FROM public.office_grand_prix_participants
      WHERE session_id = ${session.id}
        AND user_id = ${userId}
        AND NOT is_bot
    `;
    if (!participant[0]?.is_ready) {
      throw gameError("not_ready", "Tylko gotowy kierowca może przejąć koordynację.");
    }
    const heartbeatMs = session.coordinator_heartbeat_at
      ? new Date(session.coordinator_heartbeat_at).getTime()
      : 0;
    const coordinatorExists = session.coordinator_id
      ? await tx`
        SELECT 1
        FROM public.office_grand_prix_participants
        WHERE session_id = ${session.id}
          AND user_id = ${session.coordinator_id}
          AND NOT is_bot
      `
      : [];
    const stale = !session.coordinator_id
      || coordinatorExists.length === 0
      || Date.now() - heartbeatMs > OGP_COORDINATOR_STALE_MS
      || String(session.coordinator_id) === userId;
    if (!stale) {
      throw gameError("coordinator_active", "Koordynator nadal jest aktywny.");
    }
    await tx`
      UPDATE public.office_grand_prix_sessions
      SET coordinator_id = ${userId},
          coordinator_claimed_at = now(),
          coordinator_heartbeat_at = now(),
          updated_at = now(),
          version = version + 1
      WHERE id = ${session.id}
    `;
  });
  return loadState(userId, sessionId);
}

async function submitRace(userId: string, body: any) {
  if (!db) throw new Error("Database is not configured.");
  const sessionId = validUuid(body.sessionId);
  requireV2ClientContract(body);
  const elapsedTicks = asInt(body.elapsedTicks, 0);
  if (elapsedTicks < 1 || elapsedTicks > OGP_MAX_TICKS) {
    throw gameError("bad_elapsed", "Nieprawidłowy czas wyścigu.");
  }
  const inputs = parseInputs(body.inputs ?? body.inputLog, elapsedTicks);
  const idempotencyKey = String(
    body.idempotencyKey ?? `${sessionId}:${userId}`,
  );
  if (
    idempotencyKey.length < 8
    || idempotencyKey.length > 100
    || !/^[A-Za-z0-9:_-]+$/.test(idempotencyKey)
  ) {
    throw gameError("bad_idempotency_key", "Nieprawidłowy klucz zapisu.");
  }
  const canonical = JSON.stringify({ elapsedTicks, inputs });
  const payloadHash = await sha256Hex(canonical);
  const clientMeta = safeClientMeta(body.clientMeta);
  let alreadyAccepted = false;

  await db.begin(async (tx) => {
    let session = await advanceSession(tx, sessionId);
    if (!session) throw gameError("session_not_found", "Sesja nie istnieje.");
    if (session.engine_version !== OGP_ENGINE_VERSION) {
      throw gameError("session_engine_mismatch", "Ta sesja używa innego silnika wyścigu.");
    }
    const existing = await tx`
      SELECT payload_hash, idempotency_key
      FROM public.office_grand_prix_submissions
      WHERE session_id = ${session.id}
        AND user_id = ${userId}
      FOR UPDATE
    `;
    if (existing[0]) {
      if (
        existing[0].payload_hash === payloadHash
        && existing[0].idempotency_key === idempotencyKey
      ) {
        alreadyAccepted = true;
        return;
      }
      throw gameError("already_submitted", "Ten wyścig został już zapisany.");
    }
    requireCurrentSessionVersion(body, session);
    if (session.status !== "racing" || !session.race_started_at) {
      throw gameError("race_not_running", "Wyścig jeszcze się nie rozpoczął.");
    }
    if (
      session.submissions_due_at
      && Date.now() > new Date(session.submissions_due_at).getTime()
    ) {
      throw gameError("submission_closed", "Minął czas na zapis wyścigu.");
    }
    const participant = await tx`
      SELECT id
      FROM public.office_grand_prix_participants
      WHERE session_id = ${session.id}
        AND user_id = ${userId}
        AND NOT is_bot
        AND is_ready
      FOR UPDATE
    `;
    if (!participant[0]) {
      throw gameError("not_in_race", "Nie ma Cię na liście startowej.");
    }

    const wallTicks = Math.floor(
      (Date.now() - new Date(session.race_started_at).getTime() + 1500) / OGP_TICK_MS,
    );
    if (elapsedTicks > Math.min(OGP_MAX_TICKS, wallTicks)) {
      throw gameError("race_too_fast", "Zapis wyścigu wyprzedza czas serwera.");
    }

    await tx`
      INSERT INTO public.office_grand_prix_submissions (
        session_id,
        user_id,
        idempotency_key,
        payload_hash,
        elapsed_ticks,
        input_events,
        input_log,
        client_meta
      )
      VALUES (
        ${session.id},
        ${userId},
        ${idempotencyKey},
        ${payloadHash},
        ${elapsedTicks},
        ${inputs.length},
        ${JSON.stringify(inputs)}::jsonb,
        ${JSON.stringify(clientMeta)}::jsonb
      )
    `;
    await tx`
      UPDATE public.office_grand_prix_participants
      SET submission_received_at = now()
      WHERE id = ${participant[0].id}
    `;
    session = await advanceSession(tx, sessionId);
  });

  const state = await loadState(userId, sessionId);
  const official = state.participants.find((row) => row.userId === userId) ?? null;
  return {
    ...state,
    submission: {
      accepted: true,
      alreadyAccepted,
      inputEvents: inputs.length,
      elapsedTicks,
    },
    result: official?.finished == null
      ? { pending: true }
      : {
        pending: false,
        dnf: !official.finished,
        placement: official.place,
        points: official.points,
        completionMs: official.completionMs,
      },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return json(req, { ok: false, error: "Method not allowed." }, 405);
  }

  try {
    const contentLength = asInt(req.headers.get("Content-Length"), 0);
    if (contentLength > OGP_MAX_REQUEST_BYTES) {
      throw gameError("request_too_large", "Zapis wyścigu jest zbyt duży.");
    }
    const user = await requireUser(req);
    const raw = await req.text();
    if (raw.length > OGP_MAX_REQUEST_BYTES) {
      throw gameError("request_too_large", "Zapis wyścigu jest zbyt duży.");
    }
    const body = raw ? JSON.parse(raw) : {};
    const action = String(body.action ?? "state");

    let result;
    if (action === "state") {
      const sessionId = body.sessionId ? validUuid(body.sessionId) : null;
      result = await progressThenState(user.id, sessionId);
    } else if (action === "join") {
      result = await joinLobby(user.id, body);
    } else if (action === "ready") {
      result = await setReady(user.id, body);
    } else if (action === "leave") {
      result = await leaveLobby(user.id, body);
    } else if (action === "coordinator_heartbeat") {
      result = await coordinatorHeartbeat(user.id, body);
    } else if (action === "claim_coordinator") {
      result = await claimCoordinator(user.id, body);
    } else if (action === "submit") {
      result = await submitRace(user.id, body);
    } else {
      throw gameError("unknown_action", "Nieznana akcja.");
    }

    return json(req, { ok: true, ...result });
  } catch (error) {
    console.error(error);
    if (error instanceof SyntaxError) {
      return json(req, {
        ok: false,
        code: "bad_json",
        error: "Nieprawidłowe żądanie.",
      });
    }
    return json(req, {
      ok: false,
      code: error?.isGame ? error.code : "server_error",
      error: error?.isGame ? error.message : "Błąd serwera.",
    }, error?.isGame ? error.status : 500);
  }
});
