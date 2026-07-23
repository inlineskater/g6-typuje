// @ts-nocheck
// Office Grand Prix G6 authoritative race server and deterministic replay
// verifier.
//
// Deployment:
//   supabase functions deploy office-grand-prix-action
// `supabase/config.toml` keeps verify_jwt=true. SUPABASE_DB_URL, SUPABASE_URL,
// and SUPABASE_ANON_KEY are supplied by the hosted Supabase environment.
//
// V3 (2026-07): dropped the live lobby/coordinator/broadcast model entirely.
// Every race is its own solo session: `start_race` creates it, seats the
// caller in slot 0 and 7 bots in the rest, and starts it immediately --
// nothing waits on another human. `ghosts` is a separate, read-only action
// that hands the browser up to 7 other players' most recent recorded laps
// (for THIS engine/track version) so the client can drive extra visual karts
// locally by replaying their inputLog through the same deterministic engine.
// Ghosts never touch this file's roster/scoring: the authoritative replay
// below always fills the 7 non-player slots with the bot AI, exactly as it
// always has, so a ghost can never affect the caller's official result.

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
const OGP_ENGINE_VERSION = "office_grand_prix_v4";
const OGP_TRACK_VERSION = "office_loop_v4";
const OGP_TRACK_HASH = "1d4b3b7abbf81bc598c0e309dc2baf8b46115d0cba3fdb9fa835cf8dde21569b";
const OGP_TICK_MS = 50;
const OGP_TRACK_LENGTH = 160000;
const OGP_START_PROGRESS = 16000;
const OGP_FINISH_PROGRESS = OGP_START_PROGRESS + OGP_TRACK_LENGTH;
const OGP_MAX_TICKS = 1200;
const OGP_MAX_INPUT_EVENTS = 1200;
const OGP_ACCEL = 18;
const OGP_START_SPEED = 130;
const OGP_MAX_SPEED = 280;
const OGP_FORWARD_PCT = 96;
const OGP_STEER_RESPONSE = 580;
const OGP_STEER_CENTER = 850;
const OGP_STEER_MAX = 1000;
const OGP_TURN_RATE = 8;
const OGP_OFFROAD_THRESHOLD = 5600;
const OGP_OFFROAD_PCT = 68;
const OGP_GRASS_MAX_SPEED = 140;
const OGP_GRASS_BRAKE = 10;
const OGP_GRASS_GRIP_PCT = 55;
const OGP_SAFETY_LATERAL = 8000;
const OGP_RESET_AFTER_TICKS = 20;
const OGP_RESET_CONTROL_TICKS = 12;
const OGP_GRIP_NUM_ROAD = 4;
const OGP_GRIP_DEN_ROAD = 5;
const OGP_GRIP_NUM_GRASS = 1;
const OGP_GRIP_DEN_GRASS = 7;
const OGP_BOOST_PCT = 140;
const OGP_BOOST_TICKS = 30;
const OGP_BANANA_PCT = 65;
const OGP_BANANA_TICKS = 25;
const OGP_SHIELD_TICKS = 120;
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
// Generated from the pinned Three.js 0.185.1 CatmullRomCurve3 (control
// points + tension .5 in index.html's ogpBuildScene) using
// getTangentAt(i / 256). Physics consumes only these checked-in integers.
const OGP_TRACK_TANGENTS = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,254,250,248,246,244,241,239,237,236,234,232,231,230,229,227,224,222,219,217,215,213,211,209,207,206,205,203,200,197,195,193,191,189,187,185,183,181,179,177,172,170,169,170,172,172,172,174,179,189,198,204,207,209,212,217,219,217,213,210,208,203,195,183,175,170,167,163,158,152,146,142,138,136,131,127,126,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,129,129,128,125,123,122,120,118,118,116,113,108,104,101,97,94,92,89,87,84,81,78,75,73,70,68,66,64,62,60,58,56,54,52,50,46,41,38,37,38,36,35,35,36,37,35,35,39,47,62,72,78,81,81,82,84,86,87,87,89,90,91,90,88,84,82,78,72,64,54,46,37,24,15,10,6,0,254,254,0,0,0,0,0,0];
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

