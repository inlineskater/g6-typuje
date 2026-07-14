import assert from "node:assert/strict";
import test from "node:test";
import {
  COIN_PUSHER_BASE_DURATION_MS,
  COIN_PUSHER_PHYSICS_VERSION,
  coinPusherConservation,
  coinPusherPusherYAt,
  createInitialCoinPusherState,
  sanitizeCoinPusherState,
  simulateCoinPusherDrop,
} from "../supabase/functions/_shared/coin-pusher-physics.mjs";
import {
  COIN_PUSHER_QUEUE_GAP_MS,
  COIN_PUSHER_QUEUE_LIMIT,
  coinPusherQueueAdmission,
  coinPusherScheduleStartMs,
} from "../supabase/functions/_shared/coin-pusher-queue.mjs";

test("physics v2 initial cabinet contains forty valid flat coins", () => {
  const state = createInitialCoinPusherState();
  assert.equal(state.version, COIN_PUSHER_PHYSICS_VERSION);
  assert.equal(state.coins.length, 40);
  assert.equal(new Set(state.coins.map((coin) => coin.id)).size, 40);
  assert.ok(state.coins.every((coin) => coin.x > 80 && coin.x < 920 && coin.y > 300 && coin.y < 735));
});

test("legacy or malformed cabinet state resets to a safe v2 layout", () => {
  const legacy = sanitizeCoinPusherState({ version: 1, coins: [{ id: "old", x: 500, y: 500 }] }, 8);
  assert.equal(legacy.version, COIN_PUSHER_PHYSICS_VERSION);
  assert.equal(legacy.coins.length, 40);
  assert.ok(legacy.coins.every((coin) => coin.id.startsWith("r9c")));
});

test("drop simulation is deterministic and conserves every physical coin", () => {
  const state = createInitialCoinPusherState();
  const input = { state, lane: 2, seed: 123456, revision: 7, phaseMs: 830 };
  const first = simulateCoinPusherDrop(input);
  const second = simulateCoinPusherDrop(input);
  assert.deepEqual(second, first);
  assert.equal(coinPusherConservation(state.coins.length, first), 0);
  assert.ok(first.replay.frames.length > 70);
  assert.ok(first.replay.frames.some((frame) => Array.isArray(frame.d)));
  assert.ok(first.replay.frames.some((frame) => frame.d === null && frame.c.length > 0));
  assert.equal(first.replay.version, COIN_PUSHER_PHYSICS_VERSION);
  assert.ok(first.replay.durationMs >= COIN_PUSHER_BASE_DURATION_MS);
  assert.ok(first.replay.phases.chuteEndMs > 0);
  assert.equal(first.replay.frames.at(-1).t, first.replay.durationMs);
});

test("lane and timing alter the physical trajectory", () => {
  const state = createInitialCoinPusherState();
  const left = simulateCoinPusherDrop({ state, lane: 0, seed: 99, revision: 1, phaseMs: 0 });
  const right = simulateCoinPusherDrop({ state, lane: 4, seed: 99, revision: 1, phaseMs: 0 });
  const late = simulateCoinPusherDrop({ state, lane: 0, seed: 99, revision: 1, phaseMs: 900 });
  assert.notDeepEqual(left.replay.frames, right.replay.frames);
  assert.notDeepEqual(left.state, late.state);
  assert.equal(coinPusherConservation(state.coins.length, left), 0);
  assert.equal(coinPusherConservation(state.coins.length, right), 0);
  assert.equal(coinPusherConservation(state.coins.length, late), 0);
});

test("different seeds create distinct but conserved trajectories", () => {
  const state = createInitialCoinPusherState();
  const first = simulateCoinPusherDrop({ state, lane: 2, seed: 101, revision: 2, phaseMs: 400 });
  const second = simulateCoinPusherDrop({ state, lane: 2, seed: 987654, revision: 2, phaseMs: 400 });
  assert.notDeepEqual(first.replay.frames, second.replay.frames);
  assert.equal(coinPusherConservation(state.coins.length, first), 0);
  assert.equal(coinPusherConservation(state.coins.length, second), 0);
});

test("persistent cabinet conserves raw state across sequential drops", () => {
  let state = createInitialCoinPusherState();
  for (let index = 0; index < 30; index += 1) {
    const before = state.coins.length;
    const result = simulateCoinPusherDrop({
      state,
      lane: index % 5,
      seed: 1000 + index,
      revision: index,
      phaseMs: (index * 347) % 2300,
    });
    assert.equal(coinPusherConservation(before, result), 0, `drop ${index} lost a persisted coin`);
    state = result.state;
  }
});

test("maintenance refills a sparse cabinet without losing conservation", () => {
  const sparse = { version: COIN_PUSHER_PHYSICS_VERSION, coins: [] };
  const result = simulateCoinPusherDrop({ state: sparse, lane: 2, seed: 5, revision: 4, phaseMs: 200 });
  assert.ok(result.maintenanceAdded > 0);
  assert.ok(result.state.coins.length >= 24);
  assert.ok(result.replay.durationMs > COIN_PUSHER_BASE_DURATION_MS);
  assert.equal(result.replay.phases.refillStartMs, COIN_PUSHER_BASE_DURATION_MS);
  assert.ok(result.replay.frames.some((frame) => Number(frame.m || 0) > 0));
  assert.equal(coinPusherConservation(0, result), 0);
});

test("pusher motion is periodic and timing-sensitive", () => {
  assert.equal(coinPusherPusherYAt(0, 0), coinPusherPusherYAt(2300, 0));
  assert.notEqual(coinPusherPusherYAt(0, 0), coinPusherPusherYAt(575, 0));
  assert.notEqual(coinPusherPusherYAt(0, 0), coinPusherPusherYAt(0, 575));
});

test("invalid lanes are rejected", () => {
  assert.throws(() => simulateCoinPusherDrop({ state: createInitialCoinPusherState(), lane: 5, seed: 1 }), /Invalid/);
});

test("shared queue is FIFO, capped, and fair per player", () => {
  const queue = [{ user_id: "a" }, { user_id: "b" }];
  assert.deepEqual(coinPusherQueueAdmission(queue, "c"), { ok: true, position: 3 });
  assert.deepEqual(coinPusherQueueAdmission(queue, "a"), { ok: false, reason: "already_queued" });
  assert.deepEqual(
    coinPusherQueueAdmission([...queue, { user_id: "c" }], "d"),
    { ok: false, reason: "full" },
  );
  assert.equal(COIN_PUSHER_QUEUE_LIMIT, 3);
});

test("queue schedule leaves a fixed gap after the current tail", () => {
  const now = 1_000_000;
  const idleStart = coinPusherScheduleStartMs({ nowMs: now, busyUntilMs: now - 1 });
  const queuedStart = coinPusherScheduleStartMs({ nowMs: now, busyUntilMs: now + 5000 });
  assert.ok(idleStart > now);
  assert.equal(queuedStart, now + 5000 + COIN_PUSHER_QUEUE_GAP_MS);
});
