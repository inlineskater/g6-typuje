#!/usr/bin/env node
// „3 Pary Spodni" parity harness.
//
// The Edge Function does not trust the client's score: it replays the round
// from (seed, flapEvents, elapsedMs) and stores what ITS sim produces. So the
// browser sim and replayFlappy() have to agree exactly, or players see a good
// run stored as 0 — which is precisely what happened all through the week of
// 2026-08-31 (every submission replayed to base_score 0, pipes 0).
//
// Nothing here is a third transcription: the client sim is loaded from
// games/flappy-pants.js in a vm with DOM stubs and driven frame by frame, and
// the replay is extracted from the Edge Function source. A bot plays N rounds
// on jittered frame times (including dropped frames); every round's score,
// pipes and lives must round-trip.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url).pathname;

// ── the browser sim, as shipped ────────────────────────────────────────────
const clock = { now: 0 };
const sandbox = {
  performance: { now: () => clock.now },
  document: { getElementById: () => null, addEventListener: () => {} },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  window: { devicePixelRatio: 1 },
  console,
  flappyPantsRuntime: null,
  fpStartBtn: null, fpStatus: null, fpScoreEl: null, fpLivesEl: null, fpArena: null,
  allGamesMode: false,
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(root + 'games/flappy-pants.js', 'utf8'), sandbox, { filename: 'flappy-pants.js' });
// The real one submits over the network; here a death just stops the round.
sandbox.finishFlappyPantsRound = () => { sandbox.flappyPantsRuntime.playing = false; };

// ── the server replay, as deployed ─────────────────────────────────────────
const fn = readFileSync(root + 'supabase/functions/flappy-pants-action/index.ts', 'utf8');
const grab = (re, what) => {
  const m = fn.match(re);
  if (!m) throw new Error('could not extract ' + what + ' from the Edge Function');
  return m[0];
};
const serverSrc = [
  ...['MAX_SCORE_PER_ROUND', 'MAX_LIVES', 'REPLAY_TICK_MS', 'ROUND_EXPIRES_SECONDS', 'FP_CS_W', 'FP_CS_H', 'FP_PLAYER_X',
      'FP_PLAYER_R', 'FP_GRAVITY', 'FP_FLAP_V', 'FP_PIPE_SPEED', 'FP_PIPE_W', 'FP_GAP',
      'FP_PIPE_SPACING'].map(n => grab(new RegExp('^const ' + n + ' = .*$', 'm'), n)),
  grab(/^function makeRng[\s\S]*?\n}$/m, 'makeRng'),
  grab(/^function nextGapY[\s\S]*?\n}$/m, 'nextGapY'),
  grab(/^function replayFlappy[\s\S]*?\n}$/m, 'replayFlappy'),
  'replayFlappy',
].join('\n');
const replayFlappy = vm.runInNewContext(serverSrc);

// top-level `const`s in a vm script are not properties of its global object
const { FP_PLAYER_X, FP_PLAYER_R, FP_PIPE_W, FP_CS_H, FP_MAX_LIVES } = vm.runInContext(
  '({ FP_PLAYER_X, FP_PLAYER_R, FP_PIPE_W, FP_CS_H, FP_MAX_LIVES })', sandbox);

// ── a bot that plays badly enough to die and well enough to score ──────────
function playRound(seed, rngFrame) {
  sandbox.beginFlappyPantsRound({ id: 'r', seed });
  const rt = sandbox.flappyPantsRuntime;
  clock.now = 1000 + rngFrame() * 5000;   // RAF timestamps are page-relative, not 0
  let ts = clock.now;
  for (let frame = 0; frame < 4000 && rt.playing; frame++) {
    // jittered frames, with the occasional dropped one
    const step = rngFrame() < 0.05 ? 40 + rngFrame() * 80 : 12 + rngFrame() * 10;
    ts += step;
    clock.now = ts;
    // the bot presses between frames, like a person does
    const next = rt.obstacles.find(o => o.x + FP_PIPE_W > FP_PLAYER_X - FP_PLAYER_R);
    const aim = next ? next.gapY - 4 : FP_CS_H / 2;
    if (rt.player.y > aim && rt.player.vy > -140 && rngFrame() > 0.02) {
      clock.now = ts - rngFrame() * step;
      sandbox.fpFlap();
      clock.now = ts;
    }
    sandbox.fpTick(ts);
  }
  return {
    score: rt.score, pipes: rt.pipes, lives: FP_MAX_LIVES - rt.lives,
    elapsedMs: Math.ceil(rt.simMs) + 16, flapEvents: rt.flapEvents,
  };
}
function makeRng(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

const ROUNDS = Number(process.argv[2] || 200);
let bad = 0, scored = 0, totalPipes = 0;
for (let i = 0; i < ROUNDS; i++) {
  const seed = 1 + Math.floor(makeRng(i * 7919 + 13)() * 2147483646);
  const client = playRound(seed, makeRng(i * 104729 + 7));
  const server = replayFlappy(seed, client.flapEvents, client.elapsedMs);
  totalPipes += client.pipes;
  if (client.pipes > 0) scored++;
  if (server.score !== client.score || server.pipes !== client.pipes || server.livesUsed !== client.lives) {
    bad++;
    if (bad <= 5) {
      console.log(`MISMATCH seed=${seed} client=${JSON.stringify(client).slice(0, 120)}`);
      console.log(`         server=${JSON.stringify(server)}`);
    }
  }
}
console.log(`${ROUNDS} rounds · ${scored} scored at least one pipe · ${totalPipes} pipes total · ${bad} mismatches`);
if (!totalPipes) { console.error('bot never scored — the harness is not exercising anything'); process.exit(1); }
process.exit(bad ? 1 : 0);