const OGP_RACE_SECONDS = 90;
const OGP_SUBMISSION_GRACE_SECONDS = 10;
const OGP_MAX_GHOSTS = 7;
const OGP_MAX_REQUEST_BYTES = 300000;
// Production session creation, opened 2026-07-23 by explicit override of the
// V2 mobile acceptance gate; V3 (2026-07) replaced the multiplayer surface
// that gate was mainly about with async ghosts, so live-coordinator/
// reconnect risk no longer applies. See
// docs/office-grand-prix-v2-release-gate.md for the audit trail.
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

// ── Deterministic physics engine (mirrors index.html) ───────────────────────

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

// Chases `current` toward `target` by a proportional (num/den) fraction of
// the remaining gap each tick, with a minimum 1-unit step so it always fully
// converges instead of stalling on integer truncation. Applied to
// car.moveHeading chasing car.heading, this is the whole drift model.
function ogpChaseAngle(current: number, target: number, num: number, den: number) {
  const gap = ogpAngleDelta(target, current);
  if (gap === 0) return current;
  let step = Math.trunc(gap * num / den);
  if (step === 0) step = gap > 0 ? 1 : -1;
  if (Math.abs(step) > Math.abs(gap)) step = gap;
  return ogpWrapAngle(current + step);
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
  const speedFactor = Math.floor(OGP_MAX_SPEED / 2 + car.speed / 2);
  const turn = Math.trunc(
    car.steering * speedFactor * OGP_TURN_RATE * gripPct /
    (OGP_STEER_MAX * OGP_MAX_SPEED * 100),
  );
  car.heading = ogpWrapAngle(car.heading + turn);
  // Travel direction lags the nose direction -- that gap is the drift.
  car.moveHeading = ogpChaseAngle(
    car.moveHeading,
    car.heading,
    offroad ? OGP_GRIP_NUM_GRASS : OGP_GRIP_NUM_ROAD,
    offroad ? OGP_GRIP_DEN_GRASS : OGP_GRIP_DEN_ROAD,
  );

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
  const relativeHeading = ogpAngleDelta(car.moveHeading, ogpTrackHeading(car.progress));
  car.progress += Math.trunc(velocity * ogpCos(relativeHeading) / OGP_TRIG_SCALE);
  car.lane += Math.trunc(velocity * ogpSin(-relativeHeading) / OGP_TRIG_SCALE);

  if (Math.abs(car.lane) > OGP_SAFETY_LATERAL) car.outsideTicks += 1;
  else car.outsideTicks = 0;
  if (car.outsideTicks < OGP_RESET_AFTER_TICKS) return false;

  car.progress = Math.max(OGP_START_PROGRESS, car.lastCheckpoint - 800);
  car.lane = 0;
  car.heading = ogpTrackHeading(car.progress);
  car.moveHeading = car.heading;
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
        moveHeading: pose.heading,
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

// ── Auth + data helpers ──────────────────────────────────────────────────────

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

function mapSession(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    mode: row.game_mode,
    engineVersion: row.engine_version,
    seed: asInt(row.seed),
    raceStartedAt: row.race_started_at,
    race_started_at: row.race_started_at,
    raceEndsAt: row.race_ends_at,
    submissionsDueAt: row.submissions_due_at,
    createdAt: row.created_at,
  };
}

// ── Ghosts (read-only, no roster/scoring impact) ────────────────────────────

