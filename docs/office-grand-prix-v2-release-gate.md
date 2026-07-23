# Office Grand Prix release gate (history)

V1 and V2 are historical. **V3** (2026-07-23) is the live engine: it replaced
V2's tight-inner-loop track (whose constant-offset road/curb geometry
self-intersected — the "weird inner corners" bug) with a straights +
true-radius-corners circuit, added a `moveHeading`-chases-`heading` drift
model (steer-only input, no drift button), raised speed/turn responsiveness,
and replaced the live lobby/coordinator/broadcast multiplayer with **async
ghosts**: every race is its own solo server session (player + 7 bots,
started instantly, no waiting), and up to 7 other players' most recently
recorded laps are replayed locally as extra visual karts. Ghosts never touch
the authoritative roster or scoring — the server always fills non-player
slots with the bot AI, so a ghost can never affect the caller's official
result. This removed the entire class of risk the V2 manual gate below was
tracking (coordinator failover, reconnect, stale peer state); those rows no
longer apply and are kept only as historical context.

Completed V1/V2 test sessions and their score rows are audit history; do not
delete or promote them.

## V5 (2026-07-23): render crash fix + feel tuning

V4 (same day) had shipped with a game-breaking regression from its camera
work: `ogpRenderFrame`'s steering-linked camera-chase block referenced a bare
`THREE.Vector3(...)` that was never in scope (every other Three.js call in
the file goes through a passed-in `THREE` param or `runtime.three`). While
the preview camera orbits (not racing), that branch never runs, so the scene
looked fine; the instant a race actually started, the reference threw,
which escaped the `requestAnimationFrame` loop closure before its re-arm
line — permanently freezing the render loop with the orbit camera stuck
mid-air and the countdown finishing over a dead frame. Fixed by routing
through `runtime.cameraRight` (preallocated alongside the other camera
vectors) instead of a bare `THREE` global, and the render loop's `loop`
closure now wraps `ogpRenderFrame` in try/catch so a future thrown frame
logs and continues instead of wedging the game forever.

Also a physics/feel + UX tuning pass, based on live player feedback that V4's
steering was too snappy (and yanked the chase camera along with it), the
game felt slow, and the procedural Web Audio sound wasn't wanted:
- `OGP_STEER_RESPONSE` 580→340, `OGP_STEER_CENTER` 850→600 — the wheel now
  ramps to full lock over ~4 ticks instead of snapping in ~2, without
  changing top cornering rate.
- `OGP_MAX_SPEED` 280→320, `OGP_ACCEL` 18→22 — faster overall (clean lap
  34.35s → 30.35s, still inside the 25-55s band below).
- `OGP_GRIP_NUM_ROAD`/`OGP_GRIP_DEN_ROAD` 4/5→2/5 — `moveHeading` closes the
  gap to `heading` more slowly, so sustained steering shows a longer, more
  visible tail-slide (more "wobbly"/drifty) instead of near-instant grip.
- Camera-only (no parity impact): the steering-linked position/look-ahead
  offsets and roll were both roughly halved, and look-damping slowed, so the
  chase cam reads as following a turning car rather than whipping with every
  steering twitch.
- The procedural Web Audio engine (countdown beeps, item/boost/banana/finish
  stingers, engine drone) was removed at the player's request; `ogpPlaySound`
  and friends are now no-op stubs and the sound-toggle button is gone from
  the HUD.
- Engine version bumped `office_grand_prix_v4` → `office_grand_prix_v5`
  (migration `20260723160500_office_grand_prix_v5_engine.sql`, edge function
  redeployed) since gameplay-affecting constants changed; track geometry/hash
  (`office_loop_v4`) is untouched.

Re-verified: `node scripts/office-grand-prix-parity.mjs` (0 mismatches, clean
lap 30.35s), inline script syntax check, and a live Playwright smoke test of
a full Trening race (countdown → chase camera engages → car drives and
accelerates → zero new console errors over the run).

## V3 automated gate

- [x] `node scripts/office-grand-prix-parity.mjs`
  - golden steering/drift, neutral-heading, off-road, reset, grid, checkpoint,
    item, finish, DNF, cosmetics, scoring, interpolation, and track-hash cases
  - 5,000 seeded races / 40,000 kart replays, zero browser/server mismatches
  - clean lap in the 25-55s band (drift physics is meaningfully faster)
- [x] New track control points verified offline: minimum curvature radius
  ~24 world units against a 7.6 curb half-width (3x+ margin), plus a direct
  offset-polyline self-intersection check at width up to 9 — see the track
  design notes in `index.html`'s `ogpBuildScene`.
- [x] Classic inline JavaScript parses; edge function is valid TypeScript.

## V3 manual gate (recommended before/soon after the 2026-07-27 feature week)

- [ ] At 30/60/120 Hz there are no fixed-tick plateaus or camera shakes; no
  road/curb visual artifacts anywhere around the new circuit.
- [ ] Left/right steer correctly; releasing input centers the wheel without
  aligning the kart; sustained hard steering shows a visible, bounded drift
  that eases back out; an unattended kart leaves the road.
- [ ] Starting a race is instant (no lobby wait); ghosts (when any exist for
  the current track version) appear as extra karts and race believably; empty
  ghost slots are filled by bots; finishing submits and the weekly leaderboard
  updates.
- [ ] Portrait, landscape, pointer cancellation, blur, and fullscreen pass.
- [ ] Mobile frame time stays reasonable on a mid-tier device.

## Historical: V2 manual gate (superseded, kept for context)

- [ ] Two authenticated players race live with six bots via the coordinator.
- [ ] Reconnect, coordinator failover, stale engine/track/session rejection.

These rows described the live-multiplayer surface V3 removed; they will
never be checked off and should not block anything going forward.