async function fetchGhosts(userId: string) {
  const rows = await db`
    WITH recent AS (
      SELECT DISTINCT ON (s.user_id)
        s.user_id,
        s.input_log,
        s.received_at,
        p.nick_snapshot AS nick,
        p.cosmetic,
        sc.finished,
        sc.completion_ms
      FROM public.office_grand_prix_submissions s
      JOIN public.office_grand_prix_sessions sess ON sess.id = s.session_id
      JOIN public.office_grand_prix_participants p
        ON p.session_id = s.session_id AND p.user_id = s.user_id
      LEFT JOIN public.office_grand_prix_scores sc
        ON sc.session_id = s.session_id AND sc.user_id = s.user_id
      WHERE sess.engine_version = ${OGP_ENGINE_VERSION}
        AND s.user_id != ${userId}
      ORDER BY s.user_id, s.received_at DESC
    )
    SELECT *
    FROM recent
    ORDER BY received_at DESC
    LIMIT ${OGP_MAX_GHOSTS}
  `;
  return rows.map((row) => ({
    userId: row.user_id,
    nick: row.nick,
    carId: OGP_COSMETICS[asInt(row.cosmetic)] ?? OGP_COSMETICS[0],
    inputLog: Array.isArray(row.input_log) ? row.input_log : [],
    finishedTick: row.finished && row.completion_ms != null
      ? Math.round(asInt(row.completion_ms) / OGP_TICK_MS)
      : null,
  }));
}

async function loadSharedState(userId: string) {
  if (!db) throw new Error("Database is not configured.");
  const profile = await profileForUser(db, userId);
  const [modeRows, weekly, allTime, testStandings, awards] = await Promise.all([
    db`SELECT public.office_grand_prix_mode(now()) AS mode`,
    db`SELECT * FROM public.office_grand_prix_current_week ORDER BY rank LIMIT 20`,
    db`SELECT * FROM public.office_grand_prix_all_time ORDER BY rank LIMIT 20`,
    db`SELECT * FROM public.office_grand_prix_test_standings ORDER BY rank LIMIT 20`,
    db`SELECT * FROM public.office_grand_prix_recent_awards ORDER BY week_start DESC, rank LIMIT 12`,
  ]);
  const currentMode = modeRows[0]?.mode ?? "arcade";
  const mappedTestStandings = testStandings.map((row) => ({
    ...row,
    rank: asInt(row.rank),
    finish_place: asInt(row.finish_place),
    completion_ms: asInt(row.completion_ms),
    score: OGP_PLACEMENT_POINTS[asInt(row.finish_place) - 1] ?? 0,
  }));

  return {
    serverNow: new Date().toISOString(),
    maintenance: !OGP_SESSIONS_ENABLED,
    engineVersion: OGP_ENGINE_VERSION,
    trackVersion: OGP_TRACK_VERSION,
    trackHash: OGP_TRACK_HASH,
    tickMs: OGP_TICK_MS,
    mode: currentMode,
    profile: {
      id: profile.id,
      nick: profile.nick,
      coins: asInt(profile.coins),
    },
    weekly,
    testStandings: mappedTestStandings,
    allTime,
    awards,
  };
}

async function ghostsAction(userId: string) {
  if (!db) throw new Error("Database is not configured.");
  const [shared, ghosts] = await Promise.all([
    loadSharedState(userId),
    fetchGhosts(userId),
  ]);
  return { ...shared, ghosts };
}

// ── Start a solo race ────────────────────────────────────────────────────────

async function startRace(userId: string, body: any) {
  if (!db) throw new Error("Database is not configured.");
  if (!OGP_SESSIONS_ENABLED) {
    throw gameError(
      "maintenance",
      "Office Grand Prix jest przebudowywany. Wyścigi są chwilowo wyłączone.",
      503,
    );
  }
  requireV2ClientContract(body);

  const session = await db.begin(async (tx) => {
    const profile = await profileForUser(tx, userId, true);
    const modeRows = await tx`SELECT public.office_grand_prix_mode(now()) AS mode`;
    const mode = modeRows[0]?.mode ?? "arcade";

    if (mode === "arcade") {
      const charged = await tx`
        UPDATE public.profiles
        SET coins = coins - 1
        WHERE id = ${userId} AND coins >= 1
        RETURNING coins
      `;
      if (!charged[0]) {
        throw gameError("insufficient_coins", "Potrzebujesz 1 monety w archiwum.");
      }
      await tx`
        INSERT INTO public.coin_transactions(user_id, delta, reason, meta)
        VALUES (
          ${userId},
          -1,
          'arcade_entry',
          ${JSON.stringify({ game_type: "office_grand_prix" })}::jsonb
        )
      `;
    }

    const seedBytes = crypto.getRandomValues(new Uint32Array(1));
    const seed = seedBytes[0] & 0x7fffffff;
    const requestedCosmetic = asInt(body.cosmetic, -1);
    const cosmetic = requestedCosmetic >= 0 && requestedCosmetic <= 7 ? requestedCosmetic : 0;

    const inserted = await tx`
      INSERT INTO public.office_grand_prix_sessions (
        game_mode, engine_version, seed, created_by,
        status, race_started_at, race_ends_at, submissions_due_at
      )
      VALUES (
        ${mode}, ${OGP_ENGINE_VERSION}, ${seed}, ${userId},
        'racing', now(), now() + interval '90 seconds', now() + interval '100 seconds'
      )
      RETURNING *
    `;
    const sessionRow = inserted[0];

    await tx`
      INSERT INTO public.office_grand_prix_participants (
        session_id, slot, user_id, nick_snapshot, cosmetic, is_bot, is_ready, ready_at
      )
      VALUES (${sessionRow.id}, 0, ${userId}, ${profile.nick}, ${cosmetic}, false, true, now())
    `;
    const botCosmetics = [0, 1, 2, 3, 4, 5, 6, 7].filter((value) => value !== cosmetic);
    for (let slot = 1; slot < 8; slot += 1) {
      await tx`
        INSERT INTO public.office_grand_prix_participants (
          session_id, slot, user_id, nick_snapshot, cosmetic, is_bot, is_ready, ready_at
        )
        VALUES (
          ${sessionRow.id}, ${slot}, NULL, ${OGP_BOT_NAMES[slot - 1] ?? `Bot ${slot}`},
          ${botCosmetics[slot - 1]}, true, true, now()
        )
      `;
    }
    return sessionRow;
  });

  const shared = await loadSharedState(userId);
  return { ...shared, session: mapSession(session) };
}

// ── Submit + finalize (authoritative replay) ────────────────────────────────

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
  let ownResult: any = null;

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
    if (String(participant.user_id) === String(session.created_by)) {
      ownResult = result;
    }
    await tx`
      INSERT INTO public.office_grand_prix_scores (
        session_id, user_id, nick_snapshot, week_start, game_mode,
        finish_place, placement_points, fastest_bonus, total_points,
        finished, completion_ms, input_events, server_meta
      )
      VALUES (
        ${session.id}, ${participant.user_id}, ${participant.nick_snapshot},
        ${weekStart}, ${session.game_mode},
        ${result.place}, ${result.placementPoints}, ${result.fastestBonus}, ${result.totalPoints},
        ${result.finished}, ${result.completionMs}, ${result.inputEvents},
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
        VALUES (${participant.user_id}, 'office_grand_prix', ${encodedScore}, 1)
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
    SET status = 'finished', finished_at = now(), updated_at = now(), version = version + 1
    WHERE id = ${session.id} AND status = 'racing'
    RETURNING *
  `;
  return { session: finished[0] ?? session, ownResult };
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
  const idempotencyKey = String(body.idempotencyKey ?? `${sessionId}:${userId}`);
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
  let ownResult: any = null;

  await db.begin(async (tx) => {
    const sessionRows = await tx`
      SELECT * FROM public.office_grand_prix_sessions WHERE id = ${sessionId} FOR UPDATE
    `;
    let session = sessionRows[0];
    if (!session) throw gameError("session_not_found", "Sesja nie istnieje.");
    if (String(session.created_by) !== userId) {
      throw gameError("not_your_session", "To nie jest Twoja sesja wyścigu.");
    }
    if (session.engine_version !== OGP_ENGINE_VERSION) {
      throw gameError("session_engine_mismatch", "Ta sesja używa innego silnika wyścigu.");
    }
    const existing = await tx`
      SELECT payload_hash, idempotency_key
      FROM public.office_grand_prix_submissions
      WHERE session_id = ${session.id} AND user_id = ${userId}
      FOR UPDATE
    `;
    if (existing[0]) {
      if (
        existing[0].payload_hash === payloadHash
        && existing[0].idempotency_key === idempotencyKey
      ) {
        alreadyAccepted = true;
        const scoreRows = await tx`
          SELECT finish_place, total_points, finished, completion_ms
          FROM public.office_grand_prix_scores
          WHERE session_id = ${session.id} AND user_id = ${userId}
        `;
        if (scoreRows[0]) {
          ownResult = {
            place: asInt(scoreRows[0].finish_place),
            points: asInt(scoreRows[0].total_points),
            finished: scoreRows[0].finished,
            completionMs: scoreRows[0].completion_ms == null ? null : asInt(scoreRows[0].completion_ms),
          };
        }
        return;
      }
      throw gameError("already_submitted", "Ten wyścig został już zapisany.");
    }
    if (session.status !== "racing" || !session.race_started_at) {
      throw gameError("race_not_running", "Wyścig jeszcze się nie rozpoczął.");
    }
    if (
      session.submissions_due_at
      && Date.now() > new Date(session.submissions_due_at).getTime()
    ) {
      throw gameError("submission_closed", "Minął czas na zapis wyścigu.");
    }

    const wallTicks = Math.floor(
      (Date.now() - new Date(session.race_started_at).getTime() + 1500) / OGP_TICK_MS,
    );
    if (elapsedTicks > Math.min(OGP_MAX_TICKS, wallTicks)) {
      throw gameError("race_too_fast", "Zapis wyścigu wyprzedza czas serwera.");
    }

    await tx`
      INSERT INTO public.office_grand_prix_submissions (
        session_id, user_id, idempotency_key, payload_hash,
        elapsed_ticks, input_events, input_log, client_meta
      )
      VALUES (
        ${session.id}, ${userId}, ${idempotencyKey}, ${payloadHash},
        ${elapsedTicks}, ${inputs.length}, ${JSON.stringify(inputs)}::jsonb,
        ${JSON.stringify(clientMeta)}::jsonb
      )
    `;
    await tx`
      UPDATE public.office_grand_prix_participants
      SET submission_received_at = now()
      WHERE session_id = ${session.id} AND user_id = ${userId}
    `;

    const finalized = await finalizeSession(tx, session);
    session = finalized.session;
    ownResult = finalized.ownResult
      ? {
        place: finalized.ownResult.place,
        points: finalized.ownResult.totalPoints,
        finished: finalized.ownResult.finished,
        completionMs: finalized.ownResult.completionMs,
      }
      : null;
  });

  const shared = await loadSharedState(userId);
  return {
    ...shared,
    submission: { accepted: true, alreadyAccepted, inputEvents: inputs.length, elapsedTicks },
    participant: ownResult,
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
    const action = String(body.action ?? "ghosts");

    let result;
    if (action === "ghosts") {
      result = await ghostsAction(user.id);
    } else if (action === "start_race") {
      result = await startRace(user.id, body);
    } else if (action === "submit") {
      result = await submitRace(user.id, body);
    } else {
      throw gameError("unknown_action", "Nieznana akcja.");
    }

    return json(req, { ok: true, ...result });
  } catch (error) {
    console.error(error);
    if (error instanceof SyntaxError) {
      return json(req, { ok: false, code: "bad_json", error: "Nieprawidłowe żądanie." });
    }
    return json(req, {
      ok: false,
      code: error?.isGame ? error.code : "server_error",
      error: error?.isGame ? error.message : "Błąd serwera.",
    }, error?.isGame ? error.status : 500);
  }
});
